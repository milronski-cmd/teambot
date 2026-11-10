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
                VStack(spacing: 16) {
                    Image(systemName: copy.icon)
                        .font(.system(size: 44))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    Text(copy.title)
                        .font(.title3.bold())
                        .multilineTextAlignment(.center)
                    Text(copy.body)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    ForEach(Array(copy.actions.enumerated()), id: \.element) { index, action in
                        actionButton(action, primary: index == 0)
                    }
                    if !copy.tips.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(copy.tips, id: \.self) { tip in
                                Label(tip, systemImage: "lightbulb")
                                    .font(.callout)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(14)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                    VStack(spacing: 4) {
                        if let at = model.last?.connectedAt {
                            Text("Laatst verbonden \(Self.relative(at))")
                        }
                        Text("Zolang er geen verbinding is, wordt er niets verstuurd.")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                }
                .padding(24)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
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
                ProgressView()
            } else {
                Text(action.title).frame(maxWidth: 280)
            }
        }
        .disabled(action == .retry && model.checking)
        if primary {
            button.buttonStyle(.borderedProminent).controlSize(.large)
        } else {
            button.buttonStyle(.bordered)
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
