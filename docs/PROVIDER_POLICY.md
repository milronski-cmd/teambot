# Providerbeleid

TeamBot verbindt met AI-providers **namens de gebruiker, met diens eigen account**. Er wordt niets doorverkocht en
geen login omzeild.

## Drie routes, altijd zichtbaar welke actief is

| Route | Voorbeelden | Wie betaalt | Opmerking |
|---|---|---|---|
| **Eigen API-sleutel (BYOK)** | OpenAI, Anthropic, Google Gemini, xAI, OpenRouter, Groq, DeepSeek, Mistral, … | De gebruiker, rechtstreeks aan de provider | Sleutel versleuteld opgeslagen; per bot/gesprek een model. |
| **Officiële agent-CLI met eigen login** | Claude Code, OpenAI Codex CLI, OpenCode, ACP-agents | Volgens het abonnement/de voorwaarden van de gebruiker bij die provider | TeamBot start de officiële CLI lokaal; de login blijft bij de CLI. TeamBot proxyt of deelt die login nooit met andere gebruikers. |
| **Lokaal model** | Ollama, LM Studio, llama.cpp, vLLM, Jan, LocalAI, Lemonade, KoboldCpp, text-generation-webui, GPT4All, eigen OpenAI-compatibele server | Gratis (eigen hardware) | Geen data naar buiten. |

**Gemini CLI**: sinds 18 juni 2026 niet meer voor gratis Google-accounts en Google AI Pro/Ultra; die zijn verhuisd
naar de Antigravity CLI (`agy`). De Gemini CLI werkt nog met een Gemini Code Assist Standard/Enterprise-licentie,
Vertex AI of een eigen betaalde Gemini API-sleutel (README van google-gemini/gemini-cli, gelezen op 9 november 2026).
TeamBot biedt hem daarom niet aan als gratis of abonnementsroute. De Antigravity CLI staat als **experimentele**
ACP-engine in `server/modules/cli-agents` (`agy acp`); voorwaarden voor gebruik vanuit een andere app zijn niet
gevonden, dus hij hoort niet bij de gratis keten tot dat is uitgezocht.

## Regels

1. **Geen doorverkoop.** Een ChatGPT-, Claude- of ander abonnement van gebruiker A wordt nooit gebruikt voor
   gebruiker B. Gedeelde providers op een server zijn API-sleutels die de beheerder bewust deelt; leden zien de sleutel
   niet.
2. **Geen login-omzeiling.** Alleen officiële SDK's, API's en CLI's met hun gedocumenteerde flags en auth-flows.
   Geen gescrapete web-sessies, geen account-rotatie.
3. **Geen stille wissel.** Een reserve-provider wordt alleen gebruikt bij storing/limiet en dat staat zichtbaar in de
   chat. Een modelwissel blijft zichtbaar in het gesprek.
4. **Kosten eerlijk.** Kosten zijn schattingen op basis van publieke prijzen; de provider factureert. Dagbudget per
   gebruiker stopt runs bij overschrijding. Testen van een verbinding doet nooit een betaalde prompt: TeamBot vraagt de
   modellenlijst of een gratis tegoed-/sleutel-endpoint op (OpenRouter `/key`, DeepSeek `/user/balance`, Moonshot
   `/users/me/balance`, Hugging Face `whoami`). Prijzen per model komen uit de live modellenlijst van de provider waar
   die ze publiceert (OpenRouter, Together, DeepInfra, Hugging Face, Cloudflare, Perplexity, Kilo); anders uit een
   kleine tabel waarin elke regel een controledatum en bron heeft; anders "onbekend" (nooit een gok). Elke providerkaart
   toont een kostenregel met de gratis limieten en de datum waarop die is nagekeken (`server/providers/catalog.ts`).
5. **Live spraak = API-facturering.** OpenAI Realtime/Live loopt via de OpenAI API met de sleutel van de gebruiker en
   wordt per gebruik gefactureerd; dat is niet inbegrepen in een ChatGPT Plus/Pro-abonnement. De vaste sleutel blijft op
   de server; de browser/telefoon krijgt alleen een kortlevend client-secret.
6. **Voorwaarden tonen.** Elke provider toont in de UI een facturatie- en auth-notitie. Vóór een release worden de
   actuele voorwaarden opnieuw gecontroleerd.
7. **Gratis bronnen: één account per aanbieder.** Tegoed telt per account of project, niet per sleutel. TeamBot gebruikt
   per aanbieder één verbinding en combineert nooit meerdere accounts om gratis limieten op te stapelen (dat verbiedt
   onder meer OpenRouter in §7(3) van zijn voorwaarden). Wisselen naar een **andere aanbieder** mag wel.
8. **Alles wat de pc verlaat staat uit tot de gebruiker het aanzet**, en heeft een zichtbaar privacylabel:
   *blijft op je pc*, *bewaart niets* of *kan trainen*. Zeggen de voorwaarden het niet, dan geldt *kan trainen*.
9. **Proeven kosten tegoed, dus zijn ze begrensd**: hoogstens één proefaanvraag per model per dag, binnen een klein
   dagbudget per aanbieder, nooit terwijl een bron op zijn reset wacht. De modellenlijst ophalen is gratis en gebeurt
   dagelijks.

## Gratis bronnen (Instellingen › Gratis modellen)

Stand en bronnen gelezen op **9 november 2026**. Module: `server/modules/free-models` (zie
[docs/modules/free-models.md](modules/free-models.md)).

| Bron | Gratis limiet | Privacylabel | Sleutel | Bronnen |
|---|---|---|---|---|
| OpenCode (gratis modellen) | Geen getal gepubliceerd | Per model: GLM-5.3-Flash Free en DeepSeek V4.1 Flash Free *bewaart niets*, de rest *kan trainen* | Geen; **alleen via de OpenCode CLI** (de gratis Zen-modellen zijn voor OpenCode zelf; TeamBot spreekt de Zen-server nooit rechtstreeks aan) | [opencode.ai/docs/zen](https://opencode.ai/docs/zen) |
| Groq | Per model een limiet per minuut en per dag (ongeveer 1.000 verzoeken per dag), op organisatieniveau; `x-ratelimit-*`-headers zeggen wat er over is | *bewaart niets* (standaard; misbruiklogboek tot 30 dagen, uit te zetten met Zero Data Retention) | Gratis, [console.groq.com/keys](https://console.groq.com/keys) | [rate-limits](https://console.groq.com/docs/rate-limits), [your-data](https://console.groq.com/docs/your-data) |
| OpenRouter `:free` | 20 per minuut, 50 per dag voor het hele account (1.000 na eenmalig $10 tegoed); per UTC-dag; `GET /api/v1/key` geeft `free_model_daily_requests` | *kan trainen* (§6.1: "Some Models may store or train on your Inputs") | Gratis, [openrouter.ai/keys](https://openrouter.ai/keys) | [limits](https://openrouter.ai/docs/api/reference/limits), [terms](https://openrouter.ai/terms) (31 augustus 2026) |
| Cloudflare Workers AI | 10.000 neurons per dag voor het account, reset 00:00 UTC; Kimi-, GLM- en DeepSeek V4-modellen alleen betaald | *bewaart niets* (geen opslag van in- en uitvoer, geen training) | Gratis token + Account-ID, [dashboard](https://dash.cloudflare.com/?to=/:account/ai/workers-ai) | [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/) |
| Z.ai GLM Flash | GLM-4.7-Flash, GLM-4.5-Flash en GLM-4.6V-Flash gratis; geen limiet gepubliceerd | *kan trainen* (niet vastgesteld) | Gratis, [z.ai](https://z.ai/manage-apikey/apikey-list) | [pricing](https://docs.z.ai/guides/overview/pricing) |
| Kilo Gateway | Zonder sleutel: alleen gratis modellen, 200 verzoeken per uur per IP-adres | *kan trainen* ("Auto Free may route your requests to providers that log prompts and outputs") | Niet nodig; optioneel via [app.kilo.ai/profile](https://app.kilo.ai/profile) | [authentication](https://kilo.ai/docs/gateway/authentication), [free models](https://kilo.ai/docs/code-with-ai/agents/free-and-budget-models), [models](https://kilo.ai/docs/gateway/models-and-providers) |
| Lokaal (Ollama, LM Studio, …) | Wat je pc aankan | *blijft op je pc* | Geen | — |

Bewust **niet** in de gratis set:
- **Google Gemini, gratis laag**: "You may use only Paid Services when making API Clients available to users in the
  European Economic Area, Switzerland, or the United Kingdom" (Gemini API Additional Terms, van kracht sinds
  23 maart 2026). Met een betaalde sleutel blijft Gemini een gewone provider.
- **GitHub Models** (gestopt op 30 juli 2026), **Ollama Cloud** (geen gratis plan meer), **Cerebras** (proef van
  30 dagen), **Hugging Face**, **SambaNova**, **Together** (geen terugkerend gratis tegoed).
- **NVIDIA NIM** en **Mistral gratis**: proef- of trainingsvoorwaarden zonder gepubliceerde getallen; wel bruikbaar als
  gewone provider.
- **Automatische routers** (`openrouter/free`, `kilo-auto/*`): die kiezen per verzoek een willekeurig model, dus geen
  vast label en geen voorspelbaar gedrag.

Hoe TeamBot een bron gebruikt:
- **429** = wachten tot de bekende reset (header, foutbericht, of 00:00 UTC bij OpenRouter en Cloudflare); onbekend =
  korte wachttijd die verdubbelt zolang het misgaat. Bij Groq wacht alleen dat ene model (limieten per model).
- **404/410** = model weg: uit de catalogus, in het logboek, geen foutmelding voor de gebruiker. Staat het de volgende
  dag weer in de lijst, dan komt het pas terug na een geslaagde proef (catalogi houden spookmodellen).
- **Antwoordcontrole**: een "geslaagd" antwoord met een foutmelding erin, een leeg antwoord, of een stream die afbreekt
  of stilvalt, telt als mislukt (een fout die de reserve-logica begrijpt). Tekst wordt pas getoond als duidelijk is dat
  het geen foutmelding is.
