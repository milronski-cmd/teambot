/** Test helper: a minimal Ogg muxer (to build Opus files with odd page layouts) and the Ogg CRC. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(b: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < b.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

export function opusHead(o: { channels?: number; preSkip?: number; inputRate?: number; gain?: number } = {}): Buffer {
  const h = Buffer.alloc(19);
  h.write('OpusHead', 0, 'latin1');
  h[8] = 1;
  h[9] = o.channels ?? 1;
  h.writeUInt16LE(o.preSkip ?? 312, 10);
  h.writeUInt32LE(o.inputRate ?? 16000, 12);
  h.writeInt16LE(o.gain ?? 0, 16);
  h[18] = 0;
  return h;
}

export function opusTags(vendor = 'TeamBot test'): Buffer {
  const v = Buffer.from(vendor, 'utf8');
  const b = Buffer.alloc(8 + 4 + v.length + 4);
  b.write('OpusTags', 0, 'latin1');
  b.writeUInt32LE(v.length, 8);
  v.copy(b, 12);
  b.writeUInt32LE(0, 12 + v.length);
  return b;
}

/**
 * Build an Ogg stream. `packets[i].granule` is the granule position after that packet (-1 = none). Pages are cut
 * after `perPage` packets or when `maxSegments` lacing values are reached (packets then continue on the next page).
 */
export function oggMux(packets: { data: Uint8Array; granule: number }[], o: { serial?: number; perPage?: number; maxSegments?: number } = {}): Buffer {
  const serial = o.serial ?? 0x7eab_0001;
  const maxSeg = Math.min(255, o.maxSegments ?? 255);
  const perPage = o.perPage ?? 50;
  const pages: Buffer[] = [];
  let seq = 0;
  let segs: number[] = [];
  let body: Buffer[] = [];
  let granule = -1;
  let continued = false;
  let inPage = 0;
  const flush = (last: boolean, nextContinued: boolean) => {
    if (!segs.length && !last) return;
    const h = Buffer.alloc(27 + segs.length);
    h.write('OggS', 0, 'latin1');
    h[4] = 0;
    h[5] = (continued ? 0x01 : 0) | (seq === 0 ? 0x02 : 0) | (last ? 0x04 : 0);
    if (granule < 0) {
      h.writeUInt32LE(0xffffffff, 6);
      h.writeUInt32LE(0xffffffff, 10);
    } else {
      h.writeUInt32LE(granule % 2 ** 32, 6);
      h.writeUInt32LE(Math.floor(granule / 2 ** 32), 10);
    }
    h.writeUInt32LE(serial, 14);
    h.writeUInt32LE(seq++, 18);
    h[26] = segs.length;
    segs.forEach((s, i) => (h[27 + i] = s));
    const page = Buffer.concat([h, ...body]);
    page.writeUInt32LE(oggCrc(page), 22);
    pages.push(page);
    segs = [];
    body = [];
    granule = -1;
    inPage = 0;
    continued = nextContinued;
  };
  packets.forEach((p, idx) => {
    let left = p.data.length;
    let off = 0;
    // Lacing: 255-byte segments, then a final segment < 255 (possibly 0).
    for (;;) {
      const n = Math.min(255, left);
      if (segs.length >= maxSeg) flush(false, true);
      segs.push(n);
      body.push(Buffer.from(p.data.subarray(off, off + n)));
      off += n;
      left -= n;
      if (n < 255) break;
    }
    granule = p.granule;
    inPage++;
    // The header packets each get their own page (as the spec requires).
    if (idx < 2 || inPage >= perPage) flush(false, false);
  });
  flush(true, false);
  return Buffer.concat(pages);
}
