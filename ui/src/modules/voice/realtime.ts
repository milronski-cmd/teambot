/**
 * Minimal OpenAI Realtime client over WebRTC. Audio flows browser ↔ OpenAI directly on media tracks; JSON events on
 * the "oai-events" data channel. Authentication uses the short-lived client secret minted by our server.
 */

export type RtState = 'connecting' | 'listening' | 'user' | 'thinking' | 'speaking';

export interface RtCallbacks {
  onState(s: RtState): void;
  onConnected(): void;
  onCaption(c: { id: string; role: 'user' | 'assistant'; text: string; final: boolean }): void;
  onUsage(u: any): void;
  onTranscriptionUsage(u: any): void;
  onFunctionCall(c: { name: string; callId: string; args: any }): void;
  onError(message: string, fatal: boolean): void;
  /** The bot's voice is playing (true) or stopped/cleared (false). */
  onSpeaking?(on: boolean): void;
  /** You are talking (the server's voice detection). */
  onUserSpeaking?(on: boolean): void;
}

const IGNORED_ERRORS = new Set(['response_cancel_not_active', 'conversation_already_has_active_response']);

export class RealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStreamTrack | null = null;
  private partial = new Map<string, string>();
  private closed = false;
  private speaking = false;

  constructor(private cb: RtCallbacks) {}

  async connect(stream: MediaStream, secret: string, rtcUrl: string, speaker: HTMLAudioElement) {
    const pc = new RTCPeerConnection();
    this.pc = pc;
    pc.ontrack = (e) => {
      speaker.srcObject = e.streams[0];
      // iOS may refuse to start the sound outside a tap: say so instead of a silent call.
      speaker.play().catch(() => this.cb.onError('Het geluid van de bot startte niet. Tik op Onderbreken of zet het geluid van je toestel aan.', false));
    };
    this.mic = stream.getAudioTracks()[0];
    pc.addTrack(this.mic, stream);
    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.onmessage = (e) => {
      try {
        this.handle(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (pc.connectionState === 'failed') this.cb.onError('De verbinding met OpenAI is verbroken.', true);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(rtcUrl, { method: 'POST', body: offer.sdp, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/sdp' } });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let msg = t;
      try {
        msg = JSON.parse(t)?.error?.message || t;
      } catch {
        /* text */
      }
      throw new Error(`OpenAI weigerde de verbinding (${res.status}): ${String(msg).slice(0, 200)}`);
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  }

  private send(ev: any) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev));
  }

  private handle(ev: any) {
    switch (ev.type) {
      case 'session.created':
        this.cb.onConnected();
        this.cb.onState('listening');
        break;
      case 'input_audio_buffer.speech_started':
        this.cb.onState('user');
        this.cb.onUserSpeaking?.(true);
        break;
      case 'input_audio_buffer.speech_stopped':
        this.cb.onState('thinking');
        this.cb.onUserSpeaking?.(false);
        break;
      case 'response.created':
        if (!this.speaking) this.cb.onState('thinking');
        break;
      case 'output_audio_buffer.started':
        this.speaking = true;
        this.cb.onState('speaking');
        this.cb.onSpeaking?.(true);
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.speaking = false;
        this.cb.onState('listening');
        this.cb.onSpeaking?.(false);
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const t = (this.partial.get(ev.item_id) || '') + (ev.delta || '');
        this.partial.set(ev.item_id, t);
        this.cb.onCaption({ id: ev.item_id, role: 'user', text: t, final: false });
        break;
      }
      case 'conversation.item.input_audio_transcription.completed':
        this.partial.delete(ev.item_id);
        this.cb.onCaption({ id: ev.item_id, role: 'user', text: String(ev.transcript || '').trim(), final: true });
        if (ev.usage) this.cb.onTranscriptionUsage(ev.usage);
        break;
      case 'response.output_audio_transcript.delta': {
        const id = 'a_' + (ev.item_id || ev.response_id);
        const t = (this.partial.get(id) || '') + (ev.delta || '');
        this.partial.set(id, t);
        this.cb.onCaption({ id, role: 'assistant', text: t, final: false });
        break;
      }
      case 'response.output_audio_transcript.done': {
        const id = 'a_' + (ev.item_id || ev.response_id);
        const text = String(ev.transcript ?? this.partial.get(id) ?? '').trim();
        this.partial.delete(id);
        this.cb.onCaption({ id, role: 'assistant', text, final: true });
        break;
      }
      case 'response.done': {
        const r = ev.response || {};
        if (r.usage) this.cb.onUsage(r.usage);
        for (const item of r.output || []) {
          if (item?.type !== 'function_call') continue;
          let args: any = {};
          try {
            args = JSON.parse(item.arguments || '{}');
          } catch {
            args = {};
          }
          this.cb.onFunctionCall({ name: item.name, callId: item.call_id, args });
        }
        if (!this.speaking) this.cb.onState('listening');
        break;
      }
      case 'error':
        if (!IGNORED_ERRORS.has(ev.error?.code)) this.cb.onError(ev.error?.message || 'Onbekende fout van OpenAI', false);
        break;
    }
  }

  mute(on: boolean) {
    if (this.mic) this.mic.enabled = !on;
  }

  /** Barge-in by button: stop the current answer immediately. */
  interrupt() {
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
  }

  /** A tool result; `speak` = let the model answer now (not after an accepted end_call: the goodbye is said). */
  functionResult(callId: string, output: any, speak = true) {
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) } });
    if (speak) this.send({ type: 'response.create' });
  }

  isSpeaking() {
    return this.speaking;
  }

  /** Tell the voice model something new (e.g. a late answer from the bot) and let it speak. */
  inform(text: string) {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
    this.send({ type: 'response.create' });
  }

  close() {
    this.closed = true;
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.getSenders().forEach((s) => s.track?.stop());
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.dc = null;
  }
}
