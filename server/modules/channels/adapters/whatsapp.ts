import fs from 'node:fs';
import { bad } from '../../../core/http.js';
import { splitMessage, toWhatsApp } from '../format.js';
import { assertHost, checkApiBase, fetchBuffer, fetchT } from '../net.js';
import { safeEqual, verifyMetaSignature } from '../security.js';
import { ChannelError, REACTION_EMOJI, type AdapterContext, type AdapterDef, type AdapterRuntime, type Conversation, type InboundAttachment, type Outbound, type ReactionStatus } from '../types.js';

export const GRAPH_API = 'https://graph.facebook.com';
export const GRAPH_VERSION = 'v25.0';
const MAX_TEXT = 4096;
const metaCdn = (h: string) => h.endsWith('.fbsbx.com') || h.endsWith('.facebook.com') || h.endsWith('.fbcdn.net') || h.endsWith('.whatsapp.net');

function graph(ctx: AdapterContext) {
  const cfg = () => ctx.binding().config;
  const url = (p: string) => `${String(cfg().apiBase || GRAPH_API).replace(/\/+$/, '')}/${cfg().apiVersion || GRAPH_VERSION}/${p}`;
  return async function call<T = any>(p: string, o: { method?: string; json?: any; form?: FormData } = {}): Promise<T> {
    const token = ctx.secret('accessToken');
    if (!token) throw new ChannelError('Access token ontbreekt', true);
    const res = await fetchT(url(p), {
      method: o.method || (o.json || o.form ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${token}`, ...(o.json ? { 'content-type': 'application/json' } : {}) },
      body: o.json ? JSON.stringify(o.json) : o.form,
      timeoutMs: 60_000,
      signal: ctx.signal,
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && !j.error) return j as T;
    const e = j.error || {};
    const code = Number(e.code || res.status);
    if (code === 190) throw new ChannelError('Meta weigert de access token (verlopen of ingetrokken). Maak een permanente systeemgebruiker-token.', true);
    if (code === 131047) throw new ChannelError('Buiten het 24-uursvenster: WhatsApp staat vrije berichten alleen toe binnen 24 uur na het laatste bericht van deze persoon (anders is een goedgekeurde sjabloon nodig).');
    throw new ChannelError(`WhatsApp: ${e.message || 'HTTP ' + res.status}${e.code ? ` (code ${e.code})` : ''}`);
  };
}

/**
 * WhatsApp Cloud API (official, by Meta). Inbound arrives as a webhook on
 * /api/public/hooks/channels/<id>/whatsapp, verified with X-Hub-Signature-256.
 * Requires a Meta business app + a public HTTPS URL.
 */
export const whatsappAdapter: AdapterDef = {
  id: 'whatsapp',
  label: 'WhatsApp',
  description: 'Officiële WhatsApp Cloud API van Meta, voor bots die de klanten van je eigen bedrijf helpen. Vereist een Meta-bedrijfsaccount, een eigen telefoonnummer en een publieke HTTPS-URL.',
  needsPublicUrl: () => true,
  approveViaChannel: true,
  reactions: true,
  maxText: MAX_TEXT,
  webhookKinds: ['whatsapp'],
  secretFields: [
    { key: 'accessToken', label: 'Access token (permanente systeemgebruiker-token)', required: true },
    { key: 'appSecret', label: 'App secret (App-instellingen › Basis)', required: true },
    { key: 'verifyToken', label: 'Verify token (zelf gekozen, ook in Meta invullen)', required: true },
  ],
  validateSecret(key, v) {
    if (key === 'verifyToken' && v.trim().length < 12) return 'Kies een verify token van minstens 12 tekens.';
    if (key === 'appSecret' && !/^[a-f0-9]{16,64}$/i.test(v.trim())) return 'De app secret is een hexadecimale code.';
    return null;
  },
  async validate(c, o) {
    const phoneNumberId = String(c.phoneNumberId || '').trim();
    if (!/^\d{6,25}$/.test(phoneNumberId)) throw bad('Vul het telefoonnummer-ID in (een getal uit WhatsApp › API Setup).');
    const apiVersion = /^v\d{1,3}\.\d$/.test(String(c.apiVersion || '')) ? String(c.apiVersion) : GRAPH_VERSION;
    return {
      phoneNumberId,
      apiVersion,
      maxAgeHours: Math.min(168, Math.max(1, Number(c.maxAgeHours) || 24)),
      apiBase: await checkApiBase(c.apiBase, o.role, GRAPH_API).catch((e) => {
        throw bad(`API-adres: ${e.message}`);
      }),
    };
  },
  async test(ctx) {
    const r: any = await graph(ctx)(`${ctx.binding().config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
    const hook = ctx.webhookUrl('whatsapp');
    return {
      ok: true,
      detail: `Nummer ${r.display_phone_number || '?'} (${r.verified_name || 'naam onbekend'}) gevonden.${hook ? '' : ' Let op: er is nog geen publieke URL ingesteld, dus Meta kan je webhook niet bereiken.'}`,
      info: { displayPhone: r.display_phone_number, verifiedName: r.verified_name },
    };
  },
  receiveHint({ platformAt }) {
    if (!platformAt)
      return 'Meta heeft de webhook van deze koppeling nog niet gecontroleerd. Vul bij Meta › WhatsApp › Configuratie › Webhook de webhook-URL en de verify token van deze koppeling in en klik op “Verifiëren en opslaan”.';
    return 'Meta heeft de webhook bevestigd, maar stuurde geen bericht. Vink bij Webhook-velden “messages” aan, en stuur het testbericht vanaf een ander nummer dan het bedrijfsnummer zelf.';
  },
  create(ctx) {
    return new WhatsAppRuntime(ctx);
  },
};

class WhatsAppRuntime implements AdapterRuntime {
  private call;
  constructor(private ctx: AdapterContext) {
    this.call = graph(ctx);
  }

  /** Check the token and the number before saying we listen (a wrong token is fatal, see graph()). */
  async start() {
    const r: any = await this.call(`${this.ctx.binding().config.phoneNumberId}?fields=display_phone_number,verified_name`);
    const cur = this.ctx.binding();
    this.ctx.setState({ info: { ...(cur.state?.info || {}), displayPhone: r.display_phone_number, verifiedName: r.verified_name } });
    return 'listening' as const;
  }
  async stop() {}

  async webhook(_kind: string, req: any, res: any) {
    if (req.method === 'GET') {
      const q = req.query || {};
      const ok = q['hub.mode'] === 'subscribe' && safeEqual(String(q['hub.verify_token'] || ''), this.ctx.secret('verifyToken') || '');
      if (!ok) {
        this.ctx.log('in', 'rejected', 'Webhook-verificatie geweigerd (verkeerde verify token)');
        return void res.status(403).json({ error: 'Verificatie mislukt' });
      }
      this.ctx.log('system', 'verified', 'Webhook geverifieerd door Meta');
      return void res.status(200).type('text/plain').send(String(q['hub.challenge'] || ''));
    }
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const v = verifyMetaSignature({ appSecret: this.ctx.secret('appSecret') || '', signature: req.headers['x-hub-signature-256'], body: raw });
    if (!v.ok) {
      this.ctx.log('in', 'rejected', `Webhook geweigerd: ${v.reason}`);
      return void res.status(401).json({ error: 'Ongeldige handtekening' });
    }
    let body: any;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return void res.status(400).json({ error: 'Ongeldige JSON' });
    }
    res.status(200).json({ ok: true });
    await this.process(body);
  }

  /** Process a verified webhook body (exposed for tests). */
  async process(body: any) {
    const cfg = this.ctx.binding().config;
    const maxAge = (Number(cfg.maxAgeHours) || 24) * 3600_000;
    for (const entry of body?.entry || []) {
      for (const ch of entry.changes || []) {
        if (ch.field !== 'messages') continue;
        const v = ch.value || {};
        if (String(v.metadata?.phone_number_id || '') !== String(cfg.phoneNumberId)) {
          this.ctx.log('in', 'ignored', 'Webhook voor een ander telefoonnummer-ID genegeerd');
          continue;
        }
        const names = new Map<string, string>((v.contacts || []).map((c: any) => [String(c.wa_id), c.profile?.name || String(c.wa_id)]));
        for (const s of v.statuses || []) if (s.status === 'failed') this.ctx.log('out', 'error', `WhatsApp kon een bericht niet afleveren: ${s.errors?.[0]?.title || 'onbekend'}`, { conversationId: String(s.recipient_id || '') });
        for (const m of v.messages || []) {
          const ts = Number(m.timestamp || 0) * 1000;
          if (ts && Date.now() - ts > maxAge) {
            this.ctx.log('in', 'ignored', 'Oud bericht genegeerd (mogelijke herhaling)', { senderId: String(m.from) });
            continue;
          }
          await this.handleMessage(m, names.get(String(m.from)) || String(m.from)).catch((e) => this.ctx.log('in', 'error', `Bericht verwerken mislukt: ${e?.message || e}`));
        }
      }
    }
  }

  private media(id: string, name: string, mime: string, kind: InboundAttachment['kind']): InboundAttachment {
    return {
      name,
      mime,
      kind,
      fetch: async () => {
        const info: any = await this.call(encodeURIComponent(id));
        const maxMb = Math.min(50, Math.max(1, Number(this.ctx.binding().config.maxFileMb) || 20));
        if (info.file_size && info.file_size > maxMb * 1024 * 1024) throw new ChannelError('Bestand is te groot');
        const base = String(this.ctx.binding().config.apiBase || GRAPH_API);
        const u = base === GRAPH_API ? assertHost(info.url, metaCdn).toString() : info.url;
        return fetchBuffer(u, { headers: { authorization: `Bearer ${this.ctx.secret('accessToken')}` }, maxBytes: maxMb * 1024 * 1024, signal: this.ctx.signal });
      },
    };
  }

  private async handleMessage(m: any, name: string) {
    const from = String(m.from || '');
    if (!from) return;
    if (m.type === 'interactive' || m.type === 'button') {
      const id = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || m.button?.payload || '';
      if (String(id).startsWith('tb:')) {
        const text = await this.ctx.action({ conversationId: from, senderId: from, actionId: String(id).slice(3) });
        if (text) {
          const conv = { external_id: from, meta: {} } as any;
          await this.send(conv, { text }).catch(() => {});
        }
        return;
      }
    }
    let text = '';
    const atts: InboundAttachment[] = [];
    switch (m.type) {
      case 'text':
        text = m.text?.body || '';
        break;
      case 'image':
        text = m.image?.caption || '';
        atts.push(this.media(m.image.id, `foto-${m.id.slice(-8)}.jpg`, m.image.mime_type || 'image/jpeg', 'image'));
        break;
      case 'audio':
        atts.push(this.media(m.audio.id, `${m.audio.voice ? 'spraakbericht' : 'audio'}-${m.id.slice(-8)}.ogg`, (m.audio.mime_type || 'audio/ogg').split(';')[0], m.audio.voice ? 'voice' : 'audio'));
        break;
      case 'video':
        text = m.video?.caption || '';
        atts.push(this.media(m.video.id, `video-${m.id.slice(-8)}.mp4`, m.video.mime_type || 'video/mp4', 'video'));
        break;
      case 'document':
        text = m.document?.caption || '';
        atts.push(this.media(m.document.id, m.document.filename || `document-${m.id.slice(-8)}`, m.document.mime_type || 'application/octet-stream', 'file'));
        break;
      case 'sticker':
        text = '[sticker]';
        break;
      case 'location':
        text = `📍 Locatie: ${m.location?.latitude}, ${m.location?.longitude}${m.location?.name ? ` (${m.location.name})` : ''}`;
        break;
      case 'interactive':
        text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
        break;
      case 'button':
        text = m.button?.text || '';
        break;
      case 'reaction':
        return;
      default:
        text = `[niet-ondersteund berichttype: ${m.type}]`;
    }
    await this.ctx.receive({
      messageId: `w${m.id}`,
      conversation: { id: from, title: name, private: true },
      sender: { id: from, name, handle: '+' + from },
      text,
      attachments: atts,
      date: Number(m.timestamp || 0) * 1000 || undefined,
      extra: { lastMessageId: m.id },
      reactTo: `${from}:${m.id}`,
    });
  }

  private async sendText(to: string, out: Outbound): Promise<string[]> {
    const ids: string[] = [];
    const chunks = splitMessage(out.text || '', MAX_TEXT - 100);
    for (let i = 0; i < chunks.length; i++) {
      const body = toWhatsApp(chunks[i]).slice(0, MAX_TEXT);
      const last = i === chunks.length - 1;
      const json =
        last && out.buttons?.length
          ? {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to,
              type: 'interactive',
              interactive: { type: 'button', body: { text: body.slice(0, 1024) }, action: { buttons: out.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: ('tb:' + b.id).slice(0, 256), title: b.label.slice(0, 20) } })) } },
            }
          : { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } };
      const r: any = await this.call(`${this.ctx.binding().config.phoneNumberId}/messages`, { json });
      ids.push(`w${r.messages?.[0]?.id || Date.now()}`);
    }
    for (const f of out.files || []) {
      const fd = new FormData();
      fd.append('messaging_product', 'whatsapp');
      fd.append('type', f.mime);
      fd.append('file', new Blob([fs.readFileSync(f.path)], { type: f.mime }), f.name);
      const up: any = await this.call(`${this.ctx.binding().config.phoneNumberId}/media`, { form: fd });
      const kind = /^image\/(jpeg|png)$/.test(f.mime) ? 'image' : /^audio\//.test(f.mime) ? 'audio' : /^video\/(mp4|3gpp)$/.test(f.mime) ? 'video' : 'document';
      const r: any = await this.call(`${this.ctx.binding().config.phoneNumberId}/messages`, {
        json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: kind, [kind]: kind === 'document' ? { id: up.id, filename: f.name } : { id: up.id } },
      });
      ids.push(`w${r.messages?.[0]?.id || Date.now()}`);
    }
    return ids;
  }

  async send(conv: Conversation, out: Outbound) {
    return this.sendText(conv.external_id, out);
  }

  async sendTo(target: string, out: Outbound) {
    const to = target.replace(/[^\d]/g, '');
    if (to.length < 8 || to.length > 15) throw new ChannelError('Geef een telefoonnummer in internationale vorm op (bijv. 31612345678).');
    const ids = await this.sendText(to, out);
    return { conversationId: to, title: '+' + to, private: true, ids };
  }

  /** Mark as read + typing indicator (dismissed on reply or after ~25 s). */
  async typing(conv: Conversation) {
    const id = conv.meta?.lastMessageId;
    if (!id) return;
    await this.call(`${this.ctx.binding().config.phoneNumberId}/messages`, { json: { messaging_product: 'whatsapp', status: 'read', message_id: id, typing_indicator: { type: 'text' } } });
  }

  /** Status reaction (Cloud API "reaction" message; a new one replaces the earlier one). */
  async react(_conv: Conversation, reactTo: string, status: ReactionStatus) {
    const i = reactTo.indexOf(':');
    const to = reactTo.slice(0, i);
    const messageId = reactTo.slice(i + 1);
    if (!/^\d{6,20}$/.test(to) || !messageId) return;
    await this.call(`${this.ctx.binding().config.phoneNumberId}/messages`, { json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'reaction', reaction: { message_id: messageId, emoji: REACTION_EMOJI[status] } } });
  }
}
