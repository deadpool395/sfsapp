'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const PgSession = require('connect-pg-simple')(session);

const { pool } = require('./src/db/pool');
const settingsStore = require('./src/lib/settings');
const { EXTERNAL_LINKS, POWERED_BY } = require('./src/lib/constants');
const { formatClassLabel } = require('./src/lib/classes');
const { termLabel, componentLabel, TERMS } = require('./src/lib/terms');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

/* ----------------------------------------------------------------- views -- */

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');
app.set('layout extractScripts', true);

/* ------------------------------------------------------------ middleware -- */

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
// School crest lives in ./logo so it can be replaced without touching public/.
app.use('/logo', express.static(path.join(__dirname, 'logo'), { maxAge: '1d' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

app.use(
  session({
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    name: 'sfs.sid',
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 10, // a school day
    },
  })
);

// Minimal flash messages over the session.
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;

  // Survives a redirect — shown on the NEXT request (post/redirect/get).
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };

  // Shown by the render happening in THIS request, for handlers that
  // re-render in place rather than redirecting (e.g. a failed login).
  res.flashNow = (type, message) => {
    res.locals.flash = [...res.locals.flash, { type, message }];
  };

  next();
});

// Shared view locals.
app.use(async (req, res, next) => {
  try {
    const settings = await settingsStore.all();
    res.locals.user = req.session.user || null;
    res.locals.settings = settings;
    res.locals.schoolName = settings.school_name || process.env.SCHOOL_NAME || 'St. Francis School';
    res.locals.externalLinks = EXTERNAL_LINKS;
    res.locals.poweredBy = POWERED_BY;
    res.locals.currentPath = req.path;
    res.locals.TERMS = TERMS;

    // Formatting helpers used across views.
    res.locals.formatClassLabel = formatClassLabel;
    res.locals.termLabel = termLabel;
    res.locals.componentLabel = componentLabel;
    res.locals.fmtMark = (v) => (v === null || v === undefined || v === '' ? '—' : trimZeros(v));
    res.locals.fmtDateTime = (d) =>
      d
        ? new Date(d).toLocaleString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '—';
    res.locals.title = null;
    next();
  } catch (err) {
    next(err);
  }
});

/** 18.00 -> "18", 18.50 -> "18.5" */
function trimZeros(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(Number(n.toFixed(2)));
}

/* ---------------------------------------------------------------- routes -- */

app.use('/', require('./src/routes/auth'));
app.use('/teacher', require('./src/routes/teacher'));
app.use('/admin', require('./src/routes/admin'));

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ------------------------------------------------------------ error pages -- */

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page not found',
    status: 404,
    heading: 'Page not found',
    message: 'That page does not exist. Use the navigation above to get back on track.',
  });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  const status = err.status || 500;
  res.status(status).render('error', {
    title: 'Something went wrong',
    status,
    heading: 'Something went wrong',
    message:
      process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred. Please try again.'
        : err.message,
  });
});

/* ----------------------------------------------------------------- start -- */

const server = app.listen(PORT, () => {
  console.log(`SFS portal running at http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}

module.exports = app;
