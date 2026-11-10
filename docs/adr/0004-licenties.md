# ADR 0004 — Licenties van afhankelijkheden

**Status:** aangenomen (2026-11-06)

**Besluit.** Eigen code: Apache-2.0. Toegestane licenties voor dependencies: MIT, MIT-0, Apache-2.0, BSD-2/3,
ISC, 0BSD, BlueOak, CC0, Unlicense, Zlib, Python-2.0, CC-BY-4.0, en **MPL-2.0 alleen voor ongewijzigde npm-pakketten**
(zwakke copyleft op bestandsniveau; de broncode blijft via npm beschikbaar). Sinds 2026-11-06 gebruiken we geen
MPL-pakketten meer (`web-push` is vervangen door een eigen RFC 8291/8292-implementatie). GPL/AGPL/
LGPL, source-available en noncommercial (zoals PolyForm Noncommercial van nightly-labs/openbot) zijn uitgesloten.
Daarom geen Baileys voor WhatsApp (QR): die hangt van `libsignal` (GPL-3.0) af. We gebruiken whatsapp-web.js (Apache-2.0);
zijn LGPL-afhankelijkheid `node-webpmux` (alleen voor stickers) vervangen we via `overrides` door een eigen stand-in
(`packages/node-webpmux-stub`), en `puppeteer` door `puppeteer-core` (zelfde API, geen browserdownload).
`npm run licenses:check` faalt in CI bij een andere licentie; `npm run notices` maakt
`THIRD_PARTY_NOTICES.txt` + CycloneDX-SBOM.

**Open.** Juridische toets vóór commerciële cloudverkoop (plan §1, §6).
