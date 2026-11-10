import type React from 'react';
import { useEffect, useState } from 'react';
import { Check, Eye, EyeOff, FileUp, Globe, KeyRound, LockOpen, MonitorPlay, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { agentById, useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { useIsDesktop } from '../../lib/media';
import type { Approval } from '../../lib/types';
import { BotAvatar } from '../../components/BotFace';
import { Badge, Button, Card, cx, EmptyState, Field, Input, Modal, Page, PageHeader, Spinner, Textarea, timeAgo, toastError, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { Menu, SkeletonRows } from '../../components/overview';
import { t } from '../../lib/i18n';
import { useLive, vault, type VaultDraft, type VaultEntry } from './api';
import { openDock } from './BrowserDock';
import { hostOf, SiteMark } from './SiteMark';
import { VaultImportDialog } from './VaultImport';
import { ComputerOnly, useIsPhoneSession } from '../../shell/computerOnly';
import { ScriptKeysOverview } from '../script-keys/Overview';

/** "Kluis": the owner's site logins. TeamBot fills them in itself; bots never see a password or a 2FA code. */
const HOW = (
  <>
    Moet een bot inloggen, dan vraagt TeamBot jou eerst om toestemming en vult het de gegevens (en een 2FA-code) zelf in. De bot hoort alleen of het gelukt is. Dat gebeurt alleen op precies het adres dat je opgeeft: een nagemaakte site of een ander subdomein
    krijgt niets. Alles staat versleuteld op deze computer.
  </>
);

/** The page with the logins: the list, and "Login toevoegen" / "Importeren" in the header. */
function VaultList({ children }: { children?: React.ReactNode }) {
  const list = useLive(() => vault.list(), ['vault.updated'], []);
  const agents = useApp((s) => s.agents);
  const { busy, run } = useAsync();
  const [edit, setEdit] = useState<VaultEntry | 'new' | null>(null);
  const [del, setDel] = useState<VaultEntry | null>(null);
  const [importing, setImporting] = useState(false);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name || 'verwijderde bot';
  return (
    <>
      <PageHeader
        title="Kluis"
        subtitle="Logins waarmee je bots mogen inloggen. Een bot ziet je wachtwoord nooit."
        back={{ href: '#/m/browser', label: 'Computers' }}
        actions={
          <>
            {!!list.data?.length && (
              <Button icon={<FileUp className="h-4 w-4" />} onClick={() => setImporting(true)}>
                Importeren
              </Button>
            )}
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')}>
              Login toevoegen
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 px-4 pb-8 pt-3 sm:px-6">
      {list.loading && !list.data ? (
        <SkeletonRows n={3} />
      ) : list.error ? (
        <EmptyState icon={<KeyRound />} title="De kluis kon niet laden" action={<Button onClick={list.reload}>Opnieuw</Button>}>
          {list.error}
        </EmptyState>
      ) : !list.data?.length ? (
        <Card>
          <EmptyState
            icon={<KeyRound />}
            title="Nog geen logins in de kluis"
            action={
              <Button icon={<FileUp className="h-4 w-4" />} onClick={() => setImporting(true)}>
                Importeren uit een wachtwoordbeheerder
              </Button>
            }
          >
            Voeg een login toe voor een site waar je bots moeten inloggen, of haal ze op uit je wachtwoordbeheerder.
          </EmptyState>
        </Card>
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {list.data.map((e) => (
            <li key={e.id} className="tb-in flex items-start gap-3 px-4 py-3">
              <SiteMark origin={e.origins[0]} />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{e.label}</span>
                  {e.has_totp && (
                    <Badge tone="ok">
                      <Check className="h-3 w-3" aria-hidden /> 2FA-code
                    </Badge>
                  )}
                  {e.insecure && (
                    <Badge tone="warn">
                      <LockOpen className="h-3 w-3" aria-hidden /> Niet versleuteld (http)
                    </Badge>
                  )}
                </div>
                <div className="text-[13px] text-muted [overflow-wrap:anywhere]" translate="no">
                  {e.username || 'geen gebruikersnaam'}
                </div>
                <div className="flex flex-wrap gap-1">
                  {e.origins.map((o) => (
                    <code key={o} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px]" translate="no">
                      {hostOf(o)}
                    </code>
                  ))}
                </div>
                <div className="text-xs text-muted">
                  {e.agent_ids.length ? `Alleen voor: ${e.agent_ids.map(nameOf).join(', ')}` : 'Alle bots mogen erom vragen'}
                  {e.last_used_at ? ` · laatst gebruikt ${timeAgo(e.last_used_at)}` : ''}
                </div>
                {e.grants.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <span className="text-xs text-muted">Altijd toegestaan:</span>
                    {e.grants.map((g) => (
                      <span key={g.agent_id + g.origin} className="inline-flex items-center gap-1 rounded-full bg-surface-3 py-0.5 ps-2 pe-0.5 text-xs">
                        {nameOf(g.agent_id)} · {hostOf(g.origin)}
                        <button
                          type="button"
                          className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-line coarse:h-8 coarse:w-8"
                          aria-label={`Altijd toestaan intrekken voor ${nameOf(g.agent_id)}`}
                          onClick={() => run(() => vault.revoke(e.id, g.agent_id), 'Ingetrokken: er wordt weer om toestemming gevraagd').then(list.reload)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <Menu
                label={t('Meer opties voor {0}', e.label)}
                items={[
                  { label: 'Bewerken', icon: <Pencil />, onSelect: () => setEdit(e) },
                  { label: 'Verwijderen', icon: <Trash2 />, danger: true, onSelect: () => setDel(e) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
        <MoreInfo block label="Hoe de kluis werkt">
          {HOW}
        </MoreInfo>
        {children}
      </div>
      {edit && <VaultEditor entry={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), list.reload())} />}
      {importing && <VaultImportDialog onClose={() => setImporting(false)} onImported={list.reload} />}
      <Modal
        open={!!del}
        onClose={() => setDel(null)}
        title={`Login verwijderen: ${del?.label || ''}`}
        footer={
          <>
            <Button onClick={() => setDel(null)}>Annuleren</Button>
            <Button variant="danger" loading={busy} onClick={() => run(() => vault.remove(del!.id), 'Login verwijderd').then(() => (setDel(null), list.reload()))}>
              Verwijderen
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed">Gebruikersnaam, wachtwoord en 2FA-sleutel worden uit de kluis verwijderd. Bots die al ingelogd zijn blijven dat.</p>
      </Modal>
    </>
  );
}

function VaultEditor({ entry, onClose, onSaved }: { entry: VaultEntry | null; onClose(): void; onSaved(): void }) {
  const agents = useApp((s) => s.agents);
  const { busy, run } = useAsync();
  const [label, setLabel] = useState(entry?.label || '');
  const [origins, setOrigins] = useState(entry?.origins.join('\n') || '');
  const [username, setUsername] = useState(entry?.username || '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [totp, setTotp] = useState('');
  const [dropTotp, setDropTotp] = useState(false);
  const [bots, setBots] = useState<string[]>(entry?.agent_ids || []);
  const browserBots = agents.filter((a) => a.tool_groups?.includes('browser') || bots.includes(a.id));
  const save = () =>
    run(async () => {
      const d: VaultDraft = { label, origins, username, agent_ids: bots };
      if (password) d.password = password;
      if (totp.trim()) d.totp = totp.trim();
      else if (dropTotp) d.totp = null;
      if (entry) await vault.update(entry.id, d);
      else await vault.create(d);
      setPassword('');
      setTotp('');
      onSaved();
    }, entry ? 'Login bijgewerkt' : 'Login in de kluis gezet');
  return (
    <Modal
      open
      onClose={onClose}
      title={entry ? `Login bewerken: ${entry.label}` : 'Login toevoegen aan de kluis'}
      footer={
        <>
          <Button onClick={onClose}>Annuleren</Button>
          <Button variant="primary" loading={busy} disabled={!origins.trim() || (!entry && !password)} onClick={save}>
            {entry ? 'Opslaan' : 'Toevoegen'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Websites" hint="Het exacte adres waar je inlogt, één per regel. TeamBot vult alleen in op precies deze adressen.">
          <Textarea rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://accounts.google.com" spellCheck={false} />
        </Field>
        <Field label="Naam (optioneel)" hint="Zo herken je de login, bijv. “Google Ads zakelijk”.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Bijv. Webwinkel" />
        </Field>
        <Field label="Gebruikersnaam of e-mailadres">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} />
        </Field>
        <Field label="Wachtwoord" hint={entry?.has_password ? 'Opgeslagen. Laat leeg om het te houden; het wordt nooit getoond.' : 'Gaat één keer naar TeamBot en wordt versleuteld bewaard. Je ziet het hierna niet meer terug.'}>
          <div className="relative">
            <Input aria-label="Wachtwoord" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" data-1p-ignore data-lpignore="true" placeholder={entry?.has_password ? '••••••••' : ''} className="pe-11" />
            <button type="button" className="absolute end-1 top-1/2 flex h-7 w-9 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-fg coarse:h-9" aria-label={show ? 'Wachtwoord verbergen' : 'Wachtwoord tonen'} onClick={() => setShow(!show)}>
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>
        <Field
          label="2FA-sleutel (optioneel)"
          hint={
            entry?.has_totp && !dropTotp
              ? 'Er is een 2FA-sleutel opgeslagen. Vul een nieuwe in om hem te vervangen.'
              : 'De geheime sleutel uit de QR-code van de site. Laat leeg als je de code zelf invult.'
          }
        >
          <Input value={totp} onChange={(e) => setTotp(e.target.value)} autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} placeholder={entry?.has_totp && !dropTotp ? '•••• •••• (opgeslagen)' : 'Bijv. JBSW Y3DP EHPK 3PXP'} />
        </Field>
        {entry?.has_totp && !totp && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dropTotp} onChange={(e) => setDropTotp(e.target.checked)} />
            2FA-sleutel verwijderen
          </label>
        )}
        <fieldset className="space-y-1.5">
          <legend className="text-[13px] font-semibold">Welke bots mogen erom vragen</legend>
          <p className="text-xs text-muted">Niets aangevinkt = al je bots. Ze krijgen de login nooit te zien; jij keurt elk gebruik goed.</p>
          {browserBots.length === 0 ? (
            <p className="text-xs text-muted">Nog geen bots met een eigen browser.</p>
          ) : (
            <div className="grid gap-1 sm:grid-cols-2">
              {browserBots.map((a) => (
                <label key={a.id} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm', bots.includes(a.id) ? 'border-line-strong bg-surface-2' : 'border-line')}>
                  <input type="checkbox" checked={bots.includes(a.id)} onChange={(e) => setBots(e.target.checked ? [...bots, a.id] : bots.filter((x) => x !== a.id))} />
                  <BotAvatar bot={a} size={20} />
                  <span className="truncate">{a.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** #/m/browser/kluis: the site logins, and below them every "Sleutel voor scripts" (computer only, like the vault). */
export function VaultPage() {
  // The vault opens on the computer only (server/modules/mobile/policy.ts): a paired phone gets the reason, not a list
  // that cannot load or buttons that can only fail.
  const phone = useIsPhoneSession();
  return (
    <Page>
      {phone ? (
        <>
          <PageHeader title="Kluis" subtitle="Logins waarmee je bots mogen inloggen. Een bot ziet je wachtwoord nooit." back={{ href: '#/m/browser', label: 'Computers' }} />
          <div className="mx-auto max-w-4xl space-y-3 px-4 pb-8 pt-3 sm:px-6">
            <ComputerOnly>De kluis met wachtwoorden open je alleen op je computer.</ComputerOnly>
            <MoreInfo block label="Hoe de kluis werkt">
              {HOW}
            </MoreInfo>
          </div>
        </>
      ) : (
        <VaultList>
          <div className="pt-4">
            <ScriptKeysOverview />
          </div>
        </VaultList>
      )}
    </Page>
  );
}

// ---------------- approval cards ----------------

function useDecide(a: Approval) {
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (decision: 'approve' | 'deny' | 'always', answer?: string, key: string = decision) => {
    setBusy(key);
    try {
      await api.post(`/approvals/${a.id}`, { decision, answer });
      useApp.setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== a.id) }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  return { busy, decide };
}

function Meta({ a, showThreadLink, verb }: { a: Approval; showThreadLink?: boolean; verb: string }) {
  const agent = agentById(a.agent_id);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <BotAvatar bot={agent || { id: a.agent_id || 'bot', name: 'bot' }} size={20} mood="waiting" />
      <span>
        <span className="font-semibold text-fg">{agent?.name || 'Bot'}</span> {verb}
      </span>
      <span aria-hidden>·</span>
      <span>{timeAgo(a.created_at)}</span>
      {showThreadLink && a.thread_id && (
        <>
          <span aria-hidden>·</span>
          <a className="font-semibold underline underline-offset-2 hover:text-fg" href={`#/t/${a.thread_id}`}>
            naar gesprek
          </a>
        </>
      )}
    </div>
  );
}

const SELF = 'Zelf inloggen';

/**
 * "Operations wil inloggen op ads.google.com als …": approve once, always for this bot on this site, log in
 * yourself, or refuse. The bot never gets the account or the password, only "ingelogd" / "mislukt".
 */
export function VaultLoginCard({ a, showThreadLink }: { a: Approval; showThreadLink?: boolean }) {
  // "Altijd toestaan" only on the computer: a paired phone approves once (server/modules/mobile/policy.ts).
  const wide = useIsDesktop();
  const phone = useIsPhoneSession();
  const desktop = wide && !phone;
  const agent = agentById(a.agent_id);
  const accounts: { id: string; label: string; account: string; totp: boolean; option: string }[] = Array.isArray(a.input?.accounts) ? a.input.accounts : [];
  const [pick, setPick] = useState(accounts[0]?.option || '');
  useEffect(() => {
    if (!pick && accounts[0]) setPick(accounts[0].option);
  }, [accounts, pick]);
  const { busy, decide } = useDecide(a);
  const chosen = accounts.find((x) => x.option === pick) || accounts[0];
  const site = String(a.input?.site || '');
  const origin = String(a.input?.origin || '');
  return (
    <div role="group" aria-label="Inloggen met de kluis" className="w-full rounded-2xl border tb-ask p-4">
      <Meta a={a} showThreadLink={showThreadLink} verb="vraagt toestemming" />
      <div className="mt-3 flex items-start gap-3">
        <span className="relative">
          <SiteMark origin={origin || 'https://' + site} size={40} />
          <span className="absolute -bottom-1 -end-1 flex h-5 w-5 items-center justify-center rounded-full bg-surface ring-2 ring-surface">
            <KeyRound className="h-3.5 w-3.5" aria-hidden />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold leading-snug">
            {agent?.name || 'De bot'} wil inloggen op <span translate="no">{site}</span>
          </div>
          {accounts.length === 1 && (
            <div className="mt-0.5 truncate text-[13.5px] text-muted">
              als <span className="font-semibold text-fg" translate="no">{chosen?.account}</span>
              {chosen?.totp ? ' · met 2FA-code' : ''}
            </div>
          )}
          {a.input?.reason && <div className="mt-1 text-[13px] italic text-muted">“{String(a.input.reason)}”</div>}
        </div>
      </div>
      {accounts.length > 1 && (
        <fieldset className="mt-3 space-y-1.5">
          <legend className="mb-1 text-[13px] font-semibold">Met welk account?</legend>
          {accounts.map((x) => (
            <label key={x.id} className={cx('flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-sm', pick === x.option ? 'border-line-strong bg-surface' : 'border-line')}>
              <input type="radio" name={`acct-${a.id}`} checked={pick === x.option} onChange={() => setPick(x.option)} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-semibold" translate="no">
                  {x.account}
                </span>
                <span className="text-muted"> · {x.label}</span>
              </span>
              {x.totp && <Badge tone="ok">2FA</Badge>}
            </label>
          ))}
        </fieldset>
      )}
      <div className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted">
        <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-fg" aria-hidden />
        <span>
          TeamBot vult je gegevens zelf in, alleen op <code translate="no">{hostOf(origin) || site}</code>. {agent?.name || 'De bot'} ziet je wachtwoord{chosen?.totp ? ' en de code' : ''} niet en hoort alleen of het gelukt is.
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" icon={<KeyRound className="h-4 w-4" />} loading={busy === 'approve'} disabled={!!busy || !chosen} onClick={() => decide('approve', chosen!.option)}>
          Inloggen
        </Button>
        {desktop && (
          <Button size="sm" loading={busy === 'always'} disabled={!!busy || !chosen} onClick={() => decide('always', chosen!.option)} title={`${agent?.name || 'Deze bot'} mag deze login op ${site} voortaan zonder te vragen gebruiken (intrekken kan in de Kluis)`}>
            Altijd toestaan voor {agent?.name || 'deze bot'} op deze site
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={busy === 'self'} disabled={!!busy} onClick={() => decide('approve', SELF, 'self')}>
          Zelf inloggen
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'deny'} disabled={!!busy} onClick={() => decide('deny')}>
          Weigeren
        </Button>
      </div>
    </div>
  );
}

/** The bot waits while you log in yourself (no vault login for this site): open its browser right here. */
export function LoginHandoffCard({ a, showThreadLink }: { a: Approval; showThreadLink?: boolean }) {
  const { busy, decide } = useDecide(a);
  const done = a.options?.[0] || 'Klaar, ik ben ingelogd';
  const later = a.options?.[1] || 'Niet nu';
  const openBrowser = () => {
    if (!a.agent_id) return;
    openDock(a.agent_id);
    if (showThreadLink && a.thread_id) navigate(`/t/${a.thread_id}`);
    else if (!a.thread_id) navigate(`/m/browser/live/${a.agent_id}`);
  };
  return (
    <div role="group" aria-label="Zelf inloggen" className="w-full rounded-2xl border tb-ask p-4">
      <Meta a={a} showThreadLink={showThreadLink} verb="wacht op jou" />
      <div className="mt-3 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-3">
          <Globe className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap text-[15px] font-bold leading-snug">{a.summary}</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="soft" size="sm" icon={<MonitorPlay className="h-4 w-4" />} onClick={openBrowser}>
          Open de browser
        </Button>
        <Button variant="primary" size="sm" icon={<Check className="h-4 w-4" />} loading={busy === 'approve'} disabled={!!busy} onClick={() => decide('approve', done)}>
          {done}
        </Button>
        <Button variant="ghost" size="sm" loading={busy === 'later'} disabled={!!busy} onClick={() => decide('approve', later, 'later')}>
          {later}
        </Button>
      </div>
    </div>
  );
}

