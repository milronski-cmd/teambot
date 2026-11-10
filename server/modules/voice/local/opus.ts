/**
 * Ogg/Opus voice notes (WhatsApp, Telegram, Signal, most phone recorders) → mono float samples for the local
 * recogniser. A small Ogg demuxer lives here; the Opus frames are decoded by `opus-decoder` (MIT; libopus BSD-3-Clause
 * compiled to WebAssembly, so nothing native and it also runs inside Electron). Decoding happens straight at 16 kHz.
 */

export const MAX_OPUS_SECONDS = 30 * 60;

export interface OpusHead {
  channels: number;
  /** Samples (at 48 kHz) to drop at the start (encoder delay). */
  preSkip: number;
  inputRate: number;
  /** Output gain in dB (Q7.8 in the file). */
  gainDb: number;
  mappingFamily: number;
  streamCount: number;
  coupledCount: number;
  mapping: number[];
}

export interface OggOpus {
  head: OpusHead;
  /** Audio packets in order (header and comment packets removed). */
  packets: Uint8Array[];
  /** Granule position of the last page (48 kHz samples incl. pre-skip), or -1 when unknown. */
  lastGranule: number;
}

export class OpusFormatError extends Error {}

/** Split an Ogg file into the packets of its first Opus stream. Throws OpusFormatError with a Dutch message. */
export function demuxOggOpus(buf: Uint8Array): OggOpus {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 28 || b.toString('latin1', 0, 4) !== 'OggS') throw new OpusFormatError('Geen Ogg-bestand');
  let pos = 0;
  let serial: number | null = null;
  let head: OpusHead | null = null;
  let sawTags = false;
  let lastGranule = -1;
  const packets: Uint8Array[] = [];
  let partial: Buffer[] = [];
  let pages = 0;
  while (pos + 27 <= b.length) {
    if (b.toString('latin1', pos, pos + 4) !== 'OggS') {
      // Damaged or padded file: look for the next page.
      const next = b.indexOf('OggS', pos + 1, 'latin1');
      if (next < 0) break;
      pos = next;
      continue;
    }
    const flags = b[pos + 5];
    const granuleLo = b.readUInt32LE(pos + 6);
    const granuleHi = b.readInt32LE(pos + 10);
    const pageSerial = b.readUInt32LE(pos + 14);
    const nSeg = b[pos + 26];
    const segStart = pos + 27;
    if (segStart + nSeg > b.length) break;
    let size = 0;
    for (let i = 0; i < nSeg; i++) size += b[segStart + i];
    const dataStart = segStart + nSeg;
    if (dataStart + size > b.length) break; // truncated last page: use what we have
    if (++pages > 200_000) throw new OpusFormatError('Te veel Ogg-pagina’s');
    if (serial === null && flags & 0x02) {
      // First page of a stream: is it Opus?
      const first = b.subarray(dataStart, dataStart + Math.min(size, 19));
      if (first.length >= 19 && first.toString('latin1', 0, 8) === 'OpusHead') serial = pageSerial;
    }
    if (serial !== null && pageSerial === serial) {
      if (!(flags & 0x01)) partial = []; // not a continuation: drop a dangling half packet
      let off = dataStart;
      for (let i = 0; i < nSeg; i++) {
        const len = b[segStart + i];
        partial.push(b.subarray(off, off + len));
        off += len;
        if (len < 255) {
          const pkt = partial.length === 1 ? partial[0] : Buffer.concat(partial);
          partial = [];
          if (!head) head = parseHead(pkt);
          else if (!sawTags) sawTags = true; // OpusTags (comments): skip
          else if (pkt.length) packets.push(new Uint8Array(pkt.buffer, pkt.byteOffset, pkt.byteLength));
        }
      }
      const granule = granuleHi * 2 ** 32 + granuleLo;
      if (granule >= 0 && !(granuleHi === -1 && granuleLo === 0xffffffff)) lastGranule = granule;
      if (flags & 0x04) break; // end of stream
    }
    pos = dataStart + size;
  }
  if (serial === null || !head) throw new OpusFormatError('Dit Ogg-bestand bevat geen Opus-audio (alleen Opus wordt ondersteund).');
  return { head, packets, lastGranule };
}

function parseHead(p: Buffer): OpusHead {
  if (p.length < 19 || p.toString('latin1', 0, 8) !== 'OpusHead') throw new OpusFormatError('Ongeldige Opus-header');
  const version = p[8];
  if (version >> 4 !== 0) throw new OpusFormatError('Niet-ondersteunde Opus-versie');
  const channels = p[9];
  const mappingFamily = p[18];
  if (!channels) throw new OpusFormatError('Opus zonder kanalen');
  let streamCount = 1;
  let coupledCount = channels > 1 ? 1 : 0;
  let mapping = channels === 2 ? [0, 1] : [0];
  if (mappingFamily !== 0) {
    if (p.length < 21 + channels) throw new OpusFormatError('Ongeldige Opus-kanaalindeling');
    streamCount = p[19];
    coupledCount = p[20];
    mapping = [...p.subarray(21, 21 + channels)];
  } else if (channels > 2) throw new OpusFormatError('Ongeldige Opus-kanaalindeling');
  return { channels, preSkip: p.readUInt16LE(10), inputRate: p.readUInt32LE(12), gainDb: p.readInt16LE(16) / 256, mappingFamily, streamCount, coupledCount, mapping };
}

let decoderModule: Promise<any> | null = null;
const loadDecoder = () => (decoderModule ||= import('opus-decoder'));

/**
 * Decode an Ogg/Opus file to mono float samples at `rate` (8, 12, 16, 24 or 48 kHz; libopus decodes natively at
 * these rates, no resampling). Encoder delay (pre-skip) and end padding (last granule) are trimmed.
 */
export async function decodeOggOpus(buf: Uint8Array, rate: 8000 | 12000 | 16000 | 24000 | 48000 = 16000): Promise<{ samples: Float32Array; sampleRate: number; seconds: number; corruptPackets: number }> {
  const { head, packets, lastGranule } = demuxOggOpus(buf);
  const { OpusDecoder } = await loadDecoder();
  const dec = new OpusDecoder({
    sampleRate: rate,
    channels: head.channels,
    streamCount: head.streamCount,
    coupledStreamCount: head.coupledCount,
    channelMappingTable: head.mapping,
    preSkip: 0,
  });
  await dec.ready;
  const maxPacket = 3840 * head.channels; // the decoder's input buffer
  const maxSamples = MAX_OPUS_SECONDS * rate;
  const parts: Float32Array[] = [];
  let total = 0;
  let corrupt = 0;
  try {
    for (let i = 0; i < packets.length; i += 50) {
      const batch = packets.slice(i, i + 50).filter((p) => {
        if (p.length <= maxPacket) return true;
        corrupt++;
        return false;
      });
      if (!batch.length) continue;
      const r = dec.decodeFrames(batch);
      corrupt += r.errors?.length || 0;
      const ch: Float32Array[] = r.channelData;
      const n = r.samplesDecoded;
      if (!n || !ch?.length) continue;
      const mono = new Float32Array(n);
      for (const c of ch) for (let k = 0; k < n; k++) mono[k] += c[k] / ch.length;
      parts.push(mono);
      total += n;
      if (total > maxSamples) throw new OpusFormatError(`Het spraakbericht is te lang (max. ${MAX_OPUS_SECONDS / 60} minuten)`);
    }
  } finally {
    try {
      dec.free();
    } catch {
      /* already freed */
    }
  }
  const scale = rate / 48000;
  const skip = Math.min(total, Math.round(head.preSkip * scale));
  let end = total;
  if (lastGranule >= 0) end = Math.min(total, Math.max(skip, Math.round(lastGranule * scale)));
  const out = new Float32Array(end - skip);
  let o = 0;
  let at = 0;
  for (const p of parts) {
    const from = Math.max(0, skip - at);
    const to = Math.min(p.length, end - at);
    if (to > from) out.set(p.subarray(from, to), o), (o += to - from);
    at += p.length;
  }
  if (head.gainDb) {
    const g = Math.pow(10, head.gainDb / 20);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] * g));
  }
  return { samples: out, sampleRate: rate, seconds: out.length / rate, corruptPackets: corrupt };
}
