import { useState } from 'react';
import { AlertTriangle, KeyRound, PlugZap, Server, ShieldCheck } from 'lucide-react';
import { Badge, Button, Field, Input, Textarea, Toggle, useAsync } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { computers, type RemoteConfig } from './api';
import type { RemoteTestResult } from '../../../../shared/computers.js';
import { t } from '../../lib/i18n';
import { MoreInfo } from '../../components/MoreInfo';

export interface RemoteCredentialDraft {
  kind: 'key' | 'password';
  value: string;
}

const num = (v: string) => (v === '' ? 0 : Number(v));
/** The folder TeamBot picks on the server ("teambot/ag_<id>"): never shown with its internal id. */
const OWN_REMOTE_DIR = /(^|[\\/])teambot[\\/][a-z]{1,6}_[0-9a-f]{12,}$/i;

/**
 * Settings for computer mode "Eigen server (SSH)". The key/password field is write-only: what is stored never comes
 * back to the browser. Trust-on-first-use is explicit: test → compare the fingerprint → "Vertrouwen".
 */
export function RemoteSection({
  agentId,
  draft,
  stored,
  onChange,
  cred,
  onCred,
  persist,
  reload,
}: {
  agentId: string;
  draft: RemoteConfig;
  stored: RemoteConfig;
  onChange(r: RemoteConfig): void;
  cred: RemoteCredentialDraft;
  onCred(c: RemoteCredentialDraft): void;
  /** Saves the whole computer config (incl. a newly typed key/password). Resolves false when saving failed. */
  persist(): Promise<boolean>;
  reload(): void;
}) {
  const { busy, run } = useAsync();
  const [test, setTest] = useState<RemoteTestResult | null>(null);
  const [sure, setSure] = useState(false);
  const set = (p: Partial<RemoteConfig>) => onChange({ ...draft, ...p });

  const doTest = () =>
    run(async () => {
      setTest(null);
      setSure(false);
      if (!(await persist())) return;
      setTest(await computers.remoteTest(agentId));
    });
  const trust = (fingerprint: string) =>
    run(async () => {
      await computers.remoteTrust(agentId, fingerprint);
      setSure(false);
      reload();
      setTest(await computers.remoteTest(agentId));
    }, 'Serversleutel vertrouwd');
  const untrust = () =>
    run(async () => {
      await computers.remoteTrust(agentId, null);
      setTest(null);
      reload();
    }, 'Vingerafdruk vergeten; test de verbinding opnieuw');
  const forget = () =>
    run(async () => {
      await computers.remoteForget(agentId);
      reload();
    }, 'Sleutel of wachtwoord verwijderd');

  const configured = !!(stored.host && stored.username);
  const state = !configured
    ? { tone: 'warn' as const, text: 'Nog niet ingesteld: vul adres en gebruikersnaam in en sla op.' }
    : !stored.has_secret
      ? { tone: 'warn' as const, text: 'Nog geen sleutel of wachtwoord opgeslagen.' }
      : !stored.fingerprint
        ? { tone: 'warn' as const, text: 'Serversleutel nog niet vertrouwd: test de verbinding en controleer de vingerafdruk.' }
        : { tone: 'ok' as const, text: `Klaar voor gebruik: ${stored.username}@${stored.host}` };

  return (
    <div className="space-y-3 rounded-xl border border-line p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Server className="h-4 w-4" aria-hidden /> Eigen server (SSH)
      </div>
      <div className="flex items-start gap-2 rounded-control border border-warn bg-warn-soft p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
        <p className="min-w-0">
          <span className="font-semibold">De bot mag op de server alles wat deze gebruiker mag.</span> Maak dus een aparte gebruiker zonder sudo.{' '}
          <MoreInfo>
            Opdrachten van de bot draaien met alle rechten van de SSH-gebruiker die je hier invult. Of zet hieronder “Opdrachten in Docker” aan. De bestandstools blijven binnen de map hieronder. TeamBot stuurt geen eigen sleutels, wachtwoorden of instellingen naar
            de server; alleen de opdrachten en bestanden van de bot.
          </MoreInfo>
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <Field label="Adres van de server" hint="Naam of IP-adres, zonder gebruikersnaam of poort.">
          <Input value={draft.host} onChange={(e) => set({ host: e.target.value })} placeholder="vps.example.nl" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Poort">
          <Input type="number" min={1} max={65535} value={draft.port} onChange={(e) => set({ port: num(e.target.value) })} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Gebruikersnaam" hint="Bij voorkeur een aparte gebruiker zonder sudo, bijv. teambot.">
          <Input value={draft.username} onChange={(e) => set({ username: e.target.value })} placeholder="teambot" autoComplete="off" spellCheck={false} />
        </Field>
        <Field
          label="Map op de server"
          hint={
            <>
              Leeg = automatisch.{' '}
              <MoreInfo>
                {stored.workdir && !OWN_REMOTE_DIR.test(stored.workdir)
                  ? t('Leeg = {0} in de thuismap. Of een absoluut pad. De bestandstools blijven binnen deze map.', stored.workdir)
                  : 'Leeg = een eigen map voor deze bot in de map teambot in de thuismap. Of een absoluut pad. De bestandstools blijven binnen deze map.'}
              </MoreInfo>
            </>
          }
        >
          <Input value={draft.dir} onChange={(e) => set({ dir: e.target.value })} placeholder="Automatisch" autoComplete="off" spellCheck={false} />
        </Field>
      </div>

      <div className="space-y-2">
        <Field label="Inloggen met">
          <Select value={cred.kind} onChange={(e) => onCred({ kind: e.target.value === 'password' ? 'password' : 'key', value: '' })}>
            <option value="key">Privésleutel (aanbevolen)</option>
            <option value="password">Wachtwoord</option>
          </Select>
        </Field>
        {cred.kind === 'key' ? (
          <Field
            label={stored.has_secret ? 'Nieuwe privésleutel (laat leeg om de opgeslagen te houden)' : 'Privésleutel'}
            hint={
              <>
                Versleuteld bewaard en nooit meer getoond. <MoreInfo>Plak de privésleutel (zonder wachtwoordzin). De bot ziet hem niet.</MoreInfo>
              </>
            }
          >
            <Textarea rows={3} value={cred.value} onChange={(e) => onCred({ ...cred, value: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" autoComplete="off" spellCheck={false} className="font-mono text-xs" />
          </Field>
        ) : (
          <Field label={stored.has_secret ? 'Nieuw wachtwoord (laat leeg om het opgeslagen te houden)' : 'Wachtwoord'} hint="Versleuteld bewaard en nooit meer getoond. Een sleutel is veiliger.">
            <Input type="password" value={cred.value} onChange={(e) => onCred({ ...cred, value: e.target.value })} autoComplete="new-password" />
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {stored.has_secret ? (
            <Badge tone="ok">
              <KeyRound className="h-3 w-3" aria-hidden /> {stored.auth === 'password' ? 'Wachtwoord' : 'Sleutel'} opgeslagen
            </Badge>
          ) : (
            <Badge tone="warn">Nog geen sleutel of wachtwoord opgeslagen</Badge>
          )}
          {stored.has_secret && (
            <Button size="sm" variant="ghost" onClick={forget} loading={busy}>
              Vergeten
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Toggle checked={draft.docker.enabled} onChange={(v) => set({ docker: { ...draft.docker, enabled: v } })} label="Opdrachten in Docker op de server draaien" />
        {draft.docker.enabled && (
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem_8rem]">
            <Field
              label="Image"
              hint={
                <MoreInfo>
                  Zonder netwerk; alleen de map hierboven is gedeeld. Docker moet op de server staan en de SSH-gebruiker moet hem mogen gebruiken. Wie Docker mag gebruiken is in de praktijk beheerder van die server: bewaar de sleutel dus goed. De bot zelf komt niet buiten
                  de container.
                </MoreInfo>
              }
            >
              <Input value={draft.docker.image} onChange={(e) => set({ docker: { ...draft.docker, image: e.target.value } })} spellCheck={false} />
            </Field>
            <Field label="Geheugen (MB)">
              <Input type="number" min={128} max={65536} value={draft.docker.memoryMb} onChange={(e) => set({ docker: { ...draft.docker, memoryMb: num(e.target.value) } })} />
            </Field>
            <Field label="Processors">
              <Input type="number" min={0.25} max={64} step={0.25} value={draft.docker.cpus} onChange={(e) => set({ docker: { ...draft.docker, cpus: num(e.target.value) } })} />
            </Field>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Max. duur per opdracht (s)">
          <Input type="number" min={1} max={3600} value={draft.limits.timeoutSec} onChange={(e) => set({ limits: { ...draft.limits, timeoutSec: num(e.target.value) } })} />
        </Field>
        <Field label="Max. uitvoer per opdracht (kB)">
          <Input type="number" min={1} max={1024} value={draft.limits.maxOutputKb} onChange={(e) => set({ limits: { ...draft.limits, maxOutputKb: num(e.target.value) } })} />
        </Field>
        <Field label="Max. bestand bij up-/downloaden (MB)">
          <Input type="number" min={1} max={500} value={draft.limits.transferMb} onChange={(e) => set({ limits: { ...draft.limits, transferMb: num(e.target.value) } })} />
        </Field>
      </div>

      <div className="space-y-2 rounded-control border border-line bg-surface-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <Badge tone={state.tone}>{state.tone === 'ok' ? 'Klaar' : 'Nog niet klaar'}</Badge>
            <span>{state.text}</span>
          </div>
          <Button size="sm" icon={<PlugZap className="h-4 w-4" />} onClick={doTest} loading={busy}>
            Verbinding testen
          </Button>
        </div>
        {stored.fingerprint && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <ShieldCheck className="h-3 w-3 text-ok" aria-hidden /> Vertrouwde serversleutel: <code className="break-all font-mono text-fg">{stored.fingerprint}</code>
            <Button size="sm" variant="ghost" onClick={untrust} loading={busy}>
              Vergeten
            </Button>
          </div>
        )}
        <div aria-live="polite">{test && <TestOutcome test={test} sure={sure} setSure={setSure} trust={trust} busy={busy} dockerWanted={draft.docker.enabled} />}</div>
        <MoreInfo block>
          TeamBot logt pas in nadat jij de vingerafdruk van de server hebt vertrouwd. Verandert de sleutel later (bijv. door een onderschepte verbinding of een herinstallatie), dan stopt alles tot je hem opnieuw controleert. Alleen Linux- en macOS-servers (sh,
          bash of zsh) worden ondersteund.
        </MoreInfo>
      </div>
    </div>
  );
}

function TestOutcome({ test, sure, setSure, trust, busy, dockerWanted }: { test: RemoteTestResult; sure: boolean; setSure(v: boolean): void; trust(fp: string): void; busy: boolean; dockerWanted: boolean }) {
  if (test.mismatch && test.fingerprint)
    return (
      <div className="space-y-2 rounded-lg border border-danger bg-danger-soft p-3 text-sm" role="alert">
        <div className="flex items-center gap-2 font-medium text-danger">
          <AlertTriangle className="h-4 w-4" aria-hidden /> De sleutel van de server is veranderd
        </div>
        <p>{test.error}</p>
        <div className="space-y-1 text-xs">
          <div>
            Vertrouwd: <code className="break-all font-mono">{test.expected}</code>
          </div>
          <div>
            Nu: <code className="break-all font-mono">{test.fingerprint}</code>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
          Ik weet waarom de sleutel veranderd is (bijv. server opnieuw geïnstalleerd) en heb de nieuwe vingerafdruk gecontroleerd
        </label>
        <Button size="sm" variant="danger" disabled={!sure} loading={busy} onClick={() => trust(test.fingerprint!)}>
          Nieuwe sleutel vertrouwen
        </Button>
      </div>
    );
  if (!test.trusted && test.fingerprint)
    return (
      <div className="space-y-2 rounded-lg border border-line bg-surface p-3 text-sm">
        <div className="font-medium">Vingerafdruk van de server</div>
        <code className="block break-all rounded-md bg-surface-2 px-2 py-1 font-mono text-xs">{test.fingerprint}</code>
        <p className="text-xs text-muted">
          Vergelijk dit met de server zelf, bijvoorbeeld met <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> (of de vingerafdruk van je hostingpartij). Klik pas op Vertrouwen als ze gelijk zijn.
          Er is nog niet ingelogd.
        </p>
        <Button size="sm" variant="primary" icon={<ShieldCheck className="h-4 w-4" />} loading={busy} onClick={() => trust(test.fingerprint!)}>
          Vertrouwen
        </Button>
      </div>
    );
  if (!test.ok)
    return (
      <p className="text-sm text-danger" role="alert">
        {test.error || 'De verbinding is mislukt.'}
      </p>
    );
  const d = test.docker;
  return (
    <div className="space-y-1 rounded-lg border border-ok bg-ok-soft p-3 text-sm">
      <div className="font-medium text-ok">
        Verbonden als {test.username}@{test.host}
      </div>
      <div>Systeem: {test.os}</div>
      <div className={dockerWanted && !d?.usable ? 'text-warn' : undefined}>
        {d?.usable
          ? `Docker ${d.version || ''} is beschikbaar voor deze gebruiker.`
          : d?.installed
            ? 'Docker staat op de server, maar deze gebruiker mag hem niet gebruiken (bijv. niet in de groep docker).'
            : 'Docker staat niet op de server.'}
        {dockerWanted && !d?.usable ? ' Opdrachten in Docker werken zo niet.' : ''}
      </div>
    </div>
  );
}
