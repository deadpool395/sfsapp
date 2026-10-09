'use strict';
/** Student records plus the Excel import (upload -> map -> preview -> commit). */

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');

const db = require('../../db/pool');
const importer = require('../../services/excelImport');
const { formatClassLabel } = require('../../lib/classes');
const { POWERED_BY } = require('../../lib/constants');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xlsm)$/i.test(file.originalname)) return cb(null, true);
    return cb(Object.assign(new Error('Upload an .xlsx file (Excel 2007 or newer).'), { status: 400 }));
  },
});

const PAGE_SIZE = 50;

async function yearList() {
  return db.many('SELECT * FROM academic_years ORDER BY name DESC');
}

async function resolveYear(value) {
  if (value) {
    const found = await db.one('SELECT * FROM academic_years WHERE id = $1', [value]);
    if (found) return found;
  }
  return (
    (await db.one('SELECT * FROM academic_years WHERE is_active LIMIT 1')) ||
    (await db.one('SELECT * FROM academic_years ORDER BY name DESC LIMIT 1'))
  );
}

/* ------------------------------------------------------------------- list -- */

router.get('/', async (req, res, next) => {
  try {
    const years = await yearList();
    const year = await resolveYear(req.query.year);
    if (!year) {
      return res.render('admin/students', {
        title: 'Students',
        wide: true,
        years,
        year: null,
        classes: [],
        students: [],
        total: 0,
        page: 1,
        pageCount: 1,
        filters: { class: '', q: '', inactive: '' },
      });
    }

    const classes = await db.many(
      `SELECT * FROM classes WHERE academic_year_id = $1 ORDER BY sort_order, name, division`,
      [year.id]
    );

    const where = ['st.academic_year_id = $1'];
    const params = [year.id];

    if (req.query.class) {
      params.push(req.query.class);
      where.push(`st.class_id = $${params.length}`);
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      params.push(`%${q}%`);
      where.push(`(st.full_name ILIKE $${params.length} OR st.admission_no ILIKE $${params.length})`);
    }
    if (req.query.inactive !== 'on') where.push('st.is_active');

    const whereSql = where.join(' AND ');
    const { n: total } = await db.one(
      `SELECT count(*)::int AS n FROM students st WHERE ${whereSql}`,
      params
    );

    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(Math.max(1, Number(req.query.page) || 1), pageCount);

    const students = await db.many(
      `SELECT st.*, c.name AS class_name, c.division AS class_division
         FROM students st
         LEFT JOIN classes c ON c.id = st.class_id
        WHERE ${whereSql}
        ORDER BY c.sort_order NULLS LAST, c.division, st.full_name
        LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params
    );

    return res.render('admin/students', {
      title: 'Students',
      wide: true,
      years,
      year,
      classes,
      students,
      total,
      page,
      pageCount,
      filters: { class: req.query.class || '', q, inactive: req.query.inactive || '' },
    });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------ manual CRUD -- */

router.post('/', async (req, res, next) => {
  try {
    const year = await resolveYear(req.body.year);
    const fullName = String(req.body.full_name || '').replace(/\s+/g, ' ').trim();
    if (!year || !fullName) {
      req.flash('error', 'A student needs at least a name and an academic year.');
      return res.redirect('/admin/students');
    }

    await db.query(
      `INSERT INTO students
         (academic_year_id, class_id, admission_no, roll_no, full_name, gender, dob, guardian_name, contact)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        year.id,
        req.body.class_id || null,
        String(req.body.admission_no || '').trim() || null,
        String(req.body.roll_no || '').trim() || null,
        fullName,
        String(req.body.gender || '').trim() || null,
        req.body.dob || null,
        String(req.body.guardian_name || '').trim() || null,
        String(req.body.contact || '').trim() || null,
      ]
    );
    req.flash('success', `Added ${fullName}.`);
    return res.redirect(`/admin/students?year=${year.id}`);
  } catch (err) {
    if (err.code === '23505') {
      req.flash('error', 'A student with that admission number already exists in this academic year.');
      return res.redirect('/admin/students');
    }
    return next(err);
  }
});

// `(\\d+)` keeps these from shadowing literal routes such as POST /import.
router.post('/:id(\\d+)', async (req, res, next) => {
  try {
    const student = await db.one('SELECT * FROM students WHERE id = $1', [req.params.id]);
    if (!student) {
      req.flash('error', 'That student no longer exists.');
      return res.redirect('/admin/students');
    }

    await db.query(
      `UPDATE students
          SET class_id = $1, admission_no = $2, roll_no = $3, full_name = $4,
              gender = $5, dob = $6, guardian_name = $7, contact = $8,
              is_active = $9, updated_at = now()
        WHERE id = $10`,
      [
        req.body.class_id || null,
        String(req.body.admission_no || '').trim() || null,
        String(req.body.roll_no || '').trim() || null,
        String(req.body.full_name || '').replace(/\s+/g, ' ').trim() || student.full_name,
        String(req.body.gender || '').trim() || null,
        req.body.dob || null,
        String(req.body.guardian_name || '').trim() || null,
        String(req.body.contact || '').trim() || null,
        req.body.is_active === 'on',
        student.id,
      ]
    );
    req.flash('success', 'Student updated.');
    return res.redirect(`/admin/students?year=${student.academic_year_id}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const student = await db.one('SELECT * FROM students WHERE id = $1', [req.params.id]);
    if (!student) {
      req.flash('error', 'That student no longer exists.');
      return res.redirect('/admin/students');
    }

    const used = await db.one('SELECT count(*)::int AS n FROM marks WHERE student_id = $1', [student.id]);
    if (used.n) {
      await db.query('UPDATE students SET is_active = FALSE, updated_at = now() WHERE id = $1', [student.id]);
      req.flash(
        'success',
        `${student.full_name} has ${used.n} mark record(s), so they were marked inactive rather than deleted.`
      );
    } else {
      await db.query('DELETE FROM students WHERE id = $1', [student.id]);
      req.flash('success', `${student.full_name} removed.`);
    }
    return res.redirect(`/admin/students?year=${student.academic_year_id}`);
  } catch (err) {
    return next(err);
  }
});

/* ----------------------------------------------------------------- export -- */

router.get('/export', async (req, res, next) => {
  try {
    const year = await resolveYear(req.query.year);
    if (!year) {
      req.flash('error', 'No academic year to export.');
      return res.redirect('/admin/students');
    }

    const students = await db.many(
      `SELECT st.*, c.name AS class_name, c.division AS class_division
         FROM students st LEFT JOIN classes c ON c.id = st.class_id
        WHERE st.academic_year_id = $1
        ORDER BY c.sort_order NULLS LAST, c.division, st.full_name`,
      [year.id]
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Students');
    ws.columns = [
      { header: 'SNo', key: 'sno', width: 7 },
      { header: 'Name', key: 'name', width: 34 },
      { header: 'Admission Number', key: 'adm', width: 20 },
      { header: 'Class', key: 'cls', width: 14 },
      { header: 'Roll No', key: 'roll', width: 10 },
      { header: 'Gender', key: 'gender', width: 10 },
      { header: 'Date of Birth', key: 'dob', width: 14 },
      { header: 'Guardian Name', key: 'guardian', width: 26 },
      { header: 'Contact', key: 'contact', width: 16 },
      { header: 'Active', key: 'active', width: 9 },
    ];
    ws.getRow(1).eachCell((cell) => {
      cell.font = { name: 'Montserrat', bold: true, color: { argb: 'FF2C6559' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEBE7' } };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    students.forEach((s, i) => {
      const row = ws.addRow({
        sno: i + 1,
        name: s.full_name,
        adm: s.admission_no || '',
        cls: formatClassLabel({ name: s.class_name, division: s.class_division }),
        roll: s.roll_no || '',
        gender: s.gender || '',
        dob: s.dob ? new Date(s.dob).toISOString().slice(0, 10) : '',
        guardian: s.guardian_name || '',
        contact: s.contact || '',
        active: s.is_active ? 'Yes' : 'No',
      });
      row.eachCell((cell) => { cell.font = { name: 'Montserrat', size: 10 }; });
    });

    ws.addRow([]);
    ws.addRow([`Powered by ${POWERED_BY.name} — ${POWERED_BY.url}`]).getCell(1).font = {
      size: 9,
      color: { argb: 'FF8A9A95' },
    };

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Students_${year.name}.xlsx"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return next(err);
  }
});

router.get('/template', async (req, res, next) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Students');
    ws.columns = [
      { header: 'SNo', width: 7 },
      { header: 'Name', width: 34 },
      { header: 'Admission Number', width: 20 },
      { header: 'Class', width: 14 },
    ];
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FF2C6559' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEBE7' } };
    });
    ws.addRow([1, 'AARON SARATH', '265968', 'LKG A']);
    ws.addRow([2, 'RIYA SUSAN', '265970', 'I B']);
    ws.addRow([3, 'ANAND KRISHNA', '265971', 'XI Science']);

    const note = ws.addRow([]);
    ws.addRow(['Class may be combined ("LKG A", "XI Science") — the importer splits it.']).getCell(1).font = {
      italic: true,
      size: 9,
      color: { argb: 'FF8A9A95' },
    };
    void note;

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Student_Import_Template.xlsx"');
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return next(err);
  }
});

/* ----------------------------------------------------------------- import -- */

router.get('/import', async (req, res, next) => {
  try {
    const years = await yearList();
    const year = await resolveYear(req.query.year);
    const batches = await db.many(
      `SELECT b.*, ay.name AS year_name
         FROM import_batches b JOIN academic_years ay ON ay.id = b.academic_year_id
        ORDER BY b.created_at DESC LIMIT 10`
    );
    return res.render('admin/import-upload', { title: 'Import Students', years, year, batches });
  } catch (err) {
    return next(err);
  }
});

router.post('/import', upload.single('file'), async (req, res, next) => {
  try {
    const year = await resolveYear(req.body.year);
    if (!year) {
      req.flash('error', 'Create an academic year before importing students.');
      return res.redirect('/admin/years');
    }
    if (!req.file) {
      req.flash('error', 'Choose an .xlsx file to upload.');
      return res.redirect('/admin/students/import');
    }

    const parsed = await importer.parseWorkbook(req.file.buffer);
    const token = importer.stash({
      parsed,
      filename: req.file.originalname,
      yearId: year.id,
      mapping: importer.suggestMapping(parsed.columns),
    });

    return res.redirect(`/admin/students/import/${token}`);
  } catch (err) {
    if (err.status === 400) {
      req.flash('error', err.message);
      return res.redirect('/admin/students/import');
    }
    return next(err);
  }
});

/** Mapping + preview screen. */
router.get('/import/:token', async (req, res, next) => {
  try {
    const staged = importer.peek(req.params.token);
    if (!staged) {
      req.flash('error', 'That upload has expired. Please upload the file again.');
      return res.redirect('/admin/students/import');
    }

    const year = await resolveYear(staged.yearId);
    const mapping = staged.mapping || importer.suggestMapping(staged.parsed.columns);
    const preview = importer.buildPreview({ ...staged.parsed, mapping });
    const classes = await importer.classPlan({ rows: staged.parsed.rows, mapping, yearId: year.id });

    return res.render('admin/import-map', {
      title: 'Map Columns',
      wide: true,
      token: req.params.token,
      staged,
      year,
      fields: importer.FIELDS,
      mapping,
      preview,
      classes,
    });
  } catch (err) {
    return next(err);
  }
});

/** Re-render the preview under a changed mapping. */
router.post('/import/:token/preview', async (req, res, next) => {
  try {
    const staged = importer.peek(req.params.token);
    if (!staged) {
      req.flash('error', 'That upload has expired. Please upload the file again.');
      return res.redirect('/admin/students/import');
    }

    staged.mapping = importer.sanitiseMapping(req.body, staged.parsed.columns.length);
    return res.redirect(`/admin/students/import/${req.params.token}`);
  } catch (err) {
    return next(err);
  }
});

router.post('/import/:token/commit', async (req, res, next) => {
  try {
    const staged = importer.peek(req.params.token);
    if (!staged) {
      req.flash('error', 'That upload has expired. Please upload the file again.');
      return res.redirect('/admin/students/import');
    }

    const mapping = importer.sanitiseMapping(req.body, staged.parsed.columns.length);
    if (!Object.values(mapping).includes('full_name')) {
      req.flash('error', 'Map a column to Student Name before importing.');
      staged.mapping = mapping;
      return res.redirect(`/admin/students/import/${req.params.token}`);
    }

    const { stats, errors } = await importer.commitImport({
      yearId: staged.yearId,
      parsed: staged.parsed,
      mapping,
      options: {
        createMissingClasses: req.body.create_classes === 'on',
        deactivateMissing: req.body.deactivate_missing === 'on',
      },
      actor: req.session.user,
      filename: staged.filename,
    });

    importer.discard(req.params.token);

    const year = await resolveYear(staged.yearId);
    return res.render('admin/import-result', {
      title: 'Import Complete',
      wide: true,
      year,
      stats,
      errors,
      filename: staged.filename,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
