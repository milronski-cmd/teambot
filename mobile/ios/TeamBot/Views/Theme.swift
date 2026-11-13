import SwiftUI
import UIKit

/// The look of the native screens, in one place. Same values as the web app (ui/src/styles.css): warm off-white
/// canvas with white cards in light, near-black in dark, and one accent: the orange of TeamBot with dark ink.
enum Theme {
    /// The one main button per screen.
    static let accent = dynamic(light: 0xFF9440, dark: 0xFF9A4D)
    static let accentPressed = dynamic(light: 0xE07A22, dark: 0xE8863A)
    /// Text and icons on the orange button.
    static let onAccent = dynamic(light: 0x241A10, dark: 0x1D140B)
    /// Orange for text, links and small controls: dark enough to read on the canvas (also Assets › AccentColor).
    static let accentText = dynamic(light: 0xB85A0A, dark: 0xFFAB69)

    static let canvas = dynamic(light: 0xFAF9F7, dark: 0x0F0F11)
    static let card = dynamic(light: 0xFFFFFF, dark: 0x19191D)
    static let surface2 = dynamic(light: 0xF5F3EF, dark: 0x1F1F23)
    static let surface3 = dynamic(light: 0xEBE8E2, dark: 0x28282E)
    static let line = dynamic(light: 0xE6E2DC, dark: 0x2A2A30)
    static let ink = dynamic(light: 0x1C1B19, dark: 0xEEEDF0)
    static let muted = dynamic(light: 0x5C5852, dark: 0xA8A5AE)
    static let danger = dynamic(light: 0xB12E2E, dark: 0xFF7A7A)

    static let cardRadius: CGFloat = 16
    static let controlRadius: CGFloat = 14
    /// Spacing scale: 8 inside a group, 16 between parts, 24 around a screen.
    static let gapSmall: CGFloat = 8
    static let gap: CGFloat = 16
    static let gapLarge: CGFloat = 24
    /// Widest a screen's column gets (iPad, landscape).
    static let columnWidth: CGFloat = 520

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? rgb(dark) : rgb(light)
        })
    }

    private static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// The main action of a screen: orange, full width, rounded. One per screen.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous)
        return configuration.label
            .font(.headline)
            .multilineTextAlignment(.center)
            .foregroundStyle(isEnabled ? Theme.onAccent : Theme.muted)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(isEnabled ? (configuration.isPressed ? Theme.accentPressed : Theme.accent) : Theme.surface3, in: shape)
            .contentShape(shape)
    }
}

/// Every other action: a calm card-coloured button with a thin border, same shape as the main one.
struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous)
        return configuration.label
            .font(.body.weight(.medium))
            .multilineTextAlignment(.center)
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(configuration.isPressed ? Theme.surface3 : Theme.card, in: shape)
            .overlay(shape.strokeBorder(Theme.line, lineWidth: 1))
            .contentShape(shape)
            .opacity(isEnabled ? 1 : 0.5)
    }
}

extension View {
    /// The page background of every native screen.
    func tbCanvas() -> some View {
        background { Theme.canvas.ignoresSafeArea() }
    }

    /// A white (dark: raised) card with a thin border.
    func tbCard() -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
        return self
            .padding(Theme.gap)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: shape)
            .overlay(shape.strokeBorder(Theme.line, lineWidth: 1))
    }

    /// One centred column with the same margins on every screen.
    func tbColumn() -> some View {
        self
            .padding(Theme.gapLarge)
            .frame(maxWidth: Theme.columnWidth)
            .frame(maxWidth: .infinity)
    }
}

/// The bot figure of TeamBot: a little rounded face. The only decoration on the native screens.
struct BotFace: View {
    var size: CGFloat = 72
    /// Eyes closed: the pc cannot be reached.
    var sleeping = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
                .fill(Theme.accent)
            VStack(spacing: size * 0.1) {
                HStack(spacing: size * 0.2) {
                    eye
                    eye
                }
                Capsule()
                    .fill(Theme.onAccent)
                    .frame(width: size * 0.26, height: size * 0.07)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var eye: some View {
        Capsule()
            .fill(Theme.onAccent)
            .frame(width: size * 0.12, height: sleeping ? size * 0.045 : size * 0.18)
    }
}

/// The top of every state screen: the bot, a clear title and one line. `badge` is an SF Symbol for what is wrong.
struct StateHeader: View {
    let title: String
    let message: String
    var badge: String?
    var sleeping = false

    init(title: String, message: String, badge: String? = nil, sleeping: Bool = false) {
        self.title = title
        self.message = message
        self.badge = badge
        self.sleeping = sleeping
    }

    var body: some View {
        VStack(spacing: Theme.gap) {
            BotFace(sleeping: sleeping)
                .overlay(alignment: .bottomTrailing) {
                    if let badge {
                        Image(systemName: badge)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .frame(width: 32, height: 32)
                            .background(Theme.card, in: Circle())
                            .overlay(Circle().strokeBorder(Theme.line, lineWidth: 1))
                            .offset(x: 10, y: 10)
                            .accessibilityHidden(true)
                    }
                }
                .padding(.bottom, Theme.gapSmall)
            Text(title)
                .font(.title2.bold())
                .foregroundStyle(Theme.ink)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(message)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }
}

/// One way to say that something went wrong (or needs attention) on every screen.
struct NoteCard: View {
    enum Kind {
        case error
        case info
    }

    let text: String
    var kind: Kind = .error

    init(_ text: String, kind: Kind = .error) {
        self.text = text
        self.kind = kind
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: kind == .error ? "exclamationmark.circle.fill" : "info.circle.fill")
                .foregroundStyle(kind == .error ? Theme.danger : Theme.muted)
                .accessibilityHidden(true)
            Text(text)
                .font(.callout)
                .foregroundStyle(Theme.ink)
        }
        .tbCard()
        .accessibilityElement(children: .combine)
    }
}

/// A text field with its label above it, in the shape of the other controls.
struct LabeledField: View {
    let label: String
    let prompt: String
    @Binding var text: String

    init(_ label: String, prompt: String, text: Binding<String>) {
        self.label = label
        self.prompt = prompt
        self._text = text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
                .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityLabel(label)
        }
    }
}
