import SwiftUI

/// The app's own settings (from the gear on the status and consent screens, or from TeamBot › Instellingen ›
/// Telefoon inside the app): connection, consent (withdraw any time), unpair. Never touches conversations.
struct AppSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUnpair = false
    @State private var confirmWithdraw = false

    var body: some View {
        NavigationStack {
            Form {
                if let p = model.pairing {
                    Section {
                        LabeledContent("Status", value: statusText)
                        if let route = model.routeText {
                            LabeledContent("Verbonden", value: route)
                        }
                        LabeledContent("Adres", value: HostAddress.display(p.baseURL))
                        if p.candidates.count > 1 {
                            ForEach(p.candidates.dropFirst(), id: \.self) { url in
                                Text(HostAddress.display(url)).font(.footnote).foregroundStyle(Theme.muted)
                            }
                        }
                        Button {
                            Task { await model.refresh() }
                        } label: {
                            if model.checking {
                                HStack(spacing: 10) {
                                    ProgressView()
                                    Text("Verbinden met je pc…")
                                }
                            } else {
                                Text("Nu controleren")
                            }
                        }
                        .disabled(model.checking)
                    } header: {
                        Text("Verbinding")
                    } footer: {
                        Text(p.irohId == nil ? "De app probeert al deze adressen van je pc, dus wisselen tussen wifi en Tailscale gaat vanzelf." : "De app probeert eerst wifi en Tailscale, daarna de TeamBot-verbinding. Die werkt ook onderweg, zonder Tailscale, en is versleuteld tot op je pc.")
                    }

                    Section {
                        LabeledContent("Toestemming", value: consentText)
                        if case .connected = model.phase {
                            NavigationLink("Wat gaat waarheen") { PrivacyDetailsView() }
                        }
                        if model.consent.grantedVersion != nil {
                            Button("Toestemming intrekken", role: .destructive) { confirmWithdraw = true }
                        }
                    } header: {
                        Text("Privacy")
                    } footer: {
                        Text("Zonder toestemming stuurt deze iPhone niets naar je bots. Intrekken kan ook in Instellingen › TeamBot op je iPhone.")
                    }

                    Section {
                        LabeledContent("Naam", value: p.deviceName)
                        Button("Ontkoppelen", role: .destructive) { confirmUnpair = true }
                    } header: {
                        Text("Koppeling")
                    } footer: {
                        Text("Ontkoppelen of opnieuw koppelen wist geen gesprekken: die staan op je pc.")
                    }
                }
                Section("Over") {
                    LabeledContent("Versie", value: Self.appVersion)
                }
            }
            .scrollContentBackground(.hidden)
            .tbCanvas()
            .navigationTitle("Instellingen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Klaar") { dismiss() }
                }
            }
            .confirmationDialog("Toestemming intrekken?", isPresented: $confirmWithdraw, titleVisibility: .visible) {
                Button("Intrekken", role: .destructive) {
                    model.withdrawConsent()
                    dismiss()
                }
                Button("Annuleren", role: .cancel) {}
            } message: {
                Text("Deze iPhone stuurt dan niets meer naar je bots, tot je opnieuw toestemming geeft.")
            }
            .confirmationDialog("Deze iPhone ontkoppelen?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Ontkoppelen", role: .destructive) {
                    Task {
                        await model.unpair()
                        dismiss()
                    }
                }
                Button("Annuleren", role: .cancel) {}
            } message: {
                Text("Je gesprekken blijven op je pc bewaard. Daarna kun je opnieuw koppelen.")
            }
        }
    }

    private var statusText: String {
        switch model.phase {
        case .connected: return "Verbonden"
        case .checking: return "Bezig met verbinden"
        case .consent: return "Wacht op toestemming"
        case .problem(let p, let problem): return ProblemCopy.make(problem, pairing: p, phone: model.network, last: model.last).title
        case .unpaired, .revoked: return "Niet gekoppeld"
        }
    }

    private var consentText: String {
        guard let at = model.consent.grantedAt else { return "Niet gegeven" }
        return "Gegeven op " + at.formatted(Date.FormatStyle(date: .long, time: .omitted).locale(Locale(identifier: "nl_NL")))
    }

    static var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }
}

/// The current list from the pc, read-only (the same list as on the consent screen).
struct PrivacyDetailsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var info: PrivacyInfo?
    @State private var loaded = false

    var body: some View {
        List {
            if let info {
                PrivacyListSections(info: info)
            } else if loaded {
                Section {
                    Text("Je pc vertelt niet welke AI-diensten hij gebruikt (een oudere TeamBot), of is nu niet bereikbaar.")
                }
            } else {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Lijst ophalen van je pc…").foregroundStyle(Theme.muted)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            PrivacyPromises()
        }
        .scrollContentBackground(.hidden)
        .tbCanvas()
        .navigationTitle("Wat gaat waarheen")
        .task {
            info = await model.loadPrivacy()
            loaded = true
        }
    }
}
