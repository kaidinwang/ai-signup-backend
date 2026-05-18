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
const MEET_URL = process.env.MEET_URL || 'https://meet.google.com/ovp-rxuf-hma';

// 活動「進行中時段」：19:30–21:30 Asia/Taipei，這段時間內的報名 → 確認信/LINE 立即帶 Meet URL
function isEventLive(now = new Date()) {
  const tz = 'Asia/Taipei';
  const today = now.toLocaleDateString('en-CA', { timeZone: tz });
  if (today !== CURRENT_EVENT_DATE) return false;
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  return hhmm >= '19:30' && hhmm <= '21:30';
}

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
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS bind_reminded_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE line_bindings ADD COLUMN IF NOT EXISTS awaiting_attendance_email BOOLEAN DEFAULT FALSE`);
  // Backfill：既有資料（無 event_date）一律歸為 5/4 場次（共學聚首場）
  const backfilled = await pool.query(`UPDATE registrations SET event_date='2026-05-04' WHERE event_date IS NULL RETURNING id`);
  if (backfilled.rowCount > 0) console.log(`[DB] Backfilled event_date='2026-05-04' for ${backfilled.rowCount} legacy row(s)`);
  // Migration: 把 UNIQUE(email) 改成 UNIQUE(email, event_date)，讓同一 email 在不同場次有獨立 row（像訂單）
  // 用 pg_constraint 預先檢查，避免 constraint/index 殘留導致 duplicate_table error
  await pool.query(`ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_email_key`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'registrations_email_event_unique'
      ) THEN
        ALTER TABLE registrations ADD CONSTRAINT registrations_email_event_unique UNIQUE (email, event_date);
      END IF;
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

// 一鍵 LINE 綁定連結（OAuth 動態連結，比 lin.ee 靜態好：登入 → 同意 → 加好友 → 自動寫入 line_bindings + registrations）
function buildBindUrl(email) {
  const base = process.env.BASE_URL || 'https://event.cosmoseed.com.tw';
  return `${base}/line-login?email=${encodeURIComponent(email)}`;
}

function buildBindReminderEmail(name, email) {
  const url = buildBindUrl(email);
  return {
    subject: '💻 AI 共學聚 5/18 Meet 連結 — 今晚 20:00 線上見',
    text: `嗨 ${name}！\n\n你已報名 5/18 AI 共學聚 ✅\n\n📅 5/18（一）20:00–21:30 線上\n📌 主題：Claude AI 入門實戰｜小白也能快速做出精美社群內容\n\n💻 Meet 連結：\n${MEET_URL}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📋 上課前請準備：\n1. 筆電（手機體驗會差很多）\n2. Claude 帳號（沒有可先註冊 claude.ai）\n\n────\n\n📲 想接收下次活動的 LINE 提醒？\n回我們的官方 LINE OA 完成綁定（30 秒）：\n${url}\n或在 LINE OA 對話直接傳這個 Email 給我們也行 🌱\n\n— AI 共學聚團隊 🧬`,
  };
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
        `嗨 ${reg.name}！\n\n你已報名 5/18 AI 共學聚 ✅\n\n📅 5/18（一）20:00–21:30 線上\n📌 主題：Claude Skills × Projects 入門實戰，打造你的 AI 內容工作流\n\n📲 還沒綁定 LINE 嗎？點下面連結一鍵綁定（30 秒）：\n${buildBindUrl(email)}\n\nMeet 連結與活動提醒會優先在 LINE 通知！\n\n— AI 共學聚團隊 🧬`
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
        ? `嗨 ${name}！\n\n感謝你報名 5/18 AI 共學聚 🌱\n\n📅 5/18（一）20:00–21:30 線上\n📌 主題：Claude AI 入門實戰｜小白也能快速做出精美社群內容\n\n💻 Meet 連結：\n${MEET_URL}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📲 完成 LINE 綁定（活動前 30 分鐘還會在 LINE 提醒你）：\n${buildBindUrl(email)}\n👆 點下去登入 LINE → 同意 → 加好友 → 自動完成，30 秒內搞定\n\n📋 上課前請準備：\n1. 筆電（手機體驗會差很多）\n2. Claude 帳號（沒有可先註冊 claude.ai）\n\n— AI 共學聚團隊 🧬`
        : `嗨 ${name}！\n\n感謝你填寫表單！下一場 5/18 開課，若之後想參加歡迎再回來填一次 📅\n\n— AI 共學聚團隊 🧬`
    );

    if (binding.rows[0]?.line_user_id) {
      sendLine(binding.rows[0].line_user_id,
        `嗨 ${name}！\n\n你已報名 5/18 AI 共學聚 ✅\n\n📅 5/18（一）20:00–21:30 線上見\n📌 主題：Claude AI 入門實戰｜小白也能快速做出精美社群內容\n\n💻 Meet 連結：\n${MEET_URL}\n🔔 19:50 開放、20:00 準時開始\n\n活動前 30 分鐘會在這裡再提醒你一次 🧬`);
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
              { type: 'action', action: { type: 'message', label: '📌 綁定課程通知', text: '我要綁定' } },
            ],
          },
        });
      }
    }
    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const text = event.message.text.trim();
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      // 線上點名：「報到」keyword（限當前場次 CURRENT_EVENT_DATE）— 放在 alreadyBound 之前，bound 用戶也能觸發
      if (/^(報到|簽到|\+1|我來了|我到了)$/i.test(text)) {
        const bindRow = await pool.query(
          `SELECT email FROM line_bindings WHERE line_user_id=$1 AND email IS NOT NULL
           UNION
           SELECT email FROM registrations WHERE line_user_id=$1 AND email IS NOT NULL
           LIMIT 1`,
          [userId]
        );
        const knownEmail = bindRow.rows[0]?.email || null;

        if (knownEmail) {
          const exist = await pool.query(
            `SELECT id, name FROM registrations WHERE line_user_id=$1 AND event_date=$2`,
            [userId, CURRENT_EVENT_DATE]
          );
          let name;
          if (exist.rows[0]) {
            await pool.query(`UPDATE registrations SET attended=TRUE WHERE id=$1`, [exist.rows[0].id]);
            name = exist.rows[0].name;
          } else {
            const other = await pool.query(
              `SELECT name FROM registrations WHERE email=$1 ORDER BY created_at DESC LIMIT 1`,
              [knownEmail]
            );
            name = other.rows[0]?.name || '(LINE 來賓)';
            await pool.query(
              `INSERT INTO registrations (name, email, attendance, event_date, line_user_id, attended)
               VALUES ($1,$2,'Yes',$3,$4,TRUE)
               ON CONFLICT (email, event_date) DO UPDATE SET attended=TRUE, line_user_id=EXCLUDED.line_user_id`,
              [name, knownEmail, CURRENT_EVENT_DATE, userId]
            );
          }
          await pool.query(`UPDATE line_bindings SET awaiting_attendance_email=FALSE WHERE line_user_id=$1`, [userId]);
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `✅ 報到成功！\n\n${name} 你好！\n活動結束後簡報會寄到：\n📧 ${knownEmail}\n\n如果 Email 要改、直接傳新的 Email 給我`,
          });
          continue;
        } else {
          await pool.query(
            `INSERT INTO line_bindings (line_user_id, awaiting_attendance_email) VALUES ($1, TRUE)
             ON CONFLICT (line_user_id) DO UPDATE SET awaiting_attendance_email=TRUE`,
            [userId]
          );
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `👋 找不到你的 Email 紀錄\n\n請傳你的 Email 給我（例如：yourname@gmail.com）\n活動結束後我會把簡報寄到那裡 📧`,
          });
          continue;
        }
      }

      // walk-in 報到等 email：若 awaiting_attendance_email=TRUE 且使用者傳 email-format 訊息，視為 walk-in 報到
      if (emailRe.test(text)) {
        const awaiting = await pool.query(
          `SELECT awaiting_attendance_email FROM line_bindings WHERE line_user_id=$1`,
          [userId]
        );
        if (awaiting.rows[0]?.awaiting_attendance_email) {
          const email = text.toLowerCase();
          let profile;
          try { profile = await lineClient.getProfile(userId); } catch (_) { profile = { displayName: '(LINE 來賓)' }; }
          await pool.query(
            `INSERT INTO registrations (name, email, attendance, event_date, line_user_id, attended)
             VALUES ($1,$2,'Yes',$3,$4,TRUE)
             ON CONFLICT (email, event_date) DO UPDATE SET attended=TRUE, line_user_id=EXCLUDED.line_user_id`,
            [profile.displayName || '(LINE 來賓)', email, CURRENT_EVENT_DATE, userId]
          );
          await pool.query(
            `UPDATE line_bindings SET awaiting_attendance_email=FALSE, email=$2, display_name=COALESCE(display_name,$3) WHERE line_user_id=$1`,
            [userId, email, profile.displayName || null]
          );
          await lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `✅ 已記下！\n\n活動結束後簡報會寄到：\n📧 ${email}\n\n等等課程見 🚀`,
          });
          continue;
        }
      }

      // 檢查使用者是否已綁定（line_bindings 或 registrations 任一有記錄）
      const alreadyBound = await pool.query(`
        SELECT 1 FROM line_bindings WHERE line_user_id=$1 AND email IS NOT NULL AND email <> ''
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

// 課後問卷：寄給 5/18 報名 Yes/Maybe 但「沒報到」的人（避免跟簡報+問卷信重複）
// 用法：POST /admin/api/send-survey-only?pw=...&event=2026-05-18[&survey=<URL>][&dry=1]
app.post('/admin/api/send-survey-only', adminAuth, async (req, res) => {
  try {
    const eventDate = req.query.event || CURRENT_EVENT_DATE;
    const dryRun = req.query.dry === '1';
    const surveyUrl = req.query.survey || 'https://forms.gle/VA4JDwSvbg13scB58';

    const result = await pool.query(
      `SELECT id, name, email FROM registrations
       WHERE event_date=$1 AND attendance IN ('Yes','Maybe')
         AND (attended=FALSE OR attended IS NULL)
         AND email IS NOT NULL AND email <> ''
       ORDER BY name ASC`,
      [eventDate]
    );

    const sent = [];
    const subject = `📝 AI 共學聚 ${eventDate} 課後問卷 — 給我們 2 分鐘 🌱`;
    for (const reg of result.rows) {
      const text = `嗨 ${reg.name}！\n\n謝謝你報名 5/18 AI 共學聚 🌱\n\n如果你今晚有參與課程、想請你花 2 分鐘填一下回饋\n你的意見會幫助我們把下一場做得更好 💚\n\n📝 課後問卷：\n${surveyUrl}\n\n下一場 6/1（一）20:00，5/25 開放報名：\nhttps://event.cosmoseed.com.tw/courses\n\n— Din Din Wang 🧬\nAI 共學聚團隊`;
      if (!dryRun) await sendEmail(reg.email, subject, text);
      sent.push({ id: reg.id, name: reg.name, email: reg.email });
    }

    // 副件給 admin
    const adminEmail = process.env.EMAIL_USER;
    if (!dryRun && adminEmail) {
      const summary = `本場課後問卷信已寄出 ${sent.length} 封（不含 attended=TRUE 已收簡報信的人）\n\n📝 問卷連結：\n${surveyUrl}\n\n📝 收件名單：\n${sent.map((s, i) => `${i + 1}. ${s.name} <${s.email}>`).join('\n')}\n\n— AI 共學聚自動寄送 🧬`;
      await sendEmail(adminEmail, `📝 [副件] ${eventDate} 課後問卷已寄出 (${sent.length} 人)`, summary);
    }

    console.log(`[SurveyOnly] ${dryRun ? '(dry-run) ' : ''}event=${eventDate} sent=${sent.length}`);
    res.json({ success: true, dryRun, eventDate, surveyUrl, count: sent.length, recipients: sent });
  } catch (err) {
    console.error('[Send Survey Only Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 活動後寄簡報：對當前場次 attended=TRUE 的人批次寄信
// 用法：POST /admin/api/send-slides?pw=...&event=2026-05-18&url=<簡報URL>[&dry=1]
app.post('/admin/api/send-slides', adminAuth, async (req, res) => {
  try {
    const eventDate = req.query.event || CURRENT_EVENT_DATE;
    const slidesUrl = req.query.url || req.body?.url;
    const dryRun = req.query.dry === '1';
    if (!slidesUrl) return res.status(400).json({ error: 'Missing ?url= (slides URL)' });

    const result = await pool.query(
      `SELECT id, name, email FROM registrations
       WHERE event_date=$1 AND attended=TRUE
         AND email IS NOT NULL AND email <> ''
       ORDER BY name ASC`,
      [eventDate]
    );

    const surveyUrl = req.query.survey || 'https://forms.gle/VA4JDwSvbg13scB58';
    const sent = [];
    const subject = `📊 AI 共學聚 ${eventDate} — 簡報 + 課後問卷`;
    for (const reg of result.rows) {
      const text = `嗨 ${reg.name}！\n\n謝謝你今晚參與 5/18 AI 共學聚 — Claude AI 入門實戰 🌱\n\n📊 本場簡報：\n${slidesUrl}\n\n📝 課後問卷（2 分鐘）：\n${surveyUrl}\n你的回饋會幫助我們把下一場做得更好 💚\n\n下一場 6/1（一）20:00，5/25 開放報名：\nhttps://event.cosmoseed.com.tw/courses\n\n— Din Din Wang 🧬\nAI 共學聚團隊`;
      if (!dryRun) await sendEmail(reg.email, subject, text);
      sent.push({ id: reg.id, name: reg.name, email: reg.email });
    }
    // 寄一份摘要副件給 admin（EMAIL_USER）
    const adminEmail = process.env.EMAIL_USER;
    if (!dryRun && adminEmail) {
      const summary = `本場簡報已寄出 ${sent.length} 封 ✅\n\n📊 簡報連結：\n${slidesUrl}\n\n📝 收件名單（attended=TRUE）：\n${sent.map((s, i) => `${i + 1}. ${s.name} <${s.email}>`).join('\n')}\n\n— AI 共學聚自動寄送 🧬`;
      await sendEmail(adminEmail, `📊 [副件] AI 共學聚 ${eventDate} 簡報已寄出 (${sent.length} 人)`, summary);
    }

    console.log(`[Slides] ${dryRun ? '(dry-run) ' : ''}event=${eventDate} sent=${sent.length}`);
    res.json({ success: true, dryRun, eventDate, slidesUrl, count: sent.length, recipients: sent });
  } catch (err) {
    console.error('[Send Slides Error]', err.message);
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
    ? `⏰ 還有 30 分鐘！\n\nAI 共學聚今晚 20:00 即將開始 🚀\n📌 主題：Claude AI 入門實戰｜小白也能快速做出精美社群內容\n\n💻 Meet 連結：\n${MEET_URL}\n\n🔔 19:50 開放進入教室\n20:00 準時開始（21:30 結束）\n\n📋 記得準備：筆電 + Claude 帳號（claude.ai）\n\n等等見！🧬`
    : `📅 明天提醒！\n\nAI 共學聚明天晚上 20:00–21:30\n📌 主題：Claude AI 入門實戰｜小白也能快速做出精美社群內容\n\n期待明天和大家共學！🧬`;
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

// ─── 綁定提醒 ────────────────────────────────────────────────────────────────
// 寄一封一鍵綁定信給「報名了但 line_user_id 為空 + subscribe_line='yes' + 還沒寄過」的人。
// 共用邏輯：admin 端點（一次性 catch-up）與 cron（T+24h 自動）都呼叫此函式。
async function sendBindReminders({ eventDate = null, minAgeHours = 0, dryRun = false, force = false } = {}) {
  const where = [
    `line_user_id IS NULL`,
    `subscribe_line = 'yes'`,
    `email IS NOT NULL AND email <> ''`,
    `attendance IN ('Yes','Maybe')`,
  ];
  if (!force) where.push(`bind_reminded_at IS NULL`);
  const params = [];
  if (eventDate) { params.push(eventDate); where.push(`event_date = $${params.length}`); }
  if (minAgeHours > 0) where.push(`created_at < NOW() - INTERVAL '${parseInt(minAgeHours)} hours'`);
  const sql = `SELECT id, name, email FROM registrations WHERE ${where.join(' AND ')} ORDER BY created_at ASC`;
  const result = await pool.query(sql, params);

  const sent = [];
  for (const reg of result.rows) {
    const { subject, text } = buildBindReminderEmail(reg.name, reg.email);
    if (!dryRun) {
      await sendEmail(reg.email, subject, text);
      await pool.query(`UPDATE registrations SET bind_reminded_at = NOW() WHERE id = $1`, [reg.id]);
    }
    sent.push({ id: reg.id, name: reg.name, email: reg.email });
  }
  console.log(`[BindReminder] ${dryRun ? '(dry-run) ' : ''}eventDate=${eventDate || 'any'} minAge=${minAgeHours}h sent=${sent.length}`);
  return sent;
}

// 一次性 catch-up：admin 觸發
// 用法：GET /admin/api/send-bind-reminders?pw=...&event=2026-05-18[&dry=1]
app.get('/admin/api/send-bind-reminders', adminAuth, async (req, res) => {
  try {
    const eventDate = req.query.event || CURRENT_EVENT_DATE;
    const dryRun = req.query.dry === '1';
    const force = req.query.force === '1';
    const sent = await sendBindReminders({ eventDate, minAgeHours: 0, dryRun, force });
    res.json({ success: true, dryRun, eventDate, force, count: sent.length, recipients: sent });
  } catch (err) {
    console.error('[Send Bind Reminders Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 寄邀請信給「加了 LINE OA 但本場未報名」的舊粉絲
async function sendInviteToUnregistered({ eventDate = null, dryRun = false } = {}) {
  if (!eventDate) throw new Error('eventDate required');
  const result = await pool.query(`
    SELECT lb.line_user_id, lb.email, lb.display_name
    FROM line_bindings lb
    WHERE lb.email IS NOT NULL AND lb.email <> ''
      AND NOT EXISTS (
        SELECT 1 FROM registrations r
        WHERE LOWER(TRIM(r.email)) = LOWER(TRIM(lb.email)) AND r.event_date = $1
      )
    ORDER BY lb.created_at ASC
  `, [eventDate]);

  const sent = [];
  const subject = '🌱 今晚 20:00 AI 共學聚第二期 — 還沒報名嗎？';
  for (const reg of result.rows) {
    const greeting = reg.display_name ? `嗨 ${reg.display_name}！` : '嗨！';
    const text = `${greeting}\n\n我是 Din 🌱\n\n還記得上一堂課我們用 Gemini 作行事曆，是不是簡單又有趣？\n這次第二期我們換主角上課啦！\n\n從零開始、手把手帶你用 Claude AI 一步步做出精美社群內容\n不藏私的實戰教學，幫你把 AI 真的帶進日常工作裡 🌱\n\n📌 主題：Claude AI 入門實戰｜小白也能快速做出精美社群內容\n📅 課程：5/18（一）20:00–21:30 線上\n\n🎫 報名連結（今晚 19:00 截止）：\n👉 https://event.cosmoseed.com.tw\n\n報名成功後 Meet 連結會立刻寄到你的信箱 📧\n\n📋 上課前請準備：\n1. 筆電（手機體驗會差很多）\n2. Claude 帳號（沒有可先註冊 claude.ai）\n\n19:50 開放進入教室、20:00 準時開始 🚀\n\n— Din 🧬`;
    if (!dryRun) await sendEmail(reg.email, subject, text);
    sent.push({ line_user_id: reg.line_user_id, email: reg.email, display_name: reg.display_name });
  }
  console.log(`[InviteUnregistered] ${dryRun ? '(dry-run) ' : ''}event=${eventDate} sent=${sent.length}`);
  return sent;
}

// 緊急：對當前場次全員（不分綁定）寄 Email Meet URL。LINE quota 爆掉時 fallback 用
// 用法：GET /admin/api/send-meet-emergency?pw=...&event=2026-05-18[&dry=1]
app.get('/admin/api/send-meet-emergency', adminAuth, async (req, res) => {
  try {
    const eventDate = req.query.event || CURRENT_EVENT_DATE;
    const dryRun = req.query.dry === '1';
    const result = await pool.query(
      `SELECT id, name, email FROM registrations
       WHERE event_date=$1 AND attendance IN ('Yes','Maybe')
         AND email IS NOT NULL AND email <> ''`,
      [eventDate]
    );
    const subject = '⏰ AI 共學聚 — Meet 連結（再次傳送）';
    const sent = [];
    for (const r of result.rows) {
      const text = `嗨 ${r.name}！\n\nAI 共學聚 5/18 即將開始 🚀\n\n💻 Meet 連結：\n${MEET_URL}\n\n🔔 19:50 開放進入教室、20:00 準時開始\n📌 主題：Claude AI 入門實戰｜小白也能快速做出精美社群內容\n\n📋 記得準備：筆電 + Claude 帳號（claude.ai）\n\n等等見！🧬`;
      if (!dryRun) await sendEmail(r.email, subject, text);
      sent.push({ id: r.id, name: r.name, email: r.email });
    }
    console.log(`[MeetEmergency] ${dryRun ? '(dry-run) ' : ''}event=${eventDate} sent=${sent.length}`);
    res.json({ success: true, dryRun, eventDate, count: sent.length, recipients: sent });
  } catch (err) {
    console.error('[Meet Emergency Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 寄邀請信給「曾報名過舊場次但本場未報名 + 不在 line_bindings（避免重複）」的人
// 用法：GET /admin/api/send-invite-past-registrants?pw=...&event=2026-05-18[&dry=1]
app.get('/admin/api/send-invite-past-registrants', adminAuth, async (req, res) => {
  try {
    const eventDate = req.query.event || CURRENT_EVENT_DATE;
    const dryRun = req.query.dry === '1';
    const result = await pool.query(`
      WITH past_unique AS (
        SELECT DISTINCT ON (LOWER(TRIM(email))) email, name
        FROM registrations
        WHERE email IS NOT NULL AND email <> '' AND event_date <> $1
        ORDER BY LOWER(TRIM(email)), created_at DESC
      )
      SELECT pu.email, pu.name
      FROM past_unique pu
      WHERE NOT EXISTS (
        SELECT 1 FROM registrations r2
        WHERE LOWER(TRIM(r2.email)) = LOWER(TRIM(pu.email)) AND r2.event_date = $1
      )
      AND NOT EXISTS (
        SELECT 1 FROM line_bindings lb
        WHERE LOWER(TRIM(lb.email)) = LOWER(TRIM(pu.email))
      )
    `, [eventDate]);

    const subject = '🌱 今晚 20:00 AI 共學聚第二期 — 還沒報名嗎？';
    const sent = [];
    for (const r of result.rows) {
      const text = `嗨 ${r.name}！\n\n我是 Din 🌱\n\n還記得上一堂課我們用 Gemini 作行事曆，是不是簡單又有趣？\n這次第二期我們換主角上課啦！\n\n從零開始、手把手帶你用 Claude AI 一步步做出精美社群內容\n不藏私的實戰教學，幫你把 AI 真的帶進日常工作裡 🌱\n\n📌 主題：Claude AI 入門實戰｜小白也能快速做出精美社群內容\n📅 課程：5/18（一）20:00–21:30 線上\n\n🎫 報名連結（今晚 19:00 截止）：\n👉 https://event.cosmoseed.com.tw\n\n報名成功後 Meet 連結會立刻寄到你的信箱 📧\n\n📋 上課前請準備：\n1. 筆電（手機體驗會差很多）\n2. Claude 帳號（沒有可先註冊 claude.ai）\n\n19:50 開放進入教室、20:00 準時開始 🚀\n\n— Din 🧬`;
      if (!dryRun) await sendEmail(r.email, subject, text);
      sent.push({ email: r.email, name: r.name });
    }
    console.log(`[InvitePastRegistrants] ${dryRun ? '(dry-run) ' : ''}event=${eventDate} sent=${sent.length}`);
    res.json({ success: true, dryRun, eventDate, count: sent.length, recipients: sent });
  } catch (err) {
    console.error('[Invite Past Registrants Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 用法：GET /admin/api/send-invite-unregistered?pw=...&event=2026-05-18[&dry=1]
app.get('/admin/api/send-invite-unregistered', adminAuth, async (req, res) => {
  try {
    const eventDate = req.query.event || CURRENT_EVENT_DATE;
    const dryRun = req.query.dry === '1';
    const sent = await sendInviteToUnregistered({ eventDate, dryRun });
    res.json({ success: true, dryRun, eventDate, count: sent.length, recipients: sent });
  } catch (err) {
    console.error('[Invite Unregistered Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// T+24h 自動：每日 12:00（台灣時間）跑一次，抓 24h 前報名但還沒綁的，寄第一次提醒
cron.schedule('0 12 * * *', () => {
  sendBindReminders({ eventDate: CURRENT_EVENT_DATE, minAgeHours: 24 })
    .catch(err => console.error('[BindReminder Cron Error]', err.message));
}, { timezone: 'Asia/Taipei' });

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
