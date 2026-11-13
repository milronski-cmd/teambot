import SwiftUI
import UIKit

/// One honest screen per broken link (pc slaapt / TeamBot is dicht / netwerk weg / telefoon offline / koppeling
/// ingetrokken), with the fix as the first button. Checks again by itself while it is visible.
struct ConnectionView: View {
    @EnvironmentObject private var model: AppModel
    let pairing: Pairing
    let problem: LinkProblem

    init(pairing: Pairing, problem: LinkProblem) {
        self.pairing = pairing
        self.problem = problem
    }

    var body: some View {
        let copy = ProblemCopy.make(problem, pairing: pairing, phone: model.network, last: model.last)
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.gapLarge) {
                    StateHeader(title: copy.title, message: copy.body, badge: copy.icon, sleeping: true)
                    VStack(spacing: Theme.gapSmall) {
                        ForEach(Array(copy.actions.enumerated()), id: \.element) { index, action in
                            actionButton(action, primary: index == 0)
                        }
                    }
                    if !copy.tips.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(copy.tips, id: \.self) { tip in
                                Label(tip, systemImage: "lightbulb")
                                    .font(.callout)
                                    .foregroundStyle(Theme.ink)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .tbCard()
                    }
                    VStack(spacing: 4) {
                        if let at = model.last?.connectedAt {
                            Text("Laatst verbonden \(Self.relative(at))")
                        }
                        Text("Zolang er geen verbinding is, wordt er niets verstuurd.")
                    }
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                }
                .tbColumn()
            }
            .tbCanvas()
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
        }
        .task(id: problem) {
            // Check again every 15 seconds while this screen is visible (and right away on a network change).
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if Task.isCancelled { break }
                await model.refresh()
            }
        }
    }

    @ViewBuilder
    private func actionButton(_ action: ProblemAction, primary: Bool) -> some View {
        let button = Button {
            perform(action)
        } label: {
            if action == .retry && model.checking {
                HStack(spacing: Theme.gapSmall) {
                    ProgressView()
                    Text("Verbinden met je pc…")
                }
            } else {
                Text(action.title)
            }
        }
        .disabled(action == .retry && model.checking)
        if primary {
            button.buttonStyle(PrimaryButtonStyle())
        } else {
            button.buttonStyle(SecondaryButtonStyle())
        }
    }

    private func perform(_ action: ProblemAction) {
        switch action {
        case .retry:
            Task { await model.refresh() }
        case .openTailscale:
            Self.openTailscale()
        case .openAppSettings:
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        case .pairAgain:
            Task { await model.unpair() }
        }
    }

    /// The Tailscale app if it opens by its link, else its App Store page (which has an "Open" button when installed).
    static func openTailscale() {
        guard let app = URL(string: "tailscale://"), let store = URL(string: "https://apps.apple.com/app/id1470499037") else { return }
        UIApplication.shared.open(app, options: [:]) { opened in
            if !opened { UIApplication.shared.open(store) }
        }
    }

    static func relative(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "nl_NL")
        f.unitsStyle = .full
        return f.localizedString(for: date, relativeTo: Date())
    }
}
