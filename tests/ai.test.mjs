/**
 * AI 小幫手（第一階段：唯讀）。
 *
 * **絕對不打真的 DeepSeek API。** 要錢、回應每次都不一樣、CI 也沒有金鑰。
 * 這裡注入一個假的 fetch，驗的是**我們這一側的行為**——提示詞帶了什麼、
 * 上游壞掉時我們怎麼處理、限流擋不擋得住、金鑰會不會漏出去。
 *
 * 三條最重要的：
 *
 *   1. **金鑰不能出現在任何回傳給前端的東西裡。** 這是明確的絆線，同備份那個
 *      測試——一旦有人「順手」把上游的錯誤原文回傳出去，它要當場紅。
 *   2. **佔不到記錄的位子就不能呼叫。** ai_activity 同時是花費記錄與限流依據，
 *      寫不進去卻照樣呼叫，等於開一個可以無限花錢的洞。
 *   3. **失敗也要留下記錄。** 只記成功的話，「金鑰失效」看起來會跟「沒人用」
 *      一模一樣——與 cron_runs 是同一個道理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAiStatus, handleAiAsk, handleAiPlan, aiUsageSummary } from '../src/handlers/ai.js';
import { makeEnv, addUser, unwrap } from './d1.mjs';

const KEY = 'sk-super-secret-do-not-leak';
const T0 = Date.parse('2026-09-08T02:00:00Z');
const USER = { id: 'u1', email: 'a@x.test', role: 'user', status: 'approved' };

function aiEnv(extra = {}) {
  const env = makeEnv();
  addUser(env, 'u1', 'a@x.test');
  return { ...env, DEEPSEEK_API_KEY: KEY, ...extra };
}

function ask(body) {
  return new Request('https://app.test/api/ai/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

/**
 * 換掉 globalThis.fetch，記下送出去的東西並回傳指定的回應。
 *
 * `reply` 必須是**工廠函式**，每次呼叫都要造一個新的 Response——Response 的
 * body 只能讀一次，重複回傳同一個實例的話，第二次之後會解析失敗而變成 502。
 * 第一版就是這樣寫的，結果「每分鐘上限」那個測試是因為錯誤的理由才通過的：
 * 後面四次其實全部失敗，而它剛好只檢查記錄筆數。**測試工具本身也要驗。**
 */
async function withFakeApi(makeReply, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts, body: JSON.parse(opts.body) });
    return makeReply(calls.length);
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

const okReply = () => () => new Response(JSON.stringify({
  choices: [{ message: { content: '這週有兩件事還沒完成。' } }],
  usage: { prompt_tokens: 900, completion_tokens: 40 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const SCHEDULE = [
  { t: '管制藥品申報', d: '2026-09-08', k: 'assignment', done: 0, tags: ['管制藥品'] },
  { t: '客服部月會', d: '2026-09-10', k: 'meeting', done: 1, tags: [] },
];

const rows = env => env.DB.prepare('SELECT * FROM ai_activity').all().results;

// ---------------------------------------------------------------- 設定

test('沒設金鑰時回 configured:false，前端據此完全不顯示入口', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.test');
  const res = await unwrap(await handleAiStatus(env, USER));
  assert.equal(res.body.configured, false);
});

test('沒設金鑰時 ask 直接回 503，不會去打任何東西', async () => {
  const env = makeEnv(); addUser(env, 'u1', 'a@x.test');
  await withFakeApi(okReply(), async calls => {
    const res = await unwrap(await handleAiAsk(ask({ question: 'x' }), env, USER, T0));
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------- 提示詞

test('提示詞帶上今天的日期與排程內容', async () => {
  const env = aiEnv();
  await withFakeApi(okReply(), async calls => {
    await handleAiAsk(ask({ question: '這週有什麼？', today: '2026-09-08', schedule: SCHEDULE }), env, USER, T0);
    const sys = calls[0].body.messages.find(m => m.role === 'system').content;
    assert.match(sys, /2026-09-08/, '沒有錨點的話，模型換算相對日期會差一天');
    assert.match(sys, /管制藥品申報/);
    assert.match(sys, /已完成/, '完成狀態要帶進去，否則答不出「還沒做的」');
    assert.equal(calls[0].body.messages.find(m => m.role === 'user').content, '這週有什麼？');
  });
});

test('沒帶 today 時用台北時間補上，不是留空', async () => {
  const env = aiEnv();
  await withFakeApi(okReply(), async calls => {
    await handleAiAsk(ask({ question: 'x', schedule: SCHEDULE }), env, USER, T0);
    assert.match(calls[0].body.messages[0].content, /2026-09-08/);
  });
});

test('不合法的日期會被濾掉，不會混進提示詞', async () => {
  const env = aiEnv();
  await withFakeApi(okReply(), async calls => {
    await handleAiAsk(ask({
      question: 'x',
      schedule: [{ t: '壞掉的', d: '明天', k: 'work' }, ...SCHEDULE],
    }), env, USER, T0);
    assert.ok(!calls[0].body.messages[0].content.includes('壞掉的'));
  });
});

test('打到正確的端點與模型', async () => {
  const env = aiEnv();
  await withFakeApi(okReply(), async calls => {
    await handleAiAsk(ask({ question: 'x', schedule: SCHEDULE }), env, USER, T0);
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(calls[0].body.model, 'deepseek-v4-flash');
    assert.equal(calls[0].opts.headers.authorization, 'Bearer ' + KEY);
  });
});

// ---------------------------------------------------------------- 金鑰不能漏

test('金鑰不會出現在任何回傳給前端的東西裡', async () => {
  const env = aiEnv();
  // 上游把金鑰原封不動回吐（真的發生過的錯誤回應形狀）
  const leaky = () => new Response(`{"error":"invalid key ${KEY}"}`, { status: 401 });
  await withFakeApi(leaky, async () => {
    const res = await unwrap(await handleAiAsk(ask({ question: 'x', schedule: SCHEDULE }), env, USER, T0));
    assert.equal(res.status, 502);
    assert.ok(!JSON.stringify(res.body).includes(KEY),
      '上游的錯誤原文絕不能整段轉發出去——那是最容易漏金鑰的一條路');
  });
  const st = await unwrap(await handleAiStatus(env, USER));
  assert.ok(!JSON.stringify(st.body).includes(KEY));
});

// ---------------------------------------------------------------- 記錄

test('成功會記下 token 數——花費看不見就會失控', async () => {
  const env = aiEnv();
  await withFakeApi(okReply(), async () => {
    await handleAiAsk(ask({ question: '這週有什麼？', schedule: SCHEDULE }), env, USER, T0);
  });
  const r = rows(env);
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, 1);
  assert.equal(r[0].prompt_tokens, 900);
  assert.equal(r[0].completion_tokens, 40);
});

test('失敗也要留記錄，而且留的是原因', async () => {
  const env = aiEnv();
  await withFakeApi(() => new Response('insufficient balance', { status: 402 }), async () => {
    await handleAiAsk(ask({ question: 'x', schedule: SCHEDULE }), env, USER, T0);
  });
  const r = rows(env);
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, 0);
  assert.match(r[0].detail, /402/, '只記「失敗了」的話，餘額不足與金鑰無效看起來一樣');
});

test('回應沒有內容也算失敗，不是回一段空白給使用者', async () => {
  const env = aiEnv();
  const empty = () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 });
  await withFakeApi(empty, async () => {
    const res = await unwrap(await handleAiAsk(ask({ question: 'x', schedule: SCHEDULE }), env, USER, T0));
    assert.equal(res.status, 502);
  });
  assert.equal(rows(env)[0].ok, 0);
});

test('記錄佔不到位子就不呼叫——沒有記錄就沒有限流', async () => {
  const env = aiEnv();
  env.DB.batch = async () => { throw new Error('D1 掛了'); };
  await withFakeApi(okReply(), async calls => {
    const res = await unwrap(await handleAiAsk(ask({ question: 'x', schedule: SCHEDULE }), env, USER, T0));
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0, '寫不進記錄卻照樣呼叫，等於開一個可以無限花錢的洞');
  });
});

// ---------------------------------------------------------------- 限流

test('每分鐘上限擋得住，而且說得出還要等多久', async () => {
  const env = aiEnv();
  await withFakeApi(okReply(), async () => {
    for (let i = 0; i < 5; i++) {
      await handleAiAsk(ask({ question: 'q' + i, schedule: SCHEDULE }), env, USER, T0 + i);
    }
    const res = await unwrap(await handleAiAsk(ask({ question: '第六次', schedule: SCHEDULE }), env, USER, T0 + 6));
    assert.equal(res.status, 429);
    assert.ok(res.body.retryAfterSec > 0, '「請稍後再試」等於沒說');
  });
  assert.equal(rows(env).length, 5, '被擋下來的那一次不該留下記錄');
});

test('過了一分鐘就恢復——是滑動窗口，不是鎖定', async () => {
  const env = aiEnv();
  await withFakeApi(okReply(), async () => {
    for (let i = 0; i < 5; i++) {
      await handleAiAsk(ask({ question: 'q' + i, schedule: SCHEDULE }), env, USER, T0 + i);
    }
    const later = await unwrap(await handleAiAsk(
      ask({ question: '一分鐘後', schedule: SCHEDULE }), env, USER, T0 + 61_000));
    assert.equal(later.status, 200);
  });
});

test('每天的上限也擋得住', async () => {
  const env = aiEnv();
  // 直接塞 50 筆當天的記錄，不必真的跑 50 次
  for (let i = 0; i < 50; i++) {
    env.DB.prepare('INSERT INTO ai_activity (id,user_id,kind,ok,created_at) VALUES (?,?,?,1,?)')
      .bind('x' + i, 'u1', 'ask', T0 - 3_600_000).run();
  }
  await withFakeApi(okReply(), async calls => {
    const res = await unwrap(await handleAiAsk(ask({ question: 'x', schedule: SCHEDULE }), env, USER, T0));
    assert.equal(res.status, 429);
    assert.equal(calls.length, 0);
  });
});

test('限流只看自己的用量，不會被別人的次數牽連', async () => {
  const env = aiEnv();
  addUser(env, 'u2', 'b@x.test');
  for (let i = 0; i < 50; i++) {
    env.DB.prepare('INSERT INTO ai_activity (id,user_id,kind,ok,created_at) VALUES (?,?,?,1,?)')
      .bind('y' + i, 'u2', 'ask', T0 - 1000).run();
  }
  await withFakeApi(okReply(), async () => {
    const res = await unwrap(await handleAiAsk(ask({ question: 'x', schedule: SCHEDULE }), env, USER, T0));
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------- 輸入驗證

test('空問題直接退回，不浪費一次呼叫', async () => {
  const env = aiEnv();
  await withFakeApi(okReply(), async calls => {
    const res = await unwrap(await handleAiAsk(ask({ question: '   ', schedule: SCHEDULE }), env, USER, T0));
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });
});

test('壞掉的 body 不會讓 handler 拋例外', async () => {
  const env = aiEnv();
  const bad = new Request('https://app.test/api/ai/ask', { method: 'POST', body: 'not json' });
  const res = await unwrap(await handleAiAsk(bad, env, USER, T0));
  assert.equal(res.status, 400);
});

test('超長的問題會被截斷，不是原封不動送出去', async () => {
  const env = aiEnv();
  await withFakeApi(okReply(), async calls => {
    await handleAiAsk(ask({ question: 'あ'.repeat(5000), schedule: SCHEDULE }), env, USER, T0);
    assert.ok(calls[0].body.messages[1].content.length <= 500);
  });
});

// ---------------------------------------------------------------- 管理頁用量

test('全站用量只回數量與 token，不回問題內容', async () => {
  const env = aiEnv();
  await withFakeApi(okReply(), async () => {
    await handleAiAsk(ask({ question: '極機密的問題內容', schedule: SCHEDULE }), env, USER, T0);
  });
  const sum = await aiUsageSummary(env, T0 + 1000);
  assert.equal(sum.calls, 1);
  assert.equal(sum.promptTokens, 900);
  assert.ok(!JSON.stringify(sum).includes('極機密'));
});

// ============================ 提案（可寫的那一半） ============================
//
// 這一組守的是「AI 提案 → 使用者勾選 → 才寫入」裡**伺服器該擋的那一半**。
// 前端的勾選是最後一道，但有些錯誤在這裡就擋得住，而擋得住的就不該讓它過去。

const planReq = body => new Request('https://app.test/api/ai/plan', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const WITH_IDS = [
  { t: '管制藥品申報', d: '2026-09-08', k: 'assignment', done: 0, tags: ['管制藥品'], id: 'i1', occ: '2026-09' },
  { t: '客服部月會', d: '2026-09-10', k: 'meeting', done: 0, tags: [], id: 'i2', occ: 'single' },
];

const planReply = obj => () => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(obj) } }],
  usage: { prompt_tokens: 1200, completion_tokens: 300 },
}), { status: 200 });

test('提案：拆出來的項目帶回標題、日期、類型、標籤與步驟', async () => {
  const env = aiEnv();
  await withFakeApi(planReply({
    message: '拆成三步',
    create: [{ title: '確認特賣品項', type: 'work', date: '2026-10-03',
               tags: ['特賣'], subtasks: ['跟採購確認庫存', '產出價格表'] }],
    complete: [],
  }), async () => {
    const res = await unwrap(await handleAiPlan(
      planReq({ request: '10 月要做中秋特賣', schedule: WITH_IDS }), env, USER, T0));
    assert.equal(res.status, 200);
    assert.equal(res.body.create.length, 1);
    assert.equal(res.body.create[0].date, '2026-10-03');
    assert.deepEqual(res.body.create[0].subtasks, ['跟採購確認庫存', '產出價格表']);
    assert.equal(res.body.create[0].invalidDate, false);
  });
});

test('提案用結構化輸出，不是叫模型「回 JSON」再自己 parse', async () => {
  const env = aiEnv();
  await withFakeApi(planReply({ create: [], complete: [] }), async calls => {
    await handleAiPlan(planReq({ request: 'x', schedule: WITH_IDS }), env, USER, T0);
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  });
});

test('提示詞帶上既有標籤與大項目，拆出來的東西才會跟她原本的寫法一致', async () => {
  const env = aiEnv();
  await withFakeApi(planReply({ create: [], complete: [] }), async calls => {
    await handleAiPlan(planReq({
      request: 'x', schedule: WITH_IDS, tags: ['管制藥品', 'PVF'], majors: ['年度策略'],
    }), env, USER, T0);
    const sys = calls[0].body.messages[0].content;
    assert.match(sys, /管制藥品、PVF/);
    assert.match(sys, /年度策略/);
    assert.match(sys, /id=i1 occ=2026-09/, 'complete 只能從這份清單挑，所以 id 要給它');
  });
});

test('**AI 編一個不存在的項目 id 出來，伺服器就要濾掉**', async () => {
  const env = aiEnv();
  await withFakeApi(planReply({
    create: [],
    complete: [
      { id: 'i1', occ: '2026-09' },        // 真的存在
      { id: '我編的', occ: 'single' },      // 不存在
      { id: 'i1', occ: '2099-01' },         // id 對但那一次不存在
    ],
  }), async () => {
    const res = await unwrap(await handleAiPlan(
      planReq({ request: 'x', schedule: WITH_IDS }), env, USER, T0));
    assert.equal(res.body.complete.length, 1, '只有真的在清單裡的那一筆能留下');
    assert.equal(res.body.complete[0].id, 'i1');
    assert.equal(res.body.complete[0].title, '管制藥品申報', '標題由我們補，不採用模型說的');
  });
});

test('日期不合法的項目要留下來並標記，不是丟掉', async () => {
  const env = aiEnv();
  await withFakeApi(planReply({
    create: [{ title: '這一項日期壞掉', type: 'work', date: '下週三' }],
    complete: [],
  }), async () => {
    const res = await unwrap(await handleAiPlan(
      planReq({ request: 'x', schedule: WITH_IDS }), env, USER, T0));
    assert.equal(res.body.create.length, 1, '丟掉的話使用者不會知道 AI 想排在哪天');
    assert.equal(res.body.create[0].invalidDate, true);
    assert.equal(res.body.create[0].date, null);
    assert.equal(res.body.create[0].rawDate, '下週三', '原本說什麼要留著給人看');
  });
});

test('沒有標題的項目直接濾掉——那不是一件事', async () => {
  const env = aiEnv();
  await withFakeApi(planReply({
    create: [{ title: '   ', type: 'work', date: '2026-10-01' },
             { title: '正常的', type: 'work', date: '2026-10-02' }],
    complete: [],
  }), async () => {
    const res = await unwrap(await handleAiPlan(planReq({ request: 'x', schedule: WITH_IDS }), env, USER, T0));
    assert.equal(res.body.create.length, 1);
    assert.equal(res.body.create[0].title, '正常的');
  });
});

test('不認得的 type 退回 work，不是原封不動塞進去', async () => {
  const env = aiEnv();
  await withFakeApi(planReply({
    create: [{ title: 'x', type: '<script>', date: '2026-10-01' }], complete: [],
  }), async () => {
    const res = await unwrap(await handleAiPlan(planReq({ request: 'x', schedule: WITH_IDS }), env, USER, T0));
    assert.equal(res.body.create[0].type, 'work');
  });
});

test('模型回的不是 JSON 時，回錯誤而不是把壞東西丟給前端', async () => {
  const env = aiEnv();
  const junk = () => new Response(JSON.stringify({
    choices: [{ message: { content: '我覺得你應該先做 A 再做 B' } }],
  }), { status: 200 });
  await withFakeApi(junk, async () => {
    const res = await unwrap(await handleAiPlan(planReq({ request: 'x', schedule: WITH_IDS }), env, USER, T0));
    assert.equal(res.status, 502);
  });
  assert.equal(rows(env)[0].ok, 0);
  assert.match(rows(env)[0].detail, /JSON/);
});

test('空提案不是錯誤，但要說得出來', async () => {
  const env = aiEnv();
  await withFakeApi(planReply({ message: '沒有可以拆的', create: [], complete: [] }), async () => {
    const res = await unwrap(await handleAiPlan(planReq({ request: 'x', schedule: WITH_IDS }), env, USER, T0));
    assert.equal(res.status, 200);
    assert.equal(res.body.empty, true);
    assert.equal(res.body.message, '沒有可以拆的');
  });
  assert.equal(rows(env)[0].ok, 1, '空提案仍然花了錢，要記');
});

test('提案也吃同一份限流額度', async () => {
  const env = aiEnv();
  await withFakeApi(planReply({ create: [], complete: [] }), async () => {
    for (let i = 0; i < 5; i++) {
      await handleAiPlan(planReq({ request: 'q' + i, schedule: WITH_IDS }), env, USER, T0 + i);
    }
    const res = await unwrap(await handleAiPlan(planReq({ request: 'x', schedule: WITH_IDS }), env, USER, T0 + 6));
    assert.equal(res.status, 429);
  });
});

test('提案的回應裡不會有金鑰', async () => {
  const env = aiEnv();
  await withFakeApi(() => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }), async () => {
    const res = await unwrap(await handleAiPlan(planReq({ request: 'x', schedule: WITH_IDS }), env, USER, T0));
    assert.ok(!JSON.stringify(res.body).includes(KEY));
  });
});
