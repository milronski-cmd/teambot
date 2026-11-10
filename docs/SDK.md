# TeamBot-SDK — pakketten maken, ondertekenen en publiceren

Met de SDK maak je **pakketten** voor TeamBot: een skill, een bot-sjabloon of een connector-sjabloon (MCP), ondertekend
met jouw uitgeverssleutel. TeamBot controleert bij elke installatie en update de handtekening, elk bestand en de
compatibiliteit, bovenop de bestaande veiligheidsscan, checksums, het vertrouwen voor scripts en de rechten-diff.

- Code: `packages/teambot-sdk/src/index.ts` (één bestand, alleen `node:crypto`). De server gebruikt exact deze code.
- CLI: `scripts/teambot-pack.mjs`, ook als `npm run pack:package -- <opdracht>`.
- Voorbeeld: `examples/hello-skill/` (ondertekend met een wegwerpsleutel, zie onder).
- Tests: `tests/publisher-sdk.test.ts`.

De SDK wordt niet op npm gepubliceerd. Werk vanuit een checkout van de repository na `npm install`.

## Snel aan de slag

```bash
npm run pack:package -- keygen --out ~/.teambot/keys/mijn-uitgever.pem
npm run pack:package -- init ./mijn-skill --kind skill --publisher-id nl.mijnbedrijf --publisher-name "Mijn Bedrijf"
# schrijf SKILL.md, pas teambot-package.json aan
npm run pack:package -- validate ./mijn-skill
npm run pack:package -- sign ./mijn-skill --key ~/.teambot/keys/mijn-uitgever.pem
npm run pack:package -- verify ./mijn-skill
npm run pack:package -- zip ./mijn-skill            # -> ./mijn-skill-0.1.0.zip naast de map
```

Voeg `--json` toe voor uitvoer als JSON (handig in CI).

| Opdracht | Wat het doet |
|---|---|
| `keygen [--out <bestand>] [--force]` | Maakt een Ed25519-sleutelpaar. De privésleutel (PKCS#8 PEM, bestandsrechten 0600) blijft bij jou; standaard in `~/.teambot/keys/publisher-key.pem`. Weigert een plek in een pakketmap en overschrijft niets zonder `--force`. Toont de publieke sleutel en de vingerafdruk. |
| `init <map> --kind skill\|bot\|connector` | Zet een pakketmap op met een startbestand (`SKILL.md`, `bot.json` of `connector.json`) en een niet-ondertekend `teambot-package.json`. Opties: `--name`, `--version`, `--publisher-id`, `--publisher-name`, `--license`, `--key` (vult de publieke sleutel in). |
| `validate <map>` | Controleert het manifest, de compatibiliteit met deze TeamBot-versie, de bestanden tegen het manifest, de inhoud per soort (SKILL.md, bot-sjabloon, connector-sjabloon) en draait **dezelfde veiligheidsscan als de server**. Ernstige bevindingen en een privésleutel in het pakket laten de controle mislukken. |
| `sign <map> --key <bestand> [--new-key]` | Berekent de sha256 van elk bestand, vult `publisher.publicKey` in en ondertekent het manifest. Weigert als de sleutel in de pakketmap staat of als er een privésleutel in het pakket zit. `--new-key` vervangt een eerder ingevulde publieke sleutel (sleutelwissel, zie onder). |
| `verify <map\|zip> [--trust <sleutel>]` | Controleert handtekening, bestanden en compatibiliteit zoals TeamBot dat doet. Met `--trust` (sleutel of bestand, herhaalbaar) zie je "vertrouwd". Exitcode 0 alleen bij een geldige handtekening. |
| `zip <map> [--out <bestand>] [--allow-unsigned]` | Maakt een zip met het ondertekende pakket (niet in de pakketmap zelf). Weigert niet-ondertekende pakketten (tenzij `--allow-unsigned`) en elk pakket met een privésleutel. Toont de sha256 van de zip voor een catalogus. |
| `catalog-entry <map> [--id <id>]` | Drukt het JSON-item af voor een `teambot.catalog/v1`-index (zie Publiceren). |

## Wat is een pakket?

Een map (of zip met die map) met naast de inhoud een `teambot-package.json`:

| Soort (`kind`) | Hoofdbestand | Inhoud |
|---|---|---|
| `skill` | `SKILL.md` | Een skill in het open SKILL.md-formaat, met eventuele extra bestanden (zie `docs/modules/skills.md`). |
| `bot` | `bot.json` | Een bot-sjabloon in het formaat `teambot.bot-template/v1` (zelfde formaat als *Sjabloon exporteren*), eventueel met ingesloten skills. |
| `connector` | `connector.json` | Een connector-sjabloon in het formaat `teambot.connector/v1` (zie onder). |

Elk bestand in de map moet in het manifest staan; ontbrekende, gewijzigde of extra bestanden maken de handtekening
ongeldig. Mappen als `.git`, `node_modules` en `__MACOSX` en symbolische koppelingen worden overgeslagen, zowel door de
CLI als door TeamBot. Een privésleutel hoort nooit in een pakket: de CLI weigert dat en de scan van TeamBot markeert het
als ernstig.

### Het manifest (`teambot-package.json`)

```json
{
  "format": "teambot.package/v1",
  "name": "hello-skill",
  "version": "1.0.0",
  "kind": "skill",
  "description": "Korte beschrijving (optioneel).",
  "publisher": { "id": "nl.mijnbedrijf", "name": "Mijn Bedrijf", "publicKey": "<base64 van 32 bytes>" },
  "teambot": ">=0.1.0 <1.0.0",
  "requires": { "toolGroups": ["web"], "modules": ["mcp"] },
  "license": "Apache-2.0",
  "homepage": "https://… (optioneel)",
  "files": { "SKILL.md": "<sha256 hex>" },
  "signature": "<base64 van 64 bytes>"
}
```

| Veld | Regels |
|---|---|
| `format` | Altijd `teambot.package/v1`. |
| `name` | Kleine letters, cijfers, `.`, `_`, `-`; maximaal 64 tekens. Voor een skill gelijk aan `name` in SKILL.md (anders een waarschuwing). |
| `version` | Semver `x.y.z` (eventueel `-pre`). |
| `kind` | `skill`, `bot` of `connector`. |
| `publisher.id` | Je eigen herkenningsnaam, bijvoorbeeld een omgekeerde domeinnaam. **Alleen ter informatie**: vertrouwen hangt altijd aan de sleutel, nooit aan id of naam. |
| `publisher.name` | De naam die je zelf opgeeft. TeamBot toont bij een vertrouwde uitgever de naam uit de eigen vertrouwenslijst, niet deze. |
| `publisher.publicKey` | Base64 (standaard-alfabet, met `=`-opvulling) van de **ruwe 32-byte Ed25519-publieke sleutel**. Bij het plakken in TeamBot werkt ook base64url of een PEM met `BEGIN PUBLIC KEY`. |
| `teambot` | Versiebereik van TeamBot waarmee het pakket werkt: `>=`, `<=`, `>`, `<`, `=`, `^`, `~`, `1.x`, `*`, `a - b` en `\|\|`. Een spatie betekent "en". Pre-releases worden eenvoudig op volgorde vergeleken. |
| `requires` | Optioneel: toolgroepen (`toolGroups`) en modules (`modules`) die er moeten zijn. Ontbreekt er iets, dan is het pakket niet compatibel. |
| `license` | SPDX-licentie of -expressie (`MIT`, `Apache-2.0`, `MIT OR Apache-2.0`). |
| `files` | Pad (relatief, met `/`) naar sha256 (hex) van elk bestand behalve het manifest. |
| `signature` | Ed25519-handtekening, base64. |

### Wat wordt er ondertekend?

De handtekening is Ed25519 (`node:crypto`, geen extra afhankelijkheden) over de UTF-8-bytes van

```
"teambot.package/v1 signature\n" + canonicalJson(manifest zonder "signature")
```

`canonicalJson` is JSON in de stijl van RFC 8785 (JCS): sleutels van objecten gesorteerd op UTF-16-code-eenheden, geen
spaties of regeleinden, tekst en getallen zoals `JSON.stringify` ze schrijft, velden met `undefined` weggelaten. Opmaak,
inspringing en volgorde van velden in het bestand maken dus niet uit. De vaste voorzet ("domain separation") voorkomt dat
een pakkethandtekening ooit voor iets anders kan worden gebruikt. Onbekende extra velden worden meeondertekend.

Via de `files`-tabel dekt de handtekening ook de inhoud van elk bestand.

## Soorten pakketten

### Skill

Een gewone skillmap met `SKILL.md` en eventuele extra bestanden, plus het manifest. Zie `examples/hello-skill/`. Scripts in
een ondertekende skill blijven geblokkeerd tot de gebruiker ze zelf vertrouwt: een handtekening zegt *wie* iets maakte, niet
dat het veilig is.

### Bot-sjabloon

`bot.json` is een sjabloon in `teambot.bot-template/v1` (de export van een bot via *Sjabloon en delen* is een goed begin):

```json
{
  "format": "teambot.bot-template/v1",
  "name": "Onderzoeker",
  "role": "Zoekt bronnen en vat samen",
  "description": "…",
  "instructions": "…",
  "avatar": "🔎",
  "color": "#6366f1",
  "access_mode": "ask",
  "tool_groups": ["web"],
  "skills": [{ "name": "bronnenonderzoek", "version": "1.0.0", "checksum": "…", "files": { "SKILL.md": "…" } }],
  "routines": [],
  "meta": { "template_version": "1.0.0" }
}
```

Ingesloten skills vallen onder de handtekening van het pakket (ze zitten in `bot.json`). Na installatie tonen die skills
"via bot-sjabloon <naam>" met de uitgever van het bot-pakket. Provider, model, sleutels en gesprekken zitten nooit in een
sjabloon; `access_mode: "auto"` start veilig als "vragen".

### Connector-sjabloon

`connector.json` beschrijft een MCP-server zoals een sjabloon in de ingebouwde catalogus:

```json
{
  "format": "teambot.connector/v1",
  "name": "Voorbeeld-API",
  "description": "Wat de connector doet.",
  "category": "kennis",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "auth": "headers",
  "headers": [{ "name": "Authorization", "label": "API-sleutel", "secret": true, "required": true, "prefix": "Bearer " }],
  "scopes": [{ "name": "read", "description": "Alles lezen", "default": true }],
  "riskOverrides": { "delete_item": "danger" },
  "dataFlow": "Zoekvragen gaan naar mcp.example.com.",
  "source": "https://github.com/voorbeeld/mcp-server"
}
```

| Veld | Regels |
|---|---|
| `transport` | `http`, `sse` (met `url`, alleen https, zonder inloggegevens) of `stdio` (met `command`, `args`, optioneel `argsPrompt` en `env`). |
| `auth` | `none`, `headers` of `oauth` (`oauthClient`: `dynamic` of `own-app`, met `oauthAppHelp`). Van `oauthExtraParams` worden alleen `access_type` en `prompt` overgenomen. |
| `headers` / `env` | Velden die de gebruiker invult (`name`, `label`, `help`, `secret`, `required`, `prefix`, `placeholder`, `default`). Een sjabloon bevat nooit zelf geheimen. |
| `riskOverrides` | Per tool een risico (`read`/`write`/`exec`/`danger`); kan een tool alleen **strenger** maken dan de server aangeeft. |
| `dataFlow`, `requirements`, `source`, `docs`, `revokeHelp`, `availability` | Uitleg voor de gebruiker; `source` en `docs` moeten https zijn. |

Een connector uit een pakket doorloopt daarna precies dezelfde stappen als elke andere koppeling: opdracht vertrouwen
(stdio), leestest, acties pas na toestemming, gewijzigde tools opnieuw goedkeuren. Lokale programma's (stdio) blijven op
een gedeelde server voorbehouden aan beheerders.

## Publiceren

**Als bestand.** Deel de zip van `teambot-pack zip`. Gebruikers importeren:

- een skill via *Mijn skills › Importeren* (zip, map of internetadres);
- een bot-sjabloon via *Marktplaats › Sjabloon importeren* (zip of JSON);
- een connector via *Apps & connectors › Importeren › Pakketbestand…* (zip of JSON).

**In een catalogus.** Een externe catalogus is een JSON-index `teambot.catalog/v1` (zie `docs/modules/skills.md`).
`teambot-pack catalog-entry <map>` drukt het item af. Per soort:

```json
{
  "format": "teambot.catalog/v1",
  "name": "Catalogus van Mijn Bedrijf",
  "publisher": "Mijn Bedrijf",
  "skills": [
    { "id": "hello-skill", "name": "hello-skill", "title": "Hallo", "description": "…", "version": "1.0.0", "license": "Apache-2.0",
      "files": { "SKILL.md": "…" }, "sha256": "<checksum van de bestanden>", "manifest": { "…": "teambot-package.json" } },
    { "id": "grote-skill", "description": "…", "version": "2.0.0",
      "download": { "url": "https://…/grote-skill-2.0.0.zip", "sha256": "<sha256 van de zip>" }, "manifest": { "…": "…" } }
  ],
  "bots": [{ "id": "onderzoeker", "description": "…", "manifest": { "…": "…" }, "files": { "bot.json": "…" } }],
  "connectors": [{ "id": "voorbeeld-api", "description": "…", "manifest": { "…": "…" }, "files": { "connector.json": "…" } }]
}
```

- Zet het `manifest` in het item zelf, dan toont de marktplaats de uitgever al in de lijst. Bij een `download` controleert
  TeamBot de bestanden na het downloaden (de zip mag ook zelf een `teambot-package.json` bevatten).
- De sha256-checksums van de catalogus blijven gelden; de handtekening komt erbovenop.
- Binaire bestanden staan in `files` als `{ "base64": "…" }`.

## Hoe gebruikers controleren

Overal waar een pakket verschijnt (marktplaats, importvoorbeeld, Mijn skills, sjablonen, connectors) toont TeamBot één van:

| Label | Betekenis | Installeren |
|---|---|---|
| **Ondertekend door <uitgever>** | Geldige handtekening; de sleutel staat in de vertrouwenslijst. De naam komt uit die lijst. | Ja |
| **Vertrouwd: TeamBot (ingebouwd)** | Ingebouwd item van TeamBot zelf (komt mee met de installatie, geen aparte handtekening). | Ja |
| **Ondertekend, onbekende uitgever** | Geldige handtekening, maar de sleutel is (nog) niet vertrouwd. TeamBot toont de vingerafdruk en de naam die de uitgever zelf opgeeft. | Afhankelijk van het beleid |
| **Niet ondertekend** | Geen handtekening. | Afhankelijk van het beleid |
| **Handtekening ongeldig** | Handtekening of bestanden kloppen niet (gewijzigd na ondertekenen, extra bestand, verkeerde sleutel). | Nooit, ook niet met een uitzondering |
| **Niet compatibel met deze TeamBot-versie** | Het `teambot`-bereik of `requires` past niet; de reden staat erbij. | Nooit |

**Een uitgever vertrouwen.** Vergelijk de vingerafdruk (bijvoorbeeld `13c5 04de a333 …`) met wat de uitgever zelf publiceert
via een kanaal dat je vertrouwt. Een beheerder of eigenaar kiest daarna *Vertrouw deze uitgever* bij het pakket, of plakt de
publieke sleutel bij *Instellingen › Uitgevers en beleid*. Buiten TeamBot: `teambot-pack verify <zip> --trust <sleutel>`.

**Updates.** Een nieuwe versie moet zijn ondertekend met **dezelfde sleutel** als de geïnstalleerde versie. Is dat niet zo
(andere sleutel, of geen handtekening meer), dan weigert TeamBot met "andere uitgever" tot de eigenaar van de installatie
dat expliciet bevestigt; die wissel komt in het auditlog (`package.publisher_changed`). Daarna gelden nog steeds de
rechten-diff, de scan en het vertrouwen voor scripts. Een skill die je zelf bewerkt, is daarna niet meer ondertekend.

## Beleid voor beheerders

Bij *Instellingen › Uitgevers en beleid* (desktop en server) kiest de eigenaar of een beheerder:

| Beleid | Wat mag |
|---|---|
| `open` (standaard) | Alles, met duidelijke waarschuwingen. |
| `signed-only` | Alleen pakketten met een geldige handtekening, plus ingebouwde TeamBot-items. |
| `allowlist` | Alleen vertrouwde uitgevers en ingebouwde TeamBot-items. |

- De server handhaaft het beleid op elk pad: skills importeren (plakken, map, zip, URL, GitHub, map op de computer,
  ontdekken), skills uit de marktplaats, bot-sjablonen (bestand, pakket, catalogus, gedeeld op de server, ook via
  `ctx.services.skills.installTemplate`) en connectors (pakket, catalogus).
- **Leden op een gedeelde server** zijn altijd gebonden aan het beleid. Onder `signed-only` of `allowlist` kunnen zij ook
  geen eigen inhoud zonder uitgever toevoegen: geen skills plakken of bewerken, geen concepten publiceren, geen "Eigen
  server" koppelen en geen adres, opdracht of argumenten van een geïnstalleerd connector-sjabloon aanpassen.
- **Eigenaar en beheerders** kunnen per installatie een uitzondering maken met een expliciete bevestiging; die komt in het
  auditlog (`package.policy_override`). Een ongeldige handtekening of een incompatibel pakket kan niemand doorlaten.
- Beleid en vertrouwenslijst staan in de instelling `publisherPolicy` (gebruiker `''`) en worden gewijzigd via
  `PUT /api/skills/publishers/policy`, `POST /api/skills/publishers/trusted` en
  `DELETE /api/skills/publishers/trusted/:vingerafdruk` (gevalideerd en geaudit). Leden lezen `GET /api/skills/publishers`.
- Een bestaand pakket blijft werken als het beleid strenger wordt; het beleid geldt voor installeren en bijwerken.

## Sleutelbeheer

- Bewaar de privésleutel buiten elke pakketmap en repository, bij voorkeur versleuteld of in een wachtwoordkluis.
- **Sleutel kwijt of uitgelekt?** Maak een nieuwe sleutel, onderteken met `sign --new-key` en publiceer de nieuwe
  vingerafdruk. Gebruikers moeten de wissel bij de eerstvolgende update expliciet bevestigen, en beheerders vervangen de
  sleutel in hun vertrouwenslijst. Er is (nog) geen centrale intrekkingslijst.
- Teams kunnen per uitgever één sleutel delen, of per persoon een sleutel en die allemaal laten vertrouwen.

## Het voorbeeld `examples/hello-skill`

Een kleine skill, ondertekend met een **wegwerpsleutel die na het ondertekenen is weggegooid** (uitgever
`example.invalid`, "Voorbeelduitgever (alleen voorbeeld, niet vertrouwen)", vingerafdruk `13c5 04de a333 9388 16f9 80cc
aeed 06d9`). TeamBot toont het als "Ondertekend, onbekende uitgever". Voeg deze sleutel nooit toe aan je vertrouwenslijst:
er bestaat geen privésleutel meer, dus er komt ook nooit een geldige update. Wil je het voorbeeld zelf ondertekenen:

```bash
npm run pack:package -- keygen --out ~/.teambot/keys/test.pem
cp -r examples/hello-skill /tmp/hello-skill
npm run pack:package -- sign /tmp/hello-skill --key ~/.teambot/keys/test.pem --new-key
npm run pack:package -- verify /tmp/hello-skill
```

## De SDK vanuit code gebruiken

```ts
import { createManifest, hashFiles, signManifest, verifyPackage, generateKeyPair, MANIFEST_FILE } from '../packages/teambot-sdk/src/index.js';

const key = generateKeyPair(); // { publicKey, privateKeyPem, fingerprint }
const files = new Map([['SKILL.md', Buffer.from(skillMd)]]);
const manifest = signManifest(createManifest({ name: 'mijn-skill', version: '1.0.0', kind: 'skill', publisher: { id: 'nl.mij', name: 'Ik' }, license: 'MIT', files }), key.privateKeyPem);
files.set(MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2)));
const v = verifyPackage(files, { appVersion: '0.1.0', trusted: new Map([[key.publicKey, 'Ik']]) });
// v.state: 'trusted' | 'untrusted' | 'unsigned' | 'invalid'; v.compatible, v.errors, v.incompatible, v.publisher.fingerprint
```

Verder: `canonicalJson`, `sha256Hex`, `hashFiles`, `validateManifest`, `verifyManifestSignature`, `normalizePublicKey`,
`fingerprint`, `publicKeyFromPrivateKey`, `parseVersion`, `satisfies`, `parseRange`, `findPrivateKeys`, `inlineToFiles` en
`filesToInline` (het `{ manifest, files }`-formaat van catalogi en API).

**Waar het leeft.** De server importeert `packages/teambot-sdk/src/index.ts` rechtstreeks (relatief pad). `tsconfig.json`
neemt `packages/**/*.ts` mee, en de serverbuild (esbuild, `scripts/build.mjs`) bundelt de SDK in `dist/server/main.js`;
de Electron-installer en het Docker-image nemen dus automatisch dezelfde code mee. De CLI laadt de SDK en de scan van de
server (`server/modules/skills/scan.ts`) via `tsx`. Het SDK-bestand gebruikt alleen wisbare TypeScript-syntax en geen
relatieve imports, zodat het ook met Node's eigen type-stripping werkt.

## Beperkingen

- Een handtekening bewijst wie een pakket maakte en dat het onderweg niet is gewijzigd, niet dat het veilig is. Lees de scan.
- Geen centrale intrekkingslijst, tijdstempels of sleuteltransparantie; vertrouwen is per installatie.
- Ingebouwde items zijn niet apart ondertekend: hun integriteit komt van de TeamBot-installatie zelf.
- Het versiebereik volgt semver, maar vergelijkt pre-releases eenvoudiger dan npm.
