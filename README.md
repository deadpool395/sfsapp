# SFS School Portal

Node.js + PostgreSQL portal for St. Francis School: an admin portal for students,
classes, subjects and teachers, and a teacher area for submitting Assignment /
Unit Test marks.

## Requirements

- Node.js 18+
- PostgreSQL 18

> **Port note:** this machine runs PostgreSQL 13 on the default port **5432** and
> PostgreSQL 18 on **5433**. `.env.example` points at 5433. Check yours with
> `psql -U postgres -h localhost -p 5433 -c "SHOW server_version"`.

## Setup

```bash
npm install
cp .env.example .env        # then set SESSION_SECRET to something random
npm run db:setup            # create database + apply schema + seed
npm start                   # http://localhost:3000
```

`npm run db:setup` runs `db:create`, `db:migrate` and `db:seed` in order. Each is
safe to re-run; `node src/db/migrate.js --drop` rebuilds the schema from scratch.

### Seeded sign-ins — change both in Admin → Settings

| Role | Username | Password |
|---|---|---|
| Administrator | `admin` | `admin123` |
| Teachers (shared) | `teacher` | `sfs2026` |

All teachers share one login and then pick their own name from a dropdown; that
name is what every mark submission is recorded against.

## How it works

### Academic years
Everything — classes, students, marks — hangs off an academic year such as
`2026-2027`, so past years stay intact and queryable.

### Students and the Excel import
Admin → Students → **Import from Excel** takes any `.xlsx` layout:

1. Upload and pick the academic year.
2. The app detects the header row and suggests a target for each column; adjust
   anything it got wrong and preview the first rows.
3. Import. Unmapped columns are kept per student in an `extra` JSON field rather
   than discarded.

The school's sheet is `SNo | Name | Admission Number | Class`, where **Class
combines class and division** — `LKG A`, `VIII C`, `XI Science`. The importer
splits on the first space, so both letter divisions and streams work, and it
creates any missing classes.

Students are matched on **admission number** within the year, so re-importing
the same file updates records instead of duplicating them. (Names are not
unique in the real data — several students share a name — so names are never
used as the key when an admission number is present.)

> The real roster (`student_data.xlsx`) is **not** in this repository: it holds
> pupils' names and admission numbers. `samples/student_data.sample.xlsx` has
> the same four columns with twelve fictional pupils — including a duplicated
> name and both division forms — so the importer can be exercised end to end
> without handling personal data.

### Marks

A teacher picks **year → class → subject → term**, then fills a roster grid.

- Each subject is assessed on a **unit test** plus a second component that is an
  **Assignment** for most subjects and a **Practical** for Computer. This is a
  per-subject setting on Admin → Subjects, not a hardcoded subject name, so any
  subject can be switched to practical from a dropdown.
- A blank box means **absent / not assessed** and is stored as NULL, which is
  different from a zero.
- Marks are validated server-side against the maxima in Admin → Settings;
  the form's values are never trusted.

**Repeat entry is not possible.** A `UNIQUE (academic_year_id, class_id,
subject_id, term)` index on `mark_submissions` enforces it in the database, so
even a replayed POST cannot create a second submission. Teachers see a
read-only view telling them to contact an administrator.

Admins can, from Admin → Marks:
- see who entered what and when, filtered by year/class/subject/term/teacher,
- **correct marks** — audited, with the old and new value of every changed cell,
- **release** a submission, which deletes its marks so a teacher can re-enter
  them; the removed values are preserved in the audit trail.

Each submission **snapshots** its component type and both maxima at submission
time, so later changing a subject's component or the default maxima never
reinterprets marks that were already recorded.

### Reports
Excel (`exceljs`) and PDF (`pdfkit`) exports are available to teachers for their
own submissions and to admins for any submission, both built from one shared
query so the two formats and the on-screen table always agree.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with `--watch` |
| `npm run db:create` | Create the database if missing |
| `npm run db:migrate` | Apply `src/db/schema.sql` (`--drop` to rebuild) |
| `npm run db:seed` | Seed admin, shared login, year, subjects |
| `npm run db:setup` | All three of the above |
| `npm run db:backup` | Copy the local database to `BACKUP_DATABASE_URL` |
| `npm run inspect:xlsx` | Print the structure of `student_data.xlsx` |
| `npm run logo:mark` | Regenerate the small crest used in reports |
| `npm run report:preview` | Render sample Excel/PDF reports (no database needed) |
| `node screenshot.mjs <url> [label] [--admin|--teacher]` | Screenshot a page into `temporary screenshots/` |

### Backups

`npm run db:backup` pipes `pg_dump` into the remote database named by
`BACKUP_DATABASE_URL` (a Render external URL, for example), then compares row
counts table by table and fails if any differ. It uses `--clean --if-exists`,
so running it again replaces the remote contents rather than duplicating rows.

```bash
npm run db:backup            # local -> remote
npm run db:backup -- --dry   # report only, change nothing
npm run db:backup -- --file  # also keep the .sql dump under backups/
```

Both databases must be the same PostgreSQL major version.

## Branding

- **Crest** — `logo/logo.png`, served at `/logo/logo.png`. It appears in the
  masthead, on the sign-in screens, as the favicon, and at the top of PDF and
  Excel reports. Replace the file and the whole app follows; then run
  `npm run logo:mark` to refresh `logo/logo-mark.png`, the downscaled copy
  embedded in reports (the full-resolution original would add ~0.5 MB to every
  exported file).
- **Typeface** — Montserrat throughout. The web UI loads it from Google Fonts;
  PDFs embed `public/fonts/montserrat-400.woff` and `-700.woff`. Those two
  static files exist because Google publishes Montserrat only as a variable
  font and pdfkit does not apply named variations — given the variable file it
  silently renders everything in Thin. If the files are missing, PDFs fall back
  to Helvetica.
- **School name** — edit it in Admin → Settings; it feeds the masthead and
  every report header.

`screenshot.mjs` uses `puppeteer-core` against the system Chrome, so there is no
bundled Chromium download. Set `CHROME_PATH` if your browser is elsewhere.

## Layout

```
server.js              app bootstrap, sessions, view locals, error pages
src/db/                pool, schema.sql, create/migrate/seed
src/lib/               classes (label splitting), terms, settings, audit, mark parsing
src/middleware/        auth guards
src/routes/            auth, teacher/*, admin/*
src/services/          marks (shared queries), excelImport, reports
src/views/             EJS templates; layouts/main.ejs carries the footer
public/css/app.css     design tokens and components
```

Every page carries the required **Powered by Daniel** footer, as do the Excel and
PDF exports.
