import fs from 'node:fs';
import path from 'node:path';
import type { Ctx, Module, ProviderConfig, ToolDef } from '../../core/types.js';
import { ah, bad, str, user } from '../../core/http.js';
import { registerAttachment, resolveInWorkspace } from '../../tools/builtin/files.js';
import { readBytes, safeFetch } from '../../tools/builtin/web.js';
import { PLACE } from '../../../shared/places.js';
import { words } from '../../../shared/i18n-core.js';

/**
 * Afbeeldingen maken: the tool `generate_image` lets a bot make an image (a product photo for a blog, a banner, an
 * illustration) with an AI service the owner already connected. It speaks the OpenAI images protocol
 * (POST <base>/images/generations), which OpenAI, xAI, Together and many own or local servers offer. The image lands in
 * the bot's working folder (afbeeldingen/) and in the chat as an attachment.
 *
 * There is no free service without an account that answers reliably (checked 9 November 2026), so without a connected
 * image service the tool says plainly what to connect. A daily maximum keeps the cost in hand: an image is billed by
 * the service per image, outside the token budget.
 *
 * Routes: GET /images/status, PUT /images/settings, POST /images/test.
 */

interface ImageKind {
  /** Models to offer when the service's own list cannot be read, best first. */
  models: string[];
  /** Which ids in the service's model list make images. */
  match: RegExp;
  /** The service takes `size` as WIDTHxHEIGHT. */
  size: boolean;
}

/** Services that speak the images protocol. Checked against their public API reference; none was called with a real key. */
const KINDS: Record<string, ImageKind> = {
  openai: { models: ['gpt-image-1'], match: /gpt-image|dall-e/i, size: true },
  xai: { models: ['grok-2-image'], match: /image|imagine/i, size: false },
  together: { models: ['black-forest-labs/FLUX.1-schnell'], match: /flux|stable-diffusion|sdxl|image|imagen|ideogram/i, size: true },
  'openai-compatible': { models: [], match: /image|flux|diffusion|sdxl|dall|imagen/i, size: true },
};

export type Shape = 'square' | 'landscape' | 'portrait';
const SIZES: Record<Shape, string> = { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' };
const SETTING = 'images';
const MAX_BYTES = 25 * 1024 * 1024;

export interface ImageSettings {
  /** Provider id, or '' = the first connected service that can make images. */
  provider: string;
  /** Model per provider id; missing = the first suggestion. */
  models: Record<string, string>;
  dailyMax: number;
}

const today = () => new Date().toISOString().slice(0, 10);

export class Images {
  /** Images made today per user (in memory: a restart gives a fresh day count, never more than one extra round). */
  private made = new Map<string, { day: string; n: number }>();

  constructor(private ctx: Ctx) {}

  settings(userId: string): ImageSettings {
    const s = this.ctx.store.getSetting<Partial<ImageSettings>>(userId, SETTING, {});
    const max = Number(s.dailyMax);
    return { provider: typeof s.provider === 'string' ? s.provider : '', models: s.models && typeof s.models === 'object' ? s.models : {}, dailyMax: Number.isFinite(max) && max >= 0 ? Math.min(500, Math.round(max)) : 0 };
  }

  save(userId: string, data: any): ImageSettings {
    const cur = this.settings(userId);
    const next: ImageSettings = { ...cur, models: { ...cur.models } };
    if (data?.provider !== undefined) {
      const id = str(data.provider, 80);
      if (id && !this.sources(userId).some((p) => p.id === id)) throw bad('Deze AI-dienst kan geen afbeeldingen maken of is niet gekoppeld.');
      next.provider = id;
    }
    if (data?.model !== undefined) {
      const pid = str(data.modelFor, 80) || next.provider || this.sources(userId)[0]?.id || '';
      const model = str(data.model, 200).trim();
      if (pid) model ? (next.models[pid] = model) : delete next.models[pid];
    }
    if (data?.dailyMax !== undefined) {
      const n = Number(data.dailyMax);
      if (!Number.isFinite(n) || n < 0 || n > 500) throw bad('Kies een maximum tussen 0 en 500 afbeeldingen per dag.');
      next.dailyMax = Math.round(n);
    }
    this.ctx.store.setSetting(userId, SETTING, next);
    return next;
  }

  /** The owner's connected services that can make images. */
  sources(userId: string): ProviderConfig[] {
    return this.ctx.providers.list(userId).filter((p) => p.enabled && KINDS[p.kind] && (p.kind !== 'openai-compatible' || !!p.base_url));
  }

  private base(p: ProviderConfig): string {
    return (p.base_url || this.ctx.providers.kind(p.kind)?.baseUrl || '').replace(/\/+$/, '');
  }

  private headers(p: ProviderConfig): Record<string, string> {
    const key = p.secret_id ? this.ctx.secrets.get(p.secret_id) : null;
    return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
  }

  /** The image models of a service: its own list when it gives one, else the known names. */
  async models(p: ProviderConfig): Promise<string[]> {
    const k = KINDS[p.kind];
    try {
      const res = await fetch(`${this.base(p)}/models`, { headers: this.headers(p), redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j: any = await res.json();
        const ids: string[] = (Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []).map((m: any) => String(m?.id || '')).filter((id: string) => id && k.match.test(id));
        if (ids.length) return [...new Set([...ids.sort(), ...k.models])].slice(0, 50);
      }
    } catch {
      /* the known names below */
    }
    return k.models;
  }

  private pick(userId: string): { p: ProviderConfig; model: string } | null {
    const s = this.settings(userId);
    const all = this.sources(userId);
    const p = all.find((x) => x.id === s.provider) || all[0];
    if (!p) return null;
    return { p, model: s.models[p.id] || KINDS[p.kind].models[0] || '' };
  }

  async status(userId: string) {
    const s = this.settings(userId);
    const all = this.sources(userId);
    const chosen = this.pick(userId);
    const c = this.made.get(userId);
    return {
      settings: s,
      sources: all.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      chosen: chosen ? { id: chosen.p.id, name: chosen.p.name, model: chosen.model } : null,
      models: chosen ? await this.models(chosen.p) : [],
      madeToday: c && c.day === today() ? c.n : 0,
    };
  }

  /** Make one image. Returns the bytes; throws a plain Dutch sentence when it cannot. */
  async generate(userId: string, prompt: string, shape: Shape, signal?: AbortSignal): Promise<{ bytes: Buffer; ext: string; service: string; model: string }> {
    const chosen = this.pick(userId);
    if (!chosen)
      throw bad(`Er is nog geen AI-dienst gekoppeld die afbeeldingen kan maken. Koppel bij ${PLACE.ai} een dienst met een sleutel (OpenAI, xAI of Together) of je eigen OpenAI-compatibele server; daarna werkt dit vanzelf.`);
    const { p, model } = chosen;
    if (!model) throw bad(`Kies bij ${PLACE.images} welk model van “${p.name}” de afbeeldingen maakt.`);
    const s = this.settings(userId);
    const c = this.made.get(userId);
    const n = c && c.day === today() ? c.n : 0;
    // 0 = no limit (the default): a maximum exists only when the owner sets one.
    if (s.dailyMax > 0 && n >= s.dailyMax) throw bad(s.dailyMax === 1 ? `Het maximum van 1 afbeelding per dag is bereikt. Je verhoogt het bij ${PLACE.images}.` : `Het maximum van ${s.dailyMax} afbeeldingen per dag is bereikt. Je verhoogt het bij ${PLACE.images}.`);
    const k = KINDS[p.kind];
    const body: Record<string, any> = { model, prompt, n: 1 };
    if (k.size) body.size = SIZES[shape];
    // gpt-image models always answer with the image itself and refuse the field; the others need to be asked.
    if (!/^gpt-image/i.test(model)) body.response_format = 'b64_json';
    let res: Response;
    try {
      res = await fetch(`${this.base(p)}/images/generations`, { method: 'POST', headers: this.headers(p), body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
    } catch (e: any) {
      throw bad(`“${p.name}” is niet bereikbaar: ${String(e?.message || e).slice(0, 200)}`);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j: any = await res.json();
        detail = String(j?.error?.message || j?.error || j?.message || '').slice(0, 300);
      } catch {
        /* no body */
      }
      const why = res.status === 401 || res.status === 403 ? 'de sleutel wordt geweigerd' : res.status === 404 ? `model “${model}” of de afbeeldingenfunctie bestaat daar niet` : res.status === 429 ? 'de limiet van de dienst is bereikt' : `fout ${res.status}`;
      throw bad(`“${p.name}” maakte geen afbeelding: ${why}${detail ? ` (${detail})` : ''}.`);
    }
    const j: any = await res.json().catch(() => null);
    const item = j?.data?.[0];
    let bytes: Buffer | null = null;
    let mime = 'image/png';
    if (typeof item?.b64_json === 'string' && item.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
    else if (typeof item?.url === 'string' && item.url) {
      // A link to the picture: only a public address, with the same guards as any page a bot reads.
      let got: Response;
      try {
        got = await safeFetch(item.url, { signal, timeoutMs: 60_000 });
      } catch (e: any) {
        throw bad(`“${p.name}” gaf een link naar de afbeelding die TeamBot niet mag of kan openen: ${String(e?.message || e).slice(0, 200)}`);
      }
      mime = String(got.headers.get('content-type') || mime).split(';')[0];
      bytes = await readBytes(got, MAX_BYTES);
    }
    if (!bytes || bytes.length < 100 || bytes.length > MAX_BYTES) throw bad(`“${p.name}” gaf geen bruikbare afbeelding terug.`);
    const ext = bytes[0] === 0xff && bytes[1] === 0xd8 ? '.jpg' : bytes.subarray(0, 4).toString('latin1') === 'RIFF' ? '.webp' : bytes[0] === 0x89 && bytes[1] === 0x50 ? '.png' : /jpe?g/.test(mime) ? '.jpg' : /webp/.test(mime) ? '.webp' : '.png';
    this.made.set(userId, { day: today(), n: n + 1 });
    this.ctx.audit(userId, 'image.generated', { provider: p.id, model, shape, bytes: bytes.length });
    return { bytes, ext, service: p.name, model };
  }
}

function tool(svc: Images): ToolDef {
  return {
    name: 'generate_image',
    // A part of the group Bestanden: the image is written into the bot's own folder, and every bot with files has it.
    group: 'files:images',
    risk: 'exec',
    description:
      'Maak een afbeelding met AI (bijv. een sfeerbeeld bij een blog, een banner of een illustratie) en zet hem in de chat en in je werkmap. Beschrijf precies wat erop moet staan, de stijl en de sfeer. ' +
      'Elke afbeelding kost geld bij de AI-dienst van de gebruiker: maak er niet meer dan gevraagd. Geen echte personen, merken of logo’s namaken.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Wat er op de afbeelding moet staan, met stijl en sfeer' },
        shape: { type: 'string', enum: ['square', 'landscape', 'portrait'], description: 'Vierkant (standaard), liggend of staand' },
        name: { type: 'string', description: 'Korte bestandsnaam zonder extensie, bijv. "banner-winteractie"' },
      },
      required: ['prompt'],
    },
    summarize: (a) => words('Afbeelding maken: {0}', String(a.prompt || '').replace(/\s+/g, ' ').slice(0, 160)),
    async run(a, t) {
      const prompt = str(a.prompt, 4000).trim();
      if (!prompt) return { text: 'Beschrijf wat er op de afbeelding moet staan.', isError: true };
      const shape: Shape = a.shape === 'landscape' || a.shape === 'portrait' ? a.shape : 'square';
      try {
        t.progress('Afbeelding maken…');
        const img = await svc.generate(t.userId, prompt, shape, t.signal);
        const base =
          str(a.name, 80)
            .toLowerCase()
            .replace(/[^a-z0-9-_]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'afbeelding';
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const rel = `afbeeldingen/${base}-${stamp}${img.ext}`;
        const file = resolveInWorkspace(t.agent, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, img.bytes);
        const ref = registerAttachment(t.ctx, t.userId, t.thread.id, file, path.basename(file), true);
        return { text: `Afbeelding gemaakt met ${img.service} (${img.model}) en bewaard als ${rel}. Hij staat als bijlage in de chat.`, attachments: [ref] };
      } catch (e: any) {
        return { text: e?.message || 'De afbeelding kon niet gemaakt worden.', isError: true };
      }
    },
  };
}

const mod: Module = {
  id: 'images',
  label: 'Afbeeldingen maken',
  migrations: [
    {
      // The old built-in maximum (20 a day) is gone: where it is still stored it becomes 0 = no limit. 0 used to mean
      // "none at all"; nobody could set that on purpose and still use the tool, so it now reads as no limit too.
      id: 'images-001',
      sql: `UPDATE settings SET value = json_set(value, '$.dailyMax', 0) WHERE key = 'images' AND json_valid(value) AND json_extract(value, '$.dailyMax') = 20;`,
    },
  ],
  init(ctx: Ctx) {
    const svc = new Images(ctx);
    ctx.services.images = { status: (u: string) => svc.status(u), generate: (u: string, prompt: string, shape: Shape) => svc.generate(u, prompt, shape) };
    ctx.tools.register(tool(svc));
    ctx.api.get('/images/status', ah(async (req) => svc.status(user(req).id)));
    ctx.api.put(
      '/images/settings',
      ah(async (req) => {
        svc.save(user(req).id, req.body || {});
        return svc.status(user(req).id);
      }),
    );
    // "Proefafbeelding": proves the chosen service and model work; counts toward the daily maximum.
    ctx.api.post(
      '/images/test',
      ah(async (req) => {
        const img = await svc.generate(user(req).id, str(req.body?.prompt, 1000).trim() || 'Een rode stadsfiets tegen een witte muur, zacht daglicht, productfoto', 'square');
        return { ok: true, service: img.service, model: img.model, mime: img.ext === '.jpg' ? 'image/jpeg' : img.ext === '.webp' ? 'image/webp' : 'image/png', data: img.bytes.toString('base64') };
      }),
    );
  },
};

export default mod;
