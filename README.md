# TeamBot

**Maak je eigen AI-team. Gebruik je eigen modellen en tools. Draai het lokaal of op je eigen server.**
Open source (Apache-2.0), gratis, zonder account nodig voor lokaal gebruik.

> *English:* TeamBot is an open-source, local-first workspace for persistent AI teammates. Bring your own models
> (OpenAI, Anthropic, Gemini, xAI, OpenRouter, Ollama, LM Studio, agent CLIs such as Claude Code and Codex, any
> OpenAI-compatible endpoint), give each bot its own role, workspace, memory and permissions, let bots work together,
> and reach them from your phone. Windows desktop app, self-hosted server (Docker) and a phone companion (PWA).

## Wat kan het?

| | |
|---|---|
| **Bots** | Eigen naam, rol, instructies, model, werkmap, geheugen en rechten. Maak ze door te beschrijven wat ze moeten doen. |
| **Elk model** | 20+ API-providers, lokale modellen (Ollama, LM Studio), agent-CLI's met je eigen login, eigen endpoints, reserve-provider bij storing. |
| **Veilig** | Bots vragen toestemming voordat ze iets wijzigen; verzenden, betalen, verwijderen en publiceren vragen altijd. Alles komt in een logboek. |
| **Samenwerken** | Groepschats met meerdere bots, delegeren, takenbord, vrienden uitnodigen op je eigen server. |
| **Geheugen & dossiers** | Zichtbaar, begrensd geheugen met bronnen, beoordelen, ongedaan maken en écht vergeten. |
| **Skills & apps** | `SKILL.md`-skills, MCP-connectors (GitHub, Notion, Linear, …), marktplaats met eigen sjablonen. |
| **Routines** | Planningen en triggers (webhooks, feeds, mappen, e-mail) met historie, limieten en geen dubbele runs. |
| **Spraak** | Dicteren, voorlezen en live praten (OpenAI Realtime) — microfoon alleen na jouw tik. |
| **Kanalen** | Praat met je bots via Telegram, Discord, Slack, e-mail of WhatsApp (met allowlist). |
| **Browser & computer** | Eigen browser per bot, live meekijken, overnemen, oefenen op een kopie met diff en ongedaan maken. |
| **Telefoon** | Koppel je telefoon met een QR-code, krijg meldingen, keur goed onderweg. |

De volledige functielijst en de status van elk onderdeel staan in [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) en
[`docs/STATUS.md`](docs/STATUS.md). Gebruikershandleiding: [`docs/HANDLEIDING.md`](docs/HANDLEIDING.md).

## Installeren

**Windows:** download `TeamBot-Setup-<versie>.exe` en installeer. TeamBot start lokaal; er is geen account nodig.
Sluit je het venster, dan blijft TeamBot in het systeemvak draaien zodat routines doorgaan.

**Eigen server (Docker):**

```bash
git clone <deze repo> teambot && cd teambot
docker compose up -d
docker compose logs teambot   # de eenmalige link om het eigenaar-account aan te maken
# nodig daarna vrienden uit via Instellingen → Gebruikers
```

TeamBot is standaard dicht: de poort staat alleen open op 127.0.0.1 van de server, en een verse server kan alleen
met die eenmalige link worden ingericht. Wil je hem vanaf andere apparaten gebruiken, zet hem dan achter HTTPS
(Caddy, Traefik, Cloudflare Tunnel of Tailscale) en zet `TEAMBOT_PUBLIC_URL` op dat https-adres. Zonder Docker
(`npm start`) luistert TeamBot ook alleen op 127.0.0.1, tenzij je zelf `TEAMBOT_HOST` zet.

**Telefoon:** open TeamBot op je computer → Instellingen → Telefoon → scan de QR-code. Zet de pagina op je
beginscherm voor meldingen.

## Ontwikkelen

```bash
npm install
npm run dev:server    # API op http://127.0.0.1:4747 (--mode desktop voor lokale eigenaar)
npm run dev:ui        # Vite op http://localhost:5173
npm run typecheck && npm test
npm run desktop:dev   # Electron-app
npm run dist:win      # Windows-installer in release/
```

Architectuur en het modulecontract: [`docs/DEVELOPING.md`](docs/DEVELOPING.md). Beveiliging:
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md), [`SECURITY.md`](SECURITY.md). Providerregels:
[`docs/PROVIDER_POLICY.md`](docs/PROVIDER_POLICY.md).

## Kosten en privacy

TeamBot rekent niets. Je koppelt je eigen provider; die factureert jou rechtstreeks. Lokale modellen zijn gratis.
Gesprekken, bestanden en geheugen staan op jouw computer of server. Alleen wat je naar een AI-provider of koppeling
stuurt, verlaat je apparaat — naar de dienst die jij kiest. Je kunt alles exporteren en verwijderen.

## Licentie

Apache-2.0 — zie [`LICENSE`](LICENSE) en [`NOTICE`](NOTICE). TeamBot is een onafhankelijke implementatie en bevat
geen code, teksten of merken van OpenBot, Grok Bot, OpenMausBot, Bloks, OpenClaw of Hermes.
