import Combine
import Foundation
import UIKit
import UserNotifications
import WebKit

/// What the app remembers (nothing secret) about the last good connection, to show useful tips when the pc
/// cannot be reached: when it was, whether the pc may sleep, the start page.
struct LastStatus: Codable, Equatable {
    var connectedAt: Date
    var power: HostStatusInfo.Power?
    var home: String?

    private static let key = "status.last"

    static func load(_ defaults: UserDefaults = .standard) -> LastStatus? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(LastStatus.self, from: data)
    }

    static func save(_ status: LastStatus?, _ defaults: UserDefaults = .standard) {
        if let status, let data = try? JSONEncoder().encode(status) { defaults.set(data, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}

/// The consent the app still needs before the web app may load: for this version of the list of AI services.
struct ConsentRequest: Equatable {
    let version: String
    /// nil: the pc cannot tell which AI services it uses (an older TeamBot) — the screen then says so.
    let info: PrivacyInfo?
}

/// App state: unpaired → checking → consent (first use, or the list of AI services changed) → connected ⇄ problem
/// (one honest reason per broken link); revoked when the pc proved it no longer knows this iPhone.
@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case unpaired
        case checking(Pairing)
        /// nil request: loading the list.
        case consent(Pairing, ConsentRequest?)
        case connected(Pairing)
        case problem(Pairing, LinkProblem)
        case revoked
    }

    @Published private(set) var phase: Phase
    @Published private(set) var checking = false
    @Published private(set) var network = PhoneNetwork.assumed
    @Published private(set) var last: LastStatus?
    /// Ask once after pairing whether to enable notifications.
    @Published var askPush = false
    /// The native settings sheet (connection, consent, unpair).
    @Published var showSettings = false
    /// In-app route (e.g. "#/t/abc") to open after a notification tap.
    @Published var pendingLink: String?
    /// Shown on the pairing screen after unpairing while the pc could not be reached.
    @Published var unpairNote: String?

    let consent = ConsentStore()
    private let client = HostClient()
    private let monitor = NetworkMonitor()
    private var checkAgain = false

    init() {
        last = LastStatus.load()
        if let p = KeychainStore.load() { phase = .checking(p) } else { phase = .unpaired }
        monitor.start { [weak self] net in self?.networkChanged(net) }
    }

    var pairing: Pairing? {
        switch phase {
        case .checking(let p), .consent(let p, _), .connected(let p), .problem(let p, _): return p
        case .unpaired, .revoked: return nil
        }
    }

    /// Wave 2 (plan §C): the pc tells which page to open first — the main bot (`home` in `GET /api/mobile/status`,
    /// filled by `ctx.services.mobileHome` on the server). Until then nil: the web app's own start page.
    var startRoute: String? { last?.home }

    // MARK: pairing

    func pair(link: PairingLink, name: String) async throws {
        try await finishPairing(base: link.baseURL, secret: link.secret, code: nil, name: name, irohId: link.irohId, irohRelay: link.irohRelay)
    }

    func pair(base: URL, code: String, name: String) async throws {
        try await finishPairing(base: base, secret: nil, code: PairingLink.normalizeCode(code), name: name, irohId: nil, irohRelay: nil)
    }

    /// Claims at the address in the QR code; not on the pc's wifi (or a teambot://pair code), then through the
    /// TeamBot connection with the pc's key from the code.
    private func finishPairing(base: URL, secret: String?, code: String?, name: String, irohId: String?, irohRelay: String?) async throws {
        var claimBase = base
        let result: ClaimResult
        if HostAddress.kind(of: base) == .teambotLink {
            guard let irohId else { throw HostError.invalidResponse }
            claimBase = try await IrohTunnel.shared.start(id: irohId, relay: irohRelay)
            result = try await client.claim(base: claimBase, secret: secret, code: code, deviceName: name)
        } else {
            do {
                result = try await client.claim(base: base, secret: secret, code: code, deviceName: name)
            } catch HostError.unreachable {
                guard let irohId else { throw HostError.unreachable }
                claimBase = try await IrohTunnel.shared.start(id: irohId, relay: irohRelay)
                result = try await client.claim(base: claimBase, secret: secret, code: code, deviceName: name)
            }
        }
        let p = Pairing(baseURL: claimBase, token: result.token, deviceId: result.device.id, deviceName: result.device.name, pairedURL: base, irohId: irohId, irohRelay: irohRelay)
        guard KeychainStore.save(p) else { throw HostError.rejected("Kon de sleutel niet veilig opslaan in de sleutelhanger.") }
        unpairNote = nil
        phase = .checking(p)
        askPush = true
        await refresh()
    }

    // MARK: opening the app

    private var backgroundedAt: Date?

    /// At launch with a stored pairing (also after the app was swiped away). Every address of the pc is asked at once,
    /// the TeamBot connection too, and the one that worked last gets a head start (probe). The web app opens on the
    /// first address that proves itself: at home within a fraction of a second, on that same address (same origin,
    /// so the web app keeps its storage and nothing reloads). Until then CheckingView shows only the bot, and
    /// "Verbinden met je pc…" only after a short grace period; a problem screen only when nothing answers.
    /// The web app is never opened on an address that did not prove itself first: on another wifi the same
    /// 192.168.x address can be someone else's device, and the page there would get the token.
    /// Not tied to CheckingView: that screen disappears when the check is done, which must not cancel the check.
    func launch() async {
        guard case .checking = phase, !checking else { return }
        Task { await self.refresh() }
    }

    func wentToBackground() {
        backgroundedAt = Date()
    }

    /// Back in the app. After a short moment away nothing has to be checked again; after longer the TeamBot
    /// connection dials again right away (it may have died while the app slept) and the links are checked behind
    /// the conversations.
    func cameBack() async {
        guard let since = backgroundedAt else { return }
        backgroundedAt = nil
        if case .connected(let p) = phase {
            // Also picks up consent withdrawn in iOS Settings.
            if Date().timeIntervalSince(since) < 20, consent.grantedVersion != nil { return }
            if HostAddress.kind(of: p.baseURL) == .teambotLink { await IrohTunnel.shared.redial() }
        }
        await refresh()
    }

    // MARK: honest status per link

    /// Asks every known address of the pc at once (without the token) and decides which link is broken.
    func refresh() async {
        guard pairing != nil else { return }
        if checking {
            checkAgain = true
            return
        }
        checking = true
        defer { checking = false }
        repeat {
            checkAgain = false
            await check()
        } while checkAgain
    }

    private func check(again: Bool = false) async {
        guard let p = pairing else { return }
        let answers = await probe(p)
        guard pairing?.deviceId == p.deviceId else { return } // unpaired meanwhile
        switch LinkDiagnosis.diagnose(answers.attempts, phone: network, pairing: p) {
        case .reachable(let url, _):
            await connect(p, via: url)
            // Another address won: the TeamBot connection is not needed. Stopped only now, after the web app moved
            // to that address, so a page that was still on the TeamBot connection is not cut off first.
            if HostAddress.kind(of: url) != .teambotLink { await IrohTunnel.shared.stop() }
        case .problem(.revoked(confirmed: true)):
            await forget()
            phase = .revoked
        case .problem(let problem):
            // No answer through the TeamBot connection: start it fresh next time (sockets may be stale after the app
            // slept).
            if !answers.linkAnswered { await IrohTunnel.shared.stop() }
            // The conversations are on screen: one missed answer (the app just woke up, the network just changed)
            // does not take them away. Only when the second try fails too.
            if case .connected = phase, !again {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                await check(again: true)
                return
            }
            phase = .problem(p, problem)
        }
    }

    private struct Probe {
        /// In the order LinkDiagnosis.diagnose expects (ProbeRace.attempts).
        let attempts: [LinkDiagnosis.Attempt]
        let linkAnswered: Bool
    }

    /// Every address is asked at the same time: wifi, Tailscale and https (Pairing.candidates) and the TeamBot
    /// connection, which is dialed right away too, not only after the others gave up. The first proven answer
    /// decides (ProbeRace), so away from home the app does not wait until the wifi addresses give up, and at home it
    /// does not wait for addresses of the pc that this iPhone cannot reach (a second network card, a VPN adapter).
    /// The address that worked last gets a short head start, so the web app stays on its origin.
    private func probe(_ p: Pairing) async -> Probe {
        let client = self.client
        let urls = p.candidates
        let irohId = p.irohId
        let relay = p.irohRelay
        let count = urls.count + (irohId == nil ? 0 : 1)
        let last = ProbeRace.last(of: p, candidates: urls.count, link: irohId != nil)
        let decided = await withTaskGroup(of: (Int, LinkDiagnosis.Attempt?).self) { group -> ProbeRace in
            var race = ProbeRace(probes: count, last: last)
            for (i, url) in urls.enumerated() {
                group.addTask {
                    let outcome = await client.hello(base: url, pairing: p)
                    return (i, LinkDiagnosis.Attempt(url: url, outcome: outcome))
                }
            }
            if let irohId {
                group.addTask {
                    do {
                        let base = try await IrohTunnel.shared.start(id: irohId, relay: relay)
                        let outcome = await client.hello(base: base, pairing: p, timeout: 15)
                        return (ProbeRace.link, LinkDiagnosis.Attempt(url: base, outcome: outcome))
                    } catch {
                        return (ProbeRace.link, LinkDiagnosis.Attempt(url: IrohTunnel.placeholder, outcome: .unreachable))
                    }
                }
            }
            // The head start of the address that worked last (nil attempt: the time is up).
            if last != nil && count > 1 {
                group.addTask {
                    try? await Task.sleep(nanoseconds: ProbeRace.headStart)
                    return (-1, nil)
                }
            }
            for await r in group {
                let done: Bool
                if let attempt = r.1 {
                    done = race.add(r.0, attempt)
                } else {
                    done = race.endHeadStart()
                }
                if done { break }
            }
            // The probes still running stop at once (their requests are cancelled).
            group.cancelAll()
            return race
        }
        return Probe(attempts: decided.attempts, linkAnswered: decided.linkAnswered)
    }

    /// The address proved itself: now (and only now) the token goes there.
    private func connect(_ old: Pairing, via url: URL) async {
        var p = old
        switch await client.status(p, base: url) {
        case .revoked:
            await forget()
            phase = .revoked
        case .unreachable:
            phase = .problem(p, .pcAsleep(orClosed: true))
        case .ok(let info):
            p.baseURL = url
            var version = ConsentStore.unknownVersion
            if let info {
                if p.instance == nil { p.instance = info.instance }
                // The pc's TeamBot connection (it may have been turned on after pairing, or got an own relay).
                if let iroh = info.iroh, PairingLink.validKey(iroh.id) != nil {
                    p.irohId = iroh.id
                    p.irohRelay = iroh.relay.flatMap(PairingLink.validRelay)
                }
                let learned = info.addresses.compactMap { HostAddress.accept($0.url) }
                if !learned.isEmpty { p.addresses = learned }
                last = LastStatus(connectedAt: Date(), power: info.power, home: info.home)
                version = info.privacy?.version ?? ConsentStore.unknownVersion
            } else {
                last = LastStatus(connectedAt: Date(), power: nil, home: nil)
            }
            LastStatus.save(last)
            if p != old { KeychainStore.save(p) }
            noteRoute(p)
            if consent.isGranted(version) {
                phase = .connected(p)
            } else {
                if case .consent(_, let shown?) = phase, shown.version == version {
                    phase = .consent(p, shown)
                    return
                }
                phase = .consent(p, nil)
                let info = await client.privacy(p, base: url)
                // The list is the one the user reads and agrees to; its own version wins.
                phase = .consent(p, ConsentRequest(version: info?.version ?? version, info: info))
            }
        }
    }

    // MARK: how the iPhone reaches the pc (shown plainly: AppSettingsView, RouteBadge)

    /// Through the TeamBot connection: directly or via the relay (known a moment after connecting).
    @Published private(set) var linkRoute: IrohTunnel.Route?

    private func noteRoute(_ p: Pairing) {
        guard HostAddress.kind(of: p.baseURL) == .teambotLink else {
            linkRoute = nil
            return
        }
        Task {
            linkRoute = await IrohTunnel.shared.route()
            // iroh first goes through the relay and switches to a direct path when it finds one.
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            linkRoute = await IrohTunnel.shared.route()
        }
    }

    /// In plain words how this iPhone reaches the pc now, or nil when it is not connected.
    var routeText: String? {
        guard case .connected(let p) = phase else { return nil }
        switch HostAddress.kind(of: p.baseURL) {
        case .lan: return "Thuis, via wifi"
        case .tailscale, .tailscaleHTTPS: return "Via Tailscale"
        case .internet: return "Via internet (https)"
        case .teambotLink: return linkRoute == .direct ? "Via TeamBot-verbinding, direct" : "Onderweg via TeamBot-verbinding"
        }
    }

    // MARK: consent (App Review 5.1.2(i))

    func grantConsent() {
        guard case .consent(let p, let request?) = phase else { return }
        consent.grant(request.version)
        phase = .connected(p)
    }

    func withdrawConsent() {
        consent.withdraw()
        guard let p = pairing else { return }
        phase = .consent(p, nil)
        Task { await refresh() }
    }

    /// For the settings sheet: the current list, only from the address that proved itself last.
    func loadPrivacy() async -> PrivacyInfo? {
        guard case .connected(let p) = phase else { return nil }
        return await client.privacy(p, base: p.baseURL)
    }

    // MARK: unpair / pair again (never touches conversations: they live on the pc)

    func unpair() async {
        guard let p = pairing else {
            phase = .unpaired
            return
        }
        var confirmed = false
        let attempts = await probe(p).attempts
        switch LinkDiagnosis.diagnose(attempts, phone: network, pairing: p) {
        case .reachable(let url, _): confirmed = await client.unpair(p, base: url)
        case .problem(.revoked(confirmed: true)): confirmed = true
        default: break
        }
        await forget()
        phase = .unpaired
        unpairNote = confirmed ? nil : "Je pc was niet bereikbaar. Trek deze iPhone daar ook in: Instellingen › Telefoon › Gekoppelde telefoons."
    }

    func startOver() {
        phase = .unpaired
    }

    /// Removes the key. Web data goes too, except the web app's local storage: messages that were not delivered yet
    /// ("Nog niet afgeleverd") stay on this iPhone. The old token copy in there no longer works and is replaced on
    /// the next pairing (WebShellView.bootstrapScript).
    private func forget() async {
        KeychainStore.delete()
        await IrohTunnel.shared.stop()
        var types = WKWebsiteDataStore.allWebsiteDataTypes()
        types.remove(WKWebsiteDataTypeLocalStorage)
        await WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast)
        last = nil
        LastStatus.save(nil)
    }

    private func networkChanged(_ net: PhoneNetwork) {
        guard net != network else { return }
        network = net
        switch phase {
        case .checking, .connected, .problem: Task { await refresh() }
        default: break
        }
    }

    // MARK: messages from the web app (fixed words only; the shell never runs code it receives)

    func webSaid(_ word: String) {
        switch word {
        case "unauthorized": Task { await refresh() }
        case "settings": showSettings = true
        default: break
        }
    }

    // MARK: push (APNs — needs an Apple Developer account and an APNs key on the host)

    func enablePush() async {
        askPush = false
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    func uploadPushToken(_ token: String) async {
        guard let p = pairing else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        try? await client.registerPush(p, token: token, environment: environment)
    }

    func open(link: String) {
        if link.hasPrefix("#/") { pendingLink = link }
    }
}
