"use strict";
/* ======================================================================
   RenalCare – backend (PostgreSQL edition)
   Express + PostgreSQL (pg) + JWT login + role-based access.

   Roles
     admin   – creates / edits / deletes doctors, chemists and patients
     doctor  – adds & edits patients; orders tests, records results, writes care plans
     chemist – dispenses care plans, logs payments
     patient – registers themselves; sees only their own records
   ====================================================================== */
require("dotenv").config({ quiet: true });
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool, Client, types } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const demo = require("./db/demo-data");

types.setTypeParser(1082, v => v);              // DATE    -> "YYYY-MM-DD" text (no timezone surprises)
types.setTypeParser(1700, v => parseFloat(v));  // NUMERIC -> JavaScript number

const IS_PROD = process.env.NODE_ENV === "production";
const PORT = process.env.PORT || 3000;

let SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16 || /^change-this/i.test(SECRET)) {
  if (IS_PROD) {
    console.error("\n✖ JWT_SECRET must be set to a long random value (16+ characters) when NODE_ENV=production.\n");
    process.exit(1);
  }
  console.warn("⚠  JWT_SECRET is missing or too weak – using an insecure development secret. Fine locally, never in production.");
  SECRET = "dev-only-secret-change-me";
}

/* ---------------------------------------------------------------------
   Database connection
   Either set DATABASE_URL (hosted databases), or the usual PGHOST / PGPORT /
   PGUSER / PGPASSWORD / PGDATABASE variables (see .env.example).
   SSL is switched on automatically for a hosted (non-local) DATABASE_URL;
   force it on/off with PGSSL=true / PGSSL=false.
--------------------------------------------------------------------- */
const useUrl = !!process.env.DATABASE_URL;
if (!useUrl) process.env.PGDATABASE = process.env.PGDATABASE || "renalcare";
const dbHost = useUrl ? (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch { return ""; } })() : (process.env.PGHOST || "localhost");
const dbIsLocal = ["", "localhost", "127.0.0.1", "::1"].includes(dbHost) || dbHost.startsWith("/");
const ssl = process.env.PGSSL === "true" ? { rejectUnauthorized: false }
          : process.env.PGSSL === "false" ? undefined
          : (useUrl && !dbIsLocal ? { rejectUnauthorized: false } : undefined);
const pool = new Pool(useUrl ? { connectionString: process.env.DATABASE_URL, ssl } : { ssl });
pool.on("error", e => console.error("Unexpected PostgreSQL error:", e.message));

const query = (sql, params = [], c = pool) => c.query(sql, params);
const all = async (sql, params, c) => (await query(sql, params, c)).rows;
const one = async (sql, params, c) => (await query(sql, params, c)).rows[0];

async function withTx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// create the database itself if it doesn't exist yet (needs a user allowed to do that, e.g. postgres)
async function ensureDatabase() {
  if (useUrl) return;
  const dbName = process.env.PGDATABASE;
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) return;
  const admin = new Client({ database: "postgres", ssl });
  try {
    await admin.connect();
    const r = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!r.rowCount) { await admin.query(`CREATE DATABASE ${dbName}`); console.log(`Created database "${dbName}"`); }
  } catch { /* the real connection below reports any problem */ }
  finally { await admin.end().catch(() => {}); }
}

// the schema lives in db/schema.sql (one place to read it, and you can run it by hand in psql)
const SCHEMA = fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");

/* ---------------------------------------------------------------------
   Small helpers
--------------------------------------------------------------------- */
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const must = (row, msg = "Not found") => row || fail(404, msg);
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const need = (v, label) => v || fail(400, `${label} is required`);
const idOf = (v, msg) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 2147483647 ? n : fail(400, msg); };
const dateOf = (v, label) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : fail(400, `${label} must be a valid date`); };
const optDate = (v, label) => (str(v, 10) ? dateOf(v, label) : null);
const timeOf = v => { const s = str(v, 5); return !s || /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : fail(400, "Time must look like 10:30"); };
const phoneOf = v => { const s = str(v, 20); return !s || /^[0-9+\-\s]{7,20}$/.test(s) ? s : fail(400, "Phone number looks invalid"); };
const oneOf = (v, list, label) => (list.includes(v) ? v : fail(400, `${label} must be one of: ${list.join(", ")}`));
const checkPassword = p => (typeof p === "string" && p.length >= 6 && p.length <= 100 ? p : fail(400, "Password must be at least 6 characters"));
const placeholders = (n, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(",");
const exists = async (table, col, id, msg) => { if (!(await one(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [id]))) fail(400, msg); };

// route wrapper: returns JSON, turns thrown errors into proper HTTP responses
const wrap = fn => async (req, res) => {
  try {
    const out = await fn(req, res);
    res.json(out === undefined ? { ok: true } : out);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === "23503") return res.status(409).json({ error: "This record is linked to other records, so the change was blocked." });
    if (e.code === "23505") return res.status(400).json({ error: "That already exists (for example, the username is taken)." });
    if (String(e.code).startsWith("22")) return res.status(400).json({ error: "One of the values is invalid." });
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
};

/* ---------------------------------------------------------------------
   Accounts: patient / doctor / chemist = profile row + login row
--------------------------------------------------------------------- */
const TABLES = {
  patient: { table: "patients", id: "patient_id", cols: ["name", "age", "gender", "phone_no", "email", "address"] },
  doctor:  { table: "doctors",  id: "doctor_id",  cols: ["name", "specialization", "phone_no"] },
  chemist: { table: "chemists", id: "chemist_id", cols: ["name", "phone_no"] }
};

function cleanPatient(b) {
  const age = b.age === "" || b.age == null ? null : Number(b.age);
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) fail(400, "Age must be a whole number between 0 and 120");
  const email = str(b.email, 120);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) fail(400, "Email looks invalid");
  return { name: need(str(b.name, 100), "Name"), age, gender: str(b.gender, 20), phone_no: phoneOf(b.phone_no), email, address: str(b.address, 300) };
}
const cleanDoctor  = b => ({ name: need(str(b.name, 100), "Name"), specialization: str(b.specialization, 100), phone_no: phoneOf(b.phone_no) });
const cleanChemist = b => ({ name: need(str(b.name, 100), "Name"), phone_no: phoneOf(b.phone_no) });
const CLEANERS = { patient: cleanPatient, doctor: cleanDoctor, chemist: cleanChemist };

async function createAccount(role, data, username, password) {
  const t = TABLES[role];
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) fail(400, "Username must be 3–40 characters (letters, numbers, . _ -)");
  checkPassword(password);
  const hash = await bcrypt.hash(password, 10);
  return withTx(async c => {
    if (await one("SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)", [username], c)) fail(400, "Username already taken");
    const ins = await query(
      `INSERT INTO ${t.table} (${t.cols.join(",")}) VALUES (${placeholders(t.cols.length)}) RETURNING ${t.id}`,
      t.cols.map(col => data[col]), c);
    const id = ins.rows[0][t.id];
    await query("INSERT INTO users (username, password_hash, role, ref_id) VALUES ($1,$2,$3,$4)", [username, hash, role, id], c);
    return id;
  });
}

const deleteAccount = (role, id) => withTx(async c => {
  const t = TABLES[role];
  if (!(await one(`SELECT 1 FROM ${t.table} WHERE ${t.id} = $1`, [id], c))) fail(404, "Not found");
  await query(`DELETE FROM ${t.table} WHERE ${t.id} = $1`, [id], c); // blocked if linked records exist
  await query("DELETE FROM users WHERE role = $1 AND ref_id = $2", [role, id], c);
});

// If no username/password is supplied, generate them and hand them back once.
async function autoCreds(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "user";
  let username = base, n = 1;
  while (await one("SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)", [username])) username = base + ++n;
  return { username, password: crypto.randomBytes(5).toString("hex") };
}

async function createWithCreds(role, body) {
  const data = CLEANERS[role](body);
  let username = str(body.username, 40);
  let password = typeof body.password === "string" ? body.password : "";
  let generated = null;
  if (!username && !password) { ({ username, password } = await autoCreds(data.name)); generated = password; }
  const id = await createAccount(role, data, username, password);
  return { id, username, generated_password: generated };
}

/* ---------------------------------------------------------------------
   Auth middleware (role is always read from the DB, never trusted from the client)
--------------------------------------------------------------------- */
const authRequired = (...roles) => async (req, res, next) => {
  let payload;
  try { payload = jwt.verify((req.headers.authorization || "").replace(/^Bearer /, ""), SECRET); }
  catch { return res.status(401).json({ error: "Please log in again" }); }
  try {
    const u = await one("SELECT user_id, username, role, ref_id FROM users WHERE user_id = $1", [payload.uid]);
    if (!u) return res.status(401).json({ error: "Please log in again" });
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: "You don't have access to this" });
    req.user = u;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
};

async function displayName(u) {
  const map = { patient: ["patients", "patient_id"], doctor: ["doctors", "doctor_id"], chemist: ["chemists", "chemist_id"], admin: ["admins", "admin_id"] };
  const [t, k] = map[u.role];
  return ((await one(`SELECT name FROM ${t} WHERE ${k} = $1`, [u.ref_id])) || {}).name || u.username;
}
const session = async u => ({
  token: jwt.sign({ uid: u.user_id }, SECRET, { expiresIn: "8h" }),
  user: { username: u.username, role: u.role, ref_id: u.ref_id, name: await displayName(u) }
});

// what rows may this user see? patients -> own, doctors -> own, everyone else -> all
function scope(req, patientCol, doctorCol) {
  const { role, ref_id } = req.user;
  if (role === "patient") return { where: `${patientCol} = $1`, params: [ref_id] };
  if (role === "doctor") return { where: `${doctorCol} = $1`, params: [ref_id] };
  return { where: "TRUE", params: [] };
}

/* ---------------------------------------------------------------------
   Seed: one admin account (+ optional demo data) on the very first start
--------------------------------------------------------------------- */
async function insertRows(c, table, cols, rows) {
  const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders(cols.length)})`;
  for (const r of rows) await c.query(sql, r);
}

async function seed() {
  const withDemo = process.env.SEED_DEMO !== "false";
  let adminPw = process.env.ADMIN_PASSWORD || "";
  let generated = false;
  if (adminPw) checkPassword(adminPw);
  else if (IS_PROD || !withDemo) { adminPw = crypto.randomBytes(9).toString("base64url"); generated = true; }
  else adminPw = demo.PASSWORDS.admin;

  const hash = pw => bcrypt.hash(pw, 10);
  const adminHash = await hash(adminPw);
  const hashes = withDemo ? {
    patient: await hash(demo.PASSWORDS.patient), doctor: await hash(demo.PASSWORDS.doctor), chemist: await hash(demo.PASSWORDS.chemist)
  } : null;

  await withTx(async c => {
    const admin = await query("INSERT INTO admins (name) VALUES ('Clinic Admin') RETURNING admin_id", [], c);
    await query("INSERT INTO users (username, password_hash, role, ref_id) VALUES ('admin',$1,'admin',$2)", [adminHash, admin.rows[0].admin_id], c);
    if (!withDemo) return;

    await insertRows(c, "patients", ["patient_id", "name", "age", "gender", "phone_no", "email", "address"], demo.patients);
    await insertRows(c, "doctors", ["doctor_id", "name", "specialization", "phone_no"], demo.doctors);
    await insertRows(c, "chemists", ["chemist_id", "name", "phone_no"], demo.chemists);

    const U = ["username", "password_hash", "role", "ref_id"];
    await insertRows(c, "users", U, demo.patientUsers.map(([u, id]) => [u, hashes.patient, "patient", id]));
    await insertRows(c, "users", U, demo.doctorUsers.map(([u, id]) => [u, hashes.doctor, "doctor", id]));
    await insertRows(c, "users", U, demo.chemistUsers.map(([u, id]) => [u, hashes.chemist, "chemist", id]));

    await insertRows(c, "consults", ["consult_id", "patient_id", "doctor_id", "consult_date"], demo.consults);
    await insertRows(c, "urine_tests", ["test_id", "test_date", "test_time", "test_type", "status", "patient_id", "doctor_id"], demo.tests);
    await insertRows(c, "test_results", ["result_id", "measured_value", "urine_color", "assessment", "disease", "test_id"], demo.results);
    await insertRows(c, "care_plans", ["careplan_id", "recommendation", "followup_date", "notes", "dispensed_status", "result_id"], demo.carePlans);
    await insertRows(c, "payments", ["payment_id", "amount", "payment_date", "status", "patient_id", "careplan_id"], demo.payments);

    // the rows above used explicit ids, so move each SERIAL counter past them
    for (const [table, col] of [["patients", "patient_id"], ["doctors", "doctor_id"], ["chemists", "chemist_id"], ["consults", "consult_id"],
                                ["urine_tests", "test_id"], ["test_results", "result_id"], ["care_plans", "careplan_id"], ["payments", "payment_id"]]) {
      await query(`SELECT setval(pg_get_serial_sequence('${table}', '${col}'), COALESCE((SELECT MAX(${col}) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`, [], c);
    }
  });

  console.log(withDemo ? "Database was empty – created the admin account and demo data." : "Database was empty – created the admin account (no demo data).");
  if (generated) console.log(`\n  ► First-run admin login  →  username: admin   password: ${adminPw}\n    (shown only once – log in and change it under Account)\n`);
}

// Show the "demo accounts" hint on the login page only while those demo passwords really work.
let demoHint = false;
async function detectDemo() {
  try {
    const u = await one("SELECT password_hash FROM users WHERE username = 'rohan' AND role = 'patient'");
    demoHint = !!u && await bcrypt.compare(demo.PASSWORDS.patient, u.password_hash);
  } catch { demoHint = false; }
}

/* ---------------------------------------------------------------------
   App + middleware
--------------------------------------------------------------------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind Render / Railway / nginx, so req.ip is the real visitor
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  });
  if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); }); // Express 5 leaves it undefined when there is no body
app.use(express.static(path.join(__dirname, "public"), { index: false, maxAge: "1h" }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// tiny in-memory rate limiting (fine for one server process)
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const blocked = k => { const a = attempts.get(k); return a && a.count >= 10 && Date.now() - a.first < WINDOW; };
const noteFail = k => { const a = attempts.get(k); if (!a || Date.now() - a.first > WINDOW) attempts.set(k, { count: 1, first: Date.now() }); else a.count++; };
const regHits = new Map();
const tooManySignups = ip => {
  const now = Date.now(), a = regHits.get(ip);
  if (!a || now - a.first > 60 * 60 * 1000) { regHits.set(ip, { count: 1, first: now }); return false; }
  return ++a.count > 20; // 20 sign-ups per hour per IP
};
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (now - a.first > WINDOW) attempts.delete(k);
  for (const [k, a] of regHits) if (now - a.first > 60 * 60 * 1000) regHits.delete(k);
}, 10 * 60 * 1000).unref();

// a real hash to compare against when the username doesn't exist, so response time doesn't reveal which usernames are real
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

/* ---------------------------------------------------------------------
   Public + auth routes
--------------------------------------------------------------------- */
app.get("/api/health", wrap(async () => { await query("SELECT 1"); return { ok: true }; }));
app.get("/api/config", wrap(() => ({ demo: demoHint, signup: process.env.ALLOW_SIGNUP !== "false" })));

app.post("/api/auth/login", wrap(async req => {
  const username = str(req.body.username, 40), password = typeof req.body.password === "string" ? req.body.password : "";
  const key = `${req.ip}|${username.toLowerCase()}`;
  if (blocked(key)) fail(429, "Too many attempts. Please wait a few minutes and try again.");
  const u = await one("SELECT * FROM users WHERE LOWER(username) = LOWER($1)", [username]);
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) { noteFail(key); fail(401, "Invalid username or password"); }
  attempts.delete(key);
  return session(u);
}));

// public sign-up creates PATIENT accounts only (set ALLOW_SIGNUP=false to turn it off)
app.post("/api/auth/register", wrap(async req => {
  if (process.env.ALLOW_SIGNUP === "false") fail(403, "Self-registration is disabled. Please contact the clinic.");
  if (tooManySignups(req.ip)) fail(429, "Too many sign-ups from this connection. Please try again later.");
  const data = cleanPatient(req.body);
  const username = str(req.body.username, 40);
  if (!username || !req.body.password) fail(400, "Username and password are required");
  const id = await createAccount("patient", data, username, req.body.password);
  return session(await one("SELECT * FROM users WHERE role = 'patient' AND ref_id = $1", [id]));
}));

app.get("/api/auth/me", authRequired(), wrap(async req => ({ user: (await session(req.user)).user })));

app.post("/api/auth/change-password", authRequired(), wrap(async req => {
  const u = await one("SELECT * FROM users WHERE user_id = $1", [req.user.user_id]);
  if (!(await bcrypt.compare(String(req.body.current_password || ""), u.password_hash))) fail(400, "Current password is wrong");
  checkPassword(req.body.new_password);
  await query("UPDATE users SET password_hash = $1 WHERE user_id = $2", [await bcrypt.hash(req.body.new_password, 10), u.user_id]);
  await detectDemo();
}));

app.post("/api/admin/reset-password", authRequired("admin"), wrap(async req => {
  const role = oneOf(req.body.role, Object.keys(TABLES), "Role");
  checkPassword(req.body.new_password);
  const r = await query("UPDATE users SET password_hash = $1 WHERE role = $2 AND ref_id = $3",
    [await bcrypt.hash(req.body.new_password, 10), role, idOf(req.body.ref_id, "Invalid user")]);
  if (!r.rowCount) fail(404, "User not found");
  await detectDemo();
}));

/* ---------------------------------------------------------------------
   Dashboard numbers (one query per role, only that user's own scope)
--------------------------------------------------------------------- */
const planOwner = "FROM care_plans c JOIN test_results r ON r.result_id = c.result_id JOIN urine_tests t ON t.test_id = r.test_id";
const STATS = {
  patient: `SELECT
    (SELECT COUNT(*)::int FROM consults WHERE patient_id = $1 AND consult_date >= CURRENT_DATE) AS upcoming_consults,
    (SELECT COUNT(*)::int FROM urine_tests WHERE patient_id = $1 AND status = 'Pending') AS pending_tests,
    (SELECT COUNT(*)::int ${planOwner} WHERE t.patient_id = $1 AND c.dispensed_status = 'Pending') AS pending_careplans,
    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE patient_id = $1 AND status = 'Unpaid') AS unpaid_amount`,
  doctor: `SELECT
    (SELECT COUNT(*)::int FROM patients) AS total_patients,
    (SELECT COUNT(*)::int FROM consults WHERE doctor_id = $1 AND consult_date >= CURRENT_DATE) AS upcoming_consults,
    (SELECT COUNT(*)::int FROM urine_tests WHERE doctor_id = $1 AND status = 'Pending') AS pending_tests,
    (SELECT COUNT(*)::int ${planOwner} WHERE t.doctor_id = $1 AND c.dispensed_status = 'Pending') AS pending_careplans`,
  chemist: `SELECT
    (SELECT COUNT(*)::int FROM care_plans WHERE dispensed_status = 'Pending') AS pending_careplans,
    (SELECT COUNT(*)::int FROM care_plans WHERE dispensed_status = 'Dispensed') AS dispensed_careplans,
    (SELECT COUNT(*)::int FROM payments WHERE status = 'Unpaid') AS unpaid_count,
    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'Unpaid') AS unpaid_amount,
    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'Paid') AS paid_amount`,
  admin: `SELECT
    (SELECT COUNT(*)::int FROM patients) AS patients,
    (SELECT COUNT(*)::int FROM doctors) AS doctors,
    (SELECT COUNT(*)::int FROM chemists) AS chemists,
    (SELECT COUNT(*)::int FROM urine_tests WHERE status = 'Pending') AS pending_tests,
    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'Unpaid') AS unpaid_amount`
};
app.get("/api/stats", authRequired(), wrap(req => {
  const sql = STATS[req.user.role];
  return one(sql, sql.includes("$1") ? [req.user.ref_id] : []);
}));

/* ---------------------------------------------------------------------
   Patients / doctors / chemists (one set of routes, different permissions)
     patients : doctor + admin add/edit, admin deletes
     doctors  : admin only (everyone logged-in can read the list)
     chemists : admin only
--------------------------------------------------------------------- */
const ACCESS = {
  patient: { read: ["doctor", "admin"], write: ["doctor", "admin"], remove: ["admin"] },
  doctor:  { read: [],                  write: ["admin"],           remove: ["admin"] }, // [] = any logged-in user
  chemist: { read: ["admin"],           write: ["admin"],           remove: ["admin"] }
};
for (const role of Object.keys(TABLES)) {
  const t = TABLES[role], a = ACCESS[role], base = `/api/${t.table}`;
  app.get(base, authRequired(...a.read), wrap(() => all(`SELECT * FROM ${t.table} ORDER BY ${t.id}`)));
  app.post(base, authRequired(...a.write), wrap(req => createWithCreds(role, req.body)));
  app.put(`${base}/:id`, authRequired(...a.write), wrap(async req => {
    const data = CLEANERS[role](req.body);
    const id = idOf(req.params.id, "Invalid id");
    const r = await query(`UPDATE ${t.table} SET ${t.cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE ${t.id} = $${t.cols.length + 1}`,
      [...t.cols.map(c => data[c]), id]);
    if (!r.rowCount) fail(404, "Not found");
  }));
  app.delete(`${base}/:id`, authRequired(...a.remove), wrap(req => deleteAccount(role, idOf(req.params.id, "Invalid id"))));
}

// id + name only, so chemists/doctors can pick a patient without seeing full records
app.get("/api/patient-options", authRequired("doctor", "chemist", "admin"),
  wrap(() => all("SELECT patient_id, name FROM patients ORDER BY name")));

// a patient's own profile
app.get("/api/profile", authRequired("patient"), wrap(async req => must(await one("SELECT * FROM patients WHERE patient_id = $1", [req.user.ref_id]))));
app.put("/api/profile", authRequired("patient"), wrap(async req => {
  const t = TABLES.patient, d = cleanPatient(req.body);
  await query(`UPDATE patients SET ${t.cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE patient_id = $${t.cols.length + 1}`,
    [...t.cols.map(c => d[c]), req.user.ref_id]);
}));

/* ---------------------------------------------------------------------
   Consultations
--------------------------------------------------------------------- */
const consultSelect = `SELECT c.*, p.name AS patient_name, d.name AS doctor_name FROM consults c
  JOIN patients p ON p.patient_id = c.patient_id JOIN doctors d ON d.doctor_id = c.doctor_id`;

app.get("/api/consults", authRequired("patient", "doctor", "admin"), wrap(req => {
  const s = scope(req, "c.patient_id", "c.doctor_id");
  return all(`${consultSelect} WHERE ${s.where} ORDER BY c.consult_date DESC, c.consult_id DESC`, s.params);
}));
app.post("/api/consults", authRequired("patient", "doctor", "admin"), wrap(async req => {
  const { role, ref_id } = req.user;
  const patient_id = role === "patient" ? ref_id : idOf(req.body.patient_id, "Please choose a patient");
  const doctor_id = role === "doctor" ? ref_id : idOf(req.body.doctor_id, "Please choose a doctor");
  await exists("patients", "patient_id", patient_id, "Please choose a patient");
  await exists("doctors", "doctor_id", doctor_id, "Please choose a doctor");
  const r = await query("INSERT INTO consults (patient_id, doctor_id, consult_date) VALUES ($1,$2,$3) RETURNING consult_id",
    [patient_id, doctor_id, dateOf(req.body.consult_date, "Date")]);
  return { id: r.rows[0].consult_id };
}));
app.delete("/api/consults/:id", authRequired("doctor", "admin"), wrap(async req => {
  const row = must(await one("SELECT * FROM consults WHERE consult_id = $1", [idOf(req.params.id, "Invalid id")]));
  if (req.user.role === "doctor" && row.doctor_id !== req.user.ref_id) fail(403, "This isn't one of your consultations");
  await query("DELETE FROM consults WHERE consult_id = $1", [row.consult_id]);
}));

/* ---------------------------------------------------------------------
   Urine tests
--------------------------------------------------------------------- */
const testSelect = `SELECT t.*, p.name AS patient_name, d.name AS doctor_name FROM urine_tests t
  JOIN patients p ON p.patient_id = t.patient_id JOIN doctors d ON d.doctor_id = t.doctor_id`;
const TEST_STATUS = ["Pending", "Completed"];
const cleanTest = b => ({
  test_date: dateOf(b.test_date, "Test date"), test_time: timeOf(b.test_time),
  test_type: need(str(b.test_type, 100), "Test type"), status: oneOf(str(b.status) || "Pending", TEST_STATUS, "Status")
});
async function ownTest(req, id) {
  const t = must(await one("SELECT * FROM urine_tests WHERE test_id = $1", [id]), "Test not found");
  if (req.user.role === "doctor" && t.doctor_id !== req.user.ref_id) fail(403, "This isn't one of your tests");
  return t;
}

app.get("/api/tests", authRequired("patient", "doctor", "admin"), wrap(req => {
  const s = scope(req, "t.patient_id", "t.doctor_id");
  return all(`${testSelect} WHERE ${s.where} ORDER BY t.test_date DESC, t.test_id DESC`, s.params);
}));
app.post("/api/tests", authRequired("doctor", "admin"), wrap(async req => {
  const d = cleanTest(req.body);
  const patient_id = idOf(req.body.patient_id, "Please choose a patient");
  const doctor_id = req.user.role === "doctor" ? req.user.ref_id : idOf(req.body.doctor_id, "Please choose a doctor");
  await exists("patients", "patient_id", patient_id, "Please choose a patient");
  await exists("doctors", "doctor_id", doctor_id, "Please choose a doctor");
  const r = await query("INSERT INTO urine_tests (test_date,test_time,test_type,status,patient_id,doctor_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING test_id",
    [d.test_date, d.test_time, d.test_type, d.status, patient_id, doctor_id]);
  return { id: r.rows[0].test_id };
}));
app.put("/api/tests/:id", authRequired("doctor", "admin"), wrap(async req => {
  const t = await ownTest(req, idOf(req.params.id, "Invalid id")), d = cleanTest(req.body);
  await query("UPDATE urine_tests SET test_date=$1, test_time=$2, test_type=$3, status=$4 WHERE test_id=$5",
    [d.test_date, d.test_time, d.test_type, d.status, t.test_id]);
}));
app.delete("/api/tests/:id", authRequired("doctor", "admin"), wrap(async req => {
  const t = await ownTest(req, idOf(req.params.id, "Invalid id"));
  await query("DELETE FROM urine_tests WHERE test_id = $1", [t.test_id]);
}));

/* ---------------------------------------------------------------------
   Test results
--------------------------------------------------------------------- */
const resultSelect = `SELECT r.*, t.test_date, t.patient_id, t.doctor_id, p.name AS patient_name FROM test_results r
  JOIN urine_tests t ON t.test_id = r.test_id JOIN patients p ON p.patient_id = t.patient_id`;
const cleanResult = b => ({
  measured_value: need(str(b.measured_value, 300), "Measured value"), urine_color: str(b.urine_color, 50),
  assessment: str(b.assessment, 500), disease: str(b.disease, 150)
});
async function ownResult(req, id) {
  const r = must(await one("SELECT r.*, t.doctor_id FROM test_results r JOIN urine_tests t ON t.test_id = r.test_id WHERE r.result_id = $1", [id]), "Result not found");
  if (req.user.role === "doctor" && r.doctor_id !== req.user.ref_id) fail(403, "This isn't one of your results");
  return r;
}

app.get("/api/results", authRequired("patient", "doctor", "admin"), wrap(req => {
  const s = scope(req, "t.patient_id", "t.doctor_id");
  return all(`${resultSelect} WHERE ${s.where} ORDER BY r.result_id DESC`, s.params);
}));
app.post("/api/results", authRequired("doctor", "admin"), wrap(async req => {
  const d = cleanResult(req.body);
  const test = await ownTest(req, idOf(req.body.test_id, "Please choose a urine test"));
  const r = await query("INSERT INTO test_results (measured_value,urine_color,assessment,disease,test_id) VALUES ($1,$2,$3,$4,$5) RETURNING result_id",
    [d.measured_value, d.urine_color, d.assessment, d.disease, test.test_id]);
  return { id: r.rows[0].result_id };
}));
app.put("/api/results/:id", authRequired("doctor", "admin"), wrap(async req => {
  const r = await ownResult(req, idOf(req.params.id, "Invalid id")), d = cleanResult(req.body);
  await query("UPDATE test_results SET measured_value=$1, urine_color=$2, assessment=$3, disease=$4 WHERE result_id=$5",
    [d.measured_value, d.urine_color, d.assessment, d.disease, r.result_id]);
}));
app.delete("/api/results/:id", authRequired("doctor", "admin"), wrap(async req => {
  const r = await ownResult(req, idOf(req.params.id, "Invalid id"));
  await query("DELETE FROM test_results WHERE result_id = $1", [r.result_id]);
}));

/* ---------------------------------------------------------------------
   Care plans (doctor writes, chemist dispenses)
--------------------------------------------------------------------- */
const planSelect = `SELECT c.*, r.test_id, t.patient_id, t.doctor_id, p.name AS patient_name FROM care_plans c
  JOIN test_results r ON r.result_id = c.result_id JOIN urine_tests t ON t.test_id = r.test_id
  JOIN patients p ON p.patient_id = t.patient_id`;
const cleanPlan = b => ({
  recommendation: need(str(b.recommendation, 500), "Recommendation"),
  followup_date: optDate(b.followup_date, "Follow-up date"), notes: str(b.notes, 500)
});

app.get("/api/careplans", authRequired("patient", "doctor", "chemist", "admin"), wrap(req => {
  const s = scope(req, "t.patient_id", "t.doctor_id");
  return all(`${planSelect} WHERE ${s.where} ORDER BY c.careplan_id DESC`, s.params);
}));
app.post("/api/careplans", authRequired("doctor", "admin"), wrap(async req => {
  const d = cleanPlan(req.body);
  const res = await ownResult(req, idOf(req.body.result_id, "Please choose a test result"));
  const r = await query("INSERT INTO care_plans (recommendation,followup_date,notes,result_id) VALUES ($1,$2,$3,$4) RETURNING careplan_id",
    [d.recommendation, d.followup_date, d.notes, res.result_id]);
  return { id: r.rows[0].careplan_id };
}));
app.put("/api/careplans/:id", authRequired("doctor", "admin"), wrap(async req => {
  const cp = must(await one("SELECT * FROM care_plans WHERE careplan_id = $1", [idOf(req.params.id, "Invalid id")]), "Care plan not found");
  await ownResult(req, cp.result_id);
  const d = cleanPlan(req.body);
  await query("UPDATE care_plans SET recommendation=$1, followup_date=$2, notes=$3 WHERE careplan_id=$4",
    [d.recommendation, d.followup_date, d.notes, cp.careplan_id]);
}));
app.delete("/api/careplans/:id", authRequired("doctor", "admin"), wrap(async req => {
  const cp = must(await one("SELECT * FROM care_plans WHERE careplan_id = $1", [idOf(req.params.id, "Invalid id")]), "Care plan not found");
  await ownResult(req, cp.result_id);
  await query("DELETE FROM care_plans WHERE careplan_id = $1", [cp.careplan_id]);
}));
app.post("/api/careplans/:id/toggle-dispense", authRequired("chemist", "admin"), wrap(async req => {
  const r = await query(`UPDATE care_plans SET dispensed_status =
    CASE dispensed_status WHEN 'Dispensed' THEN 'Pending' ELSE 'Dispensed' END WHERE careplan_id = $1`,
    [idOf(req.params.id, "Invalid id")]);
  if (!r.rowCount) fail(404, "Care plan not found");
}));

/* ---------------------------------------------------------------------
   Payments (chemist logs, patient views own)
--------------------------------------------------------------------- */
const paySelect = `SELECT y.*, p.name AS patient_name FROM payments y JOIN patients p ON p.patient_id = y.patient_id`;
const PAY_STATUS = ["Paid", "Unpaid"];
function cleanPayment(b) {
  const amount = Number(b.amount);
  if (!(amount > 0) || amount > 9999999) fail(400, "Amount must be greater than 0");
  return { amount, payment_date: dateOf(b.payment_date, "Date"), status: oneOf(str(b.status) || "Unpaid", PAY_STATUS, "Status") };
}

app.get("/api/payments", authRequired("patient", "chemist", "admin"), wrap(req => {
  const s = scope(req, "y.patient_id", "y.patient_id");
  return all(`${paySelect} WHERE ${s.where} ORDER BY y.payment_date DESC, y.payment_id DESC`, s.params);
}));
app.post("/api/payments", authRequired("chemist", "admin"), wrap(async req => {
  const d = cleanPayment(req.body);
  const patient_id = idOf(req.body.patient_id, "Please choose a patient");
  await exists("patients", "patient_id", patient_id, "Please choose a patient");
  let careplan_id = null;
  if (req.body.careplan_id) {
    careplan_id = idOf(req.body.careplan_id, "Invalid care plan");
    const cp = must(await one(`${planSelect} WHERE c.careplan_id = $1`, [careplan_id]), "Care plan not found");
    if (cp.patient_id !== patient_id) fail(400, "That care plan belongs to a different patient");
  }
  const r = await query("INSERT INTO payments (amount,payment_date,status,patient_id,careplan_id) VALUES ($1,$2,$3,$4,$5) RETURNING payment_id",
    [d.amount, d.payment_date, d.status, patient_id, careplan_id]);
  return { id: r.rows[0].payment_id };
}));
app.put("/api/payments/:id", authRequired("chemist", "admin"), wrap(async req => {
  const d = cleanPayment(req.body);
  const r = await query("UPDATE payments SET amount=$1, payment_date=$2, status=$3 WHERE payment_id=$4",
    [d.amount, d.payment_date, d.status, idOf(req.params.id, "Invalid id")]);
  if (!r.rowCount) fail(404, "Payment not found");
}));
app.delete("/api/payments/:id", authRequired("chemist", "admin"), wrap(async req => {
  const r = await query("DELETE FROM payments WHERE payment_id = $1", [idOf(req.params.id, "Invalid id")]);
  if (!r.rowCount) fail(404, "Payment not found");
}));

/* ---------------------------------------------------------------------
   Fallbacks
--------------------------------------------------------------------- */
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Bad request body" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

/* ---------------------------------------------------------------------
   Start: make sure the database + tables exist, seed on first run, then listen
--------------------------------------------------------------------- */
(async function start() {
  try {
    await ensureDatabase();
    await pool.query(SCHEMA);
    if (!(await one("SELECT 1 FROM users LIMIT 1"))) await seed();
    await detectDemo();
  } catch (e) {
    console.error("\n✖ Could not set up PostgreSQL: " + (e.message || e.code || e));
    console.error("  Check that PostgreSQL is running and that your .env settings (PGHOST / PGPORT / PGUSER / PGPASSWORD, or DATABASE_URL) are correct.\n");
    process.exit(1);
  }
  const server = app.listen(PORT, () => console.log(`RenalCare running at http://localhost:${PORT}`));
  server.on("error", e => {
    console.error(e.code === "EADDRINUSE" ? `\n✖ Port ${PORT} is already in use. Stop the other program, or set a different PORT in .env.\n` : e);
    process.exit(1);
  });
  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
})();

process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));
