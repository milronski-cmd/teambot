import { useEffect, useState } from 'react';
import { Copy, KeyRound, Layers, ShieldCheck, Users } from 'lucide-react';
import { api } from '../lib/api';
import { askConfirm, Badge, Button, Card, Field, Input, Spinner, timeAgo, useAsync, CardHead, copyText } from '../components/ui';
import { translate, uiLocale } from '../lib/i18n';
import { Listbox } from '../components/Listbox';
import { MoreInfo } from '../components/MoreInfo';

interface SsoView {
  enabled: boolean;
  active: boolean;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  label: string;
  allowedDomains: string[];
  defaultRole: 'member' | 'admin';
  autoProvision: boolean;
  requireSso: boolean;
  publicUrl: string;
  publicBase: string;
  publicBaseSource: 'sso' | 'env' | 'request';
  redirectUri: string;
  scopes: string;
  canEditProvider: boolean;
}

interface Discovery {
  ok: boolean;
  error?: string;
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  userinfo_endpoint?: string | null;
  code_challenge_methods_supported?: string[] | null;
}

const EVENT_LABEL: Record<string, string> = {
  'sso.login': 'ingelogd met SSO',
  'sso.linked': 'account gekoppeld',
  'sso.provisioned': 'account aangemaakt via SSO',
  'sso.refused': 'geweigerd',
  'sso.config': 'SSO-instellingen gewijzigd',
  'scim.user.created': 'aangemaakt via SCIM',
  'scim.user.updated': 'bijgewerkt via SCIM',
  'scim.user.deactivated': 'geblokkeerd via SCIM',
  'scim.user.reactivated': 'gedeblokkeerd via SCIM',
  'scim.user.deleted': 'verwijderd via SCIM',
  'scim.user.restored': 'teruggezet via SCIM',
  'scim.token.created': 'SCIM-sleutel gemaakt',
  'scim.token.revoked': 'SCIM-sleutel ingetrokken',
  'scim.config': 'SCIM-instellingen gewijzigd',
  'scim.group.created': 'groep ontvangen via SCIM',
  'scim.group.renamed': 'groep hernoemd via SCIM',
  'scim.group.members': 'groepsleden gewijzigd via SCIM',
  'scim.group.deleted': 'groep verwijderd via SCIM',
  'scim.group.mapping': 'groepskoppeling gewijzigd',
  'scim.mapping.applied': 'groepsrechten toegepast',
  'scim.mapping.reapplied': 'groepsrechten opnieuw toegepast',
};
const REASON: Record<string, string> = {
  unknown: 'geen account',
  domain: 'domein niet toegestaan',
  unverified: 'e-mail niet bevestigd',
  noemail: 'geen e-mailadres',
  disabled: 'account geblokkeerd',
  state: 'verlopen of andere browser',
  provider: 'controle mislukt',
  handoff: 'inlogcode ongeldig',
  config: 'instellingen gewijzigd',
  error: 'fout',
  seats: 'geen plaats meer',
};

/** OIDC sign-in settings (TEAM-07). Provider fields are owner-only; admins can tune the rest. */
export function SsoCard() {
  const [v, setV] = useState<SsoView | null>(null);
  const [f, setF] = useState({ issuer: '', clientId: '', clientSecret: '', publicUrl: '', label: '', domains: '', defaultRole: 'member', enabled: false, autoProvision: false, requireSso: false });
  const [test, setTest] = useState<Discovery | null>(null);
  const [events, setEvents] = useState<any[] | null>(null);
  const a = useAsync();
  const t = useAsync();
  const fill = (x: SsoView) => {
    setV(x);
    setF({ issuer: x.issuer, clientId: x.clientId, clientSecret: '', publicUrl: x.publicUrl, label: x.label, domains: x.allowedDomains.join(', '), defaultRole: x.defaultRole, enabled: x.enabled, autoProvision: x.autoProvision, requireSso: x.requireSso });
  };
  const [failed, setFailed] = useState('');
  const loadEvents = () => api.get('/admin/sso/events').then(setEvents).catch(() => setEvents([]));
  useEffect(() => {
    api.get<SsoView>('/admin/sso').then(fill).catch((e) => setFailed(e.message));
    loadEvents();
  }, []);
  if (failed) return <Card className="p-5 text-sm text-muted">Inloggen met SSO is niet beschikbaar: {failed}</Card>;
  if (!v) return <Spinner />;
  const owner = v.canEditProvider;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const check = (k: 'enabled' | 'autoProvision' | 'requireSso') => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.checked });
  const save = () =>
    a.run(async () => {
      const body: any = { label: f.label, allowedDomains: f.domains, defaultRole: f.defaultRole, enabled: f.enabled, autoProvision: f.autoProvision, requireSso: f.requireSso };
      if (owner) {
        Object.assign(body, { issuer: f.issuer, clientId: f.clientId, publicUrl: f.publicUrl });
        if (f.clientSecret.trim()) body.clientSecret = f.clientSecret.trim();
      }
      if (f.requireSso && !v.requireSso && !(await askConfirm('Leden en beheerders kunnen dan niet meer met een wachtwoord inloggen. Heb je inloggen met SSO al getest? Doorgaan?'))) return;
      fill(await api.put<SsoView>('/admin/sso', body));
      loadEvents();
    }, 'SSO-instellingen opgeslagen');
  const runTest = () => t.run(async () => setTest(await api.post<Discovery>('/admin/sso/test', { issuer: f.issuer || v.issuer })));

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <CardHead icon={ShieldCheck} tone="rose" title="Inloggen met SSO" />
        {v.active ? <Badge tone="ok">aan</Badge> : <Badge>uit</Badge>}
        {v.active && v.requireSso && <Badge tone="warn">verplicht</Badge>}
      </div>
      <p className="text-xs text-muted">
        Inloggen met een werkaccount van Microsoft, Google of een andere provider. <MoreInfo>Inloggen met je bedrijfsaccount. Wachtwoorden blijven werken tenzij je SSO verplicht.</MoreInfo>
      </p>

      <div className="space-y-1 rounded-lg bg-surface-2 p-3 text-sm">
        <div className="font-medium">Registreer bij je provider</div>
        {v.redirectUri ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Redirect-URI:</span>
            <code className="break-all">{v.redirectUri}</code>
            <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copyText(v.redirectUri, 'Redirect-URI gekopieerd')}>
              Kopiëren
            </Button>
          </div>
        ) : (
          <div className="text-warn">Stel eerst het adres van TeamBot in.</div>
        )}
        <div>
          <span className="text-muted">Scopes:</span> <code>{v.scopes}</code> · <span className="text-muted">type:</span> webapp, authorization code met PKCE
        </div>
        {v.publicBaseSource === 'request' && <div className="text-xs text-warn">Dit adres is afgeleid van de huidige pagina. Vul hieronder het vaste adres in waarop iedereen TeamBot opent.</div>}
      </div>

      {!owner && <p className="text-xs text-muted">Alleen de eigenaar kan de provider instellen. De rest kun jij aanpassen.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Issuer-URL" hint="Bijv. https://login.microsoftonline.com/<tenant-id>/v2.0 of https://accounts.google.com">
          <Input value={f.issuer} onChange={set('issuer')} disabled={!owner} placeholder="https://…" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Client-ID">
          <Input value={f.clientId} onChange={set('clientId')} disabled={!owner} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Clientgeheim" hint={v.hasClientSecret ? 'Ingesteld en versleuteld opgeslagen; wordt nooit getoond. Laat leeg om het huidige te houden.' : 'Wordt versleuteld opgeslagen en is daarna niet meer zichtbaar.'}>
          <Input type="password" value={f.clientSecret} onChange={set('clientSecret')} disabled={!owner} autoComplete="new-password" placeholder={v.hasClientSecret ? '••••••••' : ''} />
        </Field>
        <Field label="Adres van TeamBot" hint={v.publicBaseSource === 'env' ? `Leeg = ${v.publicBase} (TEAMBOT_PUBLIC_URL).` : 'Het vaste adres (bij voorkeur https) waarop mensen TeamBot openen.'}>
          <Input value={f.publicUrl} onChange={set('publicUrl')} disabled={!owner} placeholder={v.publicBase || location.origin} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Tekst op de inlogknop">
          <Input value={f.label} onChange={set('label')} maxLength={60} placeholder="Inloggen met Microsoft" />
        </Field>
        <Field label="Toegestane e-maildomeinen" hint="Komma-gescheiden, bijv. bedrijf.nl. Leeg = elk domein, maar dan alleen voor accounts die al bestaan.">
          <Input value={f.domains} onChange={set('domains')} placeholder="bedrijf.nl" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Rol voor nieuwe accounts" hint="Alleen de eigenaar kan nieuwe accounts automatisch beheerder maken.">
          <Listbox value={f.defaultRole} onChange={(v) => setF({ ...f, defaultRole: v })} options={[{ value: 'member', label: translate('Lid') }, ...(owner || v.defaultRole === 'admin' ? [{ value: 'admin', label: translate('Beheerder') }] : [])]} />
        </Field>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm">
          <input type="checkbox" className="mt-1" checked={f.enabled} onChange={check('enabled')} />
          <span>
            <span className="font-medium">Inloggen met SSO aanzetten</span>
            <span className="block text-xs text-muted">Het inlogscherm toont dan de knop “{f.label || 'Inloggen met SSO'}”.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm">
          <input type="checkbox" className="mt-1" checked={f.autoProvision} onChange={check('autoProvision')} />
          <span>
            <span className="font-medium">Automatisch een account maken bij de eerste keer inloggen</span>
            <span className="block text-xs text-muted">Alleen voor e-mailadressen uit de toegestane domeinen.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-lg border border-danger/40 p-3 text-sm">
          <input type="checkbox" className="mt-1" checked={f.requireSso} onChange={check('requireSso')} />
          <span>
            <span className="font-medium">SSO verplichten</span>
            <span className="block text-xs text-muted">
              Inloggen met een wachtwoord kan dan niet meer. <MoreInfo>De eigenaar houdt het wachtwoord als noodtoegang. Bestaande sessies blijven geldig tot ze verlopen of je ze intrekt.</MoreInfo>
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={a.busy} onClick={save}>
          Opslaan
        </Button>
        <Button loading={t.busy} onClick={runTest} disabled={!(f.issuer || v.issuer)}>
          Discovery testen
        </Button>
      </div>

      {test && (
        <div className={`rounded-lg p-3 text-sm ${test.ok ? 'bg-ok-soft' : 'bg-danger-soft text-danger'}`} role="status">
          {test.ok ? (
            <>
            <div className="mb-1 font-medium text-ok">Discovery gelukt</div>
            <dl className="space-y-1">
              {(
                [
                  ['Issuer', test.issuer],
                  ['Inloggen', test.authorization_endpoint],
                  ['Token', test.token_endpoint],
                  ['Sleutels (JWKS)', test.jwks_uri],
                  ['Userinfo', test.userinfo_endpoint],
                  ['PKCE', test.code_challenge_methods_supported?.join(', ') || 'niet vermeld (meestal wel ondersteund)'],
                ] as const
              )
                .filter(([, val]) => val)
                .map(([k, val]) => (
                  <div key={k} className="flex flex-wrap gap-x-2">
                    <dt className="text-muted">{k}</dt>
                    <dd className="break-all font-mono text-xs leading-5">{val}</dd>
                  </div>
                ))}
            </dl>
            </>
          ) : (
            <span>Discovery mislukt: {test.error}</span>
          )}
        </div>
      )}

      <div>
        <h3 className="mb-1 text-sm font-semibold">Recente aanmeldingen en koppelingen</h3>
        {!events ? (
          <Spinner />
        ) : events.length === 0 ? (
          <p className="text-sm text-muted">Nog niets.</p>
        ) : (
          <ul className="scroll-thin max-h-64 divide-y divide-line overflow-y-auto">
            {events.slice(0, 30).map((e) => (
              <li key={e.id} className="py-1.5 text-xs">
                <span className="font-medium">{e.user_name || e.data?.email || e.data?.group || 'onbekend'}</span>{' '}
                <span className={e.kind === 'sso.refused' ? 'text-danger' : ''}>
                  {EVENT_LABEL[e.kind] || e.kind}
                  {e.kind === 'sso.refused' && e.data?.reason ? ` (${REASON[e.data.reason] || e.data.reason})` : ''}
                </span>{' '}
                <span className="text-muted">· {new Date(e.created_at).toLocaleString(uiLocale())}</span>
                {e.kind === 'sso.refused' && e.data?.error && <div className="truncate text-muted">{e.data.error}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

interface ScimView {
  endpoint: string;
  publicBaseSource: 'sso' | 'env' | 'request';
  token: { created_at: string; last_used_at: string | null; created_by: string | null } | null;
  deleteMode: 'deactivate' | 'delete';
  canEdit: boolean;
  newToken?: string;
}

/** SCIM 2.0 provisioning (Entra ID / Okta): endpoint, one bearer token (shown once), delete behaviour. */
export function ScimCard() {
  const [v, setV] = useState<ScimView | null>(null);
  const [fresh, setFresh] = useState('');
  const [failed, setFailed] = useState(false);
  const a = useAsync();
  useEffect(() => {
    api.get<ScimView>('/admin/scim').then(setV).catch(() => setFailed(true));
  }, []);
  if (failed) return null;
  if (!v) return <Spinner />;
  const create = () =>
    a.run(async () => {
      if (v.token && !(await askConfirm('De huidige SCIM-sleutel stopt dan meteen met werken. Nieuwe sleutel maken?'))) return;
      const r = await api.post<ScimView>('/admin/scim/token');
      setFresh(r.newToken || '');
      setV({ ...r, newToken: undefined });
    }, 'Nieuwe SCIM-sleutel gemaakt');
  const revoke = () =>
    a.run(async () => {
      if (!(await askConfirm('SCIM-sleutel intrekken? Je provider kan dan geen gebruikers meer bijwerken.', { danger: true }))) return;
      setFresh('');
      setV(await api.del<ScimView>('/admin/scim/token'));
    }, 'SCIM-sleutel ingetrokken');
  const setMode = (mode: string) =>
    a.run(async () => {
      if (mode === 'delete' && !(await askConfirm('Verwijdert je provider iemand, dan verdwijnen dat account en al zijn bots, gesprekken, bestanden en sleutels definitief. Doorgaan?', { danger: true }))) return;
      setV(await api.put<ScimView>('/admin/scim', { deleteMode: mode }));
    }, 'Opgeslagen');

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <CardHead icon={Users} tone="blue" title="Gebruikers koppelen (SCIM)" />
        {v.token ? <Badge tone="ok">actief</Badge> : <Badge>uit</Badge>}
      </div>
      <p className="text-xs text-muted">
        Je provider maakt, wijzigt en blokkeert accounts automatisch. <MoreInfo>Voor Microsoft Entra ID of Okta. Accounts via SCIM zijn altijd leden.</MoreInfo>
      </p>
      <Field label="SCIM-adres (Tenant URL)" hint={v.publicBaseSource === 'request' ? 'Afgeleid van de huidige pagina; stel bij “Inloggen met SSO” het vaste adres van TeamBot in.' : 'Vul dit in bij je provider, met de sleutel hieronder als “Secret Token”.'}>
        <div className="flex gap-2">
          <Input readOnly value={v.endpoint} onFocus={(e) => e.currentTarget.select()} spellCheck={false} aria-label="SCIM-adres (Tenant URL)" />
          <Button icon={<Copy className="h-4 w-4" />} onClick={() => copyText(v.endpoint, 'SCIM-adres gekopieerd')} aria-label="SCIM-adres kopiëren">
            Kopiëren
          </Button>
        </div>
      </Field>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <KeyRound className="h-4 w-4 text-muted" />
        {v.token ? (
          <span>
            Sleutel actief sinds {new Date(v.token.created_at).toLocaleDateString(uiLocale())}
            {v.token.created_by ? ` (door ${v.token.created_by})` : ''} · {v.token.last_used_at ? `laatst gebruikt ${timeAgo(v.token.last_used_at)}` : 'nog niet gebruikt'}
          </span>
        ) : (
          <span className="text-muted">Nog geen sleutel.</span>
        )}
      </div>
      {fresh && (
        <div className="space-y-2 rounded-lg bg-warn-soft p-3 text-sm" role="status">
          <div className="font-medium text-warn">Kopieer deze sleutel nu: hij wordt maar één keer getoond.</div>
          <div className="flex gap-2">
            <Input readOnly value={fresh} onFocus={(e) => e.currentTarget.select()} aria-label="Nieuwe SCIM-sleutel" spellCheck={false} className="font-mono" />
            <Button icon={<Copy className="h-4 w-4" />} onClick={() => copyText(fresh, 'Sleutel gekopieerd')}>
              Kopiëren
            </Button>
          </div>
        </div>
      )}
      {v.canEdit ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={a.busy} onClick={create}>
              {v.token ? 'Nieuwe sleutel maken' : 'Sleutel maken'}
            </Button>
            {v.token && (
              <Button variant="ghost" onClick={revoke}>
                Intrekken
              </Button>
            )}
          </div>
          <Field label="Als je provider iemand verwijdert">
            <Listbox
              value={v.deleteMode}
              onChange={(x) => setMode(x)}
              options={[
                { value: 'deactivate', label: translate('Account blokkeren, gegevens bewaren (aanbevolen)') },
                { value: 'delete', label: translate('Account en alle gegevens van die persoon verwijderen') },
              ]}
            />
          </Field>
        </>
      ) : (
        <p className="text-xs text-muted">Alleen de eigenaar kan de SCIM-sleutel maken of intrekken.</p>
      )}
    </Card>
  );
}

interface GroupMember {
  id: string;
  name: string;
  email: string | null;
  role: string;
  disabled: boolean;
}
interface GroupView {
  id: string;
  displayName: string;
  externalId: string | null;
  role: 'member' | 'admin';
  roomIds: string[];
  dailyBudgetUsd: number | null;
  members: GroupMember[];
  updatedAt: string;
}
interface GroupsData {
  groups: GroupView[];
  /** null = the rooms module is not loaded. */
  rooms: { id: string; name: string }[] | null;
  canEdit: boolean;
}

/** Group names per user id, for the small "via SCIM" hint in the Users list. */
export function useScimGroupHints(): Map<string, string[]> {
  const [m, setM] = useState<Map<string, string[]>>(new Map());
  useEffect(() => {
    api
      .get<GroupsData>('/admin/scim/groups')
      .then((d) => {
        const map = new Map<string, string[]>();
        for (const g of d.groups) for (const u of g.members) map.set(u.id, [...(map.get(u.id) || []), g.displayName]);
        setM(map);
      })
      .catch(() => {});
  }, []);
  return m;
}

/** SCIM groups pushed by the IdP, each mapped by the owner to a role, rooms and a per-member budget. */
export function ScimGroupsCard() {
  const [d, setD] = useState<GroupsData | null>(null);
  const [failed, setFailed] = useState(false);
  const a = useAsync();
  useEffect(() => {
    api.get<GroupsData>('/admin/scim/groups').then(setD).catch(() => setFailed(true));
  }, []);
  if (failed) return null;
  if (!d) return <Spinner />;
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <CardHead icon={Layers} tone="blue" title="Groepen uit je provider (SCIM)" />
        <Badge>{d.groups.length}</Badge>
      </div>
      <p className="text-xs text-muted">
        Koppel een groep aan een rol, groepsgesprekken en een dagbudget.{' '}
        <MoreInfo>
          TeamBot past dat toe zodra iemand in of uit de groep gaat. Wie uit alle gekoppelde groepen gaat, wordt weer lid en verlaat de gekoppelde groepsgesprekken; gegevens blijven bewaard. De eigenaar wordt nooit aangepast, en wat een beheerder met de hand
          instelde blijft staan.
        </MoreInfo>
      </p>
      {d.rooms === null && <p className="text-xs text-warn">De module Groepsgesprekken is niet geladen: koppelen aan gesprekken kan nu niet.</p>}
      {d.groups.length === 0 ? (
        <p className="text-sm text-muted">Nog geen groepen ontvangen. Zet groepsprovisioning aan bij je provider (zie de handleiding).</p>
      ) : (
        <div className="space-y-3">
          {d.groups.map((g) => (
            <GroupMapping key={g.id + g.updatedAt} g={g} rooms={d.rooms} canEdit={d.canEdit} onSaved={setD} />
          ))}
        </div>
      )}
      {d.canEdit && d.groups.length > 0 && (
        <Button variant="ghost" loading={a.busy} onClick={() => a.run(async () => setD(await api.post<GroupsData>('/admin/scim/groups/apply')), 'Groepsrechten opnieuw toegepast')}>
          Opnieuw toepassen
        </Button>
      )}
    </Card>
  );
}

function GroupMapping({ g, rooms, canEdit, onSaved }: { g: GroupView; rooms: GroupsData['rooms']; canEdit: boolean; onSaved(d: GroupsData): void }) {
  const [role, setRole] = useState(g.role);
  const [roomIds, setRoomIds] = useState<string[]>(g.roomIds);
  const [budget, setBudget] = useState(g.dailyBudgetUsd === null ? '' : String(g.dailyBudgetUsd));
  const a = useAsync();
  const budgetValue = budget.trim() === '' ? null : Number(budget.replace(',', '.'));
  const dirty = role !== g.role || budgetValue !== g.dailyBudgetUsd || roomIds.length !== g.roomIds.length || roomIds.some((x) => !g.roomIds.includes(x));
  const save = () =>
    a.run(async () => {
      if (role === 'admin' && g.role !== 'admin' && !(await askConfirm(`Iedereen in “${g.displayName}” wordt dan beheerder van TeamBot (de eigenaar blijft eigenaar). Doorgaan?`))) return;
      onSaved(await api.put<GroupsData>(`/admin/scim/groups/${g.id}`, { role, roomIds, dailyBudgetUsd: budgetValue }));
    }, 'Koppeling opgeslagen');
  const shown = g.members.slice(0, 8);
  const missing = rooms ? g.roomIds.filter((id) => !rooms.some((r) => r.id === id)) : [];
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{g.displayName}</span>
        <Badge>
          {g.members.length} {g.members.length === 1 ? 'persoon' : 'personen'}
        </Badge>
        {g.role === 'admin' && <Badge tone="warn">beheerders</Badge>}
      </div>
      {shown.length > 0 && (
        <p className="text-xs text-muted">
          {shown.map((m) => m.name || m.email).join(', ')}
          {g.members.length > shown.length ? ` en ${g.members.length - shown.length} meer` : ''}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Rol in TeamBot" hint="Beheerder maken kan alleen de eigenaar.">
          <Listbox
            value={role}
            onChange={(x) => setRole(x as GroupView['role'])}
            options={[
              { value: 'member', label: translate('Lid') },
              { value: 'admin', label: translate('Beheerder'), disabled: !canEdit && g.role !== 'admin' },
            ]}
          />
        </Field>
        <Field label="Dagbudget per lid (USD)" hint="Leeg = geen; 0 = geen limiet. In meerdere groepen telt het hoogste.">
          <Input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="bijv. 2" />
        </Field>
      </div>
      {rooms && (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Groepsgesprekken</legend>
          {rooms.length === 0 ? (
            <p className="text-xs text-muted">Je hebt nog geen groepsgesprekken.</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {rooms.map((r) => (
                <label key={r.id} className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={roomIds.includes(r.id)}
                    disabled={!canEdit}
                    onChange={(e) => setRoomIds(e.target.checked ? [...roomIds, r.id] : roomIds.filter((x) => x !== r.id))}
                  />
                  {r.name}
                </label>
              ))}
            </div>
          )}
          {missing.length > 0 && <p className="text-xs text-warn">{missing.length} gekoppeld gesprek bestaat niet meer of is gearchiveerd.</p>}
          {!canEdit && <p className="text-xs text-muted">Alleen de eigenaar koppelt groepen aan zijn groepsgesprekken.</p>}
        </fieldset>
      )}
      <Button size="sm" variant="primary" disabled={!dirty || (budgetValue !== null && !Number.isFinite(budgetValue))} loading={a.busy} onClick={save}>
        Opslaan
      </Button>
    </div>
  );
}
