import Foundation
import IrohLib
import Network

/// The TeamBot connection (iroh) on this iPhone: reaches the paired pc at home and away without Tailscale.
///
/// It dials the pc's key from the QR code (`n=` in PairingLink) over iroh: directly where it can, through a relay
/// otherwise, end-to-end encrypted either way (no relay can stand in for the pc: the key is pinned). The web view
/// sees a plain loopback address, `http://127.0.0.1:<port>`: every TCP connection there (HTTP and the WebSocket) becomes
/// one iroh stream, and on the pc that stream goes into the phone gateway, so exactly the same rules apply as on
/// wifi (server/modules/mobile/iroh.ts). The port is kept between launches, so the web app keeps its origin (and the
/// messages it still has to deliver).
///
/// Needs the CI build to confirm (Windows cannot compile Swift): IrohLib 1.2.0 API names, NWListener on 127.0.0.1.
actor IrohTunnel {
    static let shared = IrohTunnel()
    /// Same as IROH_ALPN in server/modules/mobile/iroh.ts.
    static let alpn = Data("teambot/http/1".utf8)
    /// Stand-in base of a pairing that only knows the TeamBot connection (a teambot://pair QR code).
    static let placeholder = URL(string: "http://127.0.0.1")!

    enum Route: Equatable, Sendable {
        case direct, relay
    }

    private var endpoint: Endpoint?
    private var addr: EndpointAddr?
    private var target: String?
    private var connection: Connection?
    private var connecting: Task<Connection, Error>?
    private var listener: NWListener?
    private var port: UInt16 = 0
    private let queue = DispatchQueue(label: "app.teambot.companion.iroh")
    private static let portKey = "iroh.port"

    /// Starts the endpoint and the loopback proxy for this pc (or reuses them); returns the proxy's base URL.
    /// Dialing happens in the background; the first request through the proxy waits for it.
    func start(id: String, relay: String?) async throws -> URL {
        let key = "\(id)|\(relay ?? "")"
        if target != key { await stop() }
        if endpoint == nil {
            let mode: RelayMode? = try relay.map { try RelayMode.customFromUrls(urls: [$0]) }
            let ep = try await Endpoint.bind(options: EndpointOptions(preset: presetN0(), relayMode: mode))
            endpoint = ep
            addr = EndpointAddr(id: try EndpointId.fromString(s: id), relayUrl: relay, addresses: [])
            target = key
        }
        if listener == nil { try await listen() }
        Task { _ = try? await self.connected() }
        return baseURL
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    /// How the connection runs now: directly (at home, or through a punched hole) or through the relay.
    func route() -> Route? {
        guard let c = connection, c.closeReason() == nil, let sel = c.paths().first(where: { $0.isSelected }) else { return nil }
        return sel.isRelay ? .relay : .direct
    }

    /// After the app slept: the old connection may be dead without knowing it. Dial again, and keep the endpoint and
    /// the loopback address, so the web view stays where it is.
    func redial() {
        guard endpoint != nil else { return }
        connecting?.cancel()
        connecting = nil
        if let c = connection { try? c.close(errorCode: 0, reason: Data()) }
        connection = nil
        Task { _ = try? await self.connected() }
    }

    func stop() async {
        listener?.cancel()
        listener = nil
        connecting?.cancel()
        connecting = nil
        if let c = connection { try? c.close(errorCode: 0, reason: Data()) }
        connection = nil
        if let ep = endpoint { try? await ep.close() }
        endpoint = nil
        addr = nil
        target = nil
    }

    // MARK: iroh

    private func connected() async throws -> Connection {
        if let c = connection, c.closeReason() == nil { return c }
        if let t = connecting { return try await t.value }
        guard let ep = endpoint, let addr else { throw IrohTunnelError.notStarted }
        let alpn = Self.alpn
        let t = Task { try await ep.connect(addr: addr, alpn: alpn) }
        connecting = t
        defer { connecting = nil }
        let c = try await t.value
        connection = c
        return c
    }

    private func openStream() async throws -> BiStream {
        do {
            return try await connected().openBi()
        } catch {
            // The connection dropped (network switch, the pc restarted): dial once more.
            connection = nil
            return try await connected().openBi()
        }
    }

    // MARK: loopback proxy

    private func listen() async throws {
        var ports: [UInt16] = []
        let saved = UserDefaults.standard.integer(forKey: Self.portKey)
        if saved > 1024 && saved < 65536 { ports.append(UInt16(saved)) }
        for _ in 0..<4 { ports.append(UInt16.random(in: 49152...65000)) }
        for p in ports {
            guard let nwPort = NWEndpoint.Port(rawValue: p) else { continue }
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: nwPort)
            params.allowLocalEndpointReuse = true
            guard let l = try? NWListener(using: params) else { continue }
            l.newConnectionHandler = { [weak self] c in
                Task { await self?.bridge(c) }
            }
            let ready = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
                let once = Once()
                l.stateUpdateHandler = { [weak self, weak l] state in
                    switch state {
                    case .ready:
                        if once.first() { cont.resume(returning: true) }
                    case .failed, .cancelled:
                        if once.first() {
                            cont.resume(returning: false)
                        } else if let l {
                            Task { await self?.listenerGone(l) }
                        }
                    default:
                        break
                    }
                }
                l.start(queue: queue)
            }
            if ready {
                listener = l
                port = p
                UserDefaults.standard.set(Int(p), forKey: Self.portKey)
                return
            }
            l.cancel()
        }
        throw IrohTunnelError.noPort
    }

    private func listenerGone(_ l: NWListener) {
        if listener === l { listener = nil }
    }

    /// One TCP connection of the web view ⇄ one iroh stream to the pc: bytes in both directions, unchanged.
    private func bridge(_ c: NWConnection) async {
        c.start(queue: queue)
        let bi: BiStream
        do {
            bi = try await openStream()
        } catch {
            c.cancel()
            return
        }
        let send = bi.send()
        let recv = bi.recv()
        // web view → pc
        Task.detached {
            while true {
                let (data, done) = await Self.receive(c)
                if let data, !data.isEmpty {
                    do { try await send.writeAll(buf: data) } catch {
                        c.cancel()
                        return
                    }
                }
                if done {
                    try? await send.finish()
                    return
                }
            }
        }
        // pc → web view
        Task.detached {
            while true {
                let data = (try? await recv.read(sizeLimit: 65536)) ?? Data()
                if data.isEmpty {
                    c.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.cancel() })
                    return
                }
                if !(await Self.write(c, data)) {
                    c.cancel()
                    return
                }
            }
        }
    }

    private static func receive(_ c: NWConnection) async -> (Data?, Bool) {
        await withCheckedContinuation { (cont: CheckedContinuation<(Data?, Bool), Never>) in
            c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                cont.resume(returning: (data, isComplete || error != nil))
            }
        }
    }

    private static func write(_ c: NWConnection, _ data: Data) async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            c.send(content: data, completion: .contentProcessed { error in cont.resume(returning: error == nil) })
        }
    }
}

/// True exactly once, from any thread (the listener reports its state on its own queue).
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func first() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

enum IrohTunnelError: LocalizedError {
    case notStarted
    case noPort

    var errorDescription: String? {
        switch self {
        case .notStarted: return "De TeamBot-verbinding is nog niet gestart."
        case .noPort: return "De TeamBot-verbinding kon op deze iPhone niet starten. Probeer het opnieuw."
        }
    }
}
