import { useEffect, useRef, useState } from 'react';
import { AtSign, ExternalLink, Globe } from 'lucide-react';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { askConfirm, Button, Field, Input, Textarea, toastError } from '../../components/ui';
import { ConnectCard, ConnectResult, type ConnectState } from '../../components/ConnectCard';
import { KeyFromFile } from '../../components/KeyFile';
import type { Conn } from './shared';

/**
 * TeamBot's own apps that work with one key (server/modules/mcp/transip.ts, forwardemail.ts): the owner pastes it
 * once, TeamBot checks it with one real read, and every bot can use the tools at once.
 */
interface KeyAppState {
  account: { login?: string; email?: string | null } | null;
  status: 'off' | 'on';
  connection: Conn | null;
}

const Link = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-sm font-medium hover:bg-surface-2">
    {children} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
  </a>
);

function useKeyApp(path: string) {
  const [s, setS] = useState<KeyAppState | null>(null);
  const [err, setErr] = useState('');
  const live = useRef(true);
  const load = () =>
    api
      .get<KeyAppState>(path)
      .then((x) => live.current && setS(x))
      .catch((e) => live.current && setErr(e.message));
  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
    };
  }, []);
  return { s, setS, err, setErr, load, live };
}

/** The test, "Bots kiezen" and "weghalen" of a key app: the same on both cards. */
function KeyAppCard({
  path,
  testTool,
  testArgs,
  icon,
  title,
  onLine,
  offLine,
  removeQuestion,
  form,
  testid,
}: {
  path: string;
  testTool: string;
  testArgs?: any;
  icon: React.ReactNode;
  title: string;
  onLine: (s: KeyAppState) => string;
  offLine: string;
  removeQuestion: string;
  form: (done: (next: KeyAppState) => void) => React.ReactNode;
  testid: string;
}) {
  const { s, setS, err, setErr, load, live } = useKeyApp(path);
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [ok, setOk] = useState('');

  const test = async () => {
    if (!s?.connection) return;
    setTesting(true);
    setErr('');
    setOk('');
    try {
      const r = await api.post<any>(`/mcp/connections/${s.connection.id}/test`, { tool: testTool, args: testArgs || {} });
      if (r?.sample?.isError) setErr(String(r.sample.text || '').slice(0, 400));
      else setOk('Verbinding werkt.');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      if (live.current) setTesting(false);
    }
  };

  const remove = async () => {
    if (!(await askConfirm(removeQuestion, { ok: 'Weghalen', danger: true }))) return;
    try {
      if (s?.connection) await api.del(`/mcp/connections/${s.connection.id}`);
      await api.put(path, { forget: true });
      setOk('');
      load();
    } catch (e) {
      toastError(e);
    }
  };

  const on = s?.status === 'on';
  const state: ConnectState = !s || testing ? 'busy' : err ? 'error' : on ? 'on' : 'off';
  return (
    <ConnectCard
      data-testid={testid}
      icon={icon}
      tone="blue"
      title={title}
      state={state}
      stateLabel={testing ? 'testen' : undefined}
      line={on && s ? onLine(s) : offLine}
      action={
        !s || open ? null : on ? (
          <Button loading={testing} onClick={test}>
            Test
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setOpen(true)} data-testid={`${testid}-start`}>
            Koppelen
          </Button>
        )
      }
      result={err ? <ConnectResult ok={false}>{err}</ConnectResult> : ok ? <ConnectResult ok>{ok}</ConnectResult> : undefined}
      more={
        !s || !on ? undefined : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setOpen(true)}>
              Andere sleutel
            </Button>
            {s.connection && (
              <Button size="sm" onClick={() => navigate(`/m/mcp/c/${s.connection!.id}`)}>
                Bots kiezen
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={remove}>
              Weghalen
            </Button>
          </div>
        )
      }
    >
      {open &&
        form((next) => {
          setS(next);
          setErr('');
          setOk('Gekoppeld: je bots kunnen het nu gebruiken.');
          setOpen(false);
        })}
      {open && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOpen(false)}>
          Annuleren
        </Button>
      )}
    </ConnectCard>
  );
}

function Steps({ steps }: { steps: { text: string; href?: string; label?: string }[] }) {
  return (
    <ol className="space-y-2">
      {steps.map((x, i) => (
        <li key={x.text} className="flex flex-wrap items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-semibold">{i + 1}</span>
          <span className="min-w-0 flex-1 basis-56">{x.text}</span>
          {x.href && <Link href={x.href}>{x.label}</Link>}
        </li>
      ))}
    </ol>
  );
}

function TransipForm({ onSaved }: { onSaved(next: KeyAppState): void }) {
  const [login, setLogin] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.put<KeyAppState>('/mcp/transip', { login, privateKey: key }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg bg-surface-2 p-3 text-sm" data-testid="transip-form">
      <Steps
        steps={[
          { text: 'Log in bij TransIP en open Account › API. Zet de API aan.', href: 'https://www.transip.nl/cp/account/api/', label: 'TransIP API' },
          { text: 'Maak bij “Key Pairs” een nieuwe sleutel. Laat “Alleen whitelisted IP-adressen” aan en zet het IPv4-adres van deze computer op de whitelist.' },
          { text: 'Kopieer de privésleutel die TransIP één keer toont (of bewaar hem als bestand) en vul hem hieronder in, met je inlognaam.' },
        ]}
      />
      <Field label="TransIP-inlognaam">
        <Input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="jouwnaam" autoComplete="off" />
      </Field>
      <Field label="Privésleutel" hint="TeamBot bewaart hem versleuteld op deze computer en toont hem nooit meer.">
        <div className="space-y-2">
          <Textarea rows={3} value={key} onChange={(e) => setKey(e.target.value)} className="font-mono text-xs" placeholder="-----BEGIN PRIVATE KEY-----" aria-label="Privésleutel van TransIP" />
          <KeyFromFile onKey={(v) => setKey(v)} />
        </div>
      </Field>
      <Button variant="primary" loading={busy} disabled={!login.trim() || !key.trim()} onClick={save} data-testid="transip-save">
        Opslaan en controleren
      </Button>
    </div>
  );
}

function ForwardEmailForm({ onSaved }: { onSaved(next: KeyAppState): void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.put<KeyAppState>('/mcp/forwardemail', { token }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg bg-surface-2 p-3 text-sm" data-testid="forwardemail-form">
      <Steps steps={[{ text: 'Log in bij Forward Email en open My Account › Security. Kopieer daar je API-token.', href: 'https://forwardemail.net/my-account/security', label: 'Forward Email' }]} />
      <Field label="API-token">
        <div className="flex flex-wrap gap-2">
          <KeyFromFile onKey={(v) => setToken(v)} />
          <Input className="min-w-[11rem] flex-1" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} aria-label="API-token van Forward Email" />
        </div>
      </Field>
      <Button variant="primary" loading={busy} disabled={!token.trim()} onClick={save} data-testid="forwardemail-save">
        Opslaan en controleren
      </Button>
    </div>
  );
}

/** TransIP on the Apps page: domains and DNS. */
export function TransipCard() {
  return (
    <KeyAppCard
      path="/mcp/transip"
      testTool="transip_domains"
      icon={<Globe />}
      title="TransIP"
      testid="transip-card"
      onLine={(s) => t('Account {0}: je bots zien je domeinen en beheren de DNS. Registreren vraagt altijd eerst jou.', s.account?.login || '')}
      offLine="Je domeinen en DNS bij TransIP: verlengdata, vrije namen, DNS-records en nameservers."
      removeQuestion="TransIP weghalen? TeamBot vergeet je inlognaam en sleutel. Verwijder de sleutel ook bij TransIP als je hem nergens anders gebruikt."
      form={(done) => <TransipForm onSaved={done} />}
    />
  );
}

/** Forward Email on the Apps page: mail domains and addresses. */
export function ForwardEmailCard() {
  return (
    <KeyAppCard
      path="/mcp/forwardemail"
      testTool="forwardemail_domains"
      icon={<AtSign />}
      title="Forward Email"
      testid="forwardemail-card"
      onLine={(s) => (s.account?.email ? t('Account {0}: je bots zien je maildomeinen en maken mailadressen.', s.account.email) : 'Je bots zien je maildomeinen en maken mailadressen.')}
      offLine="Maildomeinen en mailadressen bij forwardemail.net: doorsturen, mailboxen en of de DNS klopt."
      removeQuestion="Forward Email weghalen? TeamBot vergeet je API-token. Trek hem ook in bij Forward Email als je hem nergens anders gebruikt."
      form={(done) => <ForwardEmailForm onSaved={done} />}
    />
  );
}
