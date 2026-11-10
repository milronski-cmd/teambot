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
                    .sheet(isPresented: $model.askPush) { PushPromptView().environmentObject(model) }
                    .overlay(alignment: .top) { RouteBadge() }
            case .problem(let p, let problem):
                ConnectionView(pairing: p, problem: problem)
            case .revoked:
                RevokedView()
            }
        }
        .sheet(isPresented: $model.showSettings) { AppSettingsView().environmentObject(model) }
    }
}

struct CheckingView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.large)
            Text("Verbinden met je pc…").foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // At launch the web app waits until the link is checked and consent is known.
        .task { await model.refresh() }
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
        NavigationStack {
            Form {
                // 0.4.5: the first screen says one thing. The code below only when the camera is not allowed.
                Section {
                    Button {
                        Task { await startScan() }
                    } label: {
                        Label("Scan de QR-code op je computer", systemImage: "qrcode.viewfinder")
                            .font(.title3.weight(.semibold))
                    }
                    .disabled(busy)
                }
                if let note = model.unpairNote {
                    Section {
                        Label(note, systemImage: "exclamationmark.triangle")
                    }
                }
                if cameraDenied {
                    Section {
                        Text("TeamBot heeft geen toegang tot de camera. Sta dit toe in Instellingen, of koppel met een code.")
                        Button("Open Instellingen") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                    Section("Naam van dit apparaat") {
                        TextField("iPhone", text: $name)
                    }
                    Section {
                        TextField("Adres, bijv. 192.168.1.20:4748", text: $host)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Koppelcode", text: $code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                        Button("Koppelen met code") { Task { await pairWithCode() } }
                            .disabled(busy || host.isEmpty || PairingLink.normalizeCode(code).count < 8)
                    } header: {
                        Text("Of met een code")
                    } footer: {
                        Text("Het adres en de code staan op je computer onder Instellingen → Telefoon → Meer opties.")
                    }
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("TeamBot")
            .overlay {
                if busy { ProgressView().controlSize(.large) }
            }
            .sheet(isPresented: $scanning) {
                ScannerSheet { text in
                    scanning = false
                    Task { await pairWithScan(text) }
                }
            }
        }
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
                    Text("Richt de camera op de QR-code op je computer")
                        .font(.callout)
                        .padding(10)
                        .background(.ultraThinMaterial, in: Capsule())
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
        VStack(spacing: 16) {
            Image(systemName: "lock.slash").font(.system(size: 44)).foregroundStyle(.secondary).accessibilityHidden(true)
            Text("Koppeling ingetrokken").font(.title3.bold())
            Text("Deze iPhone is ontkoppeld op je pc. De sleutel is van deze iPhone verwijderd. Je gesprekken staan op je pc en blijven bewaard.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Opnieuw koppelen") { model.startOver() }
                .buttonStyle(.borderedProminent)
        }
        .padding(24)
    }
}

struct PushPromptView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "bell.badge").font(.system(size: 44)).foregroundStyle(.tint)
            Text("Meldingen aanzetten?").font(.title3.bold())
            Text("Krijg een melding als een bot een vraag heeft, toestemming nodig heeft of klaar is. Een melding opent alleen TeamBot; goedkeuren doe je altijd zelf in de app.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Meldingen toestaan") { Task { await model.enablePush() } }
                .buttonStyle(.borderedProminent)
            Button("Niet nu") { model.askPush = false }
        }
        .padding(24)
        .presentationDetents([.medium])
    }
}
