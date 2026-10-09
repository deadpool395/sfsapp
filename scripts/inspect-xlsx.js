'use strict';
/**
 * Dependency-free .xlsx inspector.
 *
 * An .xlsx is a ZIP of XML parts, so this reads the archive with zlib alone —
 * it works before `npm install` has run. Used to discover the real column
 * headers of student_data.xlsx so the importer can be mapped against them.
 *
 *   node scripts/inspect-xlsx.js [path-to-xlsx] [rows-to-show]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ zip ---- */

function readZip(buf) {
  const entries = new Map();

  // The End Of Central Directory record sits at the tail, after an optional
  // comment, so scan backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');

    // Jump to the local header; its extra field length can differ from the
    // central directory's, so the payload offset must be read from there.
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const data = buf.subarray(start, start + csize);

    try {
      entries.set(name, method === 0 ? data : zlib.inflateRawSync(data));
    } catch (err) {
      console.error(`  ! could not inflate ${name}: ${err.message}`);
    }
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

/* ------------------------------------------------------------------ xml ---- */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[ent] ?? m;
  });
}

/** Concatenate every <t> inside a fragment (rich text splits across runs). */
function textOf(fragment) {
  let out = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(fragment))) out += decodeXml(m[1]);
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si\b[^>]*(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : '');
  return out;
}

/* --------------------------------------------------------------- sheets ---- */

function colToIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToCol(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/** Excel serial date -> ISO date string (1900 system, with the leap-year bug). */
function serialToDate(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseSheet(xml, shared, dateStyles) {
  const rows = [];
  const rowRe = /<row\b([^>]*)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;

  while ((rm = rowRe.exec(xml))) {
    const rowNumMatch = /\br="(\d+)"/.exec(rm[1] || '');
    const rowNum = rowNumMatch ? Number(rowNumMatch[1]) : rows.length + 1;
    const cells = [];
    const body = rm[2] || '';

    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const ref = (/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || 'n';
      const style = Number((/\bs="(\d+)"/.exec(attrs) || [])[1] ?? -1);
      const idx = ref ? colToIndex(ref) : cells.length;

      let value = '';
      if (type === 'inlineStr') {
        value = textOf(inner);
      } else {
        const v = (/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        if (v !== undefined) {
          if (type === 's') {
            value = shared[Number(v)] ?? '';
          } else if (type === 'str') {
            value = decodeXml(v);
          } else if (type === 'b') {
            value = v === '1' ? 'TRUE' : 'FALSE';
          } else {
            const num = Number(v);
            // Style-declared dates render as dates; otherwise keep the number.
            if (dateStyles.has(style) && Number.isFinite(num) && num > 0) {
              value = serialToDate(num) ?? v;
            } else {
              value = v;
            }
          }
        }
      }
      cells[idx] = value;
    }
    rows.push({ rowNum, cells });
  }
  return rows;
}

/**
 * Collect the style indices whose number format looks like a date, so numeric
 * cells using them can be shown as dates rather than 5-digit serials.
 */
function findDateStyles(stylesXml) {
  const dateStyles = new Set();
  if (!stylesXml) return dateStyles;

  // Built-in date/time formats.
  const builtinDate = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const customDate = new Set();
  const fmtRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let m;
  while ((m = fmtRe.exec(stylesXml))) {
    const code = decodeXml(m[2]).toLowerCase();
    if (/(^|[^\\])[dmy]{1,4}([^\w]|$)/.test(code) && !code.includes('general')) {
      customDate.add(Number(m[1]));
    }
  }

  const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!cellXfsBlock) return dateStyles;
  const xfRe = /<xf\b([^>]*)(?:\/>|>[\s\S]*?<\/xf>)/g;
  let i = 0;
  let xm;
  while ((xm = xfRe.exec(cellXfsBlock[1]))) {
    const id = Number((/\bnumFmtId="(\d+)"/.exec(xm[1]) || [])[1] ?? 0);
    if (builtinDate.has(id) || customDate.has(id)) dateStyles.add(i);
    i += 1;
  }
  return dateStyles;
}

/** Map sheet names to their part paths, honouring the rels indirection. */
function resolveSheets(entries) {
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8') || '';
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';

  const rels = new Map();
  const relRe = /<Relationship\b([^>]*)\/>/g;
  let rm;
  while ((rm = relRe.exec(relsXml))) {
    const id = (/\bId="([^"]+)"/.exec(rm[1]) || [])[1];
    let target = (/\bTarget="([^"]+)"/.exec(rm[1]) || [])[1];
    if (!id || !target) continue;
    target = decodeXml(target).replace(/^\/?xl\//, '').replace(/^\//, '');
    rels.set(id, `xl/${target}`);
  }

  const sheets = [];
  const sheetRe = /<sheet\b([^>]*)\/>/g;
  let sm;
  let fallback = 1;
  while ((sm = sheetRe.exec(workbook))) {
    const name = decodeXml((/\bname="([^"]*)"/.exec(sm[1]) || [])[1] || `Sheet${fallback}`);
    const rid = (/\br:id="([^"]+)"/.exec(sm[1]) || [])[1];
    const part = (rid && rels.get(rid)) || `xl/worksheets/sheet${fallback}.xml`;
    sheets.push({ name, part });
    fallback += 1;
  }
  return sheets;
}

/* ----------------------------------------------------------------- main ---- */

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function main() {
  const file = process.argv[2] || path.join(__dirname, '..', 'student_data.xlsx');
  const sampleCount = Number(process.argv[3] || 5);

  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const entries = readZip(fs.readFileSync(file));
  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
  const dateStyles = findDateStyles(entries.get('xl/styles.xml')?.toString('utf8'));
  const sheets = resolveSheets(entries);

  console.log(`FILE          ${file}`);
  console.log(`SHARED STRINGS ${shared.length}`);
  console.log(`DATE STYLES   ${dateStyles.size ? [...dateStyles].join(',') : 'none'}`);
  console.log(`SHEETS        ${sheets.map((s) => s.name).join(' | ') || '(none found)'}`);

  for (const sheet of sheets) {
    const xml = entries.get(sheet.part)?.toString('utf8');
    console.log(`\n${'='.repeat(78)}\nSHEET "${sheet.name}"  (${sheet.part})\n${'='.repeat(78)}`);
    if (!xml) {
      console.log('  !! part missing from archive');
      continue;
    }

    const rows = parseSheet(xml, shared, dateStyles);
    const nonEmpty = rows.filter((r) => r.cells.some((c) => String(c ?? '').trim() !== ''));
    console.log(`rows (incl. header): ${nonEmpty.length}`);
    if (!nonEmpty.length) continue;

    // Header = first row carrying at least three populated cells.
    const headerIdx = nonEmpty.findIndex(
      (r) => r.cells.filter((c) => String(c ?? '').trim() !== '').length >= 3
    );
    const header = nonEmpty[headerIdx >= 0 ? headerIdx : 0];
    const width = header.cells.length;

    console.log(`\nHEADER (sheet row ${header.rowNum}):`);
    for (let i = 0; i < width; i++) {
      const raw = header.cells[i];
      console.log(`  ${pad(indexToCol(i), 4)} ${raw === undefined || raw === '' ? '(blank)' : JSON.stringify(raw)}`);
    }

    const body = nonEmpty.slice((headerIdx >= 0 ? headerIdx : 0) + 1);
    console.log(`\nDATA ROWS: ${body.length}`);
    console.log(`\nFIRST ${Math.min(sampleCount, body.length)} DATA ROWS:`);
    for (const r of body.slice(0, sampleCount)) {
      const cols = [];
      for (let i = 0; i < width; i++) cols.push(`${indexToCol(i)}=${JSON.stringify(r.cells[i] ?? '')}`);
      console.log(`  r${r.rowNum}: ${cols.join('  ')}`);
    }

    // Distinct values per column help spot class / division / gender columns.
    console.log('\nPER-COLUMN SUMMARY (distinct values, first few):');
    for (let i = 0; i < width; i++) {
      const vals = body.map((r) => String(r.cells[i] ?? '').trim()).filter((v) => v !== '');
      const distinct = [...new Set(vals)];
      const filled = `${vals.length}/${body.length} filled`;
      const preview = distinct.slice(0, 8).map((v) => JSON.stringify(v)).join(', ');
      console.log(
        `  ${pad(indexToCol(i), 4)} ${pad(header.cells[i] ?? '(blank)', 26)} ` +
        `${pad(filled, 16)} ${pad(`${distinct.length} distinct`, 14)} ${preview}${distinct.length > 8 ? ', …' : ''}`
      );
    }
  }

  const merges = [];
  for (const sheet of sheets) {
    const xml = entries.get(sheet.part)?.toString('utf8') || '';
    const block = /<mergeCells\b[\s\S]*?<\/mergeCells>/.exec(xml);
    if (block) merges.push(`${sheet.name}: ${(block[0].match(/ref="[^"]+"/g) || []).join(' ')}`);
  }
  if (merges.length) console.log(`\nMERGED CELLS:\n  ${merges.join('\n  ')}`);
}

if (require.main === module) main();

module.exports = {
  readZip,
  parseSharedStrings,
  parseSheet,
  findDateStyles,
  resolveSheets,
  indexToCol,
  colToIndex,
  serialToDate,
  decodeXml,
};
