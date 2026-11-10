import Foundation
import Security

/// What this iPhone needs to talk to its host. Stored only in the Keychain: it survives app updates (same bundle id
/// and team) and network changes, but not a backup restored to another iPhone.
struct Pairing: Codable, Equatable, Sendable {
    /// The address that worked last; the web app is loaded from here.
    var baseURL: URL
    var token: String
    var deviceId: String
    var deviceName: String
    /// The address from the QR code or typed in: always tried, also when the host does not list it.
    var pairedURL: URL
    /// Other addresses of the same TeamBot (wifi, Tailscale, https), learned from the host after pairing.
    var addresses: [URL]
    /// Stable id of the paired TeamBot: tells "the same TeamBot on another address" from "another TeamBot".
    var instance: String?
    /// The pc's iroh key for the TeamBot connection (from the QR code or the pc's status), and its own relay server.
    var irohId: String?
    var irohRelay: String?

    init(baseURL: URL, token: String, deviceId: String, deviceName: String, pairedURL: URL? = nil, addresses: [URL] = [], instance: String? = nil, irohId: String? = nil, irohRelay: String? = nil) {
        self.baseURL = baseURL
        self.token = token
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.pairedURL = pairedURL ?? baseURL
        self.addresses = addresses
        self.instance = instance
        self.irohId = irohId
        self.irohRelay = irohRelay
    }

    private enum CodingKeys: String, CodingKey {
        case baseURL, token, deviceId, deviceName, pairedURL, addresses, instance, irohId, irohRelay
    }

    /// Tolerant on purpose: a pairing saved by an older version of the app (only baseURL, token, deviceId and
    /// deviceName) still loads after an update, so nobody has to pair again.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        baseURL = try c.decode(URL.self, forKey: .baseURL)
        token = try c.decode(String.self, forKey: .token)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        deviceName = (try? c.decodeIfPresent(String.self, forKey: .deviceName)) ?? "iPhone"
        pairedURL = (try? c.decodeIfPresent(URL.self, forKey: .pairedURL)) ?? baseURL
        addresses = (try? c.decodeIfPresent([URL].self, forKey: .addresses)) ?? []
        instance = try? c.decodeIfPresent(String.self, forKey: .instance)
        irohId = try? c.decodeIfPresent(String.self, forKey: .irohId)
        irohRelay = try? c.decodeIfPresent(String.self, forKey: .irohRelay)
    }

    /// Addresses to try, best first: the one that worked last, https ones, the paired one, then the rest. Never the
    /// TeamBot connection's loopback proxy: the app tries that one itself, last (AppModel.probe).
    var candidates: [URL] {
        var out: [URL] = []
        var seen = Set<String>()
        func add(_ u: URL) {
            if HostAddress.kind(of: u) == .teambotLink { return }
            if seen.insert(HostAddress.origin(of: u)).inserted { out.append(u) }
        }
        add(baseURL)
        for u in addresses where u.scheme?.lowercased() == "https" { add(u) }
        add(pairedURL)
        for u in addresses { add(u) }
        return Array(out.prefix(8))
    }
}

/// Keychain storage for the device credential (never UserDefaults, never iCloud:
/// `ThisDeviceOnly` keeps it out of backups restored to other devices).
enum KeychainStore {
    private static let service = "app.teambot.companion"
    private static let account = "pairing"

    private static var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func load() -> Pairing? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    /// Updates in place (a new address must never lose the key halfway), adds when there is nothing yet.
    @discardableResult
    static func save(_ pairing: Pairing) -> Bool {
        guard let data = try? JSONEncoder().encode(pairing) else { return false }
        let update: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var attrs = baseQuery
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(attrs as CFDictionary, nil) == errSecSuccess
    }

    static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}
