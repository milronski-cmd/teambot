import { useState } from 'react';
import { Copy, ExternalLink, SquareTerminal } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Input, Spinner, toast, useAsync } from '../../components/ui';
import type { DeviceLoginView } from './runtime';

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Gekopieerd', 'ok');
  } catch {
    toast('Kopiëren lukte niet — selecteer de tekst handmatig', 'danger');
  }
}

/** Start the login of a CLI: a device/paste login TeamBot shows itself, or a command for a terminal. */
export async function startLogin(id: string): Promise<{ mode: 'device' | 'terminal'; login?: DeviceLoginView; command?: string }> {
  return api.post(`/cli-agents/${id}/login`, {});
}

function TerminalLogin({ id, command, desktop }: { id: string; command: string; desktop: boolean }) {
  const act = useAsync();
  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-1.5">
        <code className="min-w-0 flex-1 break-all rounded-md bg-surface px-2 py-1.5 font-mono text-xs" translate="no">
          {command}
        </code>
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`Kopieer: ${command}`} onClick={() => copy(command)}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
      {desktop && (
        <Button size="sm" icon={<SquareTerminal className="h-4 w-4" />} loading={act.busy} onClick={() => act.run(async () => void (await api.post(`/cli-agents/${id}/login/terminal`, {})), 'Terminal geopend: log daar in')}>
          Terminal openen
        </Button>
      )}
    </div>
  );
}

type SetLogin = (l: DeviceLoginView | null | ((cur: DeviceLoginView | null) => DeviceLoginView | null)) => void;

/**
 * A login that is under way, shown under the card (the card's own button starts it): Codex with a device code (link +
 * code here), Claude Code with its sign-in link and the code from that page pasted back here. The login stays with the
 * CLI: TeamBot never reads or keeps it. `terminal`: this CLI only logs in through a terminal window; TeamBot opens it
 * with the exact command.
 */
export function LoginBox({ id, label, command, desktop, login, setLogin, terminal }: { id: string; label: string; command: string; desktop: boolean; login: DeviceLoginView | null; setLogin: SetLogin; terminal?: boolean }) {
  const act = useAsync();
  const [pasted, setPasted] = useState('');
  const waiting = !!login && (login.state === 'starting' || login.state === 'waiting');
  const cancel = (
    <Button size="sm" variant="ghost" onClick={() => act.run(async () => (await api.del(`/cli-agents/${id}/login`), setLogin(null)))}>
      Annuleren
    </Button>
  );
  if (!waiting) {
    if (!terminal) return null;
    return (
      <div className="space-y-2 rounded-lg bg-surface-2 p-3 text-sm" data-testid={`login-${id}`}>
        <p className="text-[13px]">{label} logt in via een terminal. Log daar in en klik daarna op “Opnieuw zoeken”.</p>
        <TerminalLogin id={id} command={command} desktop={desktop} />
      </div>
    );
  }
  const link = login!.url && (
    <a className="inline-flex items-center gap-1 font-semibold text-accent underline" href={login!.url} target="_blank" rel="noreferrer">
      de inlogpagina <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
  if (login!.url && login!.needsCode) {
    // Claude Code: sign in on its page (own browser, also on the phone), then paste the code it shows here.
    const send = () =>
      act.run(async () => {
        const r = await api.post<{ login: DeviceLoginView }>(`/cli-agents/${id}/login/code`, { code: pasted.trim() });
        // A CLI that rejects the code at once ends (event "cli.login") before this answer arrives: keep that outcome
        // instead of going back to "Code wordt gecontroleerd…" for good.
        setLogin((cur) => (cur && cur.state !== 'starting' && cur.state !== 'waiting' ? cur : r.login));
        setPasted('');
      });
    return (
      <div className="space-y-2 rounded-lg bg-surface-2 p-3 text-sm" data-testid={`login-${id}`}>
        <ol className="list-decimal space-y-2 ps-5 text-[13px]">
          <li>Log in op {link}.</li>
          <li>
            Plak hier de code die je daar krijgt:
            <form
              className="mt-1 flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (pasted.trim()) send();
              }}
            >
              <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Code van de inlogpagina" aria-label="Code van de inlogpagina" autoComplete="off" spellCheck={false} translate="no" className="min-w-0 flex-1 font-mono" disabled={login!.checking} />
              <Button size="sm" variant="primary" type="submit" loading={act.busy || login!.checking} disabled={!pasted.trim() || login!.checking}>
                Koppelen
              </Button>
            </form>
          </li>
        </ol>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {login!.checking ? (
            <>
              <Spinner /> Code wordt gecontroleerd…
            </>
          ) : (
            `TeamBot geeft de code één keer door aan ${label} en bewaart hem niet.`
          )}
          {cancel}
        </div>
        <details className="text-xs text-muted">
          <summary className="cursor-pointer font-semibold hover:text-fg">Liever in een terminal?</summary>
          <div className="mt-1.5">
            <TerminalLogin id={id} command={command} desktop={desktop} />
          </div>
        </details>
      </div>
    );
  }
  if (login!.url && login!.code)
    return (
      <div className="space-y-2 rounded-lg bg-surface-2 p-3 text-sm" data-testid={`login-${id}`}>
        <ol className="list-decimal space-y-2 ps-5 text-[13px]">
          <li>Log in op {link}.</li>
          <li>
            Vul daar deze code in:
            <div className="mt-1 flex items-center gap-2">
              <code className="rounded-md bg-surface px-2.5 py-1 font-mono text-lg font-bold tracking-widest" translate="no">
                {login!.code}
              </code>
              <Button size="icon" variant="ghost" aria-label="Code kopiëren" onClick={() => copy(login!.code!)}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </li>
        </ol>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Spinner /> TeamBot koppelt zodra je klaar bent. Deel deze code met niemand.
          {cancel}
        </div>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 p-3 text-xs text-muted" data-testid={`login-${id}`}>
      <Spinner /> Inlogpagina wordt klaargezet…
      {cancel}
    </div>
  );
}
