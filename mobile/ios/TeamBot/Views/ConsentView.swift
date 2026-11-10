import SwiftUI

/// Consent before first use (App Review 5.1.2(i)): which personal data goes to which AI service, as the owner's pc
/// uses them. Until the user agrees, the web app does not load and nothing is sent from this iPhone.
/// Wording follows the privacy page of the website (website/src/nl.json › privacy); keep the two in sync.
struct ConsentView: View {
    @EnvironmentObject private var model: AppModel
    let request: ConsentRequest?
    @State private var declined = false

    init(request: ConsentRequest?) {
        self.request = request
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Je iPhone praat alleen met TeamBot op je eigen pc. Een bot stuurt alleen wat hij voor zijn antwoord nodig heeft naar de AI-dienst die je bij die bot koos: je bericht, zijn instructies, en wat hij daarvoor gebruikt, zoals een paar herinneringen, delen van bestanden die hij leest en de uitkomst van zijn tools.")
                }
                if let request {
                    if let info = request.info {
                        PrivacyListSections(info: info)
                    } else {
                        Section {
                            Text("TeamBot op je pc vertelt niet welke AI-diensten hij gebruikt; dat kan een oudere versie zijn. Je berichten kunnen dan naar elke AI-dienst gaan die op je pc is ingesteld. Werk TeamBot op je pc bij voor de volledige lijst.")
                        } header: {
                            Text("Gaat naar")
                        }
                    }
                } else {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Lijst ophalen van je pc…")
                        }
                    }
                }
                PrivacyPromises()
                if declined {
                    Section {
                        Text("Zonder toestemming stuurt deze iPhone niets naar je bots. Je kunt dit scherm later opnieuw bekijken.")
                        Button("Ontkoppelen", role: .destructive) { Task { await model.unpair() } }
                    }
                }
            }
            .navigationTitle("Toestemming")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        model.showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Instellingen")
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    Button {
                        model.grantConsent()
                    } label: {
                        Text("Ik geef toestemming").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(request == nil)
                    Button("Niet akkoord") { declined = true }
                }
                .padding()
                .background(.bar)
            }
        }
    }
}

/// The list of AI services: who gets what, which bots use it, and what stays on the pc. Also in the settings.
struct PrivacyListSections: View {
    let info: PrivacyInfo

    var body: some View {
        let external = info.external
        let local = info.onOwnNetwork
        if external.isEmpty && local.isEmpty {
            Section {
                Text("Op je pc staat nog geen AI-dienst aan. Zet je er een aan, dan vraagt deze app eerst opnieuw om toestemming.")
            }
        }
        if !external.isEmpty {
            Section {
                ForEach(external) { ProviderRow(provider: $0) }
            } header: {
                Text("Gaat naar deze AI-diensten")
            } footer: {
                Text("Wat al naar een AI-dienst is gestuurd, valt onder de voorwaarden van die dienst.")
            }
        }
        if !local.isEmpty {
            Section {
                ForEach(local) { ProviderRow(provider: $0) }
            } header: {
                Text("Blijft op je pc")
            } footer: {
                Text("Een lokaal model draait op je pc of in je eigen netwerk: je bericht verlaat je computer niet.")
            }
        }
    }
}

struct ProviderRow: View {
    let provider: PrivacyInfo.Provider

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(provider.vendor).font(.headline)
            if provider.service != provider.vendor {
                Text(provider.service).font(.subheadline).foregroundStyle(.secondary)
            }
            if let host = provider.host {
                Text("Adres: \(host)").font(.subheadline).foregroundStyle(.secondary)
            }
            if !provider.local {
                Text("Krijgt: \(PrivacyInfo.dataText(provider.data))").font(.subheadline)
            }
            if provider.forwards == true {
                Text("Stuurt door naar de aanbieder van het model dat daar is gekozen.").font(.footnote).foregroundStyle(.secondary)
            }
            if provider.free == true {
                Text("Gratis laag: sommige gratis diensten mogen wat je stuurt gebruiken om hun modellen te verbeteren. Lees bij twijfel hun voorwaarden.").font(.footnote).foregroundStyle(.secondary)
            }
            if let bots = provider.bots, !bots.isEmpty {
                Text("Gebruikt door: \(bots.joined(separator: ", "))").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// What never leaves, and how to take consent back. Same promises as the website.
struct PrivacyPromises: View {
    var body: some View {
        Section {
            Label("Wat je inspreekt, gaat naar je pc. Spraak blijft op je pc, behalve als je daar een live stem of een stem van een aanbieder koos.", systemImage: "mic")
            Label("Nooit verstuurd: je sleutels en wachtwoorden. Je telefoon krijgt geen sleutels, alleen een eigen toegangsbewijs dat je op je pc altijd kunt intrekken.", systemImage: "key")
            Label("De makers van TeamBot krijgen niets: geen account, geen statistieken. Deze app voert zelf geen AI uit; hij toont TeamBot van je eigen pc.", systemImage: "hand.raised")
            Label("Onder elk antwoord staat welk model het gaf.", systemImage: "text.bubble")
            Label("Intrekken kan altijd: in de instellingen van deze app, of in Instellingen › TeamBot op je iPhone.", systemImage: "arrow.uturn.backward")
        } header: {
            Text("Goed om te weten")
        }
    }
}
