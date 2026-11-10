import fs from 'node:fs';
import { bad } from '../../../core/http.js';
import { assertPublicUrl } from '../../../tools/builtin/web.js';
import { fetchT } from '../net.js';
import { safeEqual, signWebhook, verifyWebhookSignature } from '../security.js';
import { ChannelError, type AdapterContext, type AdapterDef, type AdapterRuntime, type Conversation, type Outbound } from '../types.js';

const MAX_BODY = 4 * 1024 * 1024;

async function checkCallback(url: string, role: string, allowPrivate: boolean) {
  if (!url) return '';
  const privileged = role === 'owner' || role === 'admin';
  const u = await assertPublicUrl(url, allowPrivate && privileged);
  return u.toString();
}

/**
 * Generic webhook: your own integrations post signed JSON to TeamBot and get the
 * answer synchronously (in the HTTP response) or later on a callback URL (signed the same way).
 */
export const webhookAdapter: AdapterDef = {
  id: 'webhook',
  label: 'Webhook',
  description: 'Eigen HTTP-integraties (Home Assistant, n8n, scripts): ondertekende JSON in, antwoord terug.',
  needsPublicUrl: () => false,
  approveViaChannel: false,
  maxText: 100_000,
  webhookKinds: ['webhook'],
  secretFields: [{ key: 'signingSecret', label: 'Gedeeld geheim (HMAC-SHA256)', required: true }],
  validateSecret(key, v) {
    if (key === 'signingSecret' && v.trim().length < 24) return 'Gebruik een geheim van minstens 24 tekens.';
    return null;
  },
  async validate(c, o) {
    const replyMode = ['sync', 'callback', 'none'].includes(c.replyMode) ? c.replyMode : 'sync';
    const allowPrivateCallback = !!c.allowPrivateCallback;
    let callbackUrl = String(c.callbackUrl || '').trim();
    try {
      callbackUrl = await checkCallback(callbackUrl, o.role, allowPrivateCallback);
    } catch (e: any) {
      throw bad(`Callback-URL: ${e.message}`);
    }
    if (replyMode === 'callback' && !callbackUrl) throw bad('Vul een callback-URL in of kies “antwoord in de HTTP-response”.');
    return { replyMode, callbackUrl, allowPrivateCallback, allowBearer: !!c.allowBearer, syncTimeoutSec: Math.min(120, Math.max(5, Number(c.syncTimeoutSec) || 55)) };
  },
  async test(ctx) {
    const c = ctx.binding().config;
    if (c.replyMode === 'callback' && c.callbackUrl) {
      await checkCallback(c.callbackUrl, ctx.ownerRole(), !!c.allowPrivateCallback);
      return { ok: true, detail: `Klaar. Inkomend: POST ${ctx.webhookUrl('webhook') || '/api/public/hooks/channels/' + ctx.bindingId + '/webhook'} · antwoorden gaan naar ${new URL(c.callbackUrl).host}` };
    }
    return { ok: true, detail: `Klaar. Inkomend: POST ${ctx.webhookUrl('webhook') || '/api/public/hooks/channels/' + ctx.bindingId + '/webhook'}` };
  },
  receiveHint({ webhookUrl }) {
    return `Er kwam geen geldig verzoek binnen. Stuur een ondertekende POST naar ${webhookUrl || 'het webhook-pad van deze koppeling'} met als tekst “test” en de code.`;
  },
  create(ctx) {
    return new WebhookRuntime(ctx);
  },
};

interface Pending {
  resolve(r: { text: string; files: { name: string; mime: string; size: number }[] }): void;
}

class WebhookRuntime implements AdapterRuntime {
  private waiters = new Map<string, Pending[]>();
  constructor(private ctx: AdapterContext) {}

  async start() {
    return 'listening' as const;
  }
  async stop() {
    for (const list of this.waiters.values()) for (const w of list) w.resolve({ text: '', files: [] });
    this.waiters.clear();
  }

  async webhook(_kind: string, req: any, res: any) {
    if (req.method !== 'POST') return void res.status(405).json({ error: 'Gebruik POST' });
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (raw.length > MAX_BODY) return void res.status(413).json({ error: 'Te groot' });
    const cfg = this.ctx.binding().config;
    const secret = this.ctx.secret('signingSecret') || '';
    const sig = req.headers['x-teambot-signature'];
    let dedupeKey = '';
    if (sig) {
      const v = verifyWebhookSignature({ secret, timestamp: req.headers['x-teambot-timestamp'], signature: sig, body: raw });
      if (!v.ok) {
        this.ctx.log('in', 'rejected', `Webhook geweigerd: ${v.reason}`);
        return void res.status(401).json({ error: v.reason });
      }
      dedupeKey = 'sig:' + String(sig).slice(-32);
    } else if (cfg.allowBearer && safeEqual(String(req.headers.authorization || ''), `Bearer ${secret}`)) {
      dedupeKey = '';
    } else {
      this.ctx.log('in', 'rejected', 'Webhook zonder geldige handtekening geweigerd');
      return void res.status(401).json({ error: 'Handtekening ontbreekt of is ongeldig' });
    }
    let body: any;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return void res.status(400).json({ error: 'Ongeldige JSON' });
    }
    const text = typeof body.text === 'string' ? body.text : '';
    const senderId = String(body.sender?.id ?? body.sender ?? '').slice(0, 200);
    if (!senderId) return void res.status(400).json({ error: 'sender.id ontbreekt' });
    const convId = String(body.conversation?.id ?? body.conversation ?? senderId).slice(0, 200);
    const msgId = body.id ? `id:${String(body.id).slice(0, 200)}` : dedupeKey || `t:${Date.now()}:${Math.random()}`;
    const atts = Array.isArray(body.attachments)
      ? body.attachments.slice(0, 5).map((a: any) => ({ name: String(a.name || 'bestand'), mime: String(a.mime || 'application/octet-stream'), data: Buffer.from(String(a.base64 || ''), 'base64') }))
      : [];
    const wantSync = cfg.replyMode === 'sync' && body.wait !== false;
    const wait = wantSync ? this.waitFor(convId, (Number(cfg.syncTimeoutSec) || 55) * 1000) : null;
    const r = await this.ctx.receive({
      messageId: msgId,
      conversation: { id: convId, title: String(body.conversation?.title || body.sender?.name || convId).slice(0, 120), private: body.conversation?.private !== false },
      sender: { id: senderId, name: String(body.sender?.name || senderId).slice(0, 120) },
      text,
      attachments: atts,
    });
    const status = r?.status || 'ok';
    if (status === 'duplicate') return void res.status(200).json({ ok: true, duplicate: true });
    if (status === 'blocked') {
      this.cancelWait(convId, wait);
      // Not for the bot, but a routine that explicitly accepts unknown senders started from it.
      if (r?.routines?.length) return void res.status(202).json({ ok: true, status: 'routine', routines: r.routines });
      return void res.status(403).json({ error: 'Afzender staat niet op de allowlist' });
    }
    if (status === 'rate_limited') return void res.status(429).json({ error: 'Te veel berichten' });
    if (wait && (status === 'command' || status === 'paired' || status === 'pair_failed')) {
      const quick = await Promise.race([wait.promise, new Promise<null>((r) => setTimeout(() => r(null), 50))]);
      this.cancelWait(convId, wait);
      if (quick?.text) return void res.status(200).json({ ok: true, status, reply: quick.text, files: [] });
    }
    if (status !== 'ok' || !wait || r?.quiet || r?.refused) {
      this.cancelWait(convId, wait);
      // The bot does not answer this one (a routine trigger keeps it quiet, or its engine refused): don't wait for it.
      return void res.status(202).json({ ok: true, status: r?.refused ? 'refused' : r?.quiet ? 'routine' : status, threadId: r?.threadId, ...(r?.routines?.length ? { routines: r.routines } : {}) });
    }
    const reply = await wait.promise;
    if (!reply) return void res.status(202).json({ ok: true, status: 'pending', threadId: r?.threadId, detail: 'Het antwoord duurde te lang; het staat in TeamBot' + (cfg.callbackUrl ? ' en wordt naar de callback-URL gestuurd.' : '.') });
    res.status(200).json({ ok: true, threadId: r?.threadId, reply: reply.text, files: reply.files });
  }

  private waitFor(convId: string, ms: number) {
    let done!: (v: any) => void;
    const promise = new Promise<{ text: string; files: any[] } | null>((r) => (done = r));
    const p: Pending = { resolve: (v) => done(v) };
    const list = this.waiters.get(convId) || [];
    list.push(p);
    this.waiters.set(convId, list);
    const t = setTimeout(() => {
      this.waiters.set(convId, (this.waiters.get(convId) || []).filter((x) => x !== p));
      done(null);
    }, ms);
    t.unref?.();
    return { promise, p };
  }

  private cancelWait(convId: string, w: { p: Pending } | null) {
    if (!w) return;
    this.waiters.set(convId, (this.waiters.get(convId) || []).filter((x) => x !== w.p));
    w.p.resolve({ text: '', files: [] });
  }

  private async post(body: any): Promise<void> {
    const cfg = this.ctx.binding().config;
    if (!cfg.callbackUrl) throw new ChannelError('Geen callback-URL ingesteld; het antwoord staat alleen in TeamBot.');
    const url = await checkCallback(cfg.callbackUrl, this.ctx.ownerRole(), !!cfg.allowPrivateCallback);
    const json = JSON.stringify(body);
    const s = signWebhook(this.ctx.secret('signingSecret') || '', json);
    const res = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-teambot-timestamp': s.timestamp, 'x-teambot-signature': s.signature }, body: json, timeoutMs: 20_000, redirect: 'manual' });
    if (res.status >= 300) throw new ChannelError(`Callback gaf HTTP ${res.status}`);
  }

  async send(conv: Conversation, out: Outbound): Promise<string[]> {
    const files = (out.files || []).map((f) => ({ name: f.name, mime: f.mime, size: f.size }));
    const list = this.waiters.get(conv.external_id) || [];
    const w = list.shift();
    if (w) {
      this.waiters.set(conv.external_id, list);
      w.resolve({ text: out.text, files });
      return [`r${Date.now()}`];
    }
    await this.post({
      type: 'message',
      bindingId: this.ctx.bindingId,
      conversation: { id: conv.external_id, title: conv.title },
      text: out.text,
      files: (out.files || []).filter((f) => f.size <= 2 * 1024 * 1024).map((f) => ({ name: f.name, mime: f.mime, size: f.size, base64: fs.readFileSync(f.path).toString('base64') })),
    });
    return [`r${Date.now()}`];
  }

  async sendTo(target: string, out: Outbound) {
    await this.post({ type: 'message', bindingId: this.ctx.bindingId, conversation: { id: target }, to: target, text: out.text });
    return { conversationId: target.slice(0, 200), title: target.slice(0, 120), private: true, ids: [`r${Date.now()}`] };
  }
}
