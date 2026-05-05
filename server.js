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

const app = express();
app.use(cors());
// /webhook 用 raw body（LINE 簽章驗證需要），其餘用 JSON
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  express.json()(req, res, next);
});
// 5/4 結束後關閉公開報名頁，主辦人帶 ?preview=ADMIN_PASSWORD 才能看完整表單
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    const previewPw = req.query.preview;
    const validPasswords = (process.env.ADMIN_PASSWORD || '').split(',').map(p => p.trim()).filter(Boolean);
    if (!previewPw || !validPasswords.includes(previewPw)) {
      return res.sendFile(path.join(__dirname, 'public', 'coming-soon.html'));
    }
  }
  next();
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

// ─── Routes ──────────────────────────────────────────────────────────────────

// 即時檢查 email 是否已報名
app.get('/check-email', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ registered: false });
  const result = await pool.query('SELECT name, attendance FROM registrations WHERE email=$1', [email]);
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

  // 防呆：已報名直接回傳提示
  const existing = await pool.query('SELECT name, attendance, line_user_id FROM registrations WHERE email=$1', [email]);
  if (existing.rows[0]) {
    const reg = existing.rows[0];
    if (reg.line_user_id) {
      // 已綁 LINE → 推 LINE 提醒
      await sendLine(reg.line_user_id,
        `嗨 ${reg.name}！\n\n你之前已報名過 5/4 共學聚 ✅\n5/4 已圓滿結束 ❤️\n\n下一場預計 5/18（日）20:00，\n正式報名開放時會在這裡通知你 🧬`
      );
    } else {
      // 未綁 LINE → Email 提醒並鼓勵加入 LINE@
      await sendEmail(
        email,
        '📋 你已報名 AI 共學聚！',
        `嗨 ${reg.name}！\n\n你之前已報名過 5/4 共學聚 ✅\n5/4 場次已圓滿結束。\n\n下一場預計 5/18（日）20:00–21:00，\n正式報名開放時會通知你！\n\n📲 還沒加入 LINE OA 嗎？\n👉 https://lin.ee/9WduU6Y\n下一場活動詳情會優先在 LINE 通知！\n\n— AI 共學聚團隊 🧬`
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

    res.json({ success: true, message: '報名成功！確認信已寄出' });

    // 寄信與 LINE 通知背景執行，不阻塞回應
    const isGoing = attendance === 'Yes' || attendance === 'Maybe';
    sendEmail(
      email,
      isGoing ? '✅ AI 共學聚 — 報名確認' : 'AI 共學聚 — 感謝填寫！',
      isGoing
        ? `嗨 ${name}！\n\n感謝你的填寫 🌱\n\n5/4 AI 共學聚已圓滿結束。\n下一場預計 5/18（日）20:00 線上直播，\n正式報名連結尚未開放。\n\n📲 加入 LINE OA：https://lin.ee/9WduU6Y\n下一場開放報名時會第一時間透過 LINE 通知你！\n\n— AI 共學聚團隊 🧬`
        : `嗨 ${name}！\n\n感謝你填寫表單！下一場活動開放報名時會通知你 📅\n\n— AI 共學聚團隊 🧬`
    );

    if (binding.rows[0]?.line_user_id) {
      sendLine(binding.rows[0].line_user_id,
        `嗨 ${name}！\n\n感謝你的填寫 🌱\n5/4 共學聚已結束。\n下一場預計 5/18（日）20:00，正式報名開放時會在這裡通知你 🧬`);
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
        `已為你完成綁定 ✅\n\n${reg.rows[0].name} 你好！\n下次活動我們會透過 LINE 通知你 🌱\n（下一場預計 5/18 同一時間）`
      );
      res.redirect('/?bound=success&name=' + encodeURIComponent(reg.rows[0].name));
    } else {
      // 外部報名者（如活動通）：line_bindings 已寫入，回成功頁不要求重填站內表單
      await sendLine(userId,
        `已為你完成綁定 ✅\n\n下次活動我們會透過 LINE 通知你 🌱\n（下一場預計 5/18 同一時間）`
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
          text: `歡迎回來，${reg.rows[0].name}！🧬\n\n📅 下一場 AI 共學聚預計\n5/18（日）晚上 20:00（同一時間）\n\n詳細課程內容與報名表單會在這裡推播，\n請靜候通知 ✨\n\n— Din 🌱`,
        });
      } else {
        await lineClient.replyMessage(event.replyToken, {
          type: 'text',
          text: `歡迎加入 宇宙種子 CosmoSeed AI 🧬\n\n感謝你的加入！\n\n📅 下一場 AI 共學聚預計\n5/18（日）晚上 20:00（同一時間）\n\n詳細課程內容與報名表單會在這裡推播給你，\n請靜候通知 ✨\n\n期待下次見！— Din 🌱`,
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
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: `已為你完成綁定 ✅\n\n${reg.rows[0].name} 你好！\n下次活動我們會透過 LINE 通知你 🌱\n（下一場預計 5/18 同一時間）` });
        } else {
          // 外部報名者（如活動通）：line_bindings 已寫入，直接通知綁定成功，不要求重填站內表單
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: `已為你完成綁定 ✅\n\n下次活動我們會透過 LINE 通知你 🌱\n（下一場預計 5/18 同一時間）` });
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
  for (const r of rows) {
    const ch = r.source || '(未標記)';
    bySource[ch] = (bySource[ch] || 0) + 1;
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
  `);
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
  const result = await pool.query(`SELECT * FROM registrations WHERE attendance IN ('Yes','Maybe')`);
  // ⚠️ 下一場活動前(5/18 前)請主辦人更新此處的 Meet 連結與當晚 AI 工具準備事項
  const lineMsg = type === 'hour'
    ? `⏰ 還有 30 分鐘！\n\nAI 共學聚今晚 20:00 即將開始 🚀\n\nMeet 連結與上課準備事項，請查看前一則 LINE 通知 📌\n\n🔔 19:50 開放進入教室\n20:00 準時開始\n\n等等見！🧬`
    : `📅 明天提醒！\n\nAI 共學聚明天晚上 20:00–21:00\n期待明天和大家共學！🧬`;
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

// 5/4 已結束。下一場 5/18：前一天 5/17 20:00 day 提醒、當天 5/18 19:30 hour 提醒
// ⚠️ 5/18 活動前請先用 broadcast 發出 Meet 連結 + 當晚 AI 工具準備事項，
//    這兩個 cron 訊息只是 30 分鐘提醒，會引導用戶看「前一則 LINE 通知」找連結
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
