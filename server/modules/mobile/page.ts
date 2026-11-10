/**
 * Self-contained pairing page served at /api/public/mobile/pair (no login, no app bundle needed).
 * The one-time secret travels in the URL fragment (#t=...), so it is never sent to the server in
 * the GET and never ends up in logs; the page reads it and POSTs it to /api/public/mobile/claim.
 */
export function pairPage(appName: string, nonce: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const name = esc(appName);
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#4f46e5">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${name}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<title>${name} koppelen</title>
<style nonce="${nonce}">
:root{--bg:#f6f7fb;--card:#fff;--fg:#141824;--muted:#5c6578;--line:#e2e6ef;--accent:#4f46e5;--accent-fg:#fff;--danger:#c62828;--ok:#15803d;--warn-bg:#fff5e6;--warn:#8a4a07}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#131722;--fg:#e8ebf3;--muted:#98a1b5;--line:#272d3d;--accent:#818cf8;--accent-fg:#0b0d12;--danger:#f87171;--ok:#4ade80;--warn-bg:#2a2110;--warn:#fbbf24}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:420px;margin:0 auto;padding:max(24px,env(safe-area-inset-top)) 16px 32px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}
h1{font-size:20px;margin:8px 0 4px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}
label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}
input{width:100%;height:44px;border:1px solid var(--line);border-radius:10px;padding:0 12px;font-size:16px;background:var(--card);color:var(--fg)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{width:100%;height:46px;margin-top:18px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-fg);font-size:16px;font-weight:600}
button[disabled]{opacity:.6}
.logo{width:48px;height:48px;border-radius:14px;background:var(--accent);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:22px}
.err{color:var(--danger);font-size:14px;min-height:1em}.ok{color:var(--ok)}
.hint{background:var(--warn-bg);color:var(--warn);border-radius:12px;padding:12px;font-size:14px;margin-top:14px}
.hint ol{margin:6px 0 0 18px;padding:0}
a{color:var(--accent)}.hidden{display:none}.code{letter-spacing:.12em;text-transform:uppercase;font-family:ui-monospace,Consolas,monospace}
</style>
</head>
<body>
<main>
  <div class="logo" aria-hidden="true">T</div>
  <h1>${name} koppelen</h1>
  <p class="muted">Verbinden met <strong id="host"></strong>. Deze telefoon krijgt een eigen, intrekbare toegang met beperkte rechten (chatten, goedkeuren, stoppen; geen sleutels of beheer).</p>
  <div class="card">
    <form id="f" novalidate>
      <div id="codeWrap">
        <label for="code">Koppelcode</label>
        <input id="code" class="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="ABCD-EFGH">
        <p class="muted">Staat op je computer onder Instellingen → Telefoon.</p>
      </div>
      <p id="linkNote" class="muted hidden">Koppellink gevonden. Je hoeft geen code te typen.</p>
      <label for="name">Naam van dit apparaat</label>
      <input id="name" maxlength="60" autocomplete="off">
      <button id="go" type="submit">Koppelen</button>
      <p id="err" class="err" role="alert" aria-live="polite"></p>
    </form>
    <div id="ios" class="hint hidden">
      <strong>iPhone: meldingen?</strong> Die werken alleen als ${name} op je beginscherm staat (iOS 16.4+, via https).
      <ol>
        <li>Tik op <em>Deel</em> → <em>Zet op beginscherm</em>.</li>
        <li>Open ${name} vanaf je beginscherm.</li>
        <li>Kies daar <em>Koppelen</em> en typ de koppelcode van je computer.</li>
      </ol>
      Koppel je hier in Safari, dan werkt ${name} alleen in Safari (zonder meldingen).
    </div>
  </div>
  <p class="muted" id="loginLine">Heb je een account met wachtwoord? <a href="/#/">Gewoon inloggen</a>.</p>
</main>
<script nonce="${nonce}">
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.hash.slice(1));
  var secret = params.get('t') || '';
  var code0 = params.get('c') || '';
  if (location.hash) history.replaceState(null, '', location.pathname);
  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  $('host').textContent = location.host;
  $('name').value = isIOS ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : isAndroid ? 'Android-telefoon' : 'Telefoon';
  if (code0) $('code').value = code0;
  if (secret) { $('codeWrap').classList.add('hidden'); $('linkNote').classList.remove('hidden'); }
  if (isIOS && !standalone) $('ios').classList.remove('hidden');
  $('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('code').value.replace(/[^A-Za-z0-9]/g, '');
    if (!secret && code.length < 8) { $('err').textContent = 'Typ de koppelcode van 8 tekens.'; return; }
    $('go').disabled = true; $('err').textContent = '';
    fetch('/api/public/mobile/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: secret || undefined, code: secret ? undefined : code, name: $('name').value, platform: isIOS ? 'ios' : isAndroid ? 'android' : 'other', client: standalone ? 'pwa' : 'browser' })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (r) {
      if (!r.ok) throw new Error(r.j.error || ('Fout ' + r.status));
      var stored = false;
      try { localStorage.setItem('tb_token', r.j.token); stored = true; } catch (x) { stored = false; }
      $('err').className = 'ok'; $('err').textContent = 'Gekoppeld. TeamBot wordt geopend…';
      location.replace(stored ? '/#/' : '/#token=' + encodeURIComponent(r.j.token));
    }).catch(function (x) {
      $('go').disabled = false;
      $('err').textContent = (x && x.message === 'Failed to fetch') ? 'TeamBot is niet bereikbaar. Staat je computer aan en zit je op hetzelfde netwerk?' : (x && x.message) || 'Koppelen mislukt';
      if (secret && /ongeldig|verlopen|gebruikt/i.test(String(x && x.message))) { secret = ''; $('codeWrap').classList.remove('hidden'); $('linkNote').classList.add('hidden'); }
    });
  });
})();
</script>
</body>
</html>`;
}
