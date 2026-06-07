require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Resend } = require('resend');
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
const CURRENT_EVENT_DATE = process.env.CURRENT_EVENT_DATE || '2026-06-15';
const MEET_URL = process.env.MEET_URL || 'https://meet.google.com/oph-rqjx-vgx';
// 當前場次顯示文字（人類可讀），用於 LINE/Email 文案
const EVENT_LABEL = process.env.EVENT_LABEL || '6/15（一）20:00–21:30 線上';
const EVENT_TOPIC = process.env.EVENT_TOPIC || '一人公司獲利實戰！用 ChatGPT 快速打造你的內容系統';
const EVENT_PREP = process.env.EVENT_PREP || '1. 筆電（建議可登入 Google 帳號）\n2. ChatGPT 帳號（沒有可先到 chatgpt.com 註冊）';

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

// 根目錄改導向課程列表頁（5/18 後預設行為）
// 想直接看舊報名表單請走 /register
app.get('/', (req, res) => res.redirect(302, '/courses'));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
    CREATE TABLE IF NOT EXISTS event_slides (
      event_date    TEXT PRIMARY KEY,
      slides_url    TEXT NOT NULL,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Migration: 為既有表補上後台新增欄位
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS next_event_interested BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS attended BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS event_date TEXT`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS bind_reminded_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS email_status TEXT`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS email_error TEXT`);
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

  // ─── events：場次單一真相源（取代 server.js 頂部寫死的 CURRENT_EVENT_DATE/EVENT_* 常數 + 寫死的提醒 cron）
  // 自動化鏈讀這張表：建場次 → 上架(published) → 提醒(day/hour) → 報到 → 課後問卷補推。
  // 每場用 event_date（'YYYY-MM-DD' Asia/Taipei）當 key，與 registrations.event_date / event_slides.event_date 對齊。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id                       SERIAL PRIMARY KEY,
      event_date               TEXT NOT NULL UNIQUE,   -- 'YYYY-MM-DD'（Asia/Taipei），所有 join 的 key
      title                    TEXT NOT NULL,          -- 短標題，例：AI 共學聚 6/1
      topic                    TEXT NOT NULL,          -- 主題全文（文案用）
      label                    TEXT,                   -- 人類可讀時段，例：6/1（一）20:00–21:30 線上
      prep                     TEXT,                   -- 課前準備（文案用）
      meet_url                 TEXT,                   -- Google Meet 連結
      banner                   TEXT,                   -- banner 圖路徑，例：/banner-0601.png
      start_at                 TIMESTAMPTZ NOT NULL,   -- 精確開始時間（提醒時間從這裡推算 + schema.org）
      end_at                   TIMESTAMPTZ,            -- 結束時間（課後問卷時機從這裡推算）
      registration_open_at     TIMESTAMPTZ,            -- 開放報名時間（上架）
      survey_url               TEXT,                   -- 課後問卷連結
      reminder_day_offset_min  INTEGER DEFAULT 1440,   -- day 提醒：開始前幾分鐘（預設 24h）
      reminder_hour_offset_min INTEGER DEFAULT 90,     -- hour 提醒：開始前幾分鐘（預設 90 分）
      survey_offset_min        INTEGER DEFAULT 720,    -- 課後問卷：結束後幾分鐘補推（預設 12h）
      reminder_day_sent_at     TIMESTAMPTZ,            -- 冪等戳記：day 提醒已發
      reminder_hour_sent_at    TIMESTAMPTZ,            -- 冪等戳記：hour 提醒已發
      survey_sent_at           TIMESTAMPTZ,            -- 冪等戳記：課後問卷已自動補推
      status                   TEXT DEFAULT 'draft',   -- draft | published | past | cancelled
      created_at               TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Seed：把場次灌入 events，已存在則略過（ON CONFLICT DO NOTHING）。
  // 5/4、5/18、6/1 皆已結束，status='past'；6/15 為當前場次 status='published'，
  // 自動化 cron 只動 future 的 published 場次（6/14 20:00 day 提醒、6/15 18:30 hour 提醒、6/16 課後問卷）。
  await pool.query(`
    INSERT INTO events (event_date, title, topic, label, banner, start_at, end_at, survey_url, status)
    VALUES
      ('2026-05-04', 'AI 共學聚 5/4',
       '不懂 AI 也能學會！用 Gemini 讓工作快一倍',
       '5/4（一）20:00–21:00 線上', '/banner-0504.png',
       '2026-05-04T20:00:00+08:00', '2026-05-04T21:00:00+08:00', NULL, 'past'),
      ('2026-05-18', 'AI 共學聚 5/18',
       'Claude AI 入門實戰｜小白也能快速做出精美社群內容',
       '5/18（一）20:00–21:30 線上', '/banner-0518.png',
       '2026-05-18T20:00:00+08:00', '2026-05-18T21:30:00+08:00',
       'https://forms.gle/VA4JDwSvbg13scB58', 'past'),
      ('2026-06-01', 'AI 共學聚 6/1',
       '不懂設計也能做！用 Gemini Canvas 快速打造 AI 簡報與旅遊小工具',
       '6/1（一）20:00–21:30 線上', '/banner-0601.png',
       '2026-06-01T20:00:00+08:00', '2026-06-01T21:30:00+08:00',
       'https://forms.gle/VA4JDwSvbg13scB58', 'past'),
      ('2026-06-15', 'AI 共學聚 6/15',
       '一人公司獲利實戰！用 ChatGPT 快速打造你的內容系統',
       '6/15（一）20:00–21:30 線上', '/banner-0615.png',
       '2026-06-15T20:00:00+08:00', '2026-06-15T21:30:00+08:00',
       'https://forms.gle/VA4JDwSvbg13scB58', 'published')
    ON CONFLICT (event_date) DO NOTHING
  `);

  console.log('DB ready');
}

// ─── events 表存取層（單一真相源）────────────────────────────────────────────
// 任何 ev row 的 null 欄位退回 server.js 頂部 env 常數，確保 events 表尚未填齊時行為不變（向後相容）。
function mergeEventDefaults(ev) {
  if (!ev) return null;
  return {
    ...ev,
    topic:      ev.topic    || EVENT_TOPIC,
    label:      ev.label    || EVENT_LABEL,
    prep:       ev.prep     || EVENT_PREP,
    meet_url:   ev.meet_url || MEET_URL,
    survey_url: ev.survey_url || 'https://forms.gle/VA4JDwSvbg13scB58',
  };
}

// 依日期取單一場次（含 env 預設合併）；查無時：當前場次退回 env 常數，其餘回 null。
async function getEventByDate(date) {
  try {
    const r = await pool.query(`SELECT * FROM events WHERE event_date=$1`, [date]);
    if (r.rows[0]) return mergeEventDefaults(r.rows[0]);
  } catch (e) { console.error('[events] getEventByDate fail:', e.message); }
  return date === CURRENT_EVENT_DATE
    ? mergeEventDefaults({ event_date: CURRENT_EVENT_DATE })
    : null;
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
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = `${process.env.EMAIL_FROM_NAME || 'AI 共學聚'} <${process.env.EMAIL_FROM || 'noreply@cosmoseed.com.tw'}>`;

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function sendEmail(to, subject, text, html) {
  if (!resend) {
    console.error('[Email Skip]', to, 'RESEND_API_KEY not set');
    return { ok: false, error: 'resend not configured' };
  }
  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to, subject, text,
      ...(html ? { html } : {}),
    });
    if (error) {
      console.error('[Email Fail]', to, error.message || error.name || JSON.stringify(error));
      return { ok: false, error: error.message || String(error) };
    }
    console.log('[Email OK]', to, data.id);
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[Email Fail]', to, err.message);
    return { ok: false, error: err.message };
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
    subject: `💻 AI 共學聚 ${EVENT_LABEL.split('（')[0]} Meet 連結 — ${EVENT_LABEL}`,
    text: `嗨 ${name}！\n\n你已報名 AI 共學聚 ✅\n\n📅 ${EVENT_LABEL}\n📌 主題：${EVENT_TOPIC}\n\n💻 Meet 連結：\n${MEET_URL}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📋 上課前請準備：\n${EVENT_PREP}\n\n────\n\n📲 想接收 LINE 即時提醒？\n回我們的官方 LINE OA 完成綁定（30 秒）：\n${url}\n或在 LINE OA 對話直接傳這個 Email 給我們也行 🌱\n\n— AI 共學聚團隊 🧬`,
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
      // 已綁 LINE → 推 LINE 提醒（附 Meet 連結，方便重複查看）
      await sendLine(reg.line_user_id,
        `嗨 ${reg.name}！\n\n你已報名 AI 共學聚 ✅\n\n📅 ${EVENT_LABEL}\n📌 主題：${EVENT_TOPIC}\n\n💻 Meet 連結：\n${MEET_URL}\n\n活動前 30 分鐘會在這裡再提醒一次 🧬`
      );
    } else {
      // 未綁 LINE → Email 提醒（帶 Meet 連結）+ 鼓勵綁 LINE
      await sendEmail(
        email,
        '📋 你已報名 AI 共學聚！',
        `嗨 ${reg.name}！\n\n你已報名 AI 共學聚 ✅\n\n📅 ${EVENT_LABEL}\n📌 主題：${EVENT_TOPIC}\n\n💻 Meet 連結：\n${MEET_URL}\n\n📲 還沒綁定 LINE 嗎？點下面連結一鍵綁定（30 秒），活動前 30 分鐘會在 LINE 再提醒你：\n${buildBindUrl(email)}\n\n— AI 共學聚團隊 🧬`
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
      isGoing ? `✅ AI 共學聚 — ${EVENT_LABEL.split('（')[0]} 報名確認｜Meet 連結` : 'AI 共學聚 — 感謝填寫！',
      isGoing
        ? `嗨 ${name}！\n\n感謝你報名 AI 共學聚 🌱\n\n📅 ${EVENT_LABEL}\n📌 主題：${EVENT_TOPIC}\n\n💻 Meet 連結：\n${MEET_URL}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📲 完成 LINE 綁定可即時收 Meet 連結 + 活動前 30 分鐘 LINE 提醒：\n${buildBindUrl(email)}\n👆 點下去登入 LINE → 同意 → 加好友 → 自動完成，30 秒內搞定\n\n📋 上課前請準備：\n${EVENT_PREP}\n\n— AI 共學聚團隊 🧬`
        : `嗨 ${name}！\n\n感謝你填寫表單！本場主題「${EVENT_TOPIC}」於 ${EVENT_LABEL}，若之後想參加歡迎再回來填一次 📅\n\n— AI 共學聚團隊 🧬`
    ).then(result => {
      // 寄信結果寫回 DB 供 admin 後台查看（首次報名確認信專用，duplicate/cron 不覆蓋）
      if (result?.ok) {
        pool.query(
          `UPDATE registrations SET email_sent_at=NOW(), email_status='sent', email_error=NULL
           WHERE email=$1 AND event_date=$2`,
          [email, CURRENT_EVENT_DATE]
        ).catch(e => console.error('[Email UPDATE ok]', e.message));
      } else {
        pool.query(
          `UPDATE registrations SET email_status='failed', email_error=$1
           WHERE email=$2 AND event_date=$3`,
          [(result?.error || 'unknown').slice(0, 500), email, CURRENT_EVENT_DATE]
        ).catch(e => console.error('[Email UPDATE fail]', e.message));
      }
    });

    // 雙通道通知：不管有沒有綁 LINE，Email 一定帶 Meet 連結（上方）；若已綁 LINE，再加推一次 LINE
    if (isGoing && binding.rows[0]?.line_user_id) {
      sendLine(binding.rows[0].line_user_id,
        `嗨 ${name}！\n\n你已報名 AI 共學聚 ✅\n\n📅 ${EVENT_LABEL}\n📌 主題：${EVENT_TOPIC}\n\n💻 Meet 連結：\n${MEET_URL}\n🔔 19:50 開放、20:00 準時開始\n\n📋 上課前請準備：\n${EVENT_PREP}\n\n活動前 30 分鐘會在這裡再提醒你一次 🧬`);
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
      // 綁定成功 → 立即推 Meet 連結（不再等當天 cron）
      await sendLine(userId,
        `已為你完成綁定 ✅\n\n${reg.rows[0].name} 你好！\n${EVENT_LABEL} AI 共學聚見 🌱\n📌 主題：${EVENT_TOPIC}\n\n💻 Meet 連結（已寄到信箱，這裡再給你一份）：\n${MEET_URL}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📋 上課前請準備：\n${EVENT_PREP}\n\n活動前 30 分鐘會在這裡再提醒你 🧬`
      );
      res.redirect('/?bound=success&name=' + encodeURIComponent(reg.rows[0].name));
    } else {
      // 外部報名者（如活動通）：line_bindings 已寫入，立即推 Meet 連結
      await sendLine(userId,
        `已為你完成綁定 ✅\n\n${EVENT_LABEL} AI 共學聚見 🌱\n📌 主題：${EVENT_TOPIC}\n\n💻 Meet 連結：\n${MEET_URL}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📋 上課前請準備：\n${EVENT_PREP}\n\n活動前 30 分鐘會在這裡再提醒你 🧬`
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
      // 接受純 keyword 與帶日期前綴（例如「6/1報到」「2026-06-01簽到」）兩種寫法；日期前綴只當語意糖，實際以 CURRENT_EVENT_DATE 為準
      if (/^(?:\d{1,2}[\/\-]\d{1,2}|\d{4}-\d{2}-\d{2})?\s*(報到|簽到|\+1|我來了|我到了)$/i.test(text)) {
        const bindRow = await pool.query(
          `SELECT email FROM line_bindings WHERE line_user_id=$1 AND email IS NOT NULL
           UNION
           SELECT email FROM registrations WHERE line_user_id=$1 AND email IS NOT NULL
           LIMIT 1`,
          [userId]
        );
        const knownEmail = bindRow.rows[0]?.email || null;

        if (knownEmail) {
          // 優先用 LINE 即時 displayName（最貼近用戶當下身份）；fallback DB.name；最後才空字串
          let lineDisplayName = '';
          try { lineDisplayName = (await lineClient.getProfile(userId))?.displayName || ''; } catch (_) {}
          const exist = await pool.query(
            `SELECT id, name FROM registrations WHERE line_user_id=$1 AND event_date=$2`,
            [userId, CURRENT_EVENT_DATE]
          );
          const dbNameLookup = exist.rows[0]?.name
            || (await pool.query(`SELECT name FROM registrations WHERE email=$1 ORDER BY created_at DESC LIMIT 1`, [knownEmail])).rows[0]?.name
            || '';
          // 顯示用名稱：LINE displayName 優先；其次 DB 裡非 fallback 的真名；都沒有就空（greet 句省略）
          const greetName = lineDisplayName || (dbNameLookup && dbNameLookup !== '(LINE 來賓)' ? dbNameLookup : '');
          // DB 儲存用名稱：保留 DB 既有真名；若只剩 fallback 就用 LINE displayName 補上
          const dbName = (dbNameLookup && dbNameLookup !== '(LINE 來賓)') ? dbNameLookup : (lineDisplayName || '(LINE 來賓)');
          if (exist.rows[0]) {
            await pool.query(`UPDATE registrations SET attended=TRUE WHERE id=$1`, [exist.rows[0].id]);
          } else {
            await pool.query(
              `INSERT INTO registrations (name, email, attendance, event_date, line_user_id, attended)
               VALUES ($1,$2,'Yes',$3,$4,TRUE)
               ON CONFLICT (email, event_date) DO UPDATE SET attended=TRUE, line_user_id=EXCLUDED.line_user_id`,
              [dbName, knownEmail, CURRENT_EVENT_DATE, userId]
            );
          }
          await pool.query(`UPDATE line_bindings SET awaiting_attendance_email=FALSE WHERE line_user_id=$1`, [userId]);
          const slidesRow = await pool.query(`SELECT slides_url FROM event_slides WHERE event_date=$1`, [CURRENT_EVENT_DATE]);
          const slidesUrl = slidesRow.rows[0]?.slides_url || null;
          const greetLine = greetName ? `${greetName} 你好！\n\n` : '';
          const replyText = slidesUrl
            ? `✅ 報到成功！\n\n${greetLine}📊 本場簡報下載：\n${slidesUrl}`
            : `✅ 報到成功！\n\n${greetLine}活動結束後簡報會寄到：\n📧 ${knownEmail}`;
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
          continue;
        } else {
          // 沒 email 紀錄也直接給連結，UX 不卡。同時設 awaiting_attendance_email=TRUE，使用者若後續主動傳 email 仍能接住
          await pool.query(
            `INSERT INTO line_bindings (line_user_id, awaiting_attendance_email) VALUES ($1, TRUE)
             ON CONFLICT (line_user_id) DO UPDATE SET awaiting_attendance_email=TRUE`,
            [userId]
          );
          const slidesRow = await pool.query(`SELECT slides_url FROM event_slides WHERE event_date=$1`, [CURRENT_EVENT_DATE]);
          const slidesUrl = slidesRow.rows[0]?.slides_url || null;
          const replyText = slidesUrl
            ? `✅ 報到成功！\n\n📊 本場簡報下載：\n${slidesUrl}\n\n想收課後問卷 / 下一場通知，\n歡迎傳你的 Email 給我 📧`
            : `👋 找不到你的 Email 紀錄\n\n請傳你的 Email 給我（例如：yourname@gmail.com）\n活動結束後我會把簡報寄到那裡 📧`;
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
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
          const slidesRow = await pool.query(`SELECT slides_url FROM event_slides WHERE event_date=$1`, [CURRENT_EVENT_DATE]);
          const slidesUrl = slidesRow.rows[0]?.slides_url || null;
          const replyText = slidesUrl
            ? `✅ 已記下！\n\n📊 本場簡報下載：\n${slidesUrl}`
            : `✅ 已記下！\n\n活動結束後簡報會寄到：\n📧 ${email}`;
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
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
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: `已為你完成綁定 ✅\n\n${reg.rows[0].name} 你好！\n${EVENT_LABEL} AI 共學聚見 🌱\n📌 主題：${EVENT_TOPIC}\n\n💻 Meet 連結：\n${MEET_URL}\n\n活動前 30 分鐘會在這裡再提醒你 🧬` });
        } else {
          // 外部報名者（如活動通）：line_bindings 已寫入，直接通知綁定成功 + Meet 連結
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: `已為你完成綁定 ✅\n\n${EVENT_LABEL} AI 共學聚見 🌱\n📌 主題：${EVENT_TOPIC}\n\n💻 Meet 連結：\n${MEET_URL}\n\n活動前 30 分鐘會在這裡再提醒你 🧬` });
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

// 場次簡報 URL 管理：報到回覆會自動帶上對應 event_date 的簡報連結
// 用法：
//   POST  /admin/api/event-slides?pw=...&event=2026-06-01&url=https://...   新增/更新
//   GET   /admin/api/event-slides?pw=...                                    列表
//   DELETE /admin/api/event-slides?pw=...&event=2026-06-01                   移除
app.post('/admin/api/event-slides', adminAuth, async (req, res) => {
  const eventDate = req.query.event || req.body?.event;
  const slidesUrl = req.query.url || req.body?.url;
  if (!eventDate || !slidesUrl) return res.status(400).json({ error: 'Missing event or url' });
  await pool.query(`
    INSERT INTO event_slides (event_date, slides_url, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (event_date) DO UPDATE SET slides_url=EXCLUDED.slides_url, updated_at=NOW()
  `, [eventDate, slidesUrl]);
  res.json({ success: true, eventDate, slidesUrl });
});

app.get('/admin/api/event-slides', adminAuth, async (req, res) => {
  const result = await pool.query(`SELECT event_date, slides_url, updated_at FROM event_slides ORDER BY event_date DESC`);
  res.json({ count: result.rows.length, slides: result.rows });
});

app.delete('/admin/api/event-slides', adminAuth, async (req, res) => {
  const eventDate = req.query.event;
  if (!eventDate) return res.status(400).json({ error: 'Missing event' });
  const result = await pool.query(`DELETE FROM event_slides WHERE event_date=$1`, [eventDate]);
  res.json({ success: true, eventDate, deleted: result.rowCount });
});

// ─── events 場次管理 API（自動化鏈的寫入入口：建場次 / 上架 / 列表 / 取消）────────────
// 後台 HTML 管理頁（admin.html）後續再接；先提供 JSON API 讓場次可被建立並 publish，cron 才有東西可跑。
// 用法：
//   GET    /admin/api/events?pw=...                      列出所有場次
//   POST   /admin/api/events?pw=...   body: {event_date,title,topic,start_at,...}   建立/更新（upsert by event_date）
//   POST   /admin/api/events/publish?pw=...&event=YYYY-MM-DD   上架（status=published，自動化開始追這場）
//   POST   /admin/api/events/cancel?pw=...&event=YYYY-MM-DD    取消（status=cancelled，停發後續提醒）
app.get('/admin/api/events', adminAuth, async (req, res) => {
  const result = await pool.query(`SELECT * FROM events ORDER BY event_date DESC`);
  res.json({ count: result.rows.length, events: result.rows });
});

app.post('/admin/api/events', adminAuth, async (req, res) => {
  const b = req.body || {};
  const event_date = b.event_date || req.query.event;
  if (!event_date || !b.title || !b.topic || !b.start_at) {
    return res.status(400).json({ error: 'Missing required: event_date, title, topic, start_at' });
  }
  try {
    const result = await pool.query(`
      INSERT INTO events
        (event_date, title, topic, label, prep, meet_url, banner, start_at, end_at,
         registration_open_at, survey_url, reminder_day_offset_min, reminder_hour_offset_min,
         survey_offset_min, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
              COALESCE($12,1440), COALESCE($13,90), COALESCE($14,720), COALESCE($15,'draft'))
      ON CONFLICT (event_date) DO UPDATE SET
        title=EXCLUDED.title, topic=EXCLUDED.topic, label=EXCLUDED.label, prep=EXCLUDED.prep,
        meet_url=EXCLUDED.meet_url, banner=EXCLUDED.banner, start_at=EXCLUDED.start_at,
        end_at=EXCLUDED.end_at, registration_open_at=EXCLUDED.registration_open_at,
        survey_url=EXCLUDED.survey_url,
        reminder_day_offset_min=EXCLUDED.reminder_day_offset_min,
        reminder_hour_offset_min=EXCLUDED.reminder_hour_offset_min,
        survey_offset_min=EXCLUDED.survey_offset_min,
        status=EXCLUDED.status
      RETURNING *
    `, [event_date, b.title, b.topic, b.label || null, b.prep || null, b.meet_url || null,
        b.banner || null, b.start_at, b.end_at || null, b.registration_open_at || null,
        b.survey_url || null, b.reminder_day_offset_min, b.reminder_hour_offset_min,
        b.survey_offset_min, b.status]);
    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error('[events upsert]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/events/publish', adminAuth, async (req, res) => {
  const eventDate = req.query.event || req.body?.event;
  if (!eventDate) return res.status(400).json({ error: 'Missing event' });
  const r = await pool.query(`UPDATE events SET status='published' WHERE event_date=$1 RETURNING *`, [eventDate]);
  if (!r.rowCount) return res.status(404).json({ error: 'Event not found' });
  res.json({ success: true, event: r.rows[0] });
});

app.post('/admin/api/events/cancel', adminAuth, async (req, res) => {
  const eventDate = req.query.event || req.body?.event;
  if (!eventDate) return res.status(400).json({ error: 'Missing event' });
  const r = await pool.query(`UPDATE events SET status='cancelled' WHERE event_date=$1 RETURNING *`, [eventDate]);
  if (!r.rowCount) return res.status(404).json({ error: 'Event not found' });
  res.json({ success: true, event: r.rows[0] });
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

// 對「指定場次」的 Yes/Maybe 報名者發 day/hour 提醒。文案的 topic/meet/prep 全部讀 ev（null 退回 env 常數）。
async function sendRemindersForEvent(ev, type = 'day') {
  ev = mergeEventDefaults(ev);
  // 只通知該場次的報名者，避免誤發給之前場次已報名但這次沒報的人
  const result = await pool.query(
    `SELECT * FROM registrations WHERE attendance IN ('Yes','Maybe') AND event_date=$1`,
    [ev.event_date]
  );
  const lineMsg = type === 'hour'
    ? `⏰ 今晚就要開始囉！\n\nAI 共學聚今晚 20:00–21:30 線上見 🚀\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📋 記得準備：\n${ev.prep}\n\n晚點見！🧬`
    : `📅 明天提醒！\n\nAI 共學聚明天晚上 20:00–21:30\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n\n期待明天和大家共學！🧬`;
  const emailSubject = type === 'hour' ? '⏰ AI 共學聚今晚 20:00 開始！' : '📅 明天提醒：AI 共學聚';

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
  console.log(`[Reminder] event=${ev.event_date} type=${type} sent=${result.rows.length} reg + ${externalBindings.rows.length} external`);
}

// 向後相容包裝：舊 admin 端點 POST /admin/api/send-reminder 仍可用，預設打當前場次。
async function sendReminders(type = 'day') {
  const ev = await getEventByDate(CURRENT_EVENT_DATE);
  return sendRemindersForEvent(ev, type);
}

// 課後問卷自動補推：寄給該場 Yes/Maybe 但「沒報到」的人（attended 為 TRUE 的人會走簡報+問卷信，不重複）。
async function sendPostEventSurvey(ev) {
  ev = mergeEventDefaults(ev);
  const result = await pool.query(
    `SELECT id, name, email FROM registrations
     WHERE event_date=$1 AND attendance IN ('Yes','Maybe')
       AND (attended=FALSE OR attended IS NULL)
       AND email IS NOT NULL AND email <> ''
     ORDER BY name ASC`,
    [ev.event_date]
  );
  const subject = `📝 AI 共學聚 ${ev.event_date} 課後問卷 — 給我們 2 分鐘 🌱`;
  for (const reg of result.rows) {
    const text = `嗨 ${reg.name}！\n\n謝謝你報名這場 AI 共學聚 🌱\n📌 主題：${ev.topic}\n\n如果你有參與課程、想請你花 2 分鐘填一下回饋\n你的意見會幫助我們把下一場做得更好 💚\n\n📝 課後問卷：\n${ev.survey_url}\n\n更多場次與報名：\nhttps://event.cosmoseed.com.tw/courses\n\n— Din Din Wang 🧬\nAI 共學聚團隊`;
    await sendEmail(reg.email, subject, text);
  }
  console.log(`[Survey] event=${ev.event_date} sent=${result.rows.length}`);
  return result.rows.length;
}

// ─── 自動化心臟：每分鐘掃 events 表，到點就發 day/hour 提醒、課後問卷補推（取代寫死日期的 cron）──
// 冪等：每個動作發完蓋戳記（reminder_day_sent_at / reminder_hour_sent_at / survey_sent_at），不重發。
async function runEventAutomation() {
  try {
    const now = Date.now();
    // 撈近期相關場次：未過期太久（含結束後問卷視窗）的 published 場次
    const { rows } = await pool.query(
      `SELECT * FROM events
       WHERE status = 'published'
         AND start_at > NOW() - INTERVAL '3 days'`
    );
    for (const ev of rows) {
      const start = new Date(ev.start_at).getTime();
      const dayAt  = start - (ev.reminder_day_offset_min  ?? 1440) * 60000;
      const hourAt = start - (ev.reminder_hour_offset_min ?? 90)   * 60000;
      const dayDue  = !ev.reminder_day_sent_at  && now >= dayAt  && now < start;
      const hourDue = !ev.reminder_hour_sent_at && now >= hourAt && now < start;

      // 同分鐘兩封都到點（通常是「遲上架」：publish 時已過 day 提醒時間）→ 只發較緊急的 hour，
      // day 直接蓋戳記但不寄，避免同一個人在同一分鐘收到兩封幾乎一樣的提醒。
      if (dayDue && hourDue) {
        await sendRemindersForEvent(ev, 'hour');
        await pool.query(
          `UPDATE events SET reminder_hour_sent_at = NOW(), reminder_day_sent_at = NOW() WHERE id = $1`,
          [ev.id]
        );
        console.log(`[EventAutomation] ${ev.event_date} 遲上架：day+hour 同分鐘到點，只發 hour、day 標記略過`);
      } else if (dayDue) {
        await sendRemindersForEvent(ev, 'day');
        await pool.query(`UPDATE events SET reminder_day_sent_at = NOW() WHERE id = $1`, [ev.id]);
      } else if (hourDue) {
        await sendRemindersForEvent(ev, 'hour');
        await pool.query(`UPDATE events SET reminder_hour_sent_at = NOW() WHERE id = $1`, [ev.id]);
      }
      // 課後問卷補推：結束後 survey_offset_min 分鐘，且有設 survey_url
      if (ev.end_at && !ev.survey_sent_at) {
        const surveyAt = new Date(ev.end_at).getTime() + (ev.survey_offset_min ?? 720) * 60000;
        if (now >= surveyAt && (ev.survey_url)) {
          await sendPostEventSurvey(ev);
          await pool.query(`UPDATE events SET survey_sent_at = NOW() WHERE id = $1`, [ev.id]);
        }
      }
    }
  } catch (e) {
    console.error('[EventAutomation] error:', e.message);
  }
}
cron.schedule('* * * * *', runEventAutomation, { timezone: 'Asia/Taipei' });

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

// 測試 SMTP：寄一封給指定 email 並回傳真實 error（不吞）
// 用法：GET /admin/api/test-email?pw=...&to=test@example.com
app.get('/admin/api/test-email', adminAuth, async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ error: 'missing ?to=' });
  if (!resend) return res.status(500).json({ error: 'resend not initialized — check RESEND_API_KEY env var' });
  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: 'Resend test — ' + new Date().toISOString(),
      text: 'This is a test email from /admin/api/test-email endpoint. If you see this, Resend is working.',
    });
    if (error) return res.status(500).json({ error: error.message || String(error), name: error.name });
    res.json({ success: true, id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ─── ECPay 付款通知 → LINE Push（Gmail IMAP polling）────────────────────────────
// 流程：客戶刷綠界 → 綠界自動寄通知信給商家 → 本服務每 2 分鐘 IMAP 連 Gmail →
//      找未讀的綠界信 → parse 訂單資訊 → push LINE 給 admin → 標記已讀
//
// 用 App Password + IMAP（非 OAuth），避開 testing app 7 天 token 過期問題。
//
// 環境變數：
//   GMAIL_USER          - kaidinwang@gmail.com
//   GMAIL_APP_PASSWORD  - Gmail 應用程式專用密碼（16 位，從 myaccount.google.com/apppasswords 產生）
//   ADMIN_LINE_USER_ID  - 收通知的個人 LINE userId
//   ECPAY_SENDER        - 綠界寄件人（預設 service@ecpay.com.tw）

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const ADMIN_LINE_USER_ID = process.env.ADMIN_LINE_USER_ID || '';
const ECPAY_SENDER = process.env.ECPAY_SENDER || 'service@ecpay.com.tw';

function htmlToText(s) {
  return String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function parseEcpayBody(text) {
  const pick = (re) => (text.match(re) || [])[1]?.trim();
  return {
    orderNo: pick(/(?:訂單編號|MerchantTradeNo|商店訂單編號)[\s：:]*([A-Za-z0-9\-_]+)/),
    amount: pick(/(?:交易金額|金額|TradeAmt)[\s：:]*NT?\$?\s*([\d,]+)/),
    method: pick(/(?:付款方式|PaymentType)[\s：:]*([^\n\r<]+?)(?=\s{2,}|\n|$)/),
    tradeTime: pick(/(?:交易時間|付款時間|PaymentDate)[\s：:]*([\d\-:\s\/]+)/),
    productName: pick(/(?:商品名稱|ItemName)[\s：:]*([^\n\r<]+?)(?=\s{2,}|\n|$)/),
  };
}

function formatPaymentNotice(info, subject) {
  return [
    '💰 新訂單付款通知',
    '',
    `📦 商品：${info.productName || '(未解析)'}`,
    `🔢 訂單編號：${info.orderNo || '(未解析)'}`,
    `💵 金額：NT$${info.amount || '?'}`,
    `💳 付款方式：${info.method || '?'}`,
    `🕐 交易時間：${info.tradeTime || '?'}`,
    '',
    '👉 等客戶 LINE 私訊 @795qxcio',
    '原信主旨：' + (subject || ''),
  ].join('\n');
}

let pollLock = false; // 避免 2 分鐘 cron 重疊（萬一上次還沒跑完）

async function pollEcpayPayments(opts = {}) {
  const verbose = opts.verbose;
  const result = { ok: false, connected: false, foundEmails: 0, processed: 0, error: null };
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !ADMIN_LINE_USER_ID || !lineClient) {
    result.error = 'missing config';
    return result;
  }
  if (pollLock) {
    result.error = 'already running';
    return result;
  }
  pollLock = true;

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });

  try {
    if (verbose) console.log('[ECPay Poll] Connecting to imap.gmail.com...');
    await client.connect();
    result.connected = true;
    if (verbose) console.log('[ECPay Poll] Connected ✅');
    const lock = await client.getMailboxLock('INBOX');
    try {
      // 找最近 1 天、未讀、寄件人是 ECPay 的信
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const uids = await client.search({ seen: false, from: ECPAY_SENDER, since });
      result.foundEmails = uids?.length || 0;
      if (!uids || !uids.length) {
        if (verbose) console.log(`[ECPay Poll] No unread emails from ${ECPAY_SENDER}`);
        result.ok = true;
        return result;
      }
      console.log(`[ECPay Poll] Found ${uids.length} unread ECPay email(s)`);

      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          const parsed = await simpleParser(msg.source);
          const subject = parsed.subject || msg.envelope?.subject || '';
          const bodyText = parsed.text || htmlToText(parsed.html || '');
          const info = parseEcpayBody(bodyText);
          const text = formatPaymentNotice(info, subject);

          await lineClient.pushMessage(ADMIN_LINE_USER_ID, { type: 'text', text });
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          console.log(`[ECPay Poll] Notified order ${info.orderNo || uid}`);
          result.processed++;
        } catch (e) {
          console.error(`[ECPay Poll] Failed on uid ${uid}:`, e.message);
        }
      }
      result.ok = true;
    } finally {
      lock.release();
    }
  } catch (e) {
    const detail = [
      e.code,
      e.authenticationFailed && 'auth_failed',
      e.responseText,
      e.response,
      e.message,
    ].filter(Boolean).join(' | ');
    console.error('[ECPay Poll Error]', detail);
    result.error = detail;
  } finally {
    try { await client.logout(); } catch {}
    pollLock = false;
  }
  return result;
}

// 每 2 分鐘 poll 一次
cron.schedule('*/2 * * * *', pollEcpayPayments);
// 啟動後 15 秒先跑一次
setTimeout(pollEcpayPayments, 15000);

// 手動觸發端點（測試用）— 不需 admin key，因為純讀 + 推自己 LINE 沒風險
app.get('/admin/ecpay-poll', async (req, res) => {
  const result = await pollEcpayPayments({ verbose: true });
  res.json({
    config: {
      gmailUser: !!GMAIL_USER,
      gmailPassword: !!GMAIL_APP_PASSWORD,
      adminLine: !!ADMIN_LINE_USER_ID,
      lineClient: !!lineClient,
    },
    result,
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 伺服器啟動 port ${PORT}`);
    console.log(`   Resend (寄信):     ${resend ? '✅ 已設定' : '❌ RESEND_API_KEY 未設定 — 所有信都會 silent skip'}`);
    console.log(`   Email From:        ${EMAIL_FROM}`);
    console.log(`   LINE Messaging:    ${lineClient ? '✅ 已設定' : '❌ LINE_CHANNEL_ACCESS_TOKEN 未設定'}`);
    console.log(`   LINE Login Channel ID: ${process.env.LINE_LOGIN_CHANNEL_ID || '❌ 未設定'}`);
    console.log(`   LINE Login Channel Secret: ${process.env.LINE_LOGIN_CHANNEL_SECRET ? '✅ 已設定' : '❌ 未設定'}`);
    const ecpayReady = GMAIL_USER && GMAIL_APP_PASSWORD && ADMIN_LINE_USER_ID && lineClient;
    console.log(`   ECPay→LINE 通知: ${ecpayReady ? '✅ 已啟用（每 2 分鐘 IMAP poll Gmail）' : '❌ 未啟用'}`);
    if (!ecpayReady) {
      console.log(`     ↳ GMAIL_USER:         ${GMAIL_USER ? '✅' : '❌'}`);
      console.log(`     ↳ GMAIL_APP_PASSWORD: ${GMAIL_APP_PASSWORD ? '✅' : '❌'}`);
      console.log(`     ↳ ADMIN_LINE_USER_ID: ${ADMIN_LINE_USER_ID ? '✅' : '❌'}`);
    }
  });
}).catch(err => {
  console.error('DB 連線失敗:', err.message);
  process.exit(1);
});
