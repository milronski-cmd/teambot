/**
 * Scripts evaluated inside bot browser pages. Kept as strings because the server is compiled
 * without DOM types. They never read password/payment field values.
 */

/** Readable outline with stable element refs ([e12]) stored as data-tbref attributes. */
export const SNAPSHOT_JS = String.raw`(opts) => {
  const MAXC = opts.maxChars || 15000;
  const W = window;
  if (!W.__tbRef) W.__tbRef = 0;
  const lines = []; let len = 0; let truncated = false; let refs = 0;
  const push = (depth, s) => {
    if (truncated) return;
    const line = '  '.repeat(Math.min(depth, 8)) + s;
    if (len + line.length > MAXC) { truncated = true; return; }
    lines.push(line); len += line.length + 1;
  };
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','META','LINK','svg','SVG','CANVAS']);
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const visible = (el) => {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const st = getComputedStyle(el);
    return !(st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || Number(st.opacity) === 0);
  };
  const hasBox = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const sensitive = (el) => {
    if (el.hasAttribute('data-tbvault-filled') || el.hasAttribute('data-tbvault')) return true; // filled by TeamBot's vault
    const t = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return t === 'password' || /cc-|one-time-code|current-password|new-password/.test(ac) || /passw|wachtw|pincode|cvc|cvv/i.test(el.getAttribute('name') || '');
  };
  const labelFor = (el) => {
    const al = el.getAttribute('aria-label'); if (al) return al;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' '); if (t.trim()) return t; }
    if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.innerText).join(' ');
    return el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '';
  };
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', file: 'bestand', search: 'zoekveld', number: 'getal' };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return el.multiple ? 'keuzelijst' : 'keuzemenu';
    if (tag === 'TEXTAREA') return 'tekstvak';
    if (tag === 'INPUT') { const t = (el.type || 'text').toLowerCase(); if (t === 'hidden') return null; return INPUT_ROLES[t] || 'tekstveld'; }
    if (el.isContentEditable && el.hasAttribute('contenteditable')) return 'tekstvak';
    if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0)) return 'klikbaar';
    return null;
  };
  const INTERACTIVE = new Set(['link','button','checkbox','radio','keuzemenu','keuzelijst','combobox','listbox','tekstvak','tekstveld','zoekveld','getal','textbox','searchbox','slider','switch','tab','menuitem','menuitemcheckbox','menuitemradio','option','bestand','klikbaar','spinbutton','treeitem']);
  const refOf = (el) => { let r = el.getAttribute('data-tbref'); if (!r) { r = 'e' + (++W.__tbRef); el.setAttribute('data-tbref', r); } refs++; return r; };
  let textBuf = ''; let textDepth = 0;
  const flush = () => { const t = clip(textBuf, 400); if (t) push(textDepth, t); textBuf = ''; };
  const BLOCK = /^(DIV|P|LI|SECTION|ARTICLE|MAIN|HEADER|FOOTER|NAV|ASIDE|FORM|TABLE|TR|TD|TH|UL|OL|DL|DT|DD|BLOCKQUOTE|PRE|FIGURE|FIELDSET|LABEL|DIALOG|BR|HR)$/;
  const walk = (node, depth) => {
    if (truncated) return;
    if (node.nodeType === 3) { const t = node.textContent; if (t && t.trim()) { if (!textBuf) textDepth = depth; textBuf += ' ' + t; } return; }
    if (node.nodeType !== 1) return;
    const el = node; const tag = el.tagName;
    if (SKIP.has(tag)) return;
    if (!visible(el)) return;
    if (/^H[1-6]$/.test(tag)) { flush(); const t = clip(el.innerText, 200); if (t) push(depth, '#'.repeat(Number(tag[1])) + ' ' + t); return; }
    if (tag === 'IMG') { const alt = el.getAttribute('alt'); if (alt && alt.trim() && hasBox(el)) { flush(); push(depth, 'afbeelding "' + clip(alt, 100) + '"'); } return; }
    if (tag === 'IFRAME') { flush(); push(depth, '[iframe ' + clip(el.src, 100) + '] (inhoud niet gelezen)'); return; }
    const role = roleOf(el);
    if (role && INTERACTIVE.has(role) && hasBox(el)) {
      flush();
      const ref = refOf(el);
      const field = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const name = clip(labelFor(el) || (field ? '' : el.innerText), 100);
      let s = '[' + ref + '] ' + role + (name ? ' "' + name + '"' : '');
      if (tag === 'A' && el.href) s += ' -> ' + clip(el.href, 140);
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const t = (el.type || '').toLowerCase();
        if (t === 'checkbox' || t === 'radio') s += el.checked ? ' (aangevinkt)' : ' (niet aangevinkt)';
        else if (t === 'file') s += ' (bestand kiezen)';
        else if (el.hasAttribute('data-tbvault-filled')) s += ' (ingevuld door de kluis van TeamBot, verborgen)';
        else if (sensitive(el)) s += el.value ? ' (ingevuld, verborgen)' : ' (leeg, gevoelig veld: laat de gebruiker dit invullen)';
        else if (t !== 'submit' && t !== 'button' && t !== 'reset' && t !== 'image') s += el.value ? ' = "' + clip(el.value, 80) + '"' : ' (leeg)';
      }
      if (tag === 'SELECT') {
        const o = Array.from(el.options).slice(0, 20).map((x) => (x.selected ? '*' : '') + clip(x.text, 40));
        s += ' opties: ' + o.join(' | ') + (el.options.length > 20 ? ' …' : '');
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' (uitgeschakeld)';
      const exp = el.getAttribute('aria-expanded'); if (exp) s += exp === 'true' ? ' (open)' : ' (dicht)';
      const form = el.form;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (form && ((tag === 'BUTTON' && (type === '' || type === 'submit')) || (tag === 'INPUT' && (type === 'submit' || type === 'image'))))
        s += ' (verstuurt formulier' + ((form.getAttribute('method') || 'get').toLowerCase() === 'post' ? ', POST' : '') + ')';
      push(depth, s);
      if (field || role === 'link' || role === 'button') return;
    }
    const block = BLOCK.test(tag);
    if (block) flush();
    let d = depth;
    if (tag === 'FORM') { push(depth, 'formulier' + (el.getAttribute('aria-label') ? ' "' + clip(el.getAttribute('aria-label'), 60) + '"' : '') + ' (' + (el.getAttribute('method') || 'get').toUpperCase() + ')'); d++; }
    else if (tag === 'DIALOG' && el.open) { push(depth, 'dialoogvenster'); d++; }
    else if (/^(NAV|MAIN|UL|OL|TABLE)$/.test(tag)) d++;
    if (el.shadowRoot) for (const k of el.shadowRoot.childNodes) walk(k, d);
    for (const k of el.childNodes) walk(k, d);
    if (block) flush();
  };
  if (document.body) walk(document.body, 0);
  flush();
  return { title: document.title, url: location.href, lines, truncated, refs, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
}`;

/** Plain readable text of the page (bounded). */
export const TEXT_JS = String.raw`(max) => { const t = (document.body ? document.body.innerText : '') || ''; return { title: document.title, url: location.href, text: t.length > max ? t.slice(0, max) : t, total: t.length }; }`;

/** Facts about one element, used for risk classification and approval previews. */
export const ELEMENT_INFO_JS = String.raw`(ref) => {
  const el = ref ? document.querySelector('[data-tbref="' + CSS.escape(ref) + '"]') : document.activeElement;
  if (!el || el === document.body) return null;
  const tag = el.tagName.toLowerCase();
  const form = el.form || (el.closest ? el.closest('form') : null);
  const type = (el.getAttribute('type') || '').toLowerCase();
  const field = tag === 'input' || tag === 'textarea' || tag === 'select';
  const submits = !!form && ((tag === 'button' && (type === '' || type === 'submit')) || (tag === 'input' && (type === 'submit' || type === 'image')));
  const implicit = !!form && tag === 'input' && !['checkbox','radio','button','submit','reset','image','file'].includes(type);
  const r = el.getBoundingClientRect();
  let fields = [];
  if (form) fields = Array.from(form.elements).slice(0, 30).filter((f) => f.name && f.type !== 'hidden').map((f) => {
    const t = (f.getAttribute('type') || '').toLowerCase();
    const secret = t === 'password' || f.hasAttribute('data-tbvault-filled') || /cc-|password|one-time/.test((f.getAttribute('autocomplete') || '').toLowerCase());
    return { name: String(f.name).slice(0, 40), value: secret ? '(verborgen)' : String(f.value || '').slice(0, 60) };
  });
  return {
    tag, type, role: el.getAttribute('role') || '',
    name: String(el.getAttribute('aria-label') || (field ? (el.labels && el.labels[0] ? el.labels[0].innerText : el.getAttribute('placeholder')) : el.innerText) || (field && !['submit', 'button', 'reset', 'image'].includes(type) ? '' : el.value) || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    inForm: !!form, formMethod: form ? (form.getAttribute('method') || 'get') : '', formAction: form ? form.action : '',
    submits, implicit, href: el.href || '', sensitive: type === 'password' || el.hasAttribute('data-tbvault-filled') || el.hasAttribute('data-tbvault') || /cc-|password|one-time/.test((el.getAttribute('autocomplete') || '').toLowerCase()),
    rect: { x: r.x, y: r.y, w: r.width, h: r.height }, fields,
  };
}`;

/** Submit the form that owns an element (or the element's own form). */
export const SUBMIT_JS = String.raw`(ref) => {
  const el = document.querySelector('[data-tbref="' + CSS.escape(ref) + '"]');
  if (!el) return 'missing';
  const form = el.tagName === 'FORM' ? el : (el.form || el.closest('form'));
  if (!form) return 'noform';
  if (form.requestSubmit) form.requestSubmit(); else form.submit();
  return 'ok';
}`;

/** Masked (black) in every screenshot and history frame: secrets, payment fields and everything the vault filled in. */
export const SENSITIVE_SELECTOR = 'input[type=password], input[autocomplete*="cc-"], input[autocomplete*="password"], input[autocomplete="one-time-code"], [data-tbvault], [data-tbvault-filled]';
