import XCTest
@testable import TeamBot

/// Every link state of the plan (pc slaapt / TeamBot is dicht / netwerk weg / telefoon offline / koppeling
/// ingetrokken) from what the addresses answered — no network needed.
final class LinkDiagnosisTests: XCTestCase {
    private let lan = URL(string: "http://192.168.1.20:4748")!
    private let ts = URL(string: "http://100.101.102.103:4748")!
    private let tsHTTPS = URL(string: "https://pc.tail1234.ts.net")!
    private let home = PhoneNetwork(online: true, onWiFi: true)
    private let cellular = PhoneNetwork(online: true, onWiFi: false)

    private func pairing(instance: String? = "tbi_mine0000000000000") -> Pairing {
        Pairing(baseURL: lan, token: "t", deviceId: "ses_1", deviceName: "iPhone", addresses: [tsHTTPS, ts], instance: instance)
    }

    private func hello(_ state: DeviceState, verified: Bool = true, instance: String = "tbi_mine0000000000000") -> ProbeOutcome {
        .hello(Hello(instance: instance, device: state, verified: verified))
    }

    private func diagnose(_ pairs: [(URL, ProbeOutcome)], phone: PhoneNetwork? = nil, pairing p: Pairing? = nil) -> LinkDiagnosis.Result {
        LinkDiagnosis.diagnose(pairs.map { LinkDiagnosis.Attempt(url: $0.0, outcome: $0.1) }, phone: phone ?? home, pairing: p ?? pairing())
    }

    func testConnectedOnTheFirstAddressThatProvesItself() {
        XCTAssertEqual(diagnose([(lan, .timedOut), (tsHTTPS, hello(.active))]), .reachable(tsHTTPS, proven: true))
        XCTAssertEqual(diagnose([(lan, hello(.active)), (tsHTTPS, hello(.active))]), .reachable(lan, proven: true))
    }

    func testRevokedOnlyWhenTheHostProvesIt() {
        XCTAssertEqual(diagnose([(lan, hello(.revoked))]), .problem(.revoked(confirmed: true)))
        // Our TeamBot (same instance) but no proof for this iPhone: the pairing is gone there, the user decides.
        XCTAssertEqual(diagnose([(lan, hello(.unknown, verified: false))]), .problem(.revoked(confirmed: false)))
        // A stranger saying "revoked" without proof can never make the app forget its key.
        XCTAssertEqual(diagnose([(lan, hello(.revoked, verified: false, instance: "tbi_other000000000000"))]), .problem(.networkGone(.otherNetwork)))
    }

    func testPhoneOffline() {
        XCTAssertEqual(diagnose([(lan, .phoneOffline), (ts, .phoneOffline)], phone: PhoneNetwork(online: false, onWiFi: false)), .problem(.phoneOffline))
        XCTAssertEqual(diagnose([(ts, .phoneOffline)], phone: cellular), .problem(.phoneOffline))
    }

    func testLocalNetworkPermissionDenied() {
        // On wifi, internet works, but iOS refuses the home address: the Local Network switch is off for TeamBot.
        XCTAssertEqual(diagnose([(lan, .phoneOffline), (tsHTTPS, .noHost)]), .problem(.networkGone(.localNetworkDenied)))
    }

    func testTeamBotClosedWhenThePcAnswers() {
        XCTAssertEqual(diagnose([(lan, .refused), (tsHTTPS, .noHost)]), .problem(.appClosed))
        // Tailscale Serve answers 502 when the pc is awake but TeamBot does not run.
        XCTAssertEqual(diagnose([(lan, .timedOut), (tsHTTPS, .proxyDown)], phone: cellular), .problem(.appClosed))
    }

    func testTailscaleOffOnThisIPhone() {
        XCTAssertEqual(diagnose([(lan, .timedOut), (tsHTTPS, .noHost), (ts, .timedOut)], phone: cellular), .problem(.networkGone(.tailscaleOff)))
    }

    func testOtherNetwork() {
        XCTAssertEqual(diagnose([(lan, .notTeamBot), (tsHTTPS, .timedOut)]), .problem(.networkGone(.otherNetwork)))
        XCTAssertEqual(diagnose([(lan, hello(.active, verified: true, instance: "tbi_other000000000000"))]), .problem(.networkGone(.otherNetwork)))
    }

    func testNotOnHomeWifi() {
        let wifiOnly = Pairing(baseURL: lan, token: "t", deviceId: "ses_1", deviceName: "iPhone", instance: "tbi_mine0000000000000")
        XCTAssertEqual(diagnose([(lan, .timedOut)], phone: cellular, pairing: wifiOnly), .problem(.networkGone(.notOnHomeWifi)))
        // At home on wifi the same silence means: the pc sleeps (or TeamBot is closed — the app cannot tell on wifi).
        XCTAssertEqual(diagnose([(lan, .timedOut)], phone: home, pairing: wifiOnly), .problem(.pcAsleep(orClosed: true)))
    }

    func testPcAsleepIsCertainOnlyThroughTailscaleHTTPS() {
        // Tailscale is on (the name resolves) and nothing answers: an awake pc would answer, so it sleeps or is off.
        XCTAssertEqual(diagnose([(lan, .timedOut), (tsHTTPS, .timedOut)], phone: cellular), .problem(.pcAsleep(orClosed: false)))
        XCTAssertEqual(diagnose([(lan, .timedOut), (ts, .unreachable)], phone: home, pairing: Pairing(baseURL: lan, token: "t", deviceId: "d", deviceName: "n", addresses: [ts])), .problem(.pcAsleep(orClosed: true)))
    }

    func testOlderTeamBotOnlyTrustedOnHTTPSOrThePairedAddress() {
        XCTAssertEqual(diagnose([(lan, .legacyHost)]), .reachable(lan, proven: false))
        XCTAssertEqual(diagnose([(lan, .timedOut), (tsHTTPS, .legacyHost)]), .reachable(tsHTTPS, proven: false))
        // A plain-http address the host listed (not the one the user paired with) needs a proof.
        let p = Pairing(baseURL: tsHTTPS, token: "t", deviceId: "d", deviceName: "n", pairedURL: tsHTTPS, addresses: [ts], instance: "tbi_mine0000000000000")
        XCTAssertEqual(diagnose([(tsHTTPS, .timedOut), (ts, .legacyHost)], phone: cellular, pairing: p), .problem(.pcAsleep(orClosed: false)))
    }

    func testBlocked() {
        XCTAssertEqual(diagnose([(lan, .blocked)]), .problem(.networkGone(.blocked)))
    }

    func testEveryProblemHasAPlainTitleAndAFix() {
        let all: [LinkProblem] = [
            .phoneOffline, .appClosed, .pcAsleep(orClosed: true), .pcAsleep(orClosed: false), .revoked(confirmed: true), .revoked(confirmed: false),
            .networkGone(.notOnHomeWifi), .networkGone(.tailscaleOff), .networkGone(.localNetworkDenied), .networkGone(.otherNetwork), .networkGone(.blocked),
        ]
        var titles = Set<String>()
        for problem in all {
            let copy = ProblemCopy.make(problem, pairing: pairing(), phone: cellular, last: nil)
            XCTAssertFalse(copy.title.isEmpty)
            XCTAssertFalse(copy.body.isEmpty)
            XCTAssertFalse(copy.actions.isEmpty, "\(problem) needs a one-tap fix")
            titles.insert(copy.title)
        }
        XCTAssertEqual(titles.count, all.count, "every link state says something different")
        XCTAssertEqual(ProblemCopy.make(.networkGone(.tailscaleOff), pairing: pairing(), phone: cellular, last: nil).actions.first, .openTailscale)
        XCTAssertEqual(ProblemCopy.make(.networkGone(.localNetworkDenied), pairing: pairing(), phone: home, last: nil).actions.first, .openAppSettings)
        XCTAssertTrue(ProblemCopy.make(.revoked(confirmed: true), pairing: pairing(), phone: home, last: nil).body.contains("blijven bewaard"))
    }

    func testKeepAwakeTipFollowsThePc() {
        let off = LastStatus(connectedAt: Date(), power: .init(available: true, keepAwake: false), home: nil)
        let copy = ProblemCopy.make(.pcAsleep(orClosed: false), pairing: pairing(), phone: home, last: off)
        XCTAssertTrue(copy.tips.contains { $0.contains("Houd de pc wakker") })
        let noShell = LastStatus(connectedAt: Date(), power: .init(available: false, keepAwake: false), home: nil)
        XCTAssertFalse(ProblemCopy.make(.pcAsleep(orClosed: false), pairing: pairing(), phone: home, last: noShell).tips.contains { $0.contains("Houd de pc wakker") })
    }
}
