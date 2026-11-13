import { useCallback, useEffect, useState } from 'react';
import { Copy, FolderOpen, Globe, History as HistoryIcon, KeyRound, Mail, MessageCircle, Pencil, Plus, Rss, Send, Trash2, TriangleAlert, Webhook, RefreshCw } from 'lucide-react';
import { api, on } from '../../lib/api';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, Toggle, toast, useAsync, IconTile, copyText } from '../../components/ui';
import { Fold, SkeletonRows } from '../../components/overview';
import { MoreInfo } from '../../components/MoreInfo';
import { ComputerOnly, useIsPhoneSession } from '../../shell/computerOnly';
import { EVENT_STATUS, fmtDate, fmtTime, type FieldFilter, type Filters, type Meta, type TriggerEvent, type TriggerView } from './lib';

const KIND: Record<TriggerView['kind'], { label: string; icon: typeof Webhook }> = {
  webhook: { label: 'Webhook', icon: Webhook },
  feed: { label: 'RSS/Atom-feed', icon: Rss },
  page: { label: 'Webpagina-wijziging', icon: Globe },
  folder: { label: 'Map in de werkmap', icon: FolderOpen },
  email: { label: 'E-mail', icon: Mail },
  chat: { label: 'Chat-bericht', icon: MessageCircle },
};

const CHAT_DEFAULTS = { bindingId: '', senders: 'allowlist', match: 'contains', text: '', botReplies: true, ratePerMinute: 5 };
const CHAT_MATCH: { id: string; label: string }[] = [
  { id: 'contains', label: 'Bevat' },
  { id: 'starts_with', label: 'Begint met' },
  { id: 'regex', label: 'Past op patroon (regex)' },
  { id: 'any', label: 'Elk bericht' },
];
const CHAT_SENDERS: { id: string; label: string }[] = [
  { id: 'allowlist', label: 'Iedereen op de allowlist (aanbevolen)' },
  { id: 'owner', label: 'Alleen ikzelf (privégesprek)' },
  { id: 'anyone', label: 'Ook onbekende afzenders' },
];

interface ChatChannel {
  id: string;
  name: string;
  adapter: string;
  adapterLabel: string;
  enabled: boolean;
}

/** Chat channels of the user (e-mail has its own trigger). null while loading, [] when there are none. */
function useChatChannels(enabled = true): ChatChannel[] | null {
  const [list, setList] = useState<ChatChannel[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    api.get<ChatChannel[]>('/channels/bindings').then(
      (r) => setList(r.filter((b) => b.adapter !== 'email')),
      () => setList([]),
    );
  }, [enabled]);
  return list;
}

/** One line for a chat trigger: where, from whom, which text, and whether the bot answers too. */
function chatSummary(c: Record<string, any>, channels: ChatChannel[] | null): string {
  const ch = c.bindingId ? channels?.find((b) => b.id === c.bindingId) : null;
  const where = c.bindingId ? (ch ? `${ch.name} (${ch.adapterLabel})` : channels ? 'een kanaal dat niet meer bestaat' : 'één kanaal') : 'alle chatkanalen';
  const who = c.senders === 'owner' ? 'alleen van jou' : c.senders === 'anyone' ? 'van iedereen, ook onbekenden' : 'van de allowlist';
  const what = c.match === 'any' ? 'elk bericht' : `${c.match === 'regex' ? 'patroon' : c.match === 'starts_with' ? 'begint met' : 'bevat'} “${c.text}”`;
  return `${where} · ${who} · ${what} · ${c.botReplies === false ? 'de bot antwoordt niet' : 'de bot antwoordt ook'}`;
}

/** "Probeer een bericht": the server checks it with the same rules and limits as real messages. */
function MatchTry({ match, text }: { match: string; text: string }) {
  const [sample, setSample] = useState('');
  const [res, setRes] = useState<{ ok: boolean; matches?: boolean; error?: string } | null>(null);
  // A pattern is checked as soon as it is typed; a sentence is tried once there is one.
  const ready = match === 'regex' ? !!text.trim() : !!sample.trim() && (match === 'any' || !!text.trim());
  useEffect(() => {
    if (!ready) {
      setRes(null);
      return;
    }
    const tm = setTimeout(() => {
      api.post<{ ok: boolean; matches?: boolean; error?: string }>('/routines/chat-match', { match, text, sample }).then(setRes, (e) => setRes({ ok: false, error: e.message }));
    }, 300);
    return () => clearTimeout(tm);
  }, [ready, match, text, sample]);
  return (
    <>
      {res && !res.ok && (
        <div className="flex items-start gap-1.5 text-xs text-danger" role="alert">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {res.error}
        </div>
      )}
      <Field label="Probeer een bericht" hint="Alleen om te testen; er start niets.">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="min-w-[12rem] flex-1" value={sample} maxLength={500} placeholder="bijv. Rapport van vandaag graag" onChange={(e) => setSample(e.target.value)} aria-label="Probeer een bericht" />
          {res?.ok && sample.trim() && <Badge tone={res.matches ? 'ok' : 'neutral'}>{res.matches ? 'Start de routine' : 'Start niets'}</Badge>}
        </div>
      </Field>
    </>
  );
}

function ChatConfigFields({ d, set }: { d: TDraft; set(p: Partial<TDraft>): void }) {
  const channels = useChatChannels();
  const c = { ...CHAT_DEFAULTS, ...d.config };
  const cfg = (p: Record<string, any>) => set({ config: { ...c, ...p } });
  return (
    <div className="space-y-3">
      {channels && !channels.length && (
        <div className="rounded-control bg-warn-soft px-3 py-2.5 text-sm text-warn">
          Je hebt nog geen chatkanaal. Koppel er eerst een bij{' '}
          <a className="font-medium underline" href="#/m/channels">
            Kanalen
          </a>
          .
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kanaal">
          <Select value={c.bindingId} onChange={(e) => cfg({ bindingId: e.target.value })} aria-label="Kanaal">
            <option value="">Alle chatkanalen</option>
            {(channels || []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.adapterLabel}){b.enabled ? '' : ' — staat uit'}
              </option>
            ))}
            {c.bindingId && channels && !channels.some((b) => b.id === c.bindingId) && <option value={c.bindingId}>Kanaal bestaat niet meer</option>}
          </Select>
        </Field>
        <Field label="Van wie">
          <Select value={c.senders} onChange={(e) => cfg({ senders: e.target.value })} aria-label="Van wie">
            {CHAT_SENDERS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {c.senders === 'anyone' && (
        <div className="flex items-start gap-1.5 rounded-control bg-warn-soft px-3 py-2.5 text-xs text-warn">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Dan kan iedereen die je bot een bericht stuurt deze routine starten. <MoreInfo>Hun bericht gaat nooit naar de bot zelf.</MoreInfo>
          </span>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-[13rem_1fr]">
        <Field label="Het bericht">
          <Select value={c.match} onChange={(e) => cfg({ match: e.target.value })} aria-label="Het bericht">
            {CHAT_MATCH.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {c.match !== 'any' && (
          <Field label={c.match === 'regex' ? 'Patroon' : 'Tekst'} hint="Hoofdletters maken niet uit.">
            <Input value={c.text} maxLength={200} placeholder={c.match === 'regex' ? '^rapport\\b' : 'rapport'} onChange={(e) => cfg({ text: e.target.value })} className={c.match === 'regex' ? 'font-mono' : undefined} aria-label={c.match === 'regex' ? 'Patroon' : 'Tekst'} />
          </Field>
        )}
      </div>
      <MatchTry match={c.match} text={c.text} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Toggle checked={c.botReplies !== false} onChange={(v) => cfg({ botReplies: v })} label="De bot antwoordt ook gewoon op het bericht" />
        <MoreInfo className="text-xs text-muted">Uit: het bericht start alleen de routine. Wil je de uitkomst in je chat? Kies “Resultaat ook sturen naar”.</MoreInfo>
      </div>
      <Field label="Max. keer starten per minuut">
        <Input type="number" min={1} max={60} value={c.ratePerMinute} onChange={(e) => cfg({ ratePerMinute: Number(e.target.value) })} className="w-28" />
      </Field>
    </div>
  );
}

const OPS:{ id: string; label: string; needsValue: boolean }[] = [
  { id: 'eq', label: 'is gelijk aan', needsValue: true },
  { id: 'neq', label: 'is niet gelijk aan', needsValue: true },
  { id: 'contains', label: 'bevat', needsValue: true },
  { id: 'not_contains', label: 'bevat niet', needsValue: true },
  { id: 'starts_with', label: 'begint met', needsValue: true },
  { id: 'in', label: 'is een van (komma’s)', needsValue: true },
  { id: 'exists', label: 'bestaat', needsValue: false },
  { id: 'not_exists', label: 'bestaat niet', needsValue: false },
  { id: 'gt', label: 'groter dan', needsValue: true },
  { id: 'lt', label: 'kleiner dan', needsValue: true },
];

interface TDraft {
  kind: TriggerView['kind'];
  name: string;
  preset: string;
  config: Record<string, any>;
  filters: Filters;
  secret: string;
}

/** Comma-separated keywords; keeps the raw text while typing. */
function KeywordsInput({ value, onChange, label }: { value: string[]; onChange(v: string[]): void; label: string }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <Input
      aria-label={label}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean));
      }}
    />
  );
}

function FiltersEditor({ value, onChange, kind }: { value: Filters; onChange(f: Filters): void; kind: TriggerView['kind'] }) {
  const fields = value.fields || [];
  const setField = (i: number, p: Partial<FieldFilter>) => onChange({ ...value, fields: fields.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const hint =
    kind === 'webhook'
      ? 'Paden in de JSON-body, bijv. “action” of “pull_request.base.ref”.'
      : kind === 'feed'
        ? 'Per item: “title”, “link”, “summary”, “date”.'
        : kind === 'page'
          ? '“added” en “removed” (lijsten met gewijzigde regels).'
          : kind === 'folder'
            ? '“added”, “changed”, “removed” (lijsten met bestandsnamen).'
            : '“from”, “to”, “subject”, “text”.';
  return (
    <Fold title="Filters" card={false} defaultOpen={fields.length > 0 || !!value.anyKeywords?.length || !!value.noneKeywords?.length} testId="trigger-filters">
      <div className="text-xs text-muted">
        Alle voorwaarden moeten kloppen. <MoreInfo label="Welke velden?">{hint}</MoreInfo>
      </div>
      {fields.map((f, i) => {
        const op = OPS.find((o) => o.id === f.op);
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input aria-label="Veld" className="w-full sm:w-44" value={f.path} placeholder="veld" onChange={(e) => setField(i, { path: e.target.value })} />
            <Select aria-label="Voorwaarde" className="w-full sm:w-44" value={f.op} onChange={(e) => setField(i, { op: e.target.value })}>
              {OPS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
            {op?.needsValue && <Input aria-label="Waarde" className="min-w-0 flex-1" value={Array.isArray(f.value) ? f.value.join(',') : f.value ?? ''} onChange={(e) => setField(i, { value: e.target.value })} />}
            <Button size="icon" variant="ghost" type="button" aria-label="Filter verwijderen" onClick={() => onChange({ ...value, fields: fields.filter((_, j) => j !== i) })}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
      {fields.length < 20 && (
        <Button size="sm" variant="ghost" type="button" icon={<Plus className="h-4 w-4" />} onClick={() => onChange({ ...value, fields: [...fields, { path: kind === 'webhook' ? '$event' : 'title', op: 'contains', value: '' }] })}>
          Veldfilter
        </Button>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Moet een van deze woorden bevatten" hint="Komma's ertussen">
          <KeywordsInput value={value.anyKeywords || []} onChange={(anyKeywords) => onChange({ ...value, anyKeywords })} label="Moet een van deze woorden bevatten" />
        </Field>
        <Field label="Mag geen van deze woorden bevatten">
          <KeywordsInput value={value.noneKeywords || []} onChange={(noneKeywords) => onChange({ ...value, noneKeywords })} label="Mag geen van deze woorden bevatten" />
        </Field>
      </div>
    </Fold>
  );
}

function ConfigFields({ d, set, meta, isNew }: { d: TDraft; set(p: Partial<TDraft>): void; meta: Meta; isNew: boolean }) {
  const cfg = (p: Record<string, any>) => set({ config: { ...d.config, ...p } });
  const preset = meta.presets.find((p) => p.id === d.preset);
  if (d.kind === 'webhook')
    return (
      <div className="space-y-3">
        <Field label="Afzender / beveiliging" hint={preset?.help}>
          <Select value={d.preset} onChange={(e) => set({ preset: e.target.value })} aria-label="Webhooktype">
            {meta.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        {isNew && preset && !preset.generatesSecret && (
          <Field label="Geheim van de dienst" hint="Bijv. het Slack Signing Secret of Stripe whsec_…. Je kunt dit ook later instellen.">
            <Input type="password" autoComplete="off" value={d.secret} onChange={(e) => set({ secret: e.target.value })} />
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Max. grootte (kB)">
            <Input type="number" min={1} max={1024} value={Math.round((d.config.maxBytes || 262144) / 1024)} onChange={(e) => cfg({ maxBytes: Number(e.target.value) * 1024 })} />
          </Field>
          <Field label="Max. verzoeken per minuut">
            <Input type="number" min={1} max={600} value={d.config.ratePerMinute || 30} onChange={(e) => cfg({ ratePerMinute: Number(e.target.value) })} />
          </Field>
        </div>
      </div>
    );
  if (d.kind === 'feed' || d.kind === 'page')
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Adres (URL)" className="sm:col-span-2" hint="Alleen openbare adressen.">
          <Input type="url" value={d.config.url || ''} placeholder="https://…" onChange={(e) => cfg({ url: e.target.value })} />
        </Field>
        <Field label="Controleren elke (minuten)" hint="Minimaal 5">
          <Input type="number" min={5} value={d.config.intervalMinutes || (d.kind === 'feed' ? 15 : 60)} onChange={(e) => cfg({ intervalMinutes: Number(e.target.value) })} />
        </Field>
        {d.kind === 'feed' && (
          <Field label="Max. items per run">
            <Input type="number" min={1} max={50} value={d.config.maxItems || 10} onChange={(e) => cfg({ maxItems: Number(e.target.value) })} />
          </Field>
        )}
      </div>
    );
  if (d.kind === 'folder')
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Map (binnen de werkmap van de bot)" className="sm:col-span-2" hint="Bijv. “inbox”.">
          <Input value={d.config.path ?? '.'} onChange={(e) => cfg({ path: e.target.value })} className="font-mono" />
        </Field>
        <Field label="Bestandspatroon" hint="Bijv. *.pdf, *.csv (leeg = alles)">
          <Input value={d.config.pattern || ''} onChange={(e) => cfg({ pattern: e.target.value })} />
        </Field>
        <Field label="Controleren elke (minuten)">
          <Input type="number" min={1} value={d.config.intervalMinutes || 1} onChange={(e) => cfg({ intervalMinutes: Number(e.target.value) })} />
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <Toggle checked={!!d.config.recursive} onChange={(v) => cfg({ recursive: v })} label="Ook submappen" />
          <div className="flex flex-wrap gap-1.5 text-sm" role="group" aria-label="Wijzigingen">
            {[
              ['added', 'Nieuwe bestanden'],
              ['changed', 'Gewijzigde bestanden'],
              ['removed', 'Verwijderde bestanden'],
            ].map(([k, l]) => {
              const ev: string[] = d.config.events || ['added', 'changed'];
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={ev.includes(k)}
                  className={`h-9 rounded-full border px-3 text-sm font-medium transition-colors coarse:h-11 ${ev.includes(k) ? 'border-fg bg-surface-3 text-fg' : 'border-line bg-surface text-muted hover:bg-surface-2 hover:text-fg'}`}
                  onClick={() => cfg({ events: ev.includes(k) ? ev.filter((x) => x !== k) : [...ev, k] })}
                >
                  {l}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  if (d.kind === 'chat') return <ChatConfigFields d={d} set={set} />;
  return (
    <Field label="Account (optioneel)" hint="Alleen e-mail van dit kanaalaccount; leeg = alle e-mail die de kanalenmodule voor jou ontvangt.">
      <Input value={d.config.accountId || ''} onChange={(e) => cfg({ accountId: e.target.value })} />
    </Field>
  );
}

function TriggerModal({ open, onClose, meta, routineId, existing, onSaved }: { open: boolean; onClose(): void; meta: Meta; routineId: string; existing: TriggerView | null; onSaved(t: TriggerView, secret?: string): void }) {
  const [d, setD] = useState<TDraft>(() => fromTrigger(existing));
  const { busy, run } = useAsync();
  useEffect(() => {
    if (open) setD(fromTrigger(existing));
  }, [open, existing]);
  const set = (p: Partial<TDraft>) => setD((x) => ({ ...x, ...p }));
  const save = () =>
    run(async () => {
      const body = { kind: d.kind, name: d.name, preset: d.preset, config: d.config, filters: d.filters, ...(d.secret ? { secret: d.secret } : {}) };
      if (existing) {
        const t = await api.patch<TriggerView>(`/routines/triggers/${existing.id}`, body);
        onSaved(t);
      } else {
        const r = await api.post<{ trigger: TriggerView; secret?: string }>(`/routines/${routineId}/triggers`, body);
        onSaved(r.trigger, r.secret);
      }
      onClose();
    });
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={existing ? 'Trigger bewerken' : 'Trigger toevoegen'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            {existing ? 'Opslaan' : 'Toevoegen'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!existing && (
          <Field label="Soort trigger">
            <Select value={d.kind} onChange={(e) => setD({ ...fromTrigger(null), kind: e.target.value as TDraft['kind'], ...(e.target.value === 'chat' ? { config: { ...CHAT_DEFAULTS } } : {}) })} aria-label="Soort trigger">
              <option value="webhook">Webhook (GitHub, Slack, Linear, Sentry, Stripe of eigen)</option>
              <option value="feed">RSS/Atom-feed: nieuwe items</option>
              <option value="page">Webpagina: tekst gewijzigd</option>
              <option value="folder">Map in de werkmap: nieuwe of gewijzigde bestanden</option>
              <option value="email" disabled={!meta.emailAvailable}>
                E-mail{meta.emailAvailable ? '' : ' (niet beschikbaar)'}
              </option>
              <option value="chat" disabled={!meta.chatAvailable}>
                Chat-bericht (WhatsApp, Telegram, …) met bepaalde tekst{meta.chatAvailable ? '' : ' (niet beschikbaar)'}
              </option>
            </Select>
            {!meta.emailAvailable && <div className="mt-1 text-xs text-muted">E-mailtriggers verschijnen zodra een e-mailkanaal is gekoppeld via de kanalenmodule.</div>}
          </Field>
        )}
        <Field label="Naam (optioneel)">
          <Input value={d.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <ConfigFields d={d} set={set} meta={meta} isNew={!existing} />
        {d.kind !== 'chat' && <FiltersEditor value={d.filters} onChange={(filters) => set({ filters })} kind={d.kind} />}
      </div>
    </Modal>
  );
}

function fromTrigger(t: TriggerView | null): TDraft {
  return t
    ? { kind: t.kind, name: t.name, preset: t.preset, config: { ...t.config }, filters: { fields: [...(t.filters.fields || [])], anyKeywords: t.filters.anyKeywords || [], noneKeywords: t.filters.noneKeywords || [] }, secret: '' }
    : { kind: 'webhook', name: '', preset: 'github', config: {}, filters: { fields: [], anyKeywords: [], noneKeywords: [] }, secret: '' };
}

function SecretOnce({ secret, onClose }: { secret: string | null; onClose(): void }) {
  return (
    <Modal open={!!secret} onClose={onClose} title="Nieuw geheim" footer={<Button variant="primary" onClick={onClose}>Ik heb het opgeslagen</Button>}>
      <div className="space-y-3 text-sm">
        <p>
          Plak dit geheim nu bij de dienst. Je ziet het <strong>maar één keer</strong>.
        </p>
        <div className="flex gap-2">
          <Input readOnly value={secret || ''} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Geheim" />
          <Button icon={<Copy className="h-4 w-4" />} onClick={() => secret && copyText(secret)}>
            Kopieer
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EventsList({ triggerId, tz }: { triggerId: string; tz: string }) {
  const [rows, setRows] = useState<TriggerEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .get<TriggerEvent[]>(`/routines/triggers/${triggerId}/events?limit=30`)
      .then((r) => (setRows(r), setErr(null)))
      .catch((e) => setErr(e.message));
  }, [triggerId]);
  useEffect(load, [load]);
  useEffect(() => on('routine.event', (e: any) => e.trigger_id === triggerId && load()), [triggerId, load]);
  if (err) return <div className="text-sm text-danger">{err}</div>;
  if (!rows) return <Spinner />;
  if (!rows.length) return <div className="text-sm text-muted">Nog niets ontvangen.</div>;
  return (
    <ul className="divide-y divide-line text-sm">
      {rows.map((e) => {
        const st = EVENT_STATUS[e.status] || { label: e.status, tone: 'neutral' as const };
        return (
          <li key={e.id} className="flex flex-wrap items-center gap-2 py-1.5">
            <Badge tone={st.tone}>{st.label}</Badge>
            {e.event_type && <span className="font-mono text-xs">{e.event_type}</span>}
            <span className="min-w-0 flex-1 truncate text-muted" title={e.summary}>
              {e.summary}
            </span>
            <span className="text-xs text-muted">{fmtDate(e.created_at, tz)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function TriggerCard({ t, meta, tz, onChanged, onEdit, onDeleted, onSecret }: { t: TriggerView; meta: Meta; tz: string; onChanged(t: TriggerView): void; onEdit(): void; onDeleted(): void; onSecret(s: string): void }) {
  const [showEvents, setShowEvents] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [payload, setPayload] = useState('{\n  "test": true,\n  "message": "Hallo van TeamBot"\n}');
  const [secretOpen, setSecretOpen] = useState(false);
  const [secretValue, setSecretValue] = useState('');
  // Rotating makes the old secret invalid at once, unless the owner picks a short overlap (A-74).
  const [grace, setGrace] = useState('0');
  const [confirmDel, setConfirmDel] = useState(false);
  const { busy, run } = useAsync();
  const K = KIND[t.kind];
  const preset = meta.presets.find((p) => p.id === t.preset);
  // Setting a webhook's own secret later stays on the computer (server/modules/mobile/policy.ts); a secret TeamBot
  // makes itself can be rotated on the phone too (it is shown once, to paste at the service).
  const phone = useIsPhoneSession();
  const ownSecretHere = !phone || !!preset?.generatesSecret;
  const chatChannels = useChatChannels(t.kind === 'chat');

  const toggle = (enabled: boolean) => run(async () => onChanged(await api.patch<TriggerView>(`/routines/triggers/${t.id}`, { enabled })));
  const rotate = () =>
    run(async () => {
      const r = await api.post<{ secret: string; trigger: TriggerView }>(`/routines/triggers/${t.id}/rotate`, { graceMinutes: Number(grace) });
      onChanged(r.trigger);
      setSecretOpen(false);
      onSecret(r.secret);
    });
  const revokeOld = () =>
    run(async () => {
      onChanged(await api.post<TriggerView>(`/routines/triggers/${t.id}/revoke-previous`, {}));
      toast('Het oude geheim werkt niet meer', 'ok');
    });
  const setOwn = () =>
    run(async () => {
      onChanged(await api.put<TriggerView>(`/routines/triggers/${t.id}/secret`, { value: secretValue, graceMinutes: Number(grace) }));
      setSecretValue('');
      setSecretOpen(false);
      toast('Geheim opgeslagen', 'ok');
    });
  const test = () =>
    run(async () => {
      const r = await api.post<{ status: number; result: any }>(`/routines/triggers/${t.id}/test`, t.kind === 'webhook' ? { payload } : {});
      setTestOpen(false);
      setShowEvents(true);
      if (t.kind === 'webhook') toast(r.status === 202 ? 'Testlevering geaccepteerd; de routine start' : r.result?.filtered ? 'Testlevering ontvangen, maar gefilterd' : `Antwoord ${r.status}: ${JSON.stringify(r.result).slice(0, 120)}`, r.status < 300 ? 'ok' : 'danger');
      else toast(r.result?.result === 'event' ? 'Wijziging gevonden; de routine start' : r.result?.result === 'baseline' ? 'Startpunt vastgelegd' : r.result?.result === 'error' ? 'Controle mislukt (zie gebeurtenissen)' : 'Geen nieuwe wijzigingen', r.result?.result === 'error' ? 'danger' : 'ok');
    });
  const del = () =>
    run(async () => {
      await api.del(`/routines/triggers/${t.id}`);
      onDeleted();
    }, 'Trigger verwijderd');

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <IconTile icon={K.icon} tone="blue" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{t.name}</div>
          <div className="text-xs text-muted">
            {K.label}
            {preset ? ` · ${preset.label}` : ''}
            {t.last_event_at ? ` · laatst ontvangen ${fmtDate(t.last_event_at, tz)}` : ''}
            {t.state.lastCheck ? ` · gecontroleerd ${fmtDate(t.state.lastCheck, tz)}` : ''}
          </div>
        </div>
        <Toggle checked={t.enabled} onChange={toggle} disabled={busy} label={<span className="text-xs">{t.enabled ? 'Aan' : 'Uit'}</span>} />
      </div>

      {t.kind === 'webhook' && t.url && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input readOnly value={t.url} className="font-mono text-xs" aria-label="Webhook-URL" onFocus={(e) => e.currentTarget.select()} />
            <Button icon={<Copy className="h-4 w-4" />} onClick={() => copyText(t.url!)} aria-label="URL kopiëren">
              <span className="hidden sm:inline">Kopieer</span>
            </Button>
          </div>
          {!meta.webhookReachable && (
            <div className="flex items-start gap-1.5 text-xs text-warn">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Dit adres is alleen bereikbaar vanaf deze computer. Diensten zoals GitHub of Slack hebben een publiek adres nodig: draai TeamBot als server met een vast publiek adres (de beheerder stelt dat in), of gebruik een tunnel.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {t.hasSecret ? <Badge tone="ok">Geheim ingesteld{t.secret_set_at ? ` · ${fmtDate(t.secret_set_at, tz)}` : ''}</Badge> : <Badge tone="danger">Nog geen geheim — leveringen worden geweigerd</Badge>}
          </div>
          {t.prevSecretActive && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" role="status">
              <KeyRound className="h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                Oud geheim werkt nog tot <strong>{fmtTime(t.prev_valid_until, tz)}</strong>. Daarna alleen het nieuwe.
              </span>
              <Button size="sm" variant="soft" onClick={revokeOld} loading={busy}>
                Nu intrekken
              </Button>
            </div>
          )}
        </div>
      )}
      {(t.kind === 'feed' || t.kind === 'page') && <div className="break-all font-mono text-xs text-muted">{t.config.url}</div>}
      {t.kind === 'folder' && (
        <div className="font-mono text-xs text-muted">
          {t.config.path || '.'}
          {t.config.pattern ? ` · ${t.config.pattern}` : ''}
        </div>
      )}
      {t.kind === 'chat' && <div className="break-words text-xs text-muted">{chatSummary(t.config, chatChannels)}</div>}
      {t.last_error && <div className="text-xs text-danger">Laatste fout: {t.last_error}</div>}
      {!!(t.filters.fields?.length || t.filters.anyKeywords?.length || t.filters.noneKeywords?.length) && (
        <div className="text-xs text-muted">
          Filters: {[...(t.filters.fields || []).map((f) => `${f.path} ${OPS.find((o) => o.id === f.op)?.label || f.op}${f.value !== undefined && f.value !== '' ? ` “${f.value}”` : ''}`), ...(t.filters.anyKeywords?.length ? [`bevat: ${t.filters.anyKeywords.join(', ')}`] : []), ...(t.filters.noneKeywords?.length ? [`niet: ${t.filters.noneKeywords.join(', ')}`] : [])].join(' · ')}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {t.kind === 'webhook' ? (
          <>
            <Button size="sm" icon={<Send className="h-4 w-4" />} onClick={() => setTestOpen(true)} disabled={!t.hasSecret}>
              Testpayload sturen
            </Button>
            {ownSecretHere && (
              <Button size="sm" variant="ghost" icon={<KeyRound className="h-4 w-4" />} onClick={() => setSecretOpen(true)}>
                {preset?.generatesSecret ? 'Geheim roteren' : 'Geheim instellen'}
              </Button>
            )}
          </>
        ) : t.kind !== 'email' && t.kind !== 'chat' ? (
          <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} onClick={test} loading={busy}>
            Nu controleren
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon={<HistoryIcon className="h-4 w-4" />} onClick={() => setShowEvents(!showEvents)} aria-expanded={showEvents}>
          Gebeurtenissen
        </Button>
        <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={onEdit}>
          Bewerken
        </Button>
        <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDel(true)}>
          Verwijderen
        </Button>
      </div>
      {t.kind === 'webhook' && !ownSecretHere && <ComputerOnly>Het geheim van deze webhook stel je in op je computer.</ComputerOnly>}
      {showEvents && (
        <div className="rounded-lg border border-line p-3">
          <EventsList triggerId={t.id} tz={tz} />
        </div>
      )}

      <Modal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        title="Testpayload sturen"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTestOpen(false)}>
              Annuleren
            </Button>
            <Button variant="primary" onClick={test} loading={busy}>
              Versturen
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <p className="text-muted">Gaat door de echte controle; klopt alles, dan start de routine.</p>
          <Textarea rows={8} className="font-mono text-xs" value={payload} onChange={(e) => setPayload(e.target.value)} aria-label="Testpayload" />
        </div>
      </Modal>

      <Modal
        open={secretOpen}
        onClose={() => setSecretOpen(false)}
        title={preset?.generatesSecret ? 'Geheim roteren' : 'Geheim instellen'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSecretOpen(false)}>
              Annuleren
            </Button>
            {preset?.generatesSecret ? (
              <Button variant="primary" onClick={rotate} loading={busy}>
                Nieuw geheim maken
              </Button>
            ) : (
              <Button variant="primary" onClick={setOwn} loading={busy} disabled={secretValue.length < 8}>
                Opslaan
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-3 text-sm">
          {!preset?.generatesSecret && (
            <Field label="Geheim van de dienst" hint={preset?.help}>
              <Input type="password" autoComplete="off" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} />
            </Field>
          )}
          {preset?.generatesSecret && <p>Je krijgt een nieuw geheim en ziet het één keer.</p>}
          {t.hasSecret && (
            <Field
              label="Wat gebeurt er met het oude geheim?"
            >
              <Select value={grace} onChange={(e) => setGrace(e.target.value)} aria-label="Overgangstijd voor het oude geheim">
                <option value="0">Direct ongeldig (aanbevolen)</option>
                <option value="5">Nog 5 minuten geldig</option>
                <option value="15">Nog 15 minuten geldig</option>
                <option value="60">Nog 60 minuten geldig</option>
              </Select>
            </Field>
          )}
        </div>
      </Modal>

      <Modal
        open={confirmDel}
        onClose={() => setConfirmDel(false)}
        title="Trigger verwijderen?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDel(false)}>
              Annuleren
            </Button>
            <Button variant="danger" onClick={del} loading={busy}>
              Verwijderen
            </Button>
          </>
        }
      >
        <p className="text-sm">“{t.name}” en de gebeurtenissenhistorie worden verwijderd. {t.kind === 'webhook' ? 'Leveringen naar deze URL worden daarna geweigerd.' : ''}</p>
      </Modal>
    </Card>
  );
}

export function TriggersTab({ routineId, meta, tz, routineActive }: { routineId: string; meta: Meta; tz: string; routineActive: boolean }) {
  const [list, setList] = useState<TriggerView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<{ open: boolean; existing: TriggerView | null }>({ open: false, existing: null });
  const [secret, setSecret] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .get<TriggerView[]>(`/routines/${routineId}/triggers`)
      .then((r) => (setList(r), setErr(null)))
      .catch((e) => setErr(e.message));
  }, [routineId]);
  useEffect(load, [load]);
  const upsert = (t: TriggerView) => setList((cur) => (cur ? (cur.some((x) => x.id === t.id) ? cur.map((x) => (x.id === t.id ? t : x)) : [...cur, t]) : [t]));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted">
          Een trigger start deze routine bij een gebeurtenis.{' '}
          <MoreInfo>Wat binnenkomt gaat als onbetrouwbare data naar de bot, nooit als opdracht.</MoreInfo>
        </p>
        {!!list?.length && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setModal({ open: true, existing: null })}>
            Trigger toevoegen
          </Button>
        )}
      </div>
      {!routineActive && <div className="rounded-control bg-warn-soft px-3 py-2.5 text-sm text-warn">De routine staat uit: wat binnenkomt wordt bewaard, maar start niets.</div>}
      {err && (
        <EmptyState icon={<Webhook />} title="Triggers laden mislukt" action={<Button onClick={load}>Opnieuw</Button>}>
          {err}
        </EmptyState>
      )}
      {!err && !list && <SkeletonRows n={2} avatar={false} />}
      {list && !list.length && (
        <EmptyState
          icon={<Webhook />}
          title="Nog geen triggers"
          action={
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setModal({ open: true, existing: null })}>
              Trigger toevoegen
            </Button>
          }
        >
          Start deze routine met een chatbericht, een webhook, een nieuw bestand of een gewijzigde webpagina.
        </EmptyState>
      )}
      {list?.map((t) => (
        <TriggerCard key={t.id} t={t} meta={meta} tz={tz} onChanged={upsert} onEdit={() => setModal({ open: true, existing: t })} onDeleted={() => setList((cur) => cur?.filter((x) => x.id !== t.id) || null)} onSecret={setSecret} />
      ))}
      <TriggerModal
        open={modal.open}
        existing={modal.existing}
        meta={meta}
        routineId={routineId}
        onClose={() => setModal({ open: false, existing: null })}
        onSaved={(t, s) => {
          upsert(t);
          if (s) setSecret(s);
          else toast('Trigger opgeslagen', 'ok');
        }}
      />
      <SecretOnce secret={secret} onClose={() => setSecret(null)} />
    </div>
  );
}
