import { useEffect, useState } from 'react';
import { ArrowLeftRight, Check, CircleAlert, CircleCheck, Minus, Network, PlugZap, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Button, Card, CardHead, Field, Input, Spinner, Textarea, Toggle, cx, timeAgo, toast, toastError } from '../../components/ui';
import { ComputerOnly, useIsPhoneSession } from '../../shell/computerOnly';

interface ProxyView {
  configured: boolean;
  enabled: boolean;
  url: string;
  noProxy: string[];
  browser: boolean;
  hasAuth: boolean;
  updatedAt: string | null;
  active: boolean;
  activeLabel: string | null;
  applyError: string | null;
  support: { ok: boolean; node: string; reason?: string };
  defaultNoProxy: string[];
}

interface TestResult {
  ok: boolean;
  message: string;
  status?: number;
  ms: number;
}

const VIA = [
  'AI-diensten met een API-sleutel (OpenAI, Anthropic, Gemini, OpenRouter, Mistral …)',
  'Zoeken op internet en webpagina’s lezen',
  'De marktplaats, skills en het downloaden van spraakmodellen',
  'Apps (MCP) die via internet werken',
  'Telegram, WhatsApp Business en berichten naar Slack',
  'De browser van de bots (als “Ook de browser van de bots” aanstaat)',
];
const NOT_VIA = [
  'Alles op deze computer zelf (localhost), zoals Ollama of LM Studio',
  'Adressen op de lijst “Niet via de proxy”',
  'CLI-bots (Claude Code, Codex, OpenCode …) en de terminal: die volgen hun eigen instellingen, zoals HTTPS_PROXY in Windows',
  'Apps (MCP) die als programma op je computer draaien',
  'Live verbindingen: Discord, Slack Socket Mode, WhatsApp via QR en de Realtime-stem van OpenAI',
  'E-mail (IMAP/SMTP), SSH naar je eigen servers, en app-updates (die volgen de proxy van Windows)',
];

/**
 * Instellingen › Netwerk en proxy (owner/admin): one HTTP(S) proxy for TeamBot's outgoing traffic. It is part of the
 * administration (/admin), which a paired phone leaves to the computer (server/modules/mobile/policy.ts): there the
 * page says so calmly instead of asking the server and showing an error.
 */
export function ProxySettings() {
  if (useIsPhoneSession())
    return (
      <Card className="p-5">
        <ComputerOnly>De proxy voor uitgaand verkeer stel je in op je computer.</ComputerOnly>
      </Card>
    );
  return <ProxyForm />;
}

function ProxyForm() {
  const [v, setV] = useState<ProxyView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [noProxy, setNoProxy] = useState('');
  const [browser, setBrowser] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [target, setTarget] = useState('https://example.com');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const fill = (x: ProxyView) => {
    setV(x);
    setEnabled(x.enabled);
    setUrl(x.url);
    setNoProxy((x.noProxy || []).join('\n'));
    setBrowser(x.browser);
    setUsername('');
    setPassword('');
  };
  const load = () => {
    setErr(null);
    api.get<ProxyView>('/admin/network/proxy').then(fill).catch((e) => setErr(e?.message || String(e)));
  };
  useEffect(load, []);

  if (err)
    return (
      <Card className="space-y-3 p-5">
        <p className="text-sm text-danger">De proxy-instellingen konden niet worden geladen: {err}</p>
        <Button onClick={load}>Opnieuw proberen</Button>
      </Card>
    );
  if (!v) return <Spinner />;

  const dirty = enabled !== v.enabled || url.trim() !== v.url || noProxy.trim() !== v.noProxy.join('\n') || browser !== v.browser || !!username || !!password;

  const save = async (extra: Record<string, any> = {}) => {
    setSaving(true);
    try {
      const x = await api.put<ProxyView>('/admin/network/proxy', { enabled, url: url.trim(), noProxy, browser, username, password, ...extra });
      fill(x);
      if (x.applyError) toast(`Opgeslagen, maar niet actief: ${x.applyError}`, 'danger');
      else toast(x.active ? `Proxy actief: ${x.activeLabel}` : 'Opgeslagen: TeamBot maakt zelf verbinding', 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.post<TestResult>('/admin/network/proxy/test', { url: url.trim(), username, password, target: target.trim() }));
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || String(e), ms: 0 });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      {!v.support.ok && (
        <Card className="flex items-start gap-3 border-warn/40 bg-warn-soft p-4 text-sm">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <span>{v.support.reason}</span>
        </Card>
      )}
      <Card className="space-y-5 p-5">
        <CardHead
          icon={Network}
          tone="blue"
          title="Proxy voor uitgaand verkeer"
          action={v.active ? <Badge tone="ok">Actief</Badge> : v.enabled && v.applyError ? <Badge tone="danger">Niet actief</Badge> : <Badge>Uit</Badge>}
        />
        <p className="text-sm leading-relaxed text-muted">
          Voor een netwerk dat alleen via een proxy naar internet mag, zoals op kantoor.
        </p>
        <Toggle checked={enabled} onChange={setEnabled} label={<span className="font-semibold">Proxy gebruiken</span>} />
        <Field label="Adres van de proxy" hint="Met http://, https:// of socks5:// en de poort.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://proxy.bedrijf.nl:8080" inputMode="url" autoComplete="off" spellCheck={false} translate="no" />
        </Field>
        <Field label="Niet via de proxy" hint="Eén per regel: een naam, een domein (.bedrijf.nl) of een IP-bereik.">
          <Textarea rows={5} value={noProxy} onChange={(e) => setNoProxy(e.target.value)} spellCheck={false} translate="no" className="font-mono text-[13px]" />
        </Field>
        <div className="space-y-1.5">
          <Toggle checked={browser} onChange={setBrowser} label={<span className="font-semibold">Ook de browser van de bots</span>} />
          <p className="text-xs leading-relaxed text-muted">De browser gaat eerst langs de controles van TeamBot en dan door de proxy.</p>
        </div>
        <fieldset className="space-y-3 rounded-xl border border-line p-4">
          <legend className="px-1 text-[13px] font-semibold">Inloggen bij de proxy (optioneel)</legend>
          {v.hasAuth && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
              <ShieldCheck className="h-4 w-4 shrink-0 text-ok" aria-hidden />
              <span className="min-w-0 flex-1">Inloggegevens zijn versleuteld opgeslagen. Ze worden nooit meer getoond; laat de velden leeg om ze te houden.</span>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => save({ clearAuth: true, username: '', password: '' })}>
                Wissen
              </Button>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Gebruikersnaam">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} placeholder={v.hasAuth ? 'Opgeslagen' : ''} />
            </Field>
            <Field label="Wachtwoord">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={v.hasAuth ? 'Opgeslagen' : ''} />
            </Field>
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => save()}>
            Opslaan
          </Button>
          <span className="text-xs text-muted">
            {dirty ? (
              <span className="font-semibold text-warn">Nog niet opgeslagen.</span>
            ) : v.active ? (
              <>
                Nieuwe verbindingen gaan via <b translate="no">{v.activeLabel}</b>
                {v.updatedAt ? ` · ingesteld ${timeAgo(v.updatedAt)}` : ''}.
              </>
            ) : v.enabled && v.applyError ? (
              <span className="text-danger">Niet actief: {v.applyError}</span>
            ) : (
              'Uit: TeamBot maakt zelf verbinding met internet.'
            )}
          </span>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <CardHead icon={PlugZap} tone="blue" title="Verbinding testen" hint="Haalt deze pagina op via de proxy hierboven. Opslaan is niet nodig." />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Testadres" placeholder="https://example.com" inputMode="url" spellCheck={false} translate="no" className="sm:flex-1" />
          <Button loading={testing} disabled={!url.trim()} onClick={test}>
            Verbinding testen
          </Button>
        </div>
        {result && (
          <div role="status" className={cx('flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm', result.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger')}>
            {result.ok ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
            <span className="min-w-0 break-words font-medium">{result.message}</span>
          </div>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <CardHead icon={ArrowLeftRight} tone="blue" title="Wat gaat via de proxy?" />
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-[13px] font-semibold">Wel</h3>
            <ul className="space-y-1.5 text-sm">
              {VIA.map((t) => (
                <li key={t} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-[13px] font-semibold">Niet</h3>
            <ul className="space-y-1.5 text-sm">
              {NOT_VIA.map((t) => (
                <li key={t} className="flex gap-2">
                  <Minus className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted">
          De proxy krijgt de adressen te zien waarmee TeamBot verbinding maakt. De inhoud van https-verkeer blijft versleuteld, tenzij je proxy dat zelf openbreekt; dat ondersteunt TeamBot niet.
        </p>
      </Card>
    </div>
  );
}
