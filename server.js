require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const axios = require("axios");
const mysql = require("mysql2/promise");
const cron = require("node-cron");
const { OpenAI } = require("openai");

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const TMP_DIR = process.env.TMP_DIR || "tmp";
const PUSH_TO_ADMISSIONS = String(process.env.PUSH_TO_ADMISSIONS).toLowerCase() === "true";

const UPLOADED_LEADS_URL = process.env.UPLOADED_LEADS_URL;
const LEAD_STATUS_URL = process.env.LEAD_STATUS_URL;
const ADMISSIONS_TOKEN = process.env.ADMISSIONS_TOKEN;
const SOURCE_API = process.env.SOURCE_API;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ensure tmp dir
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------- App ----------
const app = express();
app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: "5mb" }));
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

// ---------- Helpers ----------
async function downloadToTmp(url) {
  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const ext = (url.split("?")[0].match(/\.(png|jpg|jpeg|webp)$/i) || [".jpg"])[0];
  const dest = path.join(TMP_DIR, `${id}${ext}`);
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  fs.writeFileSync(dest, resp.data);
  return dest;
}

async function extractTextWithAI(imagePath) {
  const imageData = fs.readFileSync(imagePath);
  const response = await openai.responses.create({
    model: "gpt-4o-mini-vision",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `
Extract all text from this handwritten student form and return JSON with keys:
first_name, last_name, mobile_no, email, school_college_name, current_grade,
completion_year, father_name, mother_name, program_interested_in, comments
`
          },
          {
            type: "input_file",
            file: imageData,
            filename: path.basename(imagePath)
          }
        ]
      }
    ]
  });

  return response.output_text;
}

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

  let text;
  try {
    text = await extractTextWithAI(imgPath);
  } catch (err) {
    fs.unlinkSync(imgPath);
    throw err;
  }

  fs.unlinkSync(imgPath);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw_text: text }; // fallback if AI did not return valid JSON
  }
  parsed.image_url = s3_url;

  const sql = `INSERT INTO student_forms 
    (image_url, first_name, last_name, mobile_no, email, school_college_name, current_grade,
    completion_year, father_name, mother_name, program_interested_in, comments, raw_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const vals = [
    parsed.image_url,
    parsed.first_name || null, parsed.last_name || null, parsed.mobile_no || null, parsed.email || null,
    parsed.school_college_name || null, parsed.current_grade || null, parsed.completion_year || null,
    parsed.father_name || null, parsed.mother_name || null, parsed.program_interested_in || null,
    parsed.comments || null, parsed.raw_text || text
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

// ---------- API: auto import from SOURCE_API ----------
app.get("/auto-import", async (req, res) => {
  try {
    if (!SOURCE_API) return res.status(400).json({ error: "SOURCE_API not set" });

    const { data: forms } = await axios.post(
      SOURCE_API,
      { status: "new" },
      { headers: { Authorization: `Bearer ${ADMISSIONS_TOKEN}`, "Content-Type": "application/json" } }
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
      { headers: { Authorization: `Bearer ${ADMISSIONS_TOKEN}`, "Content-Type": "application/json" } }
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
app.listen(PORT, () => console.log(`OCR Admissions API running on :${PORT}`));
