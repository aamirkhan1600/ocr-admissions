require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const axios = require("axios");
const mysql = require("mysql2/promise");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");
const cron = require("node-cron");

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const TMP_DIR = process.env.TMP_DIR || "tmp";
const LANGS = (process.env.LANGS || "eng").split(",");
const PUSH_TO_ADMISSIONS = String(process.env.PUSH_TO_ADMISSIONS).toLowerCase() === "true";

const UPLOADED_LEADS_URL = process.env.UPLOADED_LEADS_URL;
const LEAD_STATUS_URL = process.env.LEAD_STATUS_URL;
const ADMISSIONS_TOKEN = process.env.ADMISSIONS_TOKEN;
const SOURCE_API = process.env.SOURCE_API;

// ensure tmp dir
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------- App ----------
const app = express();
app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));
app.get("/health", (_, res) => res.send("OK"));

// ---------- DB ----------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------- OCR Worker ----------
let worker;
async function initWorker() {
  worker = await createWorker(LANGS.join("+"));
  await worker.setParameters({
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@._-+&:/()'\", ",
  });
}

// ---------- Helpers ----------
async function downloadToTmp(url) {
  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const ext = (url.split("?")[0].match(/\.(png|jpg|jpeg|webp)$/i) || [".jpg"])[0];
  const dest = path.join(TMP_DIR, `${id}${ext}`);
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  fs.writeFileSync(dest, resp.data);
  return dest;
}

// ✨ Improved preprocessing for handwriting
async function preprocess(srcPath) {
  const outPath = srcPath.replace(/\.[^.]+$/, "") + "_proc.png";
  await sharp(srcPath)
    .resize({ width: 2000 })     // upscale for better recognition
    .grayscale()
    .normalize()                 // enhance contrast
    .threshold(180)              // binarize (important for handwriting)
    .toFormat("png")
    .toFile(outPath);
  return outPath;
}

function titleCase(s) {
  if (!s) return "";
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).trim();
}
function digitsOnly(s) {
  return (s || "").replace(/\D/g, "");
}

// Flexible "after" matcher
function after(text, labelRegex, valueRegex = /([^\n\r]+)/) {
  const m = text.match(
    new RegExp(labelRegex.source + "[\\s:]*" + valueRegex.source, "i")
  );
  return m ? (m[1] || "").trim() : "";
}

// ✨ Improved parser for handwritten forms
function parseStudentForm(raw) {
  const text = raw.replace(/[|]+/g, " ").replace(/\u200b/g, "").replace(/\r/g, "");

  const data = {};

  // Names
  data.first_name = titleCase(after(text, /(First\s*Name|Frst\s*Name)[:.]?/i));
  data.last_name = titleCase(after(text, /(Last\s*Name|Lst\s*Name)[:.]?/i));

  // Mobile
  let mobile = digitsOnly(
    after(text, /(Mobile\s*No|Mob\s*No)[:.]?/i, /([0-9\s\-()+]{7,20})/)
  );
  if (mobile.startsWith("91") && mobile.length > 10) mobile = mobile.slice(-10);
  data.mobile_no = mobile;

  // Email
  data.email = (
    after(
      text,
      /(Email\s*ID|E[-\s]?mail)[:.]?/i,
      /([\w.%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/
    ) || ""
  ).toLowerCase();

  // School / College
  data.school_college_name = after(text, /(School|College)\s*Name[:.]?/i);

  // Current Grade
  data.current_grade = after(text, /(Current\s*Grade|Grade)[:.]?/i);

  // Completion Year (fuzzy)
  data.completion_year = after(text, /(Completion|Comp1etion|Complition)\s*Year[:.]?/i);

  // Parents
  data.father_name = titleCase(after(text, /Father'?s\s*Name[:.]?/i));
  data.mother_name = titleCase(after(text, /Mother'?s\s*Name[:.]?/i));

  // Program Interested
  if (/Entrepreneurship|BBA/i.test(text)) data.program_interested_in = "BBA";
  else if (/Design|B\.?Des/i.test(text)) data.program_interested_in = "B.Des";
  else if (/Digital\s*Technology|AI|ML/i.test(text)) data.program_interested_in = "B.Sc AI & ML";

  // Comments
  data.comments = after(text, /Comments?[:.]?/i);

  return data;
}

// ---------- Admissions API pushers ----------
async function pushUploadedLeads(payload) {
  if (!PUSH_TO_ADMISSIONS || !UPLOADED_LEADS_URL || !ADMISSIONS_TOKEN) return null;
  const res = await axios.post(UPLOADED_LEADS_URL, payload, {
    headers: { Authorization: `Bearer ${ADMISSIONS_TOKEN}`, "Content-Type": "application/json" },
  });
  return res.data;
}
async function pushLeadStatusUpdate(lead_id, parsed) {
  if (!PUSH_TO_ADMISSIONS || !LEAD_STATUS_URL || !ADMISSIONS_TOKEN) return null;
  const body = {
    lead_id,
    lead_ai_response: {
      name: [parsed.first_name, parsed.last_name].filter(Boolean).join(" "),
      email: parsed.email,
      phone: parsed.mobile_no,
    },
  };
  const res = await axios.post(LEAD_STATUS_URL, body, {
    headers: { Authorization: `Bearer ${ADMISSIONS_TOKEN}`, "Content-Type": "application/json" },
  });
  return res.data;
}

// ---------- Core processor ----------
async function processFormFromUrl(s3_url) {
  const imgPath = await downloadToTmp(s3_url);
  const procPath = await preprocess(imgPath);

  const { data: { text } } = await worker.recognize(procPath);

  fs.unlink(imgPath, () => {});
  fs.unlink(procPath, () => {});

  const parsed = parseStudentForm(text);
  parsed.image_url = s3_url;

  const sql = `INSERT INTO student_forms 
    (image_url, first_name, last_name, mobile_no, email, school_college_name, current_grade,
    completion_year, father_name, mother_name, program_interested_in, comments, raw_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const vals = [
    parsed.image_url,
    parsed.first_name, parsed.last_name, parsed.mobile_no, parsed.email,
    parsed.school_college_name, parsed.current_grade, parsed.completion_year,
    parsed.father_name, parsed.mother_name, parsed.program_interested_in,
    parsed.comments, text
  ];
  const [result] = await pool.execute(sql, vals);

  let uploaded = null, status = null;
  try { uploaded = await pushUploadedLeads(parsed); } catch {}
  const lead_id = uploaded?.lead_id || uploaded?.id;
  if (lead_id) {
    try { status = await pushLeadStatusUpdate(lead_id, parsed); } catch {}
  }

  return { local_id: result.insertId, lead_data: parsed, admissions_uploadedLeads: uploaded, admissions_leadStatusUpdate: status };
}

// ---------- API: manual OCR ----------
app.post("/ocr", async (req, res) => {
  try {
    const { s3_url } = req.body;
    if (!s3_url) return res.status(400).json({ error: "s3_url required" });
    const out = await processFormFromUrl(s3_url);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: "ocr_failed", detail: err.message });
  }
});

// ---------- API: auto import ----------
app.get("/auto-import", async (req, res) => {
  try {
    if (!SOURCE_API) return res.status(400).json({ error: "SOURCE_API not set" });

    const { data: forms } = await axios.post(
      SOURCE_API,
      { status: "new" },
      {
        headers: {
          Authorization: `Bearer ${ADMISSIONS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    const results = [];
    const leads = Array.isArray(forms) ? forms : forms.data || [];
    for (const f of leads) {
      if (f.s3_url) {
        const r = await processFormFromUrl(f.s3_url);
        results.push(r);
      }
    }

    res.json({ processed: results.length, results });
  } catch (err) {
    res.status(500).json({ error: "auto_import_failed", detail: err.response?.data || err.message });
  }
});

// ---------- Scheduled automation (every hour) ----------
cron.schedule("0 * * * *", async () => {
  if (!SOURCE_API) return;
  console.log("Running scheduled import...");
  try {
    const { data: forms } = await axios.post(
      SOURCE_API,
      { status: "new" },
      {
        headers: {
          Authorization: `Bearer ${ADMISSIONS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    const leads = Array.isArray(forms) ? forms : forms.data || [];
    for (const f of leads) {
      if (f.s3_url) await processFormFromUrl(f.s3_url);
    }
  } catch (err) {
    console.error("Scheduled import failed:", err.message);
  }
});

// ---------- Boot ----------
(async () => {
  await initWorker();
  app.listen(PORT, () => console.log(`OCR Admissions API automated listening on :${PORT}`));
})();
