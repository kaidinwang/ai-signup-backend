require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Resend } = require('resend');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
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
const CURRENT_EVENT_DATE = process.env.CURRENT_EVENT_DATE || '2026-06-22';
const MEET_URL = process.env.MEET_URL || 'https://meet.google.com/oph-rqjx-vgx';
// 當前場次顯示文字（人類可讀），用於 LINE/Email 文案
const EVENT_LABEL = process.env.EVENT_LABEL || '6/22（一）20:00–21:00 線上';
const EVENT_TOPIC = process.env.EVENT_TOPIC || '一人公司品牌內容實戰！用 ChatGPT 快速打造你的內容系統';
const EVENT_PREP = process.env.EVENT_PREP || '1. 筆電（建議可登入 Google 帳號）\n2. ChatGPT 帳號（沒有可先到 chatgpt.com 註冊）';

// 活動「進行中時段」：19:30–21:00 Asia/Taipei，這段時間內的報名 → 確認信/LINE 立即帶 Meet URL
function isEventLive(now = new Date()) {
  const tz = 'Asia/Taipei';
  const today = now.toLocaleDateString('en-CA', { timeZone: tz });
  if (today !== currentEventSync().event_date) return false;
  const hhmm = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  return hhmm >= '19:30' && hhmm <= '21:00';
}

// ─── 維護模式：DB 未就緒時不讓整站空轉，回友善維護頁（503）───────────────────
// 過去 DB 連不上會 process.exit(1) → Render crash-loop → 整站一直轉。
// 改成：照常開 port，DB 沒好就回維護頁；背景重試，DB 一復原自動恢復（見檔尾啟動區）。
let dbReady = false;
const MAINTENANCE_HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>系統維護中 — AI 共學聚</title>
<style>body{margin:0;font-family:-apple-system,"Noto Sans TC",sans-serif;background:#0f1117;color:#e7e9ee;
display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}
.box{max-width:460px;padding:40px 28px}h1{font-size:1.5rem;margin:0 0 12px}
p{line-height:1.7;color:#aab0bd;margin:8px 0}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;
background:#f5a623;margin-right:8px;animation:b 1.2s infinite}@keyframes b{50%{opacity:.3}}</style></head>
<body><div class="box"><h1><span class="dot"></span>系統維護中</h1>
<p>網站正在進行短暫維護，稍候將自動恢復。</p>
<p>造成不便敬請見諒，請過幾分鐘再重新整理。</p>
<p style="margin-top:24px;font-size:.85rem;color:#6b7280">AI 共學聚 · CosmoSeed</p></div></body></html>`;

const app = express();
app.use(cors());
// 維護模式攔截：放在最前面，DB 沒好時直接回維護頁，不進後面任何路由
app.use((req, res, next) => {
  if (dbReady) return next();
  if (req.path === '/webhook') return res.sendStatus(503); // LINE 平台會自行重試
  res.status(503).set('Retry-After', '120').type('html').send(MAINTENANCE_HTML);
});
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
// 報名頁：沒有開放報名的場次時導回課程頁（顯示「籌備中」）；有則從 events 表動態渲染整頁
// （SEO/hero/日期/主題卡/課綱/出席題全自動長好）。渲染出錯 → 退回靜態 index.html（fail-safe）。
app.get('/register', async (req, res) => {
  try {
    // ?event=YYYY-MM-DD → 直接叫出指定那一場的報名頁（可回看過去場次、複製沿用文案）；
    // 沒帶或格式不符 → 照常顯示「當前開放中」的那場（單一真相源預設行為）。
    const wanted = /^\d{4}-\d{2}-\d{2}$/.test(req.query.event || '') ? req.query.event : null;
    const ev = wanted ? await getEventByDate(wanted) : await getOpenEvent();
    if (!ev) return res.redirect(302, '/courses');
    res.type('html').send(renderRegisterPage(ev));
  } catch (e) {
    console.error('[register] dynamic render fail, serving static:', e.message);
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// 課程頁：從 events 表動態渲染「下一場 / 過去課程」卡，過期場次自動歸檔、沒開放場次顯示籌備中。
// 任何錯誤或 DB 無資料 → 直接吐靜態 courses.html（其內容已維持為「當下安全狀態」）。
app.get('/courses', async (req, res) => {
  try {
    let html = coursesTemplate();
    const today = taipeiToday();
    const [open, events] = await Promise.all([getOpenEvent(), getPublicEvents()]);
    if (open) {
      // 分享縮圖（OG）同步成當前開放場次，避免沿用上一場的靜態快取
      html = fillDynBlock(html, 'CSEO1', renderCoursesSEO1(open));
      html = fillDynBlock(html, 'CSEO2', renderCoursesSEO2(open));
      // Course JSON-LD 的「當前梯次」也同步（不能用 HTML 註解標記，改以唯一 type 錨點取代整個物件）
      html = html.replace(/\{\s*"@type":\s*"CourseInstance"[\s\S]*?\n\s*\}/, renderCourseInstance(open));
    }
    if (events) {
      html = fillDynBlock(html, 'NEXT', open ? renderNextCard(open) : renderComingSoonCard());
      const past = events.filter(e => e.event_date < today && (!open || e.event_date !== open.event_date));
      if (past.length) html = fillDynBlock(html, 'PAST', past.map(renderPastCard).join('\n        '));
    }
    res.type('html').send(html);
  } catch (e) {
    console.error('[courses] dynamic render fail, serving static:', e.message);
    res.sendFile(path.join(__dirname, 'public', 'courses.html'));
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// 後台上傳的場次 banner 從 DB 取（Render 磁碟是 ephemeral，重新部署會清空，所以 bytes 存 DB 才持久）。
// 上傳寫入 event_assets；committed 的 /banner-XXXX.png 仍走上面的 express.static。
app.get('/assets/:filename', async (req, res) => {
  try {
    const fn = req.params.filename;
    const r = await pool.query(`SELECT mime, bytes FROM event_assets WHERE filename=$1`, [fn]);
    if (!r.rows[0]) return res.status(404).send('Not found');
    res.set('Content-Type', r.rows[0].mime);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(r.rows[0].bytes);
  } catch (e) {
    console.error('[assets]', e.message);
    res.status(500).send('error');
  }
});

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
    CREATE TABLE IF NOT EXISTS event_assets (
      filename      TEXT PRIMARY KEY,        -- 例：banner-0706.png
      mime          TEXT NOT NULL,
      bytes         BYTEA NOT NULL,
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
  // 5/4、5/18、6/1 皆已結束，status='past'；6/22 為當前場次 status='published'，
  // 自動化 cron 只動 future 的 published 場次（6/21 20:00 day 提醒、6/22 18:30 hour 提醒、6/23 課後問卷）。
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
      ('2026-06-22', 'AI 共學聚 6/22',
       '一人公司品牌內容實戰！用 ChatGPT 快速打造你的內容系統',
       '6/22（一）20:00–21:00 線上', '/banner-0622.png',
       '2026-06-22T20:00:00+08:00', '2026-06-22T21:00:00+08:00',
       'https://forms.gle/VA4JDwSvbg13scB58', 'published')
    ON CONFLICT (event_date) DO NOTHING
  `);

  // ─── courses.html 卡片渲染欄位（讓 /courses 能從 events 表動態產生「下一場 / 過去課程」卡，過期自動歸檔）
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS lecturer TEXT`);        // 講師顯示名，例：王宣方 Din Din Wang
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS lecturer_img TEXT`);    // 講師頭像路徑，例：/dindin.jpg
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS blurb TEXT`);           // 卡片短描述（行銷文案）
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS signups INTEGER`);      // 過去場：報名數（選填，顯示 stat tag）
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS attended_count INTEGER`); // 過去場：出席數（選填）
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS meta_desc TEXT`);       // 報名頁 SEO description（選填，預設退回 blurb）
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS agenda TEXT`);          // 報名頁課綱純文字（空行分段、**粗體**、★星號重點）
  // 一次性 backfill：只在欄位仍為 NULL 時填（避免覆蓋後台日後手動編輯）。
  const seedCard = async (date, lecturer, img, blurb, signups = null, attended = null) =>
    pool.query(
      `UPDATE events SET lecturer=$2, lecturer_img=$3, blurb=$4, signups=$5, attended_count=$6
       WHERE event_date=$1 AND lecturer IS NULL`,
      [date, lecturer, img, blurb, signups, attended]
    );
  await seedCard('2026-05-04', '阿邦老師', '/abang.jpg',
    '從 Gmail、Google 雲端硬碟到 Gem 自動化機器人，掌握 Gemini 在工作與生活上的實戰應用。', 189, 101);
  await seedCard('2026-05-18', '王宣方 Din Din Wang', '/dindin.jpg',
    '小白也能快速做出精美社群內容。涵蓋 Claude Projects 入門、AI 輪播貼文實戰、Claude Skills × AI 工作流。');
  await seedCard('2026-06-01', '阿邦老師', '/abang.jpg',
    'Gemini Canvas 實作課：自然語言生成 AI 簡報、互動式旅遊小工具，不需設計或程式背景。');
  await seedCard('2026-06-22', '王宣方 Din Din Wang', '/dindin.jpg',
    '沒團隊、不懂行銷也能賣！用 ChatGPT 與 NotebookLM 打造內容系統：市場定位、品牌企劃、Threads 爆文、IG 文案到 AI 生圖一致性，新手也能上手。');

  // 報名頁課綱 + SEO 一次性 backfill（給 6/22 當動態渲染的參考範本；只在 agenda 仍空時填）
  await pool.query(
    `UPDATE events SET meta_desc=$2, agenda=$3 WHERE event_date=$1 AND agenda IS NULL`,
    ['2026-06-22',
     '2026/6/22（一）20:00 免費線上 AI 共學聚。沒團隊、不懂行銷也能賣！用 ChatGPT 與 NotebookLM 打造你的內容系統：市場定位、品牌企劃、Threads 爆文、IG 文案、AI 生圖一致性，新手也能上手。Din Din Wang 王宣方主講。',
     ['PART 1｜AI 當你的最強大腦',
      'AI 當你的**市場研究員**',
      '用 AI **分析競品**',
      '建立**品牌定位**',
      '**RACI 黃金指令**實戰',
      '',
      'PART 2｜AI 當你的萬能雙手',
      '**社群內容規劃**',
      '**Threads 爆文**生成',
      '**IG 貼文撰寫**技巧',
      '**高互動內容**設計',
      '',
      'PART 3｜全天候設計總監',
      '各種**圖文素材**生成',
      '**AI 生圖一致性**技巧',
      '**AI 商業應用**流程',
      '★現場完整示範｜Din Din 帶你跑一遍從零打造一人公司內容系統的完整流程'].join('\n')]
  );

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

// ─── 對外「當前場次」解析（events 表為 runtime 單一真相源）─────────────────────
// 規則：status='published' 中，今天/最近未來優先（升冪取最近的那場），沒有未來場才退回最近的過去場。
// → 後台「上架」下一場後，當前場過了會自動接棒，不必再改 Render 環境變數。
// 表空 / 查詢失敗 → 退回 server.js 頂部 env 常數組成的虛擬場次（向後相容，行為不變）。
let _currentEventCache = null;
let _currentEventCachedAt = 0;
// cron（runEventAutomation）用的近期 published 場次清單快取。
// 目的：讓 cron 平常只用記憶體判斷提醒到點與否，沒到點完全不查 DB →
// Neon compute 能 scale-to-zero，免費額度才撐得過一個月（本次掛站根因之一）。
let _eventListCache = null;
let _eventListCachedAt = 0;

function taipeiToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

async function resolveCurrentEvent() {
  try {
    const today = taipeiToday();
    const r = await pool.query(
      `SELECT * FROM events
       WHERE status = 'published'
       ORDER BY
         CASE WHEN event_date >= $1 THEN 0 ELSE 1 END,           -- 今天/未來優先
         CASE WHEN event_date >= $1 THEN event_date END ASC NULLS LAST,  -- 未來場取最近
         event_date DESC                                          -- 沒未來場則取最近的過去場
       LIMIT 1`,
      [today]
    );
    if (r.rows[0]) return mergeEventDefaults(r.rows[0]);
  } catch (e) { console.error('[events] resolveCurrentEvent fail:', e.message); }
  return mergeEventDefaults({
    event_date: CURRENT_EVENT_DATE,
    start_at: `${CURRENT_EVENT_DATE}T20:00:00+08:00`,
  });
}

// 取當前場次（60 秒快取，避免 /check-email 之類高頻路徑每次打 DB）。
async function getCurrentEvent() {
  const now = Date.now();
  if (_currentEventCache && now - _currentEventCachedAt < 60000) return _currentEventCache;
  _currentEventCache = await resolveCurrentEvent();
  _currentEventCachedAt = now;
  return _currentEventCache;
}

// 場次異動（上架/取消/建立）後呼叫，讓下一次 getCurrentEvent 立即重算。
function invalidateCurrentEvent() {
  _currentEventCachedAt = 0;
  _eventListCache = null;
  _openEventCache = { v: undefined, at: 0 };
  _publicEventsCache = { v: undefined, at: 0 };
}

// 同步存取點（給少數同步函式如 isEventLive 用）：回最後一次解析結果，未解析過退 env。
function currentEventSync() {
  return _currentEventCache || mergeEventDefaults({ event_date: CURRENT_EVENT_DATE });
}

// ─── 開放報名場次 + 公開場次清單（/courses 動態渲染、報名擋關用）──────────────
// getCurrentEvent() 在「沒有未來場」時會退回最近的過去場（給課後信/問卷用），
// 但「能不能報名」要的是嚴格的「今天/未來 且 已上架」——過了就沒有開放場次 → 報名關閉。
let _openEventCache = { v: undefined, at: 0 };
let _publicEventsCache = { v: undefined, at: 0 };

// 目前開放報名的場次：status='published' 且 event_date >= 今天，取最近一場；沒有則 null。
async function getOpenEvent() {
  const now = Date.now();
  if (_openEventCache.v !== undefined && now - _openEventCache.at < 60000) return _openEventCache.v;
  let result = null;
  try {
    const r = await pool.query(
      `SELECT * FROM events WHERE status='published' AND event_date >= $1
       ORDER BY event_date ASC LIMIT 1`,
      [taipeiToday()]
    );
    result = r.rows[0] ? mergeEventDefaults(r.rows[0]) : null;
  } catch (e) {
    console.error('[events] getOpenEvent fail:', e.message);
    result = null;
  }
  _openEventCache = { v: result, at: now };
  return result;
}

// 對外可見的場次（已上架或已結束），最新在前。draft / cancelled 不顯示。
async function getPublicEvents() {
  const now = Date.now();
  if (_publicEventsCache.v !== undefined && now - _publicEventsCache.at < 60000) return _publicEventsCache.v;
  let rows = null;
  try {
    const r = await pool.query(
      `SELECT * FROM events WHERE status IN ('published','past') ORDER BY event_date DESC`
    );
    rows = r.rows.map(mergeEventDefaults);
  } catch (e) {
    console.error('[events] getPublicEvents fail:', e.message);
    rows = null;  // null → 呼叫端沿用靜態 fallback
  }
  _publicEventsCache = { v: rows, at: now };
  return rows;
}

// ─── /courses 卡片 HTML 產生器（與 courses.html 既有 class 結構一致）────────────
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
// 'YYYY-MM-DD' → { big:'6/22', year:'2026', weekday:'週一' }
function eventDateParts(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const dt = new Date(`${dateStr}T12:00:00+08:00`);
  const weekday = dt.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', weekday: 'short' });
  return { big: `${Number(m)}/${Number(d)}`, year: y, weekday };
}
function eventTimeRange(ev) {
  const fmt = t => new Date(t).toLocaleTimeString('en-GB',
    { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
  if (!ev.start_at) return '';
  return ev.end_at ? `${fmt(ev.start_at)}–${fmt(ev.end_at)}` : fmt(ev.start_at);
}
function lecturerPill(ev) {
  const name = ev.lecturer || '王宣方 Din Din Wang';
  const img = ev.lecturer_img || '/dindin.jpg';
  const isAbang = /abang/i.test(img) || name.includes('阿邦');
  const fb = isAbang ? '阿' : 'DD';
  const fbStyle = isAbang ? 'background:linear-gradient(135deg,#8b5cf6,#3b82f6);' : '';
  return `<span class="lecturer-pill">
                        <img src="${escHtml(img)}" alt="${escHtml(name)}"
                             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                        <span class="fallback" style="display:none;${fbStyle}">${fb}</span>
                        ${escHtml(name)}
                    </span>`;
}
function renderNextCard(ev) {
  const { big, year, weekday } = eventDateParts(ev.event_date);
  const meta = `${year}<br>${weekday} · ${eventTimeRange(ev)}`;
  return `<a href="/register" class="course-card glass-card live block">
            <div class="course-banner">
                <img src="${escHtml(ev.banner || '/banner.png')}" alt="${escHtml(ev.title)} — ${escHtml(ev.topic)}" loading="lazy">
            </div>
            <div class="p-6 md:p-7 space-y-5">
                <div class="flex items-start justify-between gap-3 flex-wrap">
                    <div class="date-stamp">
                        <span class="big">${big}</span>
                        <span class="meta">${meta}</span>
                    </div>
                    <span class="badge badge-live"><i class="fas fa-bolt"></i> 報名中</span>
                </div>
                <div>
                    <h3 class="display-font text-xl md:text-2xl font-bold text-white leading-snug mb-2">${escHtml(ev.topic)}</h3>
                    <p class="text-slate-300 text-[14px] leading-relaxed">${escHtml(ev.blurb || '')}</p>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs uppercase tracking-wider text-slate-500 font-semibold mr-1">主講</span>
                    ${lecturerPill(ev)}
                </div>
                <div class="pt-2">
                    <span class="cta-btn w-full"><span>立即報名</span> <span class="arrow">→</span></span>
                </div>
            </div>
        </a>`;
}
function renderComingSoonCard() {
  return `<div class="course-card glass-card block">
            <div class="p-6 md:p-7 space-y-4 text-center">
                <span class="badge badge-done"><i class="fas fa-hourglass-half text-[10px]"></i> 籌備中</span>
                <h3 class="display-font text-xl md:text-2xl font-bold text-white leading-snug">下一場正在籌備中 🌱</h3>
                <p class="text-slate-300 text-[14px] leading-relaxed">AI 共學聚每月兩次。下一場主題與日期正在規劃中，加入官方 LINE 搶先收到開課通知，不錯過報名。</p>
                <div class="pt-1">
                    <a href="https://lin.ee/RBotXBl" target="_blank" rel="noopener" class="cta-btn w-full"><span>加入 LINE 收開課通知</span> <span class="arrow">→</span></a>
                </div>
            </div>
        </div>`;
}
function renderPastCard(ev) {
  const { big, year, weekday } = eventDateParts(ev.event_date);
  const meta = `${year}<br>${weekday} · ${eventTimeRange(ev)}`;
  const stats = (ev.signups != null || ev.attended_count != null) ? `
                <div class="flex items-center gap-2 flex-wrap pt-1">
                    ${ev.signups != null ? `<span class="stat-tag"><i class="fas fa-users text-[10px]"></i> ${ev.signups} 報名</span>` : ''}
                    ${ev.attended_count != null ? `<span class="stat-tag" style="background:rgba(56,189,248,0.1);border-color:rgba(56,189,248,0.2);color:#7dd3fc;"><i class="fas fa-video text-[10px]"></i> ${ev.attended_count} 出席</span>` : ''}
                </div>` : '';
  return `<div class="course-card glass-card block">
            <div class="course-banner past">
                <img src="${escHtml(ev.banner || '/banner.png')}" alt="${escHtml(ev.title)} — ${escHtml(ev.topic)}" loading="lazy">
            </div>
            <div class="p-6 md:p-7 space-y-5">
                <div class="flex items-start justify-between gap-3 flex-wrap">
                    <div class="date-stamp">
                        <span class="big" style="color:#94a3b8;">${big}</span>
                        <span class="meta">${meta}</span>
                    </div>
                    <span class="badge badge-done"><i class="fas fa-check text-[10px]"></i> 已結束</span>
                </div>
                <div>
                    <h3 class="display-font text-xl font-bold text-slate-100 leading-snug mb-2">${escHtml(ev.topic)}</h3>
                    <p class="text-slate-400 text-[14px] leading-relaxed">${escHtml(ev.blurb || '')}</p>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs uppercase tracking-wider text-slate-500 font-semibold mr-1">講師</span>
                    ${lecturerPill(ev)}
                </div>${stats}
            </div>
        </div>`;
}

// courses.html 模板（讀一次存記憶體；DYN 標記區由 events 表動態填入）
let _coursesTemplate = null;
function coursesTemplate() {
  if (_coursesTemplate == null) {
    _coursesTemplate = fs.readFileSync(path.join(__dirname, 'public', 'courses.html'), 'utf8');
  }
  return _coursesTemplate;
}
function fillDynBlock(html, name, inner) {
  const re = new RegExp(`<!-- DYN:${name}:START[\\s\\S]*?DYN:${name}:END -->`);
  return html.replace(re, `<!-- DYN:${name}:START -->\n${inner}\n        <!-- DYN:${name}:END -->`);
}

// ─── 報名落地頁 index.html 動態渲染（全自動：上架下一場後此頁自動長好，免手改）──────
const SITE = 'https://event.cosmoseed.com.tw';
// **x** → 粗體 span（先 escHtml 再轉粗體，避免 XSS 與標籤破壞）
function boldify(s) {
  return escHtml(s).replace(/\*\*(.+?)\*\*/g, '<span class="font-semibold text-slate-900">$1</span>');
}
function performerTitle(ev) {
  const img = ev.lecturer_img || '';
  const name = ev.lecturer || '';
  if (/abang/i.test(img) || name.includes('阿邦')) return 'AI 應用實戰講師／企業數位轉型顧問';
  return '品牌策略顧問／AI 應用陪跑教練';
}
function bannerAbs(ev) {
  const b = ev.banner || '/banner.png';
  const abs = b.startsWith('http') ? b : SITE + b;
  // 加場次版本戳（?v=YYYYMMDD），讓 LINE/FB 針對每場當成新圖重抓，
  // 避免分享縮圖沿用上一場的快取（尤其沒上傳專屬 banner、退回 /banner.png 時）。
  const v = (ev.event_date || '').replace(/-/g, '');
  return v ? `${abs}${abs.includes('?') ? '&' : '?'}v=${v}` : abs;
}
// 課綱純文字 → 設計過的 PART 卡 HTML。
// 格式：空行分段；每段第 1 行「PART X｜標題」（或只標題）；其餘每行一個項目；
//       **粗體**；★開頭=星號重點，可用｜接副說明。Q&A 區塊固定附在最後。
function renderAgenda(text) {
  const COLORS = ['blue', 'purple', 'amber'];
  const blocks = String(text || '').trim().split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const partsHtml = blocks.map((block, pi) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const head = lines.shift() || '';
    const sep = head.split(/｜|\|/);
    const label = sep.length > 1 ? sep[0].trim() : `PART ${pi + 1}`;
    const title = sep.length > 1 ? sep.slice(1).join('｜').trim() : head;
    const color = COLORS[pi % COLORS.length];
    let n = 0;
    const items = lines.map(raw => {
      const line = raw.replace(/^[-•]\s*/, '');
      if (/^★/.test(line)) {
        const body = line.replace(/^★\s*/, '');
        const [t, d] = body.split(/｜|\|/);
        return `                        <li class="flex items-start gap-3">
                            <span class="flex-shrink-0 w-6 h-6 rounded-md bg-amber-400 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">★</span>
                            <div class="flex-1">
                                <div class="text-[14px] text-slate-900 font-semibold leading-relaxed">${boldify(t.trim())}</div>${d ? `
                                <div class="text-[12.5px] text-slate-500 mt-0.5">${boldify(d.trim())}</div>` : ''}
                            </div>
                        </li>`;
      }
      n += 1;
      return `                        <li class="flex items-start gap-3">
                            <span class="flex-shrink-0 w-6 h-6 rounded-full bg-slate-900 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">${n}</span>
                            <div class="flex-1">
                                <div class="text-[14px] text-slate-700 leading-relaxed">${boldify(line)}</div>
                            </div>
                        </li>`;
    }).join('\n');
    return `                <div>
                    <div class="flex items-center gap-3 mb-3">
                        <span class="display-font text-xs font-bold tracking-wider text-${color}-600 bg-${color}-50 px-2.5 py-1 rounded-md">${escHtml(label)}</span>
                        <h3 class="font-bold text-slate-900 text-[16px]">${escHtml(title)}</h3>
                    </div>
                    <ol class="space-y-2.5 ml-3">
${items}
                    </ol>
                </div>`;
  }).join('\n\n');
  const qa = `                <div class="pt-4 border-t border-slate-100">
                    <div class="flex items-center gap-3">
                        <span class="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-500 text-white text-[11px] font-bold flex items-center justify-center">Q</span>
                        <div class="text-[14px] font-semibold text-slate-900">Q & A 自由交流</div>
                        <span class="text-[12.5px] text-slate-500">— 提問、討論</span>
                    </div>
                </div>`;
  return partsHtml ? `${partsHtml}\n\n${qa}` : qa;
}
// 報名頁 SEO：title+description（DYN:SEO1）
function renderSEOTitle(ev) {
  const { big } = eventDateParts(ev.event_date);
  const headline = `${big} AI 共學聚｜${ev.topic}`;
  const desc = ev.meta_desc || ev.blurb || ev.topic;
  return `<title>${escHtml(headline)}</title>
    <meta name="description" content="${escHtml(desc)}">`;
}
// 報名頁 SEO：og + twitter（DYN:SEO2）
function renderSEOSocial(ev) {
  const { big } = eventDateParts(ev.event_date);
  const headline = `${big} AI 共學聚｜${ev.topic}`;
  const desc = ev.blurb || ev.meta_desc || ev.topic;
  const img = bannerAbs(ev);
  return `<!-- Open Graph / Facebook / LINE -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="${SITE}/">
    <meta property="og:title" content="${escHtml(headline)}">
    <meta property="og:description" content="${escHtml(desc)}">
    <meta property="og:image" content="${escHtml(img)}">
    <meta property="og:locale" content="zh_TW">
    <meta property="og:site_name" content="宇宙種子 AI 共學聚">

    <!-- Twitter -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escHtml(headline)}">
    <meta name="twitter:description" content="${escHtml(desc)}">
    <meta name="twitter:image" content="${escHtml(img)}">`;
}
// 報名頁 SEO：Event JSON-LD（DYN:SEO3）
function renderSEOEvent(ev) {
  const desc = ev.meta_desc || ev.blurb || ev.topic;
  const img = bannerAbs(ev);
  const eventJson = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: `AI 共學聚 — ${ev.topic}`,
    startDate: new Date(ev.start_at).toISOString(),
    endDate: ev.end_at ? new Date(ev.end_at).toISOString() : undefined,
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    location: { '@type': 'VirtualLocation', url: `${SITE}/register` },
    description: desc,
    image: img,
    inLanguage: 'zh-TW',
    isAccessibleForFree: true,
    organizer: { '@type': 'Organization', name: '宇宙種子 CosmoSeed AI', url: `${SITE}/` },
    performer: { '@type': 'Person', name: ev.lecturer || 'AI 共學聚講師', jobTitle: performerTitle(ev) },
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'TWD', url: `${SITE}/register`, availability: 'https://schema.org/InStock' },
  };
  return `<script type="application/ld+json">
    ${JSON.stringify(eventJson, null, 2).split('\n').join('\n    ')}
    </script>`;
}
// ─── /courses 頁 OG（DYN:CSEO1 title+desc、DYN:CSEO2 og+twitter）─────────────────
// 有開放中的場次時，把課程頁分享縮圖同步成「下一場」的主題/簡介/banner，
// 避免報名連結在換場空窗期被 LINE 快取成上一場的靜態縮圖（本次縮圖顯示舊場次的根因）。
function renderCoursesSEO1(ev) {
  const { big } = eventDateParts(ev.event_date);
  const title = `AI 共學聚｜下一場 ${big} ${ev.topic} — 宇宙種子 CosmoSeed AI`;
  const desc = `下一場 ${big} 免費線上 AI 共學：${ev.blurb || ev.meta_desc || ev.topic}。每月兩次、0 程式基礎也能跟，含現場 Q&A 與 LINE 學員社群。宇宙種子 CosmoSeed AI 主辦。`;
  return `<title>${escHtml(title)}</title>
    <meta name="description" content="${escHtml(desc)}">`;
}
function renderCoursesSEO2(ev) {
  const { big } = eventDateParts(ev.event_date);
  const title = `AI 共學聚｜下一場 ${big} ${ev.topic}`;
  const desc = ev.blurb || ev.meta_desc || ev.topic;
  const img = bannerAbs(ev);
  return `<meta property="og:type" content="website">
    <meta property="og:url" content="${SITE}/courses">
    <meta property="og:title" content="${escHtml(title)}">
    <meta property="og:description" content="${escHtml(desc)}">
    <meta property="og:image" content="${escHtml(img)}">
    <meta property="og:locale" content="zh_TW">
    <meta property="og:site_name" content="宇宙種子 AI 共學聚">

    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escHtml(title)}">
    <meta name="twitter:description" content="${escHtml(desc)}">
    <meta name="twitter:image" content="${escHtml(img)}">`;
}
// /courses 的 Course JSON-LD 裡「當前梯次」CourseInstance（同步成開放中的場次，
// 讓 Google 結構化資料不再停在上一場的日期）。以 JSON 轉義（非 HTML）產生，安全放進 <script> JSON-LD。
function renderCourseInstance(ev) {
  const { big } = eventDateParts(ev.event_date);
  const start = new Date(ev.start_at).toISOString();
  const end = ev.end_at
    ? new Date(ev.end_at).toISOString()
    : new Date(new Date(ev.start_at).getTime() + 3600000).toISOString();
  const instructorId = /阿邦/.test(ev.lecturer || '') ? '#person-abang' : '#person-dindin';
  return `{
          "@type": "CourseInstance",
          "name": ${JSON.stringify(`AI 共學聚 ${big} — ${ev.topic}`)},
          "courseMode": "online",
          "courseWorkload": "PT1H",
          "startDate": "${start}",
          "endDate": "${end}",
          "instructor": { "@id": "https://event.cosmoseed.com.tw/${instructorId}" },
          "location": { "@type": "VirtualLocation", "url": "https://event.cosmoseed.com.tw/register" }
        }`;
}
// 本月主題卡內容（標題 + 副標 + 主講 pill + 課綱）
function renderThemeCard(ev) {
  return `<div class="text-center">
            <div class="inline-block px-3 py-1 rounded-full bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-100 text-xs font-semibold text-blue-700 mb-4 tracking-wide">
                本月主題
            </div>
            <h2 class="display-font text-2xl md:text-3xl font-bold text-slate-900 mb-3 leading-snug">${escHtml(ev.topic)}</h2>
            <p class="text-slate-600 text-[15px] md:text-base leading-relaxed max-w-lg mx-auto">${escHtml(ev.blurb || '')}</p>
        </div>

        <div class="mt-7 pt-6 border-t border-slate-100">
            <div class="flex flex-col items-center gap-2 mb-5">
                <div class="display-font text-lg font-bold text-slate-900">本次課綱</div>
                <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200/70">
                    <span class="text-[11px] font-semibold tracking-wider text-amber-700">主講</span>
                    <span class="display-font text-sm font-bold text-slate-900">${escHtml(ev.lecturer || '')}</span>
                </div>
            </div>
            <div class="space-y-6 max-w-xl mx-auto">
${renderAgenda(ev.agenda)}
            </div>
        </div>`;
}
// 報名頁模板（讀一次存記憶體）
let _registerTemplate = null;
function registerTemplate() {
  if (_registerTemplate == null) {
    _registerTemplate = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  }
  return _registerTemplate;
}
// 把當前開放場次填進報名頁所有 DYN 標記區
function renderRegisterPage(ev) {
  const { big, weekday } = eventDateParts(ev.event_date);
  const time = eventTimeRange(ev);
  const dateLabel = `${big}（${weekday.replace('週', '')}）${time}`;  // 6/22（一）20:00–21:00
  let html = registerTemplate();
  html = fillDynBlock(html, 'SEO1', renderSEOTitle(ev));
  html = fillDynBlock(html, 'SEO2', renderSEOSocial(ev));
  html = fillDynBlock(html, 'SEO3', renderSEOEvent(ev));
  html = fillDynBlock(html, 'HERO', `<img src="${escHtml(ev.banner || '/banner.png')}" alt="${escHtml(ev.topic)}" class="w-full h-auto block">`);
  html = fillDynBlock(html, 'DATECARD', `<div>
                <div class="text-xs text-slate-500 mb-1">日期</div>
                <div class="display-font text-2xl font-bold text-slate-900 whitespace-nowrap">${big} <span class="text-base font-medium text-slate-500">(${weekday})</span></div>
            </div>
            <div class="w-px h-10 bg-slate-200"></div>
            <div>
                <div class="text-xs text-slate-500 mb-1">時間</div>
                <div class="display-font text-2xl font-bold text-slate-900 whitespace-nowrap">${time.replace('–', ' – ')}</div>
            </div>
            <div class="w-px h-10 bg-slate-200 hidden sm:block"></div>
            <div class="hidden sm:block">
                <div class="text-xs text-slate-500 mb-1">形式</div>
                <div class="display-font text-2xl font-bold text-slate-900">線上</div>
            </div>`);
  html = fillDynBlock(html, 'THEME', renderThemeCard(ev));
  html = fillDynBlock(html, 'SUCCESS', `${dateLabel} 線上見！Meet 連結已寄到你的 Email，綁定 LINE 還可即時收提醒`);
  html = fillDynBlock(html, 'ATTEND', `${big} 晚上你能參加嗎？`);
  return html;
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

function buildBindReminderEmail(name, email, ev) {
  ev = mergeEventDefaults(ev) || mergeEventDefaults({ event_date: CURRENT_EVENT_DATE });
  const url = buildBindUrl(email);
  return {
    subject: `💻 AI 共學聚 ${ev.label.split('（')[0]} Meet 連結 — ${ev.label}`,
    text: `嗨 ${name}！\n\n你已報名 AI 共學聚 ✅\n\n📅 ${ev.label}\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📋 上課前請準備：\n${ev.prep}\n\n────\n\n📲 想接收 LINE 即時提醒？\n回我們的官方 LINE OA 完成綁定（30 秒）：\n${url}\n或在 LINE OA 對話直接傳這個 Email 給我們也行 🌱\n\n— AI 共學聚團隊 🧬`,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// 即時檢查 email 是否已報名
app.get('/check-email', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ registered: false });
  // 只檢查「開放報名中」的場次：沒有開放場次 → 回 closed，前端不再讓人送出
  const ev = await getOpenEvent();
  if (!ev) return res.json({ registered: false, closed: true });
  const result = await pool.query(
    'SELECT name, attendance FROM registrations WHERE email=$1 AND event_date=$2',
    [email, ev.event_date]
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

  // 報名擋關：只接受「今天/未來 且 已上架」的場次。場次過了又沒上架下一場 → 報名關閉。
  const ev = await getOpenEvent();
  if (!ev) {
    return res.json({
      success: false,
      closed: true,
      message: '目前沒有開放報名的場次 🌱 下一場籌備中，加入官方 LINE（lin.ee/RBotXBl）搶先收到開課通知！',
    });
  }

  // 防呆：已報名直接回傳提示（只檢查當前場次，跨場次允許再報一次）
  const existing = await pool.query(
    'SELECT name, attendance, line_user_id FROM registrations WHERE email=$1 AND event_date=$2',
    [email, ev.event_date]
  );
  if (existing.rows[0]) {
    const reg = existing.rows[0];
    if (reg.line_user_id) {
      // 已綁 LINE → 推 LINE 提醒（附 Meet 連結，方便重複查看）
      await sendLine(reg.line_user_id,
        `嗨 ${reg.name}！\n\n你已報名 AI 共學聚 ✅\n\n📅 ${ev.label}\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n\n活動前 30 分鐘會在這裡再提醒一次 🧬`
      );
    } else {
      // 未綁 LINE → Email 提醒（帶 Meet 連結）+ 鼓勵綁 LINE
      await sendEmail(
        email,
        '📋 你已報名 AI 共學聚！',
        `嗨 ${reg.name}！\n\n你已報名 AI 共學聚 ✅\n\n📅 ${ev.label}\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n\n📲 還沒綁定 LINE 嗎？點下面連結一鍵綁定（30 秒），活動前 30 分鐘會在 LINE 再提醒你：\n${buildBindUrl(email)}\n\n— AI 共學聚團隊 🧬`
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
    `, [name, email, attendance, interestStr, level||'', toolsStr, tools_other||'', job_type||'', source||'', want_to_learn||'', subscribe_line||'', ev.event_date]);

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
      isGoing ? `✅ AI 共學聚 — ${ev.label.split('（')[0]} 報名確認｜Meet 連結` : 'AI 共學聚 — 感謝填寫！',
      isGoing
        ? `嗨 ${name}！\n\n感謝你報名 AI 共學聚 🌱\n\n📅 ${ev.label}\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📲 完成 LINE 綁定可即時收 Meet 連結 + 活動前 30 分鐘 LINE 提醒：\n${buildBindUrl(email)}\n👆 點下去登入 LINE → 同意 → 加好友 → 自動完成，30 秒內搞定\n\n📋 上課前請準備：\n${ev.prep}\n\n— AI 共學聚團隊 🧬`
        : `嗨 ${name}！\n\n感謝你填寫表單！本場主題「${ev.topic}」於 ${ev.label}，若之後想參加歡迎再回來填一次 📅\n\n— AI 共學聚團隊 🧬`
    ).then(result => {
      // 寄信結果寫回 DB 供 admin 後台查看（首次報名確認信專用，duplicate/cron 不覆蓋）
      if (result?.ok) {
        pool.query(
          `UPDATE registrations SET email_sent_at=NOW(), email_status='sent', email_error=NULL
           WHERE email=$1 AND event_date=$2`,
          [email, ev.event_date]
        ).catch(e => console.error('[Email UPDATE ok]', e.message));
      } else {
        pool.query(
          `UPDATE registrations SET email_status='failed', email_error=$1
           WHERE email=$2 AND event_date=$3`,
          [(result?.error || 'unknown').slice(0, 500), email, ev.event_date]
        ).catch(e => console.error('[Email UPDATE fail]', e.message));
      }
    });

    // 雙通道通知：不管有沒有綁 LINE，Email 一定帶 Meet 連結（上方）；若已綁 LINE，再加推一次 LINE
    if (isGoing && binding.rows[0]?.line_user_id) {
      sendLine(binding.rows[0].line_user_id,
        `嗨 ${name}！\n\n你已報名 AI 共學聚 ✅\n\n📅 ${ev.label}\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n🔔 19:50 開放、20:00 準時開始\n\n📋 上課前請準備：\n${ev.prep}\n\n活動前 30 分鐘會在這裡再提醒你一次 🧬`);
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

    const ev = await getCurrentEvent();
    const reg = await pool.query('SELECT * FROM registrations WHERE email=$1', [email.toLowerCase()]);
    if (reg.rows[0]) {
      await pool.query('UPDATE registrations SET line_user_id=$1 WHERE email=$2', [userId, email.toLowerCase()]);
      // 綁定成功 → 立即推 Meet 連結（不再等當天 cron）
      await sendLine(userId,
        `已為你完成綁定 ✅\n\n${reg.rows[0].name} 你好！\n${ev.label} AI 共學聚見 🌱\n📌 主題：${ev.topic}\n\n💻 Meet 連結（已寄到信箱，這裡再給你一份）：\n${ev.meet_url}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📋 上課前請準備：\n${ev.prep}\n\n活動前 30 分鐘會在這裡再提醒你 🧬`
      );
      res.redirect('/?bound=success&name=' + encodeURIComponent(reg.rows[0].name));
    } else {
      // 外部報名者（如活動通）：line_bindings 已寫入，立即推 Meet 連結
      await sendLine(userId,
        `已為你完成綁定 ✅\n\n${ev.label} AI 共學聚見 🌱\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📋 上課前請準備：\n${ev.prep}\n\n活動前 30 分鐘會在這裡再提醒你 🧬`
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
      const ev = await getCurrentEvent();        // 當前場次（events 表單一真相源）

      // 線上點名：「報到」keyword（限當前場次 ev.event_date）— 放在 alreadyBound 之前，bound 用戶也能觸發
      // 接受純 keyword 與帶日期前綴（例如「6/1報到」「2026-06-01簽到」）兩種寫法；日期前綴只當語意糖，實際以 ev.event_date 為準
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
            [userId, ev.event_date]
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
              [dbName, knownEmail, ev.event_date, userId]
            );
          }
          await pool.query(`UPDATE line_bindings SET awaiting_attendance_email=FALSE WHERE line_user_id=$1`, [userId]);
          const slidesRow = await pool.query(`SELECT slides_url FROM event_slides WHERE event_date=$1`, [ev.event_date]);
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
          const slidesRow = await pool.query(`SELECT slides_url FROM event_slides WHERE event_date=$1`, [ev.event_date]);
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
            [profile.displayName || '(LINE 來賓)', email, ev.event_date, userId]
          );
          await pool.query(
            `UPDATE line_bindings SET awaiting_attendance_email=FALSE, email=$2, display_name=COALESCE(display_name,$3) WHERE line_user_id=$1`,
            [userId, email, profile.displayName || null]
          );
          const slidesRow = await pool.query(`SELECT slides_url FROM event_slides WHERE event_date=$1`, [ev.event_date]);
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
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: `已為你完成綁定 ✅\n\n${reg.rows[0].name} 你好！\n${ev.label} AI 共學聚見 🌱\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n\n活動前 30 分鐘會在這裡再提醒你 🧬` });
        } else {
          // 外部報名者（如活動通）：line_bindings 已寫入，直接通知綁定成功 + Meet 連結
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: `已為你完成綁定 ✅\n\n${ev.label} AI 共學聚見 🌱\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n\n活動前 30 分鐘會在這裡再提醒你 🧬` });
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
      currentEvent: (await getCurrentEvent()).event_date,
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
  const current = await getCurrentEvent();
  res.json({ count: result.rows.length, events: result.rows, currentEventDate: current.event_date });
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
         survey_offset_min, status, lecturer, lecturer_img, blurb, meta_desc, agenda)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
              COALESCE($12,1440), COALESCE($13,90), COALESCE($14,720), COALESCE($15,'draft'),
              $16,$17,$18,$19,$20)
      ON CONFLICT (event_date) DO UPDATE SET
        title=EXCLUDED.title, topic=EXCLUDED.topic, label=EXCLUDED.label, prep=EXCLUDED.prep,
        meet_url=EXCLUDED.meet_url, banner=EXCLUDED.banner, start_at=EXCLUDED.start_at,
        end_at=EXCLUDED.end_at, registration_open_at=EXCLUDED.registration_open_at,
        survey_url=EXCLUDED.survey_url,
        reminder_day_offset_min=EXCLUDED.reminder_day_offset_min,
        reminder_hour_offset_min=EXCLUDED.reminder_hour_offset_min,
        survey_offset_min=EXCLUDED.survey_offset_min,
        status=EXCLUDED.status,
        lecturer=COALESCE(EXCLUDED.lecturer, events.lecturer),
        lecturer_img=COALESCE(EXCLUDED.lecturer_img, events.lecturer_img),
        blurb=COALESCE(EXCLUDED.blurb, events.blurb),
        meta_desc=COALESCE(EXCLUDED.meta_desc, events.meta_desc),
        agenda=COALESCE(EXCLUDED.agenda, events.agenda)
      RETURNING *
    `, [event_date, b.title, b.topic, b.label || null, b.prep || null, b.meet_url || null,
        b.banner || null, b.start_at, b.end_at || null, b.registration_open_at || null,
        b.survey_url || null, b.reminder_day_offset_min, b.reminder_hour_offset_min,
        b.survey_offset_min, b.status, b.lecturer || null, b.lecturer_img || null, b.blurb || null,
        b.meta_desc || null, b.agenda || null]);
    invalidateCurrentEvent();   // 場次內容/狀態變了 → 下次 getCurrentEvent 立即重算
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
  invalidateCurrentEvent();
  res.json({ success: true, event: r.rows[0] });
});

app.post('/admin/api/events/cancel', adminAuth, async (req, res) => {
  const eventDate = req.query.event || req.body?.event;
  if (!eventDate) return res.status(400).json({ error: 'Missing event' });
  const r = await pool.query(`UPDATE events SET status='cancelled' WHERE event_date=$1 RETURNING *`, [eventDate]);
  if (!r.rowCount) return res.status(404).json({ error: 'Event not found' });
  invalidateCurrentEvent();
  res.json({ success: true, event: r.rows[0] });
});

// ─── 部落格管理（cosmoseed.com.tw/blog）────────────────────────────────────────
// 內容住在 GitHub repo（靜態 Astro 站，PostLayout.astro 自動生 AEO schema），不搬進本 DB。
// 後台用 GitHub Contents API 對 repo 增改 markdown；上架/下架 = toggle frontmatter 的
// draft 欄位 + commit → Netlify 自動 rebuild（約 1 分鐘）。draft:true 的文章 Astro 不會
// 產頁也不列入列表（見 index.astro / [slug].astro 的 !data.draft 過濾），等同下架。
const BLOG_REPO = process.env.BLOG_REPO || 'kaidinwang/cosmoseed-blog';
const BLOG_DIR = 'src/content/blog';
const BLOG_BRANCH = process.env.BLOG_BRANCH || 'main';
function githubReady() { return !!process.env.BLOG_GITHUB_TOKEN; }

// GitHub REST API 呼叫（回 { status, json }）。需要 BLOG_GITHUB_TOKEN（fine-grained PAT，
// 對 cosmoseed-blog 給 Contents read/write）。GitHub 強制要 User-Agent。
function githubRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.BLOG_GITHUB_TOKEN;
    if (!token) return reject(new Error('BLOG_GITHUB_TOKEN not set'));
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', path: apiPath, method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cosmoseed-admin',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 從 markdown frontmatter 抽出列表/狀態要顯示的欄位
function blogParseMeta(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = m ? m[1] : '';
  const get = k => {
    const r = fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  return {
    title: get('title'),
    description: get('description'),
    publishDate: get('publishDate'),
    category: get('category'),
    draft: get('draft') === 'true',
  };
}

// 改寫 frontmatter 的 draft 欄位（沒有就補一行）。draft=true 下架、false 上架。
function blogSetDraft(content, draft) {
  const val = draft ? 'true' : 'false';
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error('frontmatter not found');
  let fm = m[1];
  fm = /^draft:\s*.*$/m.test(fm)
    ? fm.replace(/^draft:\s*.*$/m, `draft: ${val}`)
    : `${fm}\ndraft: ${val}`;
  return content.replace(/^---\n[\s\S]*?\n---/, () => `---\n${fm}\n---`);
}

async function blogGetFile(slug) {
  const r = await githubRequest('GET',
    `/repos/${BLOG_REPO}/contents/${BLOG_DIR}/${slug}.md?ref=${BLOG_BRANCH}`);
  if (r.status !== 200 || !r.json?.content) return null;
  return { content: Buffer.from(r.json.content, 'base64').toString('utf8'), sha: r.json.sha };
}

async function blogPutFile(slug, content, sha, message) {
  const body = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch: BLOG_BRANCH };
  if (sha) body.sha = sha;
  return githubRequest('PUT', `/repos/${BLOG_REPO}/contents/${BLOG_DIR}/${slug}.md`, body);
}

const blogGuard = (req, res) => {
  if (!githubReady()) { res.status(503).json({ error: 'BLOG_GITHUB_TOKEN 未設定，後台還連不到部落格 repo。請到 Render 環境變數設定。' }); return false; }
  return true;
};

// 列出所有文章（含草稿）+ 狀態
app.get('/admin/api/blog/posts', adminAuth, async (req, res) => {
  if (!blogGuard(req, res)) return;
  try {
    const r = await githubRequest('GET', `/repos/${BLOG_REPO}/contents/${BLOG_DIR}?ref=${BLOG_BRANCH}`);
    if (r.status !== 200) return res.status(r.status).json({ error: r.json?.message || 'GitHub 列表失敗' });
    const files = (r.json || []).filter(f => f.name && f.name.endsWith('.md'));
    const posts = await Promise.all(files.map(async f => {
      const slug = f.name.replace(/\.md$/, '');
      const got = await blogGetFile(slug);
      return { slug, ...(got ? blogParseMeta(got.content) : {}) };
    }));
    posts.sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));
    res.json({ posts, repo: BLOG_REPO });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 取單篇 raw markdown（編輯用）
app.get('/admin/api/blog/posts/:slug', adminAuth, async (req, res) => {
  if (!blogGuard(req, res)) return;
  try {
    const got = await blogGetFile(req.params.slug);
    if (!got) return res.status(404).json({ error: '找不到文章' });
    res.json({ slug: req.params.slug, content: got.content, ...blogParseMeta(got.content) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 新增草稿（建檔，預設依 frontmatter；建議帶 draft:true）
app.post('/admin/api/blog/posts', adminAuth, async (req, res) => {
  if (!blogGuard(req, res)) return;
  const { slug, content } = req.body || {};
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'slug 只能小寫英數與連字號，例：2026-06-24-my-post' });
  if (!content || !content.trim()) return res.status(400).json({ error: '內容必填' });
  try {
    if (await blogGetFile(slug)) return res.status(409).json({ error: '同名文章已存在' });
    const r = await blogPutFile(slug, content, null, `blog: 新增草稿 ${slug}`);
    if (r.status >= 300) return res.status(r.status).json({ error: r.json?.message || '建立失敗' });
    res.json({ ok: true, slug });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 編輯內容（後端自行抓最新 sha，前端不必管）
app.put('/admin/api/blog/posts/:slug', adminAuth, async (req, res) => {
  if (!blogGuard(req, res)) return;
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: '內容必填' });
  try {
    const got = await blogGetFile(req.params.slug);
    if (!got) return res.status(404).json({ error: '找不到文章' });
    const r = await blogPutFile(req.params.slug, content, got.sha, `blog: 編輯 ${req.params.slug}`);
    if (r.status >= 300) return res.status(r.status).json({ error: r.json?.message || '儲存失敗' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 上架 / 下架（toggle frontmatter draft）
async function blogSetPublish(slug, draft, res) {
  const got = await blogGetFile(slug);
  if (!got) return res.status(404).json({ error: '找不到文章' });
  const updated = blogSetDraft(got.content, draft);
  const r = await blogPutFile(slug, updated, got.sha, `blog: ${draft ? '下架' : '上架'} ${slug}`);
  if (r.status >= 300) return res.status(r.status).json({ error: r.json?.message || '操作失敗' });
  res.json({ ok: true, draft });
}
app.post('/admin/api/blog/posts/:slug/publish', adminAuth, async (req, res) => {
  if (!blogGuard(req, res)) return;
  try { await blogSetPublish(req.params.slug, false, res); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/admin/api/blog/posts/:slug/unpublish', adminAuth, async (req, res) => {
  if (!blogGuard(req, res)) return;
  try { await blogSetPublish(req.params.slug, true, res); } catch (e) { res.status(500).json({ error: e.message }); }
});

// 刪除文章
app.delete('/admin/api/blog/posts/:slug', adminAuth, async (req, res) => {
  if (!blogGuard(req, res)) return;
  try {
    const got = await blogGetFile(req.params.slug);
    if (!got) return res.status(404).json({ error: '找不到文章' });
    const r = await githubRequest('DELETE', `/repos/${BLOG_REPO}/contents/${BLOG_DIR}/${req.params.slug}.md`,
      { message: `blog: 刪除 ${req.params.slug}`, sha: got.sha, branch: BLOG_BRANCH });
    if (r.status >= 300) return res.status(r.status).json({ error: r.json?.message || '刪除失敗' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 後台直接上傳場次 banner 圖檔（bytes 存 DB，持久；回傳可直接填進場次 banner 欄位的 URL）。
// 用法：POST /admin/api/upload-banner?pw=...&filename=banner-0706.png  body=圖檔 binary，Content-Type: image/*
app.post('/admin/api/upload-banner', adminAuth, express.raw({ type: ['image/*'], limit: '8mb' }), async (req, res) => {
  try {
    const fn = (req.query.filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!fn || !/\.(png|jpe?g|webp)$/i.test(fn)) {
      return res.status(400).json({ error: '檔名需為 .png/.jpg/.jpeg/.webp，例：banner-0706.png' });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: '沒收到圖檔，請確認 Content-Type 為 image/* 且 body 是圖檔' });
    }
    const mime = req.headers['content-type'] || 'image/png';
    await pool.query(
      `INSERT INTO event_assets (filename, mime, bytes, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (filename) DO UPDATE SET mime=EXCLUDED.mime, bytes=EXCLUDED.bytes, updated_at=NOW()`,
      [fn, mime, req.body]
    );
    // 同步寫一份到 public/（讓本次部署期間 /banner-XXXX.png 直接命中 static；重部署後仍以 /assets 為準）
    try { fs.writeFileSync(path.join(__dirname, 'public', fn), req.body); } catch (_) {}
    console.log(`[upload-banner] ${fn} (${mime}, ${req.body.length} bytes)`);
    res.json({ success: true, filename: fn, url: `/assets/${fn}`, size: req.body.length });
  } catch (err) {
    console.error('[upload-banner]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 活動後寄簡報：對當前場次 attended=TRUE 的人批次寄信
// 用法：POST /admin/api/send-slides?pw=...&event=2026-05-18&url=<簡報URL>[&dry=1]
app.post('/admin/api/send-slides', adminAuth, async (req, res) => {
  try {
    const eventDate = req.query.event || (await getCurrentEvent()).event_date;
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
  const ev = await getCurrentEvent();
  const renderRows = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE attendance IN ('Yes','Maybe')) AS render_attending,
      COUNT(*) FILTER (WHERE attendance IN ('Yes','Maybe') AND line_user_id IS NOT NULL) AS render_attending_bound
    FROM registrations
    WHERE event_date=$1
  `, [ev.event_date]);
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
  // ⚠️ day 提醒不寫死「明天」：若因故遲發（如系統當天才補發）會誤導學員以為改天上課。
  // 改用場次標籤（含明確日期，如「6/22（一）20:00–21:00 線上」），遲發也不會搞錯。
  const dateLabel = ev.label || ev.event_date;
  const lineMsg = type === 'hour'
    ? `⏰ 今晚就要開始囉！\n\nAI 共學聚今晚 20:00–21:00 線上見 🚀\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n\n🔔 19:50 開放進入教室、20:00 準時開始\n\n📋 記得準備：\n${ev.prep}\n\n晚點見！🧬`
    : `📅 上課提醒！\n\nAI 共學聚 ${dateLabel}\n📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n\n期待和大家一起共學！🧬`;
  const emailSubject = type === 'hour' ? '⏰ AI 共學聚今晚 20:00 開始！' : `📅 上課提醒：AI 共學聚 ${dateLabel}`;

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
  const ev = await getCurrentEvent();
  return sendRemindersForEvent(ev, type);
}

// 一次性「更正」廣播：因遲發的 day 提醒誤寫「明天」，發更正告知今天上課。
// 用法（瀏覽器直接開）：
//   先預覽人數： https://event.cosmoseed.com.tw/admin/api/send-correction?pw=後台密碼&dry=1
//   實際發送：   https://event.cosmoseed.com.tw/admin/api/send-correction?pw=後台密碼
// 對象與提醒完全一致：本場 Yes/Maybe 報名者 + 外部 LINE 綁定者。
app.get('/admin/api/send-correction', adminAuth, async (req, res) => {
  try {
    const dry = req.query.dry === '1';
    const ev = mergeEventDefaults(await getCurrentEvent());
    const dateLabel = ev.label || ev.event_date;
    const msg = `🔔 更正通知（剛剛的訊息誤寫成「明天」，抱歉造成困擾 🙏）\n\n`
      + `✅ 正確上課時間是【今天】${dateLabel}\n`
      + `AI 共學聚就在今晚 20:00–21:00 線上開始，不是明天喔！\n\n`
      + `📌 主題：${ev.topic}\n\n💻 Meet 連結：\n${ev.meet_url}\n\n今晚見！🧬`;
    const subject = `🔔 更正：AI 共學聚是「今晚」（${ev.event_date}）20:00，不是明天`;

    const regs = await pool.query(
      `SELECT * FROM registrations WHERE attendance IN ('Yes','Maybe') AND event_date=$1`,
      [ev.event_date]
    );
    let lineSent = 0, emailSent = 0;
    if (!dry) {
      for (const reg of regs.rows) {
        if (reg.line_user_id) { await sendLine(reg.line_user_id, `嗨 ${reg.name}！\n\n${msg}`); lineSent++; }
        else { await sendEmail(reg.email, subject, `嗨 ${reg.name}！\n\n${msg}\n\n— AI 共學聚團隊 🧬`); emailSent++; }
      }
    } else {
      for (const reg of regs.rows) { if (reg.line_user_id) lineSent++; else emailSent++; }
    }

    const ext = await pool.query(`
      SELECT lb.line_user_id, lb.display_name
      FROM line_bindings lb
      LEFT JOIN registrations r ON lb.email = r.email
      WHERE r.id IS NULL AND lb.line_user_id IS NOT NULL
    `);
    if (!dry) {
      for (const b of ext.rows) {
        await sendLine(b.line_user_id, `${b.display_name ? `嗨 ${b.display_name}！\n\n` : '嗨！\n\n'}${msg}`);
        lineSent++;
      }
    } else {
      lineSent += ext.rows.length;
    }

    console.log(`[Correction] ${dry ? '(dry-run) ' : ''}event=${ev.event_date} line=${lineSent} email=${emailSent}`);
    res.json({ success: true, dryRun: dry, event: ev.event_date, lineSent, emailSent, preview: msg });
  } catch (e) {
    console.error('[Correction Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

// ─── 自動化心臟：每 5 分鐘掃近期 published 場次，到點就發 day/hour 提醒、課後問卷補推 ──
// 冪等：每個動作發完蓋戳記（reminder_day_sent_at / reminder_hour_sent_at / survey_sent_at），不重發。
//
// 💸 省 Neon 額度的關鍵：場次清單走 6 小時記憶體快取（_eventListCache），cron 平常只在
//    記憶體裡判斷有沒有到點，沒到點就直接 return、完全不碰 DB → Neon compute 可 scale-to-zero。
//    只有 (a) 快取過期重撈 (b) 真的要發提醒/問卷 (c) 後台改場次(invalidateCurrentEvent) 才查 DB。
const EVENT_LIST_TTL = 6 * 60 * 60 * 1000; // 6 小時
async function getRelevantEvents() {
  const now = Date.now();
  if (_eventListCache && now - _eventListCachedAt < EVENT_LIST_TTL) return _eventListCache;
  const { rows } = await pool.query(
    `SELECT * FROM events
     WHERE status = 'published'
       AND start_at > NOW() - INTERVAL '3 days'`
  );
  _eventListCache = rows;
  _eventListCachedAt = now;
  return rows;
}

async function runEventAutomation() {
  try {
    const now = Date.now();
    const rows = await getRelevantEvents();   // 多數情況回記憶體快取，不打 DB
    for (const ev of rows) {
      const start = new Date(ev.start_at).getTime();
      const dayAt  = start - (ev.reminder_day_offset_min  ?? 1440) * 60000;
      const hourAt = start - (ev.reminder_hour_offset_min ?? 90)   * 60000;
      const dayDue  = !ev.reminder_day_sent_at  && now >= dayAt  && now < start;
      const hourDue = !ev.reminder_hour_sent_at && now >= hourAt && now < start;
      let surveyAt = null, surveyDue = false;
      if (ev.end_at && !ev.survey_sent_at) {
        surveyAt = new Date(ev.end_at).getTime() + (ev.survey_offset_min ?? 720) * 60000;
        surveyDue = now >= surveyAt && !!ev.survey_url;
      }
      // 這場沒有任何動作到點 → 不碰 DB（讓 Neon 能休眠）
      if (!dayDue && !hourDue && !surveyDue) continue;

      // 同分鐘兩封都到點（通常是「遲上架」：publish 時已過 day 提醒時間）→ 只發較緊急的 hour，
      // day 直接蓋戳記但不寄，避免同一個人在同一分鐘收到兩封幾乎一樣的提醒。
      if (dayDue && hourDue) {
        await sendRemindersForEvent(ev, 'hour');
        await pool.query(
          `UPDATE events SET reminder_hour_sent_at = NOW(), reminder_day_sent_at = NOW() WHERE id = $1`,
          [ev.id]
        );
        ev.reminder_hour_sent_at = ev.reminder_day_sent_at = new Date(); // 同步快取，避免下輪重發
        console.log(`[EventAutomation] ${ev.event_date} 遲上架：day+hour 同分鐘到點，只發 hour、day 標記略過`);
      } else if (dayDue) {
        await sendRemindersForEvent(ev, 'day');
        await pool.query(`UPDATE events SET reminder_day_sent_at = NOW() WHERE id = $1`, [ev.id]);
        ev.reminder_day_sent_at = new Date();
      } else if (hourDue) {
        await sendRemindersForEvent(ev, 'hour');
        await pool.query(`UPDATE events SET reminder_hour_sent_at = NOW() WHERE id = $1`, [ev.id]);
        ev.reminder_hour_sent_at = new Date();
      }
      // 課後問卷補推：結束後 survey_offset_min 分鐘，且有設 survey_url
      if (surveyDue) {
        await sendPostEventSurvey(ev);
        await pool.query(`UPDATE events SET survey_sent_at = NOW() WHERE id = $1`, [ev.id]);
        ev.survey_sent_at = new Date();
      }
    }
  } catch (e) {
    console.error('[EventAutomation] error:', e.message);
  }
}
// 每 5 分鐘跑一次：因為平常只查記憶體快取、不打 DB，頻繁也不燒 Neon；提醒最多晚 5 分鐘。
cron.schedule('*/5 * * * *', runEventAutomation, { timezone: 'Asia/Taipei' });

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

  // 文案場次：有指定 eventDate 就讀那場，否則用當前場次（null 欄位退回 env 常數）
  const ev = eventDate ? await getEventByDate(eventDate) : await getCurrentEvent();
  const sent = [];
  for (const reg of result.rows) {
    const { subject, text } = buildBindReminderEmail(reg.name, reg.email, ev);
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

// 一次性：場次改期通知 — 對指定場次報名者寄「6/15 順延至 6/22 + 邀請加入官方 LINE 取得上課訊息」Email
// 用法：GET /admin/api/send-event-change-notice?pw=...&event=2026-06-22[&dry=1]
app.get('/admin/api/send-event-change-notice', adminAuth, async (req, res) => {
  try {
    const eventDate = req.query.event || CURRENT_EVENT_DATE;
    const dryRun = req.query.dry === '1';
    const result = await pool.query(
      `SELECT id, name, email FROM registrations
       WHERE event_date=$1 AND email IS NOT NULL AND email <> ''
       ORDER BY created_at ASC`,
      [eventDate]
    );
    const subject = '【AI 共學聚】場次調整通知：原 6/15 順延至 6/22（時間不變）';
    const sent = [];
    for (const r of result.rows) {
      const text = `嗨 ${r.name}！\n\n感謝你報名 AI 共學聚 🌱 跟你說一個小調整：\n原訂 6/15（一）的場次因故順延一週，新日期是——\n\n📅 ${EVENT_LABEL}（時間不變）\n📌 主題：${EVENT_TOPIC}\n💻 Meet 連結：\n${MEET_URL}\n🔔 19:50 開放進入教室、20:00 準時開始\n\n你的報名我們已自動保留到新場次，不用重新報名 ✅\n\n────\n\n📲 上課提醒與當天 Meet 連結都會透過官方 LINE 發送，請務必加入並完成綁定（30 秒）：\n${buildBindUrl(r.email)}\n👆 點下去登入 LINE → 同意 → 加好友 → 自動完成\n\n📋 上課前請準備：\n${EVENT_PREP}\n\n造成不便很抱歉，6/22 線上見！🧬\n— Din Din Wang｜AI 共學聚團隊`;
      if (!dryRun) await sendEmail(r.email, subject, text);
      sent.push({ id: r.id, name: r.name, email: r.email });
    }
    console.log(`[EventChangeNotice] ${dryRun ? '(dry-run) ' : ''}event=${eventDate} sent=${sent.length}`);
    res.json({ success: true, dryRun, eventDate, count: sent.length, recipients: sent });
  } catch (err) {
    console.error('[Event Change Notice Error]', err.message);
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
cron.schedule('0 12 * * *', async () => {
  try {
    const ev = await getCurrentEvent();
    await sendBindReminders({ eventDate: ev.event_date, minAgeHours: 24 });
  } catch (err) { console.error('[BindReminder Cron Error]', err.message); }
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

// DB 初始化（成功才 dbReady=true）；失敗不再 process.exit，改進維護模式 + 背景重試
async function tryInitDB() {
  await initDB();
  const cur = await getCurrentEvent();   // 暖機：解析當前場次（events 表單一真相源）
  dbReady = true;
  console.log(`   當前場次（events 表）: ${cur.event_date} — ${cur.label}`);
}

tryInitDB().catch(err => {
  console.error('⚠️ DB 連線失敗，以「維護模式」啟動（網頁回 503 維護頁，不再整站空轉）:', err.message);
  // 背景每 30 秒重試，DB 一復原就自動恢復服務，免手動重啟
  const retry = setInterval(() => {
    tryInitDB().then(() => {
      console.log('✅ DB 已恢復，服務恢復正常');
      clearInterval(retry);
    }).catch(e => console.error('   DB 重試仍失敗:', e.message));
  }, 30000);
}).finally(() => {
  app.listen(PORT, () => {
    console.log(`🚀 伺服器啟動 port ${PORT}${dbReady ? '' : '（⚠️ 維護模式：DB 未就緒）'}`);
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
});

