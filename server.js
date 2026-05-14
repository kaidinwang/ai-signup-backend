require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const path = require('path');
const https = require('https');

// Node 18 以下沒有 global fetch，用 https 模組替代
function httpsPost(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname,
      headers: { Authorization: `Bearer ${token}` }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}

// 當前場次日期（ISO 格式 YYYY-MM-DD）。Render 設 CURRENT_EVENT_DATE env var 來切換場次。
const CURRENT_EVENT_DATE = process.env.CURRENT_EVENT_DATE || '2026-05-18';

const app = express();
app.use(cors());
// /webhook 用 raw body（LINE 簽章驗證需要），其餘用 JSON
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  express.json()(req, res, next);
});
// 301 redirect 從 onrender.com 到自訂網域 event.cosmoseed.com.tw
// ⚠️ /webhook 排除：LINE Messaging API 用 POST，301 會轉 GET 把 webhook 弄壞
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  const host = (req.headers.host || '').toLowerCase();
  if (host === 'ai-signup-backend.onrender.com') {
    return res.redirect(301, `https://event.cosmoseed.com.tw${req.originalUrl}`);
  }
  next();
});

// 301 redirect /xxx.html → /xxx（canonical URL，避免 .html 與無副檔名雙重收錄）
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.endsWith('.html')) {
    const clean = req.path.slice(0, -5) || '/';
    const qIdx = req.originalUrl.indexOf('?');
    const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
    return res.redirect(301, clean + qs);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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
      next_event_interested BOOLEAN DEFAULT FALSE,
      attended      BOOLEAN DEFAULT FALSE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS line_bindings (
      line_user_id  TEXT PRIMARY KEY,
      display_name  TEXT,
      email         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Migration: 為既有表補上後台新增欄位
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS next_event_interested BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS attended BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS event_date TEXT`);
  // Backfill：既有資料（無 event_date）一律歸為 5/4 場次（共學聚首場）
  const backfilled = await pool.query(`UPDATE registrations SET event_date='2026-05-04' WHERE event_date IS NULL RETURNING id`);
  if (backfilled.rowCount > 0) console.log(`[DB] Backfilled event_date='2026-05-04' for ${backfilled.rowCount} legacy row(s)`);
  // Migration: 把 UNIQUE(email) 改成 UNIQUE(email, event_date)，讓同一 email 在不同場次有獨立 row（像訂單）
  await pool.query(`ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_email_key`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE registrations ADD CONSTRAINT registrations_email_event_unique UNIQUE (email, event_date);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  // 一次性修復：把所有 email 統一轉小寫，避免 LINE 綁定對不上
  const fixed = await pool.query(`
    UPDATE registrations SET email = LOWER(TRIM(email))
    WHERE email <> LOWER(TRIM(email))
    RETURNING email
  `);
  if (fixed.rowCount > 0) console.log(`[DB] Normalized ${fixed.rowCount} email(s) to lowercase`);
  await pool.query(`UPDATE line_bindings SET email = LOWER(TRIM(email)) WHERE email <> LOWER(TRIM(email))`);
  // 一次性修復：Kai 5/4 有出席但 UNIQUE(email) 時代被 UPSERT 蓋成 5/18，重建 5/4 row
  // Idempotent：5/4 row 一旦存在就不會再執行
  const kaiEmail = 'aloha_skyskysky@hotmail.com';
  const kai504 = await pool.query(`SELECT 1 FROM registrations WHERE email=$1 AND event_date='2026-05-04'`, [kaiEmail]);
  const kai518 = await pool.query(`SELECT * FROM registrations WHERE email=$1 AND event_date='2026-05-18'`, [kaiEmail]);
  if (kai504.rowCount === 0 && kai518.rows[0]) {
    const r = kai518.rows[0];
    await pool.query(`
      INSERT INTO registrations
        (name, email, attendance, interests, level, tools, tools_other,
         job_type, source, want_to_learn, subscribe_line, line_user_id,
         next_event_interested, attended, event_date, created_at)
      VALUES ($1,$2,'Yes',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,'2026-05-04',$13)
    `, [r.name, r.email, r.interests, r.level, r.tools, r.tools_other,
        r.job_type, r.source, r.want_to_learn, r.subscribe_line, r.line_user_id,
        r.next_event_interested, r.created_at]);
    await pool.query(
      `UPDATE registrations SET created_at='2026-05-14 18:00:00+08', attended=FALSE
       WHERE email=$1 AND event_date='2026-05-18'`,
      [kaiEmail]
    );
    console.log(`[DB] One-off: split ${kaiEmail} into 5/4 (attended) + 5/18 (re-registered 5/14)`);
  }
  // 診斷：列出疑似「5/4 報過 → 5/18 重報、但歷史被 UPSERT 蓋掉」的人
  // 條件：event_date=2026-05-18 且 created_at < 2026-05-14（5/18 頁面上架前就建的 row）
  const suspects = await pool.query(`
    SELECT id, name, email, created_at FROM registrations
    WHERE event_date='2026-05-18' AND created_at < '2026-05-14'
    ORDER BY created_at
  `);
  if (suspects.rowCount > 0) {
    console.log(`[DB] 疑似跨場次重報（5/18 row 但建立日早於 5/14，共 ${suspects.rowCount} 人）：`);
    for (const s of suspects.rows) {
      console.log(`  - id=${s.id} ${s.name} <${s.email}> created=${s.created_at.toISOString()}`);
    }
  } else {
    console.log('[DB] 無跨場次重報嫌疑帳號');
  }
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
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
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
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ registered: false });
  // 只檢查當前場次：之前場次報過不算重複
  const result = await pool.query(
    'SELECT name, attendance FROM registrations WHERE email=$1 AND event_date=$2',
    [email, CURRENT_EVENT_DATE]
  );
  if (result.rows[0]) {
    const r = result.rows[0];
    res.json({ registered: true, name: r.name, attendance: r.attendance });
  } else {
    res.json({ registered: false });
  }
});

app.post('/register', async (req, res) => {
  const {
    name, attendance,
    interest, tools, tools_other,
    level, job_type, source,
    want_to_learn, subscribe_line,
  } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();

  if (!name || !email) {
    return res.status(400).json({ success: false, message: '姓名和 Email 為必填' });
  }

  // 防呆：已報名直接回傳提示（只檢查當前場次，跨場次允許再報一次）
  const existing = await pool.query(
    'SELECT name, attendance, line_user_id FROM registrations WHERE email=$1 AND event_date=$2',
    [email, CURRENT_EVENT_DATE]
  );
  if (existing.rows[0]) {
    const reg = existing.rows[0];
    if (reg.line_user_id) {
      // 已綁 LINE → 推 LINE 提醒
      await sendLine(reg.line_user_id,
        `嗨 ${reg.name}！\n\n你已報名 5/18 AI 共學聚 ✅\n\n📅 5/18（一）20:00–21:30 線上見\n📌 主題：Claude Skills × Projects 入門實戰\n\n活動前 24 小時 + 30 分鐘會在這裡提醒你 🧬`
      );
    } else {
      // 未綁 LINE → Email 提醒並鼓勵加入 LINE@
      await sendEmail(
        email,
        '📋 你已報名 AI 共學聚！',
        `嗨 ${reg.name}！\n\n你已報名 5/18 AI 共學聚 ✅\n\n📅 5/18（一）20:00–21:30 線上\n📌 主題：Claude Skills × Projects 入門實戰，打造你的 AI 內容工作流\n\n📲 還沒加入 LINE OA 嗎？\n👉 https://lin.ee/9WduU6Y\nMeet 連結與活動提醒會優先在 LINE 通知！\n\n— AI 共學聚團隊 🧬`
      );
    }
    return res.json({ success: false, duplicate: true, name: reg.name, attendance: reg.attendance });
  }

  const interestStr = Array.isArray(interest) ? interest.join('、') : (interest || '');
  const toolsStr    = Array.isArray(tools)    ? tools.join('、')    : (tools    || '');

  try {
    await pool.query(`
      INSERT INTO registrations
        (name, email, attendance, interests, level, tools, tools_other, job_type, source, want_to_learn, subscribe_line, event_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (email, event_date) DO UPDATE SET
        name=EXCLUDED.name, attendance=EXCLUDED.attendance,
        interests=EXCLUDED.interests, level=EXCLUDED.level,
        tools=EXCLUDED.tools, tools_other=EXCLUDED.tools_other,
        job_type=EXCLUDED.job_type, source=EXCLUDED.source,
        want_to_learn=EXCLUDED.want_to_learn, subscribe_line=EXCLUDED.subscribe_line
    `, [name, email, attendance, interestStr, level||'', toolsStr, tools_other||'', job_type||'', source||'', want_to_learn||'', subscribe_line||'', CURRENT_EVENT_DATE]);

    // 嘗試連結已有的 LINE 綁定
    const binding = await pool.query('SELECT * FROM line_bindings WHERE email=$1', [email]);
    if (binding.rows[0]) {
      await pool.query('UPDATE registrations SET line_user_id=$1 WHERE email=$2', [binding.rows[0].line_user_id, email]);
    }

    res.json({ success: true, message: '報名成功！確認信已寄出' });

    // 寄信與 LINE 通知背景執行，不阻塞回應
    const isGoing = attendance === 'Yes' || attendance === 'Maybe';
    sendEmail(
      email,
      isGoing ? '✅ AI 共學聚 — 5/18 報名確認' : 'AI 共學聚 — 感謝填寫！',
      isGoing
        ? `嗨 ${name}！\n\n感謝你報名 5/18 AI 共學聚 🌱\n\n📅 5/18（一）20:00–21:30 線上\n📌 主題：Claude Skills × Projects 入門實戰，打造你的 AI 內容工作流\n\n📲 加入 LINE OA：https://lin.ee/9WduU6Y\nMeet 連結會在活動前 24 小時 + 30 分鐘透過 LINE 通知你！\n\n— AI 共學聚團隊 🧬`
        : `嗨 ${name}！\n\n感謝你填寫表單！下一場 5/18 開課，若之後想參加歡迎再回來填一次 📅\n\n— AI 共學聚團隊 🧬`
    );

    if (binding.rows[0]?.line_user_id) {
      sendLine(binding.rows[0].line_user_id,
        `嗨 ${name}！\n\n你已報名 5/18 AI 共學聚 ✅\n\n📅 5/18（一）20:00–21:30 線上見\n📌 主題：Claude Skills × Projects 入門實戰\n\n活動前會在這裡提醒你 🧬`);
    }
  } catch (err) {
    console.error('[Register Error]', err.message);
    res.status(500).json({ success: false, message: '系統錯誤，請稍後再試' });
  }
});

// ─── LINE Login OAuth ────────────────────────────────────────────────────────

// Step 1: 導向 LINE 授權頁
app.get('/line-login', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).send('缺少 email');
  const state = Buffer.from(email).toString('base64');
  const callbackUrl = `${process.env.BASE_URL || 'https://ai-signup-backend.onrender.com'}/line-callback`;
  const url = new URL('https://access.line.me/oauth2/v2.1/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.LINE_LOGIN_CHANNEL_ID);
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'profile openid');
  url.searchParams.set('bot_prompt', 'aggressive');
  res.redirect(url.toString());
});

// Step 2: LINE 授權完回到這裡
app.get('/line-callback', async (req, res) => {
  console.log('[LINE Callback] query:', JSON.stringify(req.query));
  const { code, state } = req.query;
  if (!code || !state) return res.redirect('/?bound=fail');

  const email = Buffer.from(state, 'base64').toString('utf8');
  const callbackUrl = `${process.env.BASE_URL || 'https://ai-signup-backend.onrender.com'}/line-callback`;

  try {
    // 用 code 換 access token
    const token = await httpsPost('https://api.line.me/oauth2/v2.1/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      client_id: process.env.LINE_LOGIN_CHANNEL_ID,
      client_secret: process.env.LINE_LOGIN_CHANNEL_SECRET,
    });
    console.log('[LINE Login] token response:', JSON.stringify(token));
    if (!token.access_token) {
      const reason = encodeURIComponent(token.error_description || token.error || 'no token');
      return res.redirect('/?bound=fail&reason=' + reason);
    }

    // 取得 LINE 使用者資料
    const profile = await httpsGet('https://api.line.me/v2/profile', token.access_token);
    const userId = profile.userId;
    const displayName = profile.displayName;

    // 寫入 DB 綁定
    await pool.query(`
      INSERT INTO line_bindings (line_user_id, display_name, email)
      VALUES ($1,$2,$3) ON CONFLICT (line_user_id) DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name
    `, [userId, displayName, email.toLowerCase()]);

    const reg = await pool.query('SELECT * FROM registrations WHERE email=$1', [email.toLowerCase()]);
    if (reg.rows[0]) {
      await pool.query('UPDATE registrations SET line_user_id=$1 WHERE email=$2', [userId, email.toLowerCase()]);
      await sendLine(userId,
        `已為你完成綁定 ✅\n\n${reg.rows[0].name} 你好！\n5/18（一）20:00 AI 共學聚見 🌱\nMeet 連結與提醒會在這裡通知你`
      );
      res.redirect('/?bound=success&name=' + encodeURIComponent(reg.rows[0].name));
    } else {
      // 外部報名者（如活動通）：line_bindings 已寫入，回成功頁不要求重填站內表單
      await sendLine(userId,
        `已為你完成綁定 ✅\n\n5/18（一）20:00 AI 共學聚見 🌱\nMeet 連結與提醒會在這裡通知你`
      );
      res.redirect('/?bound=success');
    }
  } catch (err) {
    console.error('[LINE Login Error]', err.message);
    res.redirect('/?bound=fail&reason=' + encodeURIComponent(err.message));
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
      const userId = event.source.userId;
      const reg = await pool.query('SELECT name FROM registrations WHERE line_user_id=$1', [userId]);
      if (reg.rows[0]) {
        await lineClient.replyMessage(event.replyToken, {
          type: 'text',
          text: `歡迎回來，${reg.rows[0].name}！🧬\n\n🧰 AI 工具箱已上線（持續更新中）\nhttps://cosmoseed.com.tw\n\n📅 每月 2 次 AI 共學聚\n請點選最新課程報名\nhttps://event.cosmoseed.com.tw/courses\n\n— Din 🌱`,
          quickReply: {
            items: [
              { type: 'action', action: { type: 'uri', label: '🧰 開啟工具箱', uri: 'https://cosmoseed.com.tw' } },
              { type: 'action', action: { type: 'uri', label: '📅 看課程詳情', uri: 'https://event.cosmoseed.com.tw/courses' } },
            ],
          },
        });
      } else {
        await lineClient.replyMessage(event.replyToken, {
          type: 'text',
          text: `歡迎加入 宇宙種子 CosmoSeed AI 🧬\n\n幫品牌行銷人準備了見面禮 🎁\n\n🧰【AI 工具箱】100% 繁中、免費使用\n我親自篩選 + 評分的行銷利器\n附「使用情境 × 建議流程」\n省下你找工具、試錯的時間\n\n👉 立即開啟\nhttps://cosmoseed.com.tw\n\n────\n\n📅 每月 2 次 AI 共學聚\n請點選最新課程報名\nhttps://event.cosmoseed.com.tw/courses\n\n— Din 🌱`,
          quickReply: {
            items: [
              { type: 'action', action: { type: 'uri', label: '🧰 開啟工具箱', uri: 'https://cosmoseed.com.tw' } },
              { type: 'action', action: { type: 'uri', label: '📅 看課程詳情', uri: 'https://event.cosmoseed.com.tw/courses' } },
              { type: 'action', action: { type: 'message', label: '📌 我要綁定通知', text: '我要綁定' } },
            ],
          },
        });
      }
    }
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const text = event.message.text.trim();
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      // 檢查使用者是否已綁定（line_bindings 或 registrations 任一有記錄）
      const alreadyBound = await pool.query(`
        SELECT 1 FROM line_bindings WHERE line_user_id=$1
        UNION ALL
        SELECT 1 FROM registrations WHERE line_user_id=$1
        LIMIT 1
      `, [userId]);
      if (alreadyBound.rows[0]) {
        console.log('[LINE] Skip auto-reply for already-bound user:', userId);
        continue;
      }

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
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: `已為你完成綁定 ✅\n\n${reg.rows[0].name} 你好！\n5/18（一）20:00 AI 共學聚見 🌱\nMeet 連結與提醒會在這裡通知你` });
        } else {
          // 外部報名者（如活動通）：line_bindings 已寫入，直接通知綁定成功，不要求重填站內表單
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: `已為你完成綁定 ✅\n\n5/18（一）20:00 AI 共學聚見 🌱\nMeet 連結與提醒會在這裡通知你` });
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
  const validPasswords = (process.env.ADMIN_PASSWORD || '')
    .split(',').map(p => p.trim()).filter(Boolean);
  if (!validPasswords.includes(pw)) return res.status(401).json({ error: '密碼錯誤' });
  next();
}

app.get('/admin/api/registrations', adminAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM registrations ORDER BY created_at DESC');
  const rows = result.rows;
  const bySource = {};
  const byEvent = {};
  for (const r of rows) {
    const ch = r.source || '(未標記)';
    bySource[ch] = (bySource[ch] || 0) + 1;
    const ev = r.event_date || '(未標記)';
    byEvent[ev] = (byEvent[ev] || 0) + 1;
  }
  res.json({
    stats: {
      total:        rows.length,
      attending:    rows.filter(r => r.attendance === 'Yes').length,
      maybe:        rows.filter(r => r.attendance === 'Maybe').length,
      notAttending: rows.filter(r => r.attendance === 'No').length,
      lineLinked:   rows.filter(r => r.line_user_id).length,
      nextEvent:    rows.filter(r => r.next_event_interested).length,
      attended:     rows.filter(r => r.attended).length,
      bySource,
      byEvent,
      currentEvent: CURRENT_EVENT_DATE,
    },
    registrations: rows,
  });
});

app.patch('/admin/api/registrations/:id', adminAuth, async (req, res) => {
  const fields = [];
  const values = [];
  let idx = 1;
  if (req.body.source !== undefined) {
    fields.push(`source=$${idx++}`);
    values.push(req.body.source || null);
  }
  if (req.body.next_event_interested !== undefined) {
    fields.push(`next_event_interested=$${idx++}`);
    values.push(!!req.body.next_event_interested);
  }
  if (req.body.attended !== undefined) {
    fields.push(`attended=$${idx++}`);
    values.push(!!req.body.attended);
  }
  if (req.body.event_date !== undefined) {
    fields.push(`event_date=$${idx++}`);
    values.push(req.body.event_date || null);
  }
  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  await pool.query(`UPDATE registrations SET ${fields.join(', ')} WHERE id=$${idx}`, values);
  res.json({ success: true });
});

app.delete('/admin/api/registrations/:id', adminAuth, async (req, res) => {
  await pool.query('DELETE FROM registrations WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

app.post('/admin/api/send-reminder', adminAuth, async (req, res) => {
  await sendReminders(req.body.type || 'day');
  res.json({ success: true, message: '提醒已發送' });
});

app.get('/admin/api/broadcast', adminAuth, async (req, res) => {
  if (!lineClient) return res.status(500).json({ error: 'LINE 未設定' });
  const msg = req.query.msg;
  if (!msg) return res.status(400).json({ error: 'Missing ?msg= query parameter (URL-encoded text)' });
  try {
    await lineClient.broadcast({ type: 'text', text: msg });
    res.json({ success: true, message: 'Broadcast sent to all OA friends', preview: msg });
  } catch (err) {
    console.error('[Broadcast Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/binding-stats', adminAuth, async (req, res) => {
  const renderRows = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE attendance IN ('Yes','Maybe')) AS render_attending,
      COUNT(*) FILTER (WHERE attendance IN ('Yes','Maybe') AND line_user_id IS NOT NULL) AS render_attending_bound
    FROM registrations
    WHERE event_date=$1
  `, [CURRENT_EVENT_DATE]);
  const externalRows = await pool.query(`
    SELECT COUNT(*) AS external_bound
    FROM line_bindings lb
    LEFT JOIN registrations r ON lb.email = r.email
    WHERE r.id IS NULL
  `);
  const r = renderRows.rows[0];
  const e = externalRows.rows[0];
  res.json({
    render: {
      attending: parseInt(r.render_attending),
      bound: parseInt(r.render_attending_bound),
      unbound: parseInt(r.render_attending) - parseInt(r.render_attending_bound),
    },
    external: {
      bound: parseInt(e.external_bound),
      note: '純活動通沒綁的人不在 DB，需用「活動通總報名數 − bound」推算',
    },
  });
});

async function sendReminders(type = 'day') {
  // 只通知當前場次的報名者，避免誤發給之前場次已報名但這次沒報的人
  const result = await pool.query(
    `SELECT * FROM registrations WHERE attendance IN ('Yes','Maybe') AND event_date=$1`,
    [CURRENT_EVENT_DATE]
  );
  // ⚠️ 下一場活動前(5/18 前)請主辦人更新此處的 Meet 連結與當晚 AI 工具準備事項
  const lineMsg = type === 'hour'
    ? `⏰ 還有 30 分鐘！\n\nAI 共學聚今晚 20:00 即將開始 🚀\n📌 Claude Skills × Projects 入門實戰\n\nMeet 連結與上課準備事項，請查看前一則 LINE 通知 📌\n\n🔔 19:50 開放進入教室\n20:00 準時開始（21:30 結束）\n\n等等見！🧬`
    : `📅 明天提醒！\n\nAI 共學聚明天晚上 20:00–21:30\n📌 Claude Skills × Projects 入門實戰\n　　打造你的 AI 內容工作流\n\n期待明天和大家共學！🧬`;
  const emailSubject = type === 'hour' ? '⏰ AI 共學聚 30 分鐘後開始！' : '📅 明天提醒：AI 共學聚';

  for (const reg of result.rows) {
    if (reg.line_user_id) {
      await sendLine(reg.line_user_id, `嗨 ${reg.name}！\n\n${lineMsg}`);
    } else {
      await sendEmail(reg.email, emailSubject, `嗨 ${reg.name}！\n\n${lineMsg}\n\n— AI 共學聚團隊 🧬`);
    }
  }

  // 外部報名者（如活動通）：line_bindings 有但不在 registrations，純 LINE 提醒
  const externalBindings = await pool.query(`
    SELECT lb.line_user_id, lb.display_name
    FROM line_bindings lb
    LEFT JOIN registrations r ON lb.email = r.email
    WHERE r.id IS NULL AND lb.line_user_id IS NOT NULL
  `);
  for (const binding of externalBindings.rows) {
    const greeting = binding.display_name ? `嗨 ${binding.display_name}！\n\n` : '嗨！\n\n';
    await sendLine(binding.line_user_id, `${greeting}${lineMsg}`);
  }
}

// 5/18 活動：前一天 5/17 20:00 day 提醒、當天 5/18 19:30 hour 提醒
// ⚠️ 5/18 活動前（建議 18:00–19:00）請先用 /admin/api/broadcast?msg= 發出 Meet 連結 + AI 工具準備事項，
//    這兩個 cron 訊息只是時間提醒，會引導用戶看「前一則 LINE 通知」找連結
cron.schedule('0 20 17 5 *',  () => sendReminders('day'),  { timezone: 'Asia/Taipei' });
cron.schedule('30 19 18 5 *', () => sendReminders('hour'), { timezone: 'Asia/Taipei' });

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 伺服器啟動 port ${PORT}`);
    console.log(`   Email: ${process.env.EMAIL_USER || '未設定'}`);
    console.log(`   LINE:  ${lineClient ? '已設定' : '未設定'}`);
    console.log(`   LINE Login Channel ID: ${process.env.LINE_LOGIN_CHANNEL_ID || '❌ 未設定'}`);
    console.log(`   LINE Login Channel Secret: ${process.env.LINE_LOGIN_CHANNEL_SECRET ? '✅ 已設定' : '❌ 未設定'}`);
  });
}).catch(err => {
  console.error('DB 連線失敗:', err.message);
  process.exit(1);
});
