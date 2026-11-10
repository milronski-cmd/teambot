# ADR 0005 — Telefoon: PWA eerst, native iOS-schil daarna

**Status:** aangenomen (2026-11-06)

**Context.** Een native iOS-app vereist macOS + Xcode + Apple Developer-account; die zijn er nu niet.

**Besluit.** De telefoon-companion is eerst een installeerbare PWA (zelfde UI, QR-koppeling, apparaat-tokens met
beperkte rechten, Web Push). Een kleine SwiftUI-schil (`mobile/ios/`) met native QR-scanner, Keychain en push wordt
meegeleverd als broncode en in CI op macOS gebouwd zodra de accounts er zijn.

**Gevolgen.** Alle telefoonfuncties zijn vandaag bruikbaar; App Store-publicatie blijft een externe voorwaarde.
