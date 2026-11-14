import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import { GoogleGenAI } from '@google/genai';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'teacher-amir-super-secret-2026';
const ADMIN_LOGIN = 'amir';
const ADMIN_PASS = 'ayo';
const DB_PATH = process.env.DB_PATH || 'data.db';

const aiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

// ==================== BAZA (SQLite) ====================
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'student',
    plan TEXT DEFAULT 'free',
    plan_expires TEXT,
    seconds_used INTEGER DEFAULT 0,
    last_active_date TEXT,
    points INTEGER DEFAULT 0,
    prize_msg TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_name TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lang TEXT NOT NULL,
    level TEXT NOT NULL,
    unit TEXT NOT NULL,
    content TEXT NOT NULL,
    UNIQUE(lang, level, unit)
  );

  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    exam TEXT NOT NULL,
    kind INTEGER NOT NULL,
    content TEXT NOT NULL,
    UNIQUE(subject, exam, kind)
  );
`);

// Standart Admin akkaunti
const adminCheck = db.prepare('SELECT id FROM users WHERE LOWER(name) = ? OR LOWER(email) = ?').get(ADMIN_LOGIN, ADMIN_LOGIN);
if (!adminCheck) {
  const hash = bcrypt.hashSync(ADMIN_PASS, 10);
  db.prepare('INSERT INTO users (name, email, password_hash, role, plan) VALUES (?, ?, ?, ?, ?)').run('Amir (Admin)', ADMIN_LOGIN, hash, 'admin', 'year');
}

function initSetting(key, defVal) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(defVal));
}
initSetting('free_subjects', ["Matematika", "Ona tili", "Ingliz tili"]);
initSetting('free_levels', ["A1"]);
initSetting('admin_phone', "+998 90 123 45 67");
initSetting('admin_telegram', "@teacher_amir_admin");
initSetting('season_prize', "1-o‘ringa 1 yillik bepul Premium!");

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}
function setSetting(key, val) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(val));
}
function logActivity(userId, userName, action, detail) {
  try {
    db.prepare('INSERT INTO activity_logs (user_id, user_name, action, detail) VALUES (?, ?, ?, ?)').run(userId || null, userName || 'Mehmon', action, detail);
  } catch (e) {}
}

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 150, message: { error: 'So‘rovlar ko‘paydi, biroz kuting.' } }));

function getUser(req) {
  const token = req.cookies.auth_token;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id) || null;
  } catch {
    return null;
  }
}
function getToday() { return new Date().toISOString().split('T')[0]; }

// Muloyim Amir AI
async function generateAI(prompt) {
  if (!aiClient) {
    return `[Amir AI]: Assalomu alaykum, aziz o‘quvchim! Hozirda tizim sinov rejimida ishlamoqda. Gemini API kaliti ulangach, barcha darslar to‘liq tushuntirib beriladi.`;
  }
  const systemInstruction = `Sen Amir AI san. O'quvchilarga 50+ til, IELTS, CEFR va barcha maktab fanlarini o'rgatuvchi juda muloyim, xushmuomala, rag'batlantiruvchi va chuqur bilimli ustozsan. Har doim o'quvchiga mehr va samimiyat bilan dars o't.`;
  try {
    const res = await aiClient.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { systemInstruction }
    });
    return res.text;
  } catch (err) {
    throw new Error('Amir AI hozir javob bera olmadi: ' + err.message);
  }
}

// ==================== AUTH API ====================
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, confirmed } = req.body;
    if (!name || !email || !password || password.length < 4) {
      return res.status(400).json({ error: 'Ism, email va kamida 4 belgili parol kiritish shart!' });
    }
    if (!confirmed) {
      return res.status(400).json({ error: 'Iltimos, "Login va parolimni eslab qoldim" tasdiqlash katakchasini belgilang!' });
    }

    const hash = await bcrypt.hash(password, 10);
    const r = db.prepare('INSERT INTO users (name, email, password_hash, role, last_active_date) VALUES (?, ?, ?, ?, ?)').run(
      name.trim(), email.toLowerCase().trim(), hash, 'student', getToday()
    );

    const token = jwt.sign({ id: r.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('auth_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 30 * 864e5 });
    logActivity(r.lastInsertRowid, name, 'Ro‘yxatdan o‘tdi', 'Yangi hisob yaratildi');

    res.json({
      ok: true,
      user: { id: r.lastInsertRowid, name, email, role: 'student', prize_msg: '' },
      plan: 'free',
      used: 0
    });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Bu email orqali allaqachon ro‘yxatdan o‘tilgan!' });
    res.status(500).json({ error: 'Xatolik yuz berdi: ' + err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Login va parolni kiriting!' });

    const q = login.toLowerCase().trim();
    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(name) = ?').get(q, q);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(400).json({ error: 'Login yoki parol noto‘g‘ri!' });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('auth_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 30 * 864e5 });
    logActivity(user.id, user.name, 'Kirish', 'Tizimga kirdi');

    const used = user.last_active_date === getToday() ? user.seconds_used : 0;
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, prize_msg: user.prize_msg },
      plan: user.plan,
      used
    });
  } catch (err) {
    res.status(500).json({ error: 'Kirishda xatolik yuz berdi.' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getUser(req);
  const settings = {
    free_subjects: getSetting('free_subjects'),
    free_levels: getSetting('free_levels'),
    admin_phone: getSetting('admin_phone'),
    admin_telegram: getSetting('admin_telegram'),
    season_prize: getSetting('season_prize')
  };
  if (!user) return res.json({ user: null, plan: 'free', used: 0, settings });
  const used = user.last_active_date === getToday() ? user.seconds_used : 0;
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, points: user.points, prize_msg: user.prize_msg }, plan: user.plan, used, settings });
});

// ==================== DARSLAR VA AI API ====================
app.post('/api/lesson', async (req, res) => {
  try {
    const { lang, level, unit } = req.body;
    const user = getUser(req);
    const freeLevels = getSetting('free_levels') || ["A1"];
    if (!freeLevels.includes(level) && (!user || user.plan === 'free')) {
      return res.status(403).json({ error: `${level} daraja darslari Premium hisobda ochiladi. Administrator bilan bog‘laning!` });
    }
    const check = db.prepare('SELECT content FROM lessons WHERE lang = ? AND level = ? AND unit = ?').get(lang, level, unit);
    if (check) return res.json({ text: check.content });

    const p = `Til: ${lang}. Daraja: ${level}. Dars: "${unit}".
Juda muloyim va rag'batlantiruvchi tarzda quyidagilardan iborat dars ber:
1. Yangi lug'at (15 ta so'z, transkripsiya, o'zbekcha tarjimasi).
2. Grammatika qoidasi (oddiy va misollar bilan).
3. Namunaviy dialog (${lang} tilida va o'zbekcha tarjimasi).
4. O'qish matni (100 so'z).
5. 5 ta mashq va test savollari javoblari bilan.`;

    const text = await generateAI(p);
    db.prepare('INSERT OR REPLACE INTO lessons (lang, level, unit, content) VALUES (?, ?, ?, ?)').run(lang, level, unit, text);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/school', async (req, res) => {
  try {
    const { grade, subject, topic } = req.body;
    const user = getUser(req);
    const freeSubjects = getSetting('free_subjects') || ["Matematika", "Ona tili", "Ingliz tili"];
    if (!freeSubjects.includes(subject) && (!user || user.plan === 'free')) {
      return res.status(403).json({ error: `"${subject}" fani Premium tarifda. Administratorga murojaat qiling.` });
    }
    const p = `${grade} uchun "${subject}" fani. Mavzu: ${topic || 'Navbatdagi mavzu'}. Maktab darsligi uslubida tushuntir, hayotiy misollar va 5 ta mashq ber.`;
    const text = await generateAI(p);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/material', async (req, res) => {
  try {
    const { subject, exam, k } = req.body;
    const kinds = ["Strategiya va qo'llanma", "150 ta akademik so'z", "Grammatika qoidalari", "Namunaviy insholar"];
    const p = `Imtihon: ${exam}. Fan/Til: ${subject}. Material turi: ${kinds[k] || kinds[0]}.
Imtihondan yuqori natija olish uchun professional va muloyim qo
