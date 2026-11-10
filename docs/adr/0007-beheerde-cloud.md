# ADR 0007 — Beheerde cloud: control plane met Postgres, één geïsoleerde instantie per klant

**Status:** aangenomen (2026-11-06)

## Context

CLD-04 vraagt een optionele beheerde cloud: always-on bots, tenant-isolatie, billing en een statuspagina. Het plan
(§26) tekent "tenant-scoped Postgres", gescheiden control plane (accounts, billing, apparaatmetadata) en data plane
(prompts, bestanden, providersleutels, werkmappen). De hele TeamBot-server is gebouwd op één SQLite-database per
installatie, met werkmappen, browserprofielen en containers op schijf.

## Besluit

1. **Control plane** (`cloud/`): een aparte dienst met eigen Postgres-database voor cloudaccounts, workspaces
   (tenants), abonnementen, facturatie-events, instantiestatus, storingen en audit. Lokaal en in tests draait dezelfde
   SQL op PGlite (Postgres in WebAssembly); in productie op een echte Postgres via `pg`.
2. **Data plane: één ongewijzigde TeamBot-server (servermodus) per klant**, in een eigen container met een eigen
   versleuteld volume, eigen hoofdsleutel (`TEAMBOT_MASTER_KEY`, alleen in de control plane en de container), eigen
   netwerk en resource-limieten. Klantdata (gesprekken, geheugen, sleutels, werkmappen) staat nooit in de
   control-plane-database.
3. **Router**: een reverse proxy stuurt `<workspace>.<domein>` (HTTP en WebSocket) naar de juiste instantie. Alleen de
   router is publiek; instanties luisteren op een intern netwerk.
4. **Billing**: abonnement (hosting) staat los van modelkosten. Modelkosten lopen via de eigen sleutels van de klant
   (BYOK) of via gedeelde providers met de bestaande budgetten. Stripe (Checkout, Customer Portal, webhooks met
   handtekeningcontrole) is de eerste betaalprovider; zonder Stripe-sleutels draait de cloud in "handmatig"-modus.
   Niet betaald → na een respijtperiode wordt de instantie gepauzeerd (data blijft); opzeggen → export aangeboden,
   daarna verwijderen na de bewaartermijn.

## Waarom niet één gedeelde Postgres voor alle klantdata

- Isolatie op procesniveau (container, volume, sleutel) is sterker dan rijbeveiliging in één database: een fout in
  een query lekt dan nooit naar een andere klant.
- De volledige app (incl. tools die bestanden, browsers en containers beheren) zou anders herschreven moeten worden;
  dat geeft een tweede, minder geteste codebasis.
- Klanten kunnen exact dezelfde software ook zelf hosten en hun data 1-op-1 meenemen (export/back-up).
- Nadeel: meer geheugen per klant en upgrades per instantie. Opvang: kleine instanties, pauzeren bij inactiviteit,
  rollende upgrades per image-tag.

## Gevolgen

- Postgres voor tenantdata kan later alsnog (bijv. voor zeer grote teams), achter dezelfde storage-interface; dat
  besluit is omkeerbaar.
- Productie vereist: domein met wildcard-TLS, een host met Docker, een Postgres-database, Stripe-account; die staan als
  handmatige voorwaarden in `docs/STATUS.md`.
