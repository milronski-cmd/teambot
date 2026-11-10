import XCTest
@testable import TeamBot

/// The hello proof must match the server byte for byte (server/modules/mobile/status.ts; the same vector is in
/// tests/mobile-status.test.ts), and answers are classified honestly.
final class HelloProofTests: XCTestCase {
    private let pairing = Pairing(baseURL: URL(string: "http://192.168.1.20:4748")!, token: "token-voor-de-test", deviceId: "ses_0123456789abcdef", deviceName: "iPhone")

    func testProofMatchesTheServerVector() {
        let message = HostClient.helloMessage(instance: "tbi_testinstance0000", device: "ses_0123456789abcdef", nonce: "nonce-0123456789abcdef", state: .active)
        XCTAssertEqual(message, "teambot-hello/1|tbi_testinstance0000|ses_0123456789abcdef|nonce-0123456789abcdef|active")
        let vector = "0f3bf427eaa4c1bb4a8bd4a33a501978b87cbbfb6e638e73e77612b9d5d7ce0f"
        XCTAssertEqual(HostClient.proof(token: "token-voor-de-test", message: message), vector)
        XCTAssertTrue(HostClient.verifyProof(vector, token: "token-voor-de-test", message: message))
        XCTAssertTrue(HostClient.verifyProof(vector.uppercased(), token: "token-voor-de-test", message: message))
        XCTAssertFalse(HostClient.verifyProof(vector, token: "een-ander-token", message: message))
        XCTAssertFalse(HostClient.verifyProof("zz", token: "token-voor-de-test", message: message))
    }

    func testHelloAnswerIsVerifiedOnlyWithTheRightProof() throws {
        let nonce = "nonce-0123456789abcdef"
        let message = HostClient.helloMessage(instance: "tbi_testinstance0000", device: pairing.deviceId, nonce: nonce, state: .active)
        let good = try JSONSerialization.data(withJSONObject: ["teambot": 1, "instance": "tbi_testinstance0000", "device": "active", "proof": HostClient.proof(token: pairing.token, message: message)])
        XCTAssertEqual(HostClient.outcome(status: 200, data: good, nonce: nonce, pairing: pairing), .hello(Hello(instance: "tbi_testinstance0000", device: .active, verified: true)))
        // Same answer for another nonce (a replay) does not verify.
        XCTAssertEqual(HostClient.outcome(status: 200, data: good, nonce: "another-nonce-0000", pairing: pairing), .hello(Hello(instance: "tbi_testinstance0000", device: .active, verified: false)))
        let unknown = try JSONSerialization.data(withJSONObject: ["teambot": 1, "instance": "tbi_testinstance0000", "device": "unknown", "proof": NSNull()])
        XCTAssertEqual(HostClient.outcome(status: 200, data: unknown, nonce: nonce, pairing: pairing), .hello(Hello(instance: "tbi_testinstance0000", device: .unknown, verified: false)))
    }

    func testOtherAnswers() {
        XCTAssertEqual(HostClient.outcome(status: 200, data: Data("<html>Log in op deze wifi</html>".utf8), nonce: "n", pairing: pairing), .notTeamBot)
        XCTAssertEqual(HostClient.outcome(status: 404, data: Data(#"{"error":"Niet gevonden"}"#.utf8), nonce: "n", pairing: pairing), .legacyHost)
        XCTAssertEqual(HostClient.outcome(status: 404, data: Data("Not Found".utf8), nonce: "n", pairing: pairing), .notTeamBot)
        XCTAssertEqual(HostClient.outcome(status: 502, data: Data(), nonce: "n", pairing: pairing), .proxyDown)
        XCTAssertEqual(HostClient.outcome(status: 530, data: Data(), nonce: "n", pairing: pairing), .tunnelDown)
        XCTAssertEqual(HostClient.outcome(status: 429, data: Data(), nonce: "n", pairing: pairing), .busy)
    }

    func testNetworkErrors() {
        func err(_ code: Int, _ info: [String: Any] = [:]) -> Error { NSError(domain: NSURLErrorDomain, code: code, userInfo: info) }
        XCTAssertEqual(HostClient.outcome(for: err(NSURLErrorNotConnectedToInternet)), .phoneOffline)
        XCTAssertEqual(HostClient.outcome(for: err(NSURLErrorTimedOut)), .timedOut)
        XCTAssertEqual(HostClient.outcome(for: err(NSURLErrorCannotFindHost)), .noHost)
        XCTAssertEqual(HostClient.outcome(for: err(NSURLErrorCannotConnectToHost, ["_kCFStreamErrorCodeKey": NSNumber(value: 61)])), .refused)
        XCTAssertEqual(HostClient.outcome(for: err(NSURLErrorCannotConnectToHost, ["_kCFStreamErrorCodeKey": NSNumber(value: 65)])), .unreachable)
        XCTAssertEqual(HostClient.outcome(for: err(NSURLErrorAppTransportSecurityRequiresSecureConnection)), .blocked)
        XCTAssertEqual(HostClient.outcome(for: err(NSURLErrorServerCertificateUntrusted)), .blocked)
    }

    func testNonceFitsTheServerRule() {
        let n = HostClient.newNonce()
        XCTAssertGreaterThanOrEqual(n.count, 16)
        XCTAssertLessThanOrEqual(n.count, 128)
        XCTAssertTrue(n.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) })
        XCTAssertNotEqual(n, HostClient.newNonce())
    }
}
