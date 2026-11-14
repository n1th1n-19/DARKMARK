// Generates the Word and image fixtures: sample.docx, big.docx (~20 MB of images), sample.png, sample.svg.
// Run from the repo root: node test/assets/make-docs-images.mjs
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import JSZip from 'jszip';

const dir = new URL('./', import.meta.url);

// ── PNG (RGBA, 8-bit) ────────────────────────────────────────────────
function png(w, h, pixel, level = 9) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 400×300: a gradient disc fading to transparent, on a transparent background
const samplePng = png(400, 300, (x, y) => {
  const d = Math.hypot(x - 200, y - 150) / 140;
  const a = d > 1 ? 0 : Math.round(255 * (1 - d * d));
  return [Math.round((x / 400) * 255), 120, Math.round((y / 300) * 255), a];
});
writeFileSync(new URL('sample.png', dir), samplePng);

writeFileSync(new URL('sample.svg', dir), `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bc8cff"/><stop offset="1" stop-color="#58a6ff"/></linearGradient></defs>
  <rect x="20" y="20" width="200" height="200" rx="44" fill="url(#g)"/>
  <path d="M70 165V75h30l20 32 20-32h30v90h-26v-48l-24 36-24-36v48z" fill="#0d1117"/>
  <script>document.title = 'svg script ran'</script>
</svg>
`);

// ── docx ─────────────────────────────────────────────────────────────
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (text, { b, i, u } = {}) =>
  `<w:r><w:rPr>${b ? '<w:b/>' : ''}${i ? '<w:i/>' : ''}${u ? '<w:u w:val="single"/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (body, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${body}</w:p>`;
const listItem = (text, numId) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(text)}</w:p>`;
const cell = (text, header) => `<w:tc><w:p>${run(text, { b: header })}</w:p></w:tc>`;
const table = (rows) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>${rows.map((r, i) => `<w:tr>${r.map((c) => cell(c, i === 0)).join('')}</w:tr>`).join('')}</w:tbl>`;
let imgId = 0;
const image = (rId, wPx, hPx) => {
  const id = ++imgId, emu = 9525;
  return `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${wPx * emu}" cy="${hPx * emu}"/><wp:docPr id="${id}" name="Picture ${id}" descr="Picture ${id}"/>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${wPx * emu}" cy="${hPx * emu}"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
};

async function docx(file, bodyXml, media, links = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const rels = [
    `<Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
    ...Object.entries(media).map(([rId, buf]) => {
      zip.file(`word/media/${rId}.png`, buf);
      return `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${rId}.png"/>`;
    }),
    ...Object.entries(links).map(([rId, url]) =>
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(url)}" TargetMode="External"/>`),
  ];
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('\n')}</Relationships>`);
  const heading = (n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - n * 4}"/></w:rPr></w:style>`;
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${heading(1)}${heading(2)}${heading(3)}
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`);
  const abs = (id, fmt, text) => `<w:abstractNum w:abstractNumId="${id}"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl></w:abstractNum>`;
  zip.file('word/numbering.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
${abs(0, 'bullet', '•')}${abs(1, 'decimal', '%1.')}
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${bodyXml}</w:body></w:document>`);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeFileSync(new URL(file, dir), buf);
  console.log(file, (buf.length / 1048576).toFixed(1), 'MB');
}

const lorem = 'Darkmark renders Word documents in the editor, in the same dark theme as the Markdown preview. The text is converted with mammoth, sanitised, and shown as a single centred page.';

await docx('sample.docx', [
  para(run('Darkmark sample document'), 'Heading1'),
  para(run('This paragraph has ') + run('bold', { b: true }) + run(', ') + run('italic', { i: true }) + run(', ') +
    run('underlined', { u: true }) + run(' text, a link to ') +
    `<w:hyperlink r:id="rLink1">${run('the VSCodium website', { u: true })}</w:hyperlink>` + run(' and a link to ') +
    `<w:hyperlink w:anchor="details">${run('the details section', { u: true })}</w:hyperlink>` + run('.')),
  para(run(lorem)),
  para(run('Lists'), 'Heading2'),
  listItem('First bullet', 1), listItem('Second bullet', 1), listItem('Third bullet', 1),
  listItem('Step one', 2), listItem('Step two', 2), listItem('Step three', 2),
  para(run('A table'), 'Heading2'),
  table([['Viewer', 'Library', 'Status'], ['Word', 'mammoth', 'Done'], ['Image', 'none', 'Done'], ['PDF', 'pdf.js', 'In progress']]),
  para(run('An image'), 'Heading2'),
  image('rImg1', 400, 300),
  para(run('The image above is embedded in word/media and shown through a blob: URL.', { i: true })),
  `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:bookmarkStart w:id="0" w:name="details"/>${run('Details')}<w:bookmarkEnd w:id="0"/></w:p>`,
  ...Array.from({ length: 8 }, () => para(run(lorem))),
].join(''), { rImg1: samplePng }, { rLink1: 'https://vscodium.com/' });

// big.docx: 48 × 512×256 RGBA noise (~0.5 MB each, incompressible) with text between them
const big = {};
const body = [para(run('Big document'), 'Heading1')];
for (let i = 1; i <= 48; i++) {
  const noise = randomBytes(512 * 256 * 4);
  for (let p = 3; p < noise.length; p += 4) noise[p] = 255; // opaque
  big[`rImg${i}`] = png(512, 256, (x, y) => noise.subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 4), 1);
  body.push(para(run(`Section ${i}`), 'Heading2'), ...Array.from({ length: 6 }, () => para(run(lorem))), image(`rImg${i}`, 512, 256));
}
await docx('big.docx', body.join(''), big);
