/**
 * 專案的公開分享頁（第三批 3B）：`/p/<token>` 要由 Worker 直接供應 p.html，**不要求登入**。
 *
 * 這一頁的讀者定義上就是沒有帳號的人。要是它掉進 servePage，沒登入的人會被 302 到登入頁——
 * 畫面上看起來像「連結壞了」，而擁有者那一側一切正常、沒有任何東西會紅。所以直接打 Worker 的 fetch 入口。
 * 也守 wrangler.jsonc 的 run_worker_first：沒列 /p/*，靜態資產層會先回 404，Worker 根本沒機會處理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { makeEnv } from './d1.mjs';

const ctx = { waitUntil() {} };
const TOKEN = 'T'.repeat(32);

function envWithAssets() {
  const env = makeEnv();
  const seen = [];
  env.ASSETS = { async fetch(request) { seen.push(new URL(request.url).pathname); return new Response('<html>p page</html>', { status: 200, headers: { 'content-type': 'text/html' } }); } };
  env.seen = seen;
  return env;
}

test('/p/<token>：沒登入也回 p.html（不是 302 到登入頁），而且不讓搜尋引擎收', async () => {
  const env = envWithAssets();
  const res = await worker.fetch(new Request('https://app.test/p/' + TOKEN), env, ctx);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /p page/);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('/p/<token>：token 一個字都不帶進資產請求（網址本身就是憑證）', async () => {
  const env = envWithAssets();
  await worker.fetch(new Request('https://app.test/p/' + TOKEN), env, ctx);
  assert.deepEqual(env.seen, ['/p']);
});

test('/p/<token>：格式不對的 token 也回這一頁（頁面會說「連結失效」），只收 GET', async () => {
  const env = envWithAssets();
  assert.equal((await worker.fetch(new Request('https://app.test/p/abc'), env, ctx)).status, 200);
  assert.equal((await worker.fetch(new Request('https://app.test/p/' + TOKEN, { method: 'POST' }), env, ctx)).status, 405);
});

test('wrangler.jsonc 的 run_worker_first 有 /p/*（沒列的話靜態資產層先回 404）', () => {
  const cfg = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(cfg, /"run_worker_first":\s*\[[^\]]*"\/p\/\*"/);
});
