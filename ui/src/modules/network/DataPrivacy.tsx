import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { t, translate } from '../../lib/i18n';
import { Card, CardHead, Spinner, cx } from '../../components/ui';
import { PrivacyBadge, PrivacyDetail, type AgentPrivacy, type PrivacyLabel } from './Privacy';

/**
 * "Wat verlaat je pc?" on the data page (#/settings/data): per bot which AI service gets its conversations and what
 * that service does with them, everything else that can go out (on or off), where the keys are, how TeamBot can be
 * reached, and how to take everything with you or wipe it. Data: GET /api/privacy/overview (network module).
 */

interface Overview {
  bots: AgentPrivacy[];
  outgoing: { search: string; jinaReader?: boolean; channels: number; appsRemote: number; appsLocal: number; push: number; sites: number; proxy: string | null; telemetry: false; shareLinks: false };
  keys: { kind: string; text: string };
  mode: 'desktop' | 'server';
  dataDir: string | null;
  exposure: {
    host: string;
    loopbackOnly: boolean;
    https: boolean;
    findings: { level: 'refuse' | 'warn' | 'info'; code: string; message: string; fix: string }[];
    gateway: { enabled: boolean; running: boolean; bind: string | null; port: number | null } | null;
  } | null;
}

/** Where a search goes, per choice in Instellingen › Zoeken (the free chain in server/tools/builtin/web.ts). */
const SEARCH: Record<string, string> = {
  auto: 'Keenable of Parallel (anders je eigen zoeksleutels, DuckDuckGo of Wikipedia)',
  keenable: 'Keenable (anders de volgende zoekdienst)',
  parallel: 'Parallel (anders de volgende zoekdienst)',
  tavily: 'Tavily (anders de volgende zoekdienst)',
  exa: 'Exa (anders de volgende zoekdienst)',
  duckduckgo: 'DuckDuckGo (anders de volgende zoekdienst)',
  brave: 'Brave Search (anders de volgende zoekdienst)',
  searxng: 'je eigen SearXNG-server',
};

function Row({ on, title, children, href }: { on: boolean; title: string; children: React.ReactNode; href?: string }) {
  return (
    <li className="flex gap-3 py-2">
      <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', on ? 'bg-warn' : 'bg-ok')} aria-hidden />
      <div className="min-w-0 text-sm">
        <div className="font-semibold">
          {title} <span className="font-normal text-muted">· {on ? 'aan' : 'uit'}</span>
        </div>
        <div className="text-muted">
          {children}
          {href && (
            <>
              {' '}
              <a className="underline hover:text-fg" href={href}>
                Instellen
              </a>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export function WhatLeavesYourPc() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get<Overview>('/privacy/overview').then(setD, (e) => setErr(e?.message || String(e)));
  }, []);
  if (err)
    return (
      <Card className="p-5">
        <CardHead icon={ShieldCheck} tone="rose" title="Wat verlaat je pc?" />
        <p className="mt-2 text-sm text-danger">{err}</p>
      </Card>
    );
  if (!d)
    return (
      <Card className="p-5">
        <Spinner />
      </Card>
    );
  const o = d.outgoing;
  // One explanation per distinct label (several bots often share an engine).
  const labels = new Map<string, { p: PrivacyLabel; who: string }>();
  for (const b of d.bots) for (const e of b.engines) if (!labels.has(e.privacy.detail)) labels.set(e.privacy.detail, { p: e.privacy, who: e.kindLabel });
  const exp = d.exposure;
  const warnings = exp?.findings.filter((f) => f.level !== 'info') || [];
  return (
    <Card className="space-y-5 p-5" id="wat-verlaat-je-pc" data-testid="what-leaves">
      <CardHead icon={ShieldCheck} tone="rose" title="Wat verlaat je pc?" hint="Per bot zie je welke AI-dienst zijn gesprekken krijgt. De rest blijft op deze computer." />

      <section className="space-y-2" aria-labelledby="wvp-bots">
        <h3 id="wvp-bots" className="text-sm font-bold">
          Je bots
        </h3>
        <p className="text-xs text-muted">Een bot stuurt zijn engine je bericht, het gesprek, geheugen en wat hij met tools leest.</p>
        {d.bots.length === 0 ? (
          <p className="text-sm text-muted">Je hebt nog geen bots. Zodra je er een maakt, staat hier waar zijn gesprekken heen gaan.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.bots.map((b) => (
              <li key={b.agentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="min-w-[8rem] font-semibold" translate="no">
                  {b.name}
                </span>
                {b.engines.length === 0 ? (
                  <span className="text-muted">nog geen engine</span>
                ) : (
                  b.engines.map((e, i) => (
                    <span key={i} className="inline-flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-muted" translate="no">
                        {e.role === 'reserve' ? t('reserve: {0}', e.kindLabel) : e.kindLabel}
                      </span>
                      <PrivacyBadge p={e.privacy} />
                    </span>
                  ))
                )}
              </li>
            ))}
          </ul>
        )}
        {labels.size > 0 && (
          <div className="space-y-3 rounded-xl bg-surface-2 p-3">
            {[...labels.values()].map(({ p, who }) => (
              <div key={p.detail} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  <span translate="no">{p.receiver || who}</span>
                  <PrivacyBadge p={p} />
                </div>
                <PrivacyDetail p={p} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-1" aria-labelledby="wvp-other">
        <h3 id="wvp-other" className="text-sm font-bold">
          Wat er verder naar buiten kan
        </h3>
        <ul className="divide-y divide-line">
          <Row on title="Zoeken op internet" href="#/settings/websearch-zoeken">
            {t('Als een bot zoekt, gaat alleen de zoekterm naar {0}.', SEARCH[o.search] ? translate(SEARCH[o.search]) : o.search)}{' '}
            {o.jinaReader ? 'Lukt het ophalen van een webpagina niet, dan gaat het adres naar Jina Reader.' : 'Webpagina’s die hij leest, haalt TeamBot zelf op.'}
          </Row>
          <Row on title="Zoeken in de marktplaats" href="#/m/skills/skills?bron=open">
            Zoek jij onder Open naar een skill, of zoekt een bot er een met skill_find, dan gaan alleen de zoekwoorden naar GitHub, skills.sh en ClawHub. Een skill die je toevoegt, haalt TeamBot daar op.
          </Row>
          <Row on={o.channels > 0} title="Kanalen" href="#/m/channels">
            {o.channels > 0 ? t('{0, plural, one {# kanaal gekoppeld: berichten gaan via die dienst.} other {# kanalen gekoppeld: berichten gaan via die diensten.}}', o.channels) : 'Geen kanaal gekoppeld.'}
          </Row>
          <Row on={o.appsRemote > 0} title="Apps op internet (MCP)" href="#/m/mcp">
            {o.appsRemote > 0 ? t('{0, plural, one {# app op internet krijgt wat een bot verstuurt.} other {# apps op internet krijgen wat een bot verstuurt.}}', o.appsRemote) : 'Geen app op internet gekoppeld.'}
            {o.appsLocal > 0 ? ' ' + t('{0, plural, one {# app draait als programma op deze computer.} other {# apps draaien als programma op deze computer.}}', o.appsLocal) : ''}
          </Row>
          <Row on={o.push > 0} title="Meldingen op je telefoon" href="#/settings/mobile-telefoon">
            {o.push > 0 ? 'Meldingen gaan versleuteld via de pushdienst van je telefoon of browser.' : 'Geen pushmeldingen aan.'}
          </Row>
          <Row on={o.sites > 0} title="Websites van bots" href="#/m/sites">
            {o.sites > 0 ? t('{0, plural, one {# website staat online, nooit op het openbare internet.} other {# websites staan online, nooit op het openbare internet.}}', o.sites) : 'Geen website online. Een bot vraagt altijd eerst toestemming en kiest standaard "alleen deze computer".'}
          </Row>
          {o.proxy && (
            <Row on title="Proxy" href="#/settings/network-proxy">
              {t('Uitgaand verkeer van TeamBot gaat via de proxy {0}.', o.proxy)}
            </Row>
          )}
          <Row on={false} title="Openbare links">
            TeamBot maakt geen openbare links naar gesprekken. Alles blijft achter je eigen inlog.
          </Row>
          <Row on={false} title="Statistieken en foutrapporten">
            TeamBot stuurt niets naar de makers: geen statistieken en geen foutrapporten. Een diagnosebestand maak en deel je alleen zelf.
          </Row>
          {d.mode === 'desktop' && (
            <Row on={false} title="Zoeken naar updates" href="#/settings/backups">
              Alleen als je een updatekanaal instelt; dan vraagt TeamBot daar af en toe of er een nieuwe versie is.
            </Row>
          )}
        </ul>
      </section>

      <section className="space-y-1" aria-labelledby="wvp-keys">
        <h3 id="wvp-keys" className="flex items-center gap-1.5 text-sm font-bold">
          <KeyRound className="h-4 w-4" aria-hidden /> Je sleutels
        </h3>
        <p className="text-sm text-muted">{d.keys.text}</p>
      </section>

      {exp && (
        <section className="space-y-1" aria-labelledby="wvp-reach">
          <h3 id="wvp-reach" className="text-sm font-bold">
            Wie kan TeamBot bereiken?
          </h3>
          <p className="flex items-start gap-1.5 text-sm text-muted">
            {exp.loopbackOnly && !warnings.length ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />}
            <span>
              {exp.loopbackOnly ? 'Alleen deze computer, tenzij je telefoon-toegang aanzet.' : exp.https ? t('Via het netwerk ({0}), achter https.', exp.host) : t('Via het netwerk ({0}), zonder https.', exp.host)}
              {exp.gateway?.running ? ' ' + t('Telefoon-toegang staat aan (poort {0}): alleen gekoppelde telefoons komen erin.', exp.gateway.port ?? '') : ''}
            </span>
          </p>
          {warnings.length > 0 && (
            <ul className="space-y-1.5">
              {warnings.map((f) => (
                <li key={f.code} className="rounded-lg bg-warn-soft p-2.5 text-sm">
                  <div className="font-semibold text-warn">{f.message}</div>
                  <div className="text-muted">{f.fix}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="space-y-1" aria-labelledby="wvp-wipe">
        <h3 id="wvp-wipe" className="text-sm font-bold">
          Alles meenemen of wissen
        </h3>
        <ul className="list-disc space-y-1 ps-5 text-sm text-muted">
          <li>
            <span className="text-fg">Meenemen:</span> met <b>Exporteren</b> hieronder download je je bots, gesprekken, instellingen en geheugen als één bestand. Sleutels gaan nooit mee.
          </li>
          <li>
            <span className="text-fg">Alles wissen:</span>{' '}
            {d.mode === 'desktop'
              ? 'verwijder TeamBot via Windows › Instellingen › Apps en kies Ja bij de vraag over je gegevens.'
              : 'stop de server en verwijder de datamap (bij Docker: het volume teambot-data).'}
            {d.dataDir && (
              <>
                {' '}
                <span className="break-all font-mono text-xs" translate="no">
                  {d.dataDir}
                </span>
              </>
            )}
          </li>
          <li>
            <span className="text-fg">Bij de AI-diensten:</span> wat al naar een dienst ging, bewaart die volgens zijn eigen termijn (zie hierboven). Verwijder het daar in je account, en trek je sleutels daar in als je stopt.
          </li>
        </ul>
      </section>
    </Card>
  );
}
