// LIVE test of WhatsApp (QR) — needs a real phone; run it together with the owner. Nothing here touches the real
// TeamBot data: the app runs in a fresh temporary data folder that is removed at the end (unless WA_KEEP=1).
//
//   npm run whatsapp:live
//   (optional) WA_OWNER_PHONE=31612345678  → only this number may link (anything else is unlinked at once)
//   (optional) WA_PAIR_PHONE=31612345678   → link with a pairing code instead of the QR (useful on the phone itself)
//   (optional) WA_KEEP=1                    → keep the link + temp folder afterwards (default: unlink and clean up)
//   (optional) TEAMBOT_BROWSER_PATH=…       → Edge/Chrome/Chromium to use (default: detected)
//   (optional) WA_QR_ONLY=1                 → pre-check without a phone: stop as soon as a QR code exists
//
// Steps (the script waits for each one and prints ✔/✖):
//   1. QR code appears in this terminal (and in qr.html in the temp folder) → scan it on the phone:
//      WhatsApp › Settings/⋮ › Linked devices › Link a device.
//   2. In WhatsApp, open the chat with yourself ("Message yourself") and send:  test
//      → the test bot answers in that chat, marked "🤖 *Testbot*".
//   3. Send:  pdf   → the bot sends a small PDF to the same chat (channel_send, allowed without asking).
//   4. Send a voice note → it arrives at the bot (transcribed only if speech-to-text is set up; here: no, so the bot
//      gets the audio file plus a note).
//   5. Send:  @Tweede hoi   → the second test bot answers ("🤖 *Tweede*").
//   6. Unlink (default) → TeamBot disappears from Linked devices on the phone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';

const { startTestApp } = await import('../helpers.ts');

const WAIT = Number(process.env.WA_STEP_TIMEOUT_MS) || 5 * 60_000;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = WAIT) {
  const start = Date.now();
  let dots = 0;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) return null;
    if (++dots % 20 === 0) console.log(`  … wacht op: ${what}`);
    await sleep(500);
  }
}

const real = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'TeamBot');
const t = await startTestApp();
if (path.resolve(t.dir).toLowerCase().startsWith(path.resolve(real).toLowerCase())) {
  console.error('Weigering: de testmap valt in de echte TeamBot-map.');
  process.exit(2);
}
console.log(`Tijdelijke TeamBot-map: ${t.dir}`);
const ch = t.app.ctx.services.channels;
const m = ch.manager;
let bindingId = '';
let wasLinked = false;
let lastErr = '';
try {
  const bot = await t.agent({ name: 'Testbot', tool_groups: ['channels', 'files'], access_mode: 'auto' });
  await t.agent({ name: 'Tweede', access_mode: 'auto' });
  // A minimal, valid one-page PDF in the bot's workspace.
  const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 58>>stream\nBT /F1 18 Tf 20 60 Td (TeamBot WhatsApp-test) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
  fs.writeFileSync(path.join(bot.workspace, 'whatsapp-test.pdf'), pdf);
  await t.api('PUT', `/channels/agents/${bot.id}/send-rules/owner`, { enabled: true });

  const b = await t.api('POST', '/channels/bindings', { adapter: 'whatsapp-web', name: 'WhatsApp live-test', agent_id: bot.id, config: { riskAccepted: true, ownerPhone: process.env.WA_OWNER_PHONE || '' } });
  bindingId = b.id;
  console.log('WhatsApp Web start onzichtbaar in Edge/Chrome…');

  // ---- 1. link
  let lastQr = '';
  let paired = false;
  const qrFile = path.join(t.dir, 'qr.html');
  const linked = await waitFor('koppelen (QR scannen of code invoeren)', async () => {
    const st = m.runtime(b.id)?.linkState?.() || {};
    const row = t.app.ctx.store.get('channel_bindings', b.id);
    if (row?.status === 'error' && row.last_error !== lastErr) {
      lastErr = row.last_error;
      console.log(`  fout: ${row.last_error}`);
      if (!/nieuwe poging/.test(row.last_error || '')) return 'error'; // fatal; otherwise TeamBot retries itself
    }
    if (st.phase === 'qr' && st.qr && process.env.WA_QR_ONLY === '1') return 'qr-only';
    if (st.phase === 'qr' && st.qr && st.qr !== lastQr) {
      lastQr = st.qr;
      if (process.env.WA_PAIR_PHONE && !paired) {
        paired = true;
        const r = await t.api('POST', `/channels/bindings/${b.id}/whatsapp/pair-phone`, { phone: process.env.WA_PAIR_PHONE });
        console.log(`\nKoppelcode: ${r.code.replace(/(.{4})/, '$1-')}\nWhatsApp › Gekoppelde apparaten › Apparaat koppelen › Koppelen met telefoonnummer, en voer de code in.\n`);
      } else if (!process.env.WA_PAIR_PHONE) {
        console.log(await QRCode.toString(st.qr, { type: 'terminal', small: true }));
        fs.writeFileSync(qrFile, `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3><title>TeamBot QR</title><body style="background:#fff;display:grid;place-items:center;height:100vh">${await QRCode.toString(st.qr, { type: 'svg', margin: 2, width: 360 })}`);
        console.log(`Scan met WhatsApp › Gekoppelde apparaten › Apparaat koppelen. (Niet scanbaar? Open ${qrFile})\n`);
      }
    }
    if (st.phase === 'ready') return st;
    return null;
  });
  if (linked === 'qr-only') {
    check('0. Voorcontrole: browser start, WhatsApp Web laadt, QR-code gemaakt', true, 'niet gescand; niets gekoppeld');
    throw new Error('stop');
  }
  if (!linked || linked === 'error') {
    check('1. Koppelen', false, t.app.ctx.store.get('channel_bindings', b.id)?.last_error || 'niet op tijd');
    throw new Error('stop');
  }
  wasLinked = true;
  check('1. Koppelen', true, `gekoppeld als +${linked.me?.phone} (${linked.me?.name || 'naam onbekend'})`);
  const sent = () => t.app.ctx.store.all("SELECT * FROM channel_log WHERE binding_id = ? AND direction = 'out' AND kind = 'message' ORDER BY id", b.id);
  const inbound = () => t.app.ctx.store.all("SELECT * FROM channel_log WHERE binding_id = ? AND direction = 'in' AND kind = 'message' ORDER BY id", b.id);

  // ---- 2. text round trip in "message yourself"
  console.log('\n2. Stuur in WhatsApp in je chat “Bericht aan jezelf”:  test');
  let n0 = sent().length;
  const ok2 = await waitFor('bericht “test” en antwoord', () => inbound().some((r) => /test/i.test(r.summary)) && sent().length > n0);
  check('2. Bericht aan jezelf → bot → antwoord terug', !!ok2, ok2 ? 'controleer op de telefoon: antwoord met “🤖 *Testbot*”' : 'niets ontvangen of niet beantwoord');

  // ---- 3. PDF from the bot (channel_send, owner allowed without approval)
  t.script.push({ toolCalls: [{ name: 'channel_send', args: { binding: 'WhatsApp live-test', to: 'eigenaar', text: 'Hier is de test-pdf', files: ['whatsapp-test.pdf'] } }] }, { text: 'De pdf staat in je chat.' });
  console.log('\n3. Stuur:  pdf');
  n0 = sent().length;
  const ok3 = await waitFor('pdf verstuurd', () => t.app.ctx.store.one("SELECT id FROM audit WHERE kind = 'channels.send' AND data LIKE '%whatsapp-test.pdf%'") && sent().length > n0);
  check('3. Bot stuurt een pdf naar jou (zonder goedkeuring, per bot toegestaan)', !!ok3, ok3 ? 'controleer op de telefoon: “whatsapp-test.pdf” is binnen en opent' : 'geen pdf verstuurd');

  // ---- 4. voice note
  console.log('\n4. Spreek een kort spraakbericht in (in dezelfde chat)');
  const ok4 = await waitFor('spraakbericht', () => t.app.ctx.store.one("SELECT id FROM messages WHERE author_type = 'external' AND content LIKE '%praakbericht%'"));
  check('4. Spraakbericht komt binnen bij de bot', !!ok4, ok4 ? 'als bijlage (uitschrijven alleen met spraakherkenning ingesteld)' : 'niet ontvangen');

  // ---- 5. another bot by name
  console.log('\n5. Stuur:  @Tweede hoi');
  n0 = sent().length;
  const ok5 = await waitFor('antwoord van Tweede', () => {
    const c = t.app.ctx.store.one("SELECT thread_id FROM channel_conversations WHERE binding_id = ? AND external_id LIKE '%#%'", b.id);
    return c?.thread_id && sent().length > n0;
  });
  check('5. Andere bot aanspreken met @Naam', !!ok5, ok5 ? 'controleer: antwoord met “🤖 *Tweede*”' : 'geen antwoord');
} catch (e) {
  if (String(e?.message) !== 'stop') console.error(e);
} finally {
  if (bindingId && wasLinked && process.env.WA_KEEP !== '1') {
    try {
      await t.api('POST', `/channels/bindings/${bindingId}/whatsapp/logout`);
      check('6. Ontkoppelen', true, 'TeamBot moet nu weg zijn bij Gekoppelde apparaten op de telefoon');
    } catch (e) {
      check('6. Ontkoppelen', false, String(e?.message || e));
    }
  }
  if (process.env.WA_KEEP === '1') {
    console.log(`\nWA_KEEP=1: koppeling en map ${t.dir} blijven staan. Ontkoppel later op de telefoon.`);
    await t.app.close();
  } else await t.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} stappen geslaagd.`);
  process.exit(failed ? 1 : 0);
}
