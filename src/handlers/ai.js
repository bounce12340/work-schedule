/**
 * AI 小幫手（DeepSeek）——第一階段：**唯讀**。
 *
 * 這一階段沒有任何寫入路徑：AI 看得到排程、答得出問題，但改不了任何一個字。
 * 因此可以放心在真實資料上試，順便回答一個測不到的問題——它到底看不看得懂
 * 這份排程。寫入留到第二階段，而且會走「AI 提案 → 使用者勾選 → 才寫入」。
 *
 * 為什麼一定要經過 Worker
 * ---------------------------------------------------------------------------
 * public/index.html 是任何人都下載得到的檔案。金鑰放進去等於公開它，別人可以
 * 拿去燒這個帳號的錢。所以金鑰只存在 Worker secret，前端呼叫 /api/ai/*，
 * 由這裡轉手。與 AGENTMAIL_API_KEY 完全相同的模式。
 *
 * 為什麼排程內容由前端送上來
 * ---------------------------------------------------------------------------
 * occurrence 引擎（循環展開、假日順延、單次覆寫）只存在前端單檔內，Worker 這邊
 * 沒有。在這裡重新實作一份，兩套必然分歧——而「AI 根據錯誤的日期回答」比沒有
 * AI 更糟，因為使用者會信任它。這與 ICS 與逾期提醒是同一個決定，理由也相同。
 */
import { json } from './auth.js';
import { uuid } from '../crypto.js';

const API_URL = 'https://api.deepseek.com/chat/completions';

/**
 * 一律用 flash。pro 貴三倍，而「這週有什麼」這種問題看不出差別——
 * 先量再調，與效能那一節同一個原則。等真的看得到品質差異再說。
 */
const MODEL = 'deepseek-v4-flash';

/** 限流：分鐘擋手滑連點，天擋「整天慢慢打」。與登入節流是同一種兩層形狀。 */
const LIMIT_PER_MIN = 5;
const LIMIT_PER_DAY = 50;

/** 保留幾天。同 share_activity——沒有保留上限的日誌表遲早會是最大的一張。 */
const KEEP_DAYS = 90;

const MAX_QUESTION = 500;
const MAX_ROWS = 400;        // 送進提示詞的排程列數上限
const MAX_ANSWER_CHARS = 4000;
const TIMEOUT_MS = 45_000;

export function aiConfigured(env) {
  return !!env.DEEPSEEK_API_KEY;
}

/**
 * 目前的用量。**同時是限流的依據**——「最近一分鐘打了幾次」直接數這張表就有，
 * 不必再開一張計數表。記錄本身就是計數器。
 */
async function usage(env, userId, nowMs) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) FILTER (WHERE created_at > ?) AS lastMin,
       COUNT(*) FILTER (WHERE created_at > ?) AS lastDay,
       COALESCE(SUM(prompt_tokens)     FILTER (WHERE created_at > ?), 0) AS promptTokens,
       COALESCE(SUM(completion_tokens) FILTER (WHERE created_at > ?), 0) AS completionTokens
     FROM ai_activity WHERE user_id = ?`
  ).bind(nowMs - 60_000, nowMs - 86_400_000, nowMs - 86_400_000, nowMs - 86_400_000, userId).first();
  return {
    lastMin: row?.lastMin ?? 0,
    lastDay: row?.lastDay ?? 0,
    promptTokens: row?.promptTokens ?? 0,
    completionTokens: row?.completionTokens ?? 0,
  };
}

/**
 * 佔一個位子。
 *
 * **在呼叫 DeepSeek 之前就寫**，拿到結果再回頭更新。順序反過來的話，寫入失敗
 * 等於沒有限流——而「記錄失敗只 console.warn」那條慣例在這裡會變成一個可以
 * 無限呼叫、無限花錢的洞。所以這一筆寫不進去就不呼叫，直接回錯誤。
 *
 * 也因此順手清掉過期記錄的動作放在這裡（同 share_activity 的作法）。
 */
async function reserve(env, userId, kind, nowMs) {
  const id = uuid();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ai_activity (id, user_id, kind, ok, detail, created_at) VALUES (?, ?, ?, 0, 'pending', ?)`
    ).bind(id, userId, kind, nowMs),
    env.DB.prepare('DELETE FROM ai_activity WHERE user_id = ? AND created_at < ?')
      .bind(userId, nowMs - KEEP_DAYS * 86_400_000),
  ]);
  return id;
}

/** 更新那一筆的結果。這裡失敗只 warn——事情已經做完了，不該讓它看起來像失敗。 */
async function settle(env, id, patch) {
  try {
    await env.DB.prepare(
      'UPDATE ai_activity SET ok = ?, detail = ?, prompt_tokens = ?, completion_tokens = ? WHERE id = ?'
    ).bind(
      patch.ok ? 1 : 0,
      String(patch.detail == null ? '' : patch.detail).slice(0, 500),
      patch.promptTokens ?? null,
      patch.completionTokens ?? null,
      id
    ).run();
  } catch (e) {
    console.warn('ai activity settle failed', String(e));
  }
}

/**
 * 把前端送上來的排程壓成提示詞用的緊湊格式。
 *
 * 外部輸入一律在自己這一側再驗一次：長度、型別、日期格式。前端是我們寫的，
 * 但送進來的東西不會因此就自動可信——瀏覽器上的任何東西都改得動。
 */
function compactRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ROWS)
    .filter(r => r && typeof r.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.d))
    .map(r => ({
      t: String(r.t == null ? '' : r.t).slice(0, 120),
      d: r.d,
      k: ['work', 'meeting', 'assignment'].includes(r.k) ? r.k : 'work',
      done: r.done ? 1 : 0,
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 8).map(x => String(x).slice(0, 24)) : [],
    }));
}

const TYPE_LABEL = { work: '工作項目', meeting: '會議安排', assignment: '作業' };

function buildPrompt(rows, todayYmd, range) {
  const lines = rows.map(r =>
    `${r.d} [${TYPE_LABEL[r.k]}]${r.done ? '（已完成）' : ''} ${r.t}` +
    (r.tags.length ? ` #${r.tags.join(' #')}` : '')
  );
  return [
    '你是一個工作排程系統的助理。以下是使用者的排程資料。',
    '',
    `今天是 ${todayYmd}。` + (range ? `以下資料涵蓋 ${range.start} 到 ${range.end}。` : ''),
    '',
    '規則：',
    '- 只根據下面的資料回答，資料裡沒有的就說不知道，不要猜測或編造項目。',
    '- 提到日期時一律用 YYYY-MM-DD，不要用「下週三」這種相對說法。',
    '- 用繁體中文回答，簡潔為主。',
    '- 你只能閱讀，沒有任何修改資料的能力；使用者要你改東西時，請告訴他目前只能查詢。',
    '',
    '排程資料：',
    ...(lines.length ? lines : ['（這個範圍沒有任何項目）']),
  ].join('\n');
}

/** 前端用來決定要不要顯示側邊欄，順便帶出用量給「我的帳號」顯示。 */
export async function handleAiStatus(env, user) {
  if (!aiConfigured(env)) return json({ configured: false });
  const u = await usage(env, user.id, Date.now());
  return json({
    configured: true,
    model: MODEL,
    limits: { perMin: LIMIT_PER_MIN, perDay: LIMIT_PER_DAY },
    usage: u,
  });
}

export async function handleAiAsk(request, env, user, nowMs = Date.now()) {
  if (!aiConfigured(env)) return json({ error: 'AI 尚未設定' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }

  const question = String(body?.question == null ? '' : body.question).trim().slice(0, MAX_QUESTION);
  if (!question) return json({ error: '請先輸入問題' }, 400);

  const today = /^\d{4}-\d{2}-\d{2}$/.test(body?.today) ? body.today
    : new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
  const rows = compactRows(body?.schedule);

  // 限流。被擋下來時要說得出還要等多久——「請稍後再試」等於沒說。
  const u = await usage(env, user.id, nowMs);
  if (u.lastMin >= LIMIT_PER_MIN) {
    return json({ error: `太快了，請等 1 分鐘再問（每分鐘上限 ${LIMIT_PER_MIN} 次）`, retryAfterSec: 60 }, 429);
  }
  if (u.lastDay >= LIMIT_PER_DAY) {
    return json({ error: `今天的 AI 用量已達上限（${LIMIT_PER_DAY} 次），明天會重置`, retryAfterSec: 3600 }, 429);
  }

  let recordId;
  try {
    recordId = await reserve(env, user.id, 'ask', nowMs);
  } catch (e) {
    // 佔不到位子就不呼叫：沒有記錄就沒有限流，那比少回答一次危險得多
    console.error('ai reserve failed', e?.stack || String(e));
    return json({ error: '暫時無法使用 AI，請稍後再試' }, 503);
  }

  const range = rows.length ? { start: rows[0].d, end: rows[rows.length - 1].d } : null;
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: buildPrompt(rows, today, range) },
          { role: 'user', content: question },
        ],
        temperature: 0.3,
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!r.ok) {
      // 訊息在 body 裡。只記狀態碼的話，「金鑰無效」與「餘額不足」看起來一模一樣
      const text = (await r.text()).slice(0, 300);
      throw new Error(`DeepSeek ${r.status}: ${text}`);
    }

    const data = await r.json();
    const answer = String(data?.choices?.[0]?.message?.content || '').slice(0, MAX_ANSWER_CHARS);
    if (!answer) throw new Error('DeepSeek 回應沒有內容');

    await settle(env, recordId, {
      ok: true,
      detail: question.slice(0, 200),
      promptTokens: data?.usage?.prompt_tokens ?? null,
      completionTokens: data?.usage?.completion_tokens ?? null,
    });

    return json({
      answer,
      usage: {
        promptTokens: data?.usage?.prompt_tokens ?? null,
        completionTokens: data?.usage?.completion_tokens ?? null,
      },
      rowsSent: rows.length,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    console.error('ai ask failed', msg);
    await settle(env, recordId, { ok: false, detail: msg });
    // 錯誤訊息**不回傳給前端原文**：它可能含有上游的內部細節。
    // 完整內容留在 ai_activity 與 console，管理者看得到。
    return json({ error: 'AI 回應失敗，請稍後再試' }, 502);
  }
}

/**
 * 給 /admin 看的全站 AI 用量。與 cron 狀態、備份清單同一個判斷：
 * 花錢的東西必須在有人會看的地方看得到。只回數量與 token，不回問題內容。
 */
export async function aiUsageSummary(env, nowMs = Date.now()) {
  const monthStart = nowMs - 30 * 86_400_000;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS calls,
            COUNT(*) FILTER (WHERE ok = 0) AS failed,
            COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
            COALESCE(SUM(completion_tokens), 0) AS completionTokens
       FROM ai_activity WHERE created_at > ?`
  ).bind(monthStart).first();
  return {
    since: monthStart,
    calls: row?.calls ?? 0,
    failed: row?.failed ?? 0,
    promptTokens: row?.promptTokens ?? 0,
    completionTokens: row?.completionTokens ?? 0,
  };
}
