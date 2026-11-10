import XCTest
@testable import TeamBot

final class PairingLinkTests: XCTestCase {
    private let secret = String(repeating: "aB3_-", count: 9) // 45 url-safe characters

    func testParsesQrLinks() {
        let https = PairingLink.parse("https://sanne-pc.tail1234.ts.net/api/public/mobile/pair#t=\(secret)")
        XCTAssertEqual(https?.baseURL.absoluteString, "https://sanne-pc.tail1234.ts.net")
        XCTAssertEqual(https?.secret, secret)
        let lan = PairingLink.parse("  http://192.168.1.20:4748/api/public/mobile/pair#t=\(secret)\n")
        XCTAssertEqual(lan?.baseURL.absoluteString, "http://192.168.1.20:4748")
    }

    func testRejectsForeignOrMalformedLinks() {
        XCTAssertNil(PairingLink.parse("https://evil.example/login#t=\(secret)"))
        XCTAssertNil(PairingLink.parse("ftp://host/api/public/mobile/pair#t=\(secret)"))
        XCTAssertNil(PairingLink.parse("https://host/api/public/mobile/pair#t=short"))
        XCTAssertNil(PairingLink.parse("https://u:p@host/api/public/mobile/pair#t=\(secret)"))
        XCTAssertNil(PairingLink.parse("https://host/api/public/mobile/pair?t=\(secret)"))
        XCTAssertNil(PairingLink.parse("https://host/api/public/mobile/pair#t=\(secret)%3Cscript"))
        XCTAssertNil(PairingLink.parse("geen link"))
    }

    func testTypedHostAndCode() {
        XCTAssertEqual(PairingLink.baseURL(fromTyped: "192.168.1.20:4748")?.absoluteString, "http://192.168.1.20:4748")
        XCTAssertEqual(PairingLink.baseURL(fromTyped: "https://x.ts.net/")?.absoluteString, "https://x.ts.net")
        XCTAssertNil(PairingLink.baseURL(fromTyped: "https://x.ts.net/pad"))
        XCTAssertNil(PairingLink.baseURL(fromTyped: ""))
        XCTAssertEqual(PairingLink.normalizeCode("abcd-ef9h"), "ABCDEF9H")
    }

    func testBootstrapScriptOnlyRunsOnHostOrigin() {
        let p = Pairing(baseURL: URL(string: "http://192.168.1.20:4748")!, token: "tok\"en", deviceId: "ses_1", deviceName: "iPhone")
        let js = WebShellView.bootstrapScript(p)
        XCTAssertTrue(js.contains("location.origin !== \"http://192.168.1.20:4748\""))
        XCTAssertTrue(js.contains("\"tok\\\"en\""), "token must be JSON-escaped")
    }
}
