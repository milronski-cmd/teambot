# Module `sso` — Inloggen met SSO (OpenID Connect) & gebruikers en groepen koppelen (SCIM)

Teambeheer (TEAM-07): mensen loggen in met hun werkaccount bij een **OpenID Connect-provider** (Microsoft Entra ID,
Google Workspace, Keycloak, Okta, Authentik, …), en de provider kan via **SCIM 2.0** accounts automatisch
**aanmaken, bijwerken en blokkeren** en **groepen** doorgeven. De eigenaar koppelt elke groep aan een rol in
TeamBot, groepsgesprekken en een dagbudget. Alleen in **servermodus**; op de desktop is alles verborgen
(`/api/public/sso` zegt `enabled: false`, `/scim/v2` geeft 404, de admin-routes geven 400).

Beheer: Instellingen → **Gebruikers** → kaarten *Inloggen met SSO*, *Gebruikers koppelen (SCIM)* en
*Groepen uit je provider (SCIM)*. In de gebruikerslijst staat bij wie in een SCIM-groep zit “via SCIM: …”.

## Inloggen met SSO — hoe het werkt

1. Het inlogscherm vraagt `GET /api/public/sso` → `{enabled, label, requireSso}` en toont de knop (bijv.
   “Inloggen met Microsoft”).
2. **Start** — `GET /api/public/sso/start`: discovery van de issuer (gecachet per instellingenversie, 15 min), dan
   `state`, `nonce` en een **PKCE**-verifier (S256) via `openid-client`. Een HttpOnly-cookie `tb_sso`
   (SameSite=Lax, 10 min, pad `/api/public/sso`, `Secure` bij https) bindt de poging aan déze browser (tegen
   login-CSRF). Opent iemand TeamBot op een ander adres dan het ingestelde adres, dan gaat de start eerst naar het
   vaste adres (anders staat de cookie op de verkeerde host). Redirect naar de provider met scopes
   `openid email profile`.
3. **Callback** — `GET /api/public/sso/callback?code&state`: de poging moet bestaan, mag maar één keer, moet bij de
   cookie horen en bij de huidige instellingenversie. `openid-client` wisselt de code in (PKCE + clientgeheim,
   `client_secret_basic` of — als de provider alleen dat biedt — `client_secret_post`) en controleert het ID-token:
   **handtekening** (JWKS van de provider; ook bij een token rechtstreeks van het token-endpoint), **iss**, **aud**,
   **exp/iat**, **nonce**. Daarna:
   - `email_verified: false` → geweigerd (ontbreekt de claim, zoals bij Entra ID, dan mag het);
   - e-mail uit de claim `email`; alleen bij Microsoft-issuers valt TeamBot terug op `preferred_username` (de UPN,
     die alleen de tenantbeheerder kan zetten). Andere providers laten mensen die claim soms zelf kiezen;
   - het domein moet in de **toegestane domeinen** staan (exacte match, geen subdomeinen; leeg = elk domein);
   - account zoeken: eerst op koppeling **(issuer, sub)**, dan op e-mailadres → koppelen (`sso.linked`), anders
     **automatisch aanmaken** als dat aan staat (`sso.provisioned`, rol *lid* of — alleen door de eigenaar ingesteld —
     *beheerder*; het maximum aantal gebruikers `TEAMBOT_MAX_USERS` geldt ook hier), anders geweigerd. Een
     geblokkeerd account wordt altijd geweigerd.
4. **Overdracht aan de app** — redirect naar `<adres>/#/?sso=<code>`: een **eenmalige code** (256 bit, 60 s geldig,
   alleen als hash in het geheugen, gebonden aan dezelfde cookie). Het URL-fragment gaat nooit naar een server of
   log. De app wisselt de code in met `POST /api/public/sso/exchange {code}` → `{token, user}`, precies zoals een
   wachtwoordlogin; daarna een gewone `web`-sessie (90 dagen) en de adresbalk wordt opgeschoond. Een gekopieerde
   code werkt op een ander apparaat dus niet.
5. Mislukt iets, dan gaat de browser naar `<adres>/#/?sso_error=<reden>`. Alleen een vaste code
   (`state`, `provider`, `unverified`, `noemail`, `domain`, `unknown`, `disabled`, `config`, `rate`, `seats`); de app
   toont de Nederlandse tekst. Er staat nooit vrije tekst of een extern doel in de URL (geen open redirect).

Elke login (`sso.login`), koppeling, aanmaak en weigering (`sso.refused` met reden, e-mail, IP en de precieze
controle die faalde) komt in de audit; beheerders zien de laatste 50 SSO-/SCIM-gebeurtenissen in de kaart.
Nooit gelogd: tokens, codes, het clientgeheim, ID-tokens. Rate limits per IP: start en callback 30/min,
mislukte code-inwisselingen 10/min.

### Wie mag wat

| Instelling | Eigenaar | Beheerder |
|---|---|---|
| Issuer-URL, client-ID, clientgeheim, adres van TeamBot | ja | nee (403) |
| Nieuwe accounts automatisch **beheerder** maken | ja | nee |
| Aan/uit, knoptekst, toegestane domeinen, automatisch aanmaken (als lid), SSO verplichten, discovery testen | ja | ja |
| SCIM-sleutel maken/intrekken, gedrag bij verwijderen, groepskoppeling opnieuw toepassen | ja | nee (alleen bekijken) |
| Een SCIM-groep koppelen aan de rol **beheerder** of aan **groepsgesprekken** | ja | nee (403) |
| Een SCIM-groep koppelen aan een dagbudget, of terugzetten van beheerder naar lid | ja | ja |

De provider is alleen door de eigenaar in te stellen omdat SSO accounts koppelt op e-mailadres: wie de provider
kiest, kan anders inloggen als ieder ander account — ook dat van de eigenaar. Om dezelfde reden geeft alleen de
eigenaar via een groep beheerdersrechten of toegang tot zijn groepsgesprekken.

Controles bij opslaan: aanzetten vraagt issuer + client-ID; automatisch aanmaken vraagt minstens één toegestaan
domein; SSO verplichten vraagt dat SSO aan staat. Het clientgeheim staat versleuteld in `secrets` (gebruiker `''`,
naam `sso:client_secret`) en komt nooit terug in een API-antwoord (alleen `hasClientSecret`).

### Adres van TeamBot en redirect-URI

Redirect-URI = `<adres van TeamBot>/api/public/sso/callback`. Het adres is, in deze volgorde: de instelling
*Adres van TeamBot* in de SSO-kaart, `TEAMBOT_PUBLIC_URL`, en anders het adres waarop de eigenaar SSO aanzette
(wordt dan vastgelegd zodat de redirect-URI stabiel blijft). Achter een reverse proxy: zet het https-adres dat
mensen gebruiken (en `TEAMBOT_TRUST_PROXY` als de proxy niet op dezelfde machine draait). Een adres met een
padprefix (`https://host/teambot`) werkt; het cookiepad volgt het prefix.

De kaart toont de redirect-URI met een kopieerknop, plus de knop **Discovery testen** (haalt
`/.well-known/openid-configuration` op en toont issuer, endpoints, JWKS en PKCE-ondersteuning, of de fout).

### Microsoft Entra ID

1. Entra-beheercentrum → **App registrations** → *New registration*. Accounttype: *Accounts in this organizational
   directory only*. Redirect URI: platform **Web**, de redirect-URI uit TeamBot.
2. *Certificates & secrets* → *New client secret* → kopieer de **Value** naar *Clientgeheim* in TeamBot.
3. *API permissions*: Microsoft Graph (gedelegeerd) `openid`, `email`, `profile` (standaard aanwezig of toevoegen).
   *Token configuration*: voeg de optionele claim **email** (ID-token) toe.
4. In TeamBot: **Issuer-URL** `https://login.microsoftonline.com/<tenant-id>/v2.0` (Directory (tenant) ID uit
   *Overview*), **Client-ID** = Application (client) ID, toegestane domeinen = je eigen domein(en).
   Issuers zonder eigen tenant (`common`, `organizations`, `consumers`) worden **geweigerd**: dan zou elke
   Microsoft-organisatie kunnen inloggen.
5. Entra stuurt geen `email_verified`. Gastaccounts (B2B): het e-mailadres is niet door Microsoft gecontroleerd —
   laat de toegestane domeinen daarom alleen je eigen domeinen bevatten.

### Google Workspace

1. Google Cloud Console → *APIs & Services* → *OAuth consent screen*: type **Internal** (alleen je Workspace).
2. *Credentials* → *Create credentials* → *OAuth client ID* → **Web application** → *Authorized redirect URIs*:
   de redirect-URI uit TeamBot. Kopieer client-ID en -geheim.
3. In TeamBot: Issuer-URL `https://accounts.google.com`, toegestane domeinen = je Workspace-domein (bijv.
   `bedrijf.nl`). Google stuurt `email_verified`; niet-bevestigde adressen worden geweigerd.

### Andere OIDC-provider (Keycloak, Authentik, Okta, Auth0, Zitadel, …)

- Maak een **vertrouwelijke** client (confidential, met geheim) voor de *authorization code flow* met **PKCE S256**;
  redirect-URI zoals hierboven; scopes `openid email profile`; zorg dat het ID-token de claim `email` bevat.
- Issuer-URL = de exacte `issuer` uit het discovery-document, bijv. Keycloak `https://host/realms/<realm>`, Okta
  `https://<org>.okta.com` of `https://<org>.okta.com/oauth2/default`, Auth0 `https://<tenant>.auth0.com/` (met `/`).
  Discovery testen meldt het als de waarde niet precies overeenkomt.
- Een lokale provider via **http** mag alleen op een loopback- of privéadres (zoals `http://127.0.0.1:8080/realms/x`)
  en alleen als de eigenaar hem instelde; verder is **https verplicht**. Alle verzoeken naar de provider gaan via
  `safeFetch` (SSRF-controle bij elke doorverwijzing; privéadressen alleen voor provider-instellingen van
  eigenaar/beheerder).
- Een client zonder geheim (public client met alleen PKCE) werkt ook: laat *Clientgeheim* leeg.

### Geen adressen claimen

Omdat SSO bij de eerste login op e-mailadres koppelt, mag niemand behalve de eigenaar zichzelf een adres geven dat
SSO zou koppelen zolang SSO aan staat: een aanmelding met wachtwoord (ook met uitnodiging) voor een adres in een
toegestaan domein wordt geweigerd (`403 sso_required`; is de domeinlijst leeg, dan geldt dat voor elk adres), en
`PATCH /api/me` mag het e-mailadres niet naar zo'n adres wijzigen of leegmaken (`403 sso_managed`). Uitnodigingen
voor mensen buiten de SSO-domeinen blijven werken. Accounts die al vóór het aanzetten van SSO bestonden, worden
vertrouwd zoals ze zijn: controleer bij twijfel de lijst *Gebruikers* voordat je SSO aanzet.

### SSO verplichten

Aan: leden **en beheerders** kunnen niet meer met een wachtwoord inloggen (`403`, code `sso_required`, ook voor
onbekende e-mailadressen) en niemand maakt nog een wachtwoordaccount (ook niet met een uitnodiging; die blijft dan
ongebruikt). Het inlogscherm toont alleen de SSO-knop en een klein linkje *Eigenaar? Log in met wachtwoord*: de
**eigenaar houdt zijn wachtwoord als noodtoegang**. Telefoons koppelen blijft werken (de code komt van een
ingelogde sessie). Bestaande sessies blijven geldig tot ze verlopen of worden ingetrokken. SSO uitzetten kan pas als
*verplichten* uit staat; daarna werken wachtwoorden weer.

## SCIM 2.0 — gebruikers en groepen koppelen

- Adres (*Tenant URL*): `<adres van TeamBot>/scim/v2` (buiten `/api`, eigen authenticatie).
- **Sleutel**: de eigenaar maakt hem in de SCIM-kaart (`tbscim_…`, 256 bit); hij wordt **één keer getoond**.
  Opgeslagen wordt alleen de SHA-256-hash; vergelijking in constante tijd; alleen via de header
  `Authorization: Bearer …`. Er is één actieve sleutel: een nieuwe maken trekt de oude meteen in. 10 foute
  pogingen per minuut per IP → 429. *Laatst gebruikt* staat in de kaart.
- Antwoorden in `application/scim+json`; fouten in het SCIM-formaat
  (`urn:ietf:params:scim:api:messages:2.0:Error`, `status` als tekst, `scimType` waar van toepassing:
  `uniqueness`, `invalidFilter`, `invalidSyntax`, `invalidValue`, `mutability`).

| Endpoint | Ondersteund |
|---|---|
| `GET /ServiceProviderConfig`, `GET /ResourceTypes[/User\|/Group]`, `GET /Schemas[/:id]` | ja (patch en filter: ja; bulk, sort, etag, changePassword: nee) |
| `GET /Users` | lijst, `filter` = `userName eq "…"`, `externalId eq "…"`, `id eq "…"`, `emails[type eq "work"].value eq "…"`; `startIndex`, `count` (max 200) |
| `GET /Users/:id` | ja, met de alleen-lezen lijst `groups` |
| `POST /Users` | 201 + `Location`; 409 `uniqueness` als het e-mailadres of de userName al bestaat; 403 als het maximum aantal gebruikers bereikt is |
| `PUT /Users/:id` | vervangt (userName verplicht) |
| `PATCH /Users/:id` | `add`/`replace`/`remove` in elke schrijfwijze (Entra: `Replace`, `"False"`), met `path` of als object zonder `path` (Okta) |
| `DELETE /Users/:id` | 204 (zie hieronder) |
| `GET /Groups` | lijst, `filter` = `displayName eq "…"` (hoofdletterongevoelig), `externalId eq "…"`, `id eq "…"`, `members.value eq "…"`; `startIndex`, `count`; `excludedAttributes=members` / `attributes=` |
| `GET /Groups/:id` | ja (ook met `excludedAttributes=members`) |
| `POST /Groups` | 201 + `Location`; 409 `uniqueness` bij een bestaande `displayName` |
| `PUT /Groups/:id` | vervangt alles: wat niet in `members` staat, gaat eruit (RFC 7644 §3.5.1) |
| `PATCH /Groups/:id` | Entra: `Add`/`Remove` met `path: "members"` en een lijst `[{value}]`, `Replace` van `displayName`; Okta: `replace` zonder path, `replace` van `members`, `remove` met `members[value eq "…"]`; `remove` van `members` zonder waarde = iedereen eruit |
| `DELETE /Groups/:id` | 204; alles wat de groep gaf, wordt teruggedraaid |

**Gebruikersvelden**: `userName` en `emails` (primair/`work`) → e-mailadres (is `userName` geen e-mailadres, dan is
een e-mail verplicht); `name.formatted`/`displayName` (of `givenName` + `familyName`) → naam; `externalId` en
`userName` worden bewaard; `active` → geblokkeerd/actief. Genegeerd: wachtwoord, rollen, extensies (enterprise),
overige attributen. **Een SCIM-account wordt altijd als lid aangemaakt**; een hogere rol kan alleen uit een
groepskoppeling komen (zie hieronder).

**Groepsvelden**: `displayName` (uniek, hoofdletterongevoelig), `externalId`, `members` (alleen gebruikers; geneste
groepen worden niet ondersteund). Een lid-id die TeamBot niet kent (of die via SCIM verwijderd is) wordt
genegeerd en in de audit geteld.

**Eigenaar en beheerders** zijn zichtbaar (zodat de provider ze kan matchen), maar SCIM kan ze niet wijzigen,
blokkeren of verwijderen (403 `mutability`); een PATCH die niets verandert is wel 200. Uitzondering: wie beheerder
werd **door een groepskoppeling**, blijft door SCIM te beheren (anders zou offboarding via de provider niet werken).
De eigenaar mag lid van een SCIM-groep zijn, maar de koppeling verandert nooit iets aan zijn account.

**Blokkeren** (`active: false`): account geblokkeerd, **alle sessies ingetrokken** (REST én open WebSockets),
lopende bot-taken gestopt, en er starten geen nieuwe taken meer voor dat account (ook niet via routines, kanalen of
groepsgesprekken). Inloggen met wachtwoord, SSO, een bestaand token of een koppelcode lukt niet meer. Wat
groepskoppelingen gaven (beheerdersrol, groepsgesprekken, budget), wordt teruggenomen. `active: true` heft dat op
(sessies blijven ingetrokken; opnieuw inloggen) en past de koppelingen weer toe — maar alleen als er nog een plaats
vrij is (`TEAMBOT_MAX_USERS`, anders 403).

**Verwijderen** (`DELETE`) — instelling van de eigenaar:
- **Blokkeren, gegevens bewaren** (standaard): als hierboven, en de persoon gaat uit alle SCIM-groepen; voor SCIM
  bestaat de gebruiker daarna niet meer (404, niet in lijsten). Maakt de provider hetzelfde e-mailadres later
  opnieuw aan, dan komt **hetzelfde account** terug.
- **Verwijderen**: het account met al zijn gegevens: modules met `deleteUser` (geheugen) ruimen eerst op, de persoon
  verlaat alle groepsgesprekken van anderen, het persoonlijke budget vervalt, daarna worden in één transactie alle
  rijen met `user_id` van die persoon, of `agent_id`/`thread_id` van zijn bots en gesprekken, verwijderd, plus
  bijlagen en de werkmappen van zijn bots. De audit blijft bewaard.

### Groepen koppelen (rol, groepsgesprekken, budget)

Groepen verschijnen in de kaart *Groepen uit je provider (SCIM)* zodra de provider ze stuurt. Per groep:

- **Rol in TeamBot** — *lid* (standaard: niets extra) of *beheerder*. Leden in een beheerdersgroep worden beheerder.
- **Groepsgesprekken** — één of meer actieve groepsgesprekken **van de eigenaar** (module *Groepen & teams*). Leden
  worden er direct lid van (geen uitnodiging; een openstaande uitnodiging wordt geaccepteerd), met een melding in
  het gesprek en in hun inbox. Is die module niet geladen, dan toont de kaart dat en kan alleen rol en budget.
- **Dagbudget per lid (USD)** — schrijft het persoonlijke budget (dezelfde `memberBudgets` als bij *Teamgebruik*);
  geldt alleen voor leden, niet voor beheerders. Zit iemand in meerdere groepen met een budget, dan telt het
  **hoogste**. `0` = geen limiet, leeg = de groep zet geen budget.

**Wanneer**: bij elke wijziging van het lidmaatschap (POST/PUT/PATCH/DELETE van een groep), bij elke wijziging van
de koppeling (voor alle leden van die groep), bij blokkeren/heractiveren via SCIM, en met de knop **Opnieuw
toepassen** (eigenaar; bijvoorbeeld na het deblokkeren van iemand in TeamBot zelf).

**Terugdraaien**: TeamBot onthoudt per persoon wat de koppeling zelf gaf (`scim_applied`) en draait alleen dat
terug. Wie uit alle beheerdersgroepen gaat, wordt weer **lid** — maar alleen als de koppeling hem beheerder maakte;
een beheerder die met de hand beheerder werd, blijft beheerder. Gekoppelde groepsgesprekken worden verlaten, maar
alleen die de koppeling zelf toevoegde. Een budget wordt alleen weggehaald als het nog de waarde van de koppeling
heeft (een budget dat een beheerder daarna met de hand wijzigde, blijft). Er wordt **nooit** iets verwijderd:
gesprekken, bestanden en bots blijven bestaan. Een groep verwijderen werkt als iedereen eruit halen.
Geblokkeerde accounts krijgen niets nieuws en blijven geblokkeerd.

Elke stap staat in de audit: `scim.group.created/renamed/members/deleted` (met toegevoegd/verwijderd/genegeerd),
`scim.group.mapping` (wie welke koppeling instelde) en `scim.mapping.applied` per persoon (rol, gesprekken,
budget en de reden). In de gebruikerslijst staat “via SCIM: <groepen>”.

### Entra ID-provisioning

*Enterprise applications* → je app (of *New application* → *Create your own* → non-gallery) → **Provisioning** →
*Automatic* → *Tenant URL* = SCIM-adres, *Secret Token* = SCIM-sleutel → *Test Connection*.

- **Gebruikers** (*Provision Microsoft Entra ID Users*): `userPrincipalName` → `userName`, `mail` →
  `emails[type eq "work"].value`, `displayName` → `displayName`, `Switch([IsSoftDeleted]…)` → `active`,
  `objectId` → `externalId`. Entra stuurt bij het verwijderen van een toewijzing een PATCH `active = False` en pas
  na de soft-delete-periode een DELETE.
- **Groepen** (*Provision Microsoft Entra ID Groups*, aan): `displayName` → `displayName`, `objectId` →
  `externalId`, `members` → `members`. Wijs de groepen toe aan de app (*Users and groups*) met scope *Sync only
  assigned users and groups*; leden van een toegewezen groep worden ook als gebruiker aangemaakt. Entra zoekt eerst
  met `displayName eq "…"` en stuurt lidmaatschap daarna als `PATCH` met `Add`/`Remove` op `members`.
- Koppel daarna in TeamBot elke groep aan rol, gesprekken en budget. Geneste groepen stuurt Entra niet mee.

### Okta-provisioning

App → *General* → *Provisioning: SCIM* → *Provisioning* → *Integration*: SCIM-connector-basis-URL = SCIM-adres,
*Unique identifier field* = `userName`, acties *Push New Users*, *Push Profile Updates* en **Push Groups**,
authenticatie *HTTP Header* met de SCIM-sleutel. *To App*: Create Users, Update User Attributes, Deactivate Users.
Daarna tab **Push Groups** → *Push Groups* → *Find groups by name* → kies de groepen (Okta maakt ze aan of koppelt
ze op naam; lidmaatschap gaat als `PATCH` op `members`, hernoemen als `replace` zonder path). Koppel daarna in
TeamBot elke groep aan rol, gesprekken en budget.

## Beperkingen

- Eén provider per server.
- Uitloggen bij de provider beëindigt de TeamBot-sessie niet (geen front-/back-channel logout); blokkeer via SCIM of
  in TeamBot.
- Inlogpogingen en overdrachtscodes staan in het geheugen van het serverproces: na een herstart tijdens het
  inloggen opnieuw beginnen; met meerdere serverprocessen achter één adres werkt SSO alleen met sticky sessions.
- SCIM: geen bulk, sort, etag; filters alleen `eq` op de genoemde attributen; één actieve sleutel.
- Groepen: `displayName` moet uniek zijn; geen geneste groepen; alleen groepsgesprekken van de eigenaar zijn te
  koppelen; deblokkeren in TeamBot zelf past koppelingen pas toe bij de volgende groepswijziging of met *Opnieuw
  toepassen*.
- Bij *verwijderen*: bestanden buiten `attachments/` en de botwerkmappen (bijv. browserprofielen) blijven staan;
  op dat moment verbonden kanaalkoppelingen sluiten pas bij de volgende herstart (ze kunnen niets meer: bots en
  koppelingen zijn uit de database).
- De nieuwste teksten (groepen) staan nog niet in de Engelse vertaling (`npm run i18n:extract` + `i18n:translate`).
- Getest tegen een eigen OIDC-provider en SCIM-verzoeken in de stijl van Entra en Okta in het proces, niet tegen de
  echte diensten.

## API

| Methode + pad | Wie | Wat |
|---|---|---|
| `GET /api/public/sso` | iedereen | `{enabled, label, requireSso}` |
| `GET /api/public/sso/start` | iedereen | redirect naar de provider (zet cookie `tb_sso`) |
| `GET /api/public/sso/callback` | provider → browser | controles, redirect naar `#/?sso=<code>` of `#/?sso_error=<reden>` |
| `POST /api/public/sso/exchange` | de app (zelfde browser) | `{code}` → `{token, user}` |
| `GET /api/admin/sso`, `PUT /api/admin/sso` | beheerder (provider: eigenaar) | instellingen; `clientSecret` alleen schrijven, `clearClientSecret: true` wist |
| `POST /api/admin/sso/test` | beheerder | `{issuer?}` → discovery-resultaat of `{ok:false, error}` |
| `GET /api/admin/sso/events` | beheerder | laatste 50 audit-regels `sso.*`/`scim.*` |
| `GET /api/admin/scim` | beheerder | adres, sleutelstatus, verwijdergedrag |
| `PUT /api/admin/scim` | eigenaar | `{deleteMode: 'deactivate' \| 'delete'}` |
| `POST /api/admin/scim/token`, `DELETE /api/admin/scim/token` | eigenaar | nieuwe sleutel (`newToken`, één keer) / intrekken |
| `GET /api/admin/scim/groups` | beheerder | `{groups: [{id, displayName, externalId, role, roomIds, dailyBudgetUsd, members}], rooms (null = module afwezig), canEdit}` |
| `PUT /api/admin/scim/groups/:id` | beheerder (rol *beheerder* en gesprekken: eigenaar) | `{role?, roomIds?, dailyBudgetUsd?}`; meteen toegepast op de leden |
| `POST /api/admin/scim/groups/apply` | eigenaar | alle koppelingen opnieuw toepassen |
| `/scim/v2/*` | SCIM-sleutel | zie boven |

Dienst voor andere modules: `ctx.services.sso.active()`, `ctx.services.sso.required()`.

## Tabellen

`sso_settings` (sleutel/waarde: `oidc`, `scim`), `sso_identities` (issuer + sub → gebruiker, laatste login),
`scim_users` (userName, externalId, `deleted`), `scim_tokens` (hash, aangemaakt door, laatst gebruikt, ingetrokken),
`scim_groups` (displayName, externalId en de koppeling: `role`, `room_ids`, `daily_budget_usd`),
`scim_group_members` (groep ↔ gebruiker), `scim_applied` (wat de koppeling per persoon gaf: `role_granted`,
`budget`, `room_ids`).

## Wijzigingen buiten deze module

- `ctx.rootApi` (`server/core/types.ts`, `server/app.ts`): router op de serverroot, buiten `/api` en zonder sessie
  (voor `/scim/v2`).
- `Auth.passwordPolicies` (controle vóór wachtwoordlogin en -aanmelding) en `Auth.revokeUserSessions()`; een
  uitnodiging wordt pas verbruikt als het account echt is aangemaakt. De e-mailcontrole op `PATCH /me` gebruikt de
  bestaande `Auth.policies`.
- `ChatService.startAgent` start geen taken voor bots van een geblokkeerd account.
- `redact()` maskeert ook `tbscim_…`-sleutels.
- Module *Groepen & teams*: `RoomService.grantPerson()` (iemand direct als lid toevoegen) en op
  `ctx.services.rooms`: `roomsOf(userId)`, `addPerson(roomId, userId, byUserId)` (alleen door de eigenaar van het
  gesprek), `removePerson(...)`, `removePersonEverywhere(userId)`.

## Tests

`tests/sso-scim.test.ts` met een eigen OIDC-provider in het proces (`tests/fake-oidc.ts`: discovery, JWKS, authorize,
token-endpoint met PKCE-controle en RS256-ondertekende ID-tokens). Gedekt: volledige login tot `/api/me`, koppelen op
e-mail en daarna op (iss, sub), automatisch aanmaken (ook het maximum aantal gebruikers), eenmalige en
browsergebonden code, state-mismatch/ontbrekende cookie/replay, nonce/aud/iss/exp/handtekening, verkeerd domein,
`email_verified: false`, geen e-mail, onbekende gebruiker, geblokkeerde gebruiker (SSO, wachtwoord, token), SSO
verplichten (eigenaar niet), geen zelf geclaimde SSO-adressen (aanmelding en `PATCH /me`), client_secret_basic én
_post, rechten eigenaar/beheerder, discovery-test; SCIM-gebruikers: 401, aanmaken/lijst/filter/paging, PATCH (Entra-
en Okta-stijl), PUT, blokkeren (sessies weg, login geweigerd) en heractiveren, verwijderen-als-blokkeren en
terugzetten, verwijderen met data (alle modules geladen), eigenaar/beheerder onaantastbaar, foutformaat; het
clientgeheim en de SCIM-sleutel staan nergens in antwoorden, audit of log.

`tests/scim-groups.test.ts`: sleutel verplicht, Entra-`PATCH` (Add/Remove met lijst, Replace displayName, onbekende
leden genegeerd), Okta (`remove` met `members[value eq]`, `replace` van members, `replace` zonder path, `PUT`),
filters, `excludedAttributes`, paginering, discovery, foutformaat; koppeling naar beheerder, groepsgesprekken en
budget (en terug), beheerder mag geen beheerdersrol of gesprekken koppelen, eigenaar onaantastbaar, met de hand
ingestelde beheerder en budget blijven, blokkeren neemt rechten terug en heractiveren geeft ze weer, groep
verwijderen draait alles terug zonder data te wissen; zonder de module *Groepen & teams*; maximum aantal gebruikers
bij aanmaken en heractiveren; verwijdermodus ruimt lidmaatschap en budget op.
