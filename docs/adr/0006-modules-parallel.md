# ADR 0006 — Featuremodules met hooks in plaats van kernwijzigingen

**Status:** aangenomen (2026-11-06)

**Besluit.** De kern biedt extensiepunten: migraties, routes (`ctx.api`/`ctx.publicApi`), tools en dynamische
tool-providers, hooks (`systemPrompt` stabiel, `turnContext` per beurt bevroren, `route`, `afterRun`,
`messageCreated`, `agentDeleted`), diensten (`ctx.services`) en UI-extensiepunten. Modules wijzigen de kern alleen
klein en additief.

**Gevolgen.** Prompt-caching en "thinking"-replay blijven correct omdat de systeemprompt stabiel blijft en
per-beurt-context in het gebruikersbericht bevroren wordt. Modules zijn afzonderlijk te testen.
