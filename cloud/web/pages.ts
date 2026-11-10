import { html, raw, type Raw } from './html.js';
import type { Plan } from '../billing/plans.js';
import type { Subscription } from '../billing/service.js';
import type { ExportRow, Workspace } from '../workspaces.js';
import type { Incident, Maintenance, Uptime } from '../monitoring.js';
import type { CreditRow, CreditStatus, ReportRow, ReportResult } from '../reports.js';
import type { AlertSettings } from '../alerts.js';
import { formatBytes, formatDate } from '../util.js';

export type { Incident } from '../monitoring.js';

/** Server-rendered page bodies (Dutch). Every form carries the CSRF token. */

export const STATUS_LABEL: Record<string, [string, string]> = {
  provisioning: ['Wordt klaargezet', 'warn'],
  active: ['Actief', 'ok'],
  suspended: ['Gepauzeerd', 'bad'],
  deleting: ['Wordt verwijderd', 'warn'],
  deleted: ['Verwijderd', ''],
};

export const REASON_LABEL: Record<string, string> = {
  trial_ended: 'Proefperiode afgelopen',
  payment_failed: 'Betaling mislukt',
  canceled: 'Abonnement opgezegd',
  operator: 'Gepauzeerd door beheer',
};

export const SUB_LABEL: Record<string, string> = {
  trialing: 'Proefperiode',
  active: 'Actief',
  past_due: 'Betaling achterstallig',
  unpaid: 'Onbetaald',
  paused: 'Gepauzeerd',
  canceled: 'Opgezegd',
  incomplete: 'Nog niet afgerond',
};

const HEALTH_LABEL: Record<string, [string, string]> = { healthy: ['Werkt', 'ok'], unhealthy: ['Reageert niet', 'bad'], unknown: ['Nog niet gecontroleerd', ''] };

const csrfInput = (csrf: string) => html`<input type="hidden" name="_csrf" value="${csrf}">`;
const badge = ([text, kind]: [string, string]) => html`<span class="badge ${kind}">${text}</span>`;
const pct = (n: number) => `${n.toFixed(n >= 99.95 || n === 0 ? 0 : 2).replace('.', ',')}%`;
const isDedicated = (ws: Pick<Workspace, 'deployment'>) => ws.deployment === 'dedicated';

export const BYOK_NOTE = html`<p class="callout small"><strong>Modelkosten zitten er niet in.</strong> Je bots gebruiken je eigen API-sleutels (of je eigen abonnement via een CLI-agent). Die provider factureert je rechtstreeks; TeamBot Cloud rekent alleen de hosting.</p>`;

export interface Ctx {
  csrf: string;
  tz: string;
  domain: string;
  url: string;
}

/** Row of small day bars (status page, uptime of one workspace). */
function dayBars(days: { day: string; pct: number | null; incidents?: number }[]): Raw {
  return html`<div class="days" role="list">${days.map((d) => {
    const label = `${d.day}: ${d.pct === null ? 'geen metingen' : pct(d.pct)}${d.incidents ? `, ${d.incidents} storing(en)` : ''}`;
    const cls = d.pct === null ? '' : d.pct >= 99.5 && !d.incidents ? 'ok' : d.pct >= 95 ? 'warn' : 'bad';
    return html`<span role="listitem" class="day ${cls}" title="${label}"><span class="sr">${label}</span></span>`;
  })}</div>`;
}

function maintenanceList(c: Ctx, items: Maintenance[], o: { cancel?: boolean } = {}): Raw {
  return html`<ul class="clean">${items.map(
    (m) => html`<li><strong>${m.title}</strong> · ${formatDate(m.starts_at, c.tz, true)} – ${formatDate(m.ends_at, c.tz, true)}
      ${m.excluded ? '' : html` <span class="badge warn">kort van tevoren: telt mee als uitval</span>`}
      ${m.body ? html`<br><span class="small muted">${m.body}</span>` : ''}
      ${o.cancel ? html`<form method="post" action="/operator/maintenance/${m.id}/cancel" class="row" style="margin-top:4px">${csrfInput(c.csrf)}<button type="submit">Annuleren</button></form>` : ''}</li>`,
  )}</ul>`;
}

export function homePage(plans: Plan[], signedIn: boolean, domain: string): Raw {
  return html`
  <section class="hero">
    <h1>Je eigen TeamBot, altijd aan</h1>
    <p>Wij draaien de server, jij houdt de regie. Elke workspace is een eigen, afgeschermde TeamBot op <strong>jouwnaam.${domain}</strong>, met eigen opslag en een eigen sleutel.</p>
    <p class="row">${signedIn ? html`<a class="btn primary" href="/dashboard">Naar je dashboard</a>` : html`<a class="btn primary" href="/signup">Gratis proberen</a><a class="btn" href="/login">Inloggen</a>`}</p>
  </section>
  <h2 id="prijzen">Abonnementen</h2>
  <div class="grid">
    ${plans.map(
      (p) => html`<article class="card">
        <h3>${p.name}</h3>
        <p class="price">${p.price}</p>
        <p class="muted small">${p.description}</p>
        ${p.deployment === 'dedicated'
          ? html`<ul class="clean small">
              <li>Tot ${p.seats} mensen</li>
              <li>Op je eigen server of in je eigen VPC</li>
              <li>Bewaking, support en updates</li>
              <li>Op factuur; neem contact met ons op</li>
            </ul>`
          : html`<ul class="clean small">
              <li>Tot ${p.seats} mensen</li>
              <li>${p.storageGb} GB opslag</li>
              <li>${p.memoryMb >= 1024 ? `${p.memoryMb / 1024} GB` : `${p.memoryMb} MB`} geheugen, ${String(p.cpus).replace('.', ',')} CPU</li>
            </ul>`}
      </article>`,
    )}
  </div>
  ${BYOK_NOTE}
  <p class="small muted">Je begint altijd met een proefperiode, zonder betaalgegevens. Stoppen kan wanneer je wilt; je krijgt dan een export van al je gegevens. Beschikbaarheid en support staan in onze <a href="/status">statuspagina</a> en de SLA.</p>`;
}

export function signupPage(c: Ctx, v: { email?: string; name?: string }, error?: string, closed = false): Raw {
  if (closed) return html`<div class="card"><h1>Account maken</h1><p>Aanmelden is op dit moment gesloten.</p></div>`;
  return html`<div class="card">
    <h1>Account maken</h1>
    <p class="muted">Daarna maak je je eerste workspace: een eigen TeamBot met 14 dagen proef.</p>
    ${error ? html`<div class="flash error" role="alert" id="fout">${error}</div>` : ''}
    <form method="post" action="/signup" novalidate>
      ${csrfInput(c.csrf)}
      <label for="name">Naam <span class="muted small">(optioneel)</span></label>
      <input id="name" name="name" autocomplete="name" maxlength="80" value="${v.name || ''}">
      <label for="email">E-mailadres</label>
      <input id="email" name="email" type="email" autocomplete="email" required maxlength="254" value="${v.email || ''}" ${error ? raw('aria-describedby="fout"') : ''}>
      <label for="password">Wachtwoord</label>
      <input id="password" name="password" type="password" autocomplete="new-password" required minlength="10" aria-describedby="pw-hint">
      <p class="hint" id="pw-hint">Minstens 10 tekens.</p>
      <p class="row" style="margin-top:16px"><button class="primary" type="submit">Account maken</button><a href="/login">Ik heb al een account</a></p>
    </form>
  </div>`;
}

export function loginPage(c: Ctx, v: { email?: string }, error?: string): Raw {
  return html`<div class="card">
    <h1>Inloggen</h1>
    ${error ? html`<div class="flash error" role="alert" id="fout">${error}</div>` : ''}
    <form method="post" action="/login" novalidate>
      ${csrfInput(c.csrf)}
      <label for="email">E-mailadres</label>
      <input id="email" name="email" type="email" autocomplete="email" required value="${v.email || ''}" ${error ? raw('aria-describedby="fout"') : ''}>
      <label for="password">Wachtwoord</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <p class="row" style="margin-top:16px"><button class="primary" type="submit">Inloggen</button><a href="/signup">Account maken</a></p>
    </form>
  </div>`;
}

export interface WorkspaceView {
  ws: Workspace;
  sub: Subscription | null;
  /** "Openen": our subdomain (shared) or the customer's own address (dedicated). */
  url: string;
  plan: Plan;
}

function claimForm(c: Ctx, ws: Workspace) {
  return html`<form method="post" action="/workspaces/${ws.id}/claim">${csrfInput(c.csrf)}<button class="primary" type="submit">Eigenaar-account aanmaken</button></form>`;
}

function statusLine(c: Ctx, v: WorkspaceView) {
  const { ws, sub } = v;
  return html`${isDedicated(ws) ? html`${badge(['Dedicated', ''])} ` : ''}${badge(STATUS_LABEL[ws.status] || [ws.status, ''])}
    ${ws.status === 'suspended' && ws.status_reason ? html` <span class="small muted">${REASON_LABEL[ws.status_reason] || ws.status_reason}${isDedicated(ws) ? ' · licentie en support' : ''}</span>` : ''}
    ${sub?.status === 'trialing' && ws.trial_ends_at && ws.status === 'active' ? html` <span class="small muted">Proef tot ${formatDate(ws.trial_ends_at, c.tz)}</span>` : ''}`;
}

/** Can the customer open their TeamBot right now? Dedicated servers keep running when the licence is paused. */
const canOpen = (ws: Workspace) => (isDedicated(ws) ? !!ws.external_url && ws.status !== 'deleting' : ws.status === 'active');

export function dashboardPage(c: Ctx, items: WorkspaceView[], o: { needsVerify: boolean; canCreate: boolean }): Raw {
  return html`
  <div class="row page-head"><h1>Je workspaces</h1>${o.canCreate && !o.needsVerify ? html`<a class="btn primary" href="/workspaces/new">Nieuwe workspace</a>` : ''}</div>
  ${o.needsVerify
    ? html`<div class="card"><p><strong>Bevestig eerst je e-mailadres.</strong> We hebben je een link gestuurd.</p>
        <form method="post" action="/verify/resend">${csrfInput(c.csrf)}<button type="submit">Stuur de link opnieuw</button></form></div>`
    : ''}
  ${!items.length && !o.needsVerify
    ? html`<div class="card"><h2>Nog geen workspace</h2><p>Een workspace is je eigen TeamBot, altijd online. Je begint met een gratis proefperiode.</p><a class="btn primary" href="/workspaces/new">Maak je eerste workspace</a></div>`
    : ''}
  ${items.map(
    (v) => html`<article class="card" aria-labelledby="ws-${v.ws.id}">
      <div class="row" style="justify-content:space-between"><h2 id="ws-${v.ws.id}">${v.ws.name}</h2><span>${statusLine(c, v)}</span></div>
      <p class="small">${v.url ? html`<a href="${v.url}">${v.url.replace(/^https?:\/\//, '')}</a> · ` : ''}${v.plan.name}${v.ws.status === 'active' ? html` · ${badge(HEALTH_LABEL[v.ws.health] || HEALTH_LABEL.unknown)}` : ''}</p>
      ${isDedicated(v.ws) ? html`<p class="small muted">Draait op je eigen server. Wij bewaken de bereikbaarheid en leveren support en updates.</p>` : ''}
      ${v.ws.status === 'provisioning'
        ? v.ws.status_reason
          ? html`<p class="flash error" role="alert">${v.ws.status_reason}</p><form method="post" action="/workspaces/${v.ws.id}/retry">${csrfInput(c.csrf)}<button type="submit">Opnieuw proberen</button></form>`
          : html`<p class="muted" role="status">Je TeamBot wordt klaargezet. Deze pagina ververst vanzelf.</p>`
        : ''}
      ${v.ws.status === 'active' && !v.ws.owner_claimed && !isDedicated(v.ws)
        ? html`<div class="callout"><p><strong>Nog één stap:</strong> maak het eigenaar-account van je TeamBot aan. Alleen jij kunt dat, via deze knop.</p>${claimForm(c, v.ws)}</div>`
        : ''}
      ${v.ws.status === 'suspended' && v.ws.delete_after
        ? html`<p class="small">We verwijderen deze workspace op <strong>${formatDate(v.ws.delete_after, c.tz)}</strong>. ${isDedicated(v.ws) ? 'Je eigen server en data blijven staan.' : 'Download vóór die datum je export.'}</p>`
        : ''}
      <div class="row">
        ${canOpen(v.ws) ? html`<a class="btn primary" href="${v.url}">Openen</a>` : ''}
        <a class="btn" href="/workspaces/${v.ws.id}#abonnement">Abonnement beheren</a>
        <a class="btn" href="/workspaces/${v.ws.id}#beschikbaarheid">Beschikbaarheid</a>
        <a class="btn" href="/workspaces/${v.ws.id}#export">Exporteren</a>
        <a class="btn danger" href="/workspaces/${v.ws.id}#verwijderen">Verwijderen</a>
      </div>
    </article>`,
  )}
  ${BYOK_NOTE}`;
}

export function newWorkspacePage(c: Ctx, v: { name?: string; slug?: string }, error?: string): Raw {
  return html`<div class="card">
    <h1>Nieuwe workspace</h1>
    <p class="muted">Je krijgt een eigen TeamBot met een gratis proefperiode. Daarna kies je een abonnement. Een eigen server of VPC (Dedicated) regelen we samen met je; neem daarvoor contact op.</p>
    ${error ? html`<div class="flash error" role="alert" id="fout">${error}</div>` : ''}
    <form method="post" action="/workspaces" novalidate>
      ${csrfInput(c.csrf)}
      <label for="name">Naam</label>
      <input id="name" name="name" required maxlength="60" value="${v.name || ''}" placeholder="Bijvoorbeeld: Team Zuid">
      <label for="slug">Adres</label>
      <input id="slug" name="slug" required minlength="3" maxlength="30" pattern="[a-z0-9-]{3,30}" value="${v.slug || ''}" aria-describedby="slug-hint${error ? ' fout' : ''}" autocapitalize="none" spellcheck="false">
      <p class="hint" id="slug-hint">Kleine letters, cijfers en streepjes, 3 tot 30 tekens. Je TeamBot komt op <strong>adres.${c.domain}</strong>. Een adres kun je later niet wijzigen.</p>
      <p class="row" style="margin-top:16px"><button class="primary" type="submit">Workspace maken</button><a href="/dashboard">Annuleren</a></p>
    </form>
  </div>`;
}

export interface Availability {
  uptime30: Uptime;
  uptime90: Uptime;
  incidents: Incident[];
  maintenance: Maintenance[];
}

function availabilitySection(c: Ctx, ws: Workspace, a: Availability): Raw {
  return html`<section class="card" aria-labelledby="beschikbaarheid-titel" id="beschikbaarheid">
    <h2 id="beschikbaarheid-titel">Beschikbaarheid</h2>
    <p class="small muted">${isDedicated(ws)
      ? 'We controleren regelmatig van buitenaf of je TeamBot antwoordt (/healthz). Aangekondigd onderhoud telt niet mee.'
      : 'We controleren regelmatig of je TeamBot antwoordt. Aangekondigd onderhoud telt niet mee.'}</p>
    <dl class="facts">
      <dt>Laatste 30 dagen</dt><dd>${a.uptime30.pct === null ? 'nog geen metingen' : html`<strong>${pct(a.uptime30.pct)}</strong> <span class="small muted">(${a.uptime30.ok} van ${a.uptime30.checks} controles)</span>`}</dd>
      <dt>Laatste 90 dagen</dt><dd>${a.uptime90.pct === null ? 'nog geen metingen' : html`<strong>${pct(a.uptime90.pct)}</strong> <span class="small muted">(${a.uptime90.ok} van ${a.uptime90.checks} controles)</span>`}</dd>
      ${ws.health === 'unhealthy' && ws.health_detail ? html`<dt>Laatste controle</dt><dd>${ws.health_detail}</dd>` : ''}
    </dl>
    ${dayBars(a.uptime30.daily)}
    ${a.maintenance.length ? html`<h3>Gepland onderhoud</h3>${maintenanceList(c, a.maintenance)}` : ''}
    <h3>Storingen (90 dagen)</h3>
    ${a.incidents.length
      ? html`<ul class="clean">${a.incidents.map(
          (i) => html`<li>${badge(i.status === 'open' ? ['Lopend', 'bad'] : ['Opgelost', 'ok'])} <strong>${i.title}</strong> · ${formatDate(i.created_at, c.tz, true)}${i.resolved_at ? ` – ${formatDate(i.resolved_at, c.tz, true)}` : ''}<br><span class="small muted">${i.body}</span></li>`,
        )}</ul>`
      : html`<p class="small muted">Geen storingen.</p>`}
  </section>`;
}

export function workspacePage(
  c: Ctx,
  v: WorkspaceView,
  o: { exports: ExportRow[]; plans: Plan[]; mode: 'stripe' | 'manual'; storageLimitGb: number; availability: Availability; stripePrices: Record<string, string>; reports: (ReportRow & { credit_status: CreditStatus | null })[] },
): Raw {
  const { ws, sub } = v;
  const dedicated = isDedicated(ws);
  const canceled = sub?.status === 'canceled';
  const hasStripeSub = sub?.provider === 'stripe' && !!sub.external_subscription_id && !canceled;
  const choosable = o.plans.filter((p) => p.paid && (p.deployment === 'dedicated') === dedicated && (!dedicated || !!o.stripePrices[p.id]));
  return html`
  <p class="small"><a href="/dashboard">← Je workspaces</a></p>
  <h1>${ws.name}</h1>
  <section class="card" aria-labelledby="overzicht">
    <h2 id="overzicht">Overzicht</h2>
    <p>${statusLine(c, v)}</p>
    <dl class="facts">
      <dt>Adres</dt><dd>${v.url ? html`<a href="${v.url}">${v.url.replace(/^https?:\/\//, '')}</a>` : '—'}</dd>
      <dt>Type</dt><dd>${dedicated ? 'Dedicated: draait op je eigen server' : 'Beheerd door TeamBot Cloud'}</dd>
      <dt>Abonnement</dt><dd>${v.plan.name}${sub ? html` · ${SUB_LABEL[sub.status] || sub.status}` : ''} · tot ${v.plan.seats} mensen</dd>
      ${ws.status === 'active' ? html`<dt>Werkt het?</dt><dd>${badge(HEALTH_LABEL[ws.health] || HEALTH_LABEL.unknown)}${ws.health_checked_at ? html` <span class="small muted">gecontroleerd ${formatDate(ws.health_checked_at, c.tz, true)}</span>` : ''}</dd>` : ''}
      ${dedicated ? '' : html`<dt>Opslag</dt><dd>${ws.storage_bytes === null ? 'nog niet gemeten' : formatBytes(Number(ws.storage_bytes))} (abonnement: ${o.storageLimitGb} GB)</dd>`}
      <dt>Aangemaakt</dt><dd>${formatDate(ws.created_at, c.tz)}</dd>
    </dl>
    ${dedicated && ws.status === 'suspended'
      ? html`<p class="flash error" role="alert">Je licentie en support zijn gepauzeerd. Je eigen server draait gewoon door (die stoppen wij niet), maar valt nu buiten support, updates en de SLA. Neem contact met ons op om dit op te lossen.</p>`
      : ''}
    <div class="row">
      ${canOpen(ws) ? html`<a class="btn primary" href="${v.url}">Openen</a>` : ''}
      ${ws.status === 'provisioning' && ws.status_reason ? html`<form method="post" action="/workspaces/${ws.id}/retry">${csrfInput(c.csrf)}<button type="submit">Opnieuw proberen</button></form>` : ''}
    </div>
  </section>

  ${dedicated
    ? html`<section class="card" aria-labelledby="eigenaar">
      <h2 id="eigenaar">Eigenaar-account</h2>
      <p>Je maakt het eigenaar-account aan op je eigen server: open eenmalig <code>${ws.external_url || 'https://jouw-adres'}/?setup=&lt;TEAMBOT_SETUP_TOKEN&gt;</code>. Die token kreeg je van ons bij de installatie (deployment-kit, <code>.env</code>). Zonder token kan niemand het eerste account aanmaken.</p>
    </section>`
    : ws.status === 'active'
      ? html`<section class="card" aria-labelledby="eigenaar">
      <h2 id="eigenaar">Eigenaar-account</h2>
      ${ws.owner_claimed
        ? html`<p>Het eigenaar-account van je TeamBot is aangemaakt. Log in op je TeamBot met dat account; teamleden nodig je daarna uit vanuit TeamBot zelf.</p>`
        : html`<p>Je TeamBot is klaar. Maak nu het eigenaar-account aan: je opent je TeamBot met een eenmalige link (30 minuten geldig) en kiest daar je naam, e-mailadres en wachtwoord. Niemand anders kan dit account aanmaken.</p>${claimForm(c, ws)}`}
    </section>`
      : ''}

  ${availabilitySection(c, ws, o.availability)}
  ${reportsSection(c, ws, o.reports)}

  <section class="card" aria-labelledby="abonnement-titel" id="abonnement">
    <h2 id="abonnement-titel">Abonnement</h2>
    ${canceled
      ? html`<p>Je abonnement is opgezegd${sub?.canceled_at ? html` op ${formatDate(sub.canceled_at, c.tz)}` : ''}. ${ws.delete_after
        ? dedicated
          ? html`We beëindigen registratie, bewaking en support op <strong>${formatDate(ws.delete_after, c.tz)}</strong>. Je eigen server en data blijven staan.`
          : html`We verwijderen alles op <strong>${formatDate(ws.delete_after, c.tz)}</strong>. Download vóór die datum je export.`
        : ''}</p>`
      : ''}
    ${sub?.status === 'past_due' || sub?.status === 'unpaid'
      ? html`<p class="flash error" role="alert">Je laatste betaling is mislukt. Werk je betaalgegevens bij; anders pauzeren we ${dedicated ? 'je licentie en support' : 'je TeamBot'} na de respijtperiode. Je gegevens blijven bewaard.</p>`
      : ''}
    ${o.mode === 'stripe' && (hasStripeSub || choosable.length)
      ? hasStripeSub
        ? html`<p>Wijzig je abonnement, betaalmethode of facturen bij Stripe.</p><form method="post" action="/workspaces/${ws.id}/portal">${csrfInput(c.csrf)}<button class="primary" type="submit">Abonnement beheren</button></form>`
        : ws.status === 'deleting' || ws.status === 'deleted'
          ? ''
          : html`<p>${dedicated ? 'Je kunt je dedicated abonnement ook online betalen.' : 'Kies een abonnement.'} Je rekent veilig af bij Stripe.</p>
            <div class="grid">${choosable.map(
              (p) => html`<form class="card" method="post" action="/workspaces/${ws.id}/checkout">${csrfInput(c.csrf)}<input type="hidden" name="plan" value="${p.id}">
                <h3>${p.name}</h3><p class="price">${p.price}</p><p class="small muted">Tot ${p.seats} mensen${p.deployment === 'dedicated' ? '' : ` · ${p.storageGb} GB`}</p><button class="primary" type="submit">Kies ${p.name}</button></form>`,
            )}</div>`
      : dedicated
        ? html`<p>Dedicated betaal je op factuur volgens je contract. Vragen over je factuur of contract stel je aan ons team.</p>`
        : html`<p>Betalen gaat (nog) niet online. De beheerder zet je abonnement voor je klaar; neem contact op om het te wijzigen of op te zeggen.</p>`}
    ${BYOK_NOTE}
  </section>

  <section class="card" aria-labelledby="export-titel" id="export">
    <h2 id="export-titel">Exporteren</h2>
    ${dedicated
      ? html`<p>Je dedicated TeamBot en al je data staan op je eigen server; wij hebben er geen kopie van. Exporteren en back-ups doe je daar zelf: in TeamBot via Instellingen → Gegevens → Back-ups, of met het back-upscript uit de deployment-kit (<code>deploy/dedicated/backup.sh</code>). Test regelmatig of terugzetten lukt.</p>`
      : html`<p>Een export bevat je hele TeamBot: database (bots, gesprekken, geheugen, routines), bijlagen, werkmappen en de sleutel van je opgeslagen API-sleutels. Daarmee kun je TeamBot ook zelf verder draaien. Een export blijft 7 dagen te downloaden.</p>
        ${ws.status === 'active' || ws.status === 'suspended'
          ? html`<form method="post" action="/workspaces/${ws.id}/export">${csrfInput(c.csrf)}<button type="submit">Export maken</button></form>`
          : html`<p class="muted">Exporteren kan zodra je workspace draait of gepauzeerd is.</p>`}
        ${o.exports.length
          ? html`<h3>Klaar om te downloaden</h3><ul class="clean">${o.exports.map(
              (e) => html`<li><a href="/workspaces/${ws.id}/exports/${e.id}" download>${e.file}</a> <span class="small muted">${formatBytes(Number(e.size_bytes))} · tot ${formatDate(e.expires_at, c.tz, true)}</span></li>`,
            )}</ul>`
          : ''}`}
  </section>

  <section class="card" aria-labelledby="verwijderen-titel" id="verwijderen">
    <h2 id="verwijderen-titel">Verwijderen</h2>
    ${dedicated
      ? html`<p>Dit beëindigt de registratie, bewaking en support van je dedicated omgeving bij ons. Een lopend online abonnement zeggen we direct op. <strong>Je eigen server en de data daarop blijven staan</strong>; die verwijder je zelf (zie de deployment-kit).</p>`
      : html`<p>Dit stopt je TeamBot en wist alle gegevens: gesprekken, bots, bestanden en sleutels. Dit kun je niet ongedaan maken. Een lopend abonnement zeggen we direct op. Maak eerst een export als je iets wilt bewaren.</p>`}
    <form method="post" action="/workspaces/${ws.id}/delete">
      ${csrfInput(c.csrf)}
      <label for="confirm">Typ <strong>${ws.slug}</strong> om te bevestigen</label>
      <input id="confirm" name="confirm" autocomplete="off" autocapitalize="none" spellcheck="false" required>
      <p style="margin-top:12px"><button class="danger" type="submit">Definitief verwijderen</button></p>
    </form>
  </section>`;
}

export function messagePage(title: string, text: string, link?: { href: string; label: string }): Raw {
  return html`<div class="card"><h1>${title}</h1><p>${text}</p>${link ? html`<p><a class="btn" href="${link.href}">${link.label}</a></p>` : ''}</div>`;
}

// ---------- operator ----------

export type OperatorRow = Workspace & { owner_email: string; sub_status: string | null; sub_provider: string | null };

export function operatorPage(
  c: Ctx,
  rows: OperatorRow[],
  incidents: Incident[],
  o: {
    plans: Plan[];
    mode: 'stripe' | 'manual';
    uptime30: Map<string, number | null>;
    workspaceIncidents: (Incident & { slug: string })[];
    maintenance: Maintenance[];
    noticeHours: number;
    nowLocal: string;
  },
): Raw {
  const live = rows.filter((r) => r.status !== 'deleted');
  const count = (f: (r: Workspace) => boolean) => live.filter(f).length;
  const slugOf = new Map(rows.map((r) => [r.id, r.slug]));
  return html`
  <h1>Beheer</h1>
  <p class="muted">Je ziet hier alleen gegevens van de control plane. De inhoud van workspaces (gesprekken, bestanden, sleutels) is niet zichtbaar voor beheer.</p>
  <div class="grid stats">
    <div class="card"><h2>${count((r) => r.status === 'active' && r.health === 'healthy')}</h2><p class="muted">actief en gezond</p></div>
    <div class="card"><h2>${count((r) => r.status === 'active' && r.health !== 'healthy')}</h2><p class="muted">actief, reageert niet of onbekend</p></div>
    <div class="card"><h2>${count((r) => r.status === 'suspended')}</h2><p class="muted">gepauzeerd</p></div>
    <div class="card"><h2>${count((r) => r.deployment === 'dedicated')}</h2><p class="muted">dedicated</p></div>
  </div>
  ${o.workspaceIncidents.length
    ? html`<section class="card" aria-labelledby="ws-inc"><h2 id="ws-inc">Lopende storingen per workspace</h2><ul class="clean">${o.workspaceIncidents.map(
        (i) => html`<li>${badge(['Lopend', 'bad'])} <a href="/operator/workspaces/${i.workspace_id}">${i.slug}</a>: ${i.title} · sinds ${formatDate(i.created_at, c.tz, true)}${i.auto ? ' (automatisch)' : ''}</li>`,
      )}</ul></section>`
    : ''}
  <section class="card" aria-labelledby="ws-titel">
    <h2 id="ws-titel">Workspaces</h2>
    <p class="small muted">Betaalmodus: ${o.mode === 'stripe' ? 'Stripe' : 'handmatig (jij zet abonnement en status)'} · <a href="/operator/reports">SLA-rapporten</a> · <a href="/operator/audit">Auditlog</a></p>
    <div class="table-wrap"><table>
      <thead><tr><th scope="col">Workspace</th><th scope="col">Eigenaar</th><th scope="col">Status</th><th scope="col">Gezondheid</th><th scope="col">Abonnement</th><th scope="col">Acties</th></tr></thead>
      <tbody>${rows.map((r) => {
        const up = o.uptime30.get(r.id);
        return html`<tr>
          <td><a href="/operator/workspaces/${r.id}"><strong>${r.slug}</strong></a><br><span class="small muted">${r.name}${r.deployment === 'dedicated' ? ' · dedicated' : ''}</span></td>
          <td class="small">${r.owner_email}</td>
          <td>${badge(STATUS_LABEL[r.status] || [r.status, ''])}${r.status_reason ? html`<br><span class="small muted">${REASON_LABEL[r.status_reason] || r.status_reason}</span>` : ''}</td>
          <td>${r.status === 'active' ? badge(HEALTH_LABEL[r.health] || HEALTH_LABEL.unknown) : '—'}<br><span class="small muted">30 d: ${up === null || up === undefined ? '—' : pct(up)}${r.deployment === 'dedicated' ? '' : ` · ${formatBytes(r.storage_bytes === null ? null : Number(r.storage_bytes))}`}</span></td>
          <td class="small">${o.plans.find((p) => p.id === r.plan)?.name || r.plan} · ${SUB_LABEL[r.sub_status || ''] || r.sub_status || '—'}${r.sub_provider === 'stripe' ? ' (Stripe)' : ''}</td>
          <td>${r.status === 'deleted'
            ? html`<span class="small muted">${formatDate(r.deleted_at, c.tz)}</span>`
            : html`<div class="row">
              ${r.status === 'active' ? html`<form method="post" action="/operator/workspaces/${r.id}/suspend">${csrfInput(c.csrf)}<button type="submit">Pauzeren</button></form>` : ''}
              ${r.status === 'suspended' ? html`<form method="post" action="/operator/workspaces/${r.id}/resume">${csrfInput(c.csrf)}<button type="submit">Hervatten</button></form>` : ''}
              </div>
              ${r.sub_provider === 'manual'
                ? html`<form method="post" action="/operator/workspaces/${r.id}/billing" class="row" style="margin-top:6px">${csrfInput(c.csrf)}
                  <label class="sr" for="plan-${r.id}">Abonnement voor ${r.slug}</label>
                  <select id="plan-${r.id}" name="plan">${o.plans
                    .filter((p) => (p.deployment === 'dedicated') === (r.deployment === 'dedicated'))
                    .map((p) => html`<option value="${p.id}" ${p.id === r.plan ? raw('selected') : ''}>${p.name}</option>`)}</select>
                  <label class="sr" for="st-${r.id}">Status voor ${r.slug}</label>
                  <select id="st-${r.id}" name="status">${['trialing', 'active', 'past_due', 'canceled'].map((s) => html`<option value="${s}" ${s === r.sub_status ? raw('selected') : ''}>${SUB_LABEL[s]}</option>`)}</select>
                  <button type="submit">Opslaan</button></form>`
                : ''}`}</td>
        </tr>`;
      })}</tbody>
    </table></div>
  </section>

  <section class="card" aria-labelledby="ded-titel">
    <h2 id="ded-titel">Dedicated omgeving registreren</h2>
    <p class="small muted">De klant draait de standaard TeamBot-image in de eigen VPC (deployment-kit <code>deploy/dedicated/</code>). Wij starten daar niets; we bewaken het adres en tonen het in het dashboard van de klant. De klant maakt eerst zelf een account op deze site.</p>
    <form method="post" action="/operator/dedicated">
      ${csrfInput(c.csrf)}
      <label for="ded-email">E-mailadres van de klant (bestaand account)</label><input id="ded-email" name="email" type="email" required>
      <label for="ded-name">Naam</label><input id="ded-name" name="name" required maxlength="60">
      <label for="ded-slug">Korte naam</label><input id="ded-slug" name="slug" required minlength="3" maxlength="30" aria-describedby="ded-slug-hint">
      <p class="hint" id="ded-slug-hint">Kleine letters, cijfers en streepjes; alleen intern gebruikt.</p>
      <label for="ded-url">Adres van hun TeamBot</label><input id="ded-url" name="url" type="url" required placeholder="https://teambot.klant.nl" aria-describedby="ded-url-hint">
      <p class="hint" id="ded-url-hint">Alleen https en een publiek adres. Wij controleren <code>/healthz</code> van buitenaf.</p>
      <p style="margin-top:12px"><button class="primary" type="submit">Registreren</button></p>
    </form>
  </section>

  <section class="card" aria-labelledby="mnt-titel">
    <h2 id="mnt-titel">Onderhoud aankondigen</h2>
    <p class="small muted">Verschijnt op de statuspagina (hele platform) of in het dashboard van die ene workspace. Minstens ${o.noticeHours} uur van tevoren aangekondigd onderhoud telt niet mee voor de beschikbaarheid; korter van tevoren telt wel mee. Tijden in ${c.tz}.</p>
    <form method="post" action="/operator/maintenance">
      ${csrfInput(c.csrf)}
      <label for="mnt-title">Titel</label><input id="mnt-title" name="title" required maxlength="120" placeholder="Bijvoorbeeld: update naar TeamBot 0.3">
      <label for="mnt-body">Wat merken klanten?</label><textarea id="mnt-body" name="body" maxlength="2000"></textarea>
      <label for="mnt-start">Begin</label><input id="mnt-start" name="starts" type="datetime-local" required min="${o.nowLocal}">
      <label for="mnt-end">Einde</label><input id="mnt-end" name="ends" type="datetime-local" required min="${o.nowLocal}">
      <label for="mnt-ws">Voor</label>
      <select id="mnt-ws" name="workspace"><option value="">Hele platform</option>${live.map((r) => html`<option value="${r.id}">${r.slug}</option>`)}</select>
      <p style="margin-top:12px"><button class="primary" type="submit">Onderhoud aankondigen</button></p>
    </form>
    ${o.maintenance.length
      ? html`<h3>Gepland en bezig</h3>${maintenanceList(
          c,
          o.maintenance.map((m) => ({ ...m, title: m.workspace_id ? `${m.title} (${slugOf.get(m.workspace_id) || 'workspace'})` : m.title })),
          { cancel: true },
        )}`
      : ''}
  </section>

  <section class="card" aria-labelledby="inc-titel">
    <h2 id="inc-titel">Storingen (platform)</h2>
    <form method="post" action="/operator/incidents">
      ${csrfInput(c.csrf)}
      <label for="inc-title">Titel</label><input id="inc-title" name="title" required maxlength="120">
      <label for="inc-body">Wat merken klanten?</label><textarea id="inc-body" name="body" maxlength="2000"></textarea>
      <label for="inc-impact">Ernst</label><select id="inc-impact" name="impact"><option value="minor">Verstoring</option><option value="major">Storing</option></select>
      <p style="margin-top:12px"><button class="primary" type="submit">Storing melden</button></p>
    </form>
    ${incidents
      .filter((i) => i.status === 'open')
      .map(
        (i) => html`<article class="card"><h3>${i.title} ${badge(i.impact === 'major' ? ['Storing', 'bad'] : ['Verstoring', 'warn'])}</h3><p>${i.body}</p>
          ${i.updates.map((u) => html`<p class="small"><span class="muted">${formatDate(u.at, c.tz, true)}:</span> ${u.text}</p>`)}
          <form method="post" action="/operator/incidents/${i.id}/update">${csrfInput(c.csrf)}<label for="upd-${i.id}">Update</label><input id="upd-${i.id}" name="text" required maxlength="1000"><p class="row" style="margin-top:8px"><button type="submit">Update plaatsen</button></p></form>
          <form method="post" action="/operator/incidents/${i.id}/resolve">${csrfInput(c.csrf)}<button type="submit">Opgelost</button></form></article>`,
      )}
  </section>`;
}

/** One workspace in the operator console: control-plane data, uptime and (for dedicated) address and setup token. */
export function operatorWorkspacePage(c: Ctx, r: OperatorRow, a: Availability, plan: Plan): Raw {
  const dedicated = isDedicated(r);
  return html`<p class="small"><a href="/operator">← Beheer</a></p>
  <h1>${r.name} <span class="muted small">${r.slug}</span></h1>
  <section class="card">
    <dl class="facts">
      <dt>Type</dt><dd>${dedicated ? 'Dedicated (draait bij de klant)' : 'Gedeeld (wij draaien de instantie)'}</dd>
      <dt>Eigenaar</dt><dd>${r.owner_email}</dd>
      <dt>Status</dt><dd>${badge(STATUS_LABEL[r.status] || [r.status, ''])}${r.status_reason ? ` ${REASON_LABEL[r.status_reason] || r.status_reason}` : ''}</dd>
      <dt>Abonnement</dt><dd>${plan.name} · ${SUB_LABEL[r.sub_status || ''] || r.sub_status || '—'}${r.sub_provider === 'stripe' ? ' (Stripe)' : ' (handmatig / op factuur)'} · tot ${plan.seats} mensen</dd>
      ${dedicated ? html`<dt>Adres</dt><dd>${r.external_url ? html`<a href="${r.external_url}">${r.external_url}</a>` : '—'}</dd>` : ''}
      <dt>Laatste controle</dt><dd>${badge(HEALTH_LABEL[r.health] || HEALTH_LABEL.unknown)} ${r.health_checked_at ? formatDate(r.health_checked_at, c.tz, true) : ''}${r.health_detail ? ` · ${r.health_detail}` : ''}</dd>
    </dl>
  </section>
  ${dedicated && r.status !== 'deleted'
    ? html`<section class="card" aria-labelledby="ded-beheer">
      <h2 id="ded-beheer">Dedicated</h2>
      <form method="post" action="/operator/workspaces/${r.id}/url">
        ${csrfInput(c.csrf)}
        <label for="url">Adres wijzigen</label><input id="url" name="url" type="url" required value="${r.external_url || ''}">
        <p style="margin-top:8px"><button type="submit">Adres opslaan</button></p>
      </form>
      <p class="small muted">Setup-token kwijt voordat de klant het eigenaar-account aanmaakte? Maak een nieuwe; de oude werkt dan niet meer zodra de klant de nieuwe in <code>.env</code> zet en TeamBot herstart.</p>
      <form method="post" action="/operator/workspaces/${r.id}/setup-token">${csrfInput(c.csrf)}<button type="submit">Nieuwe setup-token maken</button></form>
    </section>`
    : ''}
  ${availabilitySection(c, r, a)}`;
}

/** Shown exactly once after registering a dedicated workspace or rotating its setup token. */
export function dedicatedSecretsPage(c: Ctx, ws: Workspace, setupToken: string, plan: Plan, rotated: boolean): Raw {
  const env = `TEAMBOT_PUBLIC_URL=${ws.external_url}
TEAMBOT_SETUP_TOKEN=${setupToken}
TEAMBOT_MAX_USERS=${plan.seats}
# TEAMBOT_MASTER_KEY maakt de klant zelf (openssl rand -base64 32); die krijgen wij nooit.`;
  return html`<p class="small"><a href="/operator">← Beheer</a></p>
  <div class="card">
    <h1>${rotated ? 'Nieuwe setup-token' : 'Dedicated omgeving geregistreerd'}</h1>
    <p class="flash error" role="alert"><strong>Bewaar deze waarden nu.</strong> De setup-token wordt niet opnieuw getoond; we bewaren alleen een controlewaarde.</p>
    <p>Waarden voor <code>deploy/dedicated/.env</code> van <strong>${ws.name}</strong>:</p>
    <pre class="card" style="white-space:pre-wrap;word-break:break-all"><code>${env}</code></pre>
    <h2>Zo gaat het verder</h2>
    <ol>
      <li>Stuur de deployment-kit (<code>deploy/dedicated/</code>) en deze waarden via een veilig kanaal naar de klant (niet in dezelfde e-mail als het adres).</li>
      <li>De klant installeert volgens <code>deploy/dedicated/README.md</code> en opent daarna eenmalig <code>${ws.external_url}/?setup=&lt;TEAMBOT_SETUP_TOKEN&gt;</code> om het eigenaar-account aan te maken.</li>
      <li>Wij controleren vanaf nu <code>${ws.external_url}/healthz</code>; de klant ziet de beschikbaarheid in het dashboard.</li>
    </ol>
    <p><a class="btn" href="/operator/workspaces/${ws.id}">Naar deze omgeving</a></p>
  </div>`;
}

export function auditPage(c: Ctx, rows: { at: Date; actor: string; kind: string; workspace_id: string | null; ip: string | null; data: Record<string, unknown> }[]): Raw {
  return html`<p class="small"><a href="/operator">← Beheer</a></p><h1>Auditlog</h1><p class="muted">De laatste 200 gebeurtenissen.</p>
  <div class="card table-wrap"><table><thead><tr><th scope="col">Tijd</th><th scope="col">Wie</th><th scope="col">Wat</th><th scope="col">Workspace</th><th scope="col">Details</th></tr></thead>
  <tbody>${rows.map((r) => html`<tr><td class="small">${formatDate(r.at, c.tz, true)}</td><td class="small">${r.actor}</td><td><code>${r.kind}</code></td><td class="small">${r.workspace_id || '—'}</td><td class="small"><code>${JSON.stringify(r.data)}</code></td></tr>`)}</tbody></table></div>`;
}

// ---------- public status ----------

export interface StatusData {
  overall: 'ok' | 'minor' | 'major' | 'maintenance';
  counts: { healthy: number; unhealthy: number; suspended: number; provisioning: number };
  dedicated: { healthy: number; unhealthy: number };
  open: Incident[];
  recent: Incident[];
  maintenance: Maintenance[];
  days: { day: string; pct: number | null; incidents: number }[];
  uptime30: number | null;
}

export function statusPage(c: Ctx, s: StatusData, now: Date): Raw {
  const ongoing = s.maintenance.filter((m) => new Date(m.starts_at) <= now);
  const planned = s.maintenance.filter((m) => new Date(m.starts_at) > now);
  const banner =
    s.overall === 'ok'
      ? html`<div class="flash ok" role="status"><strong>Alles werkt.</strong></div>`
      : s.overall === 'maintenance'
        ? html`<div class="flash ok" role="status"><strong>Er is gepland onderhoud bezig.</strong> Zie hieronder.</div>`
        : s.overall === 'minor'
          ? html`<div class="flash error" role="status"><strong>Er is een verstoring.</strong> We zijn ermee bezig.</div>`
          : html`<div class="flash error" role="status"><strong>Er is een storing.</strong> We zijn ermee bezig.</div>`;
  return html`<h1>Status</h1>${banner}
  <section class="card" aria-labelledby="nu"><h2 id="nu">Nu</h2>
    <dl class="facts">
      <dt>Router en dashboard</dt><dd>${badge(['Werkt', 'ok'])}</dd>
      <dt>Workspaces</dt><dd>${s.counts.healthy} ${s.counts.healthy === 1 ? 'werkt' : 'werken'}${s.counts.unhealthy ? html`, <strong>${s.counts.unhealthy} ${s.counts.unhealthy === 1 ? 'reageert' : 'reageren'} niet</strong>` : ''}${s.counts.provisioning ? `, ${s.counts.provisioning} ${s.counts.provisioning === 1 ? 'wordt' : 'worden'} klaargezet` : ''}${s.counts.suspended ? `, ${s.counts.suspended} gepauzeerd` : ''}</dd>
      ${s.dedicated.healthy + s.dedicated.unhealthy
        ? html`<dt>Dedicated omgevingen</dt><dd>${s.dedicated.healthy} bereikbaar${s.dedicated.unhealthy ? html`, <strong>${s.dedicated.unhealthy} niet bereikbaar</strong>` : ''} <span class="small muted">(draaien bij klanten)</span></dd>`
        : ''}
    </dl>
    <p class="small muted">We tonen alleen aantallen, nooit namen van workspaces.</p>
  </section>
  ${s.open.length
    ? html`<section class="card" aria-labelledby="open"><h2 id="open">Lopende storingen</h2>${s.open.map(
        (i) => html`<article><h3>${i.title} ${badge(i.impact === 'major' ? ['Storing', 'bad'] : ['Verstoring', 'warn'])}</h3><p class="small muted">Sinds ${formatDate(i.created_at, c.tz, true)}</p><p>${i.body}</p>
          ${i.updates.map((u) => html`<p class="small"><span class="muted">${formatDate(u.at, c.tz, true)}:</span> ${u.text}</p>`)}</article>`,
      )}</section>`
    : ''}
  ${ongoing.length ? html`<section class="card" aria-labelledby="mnt-nu"><h2 id="mnt-nu">Onderhoud bezig</h2>${maintenanceList(c, ongoing)}</section>` : ''}
  ${planned.length ? html`<section class="card" aria-labelledby="mnt-gepland"><h2 id="mnt-gepland">Gepland onderhoud</h2>${maintenanceList(c, planned)}</section>` : ''}
  <section class="card" aria-labelledby="dertig"><h2 id="dertig">Afgelopen 30 dagen</h2>
    <p>${s.uptime30 === null ? 'Nog geen metingen.' : html`Gemiddeld werkte <strong>${pct(s.uptime30)}</strong> van de controles van workspaces (aangekondigd onderhoud telt niet mee).`}</p>
    ${dayBars(s.days)}
    ${s.recent.length
      ? html`<h3>Opgeloste storingen</h3><ul class="clean">${s.recent.map((i) => html`<li>${formatDate(i.created_at, c.tz)}: ${i.title} <span class="small muted">(opgelost ${formatDate(i.resolved_at, c.tz, true)})</span></li>`)}</ul>`
      : html`<p class="small muted">Geen opgeloste storingen in deze periode.</p>`}
  </section>`;
}



// ---------- SLA reports, credits, alerts (CLD-05) ----------

export const RESULT_LABEL: Record<ReportResult, [string, string]> = {
  met: ['Doel gehaald', 'ok'],
  not_met: ['Doel niet gehaald', 'bad'],
  no_target: ['Geen beschikbaarheidsdoel', ''],
  no_data: ['Geen metingen', ''],
};

export const CREDIT_LABEL: Record<CreditStatus, [string, string]> = {
  pending: ['Wacht op beoordeling', 'warn'],
  applied: ['Verrekend via Stripe', 'ok'],
  to_settle: ['Te verrekenen', 'warn'],
  settled: ['Verrekend', 'ok'],
  rejected: ['Afgewezen', ''],
};

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const money = (cents: number, currency: string) => (cents / 100).toLocaleString('nl-NL', { style: 'currency', currency: currency.toUpperCase() });
const pct3 = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('nl-NL', { maximumFractionDigits: 3 })}%`);
const duration = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} u ${min % 60} min`);

function reportsSection(c: Ctx, ws: Workspace, reports: (ReportRow & { credit_status: CreditStatus | null })[]): Raw {
  return html`<section class="card" aria-labelledby="rapporten-titel" id="rapporten">
    <h2 id="rapporten-titel">SLA-rapporten</h2>
    <p class="small muted">Na elke maand maken we automatisch een rapport: gemeten beschikbaarheid, onderhoud, storingen en eventuele servicecredit. Een rapport verandert daarna niet meer. Meldingen bij storingen en nieuwe rapporten stel je in bij <a href="/account/alerts">Meldingen</a>.</p>
    ${reports.length
      ? html`<div class="table-wrap"><table>
        <thead><tr><th scope="col">Maand</th><th scope="col">Beschikbaarheid</th><th scope="col">Doel</th><th scope="col">Resultaat</th><th scope="col">Credit</th><th scope="col">Downloaden</th></tr></thead>
        <tbody>${reports.map(
          (r) => html`<tr>
            <td><a href="/workspaces/${ws.id}/reports/${r.month}">${monthLabel(r.month)}</a>${r.version > 1 ? html` <span class="small muted">(versie ${r.version})</span>` : ''}</td>
            <td>${pct3(r.data.measurement.uptimePct)}</td>
            <td>${r.data.plan.slaTarget === null ? '—' : pct3(r.data.plan.slaTarget)}</td>
            <td>${badge(RESULT_LABEL[r.data.result])}</td>
            <td>${r.data.credit ? html`${r.data.credit.pct}% · ${money(r.data.credit.amountCents, r.data.credit.currency)}${r.credit_status ? html`<br>${badge(CREDIT_LABEL[r.credit_status])}` : ''}` : '—'}</td>
            <td class="small"><a href="/workspaces/${ws.id}/reports/${r.month}/csv">CSV</a> · <a href="/workspaces/${ws.id}/reports/${r.month}/json">JSON</a></td>
          </tr>`,
        )}</tbody></table></div>`
      : html`<p class="small muted">Nog geen rapporten. Het eerste rapport verschijnt na afloop van de eerste volledige maand.</p>`}
  </section>`;
}

/** Printable report (owner and operator). Operator gets the credit and regenerate actions. */
export function reportPage(c: Ctx, row: ReportRow, credit: CreditRow | null, o: { back: { href: string; label: string }; downloads: string; operator?: boolean; slaUrl?: string }): Raw {
  const r = row.data;
  const m = r.measurement;
  return html`<p class="small no-print"><a href="${o.back.href}">← ${o.back.label}</a></p>
  <h1>SLA-rapport ${monthLabel(r.month)}</h1>
  <p class="muted">${r.workspace.name} (${r.workspace.slug}) · ${r.workspace.deployment === 'dedicated' ? 'Dedicated' : 'Beheerd door TeamBot Cloud'} · versie ${row.version}</p>
  <p class="small no-print">Afdrukken of als pdf bewaren: gebruik Afdrukken in je browser (Ctrl+P). Downloaden: <a href="${o.downloads}/csv">CSV</a> · <a href="${o.downloads}/json">JSON</a></p>
  <section class="card" aria-labelledby="samenvatting">
    <h2 id="samenvatting">Samenvatting</h2>
    <p>${badge(RESULT_LABEL[r.result])}</p>
    <dl class="facts">
      <dt>Periode</dt><dd>${formatDate(r.period.start, c.tz, true)} – ${formatDate(r.period.end, c.tz, true)} <span class="small muted">(${r.period.timeZone})</span></dd>
      <dt>Abonnement</dt><dd>${r.plan.name}</dd>
      <dt>Doel</dt><dd>${r.plan.slaTarget === null ? 'geen beschikbaarheidsdoel' : pct3(r.plan.slaTarget)}</dd>
      <dt>Gemeten beschikbaarheid</dt><dd><strong>${pct3(m.uptimePct)}</strong></dd>
      <dt>Controles</dt><dd>${m.checks} geteld, ${m.ok} geslaagd, ${m.failed} mislukt (elke ${m.intervalSec} s; ≈ ${duration(m.estimatedDowntimeMinutes)} uitval)</dd>
      <dt>Niet geteld</dt><dd>${m.excludedChecks} ${m.excludedChecks === 1 ? "controle" : "controles"} tijdens aangekondigd onderhoud</dd>
    </dl>
  </section>
  <section class="card" aria-labelledby="credit-titel">
    <h2 id="credit-titel">Servicecredit</h2>
    ${r.credit
      ? html`<p>${r.credit.pct}% van de maandprijs: <strong>${money(r.credit.amountCents, r.credit.currency)}</strong> <span class="small muted">(regel: beschikbaarheid ${r.credit.rule})</span></p>
        ${credit ? html`<p>Status: ${badge(CREDIT_LABEL[credit.status])}${credit.note ? html` <span class="small muted">${credit.note}</span>` : ''}${credit.external_ref ? html` <span class="small muted">(${credit.external_ref})</span>` : ''}</p>` : ''}
        <p class="small muted">Een credit wordt altijd eerst door ons beoordeeld; daarna verrekenen we hem met een volgende factuur.</p>`
      : html`<p>${r.result === 'not_met' ? 'Het doel is niet gehaald, maar voor dit abonnement is geen credit-tabel of prijs ingesteld.' : 'Geen servicecredit voor deze maand.'}</p>`}
    ${o.operator && credit?.status === 'pending'
      ? html`<div class="row no-print">
          <form method="post" action="/operator/reports/${row.id}/credit/approve">${csrfInput(c.csrf)}<button class="primary" type="submit">Credit goedkeuren</button></form>
          <form method="post" action="/operator/reports/${row.id}/credit/reject" class="row">${csrfInput(c.csrf)}<label class="sr" for="rej">Reden</label><input id="rej" name="note" required maxlength="500" placeholder="Reden van afwijzen"><button type="submit">Afwijzen</button></form>
        </div>`
      : ''}
    ${o.operator && credit?.status === 'to_settle'
      ? html`<form method="post" action="/operator/reports/${row.id}/credit/settle" class="no-print">${csrfInput(c.csrf)}<button type="submit">Markeer als verrekend</button></form>`
      : ''}
  </section>
  <section class="card" aria-labelledby="onderhoud-titel">
    <h2 id="onderhoud-titel">Onderhoud</h2>
    ${r.maintenance.length
      ? html`<div class="table-wrap"><table><thead><tr><th scope="col">Wat</th><th scope="col">Van – tot</th><th scope="col">Duur</th><th scope="col">Telt mee?</th></tr></thead><tbody>${r.maintenance.map(
          (w) => html`<tr><td>${w.title}${w.scope === 'platform' ? '' : html` <span class="small muted">(alleen deze workspace)</span>`}</td><td class="small">${formatDate(w.start, c.tz, true)} – ${formatDate(w.end, c.tz, true)}</td><td>${duration(w.minutes)}</td><td>${w.excluded ? 'Nee, op tijd aangekondigd' : html`<strong>Ja</strong>, te kort van tevoren aangekondigd`}</td></tr>`,
        )}</tbody></table></div>`
      : html`<p class="small muted">Geen onderhoud in deze maand.</p>`}
  </section>
  <section class="card" aria-labelledby="storingen-titel">
    <h2 id="storingen-titel">Storingen</h2>
    ${r.incidents.length
      ? html`<div class="table-wrap"><table><thead><tr><th scope="col">Storing</th><th scope="col">Begin</th><th scope="col">Einde</th><th scope="col">Duur in deze maand</th></tr></thead><tbody>${r.incidents.map(
          (i) => html`<tr><td>${i.title}${i.scope === 'platform' ? html` <span class="small muted">(platform)</span>` : ''}</td><td class="small">${formatDate(i.start, c.tz, true)}</td><td class="small">${i.end ? formatDate(i.end, c.tz, true) : 'nog bezig'}</td><td>${duration(i.minutes)}</td></tr>`,
        )}</tbody></table></div>`
      : html`<p class="small muted">Geen storingen in deze maand.</p>`}
  </section>
  <section class="card" aria-labelledby="meting-titel">
    <h2 id="meting-titel">Zo is gemeten</h2>
    <p class="small">Beschikbaarheid = geslaagde controles ÷ getelde controles. Controles tijdens onderhoud dat minstens 48 uur van tevoren is aangekondigd, tellen niet mee; korter van tevoren aangekondigd onderhoud telt wel mee. Een credit geldt alleen als het doel niet is gehaald; precies op een grens is niet "onder" de grens. Dagen en de maand lopen volgens ${r.period.timeZone}.</p>
    <p class="small muted">Gemaakt ${formatDate(row.generated_at, c.tz, true)} door ${r.generatedBy === 'operator' ? 'beheer' : 'het systeem'}${row.reason ? html` · reden: ${row.reason}` : ''}. Rapporten zijn onveranderlijk; een nieuwe versie wordt alleen door beheer gemaakt en gelogd.</p>
  </section>
  ${o.operator
    ? html`<section class="card no-print" aria-labelledby="opnieuw">
        <h2 id="opnieuw">Nieuwe versie maken</h2>
        <p class="small muted">Alleen bij een fout in de meting. De huidige versie blijft bewaard; een openstaande credit vervalt en wordt opnieuw berekend.</p>
        <form method="post" action="/operator/reports/${row.id}/regenerate">${csrfInput(c.csrf)}<label for="reason">Reden</label><input id="reason" name="reason" required maxlength="500"><p style="margin-top:8px"><button type="submit">Nieuwe versie maken</button></p></form>
      </section>`
    : ''}`;
}

export function operatorReportsPage(c: Ctx, month: string, rows: (ReportRow & { slug: string; name: string; credit: CreditRow | null })[], months: string[]): Raw {
  const pending = rows.filter((r) => r.credit?.status === 'pending');
  return html`<p class="small"><a href="/operator">← Beheer</a></p>
  <h1>SLA-rapporten ${monthLabel(month)}</h1>
  <form method="get" action="/operator/reports" class="row no-print"><label for="month" class="sr">Maand</label>
    <select id="month" name="month">${months.map((m) => html`<option value="${m}" ${m === month ? raw('selected') : ''}>${monthLabel(m)}</option>`)}</select>
    <button type="submit">Tonen</button> <a class="btn" href="/operator/reports-export?month=${month}">Alles als CSV</a></form>
  ${pending.length ? html`<p class="flash error" role="status">${pending.length} credit(s) wachten op je beoordeling. Niets wordt verrekend zonder jouw goedkeuring.</p>` : ''}
  <div class="card table-wrap"><table>
    <thead><tr><th scope="col">Workspace</th><th scope="col">Beschikbaarheid</th><th scope="col">Doel</th><th scope="col">Resultaat</th><th scope="col">Credit</th></tr></thead>
    <tbody>${rows.map(
      (r) => html`<tr>
        <td><a href="/operator/reports/${r.id}">${r.slug}</a><br><span class="small muted">${r.name}${r.version > 1 ? ` · versie ${r.version}` : ''}</span></td>
        <td>${pct3(r.data.measurement.uptimePct)}</td>
        <td>${r.data.plan.slaTarget === null ? '—' : pct3(r.data.plan.slaTarget)}</td>
        <td>${badge(RESULT_LABEL[r.data.result])}</td>
        <td>${r.data.credit ? html`${r.data.credit.pct}% · ${money(r.data.credit.amountCents, r.data.credit.currency)}${r.credit ? html`<br>${badge(CREDIT_LABEL[r.credit.status])}` : ''}` : '—'}</td>
      </tr>`,
    )}</tbody></table>
    ${rows.length ? '' : html`<p class="small muted">Nog geen rapporten voor deze maand.</p>`}
  </div>
  <form method="post" action="/operator/reports/generate" class="no-print">${csrfInput(c.csrf)}<input type="hidden" name="month" value="${month}"><button type="submit">Ontbrekende rapporten voor ${monthLabel(month)} maken</button></form>`;
}

export function alertsPage(c: Ctx, s: AlertSettings, recent: { channel: string; type: string; status: string; detail: string | null; created_at: Date }[], secret: string | null, error?: string): Raw {
  return html`<p class="small"><a href="/dashboard">← Je workspaces</a></p>
  <h1>Meldingen</h1>
  <p class="muted">We laten het je weten als een workspace niet reageert, als hij weer bereikbaar is en als een maandrapport klaarstaat. Maximaal een beperkt aantal meldingen per uur.</p>
  ${error ? html`<div class="flash error" role="alert">${error}</div>` : ''}
  ${secret
    ? html`<div class="card"><p class="flash error" role="alert"><strong>Bewaar dit geheim nu</strong>; het wordt niet opnieuw getoond.</p>
        <p>Webhook-geheim: <code>${secret}</code></p>
        <p class="small">Elke webhook heeft de header <code>X-TeamBot-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>: HMAC-SHA256 met dit geheim over <code>&lt;t&gt;.&lt;body&gt;</code>. Controleer de handtekening en weiger oude tijdstempels (bijv. ouder dan 5 minuten).</p></div>`
    : ''}
  <form method="post" action="/account/alerts" class="card">
    ${csrfInput(c.csrf)}
    <label><input type="checkbox" name="email" value="1" style="width:auto" ${s.email ? raw('checked') : ''} ${s.emailAvailable ? '' : raw('disabled')}> E-mail naar mijn accountadres</label>
    ${s.emailAvailable ? '' : html`<p class="hint">E-mail is op deze installatie niet ingesteld; gebruik een webhook.</p>`}
    <label for="webhook">Webhook (https)</label>
    <input id="webhook" name="webhook" type="url" value="${s.webhookUrl || ''}" placeholder="https://hooks.jouwbedrijf.nl/teambot" aria-describedby="wh-hint">
    <p class="hint" id="wh-hint">We sturen een JSON-bericht met een ondertekening (HMAC). Alleen https en een publiek adres; doorverwijzingen volgen we niet. Leeg = geen webhook.</p>
    <p class="row" style="margin-top:12px"><button class="primary" type="submit">Opslaan</button></p>
  </form>
  <div class="row">
    ${s.webhookUrl ? html`<form method="post" action="/account/alerts/secret">${csrfInput(c.csrf)}<button type="submit">Nieuw webhook-geheim</button></form>` : ''}
    ${s.webhookUrl || s.email ? html`<form method="post" action="/account/alerts/test">${csrfInput(c.csrf)}<button type="submit">Testmelding sturen</button></form>` : ''}
  </div>
  <section class="card" aria-labelledby="recent"><h2 id="recent">Laatst verstuurd</h2>
    ${recent.length
      ? html`<ul class="clean small">${recent.map((a) => html`<li>${formatDate(a.created_at, c.tz, true)} · ${a.channel} · ${a.type} · <strong>${a.status}</strong>${a.detail ? ` (${a.detail})` : ''}</li>`)}</ul>`
      : html`<p class="small muted">Nog geen meldingen verstuurd.</p>`}
  </section>`;
}
