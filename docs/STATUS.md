# Status — TeamBot

Bijgewerkt: 2026-11-09 (versie 0.4.4) · Project: `%USERPROFILE%\Projecten\teambot` (git `main`)

Waar staat wat:
- het plan voor 0.4 en wat daarna komt: `docs/PLAN_0.4.md` en `docs/PLAN_VOLGENDE.md`;
- acceptatie per functie met bewijs: `docs/ACCEPTANCE_0.4.md`; vergelijking met OpenBot (104 punten):
  `docs/PARITEIT_0.4.md`; wat niet kan en waarom: `docs/NOG_NIET_0.4.md`;
- de controles van deze versie: `docs/RELEASE_0.4.4_GATES.md` (eerdere: `docs/archief/`); kwaliteit (30 echte taken): `docs/quality/`;
- handleiding: `docs/HANDLEIDING.md`; wijzigingen per versie: `CHANGELOG.md`; eisenmatrix: `docs/MASTER_PLAN.md`.

## Waar we staan

TeamBot 0.4.4 staat op de pc van de eigenaar, met een verse start (lege datamap; de oude gegevens van 0.3 staan in
`%APPDATA%\TeamBot-oud-0.3-2026-11-09` en in `Documents\TeamBot\backups`). De iPhone-app 0.4.0 staat in TestFlight
(interne groep), en de verbeteringen voor de telefoon komen via de pc.

**Wat 0.4 is:** wat de andere botplatforms kunnen, maar beter. Eén hoofdbot die je zelf aanmaakt en die teams
aanstuurt; teams als afgeschermde werkruimtes (eigen geheugen, map, teamdatabase, kanalen, skills, routines, budget),
met per bot toegang *geen / meekijken / aansturen*; specialisten die zelf leren; eigen en gedeeld geheugen dat zichzelf
bijhoudt; een gratis reserveketen die standaard aanstaat, met *Belangrijk* dat pauzeert in plaats van op een zwakker
model door te gaan; een vaste gebruiksbalk; bewijs en een tweede blik vóór elke "klaar"; een simpele indeling en
starten in twee klikken; een veilige skills-catalogus; standaard dicht voor het netwerk; een nette installer.

**Bewijs (9 november, op de samengevoegde code):** typecheck schoon, `npm test` 1281/1281, alle 16 e2e-suites
(ook `phone-owner` als gekoppelde iPhone), `accept:04` 73/73 + 49/49, `parity:04` 182/182, `a11y` 0, `i18n:check`
10 talen × 15.687 teksten zonder fouten en 94 pagina's per taal zonder zichtbaar Nederlands, `mobile:check` 20/20,
`perf` 14/14, `licenses:check` 394 permissief, `secrets:check` 0, `website:check` 0, `status:check` 22/22.
Kwaliteit met lokaal Ollama: 16 van 30 taken (0.3.0: 12 van 30); geheugentest: 79% in de top 5 (0.3: 19%).
Naast OpenBot: 72 punten gelijk, 22 beter, 7 achter, 3 later afgesproken.

## Wat nog openstaat

**Samen met de eigenaar of van de eigenaar nodig:**
- de lampjes van geheugen en videokaart: eenmalig PawnIO installeren (één klik op *Ja*), daarna OpenRGB;
- de telefoon onderweg zonder Tailscale (verbindingsdienst, gratis Cloudflare-account) — afgesproken voor na 0.4,
  maar nodig voor "niks met Tailscale" voor gewone gebruikers;
- ondertekenen van de installer (bijv. Azure Trusted Signing), daarna verdwijnt de Windows-waarschuwing;
- een domeinnaam voor de website, en een plek voor updates;
- computer use live testen (`npm run desktop:live`, 1–2 minuten niet aan de pc komen), WhatsApp/Telegram echt koppelen;
- de inlog voor Claude Code op de pagina *Abonnementen* geeft een code door aan het officiële programma; kies of die
  blijft of dat alleen het eigen inlogscherm van Claude wordt geopend.

**Bekend:**
- De gratis keten probeert bij een tweede OpenCode-verbinding eerst die (met dezelfde limiet) voordat hij naar Ollama
  gaat.
- De echte installer (installeren over een oude versie, verwijderen) is alleen in delen getest; daarvoor is een
  schone VM of tweede Windows-account nodig.
- Niet in 0.4 (afgesproken voor later): Mac en Linux, doorwerken als de pc uit staat, workflows tekenen, voorlezen in
  meer talen, een Android-app.

## Starten en testen

- **Ontwikkelen:** `TEAMBOT_DATA=.data/dev npm run dev:server -- --mode desktop --port 4760` en
  `TEAMBOT_DEV_SERVER=http://127.0.0.1:4760 npm run dev:ui` (poort 4747 is van de geïnstalleerde TeamBot).
- **Testen, één voor één met een tijdelijke `TEAMBOT_DATA` en `APPDATA`:** `typecheck`, `test`, `build`, `e2e`,
  `accept:04`, `parity:04`, `phone:check`, `a11y`, `i18n:check`, `mobile:check`, `perf`, `licenses:check`,
  `secrets:check`, `website:check`, `status:check`; kwaliteit: `npm run quality -- --engine ollama`; geheugen:
  `npm run memory:bench`.
- **Vertalen:** `npm run i18n:extract` en `npm run i18n:translate` (sleutel via `TEAMBOT_TRANSLATE_KEY_FILE`).
- **Installer:** `npm run dist:win`, daarna `release\TeamBot-Setup-<versie>.exe` (`/S /currentuser` voor stil).
- **iPhone:** de map `mobile/ios` staat in de privé-repo `milronski-cmd/teambot-ios`; een build start met
  `gh workflow run testflight.yml -R milronski-cmd/teambot-ios`.
