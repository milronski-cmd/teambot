import type { Ctx, Run, User } from '../../core/types.js';
import { bad, notFound } from '../../core/http.js';
import { newId, now } from '../../core/db.js';
import { usdText } from '../../core/i18n.js';
import { realtimeUsageCost, round, transcribeUsageCost, type RealtimeUsage } from './catalog.js';
import { getSettings } from './settings.js';
import { logUsage } from './usage.js';

export interface CallUsage {
  text_in: number;
  audio_in: number;
  cached_text: number;
  cached_audio: number;
  text_out: number;
  audio_out: number;
  responses: number;
  transcribe_cost: number;
  /** STT/TTS costs of a half-duplex call (already in the usage log per request). */
  extra_cost: number;
}

export interface TranscriptLine {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

const EMPTY: CallUsage = { text_in: 0, audio_in: 0, cached_text: 0, cached_audio: 0, text_out: 0, audio_out: 0, responses: 0, transcribe_cost: 0, extra_cost: 0 };
const ACTIVE = new Set(['connecting', 'active']);
const num = (v: any, max = 1_000_000) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.min(v, max) : 0);

export function createCall(
  ctx: Ctx,
  o: { userId: string; agentId: string; threadId: string; kind: 'realtime' | 'halfduplex'; mode: string; providerId?: string | null; model?: string; voice?: string; keepTranscript: boolean; priceCap: number },
) {
  const row = {
    id: newId('vc_'),
    user_id: o.userId,
    agent_id: o.agentId,
    thread_id: o.threadId,
    kind: o.kind,
    mode: o.mode,
    provider_id: o.providerId ?? null,
    model: o.model || '',
    voice: o.voice || '',
    status: o.kind === 'realtime' ? 'connecting' : 'active',
    keep_transcript: o.keepTranscript,
    transcript: [],
    usage: { ...EMPTY },
    cost: 0,
    price_cap: o.priceCap,
    asks: 0,
    error: null,
    started_at: now(),
    ended_at: null,
    duration_sec: 0,
  };
  ctx.store.insert('voice_calls', row);
  const v = view(ctx.store.get('voice_calls', row.id));
  ctx.events.emit(o.userId, 'voice.call.updated', v);
  return v;
}

/** Public view: transcript only when it is kept. */
export function view(c: any, withTranscript = false) {
  if (!c) return c;
  const { transcript, ...rest } = c;
  return { ...rest, lines: Array.isArray(transcript) ? transcript.length : 0, ...(withTranscript ? { transcript: c.keep_transcript ? transcript : [] } : {}) };
}

export function ownCall(ctx: Ctx, userId: string, id: string) {
  const c = ctx.store.get<any>('voice_calls', id);
  if (!c || c.user_id !== userId) throw notFound('Gesprek niet gevonden');
  return c;
}

function totalCost(c: any, u: CallUsage) {
  const rt = realtimeUsageCost(c.model, {
    input_token_details: { text_tokens: u.text_in, audio_tokens: u.audio_in, cached_tokens_details: { text_tokens: u.cached_text, audio_tokens: u.cached_audio } },
    output_token_details: { text_tokens: u.text_out, audio_tokens: u.audio_out },
  });
  return round(rt + u.transcribe_cost + u.extra_cost, 6);
}

function limits(ctx: Ctx, c: any, cost: number) {
  const settings = getSettings(ctx, c.user_id);
  const minutes = (Date.now() - Date.parse(c.started_at)) / 60_000;
  const cap = c.price_cap || settings.priceCapUsd;
  return {
    cost,
    capUsd: cap,
    warn: cost >= cap * 0.8,
    overCap: cost >= cap,
    overTime: minutes >= settings.maxMinutes,
    maxMinutes: settings.maxMinutes,
  };
}

/**
 * Usage and final transcript lines reported by the browser during a Realtime call. The browser reports raw token
 * counts; the server prices them from its own allowlist. Transcript lines are stored only when the user keeps them.
 */
export function recordEvents(ctx: Ctx, c: any, body: any) {
  if (!ACTIVE.has(c.status)) return { ...limits(ctx, c, c.cost), ended: true };
  const u: CallUsage = { ...EMPTY, ...(c.usage || {}) };
  for (const r of (Array.isArray(body?.usage) ? body.usage : []).slice(0, 50) as RealtimeUsage[]) {
    const inD = r?.input_token_details || {};
    const cD = inD.cached_tokens_details || {};
    const outD = r?.output_token_details || {};
    u.text_in += num(inD.text_tokens) + num(inD.image_tokens);
    u.audio_in += num(inD.audio_tokens);
    u.cached_text += num(cD.text_tokens);
    u.cached_audio += num(cD.audio_tokens) + num(cD.image_tokens);
    u.text_out += num(outD.text_tokens);
    u.audio_out += num(outD.audio_tokens);
    u.responses++;
  }
  const trModel = typeof body?.transcribeModel === 'string' ? body.transcribeModel : null;
  for (const t of (Array.isArray(body?.transcription) ? body.transcription : []).slice(0, 50)) u.transcribe_cost += transcribeUsageCost(trModel, t || {});
  let transcript: TranscriptLine[] = Array.isArray(c.transcript) ? c.transcript : [];
  if (c.keep_transcript && Array.isArray(body?.lines)) {
    for (const l of body.lines.slice(0, 50)) {
      const text = typeof l?.text === 'string' ? l.text.trim().slice(0, 4000) : '';
      if (!text || (l.role !== 'user' && l.role !== 'assistant')) continue;
      transcript.push({ role: l.role, text, at: typeof l.at === 'string' ? l.at.slice(0, 40) : now() });
    }
    transcript = transcript.slice(-2000);
  }
  const cost = totalCost(c, u);
  const patch: any = { usage: u, cost, transcript };
  if (c.status === 'connecting' && body?.status === 'active') patch.status = 'active';
  ctx.store.update('voice_calls', c.id, patch);
  const fresh = ctx.store.get<any>('voice_calls', c.id);
  ctx.events.emit(c.user_id, 'voice.call.updated', view(fresh));
  return limits(ctx, fresh, cost);
}

/** Add STT/TTS cost of a half-duplex turn to the call total (the usage log already has the request). */
export function addCallCost(ctx: Ctx, userId: string, callId: string | null | undefined, cost: number | null) {
  if (!callId || !cost) return;
  const c = ctx.store.get<any>('voice_calls', callId);
  if (!c || c.user_id !== userId || !ACTIVE.has(c.status)) return;
  const u: CallUsage = { ...EMPTY, ...(c.usage || {}) };
  u.extra_cost += cost;
  ctx.store.update('voice_calls', c.id, { usage: u, cost: totalCost(c, u) });
}

/** A call's cost ("≈ US$ 0,05"; under a cent "< US$ 0,01"), shown later in the reader's notation (usdText). */
export const money = (v: number) => (v > 0 && v < 0.01 ? `< ${usdText(0.01)}` : usdText(v, { max: 2 }));
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

/** Finish a call (idempotent). Writes the kept transcript into the chat and a short record of the call. */
export function endCall(ctx: Ctx, c: any, body: any = {}) {
  if (!ACTIVE.has(c.status)) return view(c);
  const durationSec = Math.max(0, Math.round((Date.now() - Date.parse(c.started_at)) / 100) / 10);
  const error = typeof body?.error === 'string' && body.error ? body.error.slice(0, 500) : null;
  const neverConnected = c.status === 'connecting';
  const status = error || neverConnected ? 'failed' : 'ended';
  // A group call speaks to the group thread directly; the page reports how many turns went to the bots.
  const groupTurns = c.mode === 'group' && Number.isFinite(Number(body?.turns)) ? Math.max(0, Math.min(10_000, Math.floor(Number(body.turns)))) : null;
  ctx.store.update('voice_calls', c.id, { status, ended_at: now(), duration_sec: durationSec, error: error || (neverConnected ? 'Verbinding niet tot stand gekomen' : null), ...(groupTurns !== null ? { asks: groupTurns } : {}) });
  const fin = ctx.store.get<any>('voice_calls', c.id);
  const u: CallUsage = { ...EMPTY, ...(fin.usage || {}) };
  if (fin.kind === 'realtime' && fin.cost > 0)
    logUsage(ctx, { userId: fin.user_id, agentId: fin.agent_id, providerId: fin.provider_id, model: fin.model, input: u.text_in + u.audio_in, output: u.text_out + u.audio_out, cost: fin.cost - u.extra_cost });

  const thread = ctx.store.thread(fin.thread_id);
  const agent = ctx.store.agent(fin.agent_id);
  if (thread && agent && !neverConnected) {
    const lines: TranscriptLine[] = fin.keep_transcript && Array.isArray(fin.transcript) ? fin.transcript : [];
    if (fin.kind === 'realtime' && lines.length) {
      if (fin.mode === 'direct') {
        // The conversation itself: becomes part of the chat so the bot remembers it later.
        for (const l of lines) {
          const m = ctx.store.createMessage({
            thread_id: thread.id,
            role: l.role,
            author_type: l.role === 'user' ? 'user' : 'agent',
            author_id: l.role === 'user' ? fin.user_id : agent.id,
            author_name: l.role === 'user' ? ctx.store.user(fin.user_id)?.name || 'Jij' : agent.name,
            content: l.text,
            parts: { voice: { via: 'live', callId: fin.id, at: l.at, transcript: true } },
          });
          ctx.chat.emitMessage(thread, m);
        }
      } else {
        // Agent mode: requests/answers are already real messages; the voice layer's chatter is kept as a record only.
        const text = lines.map((l) => `${l.role === 'user' ? 'Jij' : 'Stem'}: ${l.text}`).join('\n');
        ctx.chat.addEvent(thread, `Transcript live gesprek:\n${text.slice(0, 20_000)}`, { kind: 'voice_transcript', callId: fin.id });
      }
    }
    const provider = /^gemini/.test(fin.model || '') ? 'Gemini' : 'OpenAI';
    const what = fin.kind === 'realtime' ? `Live gesprek (${fin.mode === 'agent' ? 'bot bedienen' : 'direct'}, ${provider} ${fin.model})` : fin.mode === 'group' ? 'Groepsgesprek' : 'Spraakgesprek';
    // Whole sentences per count (translatable), group calls count turns instead of requests.
    const asked = !fin.asks ? null : fin.mode === 'group' ? (fin.asks === 1 ? '1 beurt' : `${fin.asks} beurten`) : fin.asks === 1 ? `1 verzoek aan ${agent.name}` : `${fin.asks} verzoeken aan ${agent.name}`;
    const parts = [what, clock(durationSec), fin.cost > 0 ? `≈ ${money(fin.cost)}` : null, asked, status === 'failed' ? 'afgebroken door een fout' : null].filter(Boolean);
    // The call log: who hung up, the bot's own summary and what was done during the call (each delegated task).
    const tasks = fin.kind === 'realtime' ? callLog(ctx, fin.id) : [];
    const endedByBot = fin.ended_by === 'bot';
    const log = [
      endedByBot ? (fin.end_reason ? `${agent.name} hing op: ${fin.end_reason}` : `${agent.name} hing op.`) : null,
      fin.summary ? `Samenvatting: ${fin.summary}` : null,
      ...(tasks.length ? [`Wat er gedaan is:`, ...tasks.map((t) => `• ${t.bot}: ${t.request} (${TASK_WORD[t.status] || t.status})`)] : []),
    ].filter(Boolean);
    ctx.chat.addEvent(thread, [parts.join(' · '), ...log].join('\n'), {
      kind: 'voice_call',
      callId: fin.id,
      durationSec,
      cost: fin.cost,
      mode: fin.mode,
      transcriptKept: !!fin.keep_transcript,
      ...(fin.kind === 'realtime' ? { provider, endedBy: endedByBot ? 'bot' : 'user', endReason: fin.end_reason || null, summary: fin.summary || null, tasks } : {}),
    });
  }
  ctx.audit(fin.user_id, 'voice.call.ended', { callId: fin.id, kind: fin.kind, durationSec, cost: fin.cost, status }, fin.agent_id);
  const v = view(ctx.store.get('voice_calls', fin.id));
  ctx.events.emit(fin.user_id, 'voice.call.updated', v);
  return v;
}

const TASK_WORD: Record<string, string> = { done: 'klaar', working: 'nog bezig', waiting_approval: 'wacht op goedkeuring', error: 'mislukt', cancelled: 'gestopt' };

/** The tasks a cloud call gave to bots (in any thread), for the call log in the chat. */
function callLog(ctx: Ctx, callId: string) {
  return ctx.store
    .all<{ id: string; agent_id: string; meta: string }>("SELECT id, agent_id, meta FROM runs WHERE json_extract(meta, '$.voiceCallId') = ? ORDER BY created_at, rowid", callId)
    .slice(0, 20)
    .map((r) => {
      let meta: any = {};
      try {
        meta = JSON.parse(r.meta || '{}');
      } catch {
        /* none */
      }
      return { runId: r.id, bot: ctx.store.agent(r.agent_id)?.name || '', request: String(meta.voiceRequest || '').replace(/\s+/g, ' ').slice(0, 160), status: runResult(ctx, r.id).status };
    });
}

export interface AskResult {
  status: 'done' | 'working' | 'waiting_approval' | 'error' | 'cancelled';
  text: string;
  runId: string;
  messageId: string | null;
  error?: string;
  /**
   * The model that wrote the answer (message parts.model, as under every answer in the chat). A voice turn is a normal
   * run of the bot, so this is the bot's own model, the same one as when you type (0.4: no other "voice model").
   */
  model?: string | null;
}

/** Outcome of a bot run started from voice: the last non-empty answer of that run. */
export function runResult(ctx: Ctx, runId: string): AskResult {
  const run = ctx.store.run(runId);
  if (!run) throw notFound('Taak niet gevonden');
  const answers = ctx.store
    .all<any>("SELECT * FROM messages WHERE run_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY seq", runId)
    .map((r) => ctx.store.decode<any>('messages', r))
    .filter((m) => m.content?.trim());
  const last = answers[answers.length - 1];
  const waiting = (ctx.store.one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ? AND status = 'pending'", runId)?.n ?? 0) > 0;
  const status: AskResult['status'] =
    run.status === 'done' ? 'done' : run.status === 'cancelled' ? 'cancelled' : run.status === 'error' || run.status === 'interrupted' ? 'error' : waiting || run.status === 'waiting' ? 'waiting_approval' : 'working';
  const model = typeof last?.parts?.model === 'string' && last.parts.model ? String(last.parts.model).slice(0, 120) : null;
  return { status, text: (last?.content || '').slice(0, 6000), runId, messageId: last?.id ?? null, error: run.error ? String(run.error).slice(0, 300) : undefined, model };
}

/**
 * You interrupted the bot in a call and then said something: stop that answer, so your new words do not wait in the
 * run queue behind it (a Claude Code answer can take another 20 s). What it wrote so far stays in the chat, marked
 * "Onderbroken: je begon te praten". Only a run of this call that is still queued or working; a run that waits for your
 * approval keeps waiting (that card is yours to decide).
 */
export function stopInterruptedAnswer(ctx: Ctx, call: any, runId: string): boolean {
  const run = ctx.store.run(runId);
  if (!run || run.user_id !== call.user_id || run.meta?.voiceCallId !== call.id) return false;
  if (run.status !== 'queued' && run.status !== 'running') return false;
  ctx.store.updateRun(run.id, { meta: { ...run.meta, steerInterrupt: true, voiceInterrupted: true } });
  if (!ctx.runs.cancel(run.id, 'Onderbroken: je begon te praten')) return false;
  ctx.runs
    .waitFor(run.id, 15_000)
    .then(() => {
      const thread = ctx.store.thread(run.thread_id);
      if (!thread) return;
      for (const r of ctx.store.all<{ id: string }>("SELECT id FROM messages WHERE run_id = ? AND role = 'assistant' AND status = 'cancelled' AND deleted = 0", run.id)) {
        const m = ctx.store.message(r.id);
        if (m) ctx.chat.emitMessage(thread, ctx.store.updateMessage(m.id, { parts: { ...m.parts, voiceInterrupted: true } }), 'message.updated');
      }
    })
    .catch(() => {});
  ctx.audit(call.user_id, 'voice.call.interrupted', { callId: call.id, runId: run.id }, run.agent_id);
  return true;
}

/**
 * The bridge used by voice: put the request as a normal message in the bot's real thread, run the bot through the
 * normal run queue (Broker, approvals, budget) and wait (bounded) for the answer.
 */
export async function askAgent(
  ctx: Ctx,
  o: { user: Pick<User, 'id' | 'name'>; call: any; text: string; via: 'live' | 'call'; waitMs: number; onRun?: (run: Run) => void; interruptRunId?: string | null },
): Promise<AskResult> {
  if (!ACTIVE.has(o.call.status)) throw bad('Dit gesprek is al beëindigd');
  const thread = ctx.store.thread(o.call.thread_id);
  const agent = ctx.store.agent(o.call.agent_id);
  if (!thread || !agent || thread.user_id !== o.user.id || agent.user_id !== o.user.id) throw notFound('Gesprek of bot niet gevonden');
  const text = String(o.text || '').trim().slice(0, 8000);
  if (!text) throw bad('Leeg verzoek');
  if (o.interruptRunId) stopInterruptedAnswer(ctx, o.call, String(o.interruptRunId));
  const msg = await ctx.chat.postUserMessage({ thread, user: o.user, content: text, parts: { voice: { via: o.via, callId: o.call.id } }, route: false });
  const run = ctx.chat.startAgent(thread, agent.id, msg.id, 'voice', { voiceCallId: o.call.id });
  if (!run) throw notFound('Bot niet gevonden');
  o.onRun?.(run);
  ctx.store.exec('UPDATE voice_calls SET asks = asks + 1 WHERE id = ?', o.call.id);
  if (o.call.status === 'connecting') ctx.store.update('voice_calls', o.call.id, { status: 'active' });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([ctx.runs.waitFor(run.id), new Promise((r) => (timer = setTimeout(r, Math.max(0, o.waitMs))))]);
  if (timer) clearTimeout(timer);
  const r = runResult(ctx, run.id);
  return { ...r, text: r.status === 'done' || r.text ? r.text : '' };
}
