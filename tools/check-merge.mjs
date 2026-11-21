/**
 * 三方合併在**真的瀏覽器**裡走一次（第零批：合併細到任務與欄位）。
 *
 * tests/merge.test.mjs 證明得了 threeWayMerge 這個函式對，證明不了它真的接上了畫面：
 * 啟動時的「本機有、雲端也被改過」那條分支 → handleConflict → applySnapshot → cloudPush。
 * 這支造一份基準、兩份各改一處的資料，讓假後端回遠端那一份，然後看：
 *   - 改的是不同的任務／同一個任務的不同欄位／項目的標題 vs 某一次的勾選 → **不跳對話框**，推上去的那一份兩邊都在
 *   - 同一欄改成不同值 → 跳一次對話框、講人話；選「保留本機」之後，另一個任務的遠端修改仍然在
 *
 *   node tools/check-merge.mjs      # 也吃 PORT（預設 8971）與 PLAYWRIGHT_CHROMIUM
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.error('需要 Playwright（不是本專案的相依套件）：npm install --no-save playwright'); process.exit(2); }
const PUB = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT || 8971);
const html = readFileSync(PUB + 'index.html', 'utf8'), sw = readFileSync(PUB + 'sw.js', 'utf8');
const ME = { email: 'me@example.test', role: 'user', status: 'approved', plan: 'pro', planSource: 'admin', planExpiresAt: null };
let remoteState = null, puts = [], backend = false;
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (c, b, t = 'application/json') => { res.writeHead(c, { 'Content-Type': t }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
  if (u.pathname.startsWith('/api/')) {
    if (!backend) return send(404, {});
    if (u.pathname === '/api/state') {
      if (req.method === 'PUT') { let raw = ''; req.on('data', c => raw += c); return req.on('end', () => { puts.push(JSON.parse(raw)); send(200, { ok: true, updatedAt: 3 }); }); }
      return send(200, { user: ME, state: remoteState, updatedAt: 2 });
    }
    if (u.pathname === '/api/shares') return send(200, { outgoing: [], incoming: [] });
    if (u.pathname === '/api/mcp/connections') return send(200, { connections: [] });
    if (u.pathname === '/api/mcp/activity') return send(200, { changes: [] });
    if (u.pathname === '/api/activity') return send(200, { activity: [] });
    return send(200, { ok: true });
  }
  if (u.pathname === '/sw.js') return send(200, sw, 'text/javascript');
  return send(200, html, 'text/html');
}).listen(PORT);
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
let fail = 0; const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fail++; };

async function run(label, edit, expectDialog) {
  backend = false; puts = [];
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => { const add=()=>{ const s = document.createElement('style'); s.textContent = '#bootSakura{display:none!important}'; document.documentElement.appendChild(s); }; if(document.documentElement) add(); else new MutationObserver((m,o)=>{ if(document.documentElement){ add(); o.disconnect(); } }).observe(document,{childList:true}); });
  await page.addInitScript(o => { if (!localStorage.getItem('workSchedule.v1.cloudMeta')) localStorage.setItem('workSchedule.v1.cloudMeta', JSON.stringify({ owner: o })); }, ME.email);
  await page.goto(`http://localhost:${PORT}/`);      // 沒後端：塞示範資料
  await page.waitForTimeout(800);
  const base = await page.evaluate(() => JSON.parse(localStorage.getItem('workSchedule.v1')));
  const gp = base.ganttProjects[0];
  if (!gp || gp.tasks.length < 2) throw new Error('示範資料沒有兩個以上的甘特任務');
  const clone = v => JSON.parse(JSON.stringify(v));
  const local = clone(base), remote = clone(base);
  edit(local, remote);
  remoteState = remote;
  await page.evaluate(([l, b, o]) => {
    localStorage.setItem('workSchedule.v1', JSON.stringify(l));
    localStorage.setItem('workSchedule.v1.cloudMeta', JSON.stringify({ owner: o, updatedAt: 1, baseSnapshot: b }));
  }, [local, base, ME.email]);
  backend = true;
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });   // 取消＝保留本機
  errors.length = 0;   // 第一次載入刻意沒有後端（404 是預期的），只算有後端之後的
  await page.reload(); await page.waitForTimeout(2500);
  ok(expectDialog ? dialogs.length === 1 : dialogs.length === 0, `${label}：對話框 ${dialogs.length} 次（預期 ${expectDialog ? 1 : 0}）`);
  ok(puts.length >= 1, `${label}：合併結果有推上雲端（${puts.length} 次）`);
  const pushed = puts.at(-1)?.state;
  ok(errors.length === 0, `${label}：零錯誤 ${errors.join(' | ')}`);
  await ctx.close();
  return { pushed, dialogs };
}

// 1. 同一個專案、不同任務
let r = await run('不同任務', (l, rm) => { l.ganttProjects[0].tasks[0].name = '本機改的A'; rm.ganttProjects[0].tasks[1].name = '遠端改的B'; }, false);
ok(r.pushed?.ganttProjects[0].tasks[0].name === '本機改的A' && r.pushed?.ganttProjects[0].tasks[1].name === '遠端改的B', '不同任務：兩邊的修改都在');
// 2. 同一個任務、不同欄位
r = await run('同任務不同欄', (l, rm) => { l.ganttProjects[0].tasks[0].name = '本機名'; rm.ganttProjects[0].tasks[0].end = '2027-01-31'; }, false);
ok(r.pushed?.ganttProjects[0].tasks[0].name === '本機名' && r.pushed?.ganttProjects[0].tasks[0].end === '2027-01-31', '同任務不同欄：兩欄都在');
// 3. 同一欄改成不同值（真衝突）＋另一個任務遠端改了：選「保留本機」之後遠端那一個仍在
r = await run('真衝突', (l, rm) => { l.ganttProjects[0].tasks[0].name = '本機名'; rm.ganttProjects[0].tasks[0].name = '遠端名'; rm.ganttProjects[0].tasks[1].name = '遠端改的B'; }, true);
ok(r.pushed?.ganttProjects[0].tasks[0].name === '本機名', '真衝突：選本機 → 衝突欄位是本機的');
ok(r.pushed?.ganttProjects[0].tasks[1].name === '遠端改的B', '真衝突：另一個任務的遠端修改沒有被蓋掉');
console.log('對話框文字：', r.dialogs[0]?.split('\n').slice(0, 3).join(' / '));
ok(/任務「本機名」的名稱/.test(r.dialogs[0] || ''), '真衝突：對話框講人話（任務「…」的名稱）');
// 4. 項目：本機改標題、遠端勾某一次完成
r = await run('項目', (l, rm) => {
  const i = l.items.findIndex(x => x.recurrence); l.items[i].title = '本機標題';
  rm.items[i].doneMap = { ...rm.items[i].doneMap, 'ZZ-remote': true };
}, false);
const it = r.pushed?.items.find(x => x.title === '本機標題');
ok(!!it && it.doneMap['ZZ-remote'] === true, '項目：標題與遠端的勾選都在');
await browser.close(); server.close();
console.log(fail ? `\n${fail} 條失敗` : '\n全部通過'); process.exit(fail ? 1 : 0);
