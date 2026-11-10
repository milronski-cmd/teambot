import type { ElementHandle, Page } from 'playwright-core';
import type { BrowserSession } from './browser.js';
import { originOf, secretVariants, totpCode, type VaultCredentials } from './vault.js';

/**
 * TeamBot fills a vault login into the bot's page itself; the model never sees the values. Rules:
 *  - only in the main frame, and only while that document's origin is EXACTLY one of the entry's origins. The origin
 *    is checked on the element handle right before each fill (a handle belongs to one document, so a navigation in
 *    between makes the fill fail instead of landing on another site);
 *  - only a sign-in form (one password field; registration / change-password forms are left alone);
 *  - filled fields get `data-tbvault-filled`: masked in screenshots and hidden in snapshots, and the bot can't type in
 *    them; the live view drops frames while TeamBot fills (`session.privacy`);
 *  - errors are mapped to fixed Dutch reasons: a Playwright message (which may echo a value) never leaves this file;
 *  - on failure the filled fields are emptied again.
 */

export type FillReason = 'origin' | 'noform' | 'signup' | 'rejected' | 'code' | 'code_rejected' | 'stuck' | 'timeout' | 'error' | 'leak';

export interface FillResult {
  ok: boolean;
  reason?: FillReason;
  /** true when the page left the login origin (or the form is gone after a navigation): really signed in */
  certain?: boolean;
  /** origin of the page at the end */
  origin?: string | null;
  steps: number;
}

export const FILL_REASON: Record<FillReason, string> = {
  origin: 'de pagina staat niet (meer) op het adres dat bij deze login hoort; uit veiligheid is niets ingevuld',
  noform: 'er staat geen inlogformulier op deze pagina',
  signup: 'dit lijkt een formulier om een account te maken of een wachtwoord te wijzigen; dat vult de kluis niet in',
  rejected: 'de website accepteerde de inloggegevens niet',
  code: 'de website vraagt een code en er staat geen 2FA-sleutel bij deze login',
  code_rejected: 'de website accepteerde de 2FA-code niet',
  stuck: 'na het versturen gebeurde er niets (misschien een captcha of een extra controle)',
  timeout: 'het inloggen duurde te lang',
  error: 'er ging iets mis tijdens het invullen',
  leak: 'de website zette de inloggegevens in het adres van de pagina; uit veiligheid gestopt',
};

/** Find and mark the sign-in fields of the current document (data-tbvault="user|pass|otp", data-tbvault-submit). */
export const FIND_LOGIN_JS = String.raw`() => {
  const doc = document;
  for (const el of doc.querySelectorAll('[data-tbvault]')) el.removeAttribute('data-tbvault');
  for (const el of doc.querySelectorAll('[data-tbvault-submit]')) el.removeAttribute('data-tbvault-submit');
  const vis = (el) => {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
    }
    return true;
  };
  const a = (el, n) => (el.getAttribute(n) || '').toLowerCase();
  const desc = (el) => [a(el, 'name'), a(el, 'id'), a(el, 'autocomplete'), a(el, 'placeholder'), a(el, 'aria-label'), el.labels && el.labels.length ? Array.from(el.labels).map((l) => l.innerText).join(' ') : ''].join(' ').toLowerCase();
  const TEXTY = ['text', 'email', 'tel', ''];
  const inputs = Array.from(doc.querySelectorAll('input')).filter((el) => vis(el) && !el.readOnly);
  const pw = inputs.filter((el) => el.type === 'password');
  const signup = pw.length > 1 || pw.some((p) => a(p, 'autocomplete') === 'new-password');
  const pass = !signup && pw.length === 1 ? pw[0] : null;
  const isOtp = (el) => {
    if (a(el, 'autocomplete') === 'one-time-code') return true;
    if (!TEXTY.includes(el.type) && el.type !== 'number') return false;
    const d = desc(el);
    if (!/otp|totp|2fa|mfa|one.?time|verif|authenticat|security.?code|beveiligings|\bcode\b|\bpin\b|token/.test(d)) return false;
    if (/post|zip|promo|coupon|korting|voucher|gift|cadeau|country|land|area|search|zoek/.test(d)) return false;
    const ml = Number(el.getAttribute('maxlength') || 0);
    return a(el, 'inputmode') === 'numeric' || el.type === 'tel' || el.type === 'number' || (ml >= 4 && ml <= 10) || /otp|totp|2fa|mfa|one.?time|authenticat/.test(d);
  };
  const otp = !pass && !signup ? inputs.find(isOtp) || null : null;
  const score = (el) => {
    const ac = a(el, 'autocomplete');
    const d = desc(el);
    let s = 0;
    if (/\b(username|email)\b/.test(ac)) s += 6;
    if (el.type === 'email') s += 4;
    if (/user|e-?mail|login|account|identifier|gebruiker|naam|name|phone|telefoon|mobiel/.test(d)) s += 3;
    if (/search|zoek|captcha|coupon|promo|korting/.test(d) || el.type === 'search') s -= 10;
    if (pass) {
      if (pass.form && el.form === pass.form) s += 3;
      if (el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING) s += 2;
      else s -= 4;
    } else if (el.form) {
      const own = Array.from(el.form.elements).filter((f) => f.tagName === 'INPUT' && TEXTY.includes(f.type) && vis(f));
      if (own.length === 1 && s >= 3) s += 3;
    }
    return s;
  };
  let user = null;
  if (!signup && !otp) {
    let best = -99;
    for (const el of inputs) {
      if (!TEXTY.includes(el.type) || el === otp || isOtp(el)) continue;
      const s = score(el);
      if (s > best) { best = s; user = el; }
    }
    if (best < (pass ? 2 : 6)) user = null;
  }
  const field = pass || otp || user;
  let submit = null;
  if (field) {
    const WORDS = /log ?in|inloggen|aanmelden|sign ?in|volgende|next|doorgaan|continue|verder|verifi|bevestig|confirm|submit|ga door|send|verzend/i;
    const NOT = /registr|sign ?up|account (aanmaken|maken)|create|vergeten|forgot|reset|with |met (google|apple|facebook|microsoft)|google|facebook|apple|github|annuleer|cancel|terug|back/i;
    const label = (b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
    const form = field.form;
    if (form) {
      const own = Array.from(form.querySelectorAll('button, input[type=submit], input[type=image]')).filter((b) => vis(b) && (b.tagName !== 'BUTTON' || ['', 'submit'].includes(a(b, 'type'))));
      submit = own.find((b) => WORDS.test(label(b)) && !NOT.test(label(b))) || own.find((b) => !NOT.test(label(b))) || null;
    }
    if (!submit) {
      const all = Array.from(doc.querySelectorAll('button, [role=button], input[type=submit], input[type=button]')).filter(vis);
      submit = all.find((b) => WORDS.test(label(b)) && !NOT.test(label(b))) || null;
    }
  }
  if (user) user.setAttribute('data-tbvault', 'user');
  if (pass) pass.setAttribute('data-tbvault', 'pass');
  if (otp) otp.setAttribute('data-tbvault', 'otp');
  if (submit) submit.setAttribute('data-tbvault-submit', '1');
  return { origin: location.origin, user: !!user, pass: !!pass, otp: !!otp, submit: !!submit, signup };
}`;

/** Changes whenever the page moves on: a new document (fresh token), or other visible inputs. */
const STATE_JS = String.raw`() => {
  if (!window.__tbVaultDoc) window.__tbVaultDoc = Math.random().toString(36).slice(2);
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const st = getComputedStyle(el); return st.display !== 'none' && st.visibility !== 'hidden'; };
  return window.__tbVaultDoc + '|' + location.href + '|' + Array.from(document.querySelectorAll('input')).filter(vis).map((i) => i.type).join(',');
}`;

const CLEAR_JS = String.raw`(origins) => {
  if (!origins.includes(location.origin)) return 0;
  let n = 0;
  for (const el of document.querySelectorAll('[data-tbvault-filled]')) {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      n++;
    } catch (e) {}
  }
  return n;
}`;

class Stop extends Error {
  constructor(public reason: FillReason) {
    super(reason);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const decode = (u: string) => {
  try {
    return decodeURIComponent(u.replace(/\+/g, ' '));
  } catch {
    return u;
  }
};

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
};

/** Did the site put a vault value into the address (a GET form)? Checked raw and decoded. */
function leaks(url: string, values: string[]): boolean {
  const hay = [url, decode(url)];
  return values.some((v) => v.length >= 4 && hay.some((h) => h.includes(v)));
}

interface Scan {
  origin: string;
  user: boolean;
  pass: boolean;
  otp: boolean;
  submit: boolean;
  signup: boolean;
}

async function scan(page: Page): Promise<Scan | null> {
  try {
    return (await page.mainFrame().evaluate(`(${FIND_LOGIN_JS})()`)) as Scan;
  } catch {
    return null; // navigating
  }
}

async function state(page: Page): Promise<string> {
  try {
    return String(await page.mainFrame().evaluate(`(${STATE_JS})()`));
  } catch {
    return 'navigating:' + Math.random();
  }
}

/** The handle of a marked element, but only while its document has one of the allowed origins. */
async function handleFor(page: Page, selector: string, origins: string[]): Promise<ElementHandle | null> {
  let h: ElementHandle | null = null;
  try {
    h = await page.mainFrame().$(selector);
  } catch {
    return null;
  }
  if (!h) return null;
  let o = '';
  try {
    o = String(await h.evaluate((el: any) => el.ownerDocument.location.origin));
  } catch {
    o = '';
  }
  if (!origins.includes(o)) {
    await h.dispose().catch(() => {});
    throw new Stop('origin');
  }
  return h;
}

async function fillOne(page: Page, role: 'user' | 'pass' | 'otp', value: string, origins: string[]): Promise<{ h: ElementHandle | null; changed: boolean }> {
  const h = await handleFor(page, `[data-tbvault="${role}"]`, origins);
  if (!h) return { h: null, changed: false };
  try {
    await h.evaluate((el: any) => el.setAttribute('data-tbvault-filled', '1'));
    if (role === 'user') {
      const cur = await h.inputValue().catch(() => '');
      if (cur.trim().toLowerCase() === value.trim().toLowerCase()) return { h, changed: false }; // already there (a remembered account)
    }
    await h.fill(value, { timeout: 5000 });
    return { h, changed: true };
  } catch (e) {
    await h.dispose().catch(() => {});
    if (e instanceof Stop) throw e;
    throw new Stop('error');
  }
}

async function submit(page: Page, last: ElementHandle | null, origins: string[]) {
  const b = await handleFor(page, '[data-tbvault-submit]', origins).catch((e) => {
    if (e instanceof Stop) throw e;
    return null;
  });
  if (b) {
    try {
      await b.click({ timeout: 4000 });
      return;
    } catch {
      /* covered by a banner, etc.: press Enter instead */
    } finally {
      await b.dispose().catch(() => {});
    }
  }
  if (!last) throw new Stop('error');
  try {
    const o = String(await last.evaluate((el: any) => el.ownerDocument.location.origin));
    if (!origins.includes(o)) throw new Stop('origin');
    await last.press('Enter', { timeout: 4000 });
  } catch (e) {
    if (e instanceof Stop) throw e;
    throw new Stop('error');
  }
}

/** Wait until the page moves on after a submit (new document, other inputs, other URL) — or give up. */
async function waitForChange(page: Page, before: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(300);
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    if ((await state(page)) !== before) {
      await sleep(400); // let a single-page app finish rendering the next step
      return true;
    }
  }
  return false;
}

export interface FillOpts {
  origins: string[];
  creds: VaultCredentials;
  deadlineMs?: number;
  /** extra values to scrub from everything the bot sees in this browser (codes are added as they are made) */
  onSecret?: (v: string) => void;
}

/** Fill and submit the sign-in steps on the bot's active tab. */
export async function fillLogin(s: BrowserSession, o: FillOpts): Promise<FillResult> {
  const page = s.active;
  const deadline = Date.now() + (o.deadlineMs ?? 60_000);
  const leakValues = [...secretVariants(o.creds.password)];
  let steps = 0;
  let submitted = 0;
  const startPath = pathOf(page.url());
  let filledPass = 0;
  let filledOtp = 0;
  s.privacy++;
  const finish = async (r: FillResult): Promise<FillResult> => {
    if (!r.ok) await page.mainFrame().evaluate(`(${CLEAR_JS})(${JSON.stringify(o.origins)})`).catch(() => {});
    // the role marks are only for the next step; the "filled" marks stay (masking) until the page goes away
    await page
      .mainFrame()
      .evaluate(`(() => { for (const el of document.querySelectorAll('[data-tbvault], [data-tbvault-submit]')) { el.removeAttribute('data-tbvault'); el.removeAttribute('data-tbvault-submit'); } })()`)
      .catch(() => {});
    return { ...r, origin: originOf(page.url()), steps };
  };
  try {
    for (let i = 0; i < 6; i++) {
      if (Date.now() > deadline) return await finish({ ok: false, reason: 'timeout', steps });
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      const url = page.url();
      if (leaks(url, leakValues)) {
        await page.goto('about:blank').catch(() => {});
        return await finish({ ok: false, reason: 'leak', steps });
      }
      const origin = originOf(url);
      if (!origin || !o.origins.includes(origin)) {
        // after a submit the site sends us on (accounts.example.com -> app.example.com): signed in
        if (submitted > 0) return await finish({ ok: true, certain: true, steps });
        return await finish({ ok: false, reason: 'origin', steps });
      }
      const f = await scan(page);
      if (!f) {
        await sleep(500);
        continue;
      }
      if (f.origin !== origin) return await finish({ ok: false, reason: 'origin', steps });
      if (f.signup && !submitted) return await finish({ ok: false, reason: 'signup', steps });
      if (!f.user && !f.pass && !f.otp) {
        // no sign-in fields left after a submit; a different page (not just the same form gone) = really signed in
        if (submitted > 0) return await finish({ ok: true, certain: pathOf(page.url()) !== startPath, steps });
        return await finish({ ok: false, reason: 'noform', steps });
      }
      let last: ElementHandle | null = null;
      if (f.otp) {
        if (!o.creds.totp) return await finish({ ok: false, reason: 'code', steps });
        if (filledOtp > 0) return await finish({ ok: false, reason: 'code_rejected', steps });
        let c = totpCode(o.creds.totp);
        if (c.remainingSec < 3) {
          await sleep(c.remainingSec * 1000 + 250);
          c = totpCode(o.creds.totp);
        }
        o.onSecret?.(c.code);
        leakValues.push(c.code);
        last = (await fillOne(page, 'otp', c.code, o.origins)).h;
        filledOtp++;
      } else {
        if (f.pass && filledPass > 0) return await finish({ ok: false, reason: 'rejected', steps });
        let changed = false;
        if (f.user && o.creds.username) {
          const r = await fillOne(page, 'user', o.creds.username, o.origins);
          last = r.h;
          changed = r.changed;
        }
        if (f.pass) {
          last = (await fillOne(page, 'pass', o.creds.password, o.origins)).h;
          filledPass++;
        } else {
          if (!o.creds.username) return await finish({ ok: false, reason: 'noform', steps });
          // after a submit only a field that already holds the username is left (a single-page app): we're through
          if (!changed && submitted > 0) {
            await last?.dispose().catch(() => {});
            return await finish({ ok: true, certain: false, steps });
          }
        }
      }
      steps++;
      const before = await state(page);
      await submit(page, last, o.origins);
      await last?.dispose().catch(() => {});
      submitted++;
      const moved = await waitForChange(page, before, Math.min(15_000, Math.max(1000, deadline - Date.now())));
      if (!moved) return await finish({ ok: false, reason: f.otp ? 'code_rejected' : f.pass ? 'rejected' : 'stuck', steps });
    }
    return await finish({ ok: false, reason: 'stuck', steps });
  } catch (e) {
    return await finish({ ok: false, reason: e instanceof Stop ? e.reason : 'error', steps });
  } finally {
    s.privacy = Math.max(0, s.privacy - 1);
    // frames were dropped while filling and a static page sends no new ones: show the viewer where we are now
    if (!s.privacy) s.pushFrame().catch(() => {});
  }
}
