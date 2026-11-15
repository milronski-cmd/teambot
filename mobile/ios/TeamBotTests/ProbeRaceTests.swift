import XCTest
@testable import TeamBot

/// Which answer decides when every address is asked at once (AppModel.probe, also after the app was swiped away): the
/// address that worked last wins when it answers within its head start, so the web app stays on its origin; otherwise
/// the first proven answer, and the TeamBot connection races with the others instead of waiting until they give up.
final class ProbeRaceTests: XCTestCase {
    private let lan = URL(string: "http://192.168.1.20:4748")!
    private let lan2 = URL(string: "http://192.168.1.21:4748")!
    private let ts = URL(string: "http://100.101.102.103:4748")!
    private let tunnel = URL(string: "http://127.0.0.1:52123")!
    private let key = "523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea"
    private let home = PhoneNetwork(online: true, onWiFi: true)
    private let proven = ProbeOutcome.hello(Hello(instance: "tbi_mine0000000000000", device: .active, verified: true))

    private func attempt(_ url: URL, _ outcome: ProbeOutcome) -> LinkDiagnosis.Attempt {
        LinkDiagnosis.Attempt(url: url, outcome: outcome)
    }

    func testTheAddressThatWorkedLastIsAskedFirst() {
        let p = Pairing(baseURL: lan2, token: "t", deviceId: "d", deviceName: "n", addresses: [lan, lan2, ts], irohId: key)
        XCTAssertEqual(p.candidates.first, lan2)
        XCTAssertEqual(ProbeRace.last(of: p, candidates: p.candidates.count, link: true), 0)
        // The TeamBot connection worked last: that probe has the head start.
        let viaLink = Pairing(baseURL: tunnel, token: "t", deviceId: "d", deviceName: "n", addresses: [lan], irohId: key)
        XCTAssertEqual(ProbeRace.last(of: viaLink, candidates: viaLink.candidates.count, link: true), ProbeRace.link)
        XCTAssertNil(ProbeRace.last(of: viaLink, candidates: viaLink.candidates.count, link: false))
    }

    func testAnotherAddressWaitsForTheOneThatWorkedLast() {
        // Two network cards of the pc both answer; the second one is a bit quicker this time.
        var race = ProbeRace(probes: 3, last: 0)
        let first = race.add(1, attempt(lan2, proven))
        XCTAssertFalse(first, "within the head start the address that worked last may still answer")
        let second = race.add(0, attempt(lan, proven))
        XCTAssertTrue(second)
        let p = Pairing(baseURL: lan, token: "t", deviceId: "d", deviceName: "n", addresses: [lan, lan2, ts])
        XCTAssertEqual(LinkDiagnosis.diagnose(race.attempts, phone: home, pairing: p), .reachable(lan, proven: true), "same origin: nothing reloads")
    }

    func testAfterTheHeadStartTheFirstProvenAnswerWins() {
        var race = ProbeRace(probes: 3, last: 0)
        let early = race.add(2, attempt(ts, proven))
        XCTAssertFalse(early)
        let timeUp = race.endHeadStart()
        XCTAssertTrue(timeUp)
        let p = Pairing(baseURL: lan, token: "t", deviceId: "d", deviceName: "n", addresses: [lan, ts])
        XCTAssertEqual(LinkDiagnosis.diagnose(race.attempts, phone: home, pairing: p), .reachable(ts, proven: true))
        // Once the head start is over, a proven answer decides at once.
        var later = ProbeRace(probes: 2, last: 0)
        let nothingYet = later.endHeadStart()
        XCTAssertFalse(nothingYet)
        let answer = later.add(1, attempt(ts, proven))
        XCTAssertTrue(answer)
    }

    func testNoWaitingWhenTheAddressThatWorkedLastFails() {
        var race = ProbeRace(probes: 3, last: 0)
        let other = race.add(1, attempt(lan2, proven))
        XCTAssertFalse(other)
        let failed = race.add(0, attempt(lan, .refused))
        XCTAssertTrue(failed, "it gave its answer: no reason to wait for the head start")
    }

    func testTheTeamBotConnectionRacesInsteadOfComingLast() {
        // Away from home, the wifi address worked last: the TeamBot connection proves itself before wifi times out.
        var race = ProbeRace(probes: 2, last: 0)
        let viaLink = race.add(ProbeRace.link, attempt(tunnel, proven))
        XCTAssertFalse(viaLink)
        let timeUp = race.endHeadStart()
        XCTAssertTrue(timeUp, "decided after the head start, not after the wifi address gave up")
        XCTAssertTrue(race.linkAnswered)
        let p = Pairing(baseURL: lan, token: "t", deviceId: "d", deviceName: "n", irohId: key)
        XCTAssertEqual(LinkDiagnosis.diagnose(race.attempts, phone: PhoneNetwork(online: true, onWiFi: false), pairing: p), .reachable(tunnel, proven: true))
    }

    func testTheTeamBotConnectionThatWorkedLastKeepsItsPlace() {
        // At home the wifi address answers too, but the web app is on the TeamBot connection and that answers in time.
        var race = ProbeRace(probes: 2, last: ProbeRace.link)
        let wifi = race.add(0, attempt(lan, proven))
        XCTAssertFalse(wifi)
        let viaLink = race.add(ProbeRace.link, attempt(tunnel, proven))
        XCTAssertTrue(viaLink)
        XCTAssertEqual(race.attempts.first?.url, tunnel, "the address that worked last comes first for the diagnosis")
        let p = Pairing(baseURL: tunnel, token: "t", deviceId: "d", deviceName: "n", addresses: [lan], irohId: key)
        XCTAssertEqual(LinkDiagnosis.diagnose(race.attempts, phone: home, pairing: p), .reachable(tunnel, proven: true))
    }

    func testWithoutAProvenAnswerEveryProbeIsHeard() {
        var race = ProbeRace(probes: 2, last: 0)
        let wifi = race.add(0, attempt(lan, .timedOut))
        XCTAssertFalse(wifi)
        let timeUp = race.endHeadStart()
        XCTAssertFalse(timeUp)
        let viaLink = race.add(ProbeRace.link, attempt(tunnel, .timedOut))
        XCTAssertTrue(viaLink)
        XCTAssertEqual(race.attempts.map(\.url), [lan, tunnel])
        XCTAssertFalse(race.linkAnswered)
    }

    func testWithoutAnAddressThatWorkedLastTheFirstProvenAnswerDecides() {
        var race = ProbeRace(probes: 3, last: nil)
        XCTAssertTrue(race.headStartOver)
        let first = race.add(2, attempt(ts, proven))
        XCTAssertTrue(first)
    }
}
