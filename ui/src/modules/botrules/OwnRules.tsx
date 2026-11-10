import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { t } from '../../lib/i18n';
import type { Agent } from '../../lib/types';
import { Badge, Button, Input, Spinner, cx, toast, toastError } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';

/**
 * Own rules in plain words (server/modules/botrules, package P6): per bot (bot editor › Wat mag de bot?) or per team
 * (Instellingen › Teams). The owner writes a sentence, sees what TeamBot makes of it before saving, and TeamBot enforces
 * it in code. A rule that lets the bot do more, and removing a rule, are computer-only: the phone shows why.
 */

export type RuleEffect = 'deny' | 'ask' | 'allow';
export interface RuleMatch {
  verb: 'any' | 'read' | 'change' | 'delete' | 'run' | 'send' | 'publish' | 'pay';
  app?: string;
  folder?: string;
  domain?: string;
  tool?: string;
  others?: boolean;
}
export interface OwnRule {
  id: string;
  text: string;
  effect: RuleEffect;
  match: RuleMatch;
  appLabel?: string;
  review: boolean;
}
interface Preview {
  rule?: Omit<OwnRule, 'id' | 'text'>;
  error?: string;
}

const EXAMPLES = ['Mail nooit naar klanten zonder mij te vragen', 'Vraag altijd voordat je iets in de webshop verandert', 'Mag altijd bestanden maken in de map Offertes'];

const EFFECT: Record<RuleEffect, { label: string; tone: 'danger' | 'warn' | 'ok'; text: string }> = {
  deny: { label: 'Nooit', tone: 'danger', text: 'TeamBot weigert dit, ook als de bot het toch probeert.' },
  ask: { label: 'Eerst vragen', tone: 'warn', text: 'TeamBot vraagt jou eerst om akkoord.' },
  allow: { label: 'Mag zonder vragen', tone: 'ok', text: 'Zonder vragen, binnen het niveau van de bot. Versturen en betalen vragen altijd.' },
};

const VERB: Record<RuleMatch['verb'], string> = {
  any: 'alles',
  read: 'lezen',
  change: 'iets veranderen',
  delete: 'verwijderen',
  run: 'opdrachten uitvoeren',
  send: 'versturen',
  publish: 'publiceren',
  pay: 'betalen',
};

/** What TeamBot looks at, as separate parts ("versturen · e-mail · alleen naar anderen dan jou"). */
export function ruleParts(r: Pick<OwnRule, 'match' | 'appLabel'>): string[] {
  const m = r.match;
  return [
    VERB[m.verb] || VERB.any,
    r.appLabel || m.app ? t('app: {0}', r.appLabel || m.app || '') : '',
    m.folder ? t('map: {0}', m.folder) : '',
    m.domain ? t('website: {0}', m.domain) : '',
    m.tool ? t('tool: {0}', m.tool) : '',
    m.others ? 'alleen naar of voor anderen dan jou, zoals klanten' : '',
  ].filter(Boolean);
}

/** For an "allow" rule: does it change anything at this bot's level? */
function allowNote(mode?: Agent['access_mode']): string | null {
  if (!mode || mode === 'ask') return null;
  if (mode === 'chat' || mode === 'readonly') return 'Deze bot mag nu niets wijzigen. Deze regel werkt pas bij het niveau Vraagt toestemming.';
  return 'Deze bot doet dit nu al zonder te vragen. De regel werkt bij het niveau Vraagt toestemming.';
}

function RuleExplain({ r, mode }: { r: Omit<OwnRule, 'id' | 'text'>; mode?: Agent['access_mode'] }) {
  const note = r.effect === 'allow' ? allowNote(mode) : null;
  return (
    <div className="space-y-0.5 text-xs text-muted">
      {r.review ? (
        <p>Deze regel wordt per actie gecontroleerd. Bij twijfel vraagt de bot jou.</p>
      ) : (
        <>
          <p>
            <span className="font-medium text-fg">Geldt voor:</span> {ruleParts(r).join(' · ')}
          </p>
          <p>{EFFECT[r.effect].text}</p>
        </>
      )}
      {note && <p className="text-warn">{note}</p>}
    </div>
  );
}

function RuleRow({ r, mode, device, onRemoved }: { r: OwnRule; mode?: Agent['access_mode']; device: boolean; onRemoved?(): void }) {
  const [busy, setBusy] = useState(false);
  // Removing an "ask"/"never" rule lets the bot do more: computer only.
  const loosens = r.effect !== 'allow';
  const remove = async () => {
    setBusy(true);
    try {
      await api.del(loosens ? `/bot-rules/loosen/${r.id}` : `/bot-rules/${r.id}`);
      toast('Regel weggehaald', 'ok');
      onRemoved?.();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex items-start gap-3 rounded-xl border border-line p-3" data-testid="own-rule">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={EFFECT[r.effect].tone}>{EFFECT[r.effect].label}</Badge>
          <span className="min-w-0 break-words text-sm font-medium" translate="no">
            “{r.text}”
          </span>
        </div>
        <RuleExplain r={r} mode={mode} />
        {onRemoved && loosens && device && <p className="text-xs text-muted">Weghalen doe je op je computer: dan mag de bot meer.</p>}
      </div>
      {onRemoved && !(loosens && device) && (
        <Button size="sm" variant="ghost" loading={busy} icon={<Trash2 className="h-4 w-4" />} onClick={remove} aria-label={t('Regel weghalen: {0}', r.text)}>
          <span className="sr-only sm:not-sr-only">Weghalen</span>
        </Button>
      )}
    </li>
  );
}

/** The rules of one bot (with its team's rules shown read-only) or of one team. */
export function OwnRules({ agentId, teamId, mode }: { agentId?: string; teamId?: string; mode?: Agent['access_mode'] }) {
  const device = useApp((s) => s.device);
  const [data, setData] = useState<{ rules: OwnRule[]; team?: { id: string; name: string; rules: OwnRule[] } | null } | null>(null);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const seq = useRef(0);
  const q = agentId ? `agentId=${encodeURIComponent(agentId)}` : `teamId=${encodeURIComponent(teamId || '')}`;

  const load = () =>
    api
      .get(`/bot-rules?${q}`)
      .then((d) => {
        setData(d);
        setErr('');
      })
      .catch((e) => setErr(String(e?.message || e)));
  useEffect(() => {
    load();
    return on('botrules.updated', () => load());
  }, [q]);

  // What TeamBot makes of the sentence, while typing.
  useEffect(() => {
    const s = text.trim();
    if (!s) {
      setPreview(null);
      return;
    }
    const n = ++seq.current;
    setChecking(true);
    const h = setTimeout(() => {
      api
        .post<Preview>('/bot-rules/preview', { text: s })
        .then((p) => n === seq.current && setPreview(p))
        .catch((e) => n === seq.current && setPreview({ error: String(e?.message || e) }))
        .finally(() => n === seq.current && setChecking(false));
    }, 350);
    return () => clearTimeout(h);
  }, [text]);

  const rule = preview?.rule;
  const loosens = rule?.effect === 'allow';
  const add = async () => {
    if (!rule) return;
    setAdding(true);
    try {
      await api.post(loosens ? '/bot-rules/loosen' : '/bot-rules', { text: text.trim(), ...(agentId ? { agentId } : { teamId }) });
      toast('Regel toegevoegd', 'ok');
      setText('');
      setPreview(null);
      load();
    } catch (e) {
      toastError(e);
    } finally {
      setAdding(false);
    }
  };
  const inputId = `own-rule-${agentId || teamId}`;

  return (
    <section className="space-y-3" data-testid="own-rules" aria-labelledby={`${inputId}-title`}>
      <div>
        <h3 id={`${inputId}-title`} className="text-sm font-semibold">
          {agentId ? 'Eigen regels' : 'Regels voor alle bots van dit team'}
        </h3>
        <p className="text-xs text-muted">
          Wat de bot nooit mag, eerst moet vragen of altijd mag.{' '}
          <MoreInfo>Schrijf het in gewone woorden. TeamBot houdt zich er zelf aan, ook als de bot het vergeet.</MoreInfo>
        </p>
      </div>
      {err && <p className="text-xs text-danger">{err}</p>}
      {!data && !err && <Spinner />}
      {data && (
        <>
          {data.rules.length > 0 && (
            <ul className="space-y-2">
              {data.rules.map((r) => (
                <RuleRow key={r.id} r={r} mode={mode} device={device} onRemoved={load} />
              ))}
            </ul>
          )}
          {!!data.team?.rules.length && (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                {t('Ook deze regels gelden, van team “{0}”.', data.team.name)}{' '}
                <a className="underline" href={`#/m/teams/${data.team.id}`}>
                  Bekijk het team
                </a>
              </p>
              <ul className="space-y-2">
                {data.team.rules.map((r) => (
                  <RuleRow key={r.id} r={r} mode={mode} device={device} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="space-y-2">
        <label htmlFor={inputId} className="sr-only">
          Nieuwe regel
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={inputId}
            value={text}
            maxLength={300}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && rule && !(loosens && device)) {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Bijvoorbeeld: Mail nooit naar klanten zonder mij te vragen"
            className="min-w-0 flex-1"
          />
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} disabled={!rule || checking || (loosens && device)} loading={adding} onClick={add}>
            Toevoegen
          </Button>
        </div>
        {text.trim() && (
          <div className={cx('rounded-xl border p-3', preview?.error ? 'border-warn/40 bg-warn-soft' : 'border-line bg-surface-2')} aria-live="polite" data-testid="rule-preview">
            {checking && !preview ? (
              <p className="text-xs text-muted">Even kijken wat TeamBot hiervan maakt…</p>
            ) : preview?.error ? (
              <p className="text-xs text-fg">{preview.error}</p>
            ) : rule ? (
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">Zo legt TeamBot het vast:</span>
                  <Badge tone={EFFECT[rule.effect].tone}>{EFFECT[rule.effect].label}</Badge>
                </div>
                <RuleExplain r={rule} mode={mode} />
                {loosens && device && <p className="text-xs text-muted">Een regel die de bot meer laat doen, voeg je toe op je computer.</p>}
              </div>
            ) : null}
          </div>
        )}
        {!text.trim() && !data?.rules.length && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Voorbeelden">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg" onClick={() => setText(x)}>
                {x}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
