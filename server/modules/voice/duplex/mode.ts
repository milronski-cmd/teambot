/**
 * The one contract between the kinds of live call and the call screen and call tools. Three modes:
 *  - 'realtime': cloud, OpenAI Realtime (your own key);
 *  - 'gemini': cloud, Gemini Live (your own key);
 *  - 'duplex': free, on this PC (Silero VAD, Smart Turn, Parakeet, Piper), the default once its parts are there.
 * The cloud modes run in the browser and reach the server through POST /voice/calls/:id/tool; the free mode runs here
 * (DuplexSession). The call tools have one implementation for all three (calltools.ts#runCallTool): `end_call` is
 * refused after "wacht", while a task runs, and always allowed after your own "hang maar op".
 */

export type CallModeId = 'realtime' | 'gemini' | 'duplex';

export type CallPhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended';

export interface CallModeEvents {
  phase: { phase: CallPhase };
  /** What you said (final = the turn is over and goes to the bot). */
  user: { text: string; final: boolean };
  /** A sentence the bot is about to say. */
  bot: { text: string; epoch: number };
  /** You talked while the bot spoke: it stopped; `heard` is what you actually heard of its answer. */
  interrupted: { heard: string; epoch: number };
  /** Time from the end of your sentence to the bot's first sound, split up (ms). */
  latency: { totalMs: number; sttMs: number; turnMs: number; brainMs: number; ttsMs: number; waitMs: number };
  error: { message: string };
  ended: { reason: string };
}

export type CallModeEvent = { [K in keyof CallModeEvents]: { type: K } & CallModeEvents[K] }[keyof CallModeEvents];

export interface CallMode {
  /** 'duplex' (free, this PC) or a cloud mode. */
  readonly id: CallModeId;
  start(): Promise<void>;
  /** Hang up (idempotent). */
  stop(reason?: string): void;
  on(cb: (e: CallModeEvent) => void): () => void;
}

/** What the bot can do with the call it is in. Every mode routes the tools through these. */
export interface CallToolHooks {
  /**
   * The bot wants to hang up. The rules are calltools.ts#runCallTool `end_call` (`runId`: the run that calls it); a
   * mode says the goodbye first and only hangs up once it has been heard. Returns the text for the bot (a refusal
   * when the user just said "wacht" or "nee", or a task still runs).
   */
  endCall(args: { reason: string; goodbye?: string; summary?: string; runId?: string }): Promise<string>;
}

/** Calls in progress per call id, for the tools (`ctx.services.voiceCallModes`). */
export type CallModeRegistry = Map<string, CallMode & CallToolHooks>;
