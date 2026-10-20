"use strict";
/* End-to-end smoke test against a RUNNING server (needs Node 18+, no extra packages).
     npm start            # in one terminal
     npm run smoke        # in another

   It proves the important thing: a patient who registers is really saved in PostgreSQL.
     1. register a new patient through the API
     2. read it back with that patient's login (data came from the database)
     3. log in again from scratch, and check a wrong password is refused
     4. check a patient can NOT see other patients (role protection)
     5. log in as admin and confirm the new patient is in the clinic's patient list, then delete it

   Settings (optional env vars):  BASE_URL (default http://localhost:3000),
   ADMIN_USER (default admin), ADMIN_PASSWORD (default admin123 - the demo-data password).
   Without a working admin password, steps 5 is skipped (and the test patient is left in place). */

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

(async () => {
  const stamp = Date.now().toString(36);
  const me = {
    name: "Smoke Test " + stamp, age: "41", gender: "Female", phone_no: "9000000000",
    email: `smoke.${stamp}@example.com`, address: "Test Street", username: "smoke_" + stamp, password: "smoke-pass-123"
  };

  const health = await call("/health");
  check("server + database are up (/api/health)", health.status === 200 && health.data.ok === true, JSON.stringify(health));
  if (health.status !== 200) { console.log(`\nCan't reach ${BASE}. Is the server running?`); process.exit(1); }

  const reg = await call("/auth/register", { method: "POST", body: me });
  check("register a new patient", reg.status === 200 && !!reg.data.token && reg.data.user && reg.data.user.role === "patient", JSON.stringify(reg));
  const patientId = reg.data.user && reg.data.user.ref_id;

  const prof = await call("/profile", { token: reg.data.token });
  check("profile read back from the database matches what was registered",
    prof.status === 200 && prof.data.name === me.name && prof.data.email === me.email && prof.data.age === 41 && prof.data.address === me.address,
    JSON.stringify(prof.data));

  const dupe = await call("/auth/register", { method: "POST", body: me });
  check("registering the same username twice is refused", dupe.status === 400, `status ${dupe.status}`);

  const login = await call("/auth/login", { method: "POST", body: { username: me.username, password: me.password } });
  check("fresh login with the new credentials works", login.status === 200 && !!login.data.token);
  const bad = await call("/auth/login", { method: "POST", body: { username: me.username, password: "wrong-password" } });
  check("wrong password is refused", bad.status === 401, `status ${bad.status}`);

  const other = await call("/patients", { token: login.data.token });
  check("a patient cannot list all patients (403)", other.status === 403, `status ${other.status}`);
  const stats = await call("/stats", { token: login.data.token });
  check("dashboard stats load for the patient", stats.status === 200 && typeof stats.data.upcoming_consults === "number", JSON.stringify(stats.data));
  const noAuth = await call("/consults");
  check("no token -> 401", noAuth.status === 401, `status ${noAuth.status}`);

  const admin = await call("/auth/login", { method: "POST", body: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  if (admin.status !== 200) {
    console.log(`SKIP  admin checks (couldn't log in as '${ADMIN_USER}' - set ADMIN_USER / ADMIN_PASSWORD to run them)`);
    console.log(`NOTE  test patient '${me.username}' was left in the database.`);
  } else {
    const list = await call("/patients", { token: admin.data.token });
    check("admin sees the new patient in the clinic's patient list",
      list.status === 200 && Array.isArray(list.data) && list.data.some(p => p.patient_id === patientId && p.name === me.name));
    const del = await call("/patients/" + patientId, { method: "DELETE", token: admin.data.token });
    check("admin can delete the test patient (clean-up)", del.status === 200, JSON.stringify(del));
    const gone = await call("/auth/login", { method: "POST", body: { username: me.username, password: me.password } });
    check("deleted patient can no longer log in", gone.status === 401, `status ${gone.status}`);
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed ✔");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("Smoke test crashed:", e.message); process.exit(2); });
