import XCTest
@testable import TeamBot

/// The pairing survives app updates (old saved format still loads) and network changes (all known addresses are
/// tried, best first); addresses from the host are filtered.
final class PairingStorageTests: XCTestCase {
    func testPairingSavedByAnOlderAppVersionStillLoads() throws {
        // Exactly what version 0.1 stored in the Keychain.
        let old = #"{"baseURL":"http:\/\/192.168.1.20:4748","token":"tok","deviceId":"ses_1","deviceName":"iPhone van Sanne"}"#
        let p = try JSONDecoder().decode(Pairing.self, from: Data(old.utf8))
        XCTAssertEqual(p.baseURL.absoluteString, "http://192.168.1.20:4748")
        XCTAssertEqual(p.pairedURL, p.baseURL)
        XCTAssertEqual(p.addresses, [])
        XCTAssertNil(p.instance)
        XCTAssertEqual(p.token, "tok")
        // And the new format round-trips.
        var q = p
        q.addresses = [URL(string: "https://pc.tail1234.ts.net")!]
        q.instance = "tbi_abc"
        let back = try JSONDecoder().decode(Pairing.self, from: JSONEncoder().encode(q))
        XCTAssertEqual(back, q)
    }

    func testCandidatesLastWorkingFirstThenHTTPSThenPairedThenRest() {
        let lan = URL(string: "http://192.168.1.20:4748")!
        let ts = URL(string: "http://100.101.102.103:4748")!
        let https = URL(string: "https://pc.tail1234.ts.net")!
        var p = Pairing(baseURL: lan, token: "t", deviceId: "d", deviceName: "n", addresses: [lan, ts, https])
        XCTAssertEqual(p.candidates, [lan, https, ts])
        p.baseURL = ts // switched to Tailscale
        XCTAssertEqual(p.candidates, [ts, https, lan])
        // The same origin written differently counts once.
        p.addresses = [URL(string: "HTTP://192.168.1.20:4748")!]
        XCTAssertEqual(p.candidates.count, 2)
    }

    func testAddressesFromTheHostAreFiltered() {
        XCTAssertEqual(HostAddress.accept("https://pc.tail1234.ts.net")?.absoluteString, "https://pc.tail1234.ts.net")
        XCTAssertEqual(HostAddress.accept("http://192.168.1.20:4748")?.absoluteString, "http://192.168.1.20:4748")
        XCTAssertEqual(HostAddress.accept("http://100.101.102.103:4748")?.absoluteString, "http://100.101.102.103:4748")
        XCTAssertNil(HostAddress.accept("http://example.com:4748"), "plain http outside the own network")
        XCTAssertNil(HostAddress.accept("https://u:p@pc.example.com"))
        XCTAssertNil(HostAddress.accept("https://pc.example.com/pad"))
        XCTAssertNil(HostAddress.accept("https://pc.example.com/?x=1"))
        XCTAssertNil(HostAddress.accept("javascript:alert(1)"))
        XCTAssertNil(HostAddress.accept("ftp://192.168.1.20"))
    }

    func testAddressKinds() {
        XCTAssertEqual(HostAddress.kind(of: URL(string: "http://192.168.1.20:4748")!), .lan)
        XCTAssertEqual(HostAddress.kind(of: URL(string: "http://10.0.0.2")!), .lan)
        XCTAssertEqual(HostAddress.kind(of: URL(string: "http://172.20.0.2")!), .lan)
        XCTAssertEqual(HostAddress.kind(of: URL(string: "http://pc.local:4748")!), .lan)
        XCTAssertEqual(HostAddress.kind(of: URL(string: "http://100.64.0.1")!), .tailscale)
        XCTAssertEqual(HostAddress.kind(of: URL(string: "http://100.128.0.1")!), .internet)
        XCTAssertEqual(HostAddress.kind(of: URL(string: "https://pc.tail1234.ts.net")!), .tailscaleHTTPS)
        XCTAssertEqual(HostAddress.kind(of: URL(string: "https://teambot.example.nl")!), .internet)
    }

    func testOriginDropsDefaultPortLikeWebKit() {
        XCTAssertEqual(HostAddress.origin(of: URL(string: "https://PC.tail1234.ts.net:443")!), "https://pc.tail1234.ts.net")
        XCTAssertEqual(HostAddress.origin(of: URL(string: "http://192.168.1.20:4748/")!), "http://192.168.1.20:4748")
    }

    func testStartRouteOnlyInApp() {
        let base = URL(string: "https://pc.tail1234.ts.net")!
        XCTAssertEqual(WebShellView.startURL(base, route: "#/t/thr_main").absoluteString, "https://pc.tail1234.ts.net/#/t/thr_main")
        XCTAssertEqual(WebShellView.startURL(base, route: "https://evil.example/"), base)
        XCTAssertEqual(WebShellView.startURL(base, route: nil), base)
    }
}
