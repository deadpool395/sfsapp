'use strict';
/**
 * Render sample Excel and PDF reports to ./temporary screenshots/ without
 * touching the database — used to eyeball branding and fonts.
 *
 *   node scripts/preview-report.js
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const reports = require('../src/services/reports');
const { buildReportData } = require('../src/services/marks');

const NAMES = [
  'AARON SARATH', 'ABELIN K BYJU', 'ADARVA AVINASH', 'ADHITHI AJEESH',
  'ADHVIKA VYSAKH', 'AIDEN M JITHIN', 'ALOK S', 'ANIRUDH S',
  'DAVID SEBASTIAN', 'RITHVI R', 'SANVI S', 'VIHAAN S',
];

const submission = {
  id: 0,
  year_name: '2026-2027',
  class_name: 'V',
  class_division: 'A',
  subject_name: 'Computer',
  term: 'term1',
  teacher_name: 'Mrs. Lakshmi Nair',
  secondary_component: 'practical',
  unit_test_max: 25,
  secondary_max: 20,
  submitted_at: new Date(),
  updated_at: null,
  updated_by_admin: null,
};

const markRows = NAMES.map((full_name, i) => ({
  student_id: i + 1,
  full_name,
  roll_no: String(i + 1),
  admission_no: String(265960 + i),
  // one absent student, to exercise the AB rendering
  unit_test_mark: i === 3 ? null : 17 + (i % 7),
  secondary_mark: i === 3 ? null : 12 + (i % 6),
}));

async function main() {
  const data = buildReportData(submission, markRows);
  const outDir = path.join(__dirname, '..', 'temporary screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  const schoolName = process.env.SCHOOL_NAME || 'St. Francis School';

  const { buffer, filename } = await reports.buildExcel(data, { schoolName });
  const xlsxPath = path.join(outDir, 'sample-report.xlsx');
  fs.writeFileSync(xlsxPath, Buffer.from(buffer));
  console.log(`excel : ${path.relative(process.cwd(), xlsxPath)}  (${Buffer.from(buffer).length} bytes, would download as ${filename})`);

  // streamPdf pipes into a response; a file stream with a no-op setHeader
  // satisfies the same contract.
  const pdfPath = path.join(outDir, 'sample-report.pdf');
  const out = fs.createWriteStream(pdfPath);
  out.setHeader = () => {};
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    reports.streamPdf(data, { schoolName, res: out });
  });
  console.log(`pdf   : ${path.relative(process.cwd(), pdfPath)}  (${fs.statSync(pdfPath).size} bytes)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
