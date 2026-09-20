import { json } from './auth.js';
import { sendMail } from '../mail.js';
import { generateToken } from '../crypto.js';

/**
 * 逾期提醒。
 *
 * 設計與行事曆訂閱（ICS）同一個模式：**內容由前端產生、同步時推上來**，
 * 這裡只負責「比對日期 → 寄信」。
 *
 * 不在 Worker 展開循環規則，理由與 ICS 相同：occurrence 引擎（含假日順延、
 * 單次覆寫、略過）只存在前端單檔內。在這裡重新實作一份，兩套必然分歧——
 * 而**提醒寄錯日期比沒有提醒更糟**，因為使用者會信任它。
 *
 * 前端推上來的是「已展開的排程」而不是「已經算好的逾期清單」：逾期與否隨日期
 * 改變，今天不逾期的項目後天就逾期了。存展開後的日期讓 cron 每天自己比對，
 * 使用者一段時間沒開 app 也不影響正確性。
 */

const MAX_DIGEST_BYTES = 200_000;
// 一次信裡最多列這麼多筆，其餘用「還有 N 項」帶過——把兩百行倒進信裡沒有人會讀
const MAX_LISTED = 20;

// 統計裡最多留幾筆錯誤訊息。同一個原因失敗一百次，看前幾筆就夠了；
// 全部留下來只會把 cron_runs.detail 撐爆而更難讀
const MAX_ERRORS = 5;

/** 預設提前 3 天。0 代表只在逾期時寄（原本的行為），上限 30 天。 */
export const DEFAULT_LEAD_DAYS = 3;
const MAX_LEAD_DAYS = 30;

/**
 * 休假那幾天閉嘴（C-3）。
 *
 * 前端推上來「有休假的日子」，**只列 leave 不列 away**——「不在」的人仍在上班，
 * 照寄照推；「休假」才是正式請假。判斷在前端，同 `ot`、`streak_current`、ICS 與
 * 逾期提醒本身：日期語意（跨多天以結束日算、時段、同一天兩種並存）只存在
 * `public/index.html` 裡，在這裡重寫一份必然分歧。
 *
 * 一天最多留這麼多筆。digest 的窗口是「回看一年、前瞻三個月」，一年半的每一天
 * 都請假也塞不滿——這個上限防的是有人把它當第二個儲存空間用。
 */
const MAX_LEAVE_DAYS = 800;

/** 回 null 代表「沒有指定」，呼叫端據此決定要不要沿用舊值（同 normalizeLeadDays） */
function normalizeLeaveDays(v) {
  if (!Array.isArray(v)) return null;
  const seen = new Set();
  for (const d of v) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    seen.add(d);
    if (seen.size >= MAX_LEAVE_DAYS) break;
  }
  // 排序只是為了讓存進去的內容穩定（同一份資料每次序列化都一樣），
  // 判斷本身用的是集合，與順序無關
  return JSON.stringify([...seen].sort());
}

/**
 * 今天是不是「休假日」。純函式，方便直接測。
 *
 * **壞掉的 JSON 一律當成「沒有休假」**：解析失敗時讓提醒照常寄，比讓它從此靜靜
 * 地不寄安全得多——沒有人會發現「信不見了」，而多收一封信看得見。
 */
export function isOnLeave(leaveDaysJson, ymd) {
  if (!leaveDaysJson) return false;
  let list;
  try { list = JSON.parse(leaveDaysJson); } catch { return false; }
  return Array.isArray(list) && list.includes(ymd);
}

/** 回 null 代表「沒有指定」，呼叫端據此決定要不要沿用舊值 */
function normalizeLeadDays(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_LEAD_DAYS, Math.max(0, n));
}

/** 台北時間的今天（UTC+8，台灣自 1980 年起無夏令時間，固定偏移即可） */
export function taipeiYmd(nowMs) {
  const d = new Date(nowMs + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

/**
 * 從展開後的排程挑出逾期未完成的項目。純函式，方便直接測。
 * 逾期＝日期早於今天且尚未完成。今天到期的**不算**逾期——那是「今天要做」，
 * 混在一起會讓真正遲交的東西被淹沒。
 */
export function pickOverdue(digest, todayYmd) {
  if (!Array.isArray(digest)) return [];
  return digest
    .filter(r => r && !r.done && typeof r.d === 'string' && r.d < todayYmd)
    .sort((a, b) => a.d.localeCompare(b.d));
}

/**
 * 即將到期：今天（含）之後、leadDays 天之內尚未完成的項目。
 *
 * **包含今天**——與逾期的分界剛好互補：pickOverdue 取 `d < today`，這裡取
 * `today <= d <= 截止`，兩者不重疊也不漏接。今天到期的東西放在「即將」這一段
 * 是對的，它還沒遲到，但確實是今天要做的。
 *
 * leadDays 為 0 代表使用者只想在逾期時被通知，直接回空陣列。
 */
export function pickUpcoming(digest, todayYmd, leadDays) {
  if (!Array.isArray(digest) || !(leadDays > 0)) return [];
  const until = addDays(todayYmd, leadDays);
  return digest
    .filter(r => r && !r.done && typeof r.d === 'string' && r.d >= todayYmd && r.d <= until)
    .sort((a, b) => a.d.localeCompare(b.d));
}

/** YYYY-MM-DD 加上 n 天。用 UTC 的 Date 算，不碰時區——輸入輸出都只是日期字串。 */
export function addDays(ymd, n) {
  const t = Date.parse(ymd + 'T00:00:00Z');
  return new Date(t + n * 86400_000).toISOString().slice(0, 10);
}

export async function handleReminderStatus(env, user) {
  const row = await env.DB
    .prepare(`SELECT enabled, last_sent_ymd, lead_days, streak_mail,
                     push_overdue, push_streak, push_today, updated_at
                FROM reminder_feed WHERE user_id = ?`)
    .bind(user.id).first();
  return json({
    enabled: !!(row && row.enabled),
    // 還沒有那一列的人回預設值（開啟），不是 false——否則畫面會先顯示「關著」，
    // 等他第一次同步建立那一列之後才莫名其妙變成開著
    streakMail: row ? !!row.streak_mail : true,
    // 推播的三個開關（子專案 B）。同上，沒有那一列時回 schema 的預設值。
    // 「今天有事要做」預設關：它每天固定時間會響，那種東西預設開是打擾。
    pushOverdue: row ? !!row.push_overdue : true,
    pushStreak: row ? !!row.push_streak : true,
    pushToday: row ? !!row.push_today : false,
    leadDays: row ? row.lead_days : DEFAULT_LEAD_DAYS,
    lastSent: row ? row.last_sent_ymd : null,
    updatedAt: row ? row.updated_at : null,
    email: user.email
  });
}

export async function handleReminderEnable(request, env, user) {
  let body = {};
  try { body = await request.json(); } catch { /* 沒有 body 就當成開啟 */ }
  const enabled = body && body.enabled === false ? 0 : 1;
  // 沒有帶 leadDays 就沿用現有值——這支端點也用於單純開關提醒，
  // 不該因為前端少送一個欄位就把使用者設好的提前天數重設掉
  const lead = normalizeLeadDays(body?.leadDays);
  // 連續斷掉的信是**另一個開關**，沒帶就沿用現有值（同 leadDays）。前端每次都把
  // 三個值一起送，所以這裡不必分辨「要改哪一個」。
  const streakMail = body?.streakMail === undefined ? null : (body.streakMail ? 1 : 0);
  // 推播的三個開關（子專案 B）。**與上面兩個 email 開關互不相干**——沒帶就沿用現有值，
  // 理由同 leadDays：這支端點也用於單純開關別的東西，不該順手把沒提到的設定重設掉。
  const flag = v => (v === undefined ? null : (v ? 1 : 0));
  const pOver = flag(body?.pushOverdue), pStreak = flag(body?.pushStreak), pToday = flag(body?.pushToday);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO reminder_feed (user_id, enabled, digest, lead_days, streak_mail,
                                push_overdue, push_streak, push_today, updated_at)
     VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled,
       lead_days = COALESCE(?, reminder_feed.lead_days),
       streak_mail = COALESCE(?, reminder_feed.streak_mail),
       push_overdue = COALESCE(?, reminder_feed.push_overdue),
       push_streak = COALESCE(?, reminder_feed.push_streak),
       push_today = COALESCE(?, reminder_feed.push_today),
       updated_at = excluded.updated_at`
  ).bind(user.id, enabled, lead ?? DEFAULT_LEAD_DAYS, streakMail ?? 1,
    pOver ?? 1, pStreak ?? 1, pToday ?? 0, now,
    lead, streakMail, pOver, pStreak, pToday).run();
  return json({ ok: true, enabled: !!enabled, streakMail: streakMail === null ? undefined : !!streakMail });
}

/** 前端每次同步後推上來的展開排程 */
export async function handleReminderPut(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }
  if (!Array.isArray(body?.digest)) return json({ error: '缺少 digest 陣列' }, 400);

  // 只留需要的欄位，長度也設上限：這份資料只用來排程寄信，不該變成第二個
  // 可以塞任意內容的儲存空間
  const digest = body.digest.slice(0, 2000).map(r => ({
    t: String(r?.t == null ? '' : r.t).slice(0, 200),
    d: String(r?.d == null ? '' : r.d).slice(0, 10),
    k: ['work', 'meeting', 'assignment'].includes(r?.k) ? r.k : 'work',
    done: r?.done ? 1 : 0,
    // 「按時完成」由**前端的遊戲化引擎判斷**後推上來（布林），不是推 doneAt 讓
    // 這裡自己比對。理由同「不在 Worker 展開循環規則」：那個判斷有一堆細節
    // （到期日、跨多天以結束日算、當天 23:59:59 的界線），兩套實作必然分歧，
    // 而分歧的症狀是「畫面說連續 12 天、信說斷了」——比沒有這封信更糟。
    ot: r?.ot ? 1 : 0
  })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d));

  // 連續天數同理：前端算好推上來。它是「最後一次同步當下」的值，而信裡印的就是
  // 它——閘門與內容用同一個數字，不會出現「擋住了卻印另一個數」。
  const streak = Number.isFinite(body?.streak?.current)
    ? Math.max(0, Math.min(9999, Math.round(body.streak.current))) : null;

  // 休假的日子同理：前端算好推上來（C-3）。沒帶就沿用現有值——舊版前端還沒開始
  // 推這個欄位，不該因為它少送一個東西就把使用者的休假清單清空。
  const leaveDays = normalizeLeaveDays(body?.leaveDays);

  const serialized = JSON.stringify(digest);
  if (serialized.length > MAX_DIGEST_BYTES) return json({ error: 'Digest too large' }, 413);

  const now = Date.now();
  // 兩件事要分清楚：
  //
  //   - **已經存在的列不動 enabled**（DO UPDATE 只改 digest）。推送是同步的副作用，
  //     絕不能把使用者親手關掉的提醒又打開——那是他明確表達過的選擇。
  //   - **新建的列採用預設值（開啟）**。這裡沒有任何「使用者的選擇」可以尊重，
  //     他還沒表達過意見；預設開啟的理由見 schema.sql 的註解。
  //
  // 先前這裡寫死 enabled = 0，等於讓 schema 的預設值永遠用不到——「預設開啟」
  // 只改 schema 是不夠的，因為實際建立這一列的就是這句 SQL。
  await env.DB.prepare(
    `INSERT INTO reminder_feed (user_id, digest, streak_current, leave_days, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       digest = excluded.digest,
       streak_current = COALESCE(?, reminder_feed.streak_current),
       leave_days = COALESCE(?, reminder_feed.leave_days),
       updated_at = excluded.updated_at`
  ).bind(user.id, serialized, streak ?? 0, leaveDays ?? '[]', now, streak, leaveDays).run();
  return json({ ok: true, count: digest.length });
}

/**
 * 退訂：信裡那個連結按下去會關掉哪一個開關。
 *
 * **這是一張白名單，不是一個參數。** 收到的 `kind` 只用來查表，查不到就退回——
 * 永遠不把使用者送來的字串拼進 SQL 的欄位名裡。
 *
 * 兩種信**各自對應自己的開關，不互相連坐**：畫面上就是兩顆按鈕（同 schema.sql
 * 裡那句「關掉其中一個不該連帶關掉另一個」）。而那正是這整件事的重點——
 * helen 按下 Gmail 的「取消訂閱」時，她要的只是「這種信別再來」，拿到的卻是
 * 「你再也收不到任何東西」。我們自己的連結不可以犯同一個錯。
 */
export const UNSUB_KINDS = { reminder: 'enabled', streak: 'streak_mail' };

/**
 * 拿到這個人的退訂 token，沒有就現場產一個。
 *
 * **第一次要寄信時才產**，不在 migration 裡回填：回填要對每一列寫一次，而這個
 * 欄位只有「真的要寄信給他」時才用得到。既有的列就這樣留著 NULL 也不會壞。
 *
 * 併發時以**資料庫裡的那一個**為準，不是我剛才產的那一個：`WHERE unsub_token
 * IS NULL` 讓兩條路徑只有一條寫得進去，輸的那條要是回傳自己產的值，就會把一個
 * 從來不存在於資料庫裡的 token 寄出去——使用者點了之後 UPDATE 改到 0 列，
 * 畫面上是「連結已失效」，而他什麼都沒做錯。
 */
export async function ensureUnsubToken(env, userId, existing) {
  if (existing) return existing;
  const token = generateToken();
  await env.DB.prepare(
    'UPDATE reminder_feed SET unsub_token = ? WHERE user_id = ? AND unsub_token IS NULL'
  ).bind(token, userId).run();
  const row = await env.DB
    .prepare('SELECT unsub_token FROM reminder_feed WHERE user_id = ?')
    .bind(userId).first();
  return (row && row.unsub_token) || token;
}

/**
 * 信裡那一行連結的網址。
 *
 * **沒有 APP_URL 或沒有 token 就回空字串**，呼叫端據此整行不放——半個連結
 * （`/unsub?t=` 後面空空的）比沒有連結更糟：點下去只會看到「這個連結不完整」，
 * 而使用者會以為是系統壞了，然後回頭去按 Gmail 那顆。
 */
/**
 * `List-Unsubscribe` 要打的網址（RFC 8058 的一鍵退訂）。
 *
 * **這是整件事的治本層。** 有了這個標頭，Gmail／Apple Mail 上那顆「取消訂閱」
 * 會用 POST 打到**我們**的端點，而不是去跟寄信商說「這個人的信我不要了」——
 * 而後者正是 helen 2026-09-09 按下去之後發生的事：寄信商把她加進帳號層級的
 * 退訂名單，連她自己索取的密碼重設信一起擋掉。
 *
 * 信裡那個看得見的連結（`unsubUrl`）指的是**給人看的確認頁**；這一個是**給
 * 郵件軟體用的**，直接生效、沒有頁面。兩者要分開：一鍵退訂的規格要求那個網址
 * 收到 POST 就當場處理，不能先回一頁要人再按一次。
 */
export function unsubOneClickUrl(appUrl, token, kind) {
  const base = String(appUrl || '').replace(/\/+$/, '');
  if (!base || !token || !UNSUB_KINDS[kind]) return '';
  return `${base}/api/unsub/one-click?t=${encodeURIComponent(token)}&k=${encodeURIComponent(kind)}`;
}

/**
 * 訂閱信要帶的標頭。**只有訂閱信帶**——交易信（密碼重設、驗證碼）不該有
 * 退訂這個概念，帶了反而會讓郵件軟體把它當成廣告。
 *
 * 兩個標頭要成對出現：少了 `List-Unsubscribe-Post`，收信端會退回舊行為
 * （把網址當成「開給人點的連結」而不是「可以直接 POST 的端點」），於是
 * 掃描器的 GET 又變成風險，而一鍵退訂也不會生效。
 */
export function unsubHeaders(appUrl, token, kind) {
  const url = unsubOneClickUrl(appUrl, token, kind);
  if (!url) return undefined;
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export function unsubUrl(appUrl, token, kind) {
  const base = String(appUrl || '').replace(/\/+$/, '');
  if (!base || !token || !UNSUB_KINDS[kind]) return '';
  return `${base}/unsub?t=${encodeURIComponent(token)}&k=${encodeURIComponent(kind)}`;
}

/**
 * POST /api/unsub —— **公開端點**，憑證是連結裡的 token 本身。
 *
 * 會走到這裡的人定義上就是「不想再收信」的人，要求他先登入等於把他推回
 * Gmail 那顆按鈕——而那顆按鈕的代價是連密碼重設信都收不到。同〈忘記密碼〉
 * 那支不加 Turnstile 的理由：這條路是使用者已經不想（或不能）進系統時才走的，
 * 多一道關卡只是多一個會壞的東西。token 是 256 位元的隨機值，猜不到。
 *
 * **只關不開。** 這個 token 打不開任何東西——要再打開一律回系統裡按。
 * 少了這一條，撿到連結的人就能把別人的提醒**打開**，那是騷擾。
 *
 * **改到 0 列要回錯誤，不能回 ok。** 同〈破窗鎚〉的「改到 0 列當成錯誤」：
 * 回 ok 等於告訴他「關好了」而其實什麼都沒發生，下個月信照來——那是這份
 * 程式碼最討厭的那種假綠燈，而且會讓他確信「這個連結沒用」再去按 Gmail 的。
 */
export async function handleUnsubscribe(request, env) {
  let body = {};
  try { body = await request.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }
  const out = await applyUnsubscribe(env, String(body?.token || ''), String(body?.kind || ''));
  return out.ok ? json({ ok: true, kind: out.kind }) : json({ error: out.error }, out.status);
}

/**
 * 真正寫入的那一支。**兩個入口（我們的頁面、郵件軟體的一鍵退訂）共用它。**
 *
 * 複製第二份的症狀是「從信箱軟體退訂沒有用、從我們的頁面退訂有用」——
 * 兩邊都各自「看起來正常」，而沒有人會發現。同〈TX_KINDS 只寫一份〉。
 */
export async function applyUnsubscribe(env, token, kind) {
  const col = UNSUB_KINDS[kind];
  if (!col || token.length < 20) return { ok: false, status: 400, error: '這個連結不完整' };

  // 單句帶條件的 UPDATE，理由同〈樂觀鎖必須是單句 SQL〉：先 SELECT 再 UPDATE
  // 的空窗沒有必要存在。欄位名來自白名單，不是拼接使用者的輸入。
  const res = await env.DB.prepare(
    `UPDATE reminder_feed SET ${col} = 0, updated_at = ? WHERE unsub_token = ?`
  ).bind(Date.now(), token).run();
  if (!res.meta.changes) {
    return { ok: false, status: 404,
      error: '這個連結已經失效了。要調整通知，請登入後到「我的帳號」。' };
  }
  return { ok: true, status: 200, kind };
}

/**
 * POST /api/unsub/one-click?t=…&k=… —— 郵件軟體那顆「取消訂閱」打進來的地方。
 *
 * 與 `/api/unsub` 的差別只有介面：參數在查詢字串（標頭裡放得下的只有網址）、
 * body 是 `List-Unsubscribe=One-Click` 的表單而不是 JSON。**寫入邏輯共用同一支**，
 * 不複製一份——複製的那一份遲早會與這一支分歧，而分歧的症狀是「從信箱軟體退訂
 * 沒有用，從我們的頁面退訂有用」，沒有人會發現。
 *
 * **只認 POST。** GET 一律不生效（路由那裡就擋掉）：掃描器與預抓會發 GET，
 * 讓它生效等於「信一進收件匣，提醒自己關掉了」。RFC 8058 用 POST 正是為了這件事。
 *
 * **回 200 純文字，不回頁面。** 對面是機器，不是人。
 */
export async function handleUnsubscribeOneClick(url, env) {
  const token = String(url.searchParams.get('t') || '');
  const kind = String(url.searchParams.get('k') || '');
  const out = await applyUnsubscribe(env, token, kind);
  return new Response(out.ok ? 'unsubscribed\n' : out.error + '\n',
    { status: out.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

const TYPE_LABEL = { work: '工作項目', meeting: '會議安排', assignment: '作業' };

const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 兩個日期字串相差幾天。只算日期，不牽涉時區。 */
function dayDiff(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / 86400000);
}

/**
 * 信件內容。逾期與即將到期分成兩段，**逾期永遠排在前面**。
 *
 * 分段而不是混成一張表，是因為兩者要的行動不同：逾期是「已經遲了，現在就處理」，
 * 即將到期是「先看一眼，安排時間」。混在一起會讓真正遲交的東西被淹沒——那正是
 * 原本「今天到期的不算逾期」想避免的事，這裡沿用同一個判斷。
 */
export function buildReminderEmail(overdue, upcoming, todayYmd, appUrl, unsub = '') {
  const parts = [];
  const htmlParts = [];

  if (overdue.length) {
    const shown = overdue.slice(0, MAX_LISTED);
    const rest = overdue.length - shown.length;
    parts.push(
      `【已逾期】${overdue.length} 項`, '',
      ...shown.map(r => `・${r.d}（逾期 ${dayDiff(r.d, todayYmd)} 天）  ${r.t}`),
      ...(rest > 0 ? [`・…還有 ${rest} 項`] : []), ''
    );
    htmlParts.push(section('已逾期', '#C0392B', shown, rest,
      r => `逾期 ${dayDiff(r.d, todayYmd)} 天`));
  }

  if (upcoming.length) {
    const shown = upcoming.slice(0, MAX_LISTED);
    const rest = upcoming.length - shown.length;
    parts.push(
      `【即將到期】${upcoming.length} 項`, '',
      ...shown.map(r => `・${r.d}（${whenLabel(dayDiff(todayYmd, r.d))}）  ${r.t}`),
      ...(rest > 0 ? [`・…還有 ${rest} 項`] : []), ''
    );
    htmlParts.push(section('即將到期', '#C9822E', shown, rest,
      r => whenLabel(dayDiff(todayYmd, r.d))));
  }

  const text = [
    ...parts,
    appUrl ? `開啟系統：${appUrl}` : '',
    '', '— 工作排程確認系統',
    // 退訂連結。**純文字版也要有**——有些人就是在純文字模式下讀信，而「只有
    // HTML 版看得到出口」等於對那些人來說沒有出口。
    //
    // 兩條路都給：一鍵停掉這一種，或回系統裡自己管全部。**兩個都要寫得清楚**，
    // 藏起來的出口與沒有出口是同一件事（helen 就是因此去按 Gmail 那顆的）。
    ...(unsub ? [
      '',
      '─────────────',
      `不想再收這種提醒信？點這裡直接停掉：`,
      unsub,
      ...(appUrl ? [`想自己管全部的通知（信與推播）：${appUrl}/#notify`] : [])
    ] : [])
  ].join('\n');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#2A2A26">
${htmlParts.join('')}
${appUrl ? `<p style="margin:18px 0 0"><a href="${esc(appUrl)}" style="color:#C9822E">開啟工作排程確認系統 →</a></p>` : ''}
<p style="margin:22px 0 0;color:#A2A099;font-size:12px">沒有逾期、也沒有即將到期的項目時，這封信不會寄出。</p>
${unsub ? unsubBlock(unsub, appUrl, '不想再收這種提醒信') : ''}
</div>`;

  return { subject: buildSubject(overdue.length, upcoming.length), text, html };
}

/**
 * 信最下面那一塊退訂。**兩封信共用同一份**，因為它要長得一樣——
 * 使用者記住的是「那個灰底的框」，不是某一封信的排版。
 *
 * **按鈕要夠明顯，這是刻意改過的決定。** 第一版是 12px 的灰色文字連結，藏在
 * 最下面一行——那是在「不要鼓勵退訂」與「要讓人找得到出口」之間選錯了邊。
 * 找不到出口的代價不是少一個訂閱者，是**那個人去按信箱軟體的「取消訂閱」，
 * 然後整個帳號被寄信商封鎖，連密碼重設信都收不到**（helen 2026-09-09）。
 * 多幾個人退訂遠比那個便宜。
 *
 * 兩條路都給，而且分工不同：
 *   - **停掉這一種**（不用登入）——只想少收一種信的人，一下就完成
 *   - **管全部的通知**（回系統）——想自己調的人，那裡有五個開關
 */
function unsubBlock(unsub, appUrl, label) {
  return `<div style="margin:26px 0 0;padding:16px;border-radius:10px;background:#F1EEE5;border:1px solid #E4E0D3">
<p style="margin:0 0 12px;font-size:13px;color:#2A2A26">${esc(label)}？</p>
<a href="${esc(unsub)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#2A2A26;color:#FFFDF9;font-size:14px;font-weight:700;text-decoration:none">取消訂閱</a>
${appUrl ? `<p style="margin:12px 0 0;font-size:12px;color:#71706A">或到系統裡管理全部的通知：<a href="${esc(appUrl)}/#notify" style="color:#C9822E">通知設定 →</a></p>` : ''}
</div>`;
}

/** 「今天到期」「明天到期」比「0 天後」「1 天後」好讀太多 */
function whenLabel(days) {
  if (days <= 0) return '今天到期';
  if (days === 1) return '明天到期';
  return `${days} 天後到期`;
}

/**
 * 主旨要一眼看得出嚴重程度。有逾期就讓逾期當主角——收件匣裡通常只看得到主旨，
 * 把「3 個已逾期」藏在「5 個提醒」後面等於把最重要的資訊丟掉。
 */
function buildSubject(overdueN, upcomingN) {
  if (overdueN && upcomingN) return `【工作排程】${overdueN} 個已逾期、${upcomingN} 個即將到期`;
  if (overdueN) return `【逾期提醒】${overdueN} 個項目已過期`;
  return `【即將到期】${upcomingN} 個項目即將到期`;
}

function section(title, color, rows, rest, whenText) {
  return `<p style="margin:0 0 10px"><b style="color:${color}">${title}</b> · ${rows.length + rest} 項</p>
<table style="border-collapse:collapse;width:100%;max-width:560px;margin:0 0 22px">
${rows.map(r => `<tr>
<td style="padding:6px 10px 6px 0;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px;color:${color};vertical-align:top">${esc(r.d)}</td>
<td style="padding:6px 10px 6px 0;white-space:nowrap;font-size:12px;color:#71706A;vertical-align:top">${esc(whenText(r))}</td>
<td style="padding:6px 0;vertical-align:top">${esc(r.t)}<span style="color:#A2A099;font-size:12px"> · ${esc(TYPE_LABEL[r.k] || '')}</span></td>
</tr>`).join('')}
${rest > 0 ? `<tr><td colspan="3" style="padding:8px 0;color:#A2A099;font-size:12.5px">…還有 ${rest} 項</td></tr>` : ''}
</table>`;
}

/**
 * Cron 進入點：掃出「已開啟提醒、今天還沒寄過、且真的有東西要說」的使用者並寄信。
 *
 * **沒有逾期、也沒有即將到期就完全不寄。** 每天一封「你今天沒事」的信只會訓練
 * 收件者忽略這個寄件人，真的有事時反而看不到。加了事前提醒之後這條更重要，
 * 不是更不重要——會觸發寄信的條件變寬了，那個「沒事就閉嘴」的閘門就更要守住。
 *
 * 提前幾天由每個人自己的 lead_days 決定，0 代表只在逾期時通知（原本的行為）。
 */
export async function sendOverdueReminders(env, nowMs = Date.now()) {
  const today = taipeiYmd(nowMs);
  const rows = await env.DB.prepare(
    `SELECT r.user_id, r.digest, r.last_sent_ymd, r.lead_days, r.leave_days,
            r.unsub_token, u.email, u.status
       FROM reminder_feed r JOIN users u ON u.id = r.user_id
      WHERE r.enabled = 1`
  ).all();

  // 跳過的三種原因**分開計數**。原本它們共用一個 skipped，於是「今天大家都沒事」
  // 與「這個帳號被停用了」在統計裡完全一樣——而這份統計現在會進 cron_runs 給人看，
  // 分不出原因的數字等於沒有記。這與 cloudPull() 要區分 absent 與 failed 是同一件事。
  const out = { checked: 0, sent: 0, nothingToSay: 0, alreadySent: 0, notApproved: 0, onLeave: 0, failed: 0, errors: [] };
  for (const row of rows.results || []) {
    out.checked++;
    // 停用中的帳號不該繼續收到信
    if (row.status !== 'approved') { out.notApproved++; continue; }
    // 同一天不重寄：cron 可能重試，重試不該變成第二封
    if (row.last_sent_ymd === today) { out.alreadySent++; continue; }
    // 今天請假就整封不寄（C-3）。**整天跳過，不是把那幾項挑掉**——挑掉會寄出一封
    // 說「你有 3 件事」但實際漏講 2 件的信，那比不寄更糟，因為收件人會以為那就是
    // 全部。也**刻意不寫 last_sent_ymd**：沒寄就不算寄過，休假結束的第一天要能補。
    if (isOnLeave(row.leave_days, today)) { out.onLeave++; continue; }

    let digest = [];
    try { digest = JSON.parse(row.digest); } catch { digest = []; }
    const overdue = pickOverdue(digest, today);
    const upcoming = pickUpcoming(digest, today,
      row.lead_days == null ? DEFAULT_LEAD_DAYS : row.lead_days);
    if (!overdue.length && !upcoming.length) { out.nothingToSay++; continue; }

    try {
      // **確定要寄了才產 token**：放在這一行之前的每一個 continue（沒事、
      // 已經寄過、休假、停用）都代表這次不寄信，那就沒有理由為他寫一次資料庫。
      const token = await ensureUnsubToken(env, row.user_id, row.unsub_token);
      const mail = buildReminderEmail(overdue, upcoming, today, env.APP_URL || '',
        unsubUrl(env.APP_URL || '', token, 'reminder'));
      // List-Unsubscribe：讓郵件軟體那顆「取消訂閱」打到我們，而不是去跟
      // 寄信商告狀（那會讓整個帳號被封鎖，連密碼重設信都收不到）
      mail.headers = unsubHeaders(env.APP_URL || '', token, 'reminder');
      await sendMail(env, row.email, mail, 'reminder');
      await env.DB.prepare('UPDATE reminder_feed SET last_sent_ymd = ? WHERE user_id = ?')
        .bind(today, row.user_id).run();
      out.sent++;
    } catch (e) {
      // 一個人寄失敗不該讓整批停下來。也刻意不記 last_sent_ymd：
      // 沒寄成功就不算寄過，下一次排程會再試。
      console.warn('reminder send failed', row.user_id, String(e));
      out.failed++;
      // **錯誤訊息要留下來。** 只有 failed 的數字的話，「金鑰失效」與「inbox 不存在」
      // 看起來一模一樣，而它們要做的事完全不同。收件人用 email 而不是 user_id：
      // 這份統計是給管理者在管理頁上讀的，而管理者本來就看得到所有人的 email。
      if (out.errors.length < MAX_ERRORS) {
        out.errors.push({ email: row.email, error: String(e?.message || e).slice(0, 200) });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ 連續斷掉的信（F2）
//
// 設計文件 docs/superpowers/specs/2026-09-16-gamification-design.md〈斷掉之後的情勒信〉。
//
// 這封信不是系統在講話，是**那棵櫻花樹**在講話——它有立場撒嬌（火焰是它的、花是
// 它的），系統沒有。使用者的裁決是「會撒嬌的口氣」。
//
// 畫面上的角色換成櫻花樹之後這封信必須跟著改口，否則症狀是「畫面上是櫻花樹，信卻
// 是別的植物寫的」——不會壞、不會報錯，只會讓人覺得哪裡怪怪的。
//
// 與逾期提醒共用同一條 cron 與同一張表，但**開關各自獨立**：關掉逾期提醒不代表
// 不想聽櫻花樹說話，反過來也一樣。

/** 連續要有這麼多天才值得為它寄一封信 */
const MIN_STREAK_FOR_MAIL = 2;
/** 信裡最多點名幾件；其餘用「還有 N 件」帶過 */
const MAX_NAMED = 3;

/**
 * 那一天的狀況。純函式，方便直接測。
 *
 * `ot`（按時完成）是前端的遊戲化引擎判斷後推上來的，這裡只數——**刻意不自己
 * 比對時間戳**：那個判斷的細節（跨多天以結束日算、當天 23:59:59 的界線）在
 * 前端有測試守著，在這裡重寫一份必然分歧。
 *
 * broken 的定義只看一天，不往回走：那天**有安排**、而且**不是每一件都按時完成**。
 * 「連續走了幾天」不在這裡算，它由前端推上來（見 streak_current）。
 */
export function dayReport(digest, ymd) {
  const rows = Array.isArray(digest)
    ? digest.filter(r => r && typeof r.d === 'string' && r.d === ymd) : [];
  const missed = rows.filter(r => !r.ot);
  return { scheduled: rows.length, missed, broken: rows.length > 0 && missed.length > 0 };
}

/** 「〈A〉和〈B〉」／「〈A〉、〈B〉、〈C〉，還有 2 件」——點名要像人在講話，不是條列 */
function namePhrase(rows) {
  const shown = rows.slice(0, MAX_NAMED).map(r => `〈${r.t}〉`);
  const rest = rows.length - shown.length;
  if (rest > 0) return `${shown.join('、')}，還有 ${rest} 件`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join('、')}和${shown[shown.length - 1]}`;
}

/**
 * 撒嬌信。三條規則（設計文件〈語氣〉）：
 *
 *   - **講事實**（幾天、哪幾件），**不評價**。沒有「你放棄了」「你又……」——
 *     撒嬌的力量來自「它在等你」，不是來自羞辱。
 *   - **第一人稱是那棵樹**，署名也是。畫面上它垂下枝子，信裡它說想你，是同一件事。
 *   - 不寫「加油」（那是提醒信的語氣）、不寫「沒關係」（那會把這封信的用途取消掉）。
 *
 * 罵人的信會被封鎖寄件人，然後逾期提醒也一起收不到；撒嬌的信不會。
 */
export function buildStreakEmail(days, missed, appUrl, unsub = '') {
  const names = namePhrase(missed);
  const text = [
    `我們一起走了 ${days} 天耶。`,
    '',
    '昨天你沒有把事情做完，我的火焰熄掉了，枝子也垂下來一點點。',
    '我不生氣啦，只是有點想你。',
    '',
    `今天可以回來嗎？把${names}做完，我就會再開花。`,
    '',
    appUrl ? `${appUrl}` : '',
    '',
    '——你的櫻花樹',
    // 這一行與逾期提醒信的那一行**各自帶不同的 kind**：關掉櫻花樹不會連帶
    // 關掉逾期提醒，反過來也一樣。
    ...(unsub ? [
      '',
      '─────────────',
      '不想再收櫻花樹的信？點這裡直接停掉：',
      unsub,
      ...(appUrl ? [`想自己管全部的通知（信與推播）：${appUrl}/#notify`] : [])
    ] : [])
  ].join('\n');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.9;color:#2A2A26;max-width:520px">
<p style="margin:0 0 4px;font-size:26px">🌸</p>
<p style="margin:0 0 14px">我們一起走了 <b style="color:#C9822E">${days}</b> 天耶。</p>
<p style="margin:0 0 14px">昨天你沒有把事情做完，我的火焰熄掉了，枝子也垂下來一點點。<br>我不生氣啦，只是有點想你。</p>
<p style="margin:0 0 18px">今天可以回來嗎？把 ${missed.slice(0, MAX_NAMED).map(r => `<b>${esc(r.t)}</b>`).join('、')}${
    missed.length > MAX_NAMED ? `，還有 ${missed.length - MAX_NAMED} 件` : ''} 做完，我就會再開花。</p>
${appUrl ? `<p style="margin:0 0 22px"><a href="${esc(appUrl)}" style="color:#C9822E">回來看看我 →</a></p>` : ''}
<p style="margin:0;color:#71706A">——你的櫻花樹</p>
<p style="margin:22px 0 0;color:#A2A099;font-size:12px">連續中斷的那一天才會收到這封信，一天最多一封。</p>
${unsub ? unsubBlock(unsub, appUrl, '不想再收櫻花樹的信') : ''}
</div>`;

  return { subject: '欸……昨天你沒有來', text, html };
}

/**
 * Cron 進入點：昨天把連續弄斷的人，由櫻花樹寄一封信。
 *
 * 幾個不能拿掉的判斷：
 *
 * - **連續少於 2 天不寄。** 每天一封「你昨天又沒做完」只會訓練收件者忽略這個
 *   寄件人——「沒事就閉嘴」那條在這裡比在逾期提醒更重要，因為會觸發的條件更寬。
 * - **同一天只寄一次**（`streak_mail_ymd`）；寄失敗刻意不寫那個欄位，下次排程補。
 * - **以最後一次同步為準。** 昨天 23:50 勾完但沒同步的人，今天早上會收到一封
 *   冤枉的信。與逾期提醒的取捨相同，可接受。
 * - 反過來，今天一早自己打開 app 同步過的人，推上來的連續已經歸零，就不會收到
 *   這封信——他已經回來了，櫻花樹不必再叫他。
 */
export async function sendStreakBroken(env, nowMs = Date.now()) {
  const today = taipeiYmd(nowMs);
  const yesterday = addDays(today, -1);
  const rows = await env.DB.prepare(
    `SELECT r.user_id, r.digest, r.streak_current, r.streak_mail_ymd, r.leave_days,
            r.unsub_token, u.email, u.status
       FROM reminder_feed r JOIN users u ON u.id = r.user_id
      WHERE r.streak_mail = 1`
  ).all();

  // 跳過的原因分開計數，理由同 sendOverdueReminders：分不出原因的數字等於沒有記
  const out = { checked: 0, sent: 0, notBroken: 0, tooShort: 0, alreadySent: 0, notApproved: 0, onLeave: 0, failed: 0, errors: [] };
  for (const row of rows.results || []) {
    out.checked++;
    if (row.status !== 'approved') { out.notApproved++; continue; }
    if (row.streak_mail_ymd === today) { out.alreadySent++; continue; }
    // 問的是「**今天**在不在休假」而不是昨天：這封信是今天寄出去打擾人的那一封。
    // 昨天請假、今天上班的人照樣會收到——他的連續確實斷了，而櫻花樹講的是事實。
    if (isOnLeave(row.leave_days, today)) { out.onLeave++; continue; }

    let digest = [];
    try { digest = JSON.parse(row.digest); } catch { digest = []; }
    const day = dayReport(digest, yesterday);
    if (!day.broken) { out.notBroken++; continue; }

    const days = Number(row.streak_current) || 0;
    if (days < MIN_STREAK_FOR_MAIL) { out.tooShort++; continue; }

    try {
      const token = await ensureUnsubToken(env, row.user_id, row.unsub_token);
      const mail = buildStreakEmail(days, day.missed, env.APP_URL || '',
        unsubUrl(env.APP_URL || '', token, 'streak'));
      mail.headers = unsubHeaders(env.APP_URL || '', token, 'streak');
      await sendMail(env, row.email, mail, 'streak');
      await env.DB.prepare('UPDATE reminder_feed SET streak_mail_ymd = ? WHERE user_id = ?')
        .bind(today, row.user_id).run();
      out.sent++;
    } catch (e) {
      console.warn('streak mail failed', row.user_id, String(e));
      out.failed++;
      if (out.errors.length < MAX_ERRORS) {
        out.errors.push({ email: row.email, error: String(e?.message || e).slice(0, 200) });
      }
    }
  }
  return out;
}
