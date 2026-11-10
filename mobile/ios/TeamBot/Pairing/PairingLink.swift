import Foundation

/// The link inside the pairing QR code: `http(s)://host[:port]/api/public/mobile/pair#t=<secret>[&n=<key>][&r=<relay>]`,
/// or `teambot://pair#t=<secret>&n=<key>[&r=<relay>]` when the pc is only reachable through the TeamBot connection.
/// The secret lives in the fragment, so it is never sent to a server by a browser GET.
/// `n` is the pc's iroh key (the app pins it), `r` an own relay server of the pc (none: n0's public relays).
struct PairingLink: Equatable {
    /// The pc's address; `IrohTunnel.placeholder` for a teambot://pair link (only the TeamBot connection).
    let baseURL: URL
    let secret: String
    var irohId: String? = nil
    var irohRelay: String? = nil

    static let path = "/api/public/mobile/pair"

    /// Only the TeamBot connection: there is no address to try first.
    var onlyTeamBotLink: Bool { HostAddress.kind(of: baseURL) == .teambotLink }

    static func parse(_ text: String) -> PairingLink? {
        guard var comps = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = comps.scheme?.lowercased(),
              comps.user == nil, comps.password == nil,
              comps.query == nil,
              let fragment = comps.fragment
        else { return nil }
        let teambot = scheme == "teambot"
        if teambot {
            guard comps.host == "pair", comps.path.isEmpty, comps.port == nil else { return nil }
        } else {
            guard scheme == "http" || scheme == "https", let host = comps.host, !host.isEmpty, comps.path == path else { return nil }
        }
        var secret: String?
        var id: String?
        var relay: String?
        for pair in fragment.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            guard kv.count == 2 else { continue }
            switch kv[0] {
            case "t": secret = kv[1]
            case "n": id = kv[1]
            case "r": relay = kv[1].removingPercentEncoding
            default: break
            }
        }
        guard let s = secret, (40...100).contains(s.count), s.allSatisfy(isTokenChar) else { return nil }
        let key = id.flatMap(validKey)
        if teambot {
            guard let key else { return nil }
            return PairingLink(baseURL: IrohTunnel.placeholder, secret: s, irohId: key, irohRelay: relay.flatMap(validRelay))
        }
        comps.path = ""
        comps.fragment = nil
        guard let base = comps.url else { return nil }
        return PairingLink(baseURL: base, secret: s, irohId: key, irohRelay: key == nil ? nil : relay.flatMap(validRelay))
    }

    /// The pc's iroh key: hex or base32 text, nothing else.
    static func validKey(_ s: String) -> String? {
        (32...80).contains(s.count) && s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) ? s : nil
    }

    /// An own relay server: https only (http only on loopback, for tests), no credentials, no path.
    static func validRelay(_ s: String) -> String? {
        guard let c = URLComponents(string: s), let scheme = c.scheme?.lowercased(), let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil, c.path.isEmpty || c.path == "/"
        else { return nil }
        guard scheme == "https" || (scheme == "http" && (host == "127.0.0.1" || host == "localhost")) else { return nil }
        return s
    }

    /// A typed host address: "192.168.1.20:4748" → http://192.168.1.20:4748. No paths, no credentials.
    static func baseURL(fromTyped text: String) -> URL? {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return nil }
        let lower = t.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") { t = "http://" + t }
        guard var comps = URLComponents(string: t), let host = comps.host, !host.isEmpty, comps.user == nil, comps.password == nil else { return nil }
        if comps.path == "/" { comps.path = "" }
        guard comps.path.isEmpty, comps.query == nil, comps.fragment == nil else { return nil }
        return comps.url
    }

    /// "abcd-ef9h" → "ABCDEF9H"
    static func normalizeCode(_ s: String) -> String {
        String(s.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(16))
    }

    private static func isTokenChar(_ c: Character) -> Bool {
        c.isASCII && (c.isLetter || c.isNumber || c == "-" || c == "_")
    }
}
