/**
 * iOS app 的跨來源請求（CORS）。
 *
 * app 跑在 capacitor://localhost，打線上的 /api/* 是跨網域：WKWebView 會先送 OPTIONS
 * 預檢，回應少了 Access-Control-Allow-Origin 就整個被丟掉，前端只看到「連線失敗」。
 * TestFlight 第一次打開就是這樣，登入與註冊都進不去，而 Worker 什麼錯都沒有。
 *
 * tools/smoke.mjs 抓不到這件事——它用 page.route 在瀏覽器送出前攔下那些請求，
 * 預檢根本不會發生——所以這裡直接打 Worker 的 fetch 入口驗標頭。
 *
 * 三條不能改的判斷：
 *   1. 只放行 app 的來源；別的來源、沒有 Origin 的（網頁版同源）一律不加標頭。
 *   2. 錯誤回應（4xx／5xx）也要帶標頭，否則 app 看到的永遠是「連線失敗」而不是真正的錯誤。
 *   3. 絕不開 Allow-Credentials：app 走 Bearer，不該讓任何跨來源請求帶得動網頁版的 cookie。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv } from './d1.mjs';

const APP = 'capacitor://localhost';
const ctx = { waitUntil() {} };

function req(path, { method = 'GET', origin, headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.origin = origin;
  return new Request('https://app.test' + path, { method, headers: h });
}

test('CORS：app 來源的預檢回 204，帶完整的允許清單', async () => {
  const res = await worker.fetch(req('/api/auth/app/code', {
    method: 'OPTIONS', origin: APP,
    headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization, x-app-client' }
  }), makeEnv(), ctx);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), APP);
  const methods = res.headers.get('access-control-allow-methods');
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) assert.ok(methods.includes(m), m);
  const allowed = res.headers.get('access-control-allow-headers').toLowerCase();
  for (const hName of ['content-type', 'authorization', 'x-app-client']) assert.ok(allowed.includes(hName), hName);
  assert.ok(res.headers.get('vary').includes('Origin'));
});

test('CORS：app 來源的正常回應帶 Allow-Origin 與 Vary', async () => {
  const res = await worker.fetch(req('/api/health', { origin: APP }), makeEnv(), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), APP);
  assert.ok(res.headers.get('vary').includes('Origin'));
  assert.deepEqual(await res.json(), { ok: true });
});

test('CORS：401 也要帶標頭——少了它，app 看到的是「連線失敗」而不是「尚未登入」', async () => {
  const res = await worker.fetch(req('/api/state', { origin: APP }), makeEnv(), ctx);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('access-control-allow-origin'), APP);
});

test('CORS：Worker 丟例外的 500 也要帶標頭', async () => {
  const env = makeEnv();
  env.DB = { prepare() { throw new Error('boom'); } };
  const res = await worker.fetch(req('/api/state', {
    origin: APP, headers: { authorization: 'Bearer ' + 'a'.repeat(32) }
  }), env, ctx);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('access-control-allow-origin'), APP);
  assert.equal((await res.json()).error, '伺服器發生錯誤，請稍後再試');
});

test('CORS：別的來源什麼都拿不到，預檢也不放行', async () => {
  const evil = 'https://evil.example';
  const res = await worker.fetch(req('/api/health', { origin: evil }), makeEnv(), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);

  const pre = await worker.fetch(req('/api/auth/app/code', {
    method: 'OPTIONS', origin: evil, headers: { 'access-control-request-method': 'POST' }
  }), makeEnv(), ctx);
  assert.notEqual(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
});

test('CORS：沒有 Origin（網頁版同源）的請求完全不受影響', async () => {
  const res = await worker.fetch(req('/api/health'), makeEnv(), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('vary'), null);
});

test('CORS：永遠不開 Allow-Credentials', async () => {
  for (const r of [
    req('/api/health', { origin: APP }),
    req('/api/auth/app/code', { method: 'OPTIONS', origin: APP, headers: { 'access-control-request-method': 'POST' } })
  ]) {
    const res = await worker.fetch(r, makeEnv(), ctx);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  }
});

test('CORS：/api/ 以外的路徑不加標頭（靜態頁與 ics 不是 app 打的）', async () => {
  const res = await worker.fetch(req('/ics/' + 'b'.repeat(32), { origin: APP }), makeEnv(), ctx);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});
