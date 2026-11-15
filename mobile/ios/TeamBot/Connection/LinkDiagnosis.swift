import Foundation

/// What iOS says about this iPhone's own connection (NWPathMonitor).
struct PhoneNetwork: Equatable, Sendable {
    var online: Bool
    var onWiFi: Bool

    /// Before the first update: assume online, so the app never says "offline" without reason.
    static let assumed = PhoneNetwork(online: true, onWiFi: true)
}

/// Which link is broken, in the words of the plan: pc slaapt / TeamBot is dicht / netwerk weg / telefoon offline /
/// koppeling ingetrokken. Each one has its own screen with a fix in one tap or a clear next step.
enum LinkProblem: Equatable {
    case phoneOffline
    case networkGone(NetworkHint)
    /// Nothing answers. `orClosed`: the app cannot tell a sleeping pc from a closed TeamBot on this link
    /// (only Tailscale https tells them apart: a pc that is awake always answers there).
    case pcAsleep(orClosed: Bool)
    case appClosed
    /// `confirmed`: the pc proved it (the key is then forgotten). Otherwise the pc answers but no longer knows this
    /// iPhone; pairing again is the user's choice.
    case revoked(confirmed: Bool)
}

enum NetworkHint: Equatable {
    /// Only home-wifi addresses are known and this iPhone is not on wifi.
    case notOnHomeWifi
    /// The Tailscale https name is not found: Tailscale is off on this iPhone.
    case tailscaleOff
    /// On wifi, but iOS does not let the app into the local network (Settings › TeamBot › Lokaal netwerk).
    case localNetworkDenied
    /// Something else answers on the pc's addresses: another network (a wifi with a login page, another TeamBot).
    case otherNetwork
    /// Certificate or App Transport Security problem.
    case blocked
}

enum LinkDiagnosis {
    struct Attempt: Equatable, Sendable {
        let url: URL
        let outcome: ProbeOutcome
    }

    enum Result: Equatable {
        /// Our TeamBot answers on this address. `proven`: it proved it knows this iPhone (hello). Otherwise an older
        /// TeamBot without hello, trusted only on https or on the address the user paired with.
        case reachable(URL, proven: Bool)
        case problem(LinkProblem)
    }

    /// May the token go to this address without a proof? Only https (the certificate vouches for the name) or the
    /// address the user scanned or typed himself.
    static func trustedWithoutProof(_ url: URL, pairing: Pairing) -> Bool {
        url.scheme?.lowercased() == "https" || HostAddress.origin(of: url) == HostAddress.origin(of: pairing.pairedURL)
    }

    /// `attempts` in priority order (Pairing.candidates). Pure: no network, so it is unit tested.
    static func diagnose(_ attempts: [Attempt], phone: PhoneNetwork, pairing: Pairing) -> Result {
        func ours(_ h: Hello) -> Bool { pairing.instance == nil || h.instance == pairing.instance }

        // 1. A proven answer from our own TeamBot decides.
        for a in attempts {
            if case .hello(let h) = a.outcome, h.verified, ours(h) {
                return h.device == .active ? .reachable(a.url, proven: true) : .problem(.revoked(confirmed: true))
            }
        }
        // 2. Our TeamBot answers, but cannot vouch for this iPhone any more.
        for a in attempts {
            guard case .hello(let h) = a.outcome, !h.verified else { continue }
            if let inst = pairing.instance, h.instance == inst { return .problem(.revoked(confirmed: false)) }
            if pairing.instance == nil, trustedWithoutProof(a.url, pairing: pairing) { return .problem(.revoked(confirmed: false)) }
        }
        // 3. An older TeamBot without hello, or a busy one.
        for a in attempts where a.outcome == .legacyHost || a.outcome == .busy {
            if trustedWithoutProof(a.url, pairing: pairing) { return .reachable(a.url, proven: false) }
        }

        let outcomes = attempts.map(\.outcome)
        // 4. This iPhone itself.
        if !phone.online { return .problem(.phoneOffline) }
        if phone.onWiFi, attempts.contains(where: { $0.outcome == .phoneOffline && HostAddress.kind(of: $0.url) == .lan }) {
            return .problem(.networkGone(.localNetworkDenied))
        }
        if !outcomes.isEmpty, outcomes.allSatisfy({ $0 == .phoneOffline }) { return .problem(.phoneOffline) }
        // 5. The pc answered, TeamBot did not.
        if outcomes.contains(.refused) || outcomes.contains(.proxyDown) { return .problem(.appClosed) }
        // 6. Tailscale is off on this iPhone: the ts.net name does not exist without it.
        let viaTailscaleHTTPS = attempts.filter { HostAddress.kind(of: $0.url) == .tailscaleHTTPS }
        if viaTailscaleHTTPS.contains(where: { $0.outcome == .noHost }) { return .problem(.networkGone(.tailscaleOff)) }
        // 7. Something else answers on our addresses.
        let foreign = attempts.contains { a in
            switch a.outcome {
            case .notTeamBot: return true
            case .hello(let h): return !ours(h)
            default: return false
            }
        }
        if foreign { return .problem(.networkGone(.otherNetwork)) }
        // 8. Only home-wifi addresses, and this iPhone is not on wifi.
        let kinds = Set(attempts.map { HostAddress.kind(of: $0.url) })
        if kinds == [.lan] && !phone.onWiFi { return .problem(.networkGone(.notOnHomeWifi)) }
        // 9. Nothing can be opened safely.
        if !outcomes.isEmpty, outcomes.allSatisfy({ $0 == .blocked }) { return .problem(.networkGone(.blocked)) }
        // 10. Nothing answers. Through Tailscale https a pc that is awake always answers (502 when TeamBot is closed),
        //     so a time-out there means the pc sleeps or is off.
        let sure = viaTailscaleHTTPS.contains { $0.outcome == .timedOut }
        return .problem(.pcAsleep(orClosed: !sure))
    }
}

/// Which answers of the probe decide (AppModel.probe), as they come in. Every address is asked at the same time, the
/// TeamBot connection too (not only after the others gave up). The first one that proves itself decides, except that
/// the address that worked last gets a short head start: it is the web app's origin, with its own storage (open
/// pages, messages not delivered yet), so two addresses that both work (wifi and Tailscale, two network cards of the
/// pc, or wifi and the TeamBot connection) do not take turns from one launch to the next. Pure, so it is unit tested.
struct ProbeRace {
    /// How long the address that worked last may take before another proven address wins (nanoseconds). At home an
    /// answer takes a few hundredths of a second.
    static let headStart: UInt64 = 800_000_000
    /// The TeamBot connection's place among the probes: after every address of Pairing.candidates.
    static let link = Int.max

    private struct Answer {
        let index: Int
        let attempt: LinkDiagnosis.Attempt
    }

    /// The probe of the address that worked last; nil when it is not among them.
    let last: Int?
    private(set) var headStartOver: Bool
    private var running: Int
    private var got: [Answer] = []

    /// `probes`: how many probes run (the head-start timer not counted).
    init(probes: Int, last: Int?) {
        self.running = probes
        self.last = last
        self.headStartOver = last == nil
    }

    /// Where the address that worked last is among the probes: the first of Pairing.candidates (that list starts with
    /// it), or the TeamBot connection when that was the one.
    static func last(of p: Pairing, candidates: Int, link: Bool) -> Int? {
        if HostAddress.kind(of: p.baseURL) == .teambotLink { return link ? Self.link : nil }
        return candidates > 0 ? 0 : nil
    }

    /// One probe answered. True: this decides, the other probes can stop.
    mutating func add(_ index: Int, _ attempt: LinkDiagnosis.Attempt) -> Bool {
        got.append(Answer(index: index, attempt: attempt))
        running -= 1
        if index == last {
            if Self.proven(attempt) { return true }
            // It answered, but not as our TeamBot: there is nothing to wait for any more.
            headStartOver = true
        }
        return (headStartOver && hasProven) || running <= 0
    }

    /// The head start ran out. True: a proven answer is there and decides.
    mutating func endHeadStart() -> Bool {
        headStartOver = true
        return hasProven || running <= 0
    }

    var hasProven: Bool {
        got.contains { Self.proven($0.attempt) }
    }

    /// The answers so far in the order LinkDiagnosis.diagnose expects: the address that worked last first, then
    /// Pairing.candidates in their order, the TeamBot connection last.
    var attempts: [LinkDiagnosis.Attempt] {
        got.sorted { rank($0.index) < rank($1.index) }.map { $0.attempt }
    }

    /// The TeamBot connection gave an answer of TeamBot (proven or not): it works, keep it when it is in use.
    var linkAnswered: Bool {
        got.contains { a in
            if a.index == Self.link, case .hello = a.attempt.outcome { return true }
            return false
        }
    }

    private func rank(_ index: Int) -> Int {
        index == last ? Int.min : index
    }

    static func proven(_ a: LinkDiagnosis.Attempt) -> Bool {
        if case .hello(let h) = a.outcome, h.verified { return true }
        return false
    }
}
