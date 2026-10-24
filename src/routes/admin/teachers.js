'use strict';
/** Teacher records. These populate the post-login name dropdown. */

const express = require('express');
const ExcelJS = require('exceljs');

const db = require('../../db/pool');
const importer = require('../../services/teacherImport');
const excel = require('../../services/excelImport');
const { spreadsheetUpload } = require('../../lib/upload');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const teachers = await db.many(`
      SELECT t.*,
             (SELECT count(*)::int FROM mark_submissions s WHERE s.teacher_id = t.id) AS submission_count,
             (SELECT max(s.submitted_at) FROM mark_submissions s WHERE s.teacher_id = t.id) AS last_submission
        FROM teachers t
       ORDER BY t.is_active DESC, t.name
    `);
    return res.render('admin/teachers', { title: 'Teachers', teachers });
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').replace(/\s+/g, ' ').trim();
    if (!name) {
      req.flash('error', 'Enter the teacher’s name.');
      return res.redirect('/admin/teachers');
    }

    const existing = await db.one('SELECT id FROM teachers WHERE lower(name) = lower($1)', [name]);
    if (existing) {
      req.flash('error', `A teacher named "${name}" already exists.`);
      return res.redirect('/admin/teachers');
    }

    await db.query(
      'INSERT INTO teachers (name, employee_code, email, phone) VALUES ($1, $2, $3, $4)',
      [
        name,
        String(req.body.employee_code || '').trim() || null,
        String(req.body.email || '').trim() || null,
        String(req.body.phone || '').trim() || null,
      ]
    );
    req.flash('success', `Added ${name}.`);
    return res.redirect('/admin/teachers');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)', async (req, res, next) => {
  try {
    const teacher = await db.one('SELECT * FROM teachers WHERE id = $1', [req.params.id]);
    if (!teacher) {
      req.flash('error', 'That teacher no longer exists.');
      return res.redirect('/admin/teachers');
    }

    await db.query(
      `UPDATE teachers SET name = $1, employee_code = $2, email = $3, phone = $4, is_active = $5
        WHERE id = $6`,
      [
        String(req.body.name || '').replace(/\s+/g, ' ').trim() || teacher.name,
        String(req.body.employee_code || '').trim() || null,
        String(req.body.email || '').trim() || null,
        String(req.body.phone || '').trim() || null,
        req.body.is_active === 'on',
        teacher.id,
      ]
    );
    req.flash('success', 'Teacher updated.');
    return res.redirect('/admin/teachers');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const used = await db.one(
      'SELECT count(*)::int AS n FROM mark_submissions WHERE teacher_id = $1',
      [req.params.id]
    );
    if (used.n) {
      req.flash(
        'error',
        `That teacher has ${used.n} mark submission(s) on record, so the account is kept for audit. Mark them inactive instead.`
      );
      return res.redirect('/admin/teachers');
    }

    await db.query('DELETE FROM teachers WHERE id = $1', [req.params.id]);
    req.flash('success', 'Teacher removed.');
    return res.redirect('/admin/teachers');
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------- bulk import ----- */
// `POST /:id(\d+)` above is digit-constrained, so these literal paths cannot
// be shadowed by it.

/** Blank spreadsheet in the shape the importer expects. */
router.get('/template', async (req, res, next) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Teachers');
    ws.columns = [
      { header: 'Name', width: 32 },
      { header: 'Staff Code', width: 14 },
      { header: 'Email', width: 28 },
      { header: 'Phone', width: 16 },
    ];
    ws.getRow(1).eachCell((cell) => {
      cell.font = { name: 'Montserrat', bold: true, color: { argb: 'FF2C6559' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEBE7' } };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    // Obviously fictional, so sample rows are never mistaken for real staff.
    ws.addRow(['Mrs. Example Teacher', 'T001', 'example@school.in', '9000000001']);
    ws.addRow(['Mr. Sample Name', 'T002', '', '']);

    ws.addRow([]);
    ws.addRow(['Only Name is required. Delete these example rows before uploading.']).getCell(1).font = {
      name: 'Montserrat', italic: true, size: 9, color: { argb: 'FF8A9A95' },
    };

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Teacher_Import_Template.xlsx"');
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return next(err);
  }
});

router.get('/import', async (req, res, next) => {
  try {
    const counts = await db.one(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_active)::int AS active FROM teachers`
    );
    return res.render('admin/teacher-import-upload', { title: 'Import Teachers', counts });
  } catch (err) {
    return next(err);
  }
});

router.post('/import', spreadsheetUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Choose an .xlsx file to upload.');
      return res.redirect('/admin/teachers/import');
    }

    const parsed = await excel.parseWorkbook(req.file.buffer);
    const token = excel.stash({
      parsed,
      filename: req.file.originalname,
      kind: 'teachers',
      mapping: importer.suggestMapping(parsed.columns),
    });

    return res.redirect(`/admin/teachers/import/${token}`);
  } catch (err) {
    if (err.status === 400) {
      req.flash('error', err.message);
      return res.redirect('/admin/teachers/import');
    }
    return next(err);
  }
});

/** Mapping + preview. */
router.get('/import/:token', async (req, res, next) => {
  try {
    const staged = excel.peek(req.params.token);
    if (!staged || staged.kind !== 'teachers') {
      req.flash('error', 'That upload has expired. Please upload the file again.');
      return res.redirect('/admin/teachers/import');
    }

    const mapping = staged.mapping || importer.suggestMapping(staged.parsed.columns);
    const [preview, plan] = await Promise.all([
      importer.buildPreview({ rows: staged.parsed.rows, mapping }),
      importer.importPlan({ rows: staged.parsed.rows, mapping }),
    ]);

    return res.render('admin/teacher-import-map', {
      title: 'Map Columns',
      wide: true,
      token: req.params.token,
      staged,
      fields: importer.FIELDS,
      mapping,
      preview,
      plan,
    });
  } catch (err) {
    return next(err);
  }
});

/** Re-render the preview under a changed mapping. */
router.post('/import/:token/preview', (req, res, next) => {
  try {
    const staged = excel.peek(req.params.token);
    if (!staged || staged.kind !== 'teachers') {
      req.flash('error', 'That upload has expired. Please upload the file again.');
      return res.redirect('/admin/teachers/import');
    }

    staged.mapping = excel.sanitiseMapping(req.body, staged.parsed.columns.length, importer.FIELD_KEYS);
    return res.redirect(`/admin/teachers/import/${req.params.token}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/import/:token/commit', async (req, res, next) => {
  try {
    const staged = excel.peek(req.params.token);
    if (!staged || staged.kind !== 'teachers') {
      req.flash('error', 'That upload has expired. Please upload the file again.');
      return res.redirect('/admin/teachers/import');
    }

    const mapping = excel.sanitiseMapping(req.body, staged.parsed.columns.length, importer.FIELD_KEYS);
    if (!Object.values(mapping).includes('name')) {
      req.flash('error', 'Map a column to Teacher Name before importing.');
      staged.mapping = mapping;
      return res.redirect(`/admin/teachers/import/${req.params.token}`);
    }

    const { stats, errors, deactivatedNames } = await importer.commitImport({
      parsed: staged.parsed,
      mapping,
      options: { deactivateMissing: req.body.deactivate_missing === 'on' },
      actor: req.session.user,
      filename: staged.filename,
    });

    excel.discard(req.params.token);

    return res.render('admin/teacher-import-result', {
      title: 'Import Complete',
      stats,
      errors,
      deactivatedNames,
      filename: staged.filename,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
