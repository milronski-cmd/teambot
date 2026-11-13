import SwiftUI
import UIKit
import UserNotifications

@main
struct TeamBotApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                // The orange of TeamBot (the same as the website and the pc app) on links and switches; every
                // colour of the native screens comes from Theme.
                .tint(Theme.accentText)
                // The native screens are Dutch (the web app follows the language set on the pc).
                .environment(\.locale, Locale(identifier: "nl_NL"))
                .onAppear { appDelegate.model = model }
                .onChange(of: scenePhase) { _, phase in
                    // Back in the app: check every link again (also picks up consent withdrawn in iOS Settings).
                    if phase == .background { model.wentToBackground() }
                    if phase == .active { Task { await model.cameBack() } }
                }
        }
    }
}

/// Receives the APNs device token and notification taps. A tap only opens the app at the
/// right place; nothing is ever approved from a notification.
@MainActor
final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var model: AppModel?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await model?.uploadPushToken(hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Without an Apple Developer account / push entitlement this fails; the app keeps working without push.
        print("APNs-registratie mislukt: \(error.localizedDescription)")
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let link = response.notification.request.content.userInfo["link"] as? String
        await MainActor.run {
            if let link { self.model?.open(link: link) }
        }
    }
}
