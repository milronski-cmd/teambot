import fs from 'node:fs';
import WebSocket from 'ws';
import { bad } from '../../../core/http.js';
import { fromSlackText, splitMessage, toSlackMrkdwn } from '../format.js';
import { assertHost, checkApiBase, fetchBuffer, fetchT } from '../net.js';
import { verifySlackSignature } from '../security.js';
import { ChannelError, type AdapterContext, type AdapterDef, type AdapterRuntime, type Conversation, type Outbound, type ReactionStatus } from '../types.js';

export const SLACK_API = 'https://slack.com/api';
const slackHost = (h: string) => h === 'files.slack.com' || h.endsWith('.slack.com') || h.endsWith('.slack-edge.com');

/** reactions:write = the status reactions (👀, then ✅ or ❌); without it Slack refuses them and TeamBot skips them. */
export const SLACK_SCOPES = ['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write', 'files:read', 'files:write', 'users:read', 'reactions:write'];

/** Slack's names for the status reactions. */
export const SLACK_REACTION: Record<ReactionStatus, string> = { working: 'eyes', done: 'white_check_mark', error: 'x' };

/** App manifest to paste in api.slack.com/apps › Create New App › From an app manifest. */
export function slackManifest(o: { name: string; mode: 'socket' | 'events'; eventsUrl?: string }) {
  const name = (o.name || 'TeamBot').slice(0, 35);
  const settings: any = {
    event_subscriptions: { bot_events: ['app_mention', 'message.im'] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: o.mode === 'socket',
    token_rotation_enabled: false,
  };
  if (o.mode === 'events') {
    settings.event_subscriptions.request_url = o.eventsUrl || 'https://JOUW-PUBLIEKE-URL/api/public/hooks/channels/<koppeling>/slack';
    settings.interactivity.request_url = settings.event_subscriptions.request_url;
  }
  return {
    display_information: { name, description: 'AI-bot via TeamBot', background_color: '#4f46e5' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: { scopes: { bot: SLACK_SCOPES } },
    settings,
  };
}

function api(ctx: AdapterContext) {
  const base = () => String(ctx.binding().config.apiBase || SLACK_API).replace(/\/+$/, '');
  return async function call<T = any>(method: string, body: Record<string, any> = {}, o: { token?: string; form?: boolean } = {}): Promise<T> {
    const token = o.token ?? ctx.secret('botToken');
    if (!token) throw new ChannelError('Bot-token (xoxb-) ontbreekt', true);
    for (let attempt = 0; ; attempt++) {
      const res = await fetchT(`${base()}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': o.form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
        body: o.form ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(body),
        timeoutMs: 30_000,
        signal: ctx.signal,
      });
      if (res.status === 429 && attempt < 2) {
        const wait = Math.min(30, Number(res.headers.get('retry-after') || 1)) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const j: any = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
      if (j.ok) return j as T;
      const fatal = ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type'].includes(j.error);
      throw new ChannelError(fatal ? `Slack weigert de token (${j.error}). Controleer de tokens in je Slack-app.` : `Slack: ${j.error || 'fout'}${j.needed ? ` (scope nodig: ${j.needed})` : ''}`, fatal);
    }
  };
}

/** Slack adapter: Socket Mode (default, no public URL) or Events API over HTTPS. */
export const slackAdapter: AdapterDef = {
  id: 'slack',
  label: 'Slack',
  description: 'Je bot in Slack: privéberichten en @vermeldingen in kanalen. Socket Mode werkt zonder publieke URL.',
  needsPublicUrl: (c) => c.mode === 'events',
  approveViaChannel: true,
  // needs the reactions:write scope (in the manifest); an app installed without it is skipped quietly
  reactions: true,
  maxText: 3900,
  webhookKinds: ['slack'],
  secretFields: [
    { key: 'botToken', label: 'Bot User OAuth Token (xoxb-…)', required: true },
    { key: 'appToken', label: 'App-Level Token (xapp-…, scope connections:write)', required: (c) => c.mode !== 'events' },
    { key: 'signingSecret', label: 'Signing Secret', required: (c) => c.mode === 'events' },
  ],
  validateSecret(key, v) {
    if (key === 'botToken' && !/^xoxb-/.test(v.trim())) return 'De bot-token begint met xoxb-.';
    if (key === 'appToken' && !/^xapp-/.test(v.trim())) return 'De app-level token begint met xapp-.';
    if (key === 'signingSecret' && !/^[a-f0-9]{20,64}$/i.test(v.trim())) return 'De Signing Secret is een hexadecimale code.';
    return null;
  },
  async validate(c, o) {
    return {
      mode: c.mode === 'events' ? 'events' : 'socket',
      apiBase: await checkApiBase(c.apiBase, o.role, SLACK_API).catch((e) => {
        throw bad(`API-adres: ${e.message}`);
      }),
    };
  },
  async test(ctx) {
    const r: any = await api(ctx)('auth.test');
    let extra = '';
    if (ctx.binding().config.mode !== 'events') {
      const app = ctx.secret('appToken');
      const res = await fetchT(`${String(ctx.binding().config.apiBase || SLACK_API)}/apps.connections.open`, { method: 'POST', headers: { authorization: `Bearer ${app}` }, timeoutMs: 15_000, signal: ctx.signal });
      const j: any = await res.json().catch(() => ({}));
      extra = j.ok ? ' · Socket Mode OK' : ` · Socket Mode faalt: ${j.error || res.status}`;
      if (!j.ok) return { ok: false, detail: `Bot-token OK (${r.team}), maar app-level token faalt: ${j.error || res.status}` };
    }
    return { ok: true, detail: `Tokens werken: @${r.user} in ${r.team}${extra}`, info: { botName: r.user, botUserId: r.user_id, team: r.team, teamId: r.team_id } };
  },
  receiveHint({ config, platformAt }) {
    if (config.mode === 'events')
      return platformAt
        ? 'Slack heeft het webhook-adres bevestigd, maar stuurde geen bericht. Zet in je Slack-app bij Event Subscriptions de events message.im en app_mention aan, en installeer de app daarna opnieuw.'
        : 'Slack heeft het webhook-adres nog niet bevestigd. Plak bij Event Subscriptions de webhook-URL van deze koppeling; Slack controleert hem dan meteen.';
    return 'Er kwam niets binnen via Socket Mode. Zet in je Slack-app bij Event Subscriptions de events message.im en app_mention aan, en bij App Home het tabblad Messages. Installeer de app daarna opnieuw.';
  },
  create(ctx) {
    return new SlackRuntime(ctx);
  },
};

class SlackRuntime implements AdapterRuntime {
  private call;
  private ws: WebSocket | null = null;
  private stopped = false;
  private botUserId = '';
  private names = new Map<string, string>();
  constructor(private ctx: AdapterContext) {
    this.call = api(ctx);
  }

  async start() {
    const r: any = await this.call('auth.test');
    this.botUserId = r.user_id;
    const cur = this.ctx.binding();
    this.ctx.setState({ info: { ...(cur.state?.info || {}), botName: r.user, botUserId: r.user_id, team: r.team, teamId: r.team_id } });
    if (cur.config.mode === 'events') return 'listening' as const;
    await this.openSocket();
    return 'connected' as const;
  }

  async stop() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private async openSocket(): Promise<void> {
    const token = this.ctx.secret('appToken');
    if (!token) throw new ChannelError('App-level token (xapp-) ontbreekt', true);
    const base = String(this.ctx.binding().config.apiBase || SLACK_API).replace(/\/+$/, '');
    const res = await fetchT(`${base}/apps.connections.open`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' }, timeoutMs: 20_000, signal: this.ctx.signal });
    const j: any = await res.json().catch(() => ({}));
    if (!j.ok || !j.url) throw new ChannelError(`Socket Mode openen mislukt: ${j.error || res.status}`, ['invalid_auth', 'not_authed', 'not_allowed_token_type'].includes(j.error));
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(j.url, { handshakeTimeout: 20_000, maxPayload: 5_000_000 });
      let hello = false;
      const old = this.ws;
      this.ws = ws;
      const t = setTimeout(() => {
        if (!hello) {
          ws.terminate();
          reject(new ChannelError('Slack stuurde geen hello binnen 30 s'));
        }
      }, 30_000);
      ws.on('message', (data) => {
        let env: any;
        try {
          env = JSON.parse(String(data));
        } catch {
          return;
        }
        if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
        if (env.type === 'hello') {
          hello = true;
          clearTimeout(t);
          old?.close();
          resolve();
          return;
        }
        if (env.type === 'disconnect') {
          if (env.reason === 'link_disabled') return this.ctx.fail(new ChannelError('Socket Mode staat uit in de Slack-app-instellingen', true));
          // refresh_requested / warning: open a fresh socket before this one closes.
          if (ws === this.ws && !this.stopped) this.openSocket().catch((e) => this.ctx.fail(e));
          return;
        }
        this.onEnvelope(env).catch((e) => this.ctx.log('in', 'error', `Slack-bericht verwerken mislukt: ${e?.message || e}`));
      });
      ws.on('close', () => {
        clearTimeout(t);
        if (!hello) return reject(new ChannelError('Slack-verbinding gesloten voor hello'));
        if (ws === this.ws && !this.stopped && !this.ctx.signal.aborted) this.ctx.fail(new ChannelError('Verbinding met Slack verbroken'));
      });
      ws.on('error', (e) => {
        if (!hello) {
          clearTimeout(t);
          reject(new ChannelError(`Slack-socket: ${e.message}`));
        }
      });
    });
  }

  private async onEnvelope(env: any) {
    if (env.type === 'events_api') return this.onEventCallback(env.payload);
    if (env.type === 'interactive') return this.onInteractive(env.payload);
  }

  /** Events API payload (`event_callback`) — shared by Socket Mode and HTTP. */
  async onEventCallback(p: any) {
    const ev = p?.event;
    if (!ev || p.type !== 'event_callback') return;
    if (ev.bot_id || ev.user === this.botUserId || !ev.user) return;
    if (ev.subtype && ev.subtype !== 'file_share' && ev.subtype !== 'thread_broadcast') return;
    let conv: { id: string; private: boolean; title: string; threadTs?: string };
    if (ev.type === 'message' && ev.channel_type === 'im') conv = { id: ev.thread_ts ? `${ev.channel}:${ev.thread_ts}` : ev.channel, private: true, title: '', threadTs: ev.thread_ts };
    else if (ev.type === 'app_mention') {
      const ts = ev.thread_ts || ev.ts;
      conv = { id: `${ev.channel}:${ts}`, private: false, title: `#${ev.channel}`, threadTs: ts };
    } else return;
    const name = await this.userName(ev.user);
    const maxMb = Math.min(50, Math.max(1, Number(this.ctx.binding().config.maxFileMb) || 20));
    const token = this.ctx.secret('botToken') || '';
    const attachments = (ev.files || []).filter((f: any) => f.url_private_download || f.url_private).map((f: any) => ({
      name: f.name || 'bestand',
      mime: f.mimetype || 'application/octet-stream',
      size: f.size,
      kind: (/^image\//.test(f.mimetype || '') ? 'image' : f.subtype === 'slack_audio' ? 'voice' : 'file') as any,
      fetch: () => fetchBuffer(assertHost(f.url_private_download || f.url_private, slackHost).toString(), { headers: { authorization: `Bearer ${token}` }, maxBytes: maxMb * 1024 * 1024, signal: this.ctx.signal }),
    }));
    const text = fromSlackText(String(ev.text || '').replace(new RegExp(`<@${this.botUserId}>`, 'g'), '')).trim();
    await this.ctx.receive({
      messageId: p.event_id ? `e${p.event_id}` : `m${ev.channel}:${ev.ts}`,
      conversation: { id: conv.id, title: conv.private ? name : conv.title, private: conv.private },
      sender: { id: ev.user, name },
      text,
      attachments,
      date: ev.ts ? Math.round(Number(ev.ts) * 1000) : undefined,
      extra: { channel: ev.channel, threadTs: conv.threadTs || null, teamId: p.team_id || null },
      reactTo: ev.ts ? `${ev.channel}:${ev.ts}` : undefined,
    });
  }

  async onInteractive(p: any) {
    if (p?.type !== 'block_actions') return;
    for (const a of p.actions || []) {
      const id = String(a.action_id || '');
      if (!id.startsWith('tb:')) continue;
      const channel = p.channel?.id || p.container?.channel_id;
      const threadTs = p.message?.thread_ts || p.container?.thread_ts;
      const isIm = String(channel || '').startsWith('D');
      const convId = isIm ? (threadTs ? `${channel}:${threadTs}` : channel) : `${channel}:${threadTs || p.message?.ts}`;
      const text = await this.ctx.action({ conversationId: convId, senderId: p.user?.id, actionId: id.slice(3) });
      if (channel)
        await this.call('chat.postMessage', { channel, text: text || 'Niet (meer) geldig.', ...(threadTs ? { thread_ts: threadTs } : {}) }).catch(() => {});
      if (text && p.message?.ts && channel) await this.call('chat.update', { channel, ts: p.message.ts, text: p.message.text || 'Aanvraag', blocks: [] }).catch(() => {});
    }
  }

  async webhook(_kind: string, req: any, res: any) {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const v = verifySlackSignature({ secret: this.ctx.secret('signingSecret') || '', timestamp: req.headers['x-slack-request-timestamp'], signature: req.headers['x-slack-signature'], body: raw });
    if (!v.ok) {
      this.ctx.log('in', 'rejected', `Slack-verzoek geweigerd: ${v.reason}`);
      return void res.status(401).json({ error: 'Ongeldige handtekening' });
    }
    const type = String(req.headers['content-type'] || '');
    let body: any;
    try {
      body = type.includes('application/x-www-form-urlencoded') ? JSON.parse(new URLSearchParams(raw.toString('utf8')).get('payload') || '{}') : JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return void res.status(400).json({ error: 'Ongeldige JSON' });
    }
    if (body.type === 'url_verification') {
      this.ctx.log('system', 'verified', 'Webhook-adres bevestigd door Slack');
      return void res.status(200).type('text/plain').send(String(body.challenge || ''));
    }
    res.status(200).end();
    if (body.type === 'event_callback') await this.onEventCallback(body).catch((e) => this.ctx.log('in', 'error', `Slack-event mislukt: ${e?.message || e}`));
    else if (body.type === 'block_actions') await this.onInteractive(body).catch(() => {});
  }

  private async userName(id: string) {
    if (this.names.has(id)) return this.names.get(id)!;
    try {
      const r: any = await this.call('users.info', { user: id }, { form: true });
      const n = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || id;
      this.names.set(id, n);
      return n;
    } catch {
      return id;
    }
  }

  private async post(channel: string, threadTs: string | null | undefined, out: Outbound): Promise<string[]> {
    const ids: string[] = [];
    const chunks = splitMessage(out.text || '', 3500);
    for (let i = 0; i < chunks.length; i++) {
      const text = toSlackMrkdwn(chunks[i]);
      const last = i === chunks.length - 1;
      const blocks = last && out.buttons?.length
        ? [
            { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
            { type: 'actions', elements: out.buttons.slice(0, 5).map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.label.slice(0, 70) }, action_id: ('tb:' + b.id).slice(0, 250), value: b.id, ...(b.style ? { style: b.style } : {}) })) },
          ]
        : undefined;
      const r: any = await this.call('chat.postMessage', { channel, text, mrkdwn: true, unfurl_links: false, ...(threadTs ? { thread_ts: threadTs } : {}), ...(blocks ? { blocks } : {}) });
      ids.push(`m${r.channel}:${r.ts}`);
    }
    for (const f of out.files || []) {
      const up: any = await this.call('files.getUploadURLExternal', { filename: f.name, length: f.size }, { form: true });
      const put = await fetchT(up.upload_url, { method: 'POST', body: fs.readFileSync(f.path), headers: { 'content-type': 'application/octet-stream' }, timeoutMs: 120_000, signal: this.ctx.signal });
      if (!put.ok) throw new ChannelError(`Upload naar Slack mislukt (${put.status})`);
      await this.call('files.completeUploadExternal', { files: [{ id: up.file_id, title: f.name }], channel_id: channel, ...(threadTs ? { thread_ts: threadTs } : {}) });
      ids.push(`f${up.file_id}`);
    }
    return ids;
  }

  /** Status reaction: 👀 while working, then 👀 off and ✅ or ❌ on (needs reactions:write). */
  async react(_conv: Conversation, reactTo: string, status: ReactionStatus) {
    const i = reactTo.indexOf(':');
    const channel = reactTo.slice(0, i);
    const timestamp = reactTo.slice(i + 1);
    if (!channel || !timestamp) return;
    if (status !== 'working') await this.call('reactions.remove', { channel, timestamp, name: SLACK_REACTION.working }).catch(() => {});
    await this.call('reactions.add', { channel, timestamp, name: SLACK_REACTION[status] });
  }

  async send(conv: Conversation, out: Outbound) {
    const [channel, ts] = conv.external_id.split(':');
    return this.post(conv.meta?.channel || channel, conv.meta?.threadTs ?? ts ?? null, out);
  }

  async sendTo(target: string, out: Outbound) {
    const t = target.trim().replace(/^#/, '');
    let channel = t;
    let priv = /^D/.test(t);
    if (/^[UW][A-Z0-9]{6,}$/.test(t)) {
      const r: any = await this.call('conversations.open', { users: t });
      channel = r.channel.id;
      priv = true;
    } else if (!/^[CGD][A-Z0-9]{6,}$/.test(t)) throw new ChannelError('Geef een Slack-kanaal-id (C…) of gebruiker-id (U…) op.');
    const ids = await this.post(channel, null, out);
    return { conversationId: channel, title: priv ? await this.userName(t) : `#${channel}`, private: priv, ids, extra: { channel, threadTs: null } };
  }
}
