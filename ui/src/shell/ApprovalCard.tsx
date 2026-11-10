import { useState } from 'react';
import { ArrowUp, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { agentById, useApp } from '../lib/store';
import type { Approval } from '../lib/types';
import { BotAvatar } from '../components/BotFace';
import { Badge, Button, Input, Select, Textarea, cx, timeAgo, toast, toastError } from '../components/ui';
import { uiModules } from '../modules';
import { approvalAction, approvalEngine } from './approvalLabels';
import { stripRefs } from '../lib/preview';
import { useIsPhoneSession } from './computerOnly';

function Meta({ a, showThreadLink, verb }: { a: Approval; showThreadLink?: boolean; verb: string }) {
  const agent = agentById(a.agent_id);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      {showThreadLink && <BotAvatar bot={agent || { id: a.agent_id, name: 'bot' }} size={20} mood="waiting" />}
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

/**
 * The run that asked was interrupted by a crash or restart; the approval came back with it. Deciding resumes the run
 * (server: Broker.resumeAfterRestart); the identical request is then not asked again.
 */
function Interrupted({ a, question }: { a: Approval; question?: boolean }) {
  const name = agentById(a.agent_id)?.name || 'de bot';
  return (
    <div className="mt-2 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-muted" role="note">
      <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        <span className="font-semibold text-fg">Onderbroken door een herstart.</span>{' '}
        {question ? `Je antwoord gaat mee als ${name} verdergaat.` : `Als je toestaat, gaat ${name} verder waar hij was; weigeren kan ook.`}
      </span>
    </div>
  );
}

/**
 * A question with choices, MausBot-style: lettered options, or type your own answer. Used for bot questions (ask_user)
 * and for the first-run greeting of a new bot.
 */
export function QuestionCard({ title, subtitle, options, meta, busy, onAnswer, onSkip, label = 'Vraag van de bot' }: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  options?: string[] | null;
  meta?: React.ReactNode;
  busy?: string | null;
  onAnswer(text: string): void;
  onSkip?(): void;
  label?: string;
}) {
  const [answer, setAnswer] = useState('');
  return (
    <div role="group" aria-label={label} className="w-full overflow-hidden rounded-card border tb-ask p-4">
      {meta && <div className="mb-2">{meta}</div>}
      <div className="flex items-start gap-2">
        <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap text-[15px] font-bold leading-snug">{title}</div>
          {subtitle && <div className="mt-1 text-[13.5px] text-muted">{subtitle}</div>}
        </div>
      </div>
      {options?.length ? (
        <div className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {options.map((o, i) => (
            <button
              key={o}
              type="button"
              disabled={!!busy}
              onClick={() => onAnswer(o)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-start text-sm hover:bg-surface-2 disabled:opacity-60 coarse:py-3"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-3 text-xs font-bold text-muted" aria-hidden>
                {String.fromCharCode(65 + (i % 26))}
              </span>
              <span className="min-w-0 flex-1 font-medium">{o}</span>
              {busy === o && <span className="text-xs text-muted">bezig…</span>}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (answer.trim()) onAnswer(answer.trim());
        }}
      >
        <Input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={options?.length ? 'Of typ je eigen antwoord…' : 'Typ je antwoord…'} aria-label="Antwoord" className="bg-surface" />
        <Button variant="primary" size="icon" className="rounded-full" aria-label="Antwoord versturen" loading={busy === 'approve'} disabled={!answer.trim()}>
          <ArrowUp className="h-4 w-4" />
        </Button>
      </form>
      {onSkip && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="ghost" loading={busy === 'deny'} onClick={onSkip}>
            Overslaan
          </Button>
        </div>
      )}
    </div>
  );
}

/** Inline approval / question card. Approving one action never grants permanent permission unless "Altijd" is chosen. */
export function ApprovalCard({ a, showThreadLink }: { a: Approval; showThreadLink?: boolean }) {
  // a module can show its own card for one of its tools (e.g. a vault login)
  const Custom = uiModules.find((m) => m.approvalRenderers?.[a.tool])?.approvalRenderers?.[a.tool];
  if (Custom) return <Custom a={a} showThreadLink={showThreadLink} />;
  return <DefaultApprovalCard a={a} showThreadLink={showThreadLink} />;
}

function DefaultApprovalCard({ a, showThreadLink }: { a: Approval; showThreadLink?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // On a paired phone: approve once or deny; 'always allow' is chosen on the computer (server/modules/mobile/policy.ts).
  const phone = useIsPhoneSession();
  const decide = async (decision: 'approve' | 'deny' | 'always', ans?: string) => {
    setBusy(decision === 'approve' && ans && a.options?.includes(ans) ? ans : decision);
    try {
      await api.post(`/approvals/${a.id}`, { decision, answer: ans });
      useApp.setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== a.id) }));
      if (a.interrupted_at) {
        const name = agentById(a.agent_id)?.name || 'De bot';
        toast(decision === 'deny' ? `${name} gaat verder zonder deze actie` : `${name} gaat verder`, 'ok');
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const r = approvalAction(a);
  const engine = approvalEngine(a.tool);

  if (a.kind === 'question' && a.tool === 'ask_form') return <FormCard a={a} busy={busy} decide={decide} showThreadLink={showThreadLink} />;
  if (a.kind === 'question') {
    return (
      <QuestionCard
        title={a.summary}
        options={a.options}
        meta={
          <>
            <Meta a={a} showThreadLink={showThreadLink} verb="vraagt" />
            {a.interrupted_at && <Interrupted a={a} question />}
          </>
        }
        busy={busy}
        onAnswer={(t) => decide('approve', t)}
        onSkip={() => decide('deny')}
      />
    );
  }

  const danger = a.risk === 'danger' || r.tone === 'danger';
  const always = !danger && !a.interrupted_at && !a.sharedBot && !phone;
  return (
    <div role="group" aria-label="Goedkeuring nodig" className={cx('w-full rounded-card border p-4', danger ? 'tb-ask-danger' : 'tb-ask')}>
      <Meta a={a} showThreadLink={showThreadLink} verb={r.verb} />
      {a.interrupted_at && <Interrupted a={a} />}
      <div className="mt-2 flex items-start gap-2">
        <span className={cx('mt-[7px] h-2 w-2 shrink-0 rounded-full', danger ? 'bg-danger' : 'bg-warn')} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap break-words text-[15px] font-bold leading-snug">{stripRefs(a.summary)}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted">
            <Badge tone={r.tone}>{r.badge}</Badge>
            <span>{r.text}</span>
            {/* The bot asks, not its engine (A-37: "Gevraagd door Claude Code"); the engine only in small print. */}
            {engine && <span className="text-[11px]">via {engine}</span>}
          </div>
        </div>
      </div>
      <button className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-fg coarse:-mb-2 coarse:mt-0 coarse:min-h-11" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {open ? 'Details verbergen' : 'Exacte invoer bekijken'}
      </button>
      {open && <pre className="tb-in scroll-thin mt-2 max-h-60 overflow-auto rounded-xl bg-surface-2 p-2.5 text-xs">{JSON.stringify(a.input, null, 2)}</pre>}
      {/* Three clear choices (Grok's simplicity, with the details above): Eén keer, Overslaan, Altijd. "Altijd" only
          on the computer, never for a risky action, after a restart or for someone else's bot; the phone shows two. */}
      <div className={cx('mt-3 grid gap-2', always ? 'grid-cols-3' : 'grid-cols-2', 'max-w-md')}>
        <Button variant="primary" className="justify-center" loading={busy === 'approve'} onClick={() => decide('approve')} aria-label={a.interrupted_at ? undefined : 'Eén keer toestaan'} title="Alleen deze ene actie toestaan">
          {a.interrupted_at ? 'Toestaan en hervatten' : 'Eén keer'}
        </Button>
        <Button className="justify-center" loading={busy === 'deny'} onClick={() => decide('deny')} title="Niet toestaan; de bot gaat verder zonder deze actie">
          Overslaan
        </Button>
        {always && (
          <Button className="justify-center" loading={busy === 'always'} onClick={() => decide('always')} aria-label="Altijd toestaan voor deze bot" title="Deze bot mag dit voortaan zonder te vragen">
            Altijd
          </Button>
        )}
      </div>
      {phone && !danger && !a.interrupted_at && !a.sharedBot && <p className="mt-2 text-xs text-muted">Altijd toestaan kies je op je computer.</p>}
    </div>
  );
}

interface FormField {
  name: string;
  label: string;
  type: string;
  options?: string[];
  required?: boolean;
  placeholder?: string;
}

/** Structured form requested by a bot (ask_form). The answer is sent back as JSON. */
function FormCard({ a, busy, decide, showThreadLink }: { a: Approval; busy: string | null; decide(d: 'approve' | 'deny', ans?: string): void; showThreadLink?: boolean }) {
  const fields: FormField[] = Array.isArray(a.input?.fields) ? a.input.fields : [];
  const [v, setV] = useState<Record<string, any>>(() => Object.fromEntries(fields.map((f) => [f.name, f.type === 'checkbox' ? false : ''])));
  const set = (k: string, x: any) => setV((o) => ({ ...o, [k]: x }));

  return (
    <div role="group" aria-label="Formulier van de bot" className="w-full rounded-card border tb-ask p-4">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const out: Record<string, any> = {};
          for (const f of fields) out[f.name] = f.type === 'number' && v[f.name] !== '' ? Number(v[f.name]) : v[f.name];
          decide('approve', JSON.stringify(out));
        }}
      >
        <div>
          <Meta a={a} showThreadLink={showThreadLink} verb="vraagt" />
          {a.interrupted_at && <Interrupted a={a} question />}
        </div>
        <div className="flex items-start gap-2">
          <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
          <div className="whitespace-pre-wrap text-[15px] font-bold leading-snug">{a.input?.title || a.summary}</div>
        </div>
        {fields.map((f) => {
          const id = `f-${a.id}-${f.name}`;
          return (
            <div key={f.name} className="space-y-1">
              {f.type !== 'checkbox' && (
                <label htmlFor={id} className="text-[13px] font-semibold">
                  {f.label}
                  {f.required && <span className="text-danger"> *</span>}
                </label>
              )}
              {f.type === 'textarea' ? (
                <Textarea id={id} className="bg-surface" rows={3} required={f.required} placeholder={f.placeholder} value={v[f.name]} onChange={(e) => set(f.name, e.target.value)} />
              ) : f.type === 'select' ? (
                <Select id={id} className="bg-surface" required={f.required} value={v[f.name]} onChange={(e) => set(f.name, e.target.value)}>
                  <option value="">Kies…</option>
                  {(f.options || []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              ) : f.type === 'checkbox' ? (
                <label className="flex items-center gap-2 text-sm">
                  <input id={id} type="checkbox" checked={!!v[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
                  {f.label}
                </label>
              ) : (
                <Input id={id} className="bg-surface" type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'} required={f.required} placeholder={f.placeholder} value={v[f.name]} onChange={(e) => set(f.name, e.target.value)} />
              )}
            </div>
          );
        })}
        <div className="flex gap-2">
          <Button variant="primary" size="sm" loading={busy === 'approve'}>
            Versturen
          </Button>
          <Button size="sm" variant="ghost" loading={busy === 'deny'} onClick={(e) => (e.preventDefault(), decide('deny'))}>
            Overslaan
          </Button>
        </div>
      </form>
    </div>
  );
}
