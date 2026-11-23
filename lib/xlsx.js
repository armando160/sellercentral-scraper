// Reads the first sheet of a simple .xlsx file (like Vendor Central's
// metric-data.xlsx) into rows of text and numbers. No extra packages: an
// .xlsx is a zip of XML files.
//   readXlsx(buffer) -> [['ASIN', 'Item name', ...], ['B07P5GV3VX', '...', 30978, ...], ...]
// HYPERLINK formulas become their shown text ("B07P5GV3VX").
import zlib from 'node:zlib';

function unzip(buf) {
  // Find the "end of central directory" record (signature 0x06054b50).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not an .xlsx (zip) file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files[name] = () => (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(buf) {
  const files = unzip(buf);
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    for (const si of files['xl/sharedStrings.xml']().match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(unescape((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const sheetName = Object.keys(files).find((f) => /^xl\/worksheets\/sheet1\.xml$/.test(f))
    || Object.keys(files).find((f) => /^xl\/worksheets\/.*\.xml$/.test(f));
  if (!sheetName) throw new Error('No sheet in the .xlsx file');
  const rows = [];
  for (const row of files[sheetName]().match(/<row[\s\S]*?<\/row>/g) || []) {
    const out = [];
    for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const ref = c.match(/ r="([A-Z]+\d+)"/)?.[1];
      const type = c.match(/ t="([^"]+)"/)?.[1];
      const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const f = c.match(/<f>([\s\S]*?)<\/f>/)?.[1];
      let value = null;
      if (v === '' && !f) value = null; // empty cell (Amazon writes <v></v>)
      else if (type === 's') value = v === undefined ? null : shared[Number(v)];
      else if (type === 'n' || (!type && v !== undefined)) value = Number(v);
      else if (type === 'inlineStr') value = unescape((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
      else if (v !== undefined) value = unescape(v);
      else if (f) {
        const parts = unescape(f).match(/"([^"]*)"/g);
        value = parts ? parts[parts.length - 1].slice(1, -1) : unescape(f);
      }
      out[ref ? colIndex(ref) : out.length] = value;
    }
    rows.push(Array.from(out, (x) => (x === undefined ? null : x)));
  }
  return rows;
}
