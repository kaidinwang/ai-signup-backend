require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database ────────────────────────────────────────────────────────────────
const db = new Database('registrations.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS registrations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS line_bindings (
    line_user_id  TEXT PRIMARY KEY,
    display_name  TEXT,
    email         TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── LINE Client ─────────────────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};
const lineClient = lineConfig.channelAccessToken
  ? new line.Client(lineConfig)
  : null;

// ─── Email Transporter ───────────────────────────────────────────────────────
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

function linkLineToRegistration(email, lineUserId) {
  db.prepare('UPDATE registrations SET line_user_id = ? WHERE email = ?')
    .run(lineUserId, email);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /register — 接收表單送出
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

  const interestStr = Array.isArray(interest) ? interest.join('、') : (interest || '');
  const toolsStr    = Array.isArray(tools)    ? tools.join('、')    : (tools    || '');

  try {
    db.prepare(`
      INSERT OR REPLACE INTO registrations
        (name, email, attendance, interests, level, tools, tools_other, job_type, source, want_to_learn, subscribe_line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, email, attendance, interestStr, level || '', toolsStr, tools_other || '', job_type || '', source || '', want_to_learn || '', subscribe_line || '');

    // 嘗試連結已有的 LINE 綁定
    const binding = db.prepare('SELECT * FROM line_bindings WHERE email = ?').get(email);
    if (binding) linkLineToRegistration(email, binding.line_user_id);

    // 寄確認 Email
    const isGoing = attendance === 'Yes' || attendance === 'Maybe';
    await sendEmail(
      email,
      isGoing ? '✅ AI 共學聚 — 報名確認' : 'AI 共學聚 — 感謝填寫！',
      isGoing
        ? `嗨 ${name}！\n\n你已成功報名 AI 共學聚 🎉\n\n📅 時間：5/4（一）20:00 – 21:00\n📍 線上直播\n\n我們會在活動前一天和活動前 30 分鐘再次提醒你，記得準時上線！\n\n有任何問題歡迎回覆此信或私訊我們的 Facebook。\n\n— AI 共學聚團隊 🧬`
        : `嗨 ${name}！\n\n感謝你填寫報名表單！雖然這次無法出席，我們會記得通知你下次活動資訊 📅\n\n— AI 共學聚團隊 🧬`
    );

    // 傳 LINE 歡迎訊息（如果已綁定）
    if (binding?.line_user_id) {
      await sendLine(
        binding.line_user_id,
        `嗨 ${name}！報名成功 🎉\n\n📅 5/4（一）20:00–21:00\n活動前會再提醒你，到時見！🧬`
      );
    }

    res.json({ success: true, message: '報名成功！確認信已寄出' });
  } catch (err) {
    console.error('[Register Error]', err.message);
    if (err.message.includes('UNIQUE')) {
      res.status(400).json({ success: false, message: '此 Email 已報名過了！若需修改請聯絡主辦人' });
    } else {
      res.status(500).json({ success: false, message: '系統錯誤，請稍後再試' });
    }
  }
});

// POST /webhook — LINE Bot Webhook
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);

  for (const event of req.body.events) {
    if (event.type === 'follow') {
      // 有人加入官方帳號
      await lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text: `歡迎加入 AI 共學聚 🧬\n\n請傳送你報名時使用的 Email，我們就能在活動前自動通知你！\n\n例如：yourname@gmail.com`,
      });
    }

    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const text   = event.message.text.trim();
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (emailRe.test(text)) {
        const email = text.toLowerCase();
        let profile;
        try { profile = await lineClient.getProfile(userId); } catch (_) { profile = { displayName: '' }; }

        db.prepare(`
          INSERT OR REPLACE INTO line_bindings (line_user_id, display_name, email)
          VALUES (?, ?, ?)
        `).run(userId, profile.displayName, email);

        const reg = db.prepare('SELECT * FROM registrations WHERE email = ?').get(email);
        if (reg) {
          linkLineToRegistration(email, userId);
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `綁定成功 🎉 ${reg.name} 你好！\n活動前我們會透過 LINE 提醒你，5/4 見！`,
          });
        } else {
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `Email 已記錄！\n請先完成網頁報名，我們就能在活動前通知你 📋\n\n確認 Email 要和報名時填的一致喔`,
          });
        }
      } else {
        await lineClient.replyMessage(event.replyToken, {
          type: 'text',
          text: `嗨！請傳送你報名時使用的 Email 給我，格式如：\n\nyourname@gmail.com`,
        });
      }
    }
  }
});

// ─── Admin API ───────────────────────────────────────────────────────────────

// 簡單密碼保護
function adminAuth(req, res, next) {
  const pw = req.query.pw || req.headers['x-admin-password'];
  if (pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密碼錯誤' });
  }
  next();
}

app.get('/admin/api/registrations', adminAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM registrations ORDER BY created_at DESC').all();
  const stats = {
    total:       rows.length,
    attending:   rows.filter(r => r.attendance === 'Yes').length,
    maybe:       rows.filter(r => r.attendance === 'Maybe').length,
    notAttending:rows.filter(r => r.attendance === 'No').length,
    lineLinked:  rows.filter(r => r.line_user_id).length,
  };
  res.json({ stats, registrations: rows });
});

// 手動發送提醒
app.post('/admin/api/send-reminder', adminAuth, async (req, res) => {
  const { type } = req.body; // 'day' | 'hour'
  await sendReminders(type || 'day');
  res.json({ success: true, message: `提醒已發送（${type}）` });
});

// ─── 提醒邏輯 ────────────────────────────────────────────────────────────────
async function sendReminders(type = 'day') {
  const rows = db.prepare(
    `SELECT * FROM registrations WHERE attendance IN ('Yes', 'Maybe')`
  ).all();

  const lineMsg = type === 'hour'
    ? `⏰ 還有 30 分鐘！\n\nAI 共學聚今晚 20:00 即將開始！\n準備好上線，等等見 🚀🧬`
    : `📅 明天提醒！\n\nAI 共學聚明天（5/4）晚上 20:00–21:00\n期待明天和大家共學！🧬`;

  const emailSubject = type === 'hour'
    ? '⏰ AI 共學聚 30 分鐘後開始！'
    : '📅 明天提醒：AI 共學聚';

  console.log(`[Reminder] 發送 ${type} 提醒給 ${rows.length} 人`);

  for (const reg of rows) {
    const body = `嗨 ${reg.name}！\n\n${lineMsg}\n\n— AI 共學聚團隊 🧬`;
    await sendEmail(reg.email, emailSubject, body);
    if (reg.line_user_id) {
      await sendLine(reg.line_user_id, `嗨 ${reg.name}！\n\n${lineMsg}`);
    }
  }
}

// ─── Cron 排程（台北時區）────────────────────────────────────────────────────
// 活動前一天晚上 20:00 發送提醒（5/3 20:00）
cron.schedule('0 20 3 5 *', () => sendReminders('day'),  { timezone: 'Asia/Taipei' });
// 活動當天 19:30 發送 30 分鐘前提醒
cron.schedule('30 19 4 5 *', () => sendReminders('hour'), { timezone: 'Asia/Taipei' });

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 AI 共學聚後端啟動！`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   後台管理：http://localhost:${PORT}/admin.html`);
  console.log(`   Email: ${process.env.EMAIL_USER || '（未設定）'}`);
  console.log(`   LINE:  ${lineClient ? '已設定' : '（未設定）'}\n`);
});
