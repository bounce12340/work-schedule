/**
 * GitHub 那一側（設計文件「乙 1」「乙 2」）：
 *   - GET /api/projects/:pid/prs      擁有者看專案連到的 PR（cookie session；讀不要求 Pro）
 *   - GET/POST/DELETE /api/github/hooks  擁有者建立／重新產生／移除 webhook（POST 只在這一刻回傳網址與密鑰）
 *   - POST /api/github/hook/:token    **公開端點**，GitHub 直接打進來
 *
 * 我們**不存 GitHub 的 token、不主動去問 GitHub**：資料都是對方送過來的（agent 回報，或這個 webhook）。
 *
 * webhook 的三道關，順序不能換：
 *   1. 網址裡的 token（只存雜湊）查不到 → 404。不讀 body、不驗簽，也不透露「這個使用者存不存在」
 *   2. X-Hub-Signature-256 的 HMAC（用 body 的**原文**算，恆定時間比對）不對 → 401
 *   3. 只更新這個使用者**已經連過**的那幾列 PR（repo＋編號對得上）；沒連過的一律 200 忽略——
 *      否則任何拿到網址的人都能往別人的專案塞東西。webhook 不會「新增」PR：新增要有專案可以掛，
 *      那是 agent 或使用者的決定
 * 驗 HMAC 必須有密鑰的原文，所以 github_hooks.secret 存明碼（同 reminder_feed.unsub_token 的取捨）：
 * 外洩時拿到它的人只能改「已經連過的 PR」的狀態，而且還得同時知道網址裡的 token。
 * 標題、作者是外部內容（公開 repo 誰都能開 PR）：去換行、截 200 字。
 */
import { json } from './auth.js';
import { generateToken, sha256, timingSafeEqual } from '../crypto.js';
import { readState } from '../mcp/store.js';
import { cleanOneLine, ownerPrView, prEventBodies, writePrEvents, listPrsOfProject } from '../mcp/prs.js';

const MAX_BODY_BYTES = 1_000_000;
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256(secret, body 原文) 的十六進位字串。 */
export async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
}

// ------------------------------------------------------------ 擁有者那一側

/** GET /api/projects/:pid/prs：專案已經不在 state 裡就不顯示（同進展日誌）。只回自己的。 */
export async function handleProjectPrs(env, user, projectId) {
  const { state } = await readState(env, user.id);
  if (!state || !(state.ganttProjects || []).some(g => g.id === projectId)) return json({ prs: [], projectMissing: true });
  const rows = await listPrsOfProject(env, user.id, projectId, { limit: 200 });
  const count = f => rows.filter(f).length;
  return json({
    prs: rows.map(ownerPrView),
    counts: { open: count(r => r.state === 'open' || r.state === 'draft'), merged: count(r => r.state === 'merged'), closed: count(r => r.state === 'closed') },
  });
}

export async function handleHookStatus(env, user) {
  const row = await env.DB.prepare('SELECT created_at FROM github_hooks WHERE user_id = ?').bind(user.id).first();
  return json({ configured: !!row, createdAt: row ? row.created_at : null });
}

/** POST /api/github/hooks：建立或重新產生（舊的網址與密鑰立刻失效）。網址與密鑰只在這一刻回傳，之後只存雜湊與密鑰。 */
export async function handleHookCreate(request, env, user) {
  const token = generateToken(), secret = generateToken();
  await env.DB.prepare(
    `INSERT INTO github_hooks (user_id, token_hash, secret, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, secret = excluded.secret, created_at = excluded.created_at`
  ).bind(user.id, await sha256(token), secret, Date.now()).run();
  const base = String(env.APP_URL || '').replace(/\/+$/, '') || new URL(request.url).origin;
  return json({
    url: `${base}/api/github/hook/${token}`, secret,
    note: '到 GitHub repo 的 Settings → Webhooks → Add webhook：貼上網址、Content type 選 application/json、Secret 貼上密鑰，事件勾 Pull requests、Check suites、Check runs。網址與密鑰只會顯示這一次；重新產生會讓舊的立刻失效。',
  });
}

export async function handleHookDelete(env, user) {
  await env.DB.prepare('DELETE FROM github_hooks WHERE user_id = ?').bind(user.id).run();
  return json({ ok: true });
}

// ------------------------------------------------------------ webhook 本體

const PR_STATE = pr => (pr.merged || pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open');

/** check_suite／check_run 的結論對應成我們的四種。 */
function checksOf(o) {
  if (!o || o.status !== 'completed') return 'pending';
  if (['success', 'neutral', 'skipped'].includes(o.conclusion)) return 'passing';
  if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(o.conclusion)) return 'failing';
  return 'pending';
}

/** 更新「已經連過」的那一列。沒有就回 null（忽略）。回傳是否真的有改到。 */
async function patchPr(env, userId, repo, number, patch) {
  const prev = await env.DB.prepare('SELECT * FROM project_prs WHERE user_id = ? AND repo = ? AND number = ?').bind(userId, repo, number).first();
  if (!prev) return null;
  const next = { ...prev, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  await env.DB.prepare(
    `UPDATE project_prs SET title = ?, branch = ?, author = ?, state = ?, checks = ?, source = 'webhook', updated_at = ?
      WHERE id = ? AND user_id = ?`
  ).bind(next.title, next.branch, next.author, next.state, next.checks, Date.now(), prev.id, userId).run();
  await writePrEvents(env, { ...prev, user_id: userId }, 'GitHub', prEventBodies(prev, next));
  return true;
}

/** POST /api/github/hook/:token */
export async function handleGithubHook(request, env, token) {
  const hook = await env.DB.prepare('SELECT user_id, secret FROM github_hooks WHERE token_hash = ?').bind(await sha256(token)).first();
  if (!hook) return json({ error: 'Not Found' }, 404);

  const declared = parseInt(request.headers.get('content-length') || '0', 10);
  if (declared > MAX_BODY_BYTES) return json({ error: 'Payload Too Large' }, 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Payload Too Large' }, 413);

  const sig = request.headers.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + await hmacHex(hook.secret, raw);
  if (!timingSafeEqual(enc.encode(sig), enc.encode(expected))) return json({ error: '簽章不符' }, 401);

  const event = request.headers.get('x-github-event') || '';
  if (event === 'ping') return json({ ok: true, pong: true });
  let p;
  try { p = JSON.parse(raw); } catch { return json({ error: 'body 不是 JSON（Content type 要選 application/json）' }, 400); }
  const repo = String(p && p.repository && p.repository.full_name || '').toLowerCase();
  if (!repo || !p) return json({ ok: true, ignored: true });

  try {
    let updated = 0;
    if (event === 'pull_request' && p.pull_request && Number.isInteger(p.pull_request.number)) {
      const pr = p.pull_request;
      const r = await patchPr(env, hook.user_id, repo, pr.number, {
        state: PR_STATE(pr),
        title: cleanOneLine(pr.title),
        branch: pr.head && pr.head.ref != null ? cleanOneLine(pr.head.ref) : undefined,
        author: pr.user && pr.user.login != null ? cleanOneLine(pr.user.login) : undefined,
      });
      if (r) updated++;
    } else if (event === 'check_suite' && p.check_suite) {
      const checks = checksOf(p.check_suite);
      for (const pr of Array.isArray(p.check_suite.pull_requests) ? p.check_suite.pull_requests.slice(0, 20) : []) {
        if (pr && Number.isInteger(pr.number) && await patchPr(env, hook.user_id, repo, pr.number, { checks })) updated++;
      }
    } else if (event === 'check_run' && p.check_run) {
      // 一個 check_run 只是整體測試的一小塊：失敗就是失敗、進行中先標進行中，但**單一個通過不代表整體通過**
      //（整體由 check_suite 說了算），所以這裡不會把任何東西改成 passing，也不會把 failing 蓋回 pending
      const c = checksOf(p.check_run);
      if (c !== 'passing') {
        for (const pr of Array.isArray(p.check_run.pull_requests) ? p.check_run.pull_requests.slice(0, 20) : []) {
          if (!pr || !Number.isInteger(pr.number)) continue;
          const cur = await env.DB.prepare('SELECT checks FROM project_prs WHERE user_id = ? AND repo = ? AND number = ?').bind(hook.user_id, repo, pr.number).first();
          if (c === 'pending' && cur && cur.checks === 'failing') continue;
          if (await patchPr(env, hook.user_id, repo, pr.number, { checks: c })) updated++;
        }
      }
    } else {
      return json({ ok: true, ignored: true });
    }
    return json({ ok: true, updated });
  } catch (e) {
    // 細節只進 log。回 500 讓 GitHub 重送（寫入是冪等的：同一份 payload 寫兩次結果相同）
    console.error('github hook failed', e?.stack || String(e));
    return json({ error: '伺服器發生錯誤' }, 500);
  }
}
