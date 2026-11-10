import SwiftUI
import UIKit
import WebKit

/// The TeamBot web app of the paired host inside a WKWebView. The device token comes from the
/// Keychain and is injected into the page's storage only for the host's own origin.
///
/// App Review 2.5.2: the shell runs only the fixed script below (bundled with the app). It never evaluates code it
/// receives; the page can only send the fixed words "unauthorized" and "settings" to it.
struct WebShellView: UIViewRepresentable {
    let pairing: Pairing
    /// In-app route to open first ("#/…"), from the host's status (wave 2: the main bot). nil = the web app's start.
    var startRoute: String?
    @EnvironmentObject private var model: AppModel

    // Explicit: a private stored property would make the memberwise initializer private.
    init(pairing: Pairing, startRoute: String? = nil) {
        self.pairing = pairing
        self.startRoute = startRoute
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(origin: Self.origin(of: pairing.baseURL), model: model)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        config.applicationNameForUserAgent = "Mobile/15E148 TeamBotiOS/\(version)"
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: Self.bootstrapScript(pairing), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(context.coordinator, name: "teambot")
        config.userContentController = controller
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.load(URLRequest(url: Self.startURL(pairing.baseURL, route: startRoute)))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        guard let link = model.pendingLink, let json = Self.jsonString(link) else { return }
        web.evaluateJavaScript("location.hash = \(json).slice(1)")
        let m = context.coordinator.model
        Task { @MainActor in m?.pendingLink = nil }
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "teambot")
    }

    nonisolated static func origin(of url: URL) -> String {
        HostAddress.origin(of: url)
    }

    /// base + "#/route" when the host named a start page; only in-app routes, never another site.
    nonisolated static func startURL(_ base: URL, route: String?) -> URL {
        guard let route, route.hasPrefix("#/"), var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return base }
        c.path = "/"
        c.fragment = String(route.dropFirst())
        return c.url ?? base
    }

    nonisolated static func jsonString(_ s: String) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? encoder.encode(s) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Stores the token for the web app and tells the native shell when the API answers 401
    /// (the shell then checks with the host before forgetting the key). A new token also drops the old
    /// signing key for links; everything else in the page's storage (undelivered messages) stays.
    nonisolated static func bootstrapScript(_ p: Pairing) -> String {
        let origin = jsonString(origin(of: p.baseURL)) ?? "\"\""
        let token = jsonString(p.token) ?? "\"\""
        return """
        (function () {
          if (location.origin !== \(origin)) return;
          try {
            if (localStorage.getItem('tb_token') !== \(token)) {
              localStorage.removeItem('tb_urlkey');
              localStorage.setItem('tb_token', \(token));
            }
          } catch (e) {}
          var f = window.fetch;
          window.fetch = function () {
            return f.apply(this, arguments).then(function (r) {
              try {
                if (r.status === 401 && /\\/api\\/(?!public\\/)/.test(r.url)) window.webkit.messageHandlers.teambot.postMessage('unauthorized');
              } catch (e) {}
              return r;
            });
          };
        })();
        """
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let origin: String
        weak var model: AppModel?

        init(origin: String, model: AppModel) {
            self.origin = origin
            self.model = model
        }

        private func isHost(_ url: URL) -> Bool {
            WebShellView.origin(of: url) == origin
        }

        // Stay on the paired host; open everything else in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else { return .cancel }
            if isHost(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return .allow }
            if ["http", "https", "mailto", "tel"].contains(url.scheme ?? "") { _ = await UIApplication.shared.open(url) }
            return .cancel
        }

        // target=_blank links
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                if isHost(url) { webView.load(navigationAction.request) } else { UIApplication.shared.open(url) }
            }
            return nil
        }

        // Microphone/camera only for the host page, and iOS still asks the user.
        func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
            let o = "\(origin.protocol)://\(origin.host)" + (origin.port > 0 ? ":\(origin.port)" : "")
            return o == self.origin ? .prompt : .deny
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            Task { await model?.refresh() }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        // Only fixed words from the host's own main frame.
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "teambot", message.frameInfo.isMainFrame, let word = message.body as? String else { return }
            let o = message.frameInfo.securityOrigin
            let from = "\(o.protocol)://\(o.host)" + (o.port > 0 ? ":\(o.port)" : "")
            guard from == origin else { return }
            model?.webSaid(word)
        }
    }
}
