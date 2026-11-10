import CryptoKit
import Foundation

enum HostError: LocalizedError {
    case unreachable
    case rejected(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .unreachable: return "TeamBot is niet bereikbaar. Staat je pc aan en zit je op hetzelfde netwerk of op Tailscale?"
        case .rejected(let message): return message
        case .invalidResponse: return "Onverwacht antwoord van TeamBot."
        }
    }
}

struct ClaimResult: Decodable {
    struct Device: Decodable {
        let id: String
        let name: String
    }
    let token: String
    let device: Device
}

enum DeviceState: String, Equatable, Sendable {
    case active, revoked, unknown
}

/// The host's answer to `POST /api/public/mobile/hello` (no token sent).
struct Hello: Equatable, Sendable {
    let instance: String
    let device: DeviceState
    /// The HMAC proof matched our token: this is the TeamBot we paired with, and its answer about us is true.
    let verified: Bool
}

/// What one address answered. Only `.hello` with `verified` lets the app send its token there.
enum ProbeOutcome: Equatable, Sendable {
    case hello(Hello)
    /// Answers like TeamBot but has no hello route (an older TeamBot on the pc).
    case legacyHost
    /// Too many checks at once; TeamBot is up.
    case busy
    /// The pc answered but nothing listens on that port: TeamBot is closed.
    case refused
    /// Nothing answered in time.
    case timedOut
    /// No route to that address from this network.
    case unreachable
    /// The name was not found (a ts.net name without Tailscale on this iPhone).
    case noHost
    /// iOS says there is no connection (or local network access is not allowed for this app).
    case phoneOffline
    /// A proxy in front of TeamBot (Tailscale Serve, a tunnel, the phone gateway) answered 502/503/504.
    case proxyDown
    /// The tunnel service says the pc side is not connected (Cloudflare 530).
    case tunnelDown
    /// App Transport Security or a certificate problem: this address cannot be opened safely.
    case blocked
    /// Something else answers on this address (a login page of a hotel wifi, another device).
    case notTeamBot
}

/// `GET /api/mobile/status` (device token).
struct HostStatusInfo: Decodable, Equatable {
    struct Address: Decodable, Equatable {
        let url: String
        let kind: String
        let secure: Bool
    }
    struct Power: Codable, Equatable {
        /// The desktop app can keep the pc awake.
        let available: Bool
        /// "Houd de pc wakker terwijl routines of taken lopen" is on.
        let keepAwake: Bool
    }
    struct Privacy: Decodable, Equatable {
        let version: String
    }
    let instance: String
    let version: String?
    let addresses: [Address]
    let power: Power?
    let privacy: Privacy?
    /// Start page in the web app (wave 2: the main bot), e.g. "#/t/thr_…"; nil = the web app's own start page.
    let home: String?
    /// The TeamBot connection (iroh) of the pc: its key and own relay; nil when it is off (or an older TeamBot).
    struct Iroh: Decodable, Equatable {
        let id: String
        let relay: String?
    }
    let iroh: Iroh?
}

enum StatusResult: Equatable {
    /// The token works. `nil` info: an older TeamBot without the status route.
    case ok(HostStatusInfo?)
    case revoked
    case unreachable
}

/// The few calls the native shell makes itself; everything else happens in the web app.
struct HostClient {
    var session: URLSession = .shared

    // MARK: pairing

    func claim(base: URL, secret: String?, code: String?, deviceName: String) async throws -> ClaimResult {
        var req = URLRequest(url: base.appendingPathComponent("api/public/mobile/claim"))
        req.httpMethod = "POST"
        req.timeoutInterval = HostAddress.kind(of: base) == .teambotLink ? 25 : 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["name": deviceName, "platform": "ios", "client": "ios-app"]
        if let secret { body["secret"] = secret }
        if let code { body["code"] = code }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await send(req)
        guard resp.statusCode == 200 else { throw HostError.rejected(Self.message(data) ?? "Koppelen mislukt (HTTP \(resp.statusCode))") }
        guard let result = try? JSONDecoder().decode(ClaimResult.self, from: data) else { throw HostError.invalidResponse }
        return result
    }

    // MARK: per-link check (no token)

    /// Asks one address "are you my TeamBot, and do you still know this iPhone?" without sending the token.
    /// `timeout`: longer through the TeamBot connection, which may still be dialing the pc.
    func hello(base: URL, pairing p: Pairing, timeout: TimeInterval = 6) async -> ProbeOutcome {
        var req = URLRequest(url: base.appendingPathComponent("api/public/mobile/hello"))
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let nonce = Self.newNonce()
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["device": p.deviceId, "nonce": nonce])
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { return .notTeamBot }
            return Self.outcome(status: http.statusCode, data: data, nonce: nonce, pairing: p)
        } catch {
            return Self.outcome(for: error)
        }
    }

    static func outcome(status: Int, data: Data, nonce: String, pairing p: Pairing) -> ProbeOutcome {
        switch status {
        case 200:
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (obj["teambot"] as? Int) == 1,
                  let instance = obj["instance"] as? String, !instance.isEmpty,
                  let raw = obj["device"] as? String, let state = DeviceState(rawValue: raw)
            else { return .notTeamBot }
            var verified = false
            if state != .unknown, let proof = obj["proof"] as? String {
                verified = verifyProof(proof, token: p.token, message: helloMessage(instance: instance, device: p.deviceId, nonce: nonce, state: state))
            }
            return .hello(Hello(instance: instance, device: state, verified: verified))
        case 404, 405:
            return message(data) != nil ? .legacyHost : .notTeamBot
        case 429:
            return .busy
        case 502, 503, 504:
            return .proxyDown
        case 530:
            return .tunnelDown
        default:
            return .notTeamBot
        }
    }

    /// Network errors in words the user can act on. ECONNREFUSED (61) means the pc answered: TeamBot is closed.
    static func outcome(for error: Error) -> ProbeOutcome {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return .unreachable }
        switch ns.code {
        case NSURLErrorNotConnectedToInternet, NSURLErrorDataNotAllowed, NSURLErrorInternationalRoamingOff, NSURLErrorCallIsActive:
            return .phoneOffline
        case NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost:
            return .timedOut
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
            return .noHost
        case NSURLErrorCannotConnectToHost:
            let posix = (ns.userInfo["_kCFStreamErrorCodeKey"] as? NSNumber)?.intValue
            return posix == 61 ? .refused : .unreachable
        case NSURLErrorAppTransportSecurityRequiresSecureConnection, NSURLErrorSecureConnectionFailed,
             NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted,
             NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid,
             NSURLErrorClientCertificateRejected, NSURLErrorClientCertificateRequired:
            return .blocked
        default:
            return .unreachable
        }
    }

    // MARK: hello proof (same as server/modules/mobile/status.ts)

    static func helloMessage(instance: String, device: String, nonce: String, state: DeviceState) -> String {
        "teambot-hello/1|\(instance)|\(device)|\(nonce)|\(state.rawValue)"
    }

    /// HMAC-SHA256 keyed with the SHA-256 of the token: the host stores only that hash, so it can prove it knows the
    /// token without anyone sending it.
    static func proof(token: String, message: String) -> String {
        let key = SymmetricKey(data: Data(SHA256.hash(data: Data(token.utf8))))
        let mac = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)
        return Data(mac).map { String(format: "%02x", $0) }.joined()
    }

    static func verifyProof(_ hex: String, token: String, message: String) -> Bool {
        guard let given = Data(hexString: hex), given.count == 32 else { return false }
        let key = SymmetricKey(data: Data(SHA256.hash(data: Data(token.utf8))))
        return HMAC<SHA256>.isValidAuthenticationCode(given, authenticating: Data(message.utf8), using: key)
    }

    static func newNonce() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }

    // MARK: with the token (only to an address that proved itself, or https / the paired address on an older host)

    /// 401 means the device was revoked (or the session expired).
    func status(_ p: Pairing, base: URL) async -> StatusResult {
        guard let result = try? await send(authorized(p, base: base, path: "api/mobile/status")) else { return .unreachable }
        switch result.1.statusCode {
        case 200:
            return .ok(try? JSONDecoder().decode(HostStatusInfo.self, from: result.0))
        case 401:
            return .revoked
        case 403, 404:
            // An older TeamBot without the status route: check the device the old way.
            guard let old = try? await send(authorized(p, base: base, path: "api/mobile/devices/self")) else { return .unreachable }
            if old.1.statusCode == 401 { return .revoked }
            return old.1.statusCode == 200 ? .ok(nil) : .unreachable
        default:
            return .unreachable
        }
    }

    /// Which AI services the pc sends data to (consent screen). nil: the host cannot tell (older TeamBot) or is gone.
    func privacy(_ p: Pairing, base: URL) async -> PrivacyInfo? {
        guard let result = try? await send(authorized(p, base: base, path: "api/mobile/privacy")), result.1.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(PrivacyInfo.self, from: result.0)
    }

    /// Returns true when the host confirmed (the key is then invalid everywhere).
    func unpair(_ p: Pairing, base: URL) async -> Bool {
        var req = authorized(p, base: base, path: "api/mobile/devices/self")
        req.httpMethod = "DELETE"
        guard let result = try? await send(req) else { return false }
        return result.1.statusCode == 200 || result.1.statusCode == 401
    }

    func registerPush(_ p: Pairing, token: String, environment: String) async throws {
        var req = authorized(p, base: p.baseURL, path: "api/mobile/devices/self/apns")
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["token": token, "environment": environment])
        let (data, resp) = try await send(req)
        guard resp.statusCode == 200 else { throw HostError.rejected(Self.message(data) ?? "Meldingen registreren mislukt") }
    }

    private func authorized(_ p: Pairing, base: URL, path: String) -> URLRequest {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.timeoutInterval = 8
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
        return req
    }

    private func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw HostError.invalidResponse }
            return (data, http)
        } catch let error as HostError {
            throw error
        } catch {
            throw HostError.unreachable
        }
    }

    static func message(_ data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj["error"] as? String
    }
}

extension Data {
    /// "0a1b…" → bytes; nil for odd length or a non-hex character.
    init?(hexString: String) {
        let chars = Array(hexString.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(chars.count / 2)
        func nibble(_ c: UInt8) -> UInt8? {
            switch c {
            case 48...57: return c - 48
            case 97...102: return c - 87
            case 65...70: return c - 55
            default: return nil
            }
        }
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
            bytes.append(hi << 4 | lo)
            i += 2
        }
        self.init(bytes)
    }
}
