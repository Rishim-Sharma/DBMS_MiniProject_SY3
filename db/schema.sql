-- RenalCare database schema (PostgreSQL)
-- The server runs this file automatically on every start. It is safe to re-run:
-- every statement uses IF NOT EXISTS, so existing data is never touched.
-- You can also run it by hand:  psql -d renalcare -f db/schema.sql

CREATE TABLE IF NOT EXISTS patients (
  patient_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER,
  gender TEXT,
  phone_no TEXT,
  email TEXT,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- databases created by an older version of the app get the new column too
ALTER TABLE patients ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS doctors (
  doctor_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  specialization TEXT,
  phone_no TEXT
);

CREATE TABLE IF NOT EXISTS chemists (
  chemist_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone_no TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  admin_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

-- one login per patient / doctor / chemist / admin; ref_id points at that person's row
CREATE TABLE IF NOT EXISTS users (
  user_id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('patient','doctor','chemist','admin')),
  ref_id INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_role_ref ON users (role, ref_id);

CREATE TABLE IF NOT EXISTS consults (
  consult_id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(patient_id),
  doctor_id  INTEGER NOT NULL REFERENCES doctors(doctor_id),
  consult_date DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS urine_tests (
  test_id SERIAL PRIMARY KEY,
  test_date DATE NOT NULL,
  test_time TEXT,
  test_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  patient_id INTEGER NOT NULL REFERENCES patients(patient_id),
  doctor_id  INTEGER NOT NULL REFERENCES doctors(doctor_id)
);

CREATE TABLE IF NOT EXISTS test_results (
  result_id SERIAL PRIMARY KEY,
  measured_value TEXT NOT NULL,
  urine_color TEXT,
  assessment TEXT,
  disease TEXT,
  test_id INTEGER NOT NULL REFERENCES urine_tests(test_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS care_plans (
  careplan_id SERIAL PRIMARY KEY,
  recommendation TEXT NOT NULL,
  followup_date DATE,
  notes TEXT,
  dispensed_status TEXT NOT NULL DEFAULT 'Pending',
  result_id INTEGER NOT NULL REFERENCES test_results(result_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  payment_id SERIAL PRIMARY KEY,
  amount NUMERIC(12,2) NOT NULL,
  payment_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Unpaid',
  patient_id INTEGER NOT NULL REFERENCES patients(patient_id),
  careplan_id INTEGER REFERENCES care_plans(careplan_id) ON DELETE SET NULL
);

-- indexes for the lookups the app does on every page
CREATE INDEX IF NOT EXISTS idx_consults_patient ON consults (patient_id);
CREATE INDEX IF NOT EXISTS idx_consults_doctor  ON consults (doctor_id);
CREATE INDEX IF NOT EXISTS idx_tests_patient    ON urine_tests (patient_id);
CREATE INDEX IF NOT EXISTS idx_tests_doctor     ON urine_tests (doctor_id);
CREATE INDEX IF NOT EXISTS idx_results_test     ON test_results (test_id);
CREATE INDEX IF NOT EXISTS idx_plans_result     ON care_plans (result_id);
CREATE INDEX IF NOT EXISTS idx_payments_patient ON payments (patient_id);
