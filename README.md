# RenalCare

Clinic management app for a kidney-care clinic. Four roles share one patient record:

| Role | Can do |
|---|---|
| **Patient** | Registers themselves, sees only their own consultations, tests, results, care plans and bills |
| **Doctor** | Registers patients, books consultations, orders urine tests, records results, writes care plans |
| **Chemist** | Dispenses care plans, logs payments |
| **Admin** | Adds / edits / deletes doctors, chemists and patients, resets passwords |

Everything is stored in **PostgreSQL**. When someone registers, a row is written to the `patients` and
`users` tables before the screen changes – nothing lives only in the browser.

Built with Node + Express, PostgreSQL (`pg`), bcrypt password hashing, JWT login. The UI is a single page (`public/index.html`).

---

## Run it on your computer

You need **Node.js 18+** and **PostgreSQL** installed and running.

1. Copy `.env.example` to a new file called `.env` and put your PostgreSQL password in `PGPASSWORD`
   (also set `JWT_SECRET` to any long random text).
2. In this folder:
   ```bash
   npm install
   npm start
   ```
3. Open <http://localhost:3000>

On first start the app creates the `renalcare` database (if your PostgreSQL user is allowed to),
creates the tables from `db/schema.sql`, and adds the admin account plus demo data.
If it can't create the database, run `CREATE DATABASE renalcare;` once in pgAdmin or psql.

**Demo logins** (first run only, with demo data): the login page has one-click buttons. They are
`admin / admin123`, `drsameer / doctor123`, `priya / chemist123`, `rohan / patient123`.

### Check that registrations really reach the database

Register a patient in the app, then in pgAdmin or psql:

```sql
SELECT patient_id, name, email, created_at FROM patients ORDER BY patient_id DESC LIMIT 5;
SELECT username, role, ref_id FROM users ORDER BY user_id DESC LIMIT 5;
```

Or run the automated check (server must be running): `npm run smoke`
It registers a patient, reads it back, logs in, confirms the admin can see it, then cleans up.

---

## Put it online (GitHub + hosting)

**GitHub Pages cannot run this app** – it only serves static files, and this app needs a Node server and a database.
The usual setup is: code on GitHub → a host builds and runs it from the repo.

### Option A – Render (config included in `render.yaml`)

1. Create a new empty repo on GitHub, then in this folder:
   ```bash
   git init
   git add .
   git commit -m "RenalCare"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
   (`.env` is git-ignored, so your passwords are not uploaded.)
2. On [render.com](https://render.com): **New → Blueprint**, pick the repo, approve. It creates the web app and a PostgreSQL database and wires them together.
3. When it's live, open the `renalcare` service → **Environment** and read `ADMIN_PASSWORD`. Log in as `admin` with it.
   (`SEED_DEMO` is `false` there, so no demo accounts are created.)

> ⚠️ **Render's free PostgreSQL expires 30 days after creation** (then data is deleted after a 14-day grace period), and the free web service sleeps after 15 minutes idle (~1 minute to wake).
> Fine for a demo. For data you want to keep, upgrade the database plan in `render.yaml`, or use a permanent hosted
> PostgreSQL (Neon, Supabase, Railway…) – create the database there, set its connection string as `DATABASE_URL` on the web service, and delete the `databases:` block in `render.yaml`.

### Option B – any other Node host (Railway, Fly.io, a VPS…)

Set these environment variables: `DATABASE_URL`, `JWT_SECRET` (long random), `NODE_ENV=production`, optionally `ADMIN_PASSWORD`, `SEED_DEMO=false`. Start command: `npm start`. Health check: `/api/health`.

Every push to GitHub also runs `.github/workflows/ci.yml`, which boots the app against a real PostgreSQL and runs the smoke test.

---

## Settings (`.env` / environment variables)

| Variable | Meaning |
|---|---|
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | Local PostgreSQL connection |
| `DATABASE_URL` | Hosted PostgreSQL connection string (used instead of the `PG*` values; SSL turns on automatically) |
| `JWT_SECRET` | Signs login tokens. **Required (16+ chars) when `NODE_ENV=production`** |
| `PORT` | Default `3000` |
| `SEED_DEMO` | `false` = first start creates only the admin account |
| `ADMIN_PASSWORD` | Password for the first `admin` login. If blank in production, a random one is printed once in the server log |
| `ALLOW_SIGNUP` | `false` turns off public patient registration |

## Before using real patient data

This is a solid learning/demo project, **not** a certified medical system. Before real patients use it: keep `SEED_DEMO=false`,
change the admin password, serve it over HTTPS (hosts do this for you), use a paid database with backups, and check the privacy
rules that apply where you operate (e.g. DPDP Act in India, HIPAA in the US).

## Project layout

```
server.js           API + auth + role rules + first-run setup
db/schema.sql       all tables (safe to re-run)
db/demo-data.js     demo patients/doctors/etc. (dates are relative to today)
public/index.html   the whole front end
scripts/smoke-test.js   end-to-end check
render.yaml         one-click deploy config for Render
.github/workflows/ci.yml   automated test on every push
```
