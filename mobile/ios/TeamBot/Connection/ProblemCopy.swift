import Foundation

/// A fix the user can do in one tap.
enum ProblemAction: Hashable, Identifiable {
    case retry
    case openTailscale
    case openAppSettings
    case pairAgain

    var id: Self { self }

    var title: String {
        switch self {
        case .retry: return "Opnieuw proberen"
        case .openTailscale: return "Tailscale openen"
        case .openAppSettings: return "Open Instellingen"
        case .pairAgain: return "Opnieuw koppelen"
        }
    }
}

/// The words for one broken link: what is wrong, what to do, and the buttons (the first one is the main fix).
/// Pure, so every state is unit tested.
struct ProblemCopy: Equatable {
    /// SF Symbol.
    let icon: String
    let title: String
    let body: String
    var tips: [String] = []
    var actions: [ProblemAction]

    static let tailscaleSetup = "Tailscale stel je in op je pc: Instellingen › Telefoon › Telefoon via Tailscale instellen."

    static func make(_ problem: LinkProblem, pairing: Pairing, phone: PhoneNetwork, last: LastStatus?) -> ProblemCopy {
        let kinds = Set(pairing.candidates.map { HostAddress.kind(of: $0) })
        let hasTailscale = kinds.contains(.tailscale) || kinds.contains(.tailscaleHTTPS)
        switch problem {
        case .phoneOffline:
            return ProblemCopy(
                icon: "iphone.slash",
                title: "Je iPhone is offline",
                body: "Zet wifi of mobiele data aan, of zet de vliegtuigmodus uit. TeamBot verbindt vanzelf zodra er weer verbinding is.",
                actions: [.retry]
            )
        case .networkGone(.notOnHomeWifi):
            return ProblemCopy(
                icon: "wifi.exclamationmark",
                title: "Je bent niet op je wifi thuis",
                body: "Deze iPhone kent je pc alleen via je wifi thuis. Ga terug naar die wifi, of gebruik Tailscale om ook onderweg te verbinden.",
                tips: [tailscaleSetup],
                actions: [.retry, .openTailscale]
            )
        case .networkGone(.tailscaleOff):
            return ProblemCopy(
                icon: "network",
                title: "Tailscale staat uit op deze iPhone",
                body: "Je pc is bereikbaar via Tailscale, maar Tailscale is niet verbonden op deze iPhone. Zet het aan en kom terug.",
                actions: [.openTailscale, .retry]
            )
        case .networkGone(.localNetworkDenied):
            return ProblemCopy(
                icon: "wifi.slash",
                title: "TeamBot mag je thuisnetwerk niet gebruiken",
                body: "Zet in Instellingen bij TeamBot ‘Lokaal netwerk’ aan. Daarna vindt de app je pc via de wifi.",
                actions: [.openAppSettings, .retry]
            )
        case .networkGone(.otherNetwork):
            return ProblemCopy(
                icon: "questionmark.circle",
                title: "Dit netwerk komt niet bij je pc",
                body: "Op het adres van je pc antwoordt iets anders. Je zit waarschijnlijk op een ander netwerk, zoals een wifi met een inlogpagina. Gebruik je wifi thuis of Tailscale.",
                tips: ["Heb je TeamBot op je pc opnieuw geïnstalleerd? Koppel dan opnieuw. Je gesprekken blijven op je pc bewaard."],
                actions: [.retry, .openTailscale, .pairAgain]
            )
        case .networkGone(.blocked):
            return ProblemCopy(
                icon: "lock.shield",
                title: "Dit adres kan niet veilig worden geopend",
                body: "Het certificaat van het https-adres klopt niet, of het adres gebruikt http buiten je eigen netwerk. Koppel opnieuw met het https-adres van Tailscale.",
                tips: [tailscaleSetup],
                actions: [.pairAgain, .retry]
            )
        case .pcAsleep(let orClosed):
            var tips: [String] = []
            if orClosed { tips.append("Staat je pc wel aan? Open dan TeamBot op je pc.") }
            if hasTailscale && !phone.onWiFi { tips.append("Niet thuis? Zet Tailscale aan op deze iPhone.") }
            if let power = last?.power, power.available {
                tips.append(power.keepAwake
                    ? "Je pc blijft alleen wakker terwijl er een taak of routine loopt."
                    : "Wil je dat je pc wakker blijft terwijl je bots werken? Zet op je pc ‘Houd de pc wakker terwijl routines of taken lopen’ aan (Instellingen › Algemeen).")
            }
            if !kinds.contains(.tailscaleHTTPS) {
                tips.append("Met het https-adres van Tailscale ziet de app precies of je pc slaapt of dat TeamBot dicht is. " + tailscaleSetup)
            }
            return ProblemCopy(
                icon: "moon.zzz",
                title: orClosed ? "Je pc reageert niet" : "Je pc slaapt of staat uit",
                body: orClosed
                    ? "Je pc slaapt, staat uit, of TeamBot is dicht. Maak je pc wakker met de muis of een toets en open TeamBot."
                    : "Maak je pc wakker met de muis of een toets, of zet hem aan. Daarna verbindt TeamBot vanzelf.",
                tips: tips,
                actions: hasTailscale && !phone.onWiFi ? [.retry, .openTailscale] : [.retry]
            )
        case .appClosed:
            return ProblemCopy(
                icon: "power",
                title: "TeamBot is dicht op je pc",
                body: "Je pc staat aan, maar TeamBot draait niet. Open TeamBot op je pc; daarna verbindt deze iPhone vanzelf.",
                tips: ["Wil je dat TeamBot altijd draait? Klik op je pc op het TeamBot-icoon in het systeemvak en zet ‘Starten bij inloggen op Windows’ aan."],
                actions: [.retry]
            )
        case .revoked(let confirmed):
            return ProblemCopy(
                icon: "lock.slash",
                title: confirmed ? "Koppeling ingetrokken" : "Je pc kent deze iPhone niet meer",
                body: confirmed
                    ? "Deze iPhone is ontkoppeld op je pc. Je gesprekken staan op je pc en blijven bewaard."
                    : "TeamBot op je pc antwoordt, maar deze koppeling staat daar niet meer. Koppel opnieuw; je gesprekken blijven op je pc bewaard.",
                actions: confirmed ? [.pairAgain] : [.pairAgain, .retry]
            )
        }
    }
}
