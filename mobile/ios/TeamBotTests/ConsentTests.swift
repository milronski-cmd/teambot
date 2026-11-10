import XCTest
@testable import TeamBot

/// Consent (App Review 5.1.2(i)): per version of the list, withdrawable in the app and in iOS Settings, never
/// given by the Settings switch alone.
final class ConsentTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUp() {
        super.setUp()
        suite = "consent-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testGrantIsPerVersionAndWithdrawable() {
        let store = ConsentStore(defaults: defaults)
        XCTAssertFalse(store.isGranted("v1"))
        XCTAssertNil(store.grantedAt)
        store.grant("v1")
        XCTAssertTrue(store.isGranted("v1"))
        XCTAssertNotNil(store.grantedAt)
        XCTAssertFalse(store.isGranted("v2"), "another company on the pc: ask again")
        XCTAssertEqual(defaults.object(forKey: ConsentStore.settingsKey) as? Bool, true)
        store.withdraw()
        XCTAssertFalse(store.isGranted("v1"))
        XCTAssertEqual(defaults.object(forKey: ConsentStore.settingsKey) as? Bool, false)
    }

    func testTheSettingsSwitchCanOnlyWithdraw() {
        let store = ConsentStore(defaults: defaults)
        store.grant("v1")
        defaults.set(false, forKey: ConsentStore.settingsKey) // switched off in iOS Settings › TeamBot
        XCTAssertFalse(store.isGranted("v1"))
        defaults.set(true, forKey: ConsentStore.settingsKey) // switched on again there: still no consent
        XCTAssertFalse(store.isGranted("v1"))
        store.grant("v1") // only the consent screen gives it
        XCTAssertTrue(store.isGranted("v1"))
    }

    func testPrivacyListDecodesAndReadsPlainly() throws {
        let json = #"""
        {"version":"abc","providers":[
          {"id":"p1","vendor":"Anthropic","service":"Claude Code","local":false,"host":null,"forwards":false,"free":false,"data":["chat","voice"],"bots":["Hoofdbot"]},
          {"id":"p2","vendor":"Ollama (lokaal)","service":"Ollama (lokaal)","local":true,"host":null,"forwards":false,"free":false,"data":["chat"],"bots":[]},
          {"id":"p3","vendor":"Groq","service":"Groq","local":false,"host":null}
        ]}
        """#
        let info = try JSONDecoder().decode(PrivacyInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.external.map(\.vendor), ["Anthropic", "Groq"])
        XCTAssertEqual(info.onOwnNetwork.map(\.id), ["p2"])
        XCTAssertEqual(PrivacyInfo.dataText(info.providers[0].data), "je berichten (met wat een bot daarvoor gebruikt) en wat je inspreekt")
        XCTAssertEqual(PrivacyInfo.dataText(nil), "je berichten (met wat een bot daarvoor gebruikt)")
        XCTAssertEqual(PrivacyInfo.dataText(["chat", "voice", "readaloud"]), "je berichten (met wat een bot daarvoor gebruikt), wat je inspreekt en teksten om voor te lezen")
    }
}
