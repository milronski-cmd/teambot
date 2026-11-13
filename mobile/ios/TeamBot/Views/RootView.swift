import AVFoundation
import SwiftUI
import UIKit

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            switch model.phase {
            case .unpaired:
                PairingView()
            case .checking:
                CheckingView()
            case .consent(_, let request):
                ConsentView(request: request)
            case .connected(let p):
                // A new address (wifi ↔ Tailscale) is a new origin: a fresh web view, same conversations.
                WebShellView(pairing: p, startRoute: model.startRoute)
                    .id(HostAddress.origin(of: p.baseURL))
                    .ignoresSafeArea(edges: .bottom)
                    .sheet(isPresented: $model.askPush) { PushPromptView().environmentObject(model).tint(Theme.accentText) }
                    .overlay(alignment: .top) { RouteBadge() }
            case .problem(let p, let problem):
                ConnectionView(pairing: p, problem: problem)
            case .revoked:
                RevokedView()
            }
        }
        .sheet(isPresented: $model.showSettings) { AppSettingsView().environmentObject(model).tint(Theme.accentText) }
    }
}

struct CheckingView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: Theme.gap) {
            BotFace()
            ProgressView()
            Text("Verbinden met je pc…").foregroundStyle(Theme.muted)
        }
        .padding(Theme.gapLarge)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .tbCanvas()
        .accessibilityElement(children: .combine)
        // Paired and agreed before: straight to the conversations, the check runs behind them. Otherwise the web app
        // waits until the link is checked and consent is known.
        .task { await model.launch() }
    }
}

// MARK: - Pairing

struct PairingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var name = UIDevice.current.name
    @State private var host = ""
    @State private var code = ""
    @State private var scanning = false
    @State private var busy = false
    @State private var error: String?
    @State private var cameraDenied = false

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.gapLarge) {
                StateHeader(
                    title: "Koppel met je pc",
                    message: "Open TeamBot op je pc, ga naar Instellingen › Telefoon en scan de QR-code."
                )
                if let note = model.unpairNote {
                    NoteCard(note, kind: .info)
                }
                if let error {
                    NoteCard(error)
                }
                // The one main action. The code below only when the camera is not allowed.
                Button {
                    Task { await startScan() }
                } label: {
                    if busy {
                        HStack(spacing: Theme.gapSmall) {
                            ProgressView()
                            Text("Koppelen met je pc…")
                        }
                    } else {
                        Label(error != nil && !cameraDenied ? "Opnieuw proberen" : "QR-code scannen", systemImage: "qrcode.viewfinder")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(busy)
                if cameraDenied {
                    cameraCard
                    codeCard
                }
            }
            .tbColumn()
        }
        .scrollDismissesKeyboard(.interactively)
        .tbCanvas()
        .sheet(isPresented: $scanning) {
            ScannerSheet { text in
                scanning = false
                Task { await pairWithScan(text) }
            }
            .tint(Theme.accentText)
        }
    }

    private var cameraCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("TeamBot mag de camera niet gebruiken. Zet de camera aan in Instellingen, of koppel met een code.")
                .foregroundStyle(Theme.ink)
            Button("Open Instellingen") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            .buttonStyle(SecondaryButtonStyle())
        }
        .tbCard()
    }

    private var codeCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Koppelen met een code")
                .font(.headline)
                .foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
            LabeledField("Naam van dit apparaat", prompt: "iPhone", text: $name)
            LabeledField("Adres van je pc", prompt: "192.168.1.20:4748", text: $host)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            LabeledField("Koppelcode", prompt: "Code van je pc", text: $code)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            Button("Koppelen met code") { Task { await pairWithCode() } }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(busy || host.isEmpty || PairingLink.normalizeCode(code).count < 8)
            Text("Het adres en de code staan op je pc onder Instellingen › Telefoon › Meer opties.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
        }
        .tbCard()
    }

    private func startScan() async {
        error = nil
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            scanning = true
        case .notDetermined:
            if await AVCaptureDevice.requestAccess(for: .video) { scanning = true } else { cameraDenied = true }
        default:
            cameraDenied = true
        }
    }

    private func pairWithScan(_ text: String) async {
        guard let link = PairingLink.parse(text) else {
            error = "Dit is geen TeamBot-koppelcode. Maak op je computer een nieuwe QR-code."
            return
        }
        await run { try await model.pair(link: link, name: name) }
    }

    private func pairWithCode() async {
        guard let base = PairingLink.baseURL(fromTyped: host) else {
            error = "Ongeldig adres. Voorbeeld: 192.168.1.20:4748 of https://naam.ts.net"
            return
        }
        await run { try await model.pair(base: base, code: code, name: name) }
    }

    private func run(_ work: () async throws -> Void) async {
        busy = true
        error = nil
        do {
            try await work()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}

struct ScannerSheet: View {
    var onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    init(onCode: @escaping (String) -> Void) {
        self.onCode = onCode
    }

    var body: some View {
        NavigationStack {
            QRScannerView(onCode: onCode)
                .ignoresSafeArea()
                .overlay(alignment: .bottom) {
                    Text("Richt de camera op de QR-code op je pc")
                        .font(.callout)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous))
                        .padding(.horizontal, Theme.gapLarge)
                        .padding(.bottom, 32)
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Annuleren") { dismiss() }
                    }
                }
        }
    }
}

// MARK: - States

/// Says plainly for a few seconds how this iPhone reaches the pc ("Thuis, via wifi", "Onderweg via
/// TeamBot-verbinding") each time that changes. Always in the settings sheet too (AppSettingsView).
struct RouteBadge: View {
    @EnvironmentObject private var model: AppModel
    @State private var shown: String?

    var body: some View {
        Group {
            if let shown {
                Label(shown, systemImage: model.linkRoute == nil ? "wifi" : "lock.shield")
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.top, 6)
                    .transition(.opacity)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .allowsHitTesting(false)
        .task(id: model.routeText) {
            guard let text = model.routeText else { return }
            withAnimation { shown = text }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            withAnimation { shown = nil }
        }
    }
}


/// The pc proved this iPhone was unpaired there: the key is gone; pairing again keeps every conversation.
struct RevokedView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.gapLarge) {
                StateHeader(
                    title: "Koppeling ingetrokken",
                    message: "Deze iPhone is ontkoppeld op je pc. Je gesprekken staan op je pc en blijven bewaard.",
                    badge: "lock.slash",
                    sleeping: true
                )
                Button("Opnieuw koppelen") { model.startOver() }
                    .buttonStyle(PrimaryButtonStyle())
            }
            .tbColumn()
        }
        .tbCanvas()
    }
}

struct PushPromptView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.gapLarge) {
                StateHeader(
                    title: "Meldingen aanzetten?",
                    message: "Je krijgt een melding als een bot een vraag heeft, toestemming nodig heeft of klaar is. Goedkeuren doe je altijd zelf in de app.",
                    badge: "bell"
                )
                VStack(spacing: Theme.gapSmall) {
                    Button("Meldingen toestaan") { Task { await model.enablePush() } }
                        .buttonStyle(PrimaryButtonStyle())
                    Button("Niet nu") { model.askPush = false }
                        .buttonStyle(SecondaryButtonStyle())
                }
            }
            .tbColumn()
        }
        .tbCanvas()
        .presentationDetents([.medium, .large])
    }
}
