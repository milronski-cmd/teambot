/**
 * Makes the small document fixtures in this folder (run once: `npx tsx tests/fixtures/documents/make.ts`; the files are
 * committed, so tests never need this script).
 *
 * - scan.pdf: a page with only a picture of text (no text layer), like a scanned letter: a text pdf rendered by PDFium
 *   to grey pixels, then put back into a new pdf as an image.
 * - scan.png: the same picture as a png (a photo of a page).
 * - brief.docx, cijfers.xlsx, presentatie.pptx: minimal Office files written by hand (Open XML).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** A pdf from objects (1-based), with a correct cross-reference table. */
function pdf(objects: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let len = parts[0].length;
  objects.forEach((o, i) => {
    offsets.push(len);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(b);
    len += b.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);

const W = 420;
const H = 200;
const LINES = ['Factuur 2026-118', 'Totaal te betalen: 245 euro', 'Graag betalen voor 1 december.'];

function textPdf(): Buffer {
  const content = ['BT', '/F1 22 Tf', '30 150 Td', ...LINES.flatMap((l, i) => [i ? '0 -40 Td' : '', `(${l}) Tj`]).filter(Boolean), 'ET'].join('\n');
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    stream('', Buffer.from(content, 'latin1')),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

function imagePdf(gray: Uint8Array, w: number, h: number): Buffer {
  const img = zlib.deflateSync(Buffer.from(gray), { level: 9 });
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    stream('', Buffer.from(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`, 'latin1')),
    stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, img),
  ]);
}

function png(gray: Uint8Array, w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grey
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(gray.subarray(y * w, (y + 1) * w)).copy(raw, y * (w + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const CT = (overrides: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;
const RELS = (target: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;

function docx(): Buffer {
  const z = new AdmZip();
  const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  z.addFile('[Content_Types].xml', Buffer.from(CT('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>')));
  z.addFile('_rels/.rels', Buffer.from(RELS('word/document.xml')));
  z.addFile(
    'word/_rels/document.xml.rels',
    Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
  );
  z.addFile(
    'word/styles.xml',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`),
  );
  const p = (text: string, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const table = `<w:tbl>${[
    ['Product', 'Prijs'],
    ['Zonnepaneel', '320 euro'],
    ['Omvormer', '890 euro'],
  ]
    .map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`)
    .join('')}</w:tbl>`;
  const body = [p('Offerte zonnepanelen', 'Heading1'), p('Beste meneer De Vries, hierbij onze offerte.'), p('Prijzen', 'Heading2'), table, p('Met vriendelijke groet, Sanne')].join('');
  z.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`));
  return z.toBuffer();
}

function xlsx(): Buffer {
  const z = new AdmZip();
  z.addFile(
    '[Content_Types].xml',
    Buffer.from(
      CT(
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
      ),
    ),
  );
  z.addFile('_rels/.rels', Buffer.from(RELS('xl/workbook.xml')));
  z.addFile(
    'xl/workbook.xml',
    Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Klanten" sheetId="1" r:id="rId1"/><sheet name="Notities" sheetId="2" r:id="rId2"/></sheets></workbook>'),
  );
  z.addFile(
    'xl/_rels/workbook.xml.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    ),
  );
  const strings = ['Naam', 'Plaats', 'Omzet', 'Bakkerij Jansen', 'Utrecht', 'Fietsenmaker Ali', 'Zwolle', 'Opmerking', 'Bel in januari terug'];
  z.addFile('xl/sharedStrings.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`));
  const s = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
  const n = (ref: string, v: number) => `<c r="${ref}"><v>${v}</v></c>`;
  const sheet = (rows: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  z.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet([`<row r="1">${s('A1', 0)}${s('B1', 1)}${s('C1', 2)}</row>`, `<row r="2">${s('A2', 3)}${s('B2', 4)}${n('C2', 1250.5)}</row>`, `<row r="3">${s('A3', 5)}${s('B3', 6)}${n('C3', 830)}</row>`])));
  z.addFile('xl/worksheets/sheet2.xml', Buffer.from(sheet([`<row r="1">${s('A1', 7)}</row>`, `<row r="2">${s('A2', 8)}</row>`])));
  return z.toBuffer();
}

function pptx(): Buffer {
  const z = new AdmZip();
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  z.addFile('[Content_Types].xml', Buffer.from(CT('<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>')));
  z.addFile('_rels/.rels', Buffer.from(RELS('ppt/presentation.xml')));
  // Slide order in the deck is 2, 1 on disk: the reader must follow presentation.xml, not the file names.
  z.addFile('ppt/presentation.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${A}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`));
  z.addFile(
    'ppt/_rels/presentation.xml.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    ),
  );
  const para = (t: string) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
  const slide = (texts: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${A}><p:cSld><p:spTree>${texts.map((t) => `<p:sp><p:txBody>${para(t)}</p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;
  z.addFile('ppt/slides/slide2.xml', Buffer.from(slide(['Plan voor 2027', 'Drie nieuwe winkels &amp; een webshop'])));
  z.addFile('ppt/slides/slide1.xml', Buffer.from(slide(['Budget', 'Totaal 40.000 euro'])));
  z.addFile(
    'ppt/slides/_rels/slide1.xml.rels',
    Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>'),
  );
  z.addFile('ppt/notesSlides/notesSlide1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${A}><p:cSld><p:spTree><p:sp><p:txBody>${para('Noem de subsidie van de gemeente')}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`));
  return z.toBuffer();
}

const { PDFiumLibrary } = await import('@hyzyla/pdfium');
const lib = await PDFiumLibrary.init();
const doc = await lib.loadDocument(new Uint8Array(textPdf()));
const page = doc.getPage(0);
const r = await page.render({ scale: 1.6, colorSpace: 'Gray', render: 'bitmap' });
doc.destroy();
lib.destroy();
fs.writeFileSync(path.join(here, 'scan.pdf'), imagePdf(r.data, r.width, r.height));
fs.writeFileSync(path.join(here, 'scan.png'), png(r.data, r.width, r.height));
fs.writeFileSync(path.join(here, 'brief.docx'), docx());
fs.writeFileSync(path.join(here, 'cijfers.xlsx'), xlsx());
fs.writeFileSync(path.join(here, 'presentatie.pptx'), pptx());
console.log('fixtures written to', here, `(${r.width}x${r.height})`);
