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

// Admin akkauntini yaratish (amir / ayo)
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
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 150, message: { error: 'So‘rovlar soni oshdi. 1 daqiqa kuting.' } }));

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
    return `[Amir AI]: Assalomu alaykum, aziz o‘quvchim! Hozirda tizim demo rejimida. API ulangach, darslar to‘liq beriladi.`;
  }
  const systemInstruction = `Sen Amir AI san. O'quvchilarga 50+ til, IELTS, CEFR va maktab fanlarini o'rgatuvchi juda muloyim, xushmuomala, rag'batlantiruvchi va chuqur bilimli ustozsan. Har doim o'quvchiga mehr bilan va tushunarli tilda dars o't.`;
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
    logActivity(r.lastInsertRowid, name, 'Ro‘yxatdan o‘tdi', 'Yangi hisob ochildi');

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
    logActivity(user.id, user.name, 'Kirish', 'Tizimga muvaffaqiyatli kirdi');

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
Imtihondan yuqori natija olish uchun professional va muloyim qo'llanma yozib ber.`;
    const text = await generateAI(p);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai', async (req, res) => {
  try {
    const text = await generateAI(req.body.prompt);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== JANG VA ARENA ====================
const rooms = new Map();
const BATTLE_BANK = [
  { q: "'Diligent' so'zining ma'nosi?", a: "tirishqoq", opts: ["tirishqoq", "dangasa", "qo'rqoq", "saxiy"] },
  { q: "She ___ to school every day.", a: "goes", opts: ["goes", "go", "going", "went"] },
  { q: "'Ubiquitous' nimani anglatadi?", a: "hamma yerda mavjud", opts: ["hamma yerda mavjud", "kamyob", "qadimiy", "xavfli"] },
  { q: "12 × 12 = ?", a: "144", opts: ["144", "124", "134", "154"] },
  { q: "15 × 6 = ?", a: "90", opts: ["90", "80", "85", "95"] }
];

app.get('/api/league', (req, res) => {
  const user = getUser(req);
  const mePoints = user ? user.points : 0;
  const topRows = db.prepare('SELECT name, points FROM users ORDER BY points DESC LIMIT 20').all();
  const getLeague = p => p >= 500 ? 'Brilliant' : p >= 200 ? 'Oltin' : p >= 50 ? 'Kumush' : 'Bronza';
  res.json({
    me: mePoints,
    myLeague: getLeague(mePoints),
    season_prize: getSetting('season_prize'),
    top: topRows.map((r, i) => ({ rank: i + 1, nick: r.name, pts: r.points, league: getLeague(r.points) }))
  });
});

app.post('/api/room/create', (req, res) => {
  const { name } = req.body;
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
  rooms.set(code, {
    code, state: 'lobby', pos: 0, winner: null, q: '', answer: '', options: [],
    players: [{ id: playerId, n: name, t: 0, s: 0, res: null }]
  });
  res.json({ id: playerId, code, host: true });
});

app.post('/api/room/join', (req, res) => {
  const { name, code } = req.body;
  const r = rooms.get(code);
  if (!r) return res.status(404).json({ error: 'Xona topilmadi.' });
  if (r.state !== 'lobby') return res.status(400).json({ error: 'Jang boshlangan.' });
  const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
  const t = r.players.filter(p => p.t === 0).length <= r.players.filter(p => p.t === 1).length ? 0 : 1;
  r.players.push({ id: playerId, n: name, t, s: 0, res: null });
  broadcastRoom(r);
  res.json({ id: playerId, code, host: false });
});

app.get('/api/room/:code/events', (req, res) => {
  const r = rooms.get(req.params.code);
  if (!r) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const p = r.players.find(x => x.id === req.query.id);
  if (p) p.res = res;
  sendRoomState(p, r);
  req.on('close', () => { if (p) p.res = null; });
});

function nextQuestion(r) {
  const itm = BATTLE_BANK[Math.floor(Math.random() * BATTLE_BANK.length)];
  r.q = itm.q;
  r.answer = itm.a;
  r.options = itm.opts;
}

function sendRoomState(p, r) {
  if (!p || !p.res) return;
  p.res.write(`data: ${JSON.stringify({
    state: r.state, pos: r.pos, winner: r.winner, q: r.q, options: r.options,
    players: r.players.map(x => ({ n: x.n, t: x.t, s: x.s }))
  })}\n\n`);
}
function broadcastRoom(r) { r.players.forEach(p => sendRoomState(p, r)); }

app.post('/api/room/:code/start', (req, res) => {
  const r = rooms.get(req.params.code);
  if (!r) return res.status(404).json({ error: 'Xona topilmadi.' });
  r.state = 'play';
  r.pos = 0;
  nextQuestion(r);
  broadcastRoom(r);
  res.json({ ok: true });
});

app.post('/api/room/:code/answer', (req, res) => {
  const r = rooms.get(req.params.code);
  if (!r || r.state !== 'play') return res.json({ ok: false });
  const p = r.players.find(x => x.id === req.body.id);
  if (!p) return res.json({ ok: false });

  if (String(req.body.ans).toLowerCase().trim() === String(r.answer).toLowerCase().trim()) {
    p.s += 1;
    r.pos += (p.t === 0 ? -1 : 1);
    const user = getUser(req);
    if (user) db.prepare('UPDATE users SET points = points + 3 WHERE id = ?').run(user.id);

    if (r.pos <= -5) { r.state = 'finish'; r.winner = 0; }
    else if (r.pos >= 5) { r.state = 'finish'; r.winner = 1; }
    else nextQuestion(r);

    broadcastRoom(r);
    return res.json({ ok: true });
  }
  res.json({ ok: false, wait: true });
});

// ==================== ADMIN PANEL API ====================
function verifyAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key === `${ADMIN_LOGIN}:${ADMIN_PASS}` || key === 'amir-admin-2026') return next();
  const user = getUser(req);
  if (user && user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin ruxsati kerak.' });
}

app.post('/api/admin/login', (req, res) => {
  const { login, password } = req.body;
  if (login === ADMIN_LOGIN && password === ADMIN_PASS) {
    return res.json({ ok: true, token: `${ADMIN_LOGIN}:${ADMIN_PASS}` });
  }
  res.status(400).json({ error: 'Admin logini yoki paroli noto‘g‘ri!' });
});

app.get('/api/admin/overview', verifyAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, plan, plan_expires, points, prize_msg, created_at FROM users ORDER BY id DESC').all();
  const activities = db.prepare('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 50').all();
  res.json({
    users,
    activities,
    settings: {
      free_subjects: getSetting('free_subjects'),
      free_levels: getSetting('free_levels'),
      admin_phone: getSetting('admin_phone'),
      admin_telegram: getSetting('admin_telegram'),
      season_prize: getSetting('season_prize')
    }
  });
});

app.post('/api/admin/settings', verifyAdmin, (req, res) => {
  const { free_subjects, free_levels, admin_phone, admin_telegram, season_prize } = req.body;
  if (free_subjects) setSetting('free_subjects', free_subjects);
  if (free_levels) setSetting('free_levels', free_levels);
  if (admin_phone) setSetting('admin_phone', admin_phone);
  if (admin_telegram) setSetting('admin_telegram', admin_telegram);
  if (season_prize) setSetting('season_prize', season_prize);
  res.json({ ok: true });
});

app.post('/api/admin/award', verifyAdmin, (req, res) => {
  const { userId, plan, days, prizeMessage } = req.body;
  const d = days || (plan === 'year' ? 365 : 30);
  const exp = new Date(Date.now() + d * 864e5).toISOString();
  const msg = prizeMessage || `Tabriklaymiz! Sizga musobaqa sovrini sifatida ${d} kunlik bepul Premium taqdim etildi!`;
  db.prepare('UPDATE users SET plan = ?, plan_expires = ?, prize_msg = ? WHERE id = ?').run(plan, exp, msg, userId);
  res.json({ ok: true });
});

// ==================== FRONTEND (HTML/CSS/JS) ====================
const HTML = `<!DOCTYPE html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Teacher Amir — 50+ Til, Sertifikatlar va Bilim Arenasi</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;800&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/pptxgenjs/3.12.0/pptxgen.bundle.js"></script>
<style>
:root{--bg:#060b14;--sf:#0c1626;--ink:#e8f4f8;--mut:#8aa0b4;--ln:#1a2c42;--br:#19d3e6;--bi:#031417;--soft:#0e2a33;--sun:#f2b134;--si:#2a1e00;--bad:#ff5252;--ok:#10b981;box-sizing:border-box}
*,*::before,*::after{box-sizing:inherit}
body{margin:0;background:radial-gradient(1000px 500px at 50% -10%,rgba(25,211,230,.18),transparent),var(--bg);color:var(--ink);font:16px/1.55 Manrope,sans-serif;min-height:100vh}
.app{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
aside{background:rgba(8,14,26,.95);border-right:1px solid rgba(25,211,230,.2);padding:20px 14px;position:sticky;top:0;height:100vh;overflow:auto}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;color:#fff;margin-bottom:20px}
.logo b{color:var(--br)}
aside button.n{display:block;width:100%;text-align:left;font:inherit;font-weight:700;border:0;background:none;color:var(--mut);padding:11px 14px;border-radius:12px;cursor:pointer;margin-bottom:4px;transition:.2s}
aside button.n:hover{color:#fff;background:rgba(25,211,230,.08)}
aside button.n[aria-current="true"]{background:var(--soft);color:var(--br);box-shadow:inset 0 0 12px rgba(25,211,230,.2)}
main{padding:24px clamp(16px,3vw,40px);min-width:0}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--ln)}
.me{font-size:14px;color:var(--mut)}.me b{color:var(--sun)}
h1{font-size:clamp(26px,4vw,38px);margin:0 0 8px;background:linear-gradient(90deg,#19d3e6,#f2b134);-webkit-background-clip:text;background-clip:text;color:transparent}
h2{font-size:22px;margin:24px 0 12px;color:var(--br)}
.sub{color:var(--mut);margin:0 0 20px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.card{background:linear-gradient(160deg,rgba(25,211,230,.06),rgba(12,22,38,.9));border:1px solid rgba(25,211,230,.18);border-radius:16px;padding:18px}
button.card{text-align:left;cursor:pointer;font:inherit;color:inherit;transition:.2s}
button.card:hover{border-color:var(--br);box-shadow:0 0 20px rgba(25,211,230,.25);transform:translateY(-2px)}
.tag{display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:2px 10px;background:var(--soft);color:var(--br);margin-bottom:8px}
.tag.pro{background:var(--sun);color:var(--si)}
.btn{font:inherit;font-weight:800;background:var(--br);color:var(--bi);border:0;border-radius:12px;padding:11px 20px;cursor:pointer;transition:.2s}
.btn:hover{filter:brightness(1.1);box-shadow:0 0 16px rgba(25,211,230,.4)}
.btn.sun{background:var(--sun);color:var(--si)}
input,select,textarea{width:100%;font:inherit;padding:11px 14px;border-radius:10px;border:1px solid var(--ln);background:var(--sf);color:var(--ink);margin-top:6px}
label{display:block;font-weight:700;font-size:14px;margin-top:12px}
.form{max-width:580px}
.out{white-space:pre-wrap;background:var(--sf);border:1px solid var(--ln);border-radius:14px;padding:20px;margin-top:18px;line-height:1.7}
.out:empty{display:none}
.rope{display:flex;height:24px;border-radius:12px;overflow:hidden;border:1px solid var(--ln);margin:14px 0}
.rope i{background:var(--br);transition:width .25s}.rope b{flex:1;background:var(--sun)}
.alert-prize{background:rgba(242,177,52,.15);border:1px solid var(--sun);color:var(--sun);padding:14px 18px;border-radius:14px;margin-bottom:18px;font-weight:700}
.pulse-mic{display:inline-flex;align-items:center;gap:8px;background:rgba(255,82,82,.2);border:1px solid var(--bad);color:#ff8a80;padding:6px 14px;border-radius:999px;font-size:13px;animation:p 1.5s infinite}
@keyframes p{0%{opacity:1}50%{opacity:.4}100%{opacity:1}}
#ai-b{position:fixed;right:20px;bottom:20px;z-index:30}
#ai-p{position:fixed;right:20px;bottom:75px;width:min(400px,calc(100vw - 40px));height:500px;background:var(--sf);border:1px solid var(--br);border-radius:18px;display:none;flex-direction:column;z-index:30;box-shadow:0 10px 40px rgba(0,0,0,.6)}
#ai-p.on{display:flex}#ai-m{flex:1;overflow:auto;padding:16px}
#ai-f{display:flex;gap:8px;padding:12px;border-top:1px solid var(--ln)}
table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid var(--ln);padding:10px 12px;text-align:left;font-size:14px}th{background:rgba(25,211,230,.1);color:var(--br)}

/* Boshlang'ich Kirish Darvozasi (Gate Modal) */
#gate-overlay{position:fixed;inset:0;background:rgba(6,11,20,.94);backdrop-filter:blur(16px);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px}
.gate-box{width:min(460px,100%);background:linear-gradient(160deg,rgba(25,211,230,.1),rgba(12,22,38,.98));border:1px solid rgba(25,211,230,.3);border-radius:22px;padding:28px;box-shadow:0 0 50px rgba(25,211,230,.25)}
.gate-box h2{margin:0 0 6px;color:#fff}
.gate-box p{color:var(--mut);margin:0 0 16px;font-size:14px}
.gate-switch{color:var(--br);cursor:pointer;font-weight:700;text-decoration:underline;margin-top:14px;display:inline-block}

@media (max-width:768px){.app{grid-template-columns:1fr}aside{height:auto;position:static;display:flex;gap:6px;overflow-x:auto;padding:10px}aside .logo{display:none}aside button.n{white-space:nowrap;width:auto}}
</style>
</head>
<body>

<div id="gate-overlay" style="display:none">
  <div class="gate-box">
    <div id="gate-login-view">
      <h2>Kirish</h2>
      <p>Teacher Amir platformasiga kirish uchun login va parolingizni kiriting.</p>
      <form onsubmit="event.preventDefault();submitGateLogin()">
        <label>Login yoki Email</label>
        <input id="gl-login" required placeholder="Email yoki loginni kiriting...">
        <label>Parol</label>
        <input id="gl-pass" type="password" required placeholder="Parolingizni kiriting...">
        <p id="gl-err" style="color:var(--bad);margin:8px 0 0"></p>
        <button class="btn" style="width:100%;margin-top:16px">Kirish</button>
      </form>
      <span class="gate-switch" onclick="switchGate('reg')">Akkaunt yo‘qmi? Yangi akkaunt yaratish</span>
    </div>

    <div id="gate-reg-view" style="display:none">
      <h2>Yangi akkaunt yaratish</h2>
      <p>Iltimos, ma’lumotlaringizni to‘liq kiriting va parolingizni eslab qoling.</p>
      <form onsubmit="event.preventDefault();submitGateReg()">
        <label>Ismingiz (majburiy)</label>
        <input id="gr-name" required placeholder="Masalan: Amirbek">
        <label>Email (majburiy)</label>
        <input id="gr-email" type="email" required placeholder="Emailingizni kiriting...">
        <label>Yangi parol yarating (majburiy)</label>
        <input id="gr-pass" type="password" required minlength="4" placeholder="Parol yarating...">
        
        <div style="margin-top:14px;background:rgba(25,211,230,.06);padding:12px;border-radius:10px;border:1px solid rgba(25,211,230,.2)">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin:0;font-weight:700;color:var(--sun)">
            <input type="checkbox" id="gr-chk" required style="width:18px;height:18px;margin:0;accent-color:var(--sun)">
            <span>Login va parolimni eslab qoldim</span>
          </label>
        </div>

        <p id="gr-err" style="color:var(--bad);margin:8px 0 0"></p>
        <p id="gr-ok" style="color:var(--ok);font-weight:700;margin:8px 0 0"></p>
        <button class="btn sun" id="gr-btn" style="width:100%;margin-top:16px">Akkauntni yaratish</button>
      </form>
      <span class="gate-switch" onclick="switchGate('login')">Akkauntingiz bormi? Kirish oynasiga qaytish</span>
    </div>
  </div>
</div>

<div class="app">
<aside id="nav">
  <div class="logo">
    <svg width="34" height="34" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="var(--br)"/><path d="M20 7 35 15 20 23 5 15Z" fill="var(--bi)"/><path d="M11 20v6c0 2.5 4 4.5 9 4.5s9-2 9-4.5v-6l-9 4.5z" fill="var(--bi)" opacity=".8"/></svg>
    <span>Teacher <b>Amir</b></span>
  </div>
</aside>
<main>
  <div class="top">
    <div><b>Xalqaro Ta’lim & Bilimlar Jangi Arenasi</b></div>
    <div class="me" id="me"></div>
  </div>
  <div id="prize_banner"></div>
  <div id="v"></div>
</main>
</div>

<button class="btn sun" id="ai-b" type="button">Ustoz Amir AI</button>
<div id="ai-p" role="dialog">
  <div style="padding:12px 16px;background:rgba(25,211,230,.15);border-bottom:1px solid var(--ln);font-weight:800;display:flex;justify-content:space-between">
    <span>Ustoz Amir (Muloyim AI)</span><span style="cursor:pointer" onclick="$('#ai-p').classList.remove('on')">✕</span>
  </div>
  <div id="ai-m"><p style="color:var(--br)">Assalomu alaykum! Men Amir AI man. Qanday dars yoki savolingiz bor?</p></div>
  <form id="ai-f"><input id="ai-i" placeholder="Savol bering..." autocomplete="off"><button class="btn">Yuborish</button></form>
</div>

<script>
var $ = s => document.querySelector(s);
var ME = null, SETTINGS = {}, plan = 'free', used = 0;
var LANGS = "Ingliz,Rus,Nemis,Fransuz,Ispan,Italyan,Portugal,Turk,Arab,Xitoy,Yapon,Koreys,Hind,Fors,Ukrain,Polyak,Chex,Slovak,Venger,Rumin,Bolgar,Serb,Xorvat,Yunon,Golland,Shved,Norveg,Dat,Fin,Eston,Latish,Litva,Gruzin,Arman,Ozarbayjon,Qozoq,Qirgʻiz,Turkman,Tojik,Urdu,Bengal,Tamil,Tailand,Vetnam,Indoneziya,Malay,Filipin,Ivrit,Suahili,Afrikaans,Irland,Island,Belarus,Mongol,Pushtu,Katalan,Lotin,Esperanto".split(",");
var SUBJ = ["Matematika","Ona tili","Ingliz tili","Rus tili","Fizika","Kimyo","Biologiya","Tarix","Geografiya","Informatika","Adabiyot"];
var EXAMS = ["Milliy sertifikat (CEFR)","IELTS","TOEFL","Cambridge","TORFL (ТРКИ)","Goethe","TOPIK","JLPT","HSK","DELF/DALF","DTM/attestatsiya"];
var LVL = [
  ["A1","A1: Boshlangʻich",["Salomlashish va tanishuv","Raqamlar, vaqt va sana","Oila va doʻstlar","Ovqat va ichimlik","Doʻkon va narxlar","Uy va xonalar","Kundalik tartib","Shahar va yoʻnalish","Ob-havo va fasllar","Hobbi va boʻsh vaqt"]],
  ["A2","A2: Elementar",["Kiyim va xarid","Sayohat va transport","Sogʻliq va shifokor","Ish va kasblar","Rejalar va oʻtgan voqealar","Mehmonxona va restoran","Telefon va xabarlar","Bayramlar va urf-odatlar","Taqqoslash va tavsif","Taklif va rad etish"]],
  ["B1","B1: Oʻrta",["Taʼlim va oʻqish","Ish suhbati","Texnologiya va internet","Ekologiya","Sogʻlom turmush","Madaniyat va sanʼat","Sayohatdagi muammolar","Fikr bildirish","Shartli gaplar","Yangiliklar"]],
  ["B2","B2: Oʻrta-yuqori",["Jamiyat va muammolar","Ilm-fan","Biznes va iqtisod","Munozara","Rasmiy xat","Tarix","Munosabatlar","Media","Mavhum mavzu","Idiomalar"]],
  ["C1","C1: Ilgʻor",["Akademik yozuv","Nutq va taqdimot","Siyosat va huquq","Adabiyot tahlili","Kasbiy muloqot","Ohang va ironiya","Ilmiy maqolalar","Murakkab grammatika","Tez nutq","Madaniyatlararo"]],
  ["C2","C2: Master",["Muzokara","Yuqori ritorika","Tarjima","Dialekt","Adabiy asarlar","Ilmiy munozara","Ijodiy yozuv","Notiqlik","Imtihon strategiyasi","Loyiha"]]
];

function API(u,b){
  return fetch(u,b===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':localStorage.getItem('adm_key')||''},body:JSON.stringify(b)})
  .then(r=>r.json().then(j=>{if(!r.ok)throw new Error(j.error||'Xato yuz berdi');return j}));
}
function opts(a){return a.map(x=>'<option value="'+x+'">'+x+'</option>').join("");}

function switchGate(to){
  if(to === 'reg'){
    $("#gate-login-view").style.display = 'none';
    $("#gate-reg-view").style.display = 'block';
  } else {
    $("#gate-reg-view").style.display = 'none';
    $("#gate-login-view").style.display = 'block';
  }
}

function submitGateLogin(){
  var l = $("#gl-login").value, p = $("#gl-pass").value;
  $("#gl-err").textContent = "";
  API('/api/login', { login: l, password: p }).then(j => {
    ME = j.user; plan = j.plan; used = j.used;
    $("#gate-overlay").style.display = 'none';
    updateMe(); show('home');
  }).catch(e => { $("#gl-err").textContent = e.message; });
}

function submitGateReg(){
  var n = $("#gr-name").value, e = $("#gr-email").value, p = $("#gr-pass").value, chk = $("#gr-chk").checked;
  $("#gr-err").textContent = ""; $("#gr-ok").textContent = "";
  if(!chk){ $("#gr-err").textContent = 'Iltimos, "Login va parolimni eslab qoldim" katakchasini belgilang!'; return; }
  
  API('/api/register', { name: n, email: e, password: p, confirmed: chk }).then(j => {
    $("#gr-ok").textContent = "Akkaunt muvaffaqiyatli yaratildi! Saytga yo‘naltirilmoqda...";
    setTimeout(() => {
      ME = j.user; plan = j.plan; used = j.used;
      $("#gate-overlay").style.display = 'none';
      updateMe(); show('home');
    }, 1200);
  }).catch(err => { $("#gr-err").textContent = err.message; });
}

var NAV = [
  ["home","Asosiy"],["course","50+ Chet tillari"],["school","Maktab fanlari"],
  ["cert","Sertifikatlar"],["arena","Jonli Jang (Arena)"],["league","Ligalar & Sovrinlar"],
  ["teach","Taqdimot & Slayd"],["premium","Premium olish"],["admin","Admin Panel"]
];
$("#nav").insertAdjacentHTML("beforeend", NAV.map(n=>'<button class="n" data-v="'+n[0]+'" type="button">'+n[1]+'</button>').join(""));
$("#nav").onclick = e => { var v = e.target.dataset && e.target.dataset.v; if(v) show(v); };

var V = {
  home: function(){
    return '<h1>Xush kelibsiz, Teacher Amir platformasiga!</h1>' +
    '<p class="sub">50+ til, IELTS/CEFR sertifikatlari, maktab fanlari va real-vaqtli bilim janglari arenasi.</p>' +
    '<div class="grid">' +
      '<button class="card" onclick="show(\\'course\\')"><h3>🌐 50+ Chet tillari</h3><p>A1 dan C2 gacha noldan mukammallikkacha.</p></button>' +
      '<button class="card" onclick="show(\\'cert\\')"><h3>🎓 Sertifikatlar</h3><p>IELTS, CEFR, TOEFL, HSK bo‘yicha Speaking va Mock imtihonlar.</p></button>' +
      '<button class="card" onclick="show(\\'arena\\')"><h3>⚔️ Bilimlar Jangi</h3><p>Do‘stlar bilan jonli duel qilib ball to‘plang!</p></button>' +
      '<button class="card" onclick="show(\\'league\\')"><h3>🏆 Ligalar & Sovrinlar</h3><p>1-o‘rinni oling va tekin 1 yillik Premium yuting!</p></button>' +
    '</div>';
  },
  course: function(){
    return '<h1>50+ Xorijiy tillar kursi</h1><p class="sub">Til va darajani tanlang. Darslar lug‘at, grammatika va testlardan iborat.</p>' +
    '<div class="form"><label>Til:</label><select id="c-lang">' + opts(LANGS) + '</select></div>' +
    '<div style="display:flex;gap:6px;margin:16px 0;flex-wrap:wrap">' +
      LVL.map((x,i)=>'<button class="btn '+(i===0?'':'sun')+'" style="padding:6px 14px" onclick="setLvl('+i+',this)">'+x[0]+'</button>').join("") +
    '</div><h3 id="lvl-title">'+LVL[0][1]+'</h3>' +
    '<div class="grid" id="c-units">' + LVL[0][2].map((u,i)=>'<button class="card" onclick="openLesson(\\''+u+'\\')"><span class="tag">'+(i+1)+'-dars</span><h3>'+u+'</h3></button>').join("") + '</div>' +
    '<div class="out" id="o"></div>';
  },
  school: function(){
    return '<h1>Onlayn Maktab</h1><p class="sub">1–11-sinf fanlari darslik formatida.</p>' +
    '<div class="form"><label>Sinf:</label><select id="s-gr">' + [1,2,3,4,5,6,7,8,9,10,11].map(x=>'<option>'+x+'-sinf</option>').join("") + '</select></div>' +
    '<h2>Fanlar</h2><div class="grid">' +
    SUBJ.map(s => {
      var isFree = (SETTINGS.free_subjects || []).includes(s);
      return '<button class="card" onclick="openSchool(\\''+s+'\\')"><span class="tag '+(isFree?'':'pro')+'">'+(isFree?'Bepul':'Premium')+'</span><h3>'+s+'</h3></button>';
    }).join("") + '</div><label style="margin-top:14px">Mavzu:</label><input id="s-tp" class="form" placeholder="Masalan: Tenglamalar"><div class="out" id="o"></div>';
  },
  cert: function(){
    return '<h1>Sertifikatga Tayyorlov & Speaking</h1><div class="form card">' +
    '<label>Imtihon:</label><select id="x-ex">' + opts(EXAMS) + '</select>' +
    '<label>Til/Fan:</label><select id="x-sub">' + opts(["Ingliz tili","Rus tili","Nemis tili","Xitoy tili","Koreys tili"].concat(SUBJ)) + '</select>' +
    '<label>Bo‘lim:</label><select id="x-kind">' +
      '<option value="0">Strategiya va qo‘llanma</option><option value="1">150 ta akademik so‘z</option>' +
      '<option value="2">Grammatika qoidalari</option><option value="3">Namunaviy insholar</option>' +
    '</select><button class="btn" style="margin-top:14px" onclick="openCert()">Materialni yaratish</button></div>' +
    '<h2>Speaking (Mikrofon bilan sinash)</h2><div class="form card">' +
    '<p>Savol: <i>"Tell me about your favorite book and why you like it."</i></p>' +
    '<button class="btn sun" onclick="startMic()">🎤 Gapirish (Mikrofon)</button><div id="mic-stat" style="margin-top:6px"></div>' +
    '<textarea id="mic-txt" rows="4" placeholder="Gapirganingiz shu yerga yoziladi..." style="margin-top:10px"></textarea>' +
    '<button class="btn" style="margin-top:10px" onclick="evalSpeaking()">Baholash va Xatolarni ko‘rish</button></div>' +
    '<div class="out" id="o"></div>';
  },
  arena: function(){
    return '<h1>Bilimlar Arenasi (Jonli Jang)</h1><p class="sub">Do‘stlaringiz bilan xona ochib, bir-biringizga qarshi duel qiling!</p>' +
    '<div class="form card" id="ar-box">' +
      '<label>Ismingiz:</label><input id="ar-name" value="'+(ME?ME.name:'')+'">' +
      '<label>Xona kodi:</label><input id="ar-code" placeholder="4 xonali kod">' +
      '<p style="margin-top:14px"><button class="btn" onclick="createRoom()">Xona yaratish</button> <button class="btn sun" onclick="joinRoom()">Xonaga kirish</button></p>' +
    '</div><div id="ar-live"></div>';
  },
  league: function(){
    return '<h1>Ligalar & Sovrinlar</h1><div class="alert-prize">🎁 <b>Joriy mavsum sovrini:</b> '+(SETTINGS.season_prize||'1-o‘ringa 1 yillik bepul Premium!')+'</div>' +
    '<div class="grid">' +
      '<div class="card"><h3>Bronza</h3><p>0–49 ball</p></div><div class="card"><h3>Kumush</h3><p>50–199 ball</p></div>' +
      '<div class="card"><h3>Oltin</h3><p>200–499 ball</p></div><div class="card"><h3>Brilliant</h3><p>500+ ball</p></div>' +
    '</div><h2>Top-20 Peshqadamlar</h2><div class="card form" id="league-board">Yuklanmoqda...</div>';
  },
  teach: function(){
    return '<h1>Taqdimot Yaratish (PowerPoint)</h1><p class="sub">Mavzu kiriting, Amir AI slaydlar tayyorlab, .pptx qilib beradi.</p>' +
    '<form class="form card" id="f-sl"><label>Mavzu:</label><input id="sl-tp" required placeholder="Masalan: Fotosintez"><button class="btn" style="margin-top:12px">Slaydlarni tayyorlash</button></form>' +
    '<div id="sl-res"></div>';
  },
  premium: function(){
    return '<h1>Premium Hisobga O‘tish</h1><div class="grid">' +
      '<div class="card"><h3>Oylik Premium</h3><h1 style="color:var(--sun)">59 000 so‘m</h1><p>Barcha 50+ tillar va fanlar ochiq.</p></div>' +
      '<div class="card"><span class="tag pro">Chegirma</span><h3>Yillik Premium</h3><h1 style="color:var(--sun)">490 000 so‘m</h1><p>Butun yil cheksiz foydalanish.</p></div>' +
    '</div>' +
    '<div class="card form" style="margin-top:20px;border-color:var(--sun)">' +
      '<h3>To‘lov va faollashtirish:</h3>' +
      '<p>1. Administratorga qo‘ng‘iroq qiling yoki Telegram orqali yozing.</p>' +
      '<p>2. To‘lov amalga oshirilgach, administrator hisobingizni darhol Premium qiladi.</p>' +
      '<p>📞 <b>Telefon:</b> <a href="tel:'+SETTINGS.admin_phone+'" style="color:var(--br)">'+SETTINGS.admin_phone+'</a></p>' +
      '<p>💬 <b>Telegram:</b> <a href="https://t.me/'+(SETTINGS.admin_telegram||'').replace('@','')+'" target="_blank" style="color:var(--br)">'+SETTINGS.admin_telegram+'</a></p>' +
    '</div>';
  },
  admin: function(){
    return '<h1>Admin Panel (Boshqaruv)</h1>' +
    '<div class="form card" id="adm-l-box">' +
      '<label>Admin Logini:</label><input id="adm-u" placeholder="amir">' +
      '<label>Admin Paroli:</label><input type="password" id="adm-p" placeholder="ayo">' +
      '<p id="adm-err" style="color:var(--bad);margin:8px 0 0"></p>' +
      '<button class="btn" style="margin-top:12px" onclick="loadAdmin()">Panelga kirish</button>' +
    '</div><div id="adm-c" style="display:none"></div>';
  }
};

function show(k){
  $("#v").innerHTML = V[k]();
  [].forEach.call(document.querySelectorAll("#nav .n"), b => b.setAttribute("aria-current", b.dataset.v === k));
  var pb = $("#prize_banner");
  pb.innerHTML = (ME && ME.prize_msg) ? '<div class="alert-prize">🎉 <b>Mukofotingiz:</b> ' + ME.prize_msg + '</div>' : '';
  if(k === 'league') loadLeague();
  if(k === 'teach'){
    $("#f-sl").onsubmit = e => {
      e.preventDefault();
      var t = $("#sl-tp").value;
      $("#sl-res").innerHTML = "<p>Slaydlar tayyorlanmoqda...</p>";
      API('/api/ai', { prompt: '"' + t + '" mavzusida 5 ta slayd tayyorla. Format faqat JSON: [{"title":"Nom","points":["band1","band2"]}]' }).then(j => {
        try {
          var clean = j.text.split(String.fromCharCode(96,96,96)+'json').join('').split(String.fromCharCode(96,96,96)).join('').trim();
          renderSlides(JSON.parse(clean), t);
        }
        catch(err) { $("#sl-res").innerHTML = "<p>Qayta urinib ko‘ring.</p>"; }
      });
    };
  }
}

function updateMe(){
  $("#me").innerHTML = ME ? '<b>' + ME.name + '</b> (' + plan.toUpperCase() + ') | <a href="#" onclick="doLogout();return false" style="color:var(--bad)">Chiqish</a>' :
  '<a href="#" onclick="$(\\'#gate-overlay\\').style.display=\\'flex\\';return false" style="color:var(--br)">Kirish / Ro‘yxatdan o‘tish</a>';
}

function doLogout(){
  API('/api/logout',{}).then(()=>{
    ME=null; plan='free'; updateMe();
    $("#gate-overlay").style.display = 'flex';
    switchGate('login');
  });
}

var curLvl = 0;
function setLvl(i, b){
  curLvl = i;
  [].forEach.call(b.parentNode.children, x => x.className = "btn sun");
  b.className = "btn";
  $("#lvl-title").textContent = LVL[i][1];
  $("#c-units").innerHTML = LVL[i][2].map((u, idx) => '<button class="card" onclick="openLesson(\\''+u+'\\')"><span class="tag">'+(idx+1)+'-dars</span><h3>'+u+'</h3></button>').join("");
}
function openLesson(u){
  var o = $("#o"); o.textContent = "Ustoz Amir dars tayyorlamoqda...";
  API('/api/lesson', { lang: $("#c-lang").value, level: LVL[curLvl][0], unit: u }).then(j => {
    o.textContent = j.text; o.scrollIntoView({ behavior: 'smooth' });
  }).catch(e => { o.textContent = "Xato: " + e.message; });
}
function openSchool(s){
  var o = $("#o"); o.textContent = "Ustoz Amir tushuntirmoqda...";
  API('/api/school', { grade: $("#s-gr").value, subject: s, topic: $("#s-tp").value }).then(j => {
    o.textContent = j.text; o.scrollIntoView({ behavior: 'smooth' });
  }).catch(e => { o.textContent = "Xato: " + e.message; });
}
function openCert(){
  var o = $("#o"); o.textContent = "Sertifikat materiallari tayyorlanmoqda...";
  API('/api/material', { subject: $("#x-sub").value, exam: $("#x-ex").value, k: +$("#x-kind").value }).then(j => {
    o.textContent = j.text; o.scrollIntoView({ behavior: 'smooth' });
  }).catch(e => { o.textContent = "Xato: " + e.message; });
}

function startMic(){
  var R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!R) return alert("Brauzeringiz ovoz yozishni qo‘llamaydi (Google Chrome tavsiya etiladi).");
  var r = new R(); r.lang = "en-US";
  $("#mic-stat").innerHTML = "<span class='pulse-mic'>● Gapiring, eshityapman...</span>";
  r.onresult = e => { $("#mic-txt").value = e.results[0][0].transcript; $("#mic-stat").innerHTML = "<span style='color:var(--ok)'>✓ Yozib olindi!</span>"; };
  r.onerror = () => { $("#mic-stat").innerHTML = "<span style='color:var(--bad)'>Mikrofon xatosi.</span>"; };
  r.start();
}
function evalSpeaking(){
  var t = $("#mic-txt").value; if(!t) return alert("Avval gapiring yoki matn yozing.");
  var o = $("#o"); o.textContent = "Amir AI muloyimlik bilan tahlil qilmoqda...";
  API('/api/ai', { prompt: 'Speaking javobini bahola: "' + t + '". Grammatika, Lug\'at, Band ball va maslahatlar ber.' }).then(j => {
    o.textContent = j.text; o.scrollIntoView({ behavior: 'smooth' });
  });
}

// Arena
var rSSE = null;
function createRoom(){
  API('/api/room/create', { name: $("#ar-name").value || "Jangchi" }).then(j => initArena(j.code, j.id, true));
}
function joinRoom(){
  var c = $("#ar-code").value; if(!c) return alert("Kodni kiriting!");
  API('/api/room/join', { name: $("#ar-name").value || "Jangchi", code: c }).then(j => initArena(c, j.id, false));
}
function initArena(code, id, isHost){
  $("#ar-box").style.display = "none";
  $("#ar-live").innerHTML = '<div class="card form"><h3>Xona: <b style="color:var(--sun);font-size:26px">' + code + '</b></h3>' +
  '<p>Do‘stingizga shu kodni ayting.</p><div id="p-box"></div><div class="rope"><i id="r-pos" style="width:50%"></i><b></b></div><div id="q-box"></div></div>';
  if(rSSE) rSSE.close();
  rSSE = new EventSource('/api/room/' + code + '/events?id=' + id);
  rSSE.onmessage = e => {
    var s = JSON.parse(e.data);
    $("#p-box").innerHTML = '<p><b>Ko‘k:</b> ' + s.players.filter(p=>p.t===0).map(p=>p.n+' ('+p.s+')').join(', ') + '</p>' +
    '<p><b>Sariq:</b> ' + s.players.filter(p=>p.t===1).map(p=>p.n+' ('+p.s+')').join(', ') + '</p>';
    $("#r-pos").style.width = (5 - s.pos) * 10 + "%";
    var qb = $("#q-box");
    if(s.state === 'lobby') qb.innerHTML = isHost ? '<button class="btn" onclick="API(\\'/api/room/'+code+'/start\\')">Jangni Boshlash</button>' : '<p>Mezbon boshlashini kuting...</p>';
    else if(s.state === 'play'){
      qb.innerHTML = '<h2>' + s.q + '</h2><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      s.options.map(o => '<button class="btn sun" onclick="sendAns(\\''+code+'\\',\\''+id+'\\',\\''+o+'\\')">'+o+'</button>').join("") + '</div>';
    } else if(s.state === 'finish'){
      qb.innerHTML = '<h2>🎉 ' + (s.winner === 0 ? 'Ko‘k jamoa' : 'Sariq jamoa') + ' g‘alaba qildi!</h2><button class="btn" onclick="show(\\'arena\\')">Yangi Jang</button>';
    }
  };
}
function sendAns(code, id, a){ API('/api/room/' + code + '/answer', { id, ans: a }); }

function loadLeague(){
  API('/api/league').then(j => {
    $("#league-board").innerHTML = '<p>Sizning ballaringiz: <b>' + j.me + '</b> (' + j.myLeague + ')</p>' +
    '<table><tr><th>O‘rin</th><th>Ism</th><th>Ball</th><th>Liga</th></tr>' +
    j.top.map(t => '<tr><td>' + t.rank + '</td><td>' + t.nick + '</td><td><b>' + t.pts + '</b></td><td>' + t.league + '</td></tr>').join("") + '</table>';
  });
}

function renderSlides(s, tp){
  $("#sl-res").innerHTML = '<div class="card form" style="margin-top:14px"><h3>' + tp + '</h3><button class="btn sun" id="dp">PowerPoint (.pptx) yuklab olish</button></div>';
  $("#dp").onclick = () => {
    var p = new PptxGenJS();
    s.forEach(x => {
      var sl = p.addSlide();
      sl.addText(x.title, { x: .5, y: .4, fontSize: 26, bold: true, color: "0E6E7E" });
      sl.addText(x.points.map(q => ({ text: q, options: { bullet: true, breakLine: true } })), { x: .7, y: 1.5, fontSize: 18, color: "14213D" });
    });
    p.writeFile({ fileName: tp + ".pptx" });
  };
}

// Admin
function loadAdmin(){
  var u = $("#adm-u").value, p = $("#adm-p").value;
  $("#adm-err").textContent = "";
  API('/api/admin/login', { login: u, password: p }).then(j => {
    localStorage.setItem('adm_key', j.token);
    API('/api/admin/overview').then(data => {
      $("#adm-l-box").style.display = "none";
      var c = $("#adm-c"); c.style.display = "block";
      c.innerHTML = '<h2>Admin Boshqaruvi</h2>' +
      '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">' +
        '<button class="btn" onclick="admTab(\\'users\\')">Foydalanuvchilar (' + data.users.length + ')</button>' +
        '<button class="btn" onclick="admTab(\\'logs\\')">Faoliyat jurnali</button>' +
        '<button class="btn" onclick="admTab(\\'pricing\\')">Pullik/Bepul sozlamalari</button>' +
        '<button class="btn" onclick="admTab(\\'prizes\\')">Sovrin topshirish</button>' +
      '</div><div id="adm-tc"></div>';
      window.ADM_DATA = data; admTab('users');
    });
  }).catch(e => { $("#adm-err").textContent = e.message; });
}

function admTab(t){
  var d = window.ADM_DATA, el = $("#adm-tc");
  if(t === 'users'){
    el.innerHTML = '<table><tr><th>ID</th><th>Ism</th><th>Email</th><th>Tarif</th><th>Ball</th><th>Sovrin</th></tr>' +
    d.users.map(u => '<tr><td>' + u.id + '</td><td>' + u.name + '</td><td>' + u.email + '</td><td><b>' + u.plan + '</b></td><td>' + u.points + '</td><td>' + (u.prize_msg||'-') + '</td></tr>').join("") + '</table>';
  } else if(t === 'logs'){
    el.innerHTML = '<table><tr><th>Vaqt</th><th>Foydalanuvchi</th><th>Harakat</th><th>Tafsilot</th></tr>' +
    d.activities.map(a => '<tr><td>' + a.created_at.slice(0,19) + '</td><td>' + a.user_name + '</td><td>' + a.action + '</td><td>' + a.detail + '</td></tr>').join("") + '</table>';
  } else if(t === 'pricing'){
    el.innerHTML = '<form class="card form" onsubmit="event.preventDefault();saveSettings()">' +
      '<label>Bepul fanlar (vergul bilan):</label><input id="set-subj" value="' + (d.settings.free_subjects||[]).join(', ') + '">' +
      '<label>Bepul til darajalari (masalan: A1):</label><input id="set-lvls" value="' + (d.settings.free_levels||[]).join(', ') + '">' +
      '<label>Admin Telefon raqami:</label><input id="set-ph" value="' + (d.settings.admin_phone||'') + '">' +
      '<label>Admin Telegram:</label><input id="set-tg" value="' + (d.settings.admin_telegram||'') + '">' +
      '<label>Sovrin nomi:</label><input id="set-prz" value="' + (d.settings.season_prize||'') + '">' +
      '<button class="btn" style="margin-top:12px">Saqlash</button></form>';
  } else if(t === 'prizes'){
    el.innerHTML = '<form class="card form" onsubmit="event.preventDefault();awardPrize()">' +
      '<label>Foydalanuvchini tanlang:</label><select id="aw-uid">' + d.users.map(u => '<option value="'+u.id+'">'+u.name+' ('+u.points+' ball)</option>').join("") + '</select>' +
      '<label>Sovrin tarifi:</label><select id="aw-plan"><option value="month">1 Oylik Bepul Premium</option><option value="year">1 Yillik Bepul Premium</option></select>' +
      '<label>Sovrin tabrigi:</label><input id="aw-msg" value="Tabriklaymiz! Siz musobaqada g‘olib bo‘lib, bepul Premium yutdingiz!">' +
      '<button class="btn sun" style="margin-top:12px">Sovrinni berish</button></form>';
  }
}

function saveSettings(){
  API('/api/admin/settings', {
    free_subjects: $("#set-subj").value.split(',').map(x=>x.trim()).filter(Boolean),
    free_levels: $("#set-lvls").value.split(',').map(x=>x.trim()).filter(Boolean),
    admin_phone: $("#set-ph").value.trim(), admin_telegram: $("#set-tg").value.trim(),
    season_prize: $("#set-prz").value.trim()
  }).then(()=>{ alert("Sozlamalar saqlandi!"); location.reload(); });
}
function awardPrize(){
  API('/api/admin/award', { userId: +$("#aw-uid").value, plan: $("#aw-plan").value, prizeMessage: $("#aw-msg").value }).then(()=>{
    alert("Sovrin topshirildi!"); loadAdmin();
  });
}

// AI Chatbot
$("#ai-b").onclick = () => $("#ai-p").classList.toggle("on");
$("#ai-f").onsubmit = e => {
  e.preventDefault();
  var inp = $("#ai-i"), val = inp.value.trim(); if(!val) return; inp.value = "";
  var m = $("#ai-m");
  m.innerHTML += '<p style="text-align:right"><b>Siz:</b> ' + val + '</p><p id="ai-cur" style="color:var(--br)">Ustoz Amir o‘ylamoqda...</p>';
  m.scrollTop = m.scrollHeight;
  API('/api/ai', { prompt: val }).then(j => {
    $("#ai-cur").innerHTML = '<b>Ustoz Amir:</b> ' + j.text;
    $("#ai-cur").removeAttribute('id');
    m.scrollTop = m.scrollHeight;
  });
};

API('/api/me').then(j => {
  ME = j.user; plan = j.plan; used = j.used; SETTINGS = j.settings || {};
  if(!ME){
    $("#gate-overlay").style.display = 'flex';
  } else {
    $("#gate-overlay").style.display = 'none';
  }
  updateMe(); show('home');
}).catch(() => {
  $("#gate-overlay").style.display = 'flex';
  updateMe(); show('home');
});
</script>
</body>
</html>`;

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/health') return next();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

app.listen(PORT, () => {
  console.log(`Teacher Amir serveri http://localhost:${PORT} da ishga tushdi.`);
});
