import XCTest
@testable import TeamBot

/// The TeamBot connection (iroh): the pc's key from the QR code, the teambot://pair form, and the loopback proxy that
/// is never treated as an address of the pc. (The tunnel itself needs a pc; it is tested on the pc side with a Node
/// stand-in: tests/mobile-iroh.test.ts and npm run iroh:live.)
final class TeamBotLinkTests: XCTestCase {
    private let secret = String(repeating: "aB3_-", count: 9)
    private let key = "523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea"

    func testWifiCodeCarriesTheKey() {
        let link = PairingLink.parse("http://192.168.1.20:4748/api/public/mobile/pair#t=\(secret)&n=\(key)")
        XCTAssertEqual(link?.baseURL.absoluteString, "http://192.168.1.20:4748")
        XCTAssertEqual(link?.secret, secret)
        XCTAssertEqual(link?.irohId, key)
        XCTAssertNil(link?.irohRelay)
        XCTAssertEqual(link?.onlyTeamBotLink, false)
        // An older code without the key still works the old way.
        XCTAssertNil(PairingLink.parse("http://192.168.1.20:4748/api/public/mobile/pair#t=\(secret)")?.irohId)
    }

    func testTeamBotLinkOnlyCode() {
        let relay = "https%3A%2F%2Frelay.voorbeeld.nl%2F"
        let link = PairingLink.parse("teambot://pair#t=\(secret)&n=\(key)&r=\(relay)")
        XCTAssertEqual(link?.onlyTeamBotLink, true)
        XCTAssertEqual(link?.irohId, key)
        XCTAssertEqual(link?.irohRelay, "https://relay.voorbeeld.nl/")
        // Without the key there is nothing to dial; a foreign scheme or path is refused.
        XCTAssertNil(PairingLink.parse("teambot://pair#t=\(secret)"))
        XCTAssertNil(PairingLink.parse("teambot://evil#t=\(secret)&n=\(key)"))
        XCTAssertNil(PairingLink.parse("teambot://pair/x#t=\(secret)&n=\(key)"))
        XCTAssertNil(PairingLink.parse("teambot://pair#t=\(secret)&n=\(key)%3Cscript").flatMap(\.irohId))
        // A relay must be https.
        XCTAssertNil(PairingLink.parse("teambot://pair#t=\(secret)&n=\(key)&r=http%3A%2F%2Frelay.voorbeeld.nl")?.irohRelay)
    }

    func testLoopbackIsTheTunnelNeverAnAddressOfThePc() {
        XCTAssertEqual(HostAddress.kind(of: URL(string: "http://127.0.0.1:52123")!), .teambotLink)
        XCTAssertEqual(HostAddress.kind(of: URL(string: "http://localhost:52123")!), .teambotLink)
        XCTAssertEqual(HostAddress.display(URL(string: "http://127.0.0.1:52123")!), "TeamBot-verbinding")
        XCTAssertNil(HostAddress.accept("http://127.0.0.1:4747"), "the pc never sends loopback")
        let lan = URL(string: "http://192.168.1.20:4748")!
        let tunnel = URL(string: "http://127.0.0.1:52123")!
        let p = Pairing(baseURL: tunnel, token: "t", deviceId: "d", deviceName: "n", pairedURL: lan, irohId: key)
        XCTAssertEqual(p.candidates, [lan], "the proxy is tried by the app itself, last")
        let onlyLink = Pairing(baseURL: tunnel, token: "t", deviceId: "d", deviceName: "n", pairedURL: tunnel, irohId: key)
        XCTAssertEqual(onlyLink.candidates, [])
    }

    func testKeyIsStoredAndOlderPairingsLoad() throws {
        let old = #"{"baseURL":"http:\/\/192.168.1.20:4748","token":"tok","deviceId":"ses_1","deviceName":"iPhone"}"#
        var p = try JSONDecoder().decode(Pairing.self, from: Data(old.utf8))
        XCTAssertNil(p.irohId)
        p.irohId = key
        p.irohRelay = "https://relay.voorbeeld.nl/"
        let back = try JSONDecoder().decode(Pairing.self, from: JSONEncoder().encode(p))
        XCTAssertEqual(back.irohId, key)
        XCTAssertEqual(back.irohRelay, "https://relay.voorbeeld.nl/")
    }

    func testNothingAnswersThroughTheLinkMeansThePcSleeps() {
        let tunnel = URL(string: "http://127.0.0.1:52123")!
        let p = Pairing(baseURL: tunnel, token: "t", deviceId: "d", deviceName: "n", pairedURL: tunnel, irohId: key)
        let r = LinkDiagnosis.diagnose([.init(url: tunnel, outcome: .timedOut)], phone: PhoneNetwork(online: true, onWiFi: false), pairing: p)
        XCTAssertEqual(r, .problem(.pcAsleep(orClosed: true)), "not 'not on home wifi': the link also works away from home")
    }
}
