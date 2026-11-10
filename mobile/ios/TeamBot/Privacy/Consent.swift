import Foundation

/// `GET /api/mobile/privacy`: the AI services the bots on the owner's pc can send data to.
struct PrivacyInfo: Codable, Equatable {
    struct Provider: Codable, Equatable, Identifiable {
        let id: String
        /// Company or service that receives the data (a name: never translated).
        let vendor: String
        /// The connection as the owner named it on the pc.
        let service: String
        /// Runs on the pc or in the owner's own network.
        let local: Bool
        /// Host of a custom endpoint, when the kind does not say where the data goes.
        let host: String?
        /// Passes data on to the model chosen there (OpenRouter, an own endpoint, …).
        let forwards: Bool?
        /// A free tier: some free services may use what you send to improve their models.
        let free: Bool?
        /// "chat", "voice", "readaloud".
        let data: [String]?
        /// Bots that use it now.
        let bots: [String]?
    }

    let version: String
    let providers: [Provider]

    var external: [Provider] { providers.filter { !$0.local } }
    var onOwnNetwork: [Provider] { providers.filter { $0.local } }

    /// "je berichten (met wat een bot daarvoor gebruikt) en wat je inspreekt" — what one service gets, in plain
    /// Dutch. Same wording as the privacy page of the website (website/src/nl.json › privacy.ai).
    static func dataText(_ codes: [String]?) -> String {
        let parts = (codes ?? ["chat"]).compactMap { code -> String? in
            switch code {
            case "chat": return "je berichten (met wat een bot daarvoor gebruikt)"
            case "voice": return "wat je inspreekt"
            case "readaloud": return "teksten om voor te lezen"
            default: return nil
            }
        }
        guard let last = parts.last else { return "je berichten" }
        return parts.count == 1 ? last : parts.dropLast().joined(separator: ", ") + " en " + last
    }
}

/// Explicit consent before any personal data leaves this iPhone for the bots (App Review 5.1.2(i), since
/// 13 November 2025). Given per version of the list: when the pc starts using another company, the app asks again.
/// Withdraw it in the app's settings or with the switch in iOS Settings › TeamBot (which can only withdraw).
struct ConsentStore {
    /// Version used when the pc cannot tell which services it uses (an older TeamBot).
    static let unknownVersion = "onbekend"
    /// The switch in iOS Settings › TeamBot (Settings.bundle/Root.plist).
    static let settingsKey = "ai_consent"
    private static let versionKey = "consent.version"
    private static let dateKey = "consent.date"

    var defaults: UserDefaults = .standard

    var grantedVersion: String? {
        syncWithSettingsApp()
        return defaults.string(forKey: Self.versionKey)
    }

    var grantedAt: Date? {
        grantedVersion == nil ? nil : defaults.object(forKey: Self.dateKey) as? Date
    }

    func isGranted(_ version: String) -> Bool {
        grantedVersion == version
    }

    func grant(_ version: String, at date: Date = Date()) {
        defaults.set(version, forKey: Self.versionKey)
        defaults.set(date, forKey: Self.dateKey)
        defaults.set(true, forKey: Self.settingsKey)
    }

    func withdraw() {
        defaults.removeObject(forKey: Self.versionKey)
        defaults.removeObject(forKey: Self.dateKey)
        defaults.set(false, forKey: Self.settingsKey)
    }

    /// Switched off in iOS Settings → consent withdrawn. Switching it on there gives nothing: consent is only given
    /// on the consent screen, after the explanation.
    private func syncWithSettingsApp() {
        if (defaults.object(forKey: Self.settingsKey) as? Bool) == false, defaults.string(forKey: Self.versionKey) != nil {
            defaults.removeObject(forKey: Self.versionKey)
            defaults.removeObject(forKey: Self.dateKey)
        }
    }
}
