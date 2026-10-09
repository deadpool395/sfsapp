'use strict';
/**
 * Subjects, including each subject's second assessed component.
 * Computer is assessed on a practical rather than an assignment.
 */

const express = require('express');
const db = require('../../db/pool');
const audit = require('../../lib/audit');
const { isSecondaryComponent, componentLabel } = require('../../lib/terms');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const subjects = await db.many(`
      SELECT s.*,
             (SELECT count(*)::int FROM mark_submissions ms WHERE ms.subject_id = s.id) AS submission_count
        FROM subjects s
       ORDER BY s.name
    `);
    return res.render('admin/subjects', { title: 'Subjects', subjects });
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const component = isSecondaryComponent(req.body.secondary_component)
      ? req.body.secondary_component
      : 'assignment';

    if (!name) {
      req.flash('error', 'Enter a subject name.');
      return res.redirect('/admin/subjects');
    }

    const existing = await db.one('SELECT id FROM subjects WHERE lower(name) = lower($1)', [name]);
    if (existing) {
      req.flash('error', `"${name}" already exists.`);
      return res.redirect('/admin/subjects');
    }

    await db.query(
      'INSERT INTO subjects (name, code, secondary_component) VALUES ($1, $2, $3)',
      [name, String(req.body.code || '').trim() || null, component]
    );
    req.flash('success', `Added ${name} (second component: ${componentLabel(component)}).`);
    return res.redirect('/admin/subjects');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)', async (req, res, next) => {
  try {
    const subject = await db.one('SELECT * FROM subjects WHERE id = $1', [req.params.id]);
    if (!subject) {
      req.flash('error', 'That subject no longer exists.');
      return res.redirect('/admin/subjects');
    }

    const name = String(req.body.name || '').trim() || subject.name;
    const component = isSecondaryComponent(req.body.secondary_component)
      ? req.body.secondary_component
      : subject.secondary_component;

    await db.query(
      `UPDATE subjects SET name = $1, code = $2, secondary_component = $3, is_active = $4
        WHERE id = $5`,
      [
        name,
        String(req.body.code || '').trim() || null,
        component,
        req.body.is_active === 'on',
        subject.id,
      ]
    );

    if (component !== subject.secondary_component) {
      await audit.log({
        actor: req.session.user,
        action: 'subject.component_change',
        entity: 'subject',
        entityId: subject.id,
        details: { from: subject.secondary_component, to: component },
      });
      req.flash(
        'success',
        `${name} now uses <strong>${componentLabel(component)}</strong> as its second component. ` +
          'Marks already submitted keep the label they were entered under.'
      );
    } else {
      req.flash('success', `${name} updated.`);
    }

    return res.redirect('/admin/subjects');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const used = await db.one(
      'SELECT count(*)::int AS n FROM mark_submissions WHERE subject_id = $1',
      [req.params.id]
    );
    if (used.n) {
      req.flash('error', `That subject has ${used.n} mark submission(s) and cannot be deleted. Deactivate it instead.`);
      return res.redirect('/admin/subjects');
    }

    await db.query('DELETE FROM subjects WHERE id = $1', [req.params.id]);
    req.flash('success', 'Subject deleted.');
    return res.redirect('/admin/subjects');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
