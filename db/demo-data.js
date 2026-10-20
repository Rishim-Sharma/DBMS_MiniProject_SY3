"use strict";
/* Demo data used on the very first start (skipped when SEED_DEMO=false).
   Dates are relative to "today" so the dashboards always show upcoming items. */

const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

const patients = [ // id, name, age, gender, phone, email, address
  [1, "Shanaya Singh", 22, "Female", "9876543210", "shanaya@gmail.com", "Mumbai"],
  [2, "Rohan Sharma", 21, "Male", "9876543210", "rohan@gmail.com", "Mumbai"],
  [3, "Priya Patel", 24, "Female", "9876543211", "priya@gmail.com", "Pune"],
  [4, "Amit Kumar", 28, "Male", "9876543212", "amit@gmail.com", "Delhi"],
  [5, "Sneha Deshmukh", 22, "Female", "9876543213", "sneha@gmail.com", "Nashik"],
  [6, "Arjun Mehta", 30, "Male", "9876543214", "arjun@gmail.com", "Ahmedabad"],
  [7, "Neha Singh", 26, "Female", "9876543215", "neha@gmail.com", "Bangalore"],
  [8, "Rohan Joshi", 23, "Male", "9876543216", "rohanj@gmail.com", "Jaipur"],
  [9, "Ananya Rao", 27, "Female", "9876543217", "ananya@gmail.com", "Hyderabad"],
  [10, "Karan Shah", 25, "Male", "9876543218", "karan@gmail.com", "Surat"],
  [11, "Pooja Verma", 29, "Female", "9876543219", "pooja@gmail.com", "Kolkata"],
  [12, "Vikram Nair", 21, "Male", "9876543220", "vikram@gmail.com", "Chennai"],
  [13, "Isha Kapoor", 20, "Female", "9876543221", "isha@gmail.com", "Mumbai"],
  [14, "Aditya Rao", 26, "Male", "9876543222", "aditya@gmail.com", "Pune"],
  [15, "Sahil Gupta", 28, "Male", "9876543224", "sahil@gmail.com", "Lucknow"]
];

const doctors = [ // id, name, specialization, phone
  [1, "Dr. Sameer Kulkarni", "Nephrology", "9821122334"],
  [2, "Dr. Mehta", "Urology", "9876001111"],
  [3, "Dr. Shah", "General Medicine", "9876500222"],
  [4, "Dr. Patil", "Nephrology", "9876003333"],
  [5, "Dr. Joshi", "Urology", "9876004444"]
];

const chemists = [[1, "Priya Deshmukh", "9822233445"]];

const patientUsers = [["shanaya", 1], ["rohan", 2], ["priyap", 3], ["amit", 4], ["sneha", 5], ["arjun", 6], ["neha", 7], ["rohanj", 8],
  ["ananya", 9], ["karan", 10], ["pooja", 11], ["vikram", 12], ["isha", 13], ["aditya", 14], ["sahil", 15]];
const doctorUsers = [["drsameer", 1], ["drmehta", 2], ["drshah", 3], ["drpatil", 4], ["drjoshi", 5]];
const chemistUsers = [["priya", 1]];

const PASSWORDS = { admin: "admin123", patient: "patient123", doctor: "doctor123", chemist: "chemist123" };

// id, patient, doctor, date  (a spread from ~2 weeks ago to ~2 weeks ahead)
const consults = [
  [1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4], [5, 1, 5], [6, 2, 1], [7, 3, 2], [8, 4, 3],
  [9, 1, 4], [10, 2, 5], [11, 3, 1], [12, 4, 2], [13, 1, 3], [14, 2, 4], [15, 3, 5]
].map(([id, p, d]) => [id, p, d, day(-14 + id * 2)]);

// id, date, time, type, status, patient, doctor
const tests = [
  [1, day(-45), "10:30", "Routine Urinalysis", "Completed", 1, 1],
  [2, day(-28), "10:30", "Routine Urine Test", "Completed", 1, 1],
  [3, day(-27), "11:00", "Routine Urine Test", "Completed", 2, 2],
  [4, day(-26), "09:45", "Routine Urine Test", "Completed", 3, 3],
  [5, day(-3), "12:15", "Routine Urine Test", "Pending", 4, 4],
  [6, day(-2), "10:00", "Routine Urine Test", "Pending", 1, 5],
  [7, day(-24), "10:30", "Routine Urine Test", "Completed", 2, 1],
  [8, day(-23), "11:15", "Routine Urine Test", "Completed", 3, 2],
  [9, day(-22), "09:30", "Routine Urine Test", "Completed", 4, 3],
  [10, day(1), "10:45", "Routine Urine Test", "Pending", 1, 4],
  [11, day(-20), "11:30", "Routine Urine Test", "Completed", 2, 5],
  [12, day(-19), "09:15", "Routine Urine Test", "Completed", 3, 1],
  [13, day(2), "12:00", "Routine Urine Test", "Pending", 4, 2],
  [14, day(-17), "10:20", "Routine Urine Test", "Completed", 1, 3],
  [15, day(3), "09:50", "Routine Urine Test", "Pending", 3, 5]
];

// result 50N belongs to test N
const results = [
  [501, "Protein: Trace, Glucose: Nil", "Yellow", "Normal", "None", 1],
  [502, "Protein: +, Glucose: +", "Dark Yellow", "Abnormal", "UTI", 2],
  [503, "Protein: -, Glucose: -", "Pale Yellow", "Normal", "None", 3],
  [504, "Protein: ++, Glucose: -", "Yellow", "Abnormal", "Proteinuria", 4],
  [505, "Protein: -, Glucose: -", "Yellow", "Normal", "None", 5],
  [506, "Protein: +++, Glucose: +++", "Dark Yellow", "Abnormal", "Dehydration", 6],
  [507, "Protein: -, Glucose: -", "Pale Yellow", "Normal", "None", 7],
  [508, "Protein: +, Glucose: +", "Yellow", "Abnormal", "UTI", 8],
  [509, "Protein: -, Glucose: -", "Yellow", "Normal", "None", 9],
  [510, "Protein: ++, Glucose: -", "Dark Yellow", "Abnormal", "Kidney Infection", 10],
  [511, "Protein: -, Glucose: -", "Pale Yellow", "Normal", "None", 11],
  [512, "Protein: +++, Glucose: +++", "Dark Yellow", "Abnormal", "Proteinuria", 12],
  [513, "Protein: -, Glucose: -", "Yellow", "Normal", "None", 13],
  [514, "Protein: +, Glucose: +", "Dark Yellow", "Abnormal", "UTI", 14],
  [515, "Protein: -, Glucose: -", "Pale Yellow", "Normal", "None", 15]
];

// care plan 70N belongs to result 50N
const carePlans = [
  [701, "Drink adequate water", "Maintain hydration", "Pending"],
  [702, "Take prescribed antibiotics", "Complete medication course", "Pending"],
  [703, "Continue normal diet", "No major concerns", "Dispensed"],
  [704, "Reduce salt intake", "Monitor protein levels", "Pending"],
  [705, "Maintain healthy lifestyle", "Routine follow-up", "Dispensed"],
  [706, "Increase water intake", "Prevent dehydration", "Pending"],
  [707, "Continue regular diet", "No major concerns", "Dispensed"],
  [708, "Take prescribed medication", "Follow doctor instructions", "Pending"],
  [709, "Maintain adequate hydration", "Routine monitoring", "Dispensed"],
  [710, "Complete antibiotic course", "Follow-up required", "Pending"],
  [711, "Continue normal diet", "No major concerns", "Dispensed"],
  [712, "Reduce salt intake", "Monitor protein levels", "Pending"],
  [713, "Maintain healthy lifestyle", "Routine follow-up", "Dispensed"],
  [714, "Take prescribed antibiotics", "Complete medication course", "Pending"],
  [715, "Drink adequate water", "Maintain hydration", "Pending"]
].map(([id, rec, notes, status], i) => [id, rec, day(5 + i), notes, status, 501 + i]);

// each payment is tied to a care plan and to that plan's patient
const payAmounts = [500, 750, 600, 800, 500, 650, 900, 550, 700, 850, 500, 950, 600, 750, 800];
const payStatus = ["Paid", "Paid", "Paid", "Unpaid", "Paid", "Paid", "Paid", "Unpaid", "Paid", "Paid", "Paid", "Unpaid", "Paid", "Paid", "Unpaid"];
const payments = payAmounts.map((amt, i) => [901 + i, amt, day(-30 + i * 2), payStatus[i], tests[i][5], 701 + i]);

module.exports = {
  patients, doctors, chemists, patientUsers, doctorUsers, chemistUsers, PASSWORDS,
  consults, tests, results, carePlans, payments
};
