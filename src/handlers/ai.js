/**
 * AI 小幫手（DeepSeek）。
 *
 * 兩個端點：
 *   - `/api/ai/ask`   問答與摘要（唯讀，一個字都不會改）
 *   - `/api/ai/plan`  **提案**：把「這段時間要做哪些事」拆成可勾選的清單
 *
 * **AI 永遠不直接寫入。** `/api/ai/plan` 只回一份提案；寫入發生在使用者
 * 在畫面上勾選並按下「加入」的那一刻，走既有的 `commit()`。
 *
 * 這個形狀比「AI 直接寫、寫錯了按復原」安全一個層級：復原是**事後補救**，
 * 勾選是**事前確認**。最壞的情況因此從「資料被改錯、等人發現」變成
 * 「畫面上多了一份沒被採納的清單」。
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
const MAX_PLAN_ITEMS = 30;   // 一次提案最多幾項
const MAX_SUBTASKS = 8;

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
function compactRows(raw, withIds = false) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ROWS)
    .filter(r => r && typeof r.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.d))
    .map(r => {
      const out = {
        t: String(r.t == null ? '' : r.t).slice(0, 120),
        d: r.d,
        k: ['work', 'meeting', 'assignment'].includes(r.k) ? r.k : 'work',
        done: r.done ? 1 : 0,
        tags: Array.isArray(r.tags) ? r.tags.slice(0, 8).map(x => String(x).slice(0, 24)) : [],
      };
      // 「標記完成」要指得到「哪一個項目的哪一次」，而 occurrence 從不被儲存——
      // AI 拼不出 occKey，只能從我們給它的清單裡挑。這是兩個功能之間的契約。
      if (withIds) { out.id = String(r.id || ''); out.occ = String(r.occ || ''); }
      return out;
    });
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

// ============================ 提案（可寫的那一半） ============================

/**
 * 提案的提示詞。
 *
 * 三件事一定要交代給模型，少一件產出就不可用：
 *   1. **今天是幾號**——沒有錨點，相對日期一定算錯
 *   2. **既有的標籤與大項目**——拆出來的東西要跟她原本的寫法一致，
 *      而不是模型自己的風格
 *   3. **既有排程的 id 與 occ**——「標記完成」只能從這份清單裡挑，
 *      不能自己編一個出來
 */
function buildPlanPrompt(rows, todayYmd, ctx) {
  const lines = rows.map(r =>
    `${r.d} [${TYPE_LABEL[r.k]}]${r.done ? '（已完成）' : ''} ${r.t}` +
    (r.tags.length ? ` #${r.tags.join(' #')}` : '') +
    ` <id=${r.id} occ=${r.occ}>`
  );
  return [
    '你是一個工作排程系統的助理。使用者會描述「某段時間要做哪些事」，',
    '你的工作是把它拆成可以直接排進系統的小項目。',
    '',
    `今天是 ${todayYmd}。`,
    '',
    '**只回傳 JSON**，格式如下（不要有其他文字）：',
    '{',
    '  "message": "一句話說明你怎麼拆的",',
    '  "create": [',
    '    { "title": "項目名稱", "type": "work|meeting|assignment",',
    '      "date": "YYYY-MM-DD", "tags": ["標籤"], "subtasks": ["步驟一","步驟二"] }',
    '  ],',
    '  "complete": [ { "id": "既有項目的 id", "occ": "那一次的 occ" } ]',
    '}',
    '',
    '規則：',
    '- 日期一律用絕對的 YYYY-MM-DD，不要用「下週三」這種相對說法。',
    '- type 只能是 work、meeting、assignment 三者之一。',
    '- 標籤盡量沿用下面「已在使用的標籤」，不要另創同義的新詞。',
    '- complete 只能填下面排程清單裡真的存在的 id 與 occ，不可以自己編。',
    '- 使用者沒有要求標記完成時，complete 就留空陣列。',
    '- 拆解要具體可執行，不要拆成「規劃」「執行」「檢討」這種空話。',
    `- 最多 ${MAX_PLAN_ITEMS} 項。`,
    '',
    ctx.tags.length ? '已在使用的標籤：' + ctx.tags.join('、') : '（目前還沒有任何標籤）',
    ctx.majors.length ? '已有的大項目：' + ctx.majors.join('、') : '',
    '',
    '目前的排程（供參考，避免重複；也是 complete 唯一可以挑選的來源）：',
    ...(lines.length ? lines : ['（這個範圍沒有任何項目）']),
  ].filter(Boolean).join('\n');
}

const isYmd = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * 驗證模型回來的提案。
 *
 * **日期不合法的那一項標記起來，而不是丟掉。** 丟掉的話使用者不會知道 AI 本來
 * 想排在哪天；標記則讓她看得到、也改得動。前端會把它預設成不勾。
 *
 * complete 只接受**真的出現在我們送出去那份清單裡**的 (id, occ)。模型編一個
 * 出來的話直接濾掉——這是伺服器端擋得住、也應該擋的一種錯誤。
 */
function validatePlan(raw, rows) {
  const known = new Set(rows.map(r => r.id + '|' + r.occ));
  const byKey = new Map(rows.map(r => [r.id + '|' + r.occ, r]));

  const create = (Array.isArray(raw?.create) ? raw.create : [])
    .slice(0, MAX_PLAN_ITEMS)
    .map(x => {
      const title = String(x?.title == null ? '' : x.title).trim().slice(0, 120);
      const date = isYmd(x?.date) ? x.date : null;
      return {
        title,
        type: ['work', 'meeting', 'assignment'].includes(x?.type) ? x.type : 'work',
        date,
        invalidDate: !date,
        rawDate: date ? null : String(x?.date == null ? '' : x.date).slice(0, 40),
        tags: Array.isArray(x?.tags)
          ? [...new Set(x.tags.map(t => String(t).trim().slice(0, 24)).filter(Boolean))].slice(0, 6)
          : [],
        subtasks: Array.isArray(x?.subtasks)
          ? x.subtasks.map(t => String(t).trim().slice(0, 120)).filter(Boolean).slice(0, MAX_SUBTASKS)
          : [],
      };
    })
    .filter(x => x.title);

  const complete = (Array.isArray(raw?.complete) ? raw.complete : [])
    .slice(0, MAX_PLAN_ITEMS)
    .map(x => ({ id: String(x?.id || ''), occ: String(x?.occ || '') }))
    .filter(x => known.has(x.id + '|' + x.occ))
    .map(x => {
      const r = byKey.get(x.id + '|' + x.occ);
      return { id: x.id, occ: x.occ, title: r.t, date: r.d, alreadyDone: !!r.done };
    });

  return {
    message: String(raw?.message == null ? '' : raw.message).slice(0, 400),
    create,
    complete,
  };
}

export async function handleAiPlan(request, env, user, nowMs = Date.now()) {
  if (!aiConfigured(env)) return json({ error: 'AI 尚未設定' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }

  const ask = String(body?.request == null ? '' : body.request).trim().slice(0, MAX_QUESTION);
  if (!ask) return json({ error: '請先描述要做什麼' }, 400);

  const today = isYmd(body?.today) ? body.today
    : new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
  const rows = compactRows(body?.schedule, true);
  const ctx = {
    tags: Array.isArray(body?.tags) ? body.tags.slice(0, 40).map(t => String(t).slice(0, 24)) : [],
    majors: Array.isArray(body?.majors) ? body.majors.slice(0, 20).map(t => String(t).slice(0, 60)) : [],
  };

  const u = await usage(env, user.id, nowMs);
  if (u.lastMin >= LIMIT_PER_MIN) {
    return json({ error: `太快了，請等 1 分鐘再試（每分鐘上限 ${LIMIT_PER_MIN} 次）`, retryAfterSec: 60 }, 429);
  }
  if (u.lastDay >= LIMIT_PER_DAY) {
    return json({ error: `今天的 AI 用量已達上限（${LIMIT_PER_DAY} 次），明天會重置`, retryAfterSec: 3600 }, 429);
  }

  let recordId;
  try {
    recordId = await reserve(env, user.id, 'plan', nowMs);
  } catch (e) {
    console.error('ai reserve failed', e?.stack || String(e));
    return json({ error: '暫時無法使用 AI，請稍後再試' }, 503);
  }

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
          { role: 'system', content: buildPlanPrompt(rows, today, ctx) },
          { role: 'user', content: ask },
        ],
        // 用結構化輸出，不要叫模型「回 JSON」然後自己 parse 一段可能壞掉的文字。
        // 即便如此下面仍然要驗——外部輸入永遠要在自己這一側再驗一次。
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 2400,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${(await r.text()).slice(0, 300)}`);

    const data = await r.json();
    const text = String(data?.choices?.[0]?.message?.content || '');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('模型回的不是合法 JSON'); }

    const plan = validatePlan(parsed, rows);
    if (!plan.create.length && !plan.complete.length) {
      // 空提案不是錯誤，但要說得出來——回一份空清單讓前端顯示訊息
      await settle(env, recordId, { ok: true, detail: ask.slice(0, 200) + '（無提案）',
        promptTokens: data?.usage?.prompt_tokens ?? null,
        completionTokens: data?.usage?.completion_tokens ?? null });
      return json({ ...plan, empty: true });
    }

    await settle(env, recordId, {
      ok: true,
      detail: `${ask.slice(0, 150)} → 提案 ${plan.create.length} 新增 / ${plan.complete.length} 完成`,
      promptTokens: data?.usage?.prompt_tokens ?? null,
      completionTokens: data?.usage?.completion_tokens ?? null,
    });
    return json(plan);
  } catch (e) {
    const msg = String(e?.message || e);
    console.error('ai plan failed', msg);
    await settle(env, recordId, { ok: false, detail: msg });
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
