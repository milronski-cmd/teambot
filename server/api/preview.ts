import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Ctx } from '../core/types.js';
import { ah, bad, notFound, user } from '../core/http.js';
import { canSeeThread } from './threads.js';

/**
 * Interactive HTML previews (show_html). The UI asks for a short-lived signed URL; the public endpoint serves the HTML
 * with its own CSP: inline scripts/styles allowed, all network blocked, opaque origin via the CSP `sandbox` directive
 * (so it can never read TeamBot data, cookies, storage or the session token, which is not in the URL).
 */
const KEY = crypto.randomBytes(32);
const TTL_MS = 30 * 60_000;

const sign = (id: string, exp: number) => crypto.createHmac('sha256', KEY).update(`${id}.${exp}`).digest('base64url');

export const PREVIEW_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/**
 * "Citeren": the page tells the TeamBot window which text is selected (and where), so the window can offer to quote
 * it into the composer. One way only: the page posts {tb:'selection', text, rect} to its parent and receives nothing;
 * the window accepts it only from that very frame (ui/src/shell/PagePanel.tsx), caps it, and puts it in the composer
 * only after a click, where the user still sees and edits it before sending. Same opaque, network-less sandbox.
 */
export const QUOTE_HELPER =
  '<script>(function(){var last="",tm=0;function send(){tm=0;var s=window.getSelection(),x="",r=null;try{x=s?String(s):"";if(x&&s.rangeCount){var b=s.getRangeAt(0).getBoundingClientRect();r={x:b.left,y:b.top,w:b.width,h:b.height}}}catch(e){}if(x.length>4000)x=x.slice(0,4000);var k=x+"|"+(r?Math.round(r.x)+","+Math.round(r.y):"");if(k===last)return;last=k;try{parent.postMessage({tb:"selection",text:x,rect:r},"*")}catch(e){}}function soon(){if(!tm)tm=setTimeout(send,150)}document.addEventListener("selectionchange",soon);addEventListener("scroll",soon,true);addEventListener("resize",soon)})();</script>';

/** The page with the selection helper: before the last </body>, or at the end. */
export function withQuoteHelper(html: string): string {
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i < 0 ? html + QUOTE_HELPER : html.slice(0, i) + QUOTE_HELPER + html.slice(i);
}

/** Larger pages are served as they are (without "Citeren"), streamed. */
const HELPER_MAX_BYTES = 8 * 1024 * 1024;

export function previewRoutes(ctx: Ctx) {
  ctx.api.post(
    '/attachments/:id/preview',
    ah(async (req) => {
      const u = user(req);
      const a = ctx.store.get<any>('attachments', req.params.id as string);
      const t = a?.thread_id ? ctx.store.thread(a.thread_id) : null;
      if (!a || (a.user_id !== u.id && !canSeeThread(u.id, t))) throw notFound('Bijlage niet gevonden');
      if (a.mime !== 'text/html') throw bad('Alleen HTML kan als preview worden getoond');
      const exp = Date.now() + TTL_MS;
      return { url: `/api/public/preview/${a.id}.${exp}.${sign(a.id, exp)}` };
    }),
  );
  ctx.publicApi.get(
    '/preview/:token',
    ah(async (req, res) => {
      const [id, expS, sig] = String(req.params.token).split('.');
      const exp = Number(expS);
      const good = id && sig && exp > Date.now() && crypto.timingSafeEqual(Buffer.from(sign(id, exp)), Buffer.from(sig.padEnd(43, '=').slice(0, 43)));
      if (!good) throw notFound('Preview verlopen');
      const a = ctx.store.get<any>('attachments', id);
      if (!a || a.mime !== 'text/html' || !fs.existsSync(a.path)) throw notFound('Preview niet gevonden');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-security-policy', PREVIEW_CSP);
      res.setHeader('x-frame-options', 'SAMEORIGIN');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      if (fs.statSync(a.path).size > HELPER_MAX_BYTES) return void fs.createReadStream(a.path).pipe(res);
      res.send(withQuoteHelper(fs.readFileSync(a.path, 'utf8')));
    }),
  );
}
