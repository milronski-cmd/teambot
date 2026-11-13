/**
 * The small recording pill for the dictation hotkey (bottom centre of the screen with the mouse, just above the
 * taskbar: never over the middle of your work). It never takes the focus (the text has to go to the app you are typing
 * in) and lets every click through. It also does the recording:
 * the microphone is only opened on "start" and closed again on "stop"/"cancel" (16 kHz PCM via an AudioWorklet,
 * sent to the main process every 100 ms).
 */
export const OVERLAY_WIDTH = 420;
export const OVERLAY_HEIGHT = 52;
/** Distance to the bottom of the work area (the taskbar). */
export const OVERLAY_MARGIN = 12;
/** No view update for this long while it is shown: hide it, whatever the state (longer than any step may take). */
export const OVERLAY_STALE_MS = 150_000;

/** Where the pill goes on a display's work area: bottom centre, never wider than the screen. */
export function overlayBounds(workArea: { x: number; y: number; width: number; height: number }) {
  const width = Math.max(200, Math.min(OVERLAY_WIDTH, workArea.width - 16));
  return { x: Math.round(workArea.x + (workArea.width - width) / 2), y: Math.round(workArea.y + workArea.height - OVERLAY_HEIGHT - OVERLAY_MARGIN), width, height: OVERLAY_HEIGHT };
}

const WORKLET = `class TbDictPcm extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = Math.max(1, sampleRate / 16000); this.pos = 0; this.acc = 0; this.n = 0; this.out = new Int16Array(320); this.k = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.n));
        this.acc = 0; this.n = 0;
        this.out[this.k++] = v < 0 ? v * 32768 : v * 32767;
        if (this.k === this.out.length) { this.port.postMessage(this.out.buffer, [this.out.buffer]); this.out = new Int16Array(320); this.k = 0; }
      }
    }
    return true;
  }
}
registerProcessor('tb-dict-pcm', TbDictPcm);`;

export const OVERLAY_HTML = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif;user-select:none}
#pill{position:fixed;left:6px;right:6px;bottom:6px;height:38px;display:flex;align-items:center;gap:10px;padding:0 16px;box-sizing:border-box;
  background:rgba(18,18,22,.92);color:#fff;border-radius:999px;font-size:13px;line-height:18px;box-shadow:0 6px 24px rgba(0,0,0,.35);white-space:nowrap;overflow:hidden}
#dot{flex:none;width:10px;height:10px;border-radius:50%;background:#ef4444;animation:pulse 1.1s ease-in-out infinite}
#what{flex:none;font-weight:600}
#text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;opacity:.9}
#text span{direction:ltr;unicode-bidi:embed}
#meter{flex:none;display:flex;gap:2px;align-items:flex-end;height:16px}
#meter i{display:block;width:3px;height:3px;background:#f87171;border-radius:1px;transition:height .08s}
#hint{flex:none;opacity:.6;font-size:12px}
body.working #dot{background:#a3a3a3;animation:none}
body.ok #dot{background:#22c55e;animation:none}
body.warn #dot{background:#f59e0b;animation:none}
body.starting #dot{background:#f59e0b}
body:not(.recording) #meter{display:none}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){#dot{animation:none}}
</style></head><body><div id="pill" role="status" aria-live="polite"><span id="dot"></span><span id="what">Dicteren</span><span id="text"><span id="t"></span></span><span id="meter"><i></i><i></i><i></i><i></i><i></i></span><span id="hint"></span></div>
<script>
(function () {
  var bridge = window.tbDictation;
  var WORKLET = ${JSON.stringify(WORKLET)};
  var stream = null, ac = null, node = null, pending = [], timer = null, level = 0, gen = 0;
  function el(id) { return document.getElementById(id); }
  window.tbView = function (v) {
    document.body.className = v.phase === 'message' || v.phase === 'done' ? (v.tone || 'warn') : v.phase;
    var what = { starting: 'Microfoon aan…', recording: 'Dicteren', working: 'Uitschrijven…', done: 'Geplakt', message: 'Dicteren' }[v.phase] || 'Dicteren';
    if (v.phase === 'recording' && typeof v.seconds === 'number') what += ' ' + Math.floor(v.seconds / 60) + ':' + String(v.seconds % 60).padStart(2, '0');
    el('what').textContent = what;
    el('t').textContent = v.text || '';
    el('hint').textContent = v.phase === 'recording' || v.phase === 'starting' ? (v.hint || '') : '';
    var bars = document.querySelectorAll('#meter i');
    var l = Math.min(1, (v.level || level) * 12);
    for (var i = 0; i < bars.length; i++) bars[i].style.height = (3 + Math.max(0, l * 13 - Math.abs(i - 2) * 3)) + 'px';
  };
  function flush() {
    if (!pending.length) return;
    var n = 0; for (var i = 0; i < pending.length; i++) n += pending[i].length;
    var out = new Int16Array(n), o = 0, s = 0;
    for (var j = 0; j < pending.length; j++) { out.set(pending[j], o); o += pending[j].length; }
    for (var k = 0; k < out.length; k++) s += out[k] * out[k];
    level = Math.sqrt(s / Math.max(1, out.length)) / 32768;
    pending = [];
    bridge.pcm(out.buffer, level);
  }
  function close() {
    if (timer) clearInterval(timer);
    timer = null;
    try { if (node) node.port.onmessage = null; } catch (e) {}
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (ac) ac.close(); } catch (e) {}
    stream = null; ac = null; node = null; pending = [];
  }
  async function start() {
    var my = ++gen;
    close();
    console.debug('[dicteren] microfoon openen');
    try {
      var s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (my !== gen) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;
      // The microphone went away while recording (unplugged, taken by Windows): say so, the pill then closes.
      s.getTracks().forEach(function (t) { t.onended = function () { if (my !== gen) return; ++gen; close(); bridge.error('De microfoon is weggevallen.'); }; });
      console.debug('[dicteren] microfoon open');
      ac = new AudioContext({ latencyHint: 'interactive' });
      if (ac.state !== 'running') await ac.resume();
      var url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ac.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (my !== gen) return close();
      var src = ac.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ac, 'tb-dict-pcm', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = function (e) { pending.push(new Int16Array(e.data)); };
      var mute = ac.createGain(); mute.gain.value = 0;
      src.connect(node); node.connect(mute); mute.connect(ac.destination);
      timer = setInterval(flush, 100);
      console.debug('[dicteren] opname loopt');
      bridge.started();
    } catch (e) {
      close();
      console.debug('[dicteren] fout', e && e.name, e && e.message);
      var name = e && e.name;
      bridge.error(name === 'NotAllowedError' ? 'Geen toegang tot de microfoon (Windows-instellingen › Privacy › Microfoon).' : name === 'NotFoundError' ? 'Geen microfoon gevonden.' : 'Microfoon openen mislukt: ' + ((e && e.message) || e));
    }
  }
  async function stop() {
    ++gen;
    // The last 20 ms frames are still on their way from the audio thread.
    await new Promise(function (r) { setTimeout(r, 60); });
    flush();
    close();
    bridge.stopped();
  }
  console.debug('[dicteren] klaar, brug ' + (bridge ? 'aanwezig' : 'ontbreekt'));
  bridge.onCommand(function (cmd, data) {
    if (cmd === 'start') start();
    else if (cmd === 'stop') stop();
    else if (cmd === 'cancel') { ++gen; close(); }
    else if (cmd === 'view') window.tbView(data || {});
  });
})();
</script></body></html>`;
