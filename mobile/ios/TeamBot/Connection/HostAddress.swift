import Foundation

/// Addresses of the paired TeamBot: what kind of link they are and which ones the app accepts from the host.
enum HostAddress {
    enum Kind: Hashable {
        /// Home network: 192.168.x / 10.x / 172.16–31.x, `.local` or a bare name.
        case lan
        /// Tailscale direct: 100.64.0.0/10.
        case tailscale
        /// Tailscale Serve: https://<pc>.<tailnet>.ts.net (only reachable with Tailscale on this iPhone).
        case tailscaleHTTPS
        /// Anything else (an own domain, a tunnel).
        case internet
        /// The TeamBot connection (iroh): the app's own loopback proxy (IrohTunnel). A phone never runs TeamBot itself,
        /// so 127.x / localhost is always that proxy.
        case teambotLink
    }

    /// scheme://host[:port] in lower case, without a default port (as WebKit writes an origin): the web view only
    /// trusts this origin.
    static func origin(of url: URL) -> String {
        let scheme = url.scheme?.lowercased()
        var c = URLComponents()
        c.scheme = scheme
        c.host = url.host?.lowercased()
        if let port = url.port, !(scheme == "https" && port == 443), !(scheme == "http" && port == 80) { c.port = port }
        return c.string ?? url.absoluteString
    }

    static func kind(of url: URL) -> Kind {
        let host = (url.host ?? "").lowercased()
        if host.hasSuffix(".ts.net") { return .tailscaleHTTPS }
        if let ip = ipv4(host) {
            if ip[0] == 100 && (64...127).contains(ip[1]) { return .tailscale }
            if ip[0] == 127 { return .teambotLink }
            if ip[0] == 10 || (ip[0] == 172 && (16...31).contains(ip[1])) || (ip[0] == 192 && ip[1] == 168) { return .lan }
            return .internet
        }
        if host == "localhost" { return .teambotLink }
        if host.hasSuffix(".local") || !host.contains(".") { return .lan }
        return .internet
    }

    /// An address sent by the host (`GET /api/mobile/status`): only an http(s) origin without credentials, path,
    /// query or fragment, and plain http only inside the own network (App Transport Security blocks the rest).
    static func accept(_ raw: String) -> URL? {
        guard let c = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil,
              c.path.isEmpty || c.path == "/",
              c.query == nil, c.fragment == nil
        else { return nil }
        var out = URLComponents()
        out.scheme = scheme
        out.host = host.lowercased()
        out.port = c.port
        guard let url = out.url else { return nil }
        if scheme == "http" && kind(of: url) == .internet { return nil }
        // Loopback is this iPhone's own TeamBot-connection proxy, never an address of the pc.
        if kind(of: url) == .teambotLink { return nil }
        return url
    }

    /// The address without "http://" for people.
    static func display(_ url: URL) -> String {
        if kind(of: url) == .teambotLink { return "TeamBot-verbinding" }
        let s = origin(of: url)
        return s.hasPrefix("https://") ? String(s.dropFirst(8)) : s.hasPrefix("http://") ? String(s.dropFirst(7)) : s
    }

    private static func ipv4(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var out: [Int] = []
        for p in parts {
            guard !p.isEmpty, p.count <= 3, p.allSatisfy({ $0.isASCII && $0.isNumber }), let v = Int(p), v <= 255 else { return nil }
            out.append(v)
        }
        return out
    }
}
