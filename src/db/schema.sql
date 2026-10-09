-- SFS School Portal schema (PostgreSQL 18)
-- Applied by `npm run db:migrate`. Safe to re-run.

/* ------------------------------------------------------------ academics --- */

CREATE TABLE IF NOT EXISTS academic_years (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,          -- '2026-2027'
  start_date  DATE,
  end_date    DATE,
  is_active   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active year at a time.
CREATE UNIQUE INDEX IF NOT EXISTS academic_years_one_active
  ON academic_years ((is_active)) WHERE is_active;

CREATE TABLE IF NOT EXISTS classes (
  id               SERIAL PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,                -- 'LKG', 'I', 'XI'
  division         TEXT    NOT NULL DEFAULT '',     -- 'A'..'E', or 'Science'/'Commerce'
  sort_order       INTEGER NOT NULL DEFAULT 999,    -- keeps LKG < UKG < I < II < ... < XII
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (academic_year_id, name, division)
);

CREATE INDEX IF NOT EXISTS classes_year_idx ON classes (academic_year_id, sort_order, division);

CREATE TABLE IF NOT EXISTS subjects (
  id         SERIAL PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  code       TEXT    UNIQUE,
  -- The second assessed component. Computer is marked on a practical instead
  -- of an assignment; any subject can be designated the same way by an admin.
  secondary_component TEXT NOT NULL DEFAULT 'assignment'
    CHECK (secondary_component IN ('assignment', 'practical')),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teachers (
  id            SERIAL PRIMARY KEY,
  name          TEXT    NOT NULL,
  employee_code TEXT    UNIQUE,
  email         TEXT,
  phone         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS teachers_active_idx ON teachers (is_active, name);

/* -------------------------------------------------------------- students --- */

CREATE TABLE IF NOT EXISTS students (
  id               SERIAL PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  class_id         INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  admission_no     TEXT,
  roll_no          TEXT,
  full_name        TEXT    NOT NULL,
  gender           TEXT,
  dob              DATE,
  guardian_name    TEXT,
  contact          TEXT,
  -- Columns present in an uploaded sheet but not mapped to a field above are
  -- kept here rather than discarded (e.g. the source 'SNo').
  extra            JSONB   NOT NULL DEFAULT '{}'::jsonb,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admission number is the import key, unique within an academic year. Students
-- without one are still allowed, so the index is partial.
CREATE UNIQUE INDEX IF NOT EXISTS students_year_admission_no
  ON students (academic_year_id, admission_no)
  WHERE admission_no IS NOT NULL AND admission_no <> '';

CREATE INDEX IF NOT EXISTS students_class_idx ON students (class_id, full_name);
CREATE INDEX IF NOT EXISTS students_year_idx  ON students (academic_year_id);

/* ----------------------------------------------------------------- auth --- */

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row-per-key settings store: shared teacher credentials and the
-- default maximum marks.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- express-session store (connect-pg-simple).
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess   JSON    NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);

/* ---------------------------------------------------------------- marks --- */

CREATE TABLE IF NOT EXISTS mark_submissions (
  id                  SERIAL PRIMARY KEY,
  academic_year_id    INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  class_id            INTEGER NOT NULL REFERENCES classes(id)        ON DELETE CASCADE,
  subject_id          INTEGER NOT NULL REFERENCES subjects(id)       ON DELETE RESTRICT,
  term                TEXT    NOT NULL CHECK (term IN ('term1', 'term2', 'term3')),
  teacher_id          INTEGER NOT NULL REFERENCES teachers(id)       ON DELETE RESTRICT,
  -- Snapshotted at submission time so that later changes to a subject's
  -- component type or to the default maxima cannot reinterpret old marks.
  unit_test_max       NUMERIC(6,2) NOT NULL,
  secondary_max       NUMERIC(6,2) NOT NULL,
  secondary_component TEXT    NOT NULL
    CHECK (secondary_component IN ('assignment', 'practical')),
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ,
  updated_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,

  -- The duplicate-entry guard. A teacher cannot submit the same
  -- class/subject/term twice; only an admin can edit or release a submission.
  UNIQUE (academic_year_id, class_id, subject_id, term)
);

CREATE INDEX IF NOT EXISTS mark_submissions_teacher_idx
  ON mark_submissions (teacher_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS mark_submissions_lookup_idx
  ON mark_submissions (academic_year_id, class_id, term);

CREATE TABLE IF NOT EXISTS marks (
  id             SERIAL PRIMARY KEY,
  submission_id  INTEGER NOT NULL REFERENCES mark_submissions(id) ON DELETE CASCADE,
  student_id     INTEGER NOT NULL REFERENCES students(id)         ON DELETE CASCADE,
  -- NULL means absent / not assessed, which is distinct from a zero.
  unit_test_mark NUMERIC(6,2),
  secondary_mark NUMERIC(6,2),
  remarks        TEXT,
  UNIQUE (submission_id, student_id)
);

CREATE INDEX IF NOT EXISTS marks_student_idx ON marks (student_id);

/* ----------------------------------------------------------- audit/imports - */

CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL,          -- 'admin' | 'teacher' | 'system'
  actor_id   INTEGER,
  actor_name TEXT,
  action     TEXT NOT NULL,          -- 'mark.update', 'submission.release', ...
  entity     TEXT,
  entity_id  INTEGER,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_recent_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, entity_id);

CREATE TABLE IF NOT EXISTS import_batches (
  id               SERIAL PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  filename         TEXT,
  sheet_name       TEXT,
  row_count        INTEGER NOT NULL DEFAULT 0,
  inserted         INTEGER NOT NULL DEFAULT 0,
  updated          INTEGER NOT NULL DEFAULT 0,
  skipped          INTEGER NOT NULL DEFAULT 0,
  mapping          JSONB   NOT NULL DEFAULT '{}'::jsonb,
  errors           JSONB   NOT NULL DEFAULT '[]'::jsonb,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
