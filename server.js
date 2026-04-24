require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
// /webhook 用 raw body（LINE 簽章驗證需要），其餘用 JSON
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  express.json()(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database (PostgreSQL) ───────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registrations (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      attendance    TEXT,
      interests     TEXT,
      level         TEXT,
      tools         TEXT,
      tools_other   TEXT,
      job_type      TEXT,
      source        TEXT,
      want_to_learn TEXT,
      subscribe_line TEXT,
      line_user_id  TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS line_bindings (
      line_user_id  TEXT PRIMARY KEY,
      display_name  TEXT,
      email         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

// ─── LINE Client ─────────────────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};
const lineClient = lineConfig.channelAccessToken
  ? new line.Client(lineConfig)
  : null;

// ─── Email ───────────────────────────────────────────────────────────────────
const mailer = process.env.EMAIL_USER
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD },
    })
  : null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function sendEmail(to, subject, text) {
  if (!mailer) return;
  try {
    await mailer.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME || 'AI 共學聚'}" <${process.env.EMAIL_USER}>`,
      to, subject, text,
    });
  } catch (err) {
    console.error('[Email Error]', err.message);
  }
}

async function sendLine(userId, message) {
  if (!lineClient || !userId) return;
  try {
    await lineClient.pushMessage(userId, { type: 'text', text: message });
  } catch (err) {
    console.error('[LINE Error]', err.message);
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// 即時檢查 email 是否已報名
app.get('/check-email', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.json({ registered: false });
  const result = await pool.query('SELECT name, attendance FROM registrations WHERE email=$1', [email.toLowerCase()]);
  if (result.rows[0]) {
    const r = result.rows[0];
    res.json({ registered: true, name: r.name, attendance: r.attendance });
  } else {
    res.json({ registered: false });
  }
});

app.post('/register', async (req, res) => {
  const {
    name, email, attendance,
    interest, tools, tools_other,
    level, job_type, source,
    want_to_learn, subscribe_line,
  } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, message: '姓名和 Email 為必填' });
  }

  // 防呆：已報名直接回傳提示
  const existing = await pool.query('SELECT name, attendance, line_user_id FROM registrations WHERE email=$1', [email.toLowerCase()]);
  if (existing.rows[0]) {
    const reg = existing.rows[0];
    if (reg.line_user_id) {
      // 已綁 LINE → 推 LINE 提醒
      await sendLine(reg.line_user_id,
        `嗨 ${reg.name}！\n\n你剛才嘗試再次報名 AI 共學聚 👀\n\n你已經報名過了，不用重複填喔！\n\n📅 5/4（一）20:00–21:00 線上見 🧬`
      );
    } else {
      // 未綁 LINE → Email 提醒並鼓勵加入 LINE@
      await sendEmail(
        email,
        '📋 你已報名 AI 共學聚！',
        `嗨 ${reg.name}！\n\n你已經報名過 AI 共學聚了，不需要重複填寫 ✅\n\n📅 活動時間：5/4（一）20:00–21:00\n\n📲 還沒加入我們的 LINE@ 嗎？\n掃描表單上的 QR Code 加入，活動前會自動提醒你！\n\n— AI 共學聚團隊 🧬`
      );
    }
    return res.json({ success: false, duplicate: true, name: reg.name, attendance: reg.attendance });
  }

  const interestStr = Array.isArray(interest) ? interest.join('、') : (interest || '');
  const toolsStr    = Array.isArray(tools)    ? tools.join('、')    : (tools    || '');

  try {
    await pool.query(`
      INSERT INTO registrations
        (name, email, attendance, interests, level, tools, tools_other, job_type, source, want_to_learn, subscribe_line)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (email) DO UPDATE SET
        name=EXCLUDED.name, attendance=EXCLUDED.attendance,
        interests=EXCLUDED.interests, level=EXCLUDED.level,
        tools=EXCLUDED.tools, tools_other=EXCLUDED.tools_other,
        job_type=EXCLUDED.job_type, source=EXCLUDED.source,
        want_to_learn=EXCLUDED.want_to_learn, subscribe_line=EXCLUDED.subscribe_line
    `, [name, email, attendance, interestStr, level||'', toolsStr, tools_other||'', job_type||'', source||'', want_to_learn||'', subscribe_line||'']);

    // 嘗試連結已有的 LINE 綁定
    const binding = await pool.query('SELECT * FROM line_bindings WHERE email=$1', [email]);
    if (binding.rows[0]) {
      await pool.query('UPDATE registrations SET line_user_id=$1 WHERE email=$2', [binding.rows[0].line_user_id, email]);
    }

    const isGoing = attendance === 'Yes' || attendance === 'Maybe';
    await sendEmail(
      email,
      isGoing ? '✅ AI 共學聚 — 報名確認' : 'AI 共學聚 — 感謝填寫！',
      isGoing
        ? `嗨 ${name}！\n\n你已成功報名 AI 共學聚 🎉\n\n📅 時間：5/4（一）20:00 – 21:00\n📍 線上直播\n\n我們會在活動前一天和活動前 30 分鐘再次提醒你，記得準時上線！\n\n— AI 共學聚團隊 🧬`
        : `嗨 ${name}！\n\n感謝你填寫報名表單！我們會通知你下次活動資訊 📅\n\n— AI 共學聚團隊 🧬`
    );

    if (binding.rows[0]?.line_user_id) {
      await sendLine(binding.rows[0].line_user_id,
        `嗨 ${name}！報名成功 🎉\n\n📅 5/4（一）20:00–21:00\n活動前會再提醒你，到時見！🧬`);
    }

    res.json({ success: true, message: '報名成功！確認信已寄出' });
  } catch (err) {
    console.error('[Register Error]', err.message);
    res.status(500).json({ success: false, message: '系統錯誤，請稍後再試' });
  }
});

// LINE Webhook
const lineMiddleware = lineConfig.channelSecret
  ? line.middleware(lineConfig)
  : (req, res, next) => next();

async function forwardToStockSystem(body) {
  if (!process.env.STOCK_WEBHOOK_URL) return;
  try {
    await fetch(process.env.STOCK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[Forward Error]', err.message);
  }
}

app.post('/webhook', express.raw({ type: '*/*' }), lineMiddleware, async (req, res) => {
  res.sendStatus(200);
  const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  forwardToStockSystem(body);
  for (const event of body.events) {
    if (event.type === 'follow') {
      await lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text: `歡迎加入 AI 共學聚 🧬\n\n請傳送你填寫報名表單時使用的 Email\n我們就能在活動前自動通知你！\n\n例如：yourname@gmail.com`,
      });
    }
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const text = event.message.text.trim();
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (emailRe.test(text)) {
        const email = text.toLowerCase();
        let profile;
        try { profile = await lineClient.getProfile(userId); } catch (_) { profile = { displayName: '' }; }
        await pool.query(`
          INSERT INTO line_bindings (line_user_id, display_name, email)
          VALUES ($1,$2,$3) ON CONFLICT (line_user_id) DO UPDATE SET email=EXCLUDED.email
        `, [userId, profile.displayName, email]);
        const reg = await pool.query('SELECT * FROM registrations WHERE email=$1', [email]);
        if (reg.rows[0]) {
          await pool.query('UPDATE registrations SET line_user_id=$1 WHERE email=$2', [userId, email]);
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: `AI 共學聚 綁定成功 🎉\n\n${reg.rows[0].name} 你好！\n活動前我們會透過 LINE 提醒你，5/4 見！🧬` });
        } else {
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: `AI 共學聚 📋\n\nEmail 已記錄！\n請先完成報名表單，填寫相同的 Email，我們就能在活動前通知你 🔔\n\n報名連結：https://ai-signup-backend.onrender.com` });
        }
      } else {
        await lineClient.replyMessage(event.replyToken, { type: 'text', text: `嗨！請傳送你報名時使用的 Email 給我\n\n例如：yourname@gmail.com` });
      }
    }
  }
});

// Admin
function adminAuth(req, res, next) {
  const pw = req.query.pw || req.headers['x-admin-password'];
  if (pw !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });
  next();
}

app.get('/admin/api/registrations', adminAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM registrations ORDER BY created_at DESC');
  const rows = result.rows;
  res.json({
    stats: {
      total:        rows.length,
      attending:    rows.filter(r => r.attendance === 'Yes').length,
      maybe:        rows.filter(r => r.attendance === 'Maybe').length,
      notAttending: rows.filter(r => r.attendance === 'No').length,
      lineLinked:   rows.filter(r => r.line_user_id).length,
    },
    registrations: rows,
  });
});

app.post('/admin/api/send-reminder', adminAuth, async (req, res) => {
  await sendReminders(req.body.type || 'day');
  res.json({ success: true, message: '提醒已發送' });
});

async function sendReminders(type = 'day') {
  const result = await pool.query(`SELECT * FROM registrations WHERE attendance IN ('Yes','Maybe')`);
  const lineMsg = type === 'hour'
    ? `⏰ 還有 30 分鐘！\n\nAI 共學聚今晚 20:00 即將開始！\n準備好上線，等等見 🚀🧬`
    : `📅 明天提醒！\n\nAI 共學聚明天（5/4）晚上 20:00–21:00\n期待明天和大家共學！🧬`;
  const emailSubject = type === 'hour' ? '⏰ AI 共學聚 30 分鐘後開始！' : '📅 明天提醒：AI 共學聚';

  for (const reg of result.rows) {
    if (reg.line_user_id) {
      await sendLine(reg.line_user_id, `嗨 ${reg.name}！\n\n${lineMsg}`);
    } else {
      await sendEmail(reg.email, emailSubject, `嗨 ${reg.name}！\n\n${lineMsg}\n\n— AI 共學聚團隊 🧬`);
    }
  }
}

cron.schedule('0 20 3 5 *',  () => sendReminders('day'),  { timezone: 'Asia/Taipei' });
cron.schedule('30 19 4 5 *', () => sendReminders('hour'), { timezone: 'Asia/Taipei' });

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 伺服器啟動 port ${PORT}`);
    console.log(`   Email: ${process.env.EMAIL_USER || '未設定'}`);
    console.log(`   LINE:  ${lineClient ? '已設定' : '未設定'}`);
  });
}).catch(err => {
  console.error('DB 連線失敗:', err.message);
  process.exit(1);
});
