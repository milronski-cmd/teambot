// AudioWorklet: microphone → 16 kHz mono 16-bit PCM in 20 ms frames (posted to the main thread).
// Served as a separate file (the app's CSP does not allow blob: scripts).
class TeamBotPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = Math.max(1, sampleRate / 16000);
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
    this.out = new Int16Array(320);
    this.k = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.n));
        this.acc = 0;
        this.n = 0;
        this.out[this.k++] = v < 0 ? v * 32768 : v * 32767;
        if (this.k === this.out.length) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(320);
          this.k = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('teambot-pcm-tap', TeamBotPcmTap);
