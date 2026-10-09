'use strict';
/**
 * Excel and PDF report builders.
 *
 * Both consume the output of marks.buildReportData(), so the two formats and
 * the on-screen table always show the same numbers.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const { formatClassLabel } = require('../lib/classes');
const { termLabel, componentLabel } = require('../lib/terms');
const { POWERED_BY } = require('../lib/constants');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Crest for embedded report branding. Prefers the downscaled mark, since the
 * full-resolution source would add ~0.5 MB to every exported file.
 * Regenerate with `npm run logo:mark` after replacing logo/logo.png.
 */
const LOGO_PATH = [
  path.join(ROOT, 'logo', 'logo-mark.png'),
  path.join(ROOT, 'logo', 'logo.png'),
].find((p) => fs.existsSync(p));

/**
 * Montserrat for PDFs, matching the web UI.
 *
 * These are static Latin-subset instances: Google ships Montserrat only as a
 * variable font, and pdfkit does not apply named variations (it falls back to
 * the Thin master), so separate Regular and Bold files are required.
 * Falls back to the PDF base-14 Helvetica if the files are missing.
 */
const FONT_DIR = path.join(ROOT, 'public', 'fonts');
const MONT_REGULAR = path.join(FONT_DIR, 'montserrat-400.woff');
const MONT_BOLD = path.join(FONT_DIR, 'montserrat-700.woff');

const FONT = fs.existsSync(MONT_REGULAR) && fs.existsSync(MONT_BOLD)
  ? { regular: MONT_REGULAR, bold: MONT_BOLD }
  : { regular: 'Helvetica', bold: 'Helvetica-Bold' };

const XL_FONT = 'Montserrat';

const BRAND = '2C6559';
const BRAND_LIGHT = 'DCEBE7';
const BRAND_PDF = '#2c6559';
const INK_PDF = '#14201d';
const MUTED_PDF = '#5b6b66';

/** Windows-safe filename stem. */
function slug(s) {
  return String(s || '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function reportFilename(data, ext) {
  const s = data.submission;
  return [
    'Marks',
    slug(formatClassLabel({ name: s.class_name, division: s.class_division })),
    slug(s.subject_name),
    slug(termLabel(s.term)),
  ]
    .filter(Boolean)
    .join('_') + `.${ext}`;
}

/** Facts shown above the table in both formats. */
function headerPairs(data, schoolName) {
  const s = data.submission;
  return [
    ['Academic Year', s.year_name],
    ['Class', formatClassLabel({ name: s.class_name, division: s.class_division })],
    ['Subject', s.subject_name],
    ['Term', termLabel(s.term)],
    ['Entered by', s.teacher_name],
    ['Submitted on', new Date(s.submitted_at).toLocaleString('en-IN')],
    ...(s.updated_at
      ? [['Last edited', `${new Date(s.updated_at).toLocaleString('en-IN')} by admin ${s.updated_by_admin || ''}`.trim()]]
      : []),
  ];
}

function fmt(v, digits = 0) {
  if (v === null || v === undefined) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return digits ? n.toFixed(digits) : String(Number(n.toFixed(2)));
}

/* ----------------------------------------------------------------- excel -- */

async function buildExcel(data, { schoolName }) {
  const s = data.submission;
  const secLabel = componentLabel(s.secondary_component);

  const wb = new ExcelJS.Workbook();
  wb.creator = schoolName;
  wb.created = new Date();

  const ws = wb.addWorksheet(`${termLabel(s.term)}`, {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ state: 'frozen', ySplit: 0 }],
  });

  ws.columns = [
    { key: 'sl', width: 6 },
    { key: 'roll', width: 9 },
    { key: 'adm', width: 14 },
    { key: 'name', width: 34 },
    { key: 'ut', width: 14 },
    { key: 'sec', width: 16 },
    { key: 'total', width: 12 },
    { key: 'pct', width: 10 },
  ];

  const lastCol = 8;

  /* crest, floated over the title block in the top-left corner */
  if (LOGO_PATH) {
    const logoId = wb.addImage({ filename: LOGO_PATH, extension: 'png' });
    ws.addImage(logoId, { tl: { col: 0.2, row: 0.15 }, ext: { width: 44, height: 44 } });
  }

  /* title block */
  const title = ws.addRow([schoolName]);
  ws.mergeCells(title.number, 1, title.number, lastCol);
  title.getCell(1).font = { name: XL_FONT, size: 16, bold: true, color: { argb: `FF${BRAND}` } };
  title.getCell(1).alignment = { horizontal: 'center' };
  title.height = 22;

  const subtitle = ws.addRow([`${s.subject_name} — ${termLabel(s.term)} — Unit Test & ${secLabel} Marks`]);
  ws.mergeCells(subtitle.number, 1, subtitle.number, lastCol);
  subtitle.getCell(1).font = { name: XL_FONT, size: 11, italic: true, color: { argb: 'FF5B6B66' } };
  subtitle.getCell(1).alignment = { horizontal: 'center' };

  ws.addRow([]);

  /* metadata, two label/value pairs per line */
  const pairs = headerPairs(data, schoolName);
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i];
    const b = pairs[i + 1];
    const row = ws.addRow(['', a[0], a[1], '', '', b ? b[0] : '', b ? b[1] : '', '']);
    for (const col of [2, 6]) {
      row.getCell(col).font = { name: XL_FONT, bold: true, size: 10, color: { argb: 'FF245247' } };
    }
    for (const col of [3, 7]) {
      row.getCell(col).font = { name: XL_FONT, size: 10 };
      ws.mergeCells(row.number, col, row.number, col + 1);
    }
  }

  ws.addRow([]);

  /* table header */
  const head = ws.addRow([
    'Sl.',
    'Roll',
    'Adm. No.',
    'Student Name',
    `Unit Test (${fmt(data.unitMax)})`,
    `${secLabel} (${fmt(data.secMax)})`,
    `Total (${fmt(data.totalMax)})`,
    '%',
  ]);
  head.eachCell((cell) => {
    cell.font = { name: XL_FONT, bold: true, size: 10, color: { argb: `FF${BRAND}` } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BRAND_LIGHT}` } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB9D7D0' } },
      bottom: { style: 'thin', color: { argb: 'FFB9D7D0' } },
      left: { style: 'thin', color: { argb: 'FFB9D7D0' } },
      right: { style: 'thin', color: { argb: 'FFB9D7D0' } },
    };
  });
  head.height = 28;

  // Freeze everything above and including the header row.
  ws.views = [{ state: 'frozen', ySplit: head.number }];

  /* data rows */
  for (const st of data.students) {
    const row = ws.addRow({
      sl: st.index,
      roll: st.rollNo,
      adm: st.admissionNo,
      name: st.name,
      ut: st.unitTest === null ? 'AB' : Number(st.unitTest),
      sec: st.secondary === null ? 'AB' : Number(st.secondary),
      total: st.total === null ? '' : Number(st.total),
      pct: st.percent === null ? '' : Number(st.percent / 100),
    });

    row.getCell('sl').alignment = { horizontal: 'center' };
    row.getCell('roll').alignment = { horizontal: 'center' };
    for (const key of ['ut', 'sec', 'total']) {
      row.getCell(key).alignment = { horizontal: 'center' };
      row.getCell(key).numFmt = '0.##';
    }
    row.getCell('pct').numFmt = '0.0%';
    row.getCell('pct').alignment = { horizontal: 'center' };

    // Cells carry no font of their own otherwise, so Excel would fall back to
    // its default (Calibri) for the body of the table.
    row.eachCell((cell) => { cell.font = { name: XL_FONT, size: 10 }; });

    if (st.absent) {
      row.eachCell((cell) => {
        cell.font = { name: XL_FONT, size: 10, color: { argb: 'FF8A9A95' }, italic: true };
      });
    }

    row.eachCell((cell) => {
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFDFE8E5' } } };
    });
  }

  /* totals */
  const t = data.totals;
  const foot = ws.addRow({
    name: `Total (${t.counted} assessed, ${t.absent} absent)`,
    ut: t.unitTest === null ? '' : Number(t.unitTest),
    sec: t.secondary === null ? '' : Number(t.secondary),
    total: t.total === null ? '' : Number(t.total),
    pct: t.averagePercent === null ? '' : Number(t.averagePercent / 100),
  });
  foot.eachCell((cell) => {
    cell.font = { name: XL_FONT, bold: true, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF4F2' } };
    cell.border = { top: { style: 'thin', color: { argb: 'FFB9D7D0' } } };
  });
  foot.getCell('pct').numFmt = '0.0%';
  for (const key of ['ut', 'sec', 'total']) foot.getCell(key).alignment = { horizontal: 'center' };

  ws.addRow([]);
  const note = ws.addRow([`AB = absent / not assessed.  Average % is the mean of assessed students.`]);
  note.getCell(1).font = { name: XL_FONT, size: 9, italic: true, color: { argb: 'FF8A9A95' } };
  ws.mergeCells(note.number, 1, note.number, lastCol);

  const credit = ws.addRow([`Powered by ${POWERED_BY.name} — ${POWERED_BY.url}`]);
  credit.getCell(1).font = { name: XL_FONT, size: 9, color: { argb: 'FF8A9A95' } };
  ws.mergeCells(credit.number, 1, credit.number, lastCol);

  return {
    buffer: await wb.xlsx.writeBuffer(),
    filename: reportFilename(data, 'xlsx'),
  };
}

/** Multi-submission summary workbook for the admin oversight screen. */
async function buildSubmissionsExcel(rows, { schoolName }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = schoolName;
  const ws = wb.addWorksheet('Submissions');

  ws.columns = [
    { header: 'Academic Year', key: 'year', width: 15 },
    { header: 'Class', key: 'cls', width: 14 },
    { header: 'Subject', key: 'subject', width: 20 },
    { header: 'Term', key: 'term', width: 10 },
    { header: 'Component', key: 'component', width: 13 },
    { header: 'Entered By', key: 'teacher', width: 24 },
    { header: 'Students', key: 'students', width: 10 },
    { header: 'Unit Test Max', key: 'utmax', width: 14 },
    { header: 'Second Max', key: 'secmax', width: 12 },
    { header: 'Submitted On', key: 'submitted', width: 22 },
    { header: 'Last Edited By Admin', key: 'edited', width: 24 },
  ];

  ws.getRow(1).eachCell((cell) => {
    cell.font = { name: XL_FONT, bold: true, size: 10, color: { argb: `FF${BRAND}` } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BRAND_LIGHT}` } };
    cell.alignment = { horizontal: 'center', wrapText: true };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const r of rows) {
    const row = ws.addRow({
      year: r.year_name,
      cls: formatClassLabel({ name: r.class_name, division: r.class_division }),
      subject: r.subject_name,
      term: termLabel(r.term),
      component: componentLabel(r.secondary_component),
      teacher: r.teacher_name,
      students: r.student_count,
      utmax: Number(r.unit_test_max),
      secmax: Number(r.secondary_max),
      submitted: new Date(r.submitted_at).toLocaleString('en-IN'),
      edited: r.updated_at
        ? `${r.updated_by_admin || 'admin'} on ${new Date(r.updated_at).toLocaleString('en-IN')}`
        : '',
    });
    row.eachCell((cell) => { cell.font = { name: XL_FONT, size: 10 }; });
  }

  ws.addRow([]);
  ws.addRow([`Powered by ${POWERED_BY.name} — ${POWERED_BY.url}`]).getCell(1).font = {
    size: 9,
    color: { argb: 'FF8A9A95' },
  };

  return { buffer: await wb.xlsx.writeBuffer(), filename: 'Mark_Submissions.xlsx' };
}

/* ------------------------------------------------------------------- pdf -- */

const PAGE = { margin: 40, width: 595.28, height: 841.89 }; // A4 portrait

/**
 * Stream a submission as a PDF. pdfkit is used rather than a headless browser
 * so report generation has no Chrome dependency.
 */
function streamPdf(data, { schoolName, res }) {
  const s = data.submission;
  const secLabel = componentLabel(s.secondary_component);

  const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${reportFilename(data, 'pdf')}"`);
  doc.pipe(res);

  const left = PAGE.margin;
  const right = PAGE.width - PAGE.margin;
  const usable = right - left;

  /* ---- crest + title ---- */
  const CREST = 46;
  let titleTop = PAGE.margin;

  if (LOGO_PATH) {
    // Crest centred above the school name.
    doc.image(LOGO_PATH, left + usable / 2 - CREST / 2, titleTop, {
      fit: [CREST, CREST],
      align: 'center',
    });
    titleTop += CREST + 8;
  }

  doc.font(FONT.bold).fontSize(15).fillColor(BRAND_PDF).text(schoolName, left, titleTop, {
    width: usable,
    align: 'center',
  });
  doc.font(FONT.regular).fontSize(9.5).fillColor(MUTED_PDF).text(
    `${s.subject_name} — ${termLabel(s.term)} — Unit Test & ${secLabel} Marks`,
    { width: usable, align: 'center' }
  );
  doc.moveDown(0.8);

  /* ---- metadata box ---- */
  const pairs = headerPairs(data, schoolName);
  const boxTop = doc.y;
  const lineH = 14;
  const rowsOfTwo = Math.ceil(pairs.length / 2);
  const boxH = rowsOfTwo * lineH + 12;

  doc.roundedRect(left, boxTop, usable, boxH, 5).fillAndStroke('#f1f7f5', '#b9d7d0');

  for (let i = 0; i < pairs.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = left + 10 + col * (usable / 2);
    const y = boxTop + 6 + row * lineH;
    doc.font(FONT.bold).fontSize(8).fillColor('#245247').text(`${pairs[i][0]}: `, x, y, { continued: true });
    doc.font(FONT.regular).fontSize(8).fillColor(INK_PDF).text(String(pairs[i][1] ?? ''));
  }

  doc.y = boxTop + boxH + 14;

  /* ---- table ---- */
  const cols = [
    { key: 'index', label: 'Sl.', w: 26, align: 'center' },
    { key: 'rollNo', label: 'Roll', w: 32, align: 'center' },
    { key: 'admissionNo', label: 'Adm. No.', w: 62, align: 'center' },
    { key: 'name', label: 'Student Name', w: usable - 26 - 32 - 62 - 62 - 66 - 50 - 44, align: 'left' },
    { key: 'unitTest', label: `Unit Test\n(${fmt(data.unitMax)})`, w: 62, align: 'center' },
    { key: 'secondary', label: `${secLabel}\n(${fmt(data.secMax)})`, w: 66, align: 'center' },
    { key: 'total', label: `Total\n(${fmt(data.totalMax)})`, w: 50, align: 'center' },
    { key: 'percent', label: '%', w: 44, align: 'center' },
  ];

  const rowH = 16;
  const headH = 24;

  function drawHeader(y) {
    doc.rect(left, y, usable, headH).fill(`#${BRAND_LIGHT}`);
    let x = left;
    doc.font(FONT.bold).fontSize(7.5).fillColor(BRAND_PDF);
    for (const c of cols) {
      doc.text(c.label, x + 3, y + 5, { width: c.w - 6, align: c.align, lineGap: -1 });
      x += c.w;
    }
    // rules
    doc.strokeColor('#b9d7d0').lineWidth(0.6)
      .moveTo(left, y).lineTo(right, y).stroke()
      .moveTo(left, y + headH).lineTo(right, y + headH).stroke();
    return y + headH;
  }

  function cellText(st, key) {
    if (key === 'unitTest') return st.unitTest === null ? 'AB' : fmt(st.unitTest);
    if (key === 'secondary') return st.secondary === null ? 'AB' : fmt(st.secondary);
    if (key === 'total') return st.total === null ? '—' : fmt(st.total);
    if (key === 'percent') return st.percent === null ? '—' : `${st.percent.toFixed(1)}%`;
    return String(st[key] ?? '');
  }

  let y = drawHeader(doc.y);

  for (const st of data.students) {
    // New page when the next row would cross the bottom margin.
    if (y + rowH > PAGE.height - PAGE.margin - 40) {
      doc.addPage();
      y = drawHeader(PAGE.margin);
    }

    let x = left;
    doc.font(FONT.regular).fontSize(8).fillColor(st.absent ? '#8a9a95' : INK_PDF);
    for (const c of cols) {
      doc.text(cellText(st, c.key), x + 3, y + 4.5, { width: c.w - 6, align: c.align, ellipsis: true, lineBreak: false });
      x += c.w;
    }
    doc.strokeColor('#edf3f1').lineWidth(0.4).moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
    y += rowH;
  }

  /* ---- totals ---- */
  const t = data.totals;
  if (y + rowH + 6 > PAGE.height - PAGE.margin - 40) {
    doc.addPage();
    y = PAGE.margin;
  }
  doc.rect(left, y, usable, rowH + 4).fill('#eef4f2');
  doc.strokeColor('#b9d7d0').lineWidth(0.6).moveTo(left, y).lineTo(right, y).stroke();

  let tx = left;
  doc.font(FONT.bold).fontSize(8).fillColor(INK_PDF);
  const totalsByKey = {
    name: `Total (${t.counted} assessed, ${t.absent} absent)`,
    unitTest: t.unitTest === null ? '' : fmt(t.unitTest),
    secondary: t.secondary === null ? '' : fmt(t.secondary),
    total: t.total === null ? '' : fmt(t.total),
    percent: t.averagePercent === null ? '' : `${t.averagePercent.toFixed(1)}%`,
  };
  for (const c of cols) {
    const text = totalsByKey[c.key] ?? '';
    if (text) doc.text(text, tx + 3, y + 6, { width: c.w - 6, align: c.align, lineBreak: false });
    tx += c.w;
  }
  y += rowH + 4;

  doc.font(FONT.regular).fontSize(7.5).fillColor('#8a9a95')
    .text('AB = absent / not assessed. Average % is the mean of assessed students.', left, y + 8, { width: usable });

  /* ---- per-page footer: required "Powered by Daniel" credit ---- */
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = PAGE.height - PAGE.margin + 6;
    doc.font(FONT.regular).fontSize(7.5).fillColor('#8a9a95');
    doc.text(`Powered by ${POWERED_BY.name} — ${POWERED_BY.url}`, left, fy, {
      width: usable / 2,
      align: 'left',
      lineBreak: false,
    });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + usable / 2, fy, {
      width: usable / 2,
      align: 'right',
      lineBreak: false,
    });
  }

  doc.end();
}

module.exports = { buildExcel, buildSubmissionsExcel, streamPdf, reportFilename };
