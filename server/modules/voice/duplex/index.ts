import path from 'node:path';
import type { WebSocket } from 'ws';
import type { Ctx, ToolDef, User } from '../../../core/types.js';
import { HttpError, ah, bad, notFound, own, str, user } from '../../../core/http.js';
import { LocalModels } from '../local/models.js';
import { localVoice, mb } from '../local/service.js';
import { totalSize } from '../local/catalog.js';
import { STT_RATE } from '../local/pcm.js';
import { createCall, endCall } from '../calls.js';
import { runCallTool } from '../calltools.js';
import { getSettings } from '../settings.js';
import { localVoiceChoice, resolveTts } from '../tts.js';
import { baseLang } from '../../../../shared/voiceLanguage.js';
import { DUPLEX_LICENCES_CHECKED, DUPLEX_MODELS, SILERO_VAD, SMART_TURN } from './catalog.js';
import { DuplexSession, type Brain, type Voice } from './session.js';
import { SmartTurn, type TurnDetector } from './turn.js';
import { VAD_DEFAULTS, sileroVad, type VoiceActivity } from './vad.js';
import { agentBrain } from './brain.js';
import type { CallModeRegistry } from './mode.js';

export const DUPLEX_WS = '/ws/voice';

interface TestDeps {
  vad?: () => VoiceActivity;
  turn?: TurnDetector;
  brain?: (call: any) => Brain;
  /** Pretend the two call parts are installed (no download in `npm test`). */
  partsReady?: boolean;
}
let testDeps: TestDeps | null = null;
/** Tests: fake VAD / turn detector / brain. */
export function setDuplexTestDeps(d: TestDeps | null) {
  testDeps = d;
}

interface State {
  models: LocalModels;
  watchers: Set<string>;
  turn: SmartTurn | null;
  sessions: CallModeRegistry;
}
const states = new WeakMap<Ctx, State>();

function state(ctx: Ctx): State {
  let s = states.get(ctx);
  if (!s) {
    const watchers = new Set<string>();
    s = {
      models: new LocalModels(path.join(ctx.config.dataDir, 'voice', 'models'), { catalog: DUPLEX_MODELS, onProgress: (p) => watchers.forEach((u) => ctx.events.emit(u, 'voice.duplex.progress', p)) }),
      watchers,
      turn: null,
      sessions: new Map(),
    };
    states.set(ctx, s);
  }
  return s;
}

/** What the free live call needs on this computer, and why it cannot start yet (Dutch, for the page). */
export function duplexStatus(ctx: Ctx, userId: string) {
  const s = state(ctx);
  const lv = localVoice(ctx);
  const settings = getSettings(ctx, userId);
  const sttProblem = lv.sttProblem(settings.stt.localModel);
  let ttsProblem: string | null = null;
  try {
    const r = resolveTts(ctx, userId, null);
    ttsProblem = r.engine === 'local' ? null : r.localMissing || 'Kies een gratis stem op deze computer (Instellingen › Spraak).';
  } catch (e: any) {
    ttsProblem = String(e?.message || e);
  }
  const parts = DUPLEX_MODELS.map((m) => ({ label: m.label, description: m.description, licence: m.licence, licenceNote: m.licenceNote || null, source: m.source, size: totalSize(m), ...s.models.state(m.id), ...(testDeps?.partsReady ? { status: 'installed' } : {}) }));
  const missing = parts.filter((p) => p.status !== 'installed');
  const download = missing.reduce((n, p) => n + p.size, 0);
  const problem = sttProblem || ttsProblem || (missing.length ? `Nog één keer de gesprekshulp downloaden (${mb(download)}).` : null);
  return { ready: !problem, problem, sttProblem, ttsProblem, parts, download, downloadText: download ? mb(download) : '', licencesChecked: DUPLEX_LICENCES_CHECKED };
}

function voiceFor(ctx: Ctx, userId: string, agentId: string): { voice: Voice; lang: string } {
  const lv = localVoice(ctx);
  const agent = ctx.store.agent(agentId);
  const r = resolveTts(ctx, userId, agent && agent.user_id === userId ? agent : null);
  if (r.engine !== 'local') throw bad(r.localMissing || 'Het gratis live gesprek spreekt met een gratis stem op deze computer. Kies of download er een bij Instellingen › Spraak.');
  const c = localVoiceChoice(ctx, r, '', null);
  lv.tts().warm?.(lv.synthRequest(c.voiceId, '', c.speaker, c.speed));
  return {
    lang: baseLang(c.model.lang || r.lang || 'nl'),
    voice: { synth: (text) => lv.tts().synth(lv.synthRequest(c.voiceId, text, c.speaker, c.speed)) },
  };
}

function turnDetector(ctx: Ctx): TurnDetector {
  if (testDeps?.turn) return testDeps.turn;
  const s = state(ctx);
  if (!s.turn) s.turn = new SmartTurn(s.models.file(SMART_TURN, DUPLEX_MODELS[1].files[0].path));
  return s.turn;
}

function attach(ctx: Ctx, ws: WebSocket, u: User, callId: string) {
  const call = ctx.store.get<any>('voice_calls', callId);
  if (!call || call.user_id !== u.id || call.mode !== 'duplex') return ws.close(4404, 'Gesprek niet gevonden');
  if (call.status !== 'active') return ws.close(4409, 'Dit gesprek is al beëindigd');
  const s = state(ctx);
  if (s.sessions.has(call.id)) return ws.close(4409, 'Dit gesprek loopt al in een ander venster');
  const lv = localVoice(ctx);
  const settings = getSettings(ctx, u.id);
  let voice: Voice;
  let lang: string;
  try {
    ({ voice, lang } = voiceFor(ctx, u.id, call.agent_id));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: 'error', message: String(e?.message || e) }));
    return ws.close(4400, 'Geen stem');
  }
  const send = (m: Record<string, unknown>) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  lv.stt.warm(settings.stt.localModel, settings.stt.language);
  const turn = turnDetector(ctx);
  (turn as any).warm?.();
  const session = new DuplexSession({
    vad: testDeps?.vad ? testDeps.vad() : sileroVad(s.models.file(SILERO_VAD, DUPLEX_MODELS[0].files[0].path), VAD_DEFAULTS),
    turn,
    stt: async (audio) => (await lv.transcribeSamples(audio, STT_RATE, settings.stt.localModel, settings.stt.language)).text,
    voice,
    brain: testDeps?.brain ? testDeps.brain(call) : agentBrain(ctx, { user: u, call, lang }),
    send,
    sendAudio(epoch, pcm) {
      if (ws.readyState !== 1) return;
      // 4-byte answer number, then 16-bit PCM: the page drops audio of an answer you interrupted.
      const head = Buffer.alloc(4);
      head.writeUInt32LE(epoch >>> 0);
      ws.send(Buffer.concat([head, pcm]));
    },
    // end_call: the one implementation of every call (calltools.ts), with your last recognised sentence as `heard`.
    async endCallRules(heard, args) {
      const fresh = ctx.store.get<any>('voice_calls', call.id);
      if (!fresh) return 'Er loopt geen live gesprek in dit gesprek.';
      const out = await runCallTool(ctx, u, fresh, { name: 'end_call', args: { reason: args.reason, summary: args.summary }, heard }, { exceptRun: args.runId });
      return out.hangup ? null : String(out.output?.bericht || 'Niet ophangen.');
    },
    maxPauseMs: Math.max(1200, settings.call.silenceMs + 1000),
    onEnd(reason) {
      s.sessions.delete(call.id);
      off();
      try {
        const fresh = ctx.store.get<any>('voice_calls', call.id);
        if (fresh) endCall(ctx, fresh, {});
      } catch (e) {
        ctx.log.warn('[voice] ending duplex call failed', String(e));
      }
      ctx.audit(u.id, 'voice.duplex.ended', { callId: call.id, reason }, call.agent_id);
      setTimeout(() => ws.readyState === 1 && ws.close(1000, 'Opgehangen'), 300).unref?.();
    },
  });
  s.sessions.set(call.id, session);
  // The call ended elsewhere (the end button, another call tool, a limit): finish the sentence, then hang up.
  const off = ctx.events.subscribe((e) => {
    if (e.type === 'voice.call.updated' && e.data?.id === call.id && e.data?.status !== 'active' && !session.ended) session.finish('Opgehangen');
  });
  session.on((e) => {
    if (e.type === 'latency') ctx.log.info?.(`[voice] live gesprek: eerste klank ${e.totalMs} ms na je zin (herkenning ${e.sttMs}, beurt ${e.turnMs}, bot ${e.brainMs}, stem ${e.ttsMs})`);
  });
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return session.audio(Buffer.isBuffer(data) ? data : Buffer.from(data as any));
    try {
      session.control(JSON.parse(String(data)));
    } catch {
      /* not JSON */
    }
  });
  ws.on('close', () => session.stop('Verbinding verbroken'));
  ws.on('error', () => session.stop('Verbinding verbroken'));
  void session.start().then(() => send({ type: 'ready', callId: call.id, voiceRate: 0 }));
}

const END_CALL_GROUP = 'voice-call';

/** `end_call` for a bot that is in a free live call right now (only then is the tool offered). */
function endCallTool(ctx: Ctx): ToolDef {
  return {
    name: 'end_call',
    group: END_CALL_GROUP,
    risk: 'read',
    description:
      'Hang up the live voice call you are in. Only when the user clearly wants to stop (they say goodbye, ask you to hang up, or say this was all after you asked whether there is anything else). Never right after "wait" or "no", and not while a task still runs, unless the user asks to hang up. Give a short goodbye; it is spoken first, then the call ends.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the call ends, in a few words.' },
        goodbye: { type: 'string', description: 'One short goodbye sentence in the language of the call.' },
        summary: { type: 'string', description: 'A summary of the call in one or two sentences, for the call log in the chat.' },
      },
      required: ['reason'],
    },
    summarize: (a) => `Ophangen: ${String(a?.reason || '').slice(0, 80)}`,
    async run(args, t) {
      const call = ctx.store.one<any>("SELECT id FROM voice_calls WHERE thread_id = ? AND mode = 'duplex' AND status = 'active' ORDER BY started_at DESC LIMIT 1", t.thread.id);
      const session = call ? state(ctx).sessions.get(call.id) : null;
      if (!session) return 'Er loopt geen live gesprek in dit gesprek.';
      return session.endCall({ reason: str(args?.reason, 200), goodbye: typeof args?.goodbye === 'string' ? args.goodbye : '', summary: typeof args?.summary === 'string' ? args.summary : '', runId: t.run?.id });
    },
  };
}

export function duplex(ctx: Ctx) {
  const api = ctx.api;
  const canManage = (req: any) => ctx.config.mode === 'desktop' || user(req).role !== 'member';

  api.get('/voice/duplex', ah(async (req) => ({ ...duplexStatus(ctx, user(req).id), canManage: canManage(req) })));

  /** Download the call parts (only after the user tapped "download", with size shown). */
  api.post(
    '/voice/duplex/install',
    ah(async (req) => {
      const u = user(req);
      if (!canManage(req)) throw new HttpError(403, 'Alleen de eigenaar van deze computer of een beheerder kan spraakmodellen downloaden.', 'forbidden');
      const s = state(ctx);
      s.watchers.add(u.id);
      const ids = DUPLEX_MODELS.filter((m) => !s.models.installed(m.id)).map((m) => m.id);
      (async () => {
        for (const id of ids) await s.models.install(id);
      })().then(
        () => ctx.audit(u.id, 'voice.local.installed', { ids }),
        (e) => ctx.log.warn('[voice] call parts download failed', String(e?.message || e)),
      );
      return duplexStatus(ctx, u.id);
    }),
  );

  /** Start a free live call; the page then opens the audio socket it gets back. */
  api.post(
    '/voice/duplex/calls',
    ah(async (req) => {
      const u = user(req);
      const b = req.body || {};
      const agent = own(req, ctx.store.agent(str(b.agentId, 60)), 'Bot niet gevonden');
      let thread = b.threadId ? ctx.store.thread(str(b.threadId, 60)) : ctx.chat.threadForAgent(u.id, agent.id);
      if (!thread || thread.user_id !== u.id) throw notFound('Gesprek niet gevonden');
      if (thread.agent_id && thread.agent_id !== agent.id) throw bad('Dit gesprek hoort niet bij deze bot');
      const st = duplexStatus(ctx, u.id);
      if (!st.ready) throw new HttpError(409, st.problem || 'Het gratis live gesprek is nog niet klaar', 'voice_duplex_missing');
      voiceFor(ctx, u.id, agent.id); // warms the voice and fails early when there is none
      const settings = getSettings(ctx, u.id);
      localVoice(ctx).stt.warm(settings.stt.localModel, settings.stt.language);
      (turnDetector(ctx) as any).warm?.();
      const call = createCall(ctx, { userId: u.id, agentId: agent.id, threadId: thread.id, kind: 'halfduplex', mode: 'duplex', keepTranscript: true, priceCap: settings.priceCapUsd });
      ctx.audit(u.id, 'voice.call.started', { callId: call.id, kind: 'duplex' }, agent.id);
      return { call, socket: `${DUPLEX_WS}?call=${encodeURIComponent(call.id)}` };
    }),
  );

  // The audio socket: a signed URL (like /ws), for the owner of the call only.
  if (!(ctx.services.wsRoutes instanceof Map)) ctx.services.wsRoutes = new Map();
  ctx.services.wsRoutes.set(DUPLEX_WS, (ws: WebSocket, r: { user: User }, url: URL) => attach(ctx, ws, r.user, String(url.searchParams.get('call') || '')));
  ctx.services.voiceCallModes = state(ctx).sessions;

  ctx.tools.registerGroup({ id: END_CALL_GROUP, label: 'Live gesprek', description: 'Ophangen tijdens een live gesprek', always: true });
  const tool = endCallTool(ctx);
  ctx.tools.addProvider((_agent, thread) => {
    const s = states.get(ctx);
    if (!s?.sessions.size) return [];
    const active = ctx.store.one<any>("SELECT id FROM voice_calls WHERE thread_id = ? AND mode = 'duplex' AND status = 'active' LIMIT 1", thread.id);
    return active && s.sessions.has(active.id) ? [tool] : [];
  });
}

export function closeDuplex(ctx: Ctx) {
  const s = states.get(ctx);
  if (!s) return;
  for (const x of [...s.sessions.values()]) x.stop('Server stopt');
  s.turn?.close();
  for (const m of DUPLEX_MODELS) if (s.models.state(m.id).status === 'downloading') s.models.cancel(m.id);
  states.delete(ctx);
}
