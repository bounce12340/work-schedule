/**
 * 專案的唯讀分享連結（第三批 3A，設計文件第 21 件）：`/api/p/:token`，**不用登入**。
 *
 * 這是給不用登入的人看的，而日誌是 agent 寫的外部內容，可能有內部網址、人名、甚至金鑰。所以：
 *   - **預設只有**：專案名、里程碑（含會不會趕上）、每個任務的名稱／起訖／狀態／進度／預測完成日。
 *     說明書、筆記、連結、認領的人、卡住的原因、每日記錄、其他專案——**這個檔案裡沒有任何一行讀它們**
 *   - 日誌、提問、決策、風險、PR **一律不帶**，要帶哪一種由擁有者在產生連結時勾選（`include`）
 *   - **被遮蔽的那幾筆永遠不出現**（SQL 就濾掉，不是組出來再刪）
 *   - token 只存雜湊、只在產生當下回傳一次（同 ICS）；重新產生＝舊的撤銷（同一個專案同時只有一個有效連結）
 *   - 內容由伺服器從 user_state＋project_events 組出來（甘特任務是固定日期，不需要 occurrence 引擎）
 *   - 連結不存在／撤銷了／專案已經不在 → 一律 404（不分原因：不讓人用它探測）
 *
 * 公開頁面（`/p/:token` 的 HTML）留給 3B；這裡只有 JSON。
 */
import { json } from './auth.js';
import { generateToken, sha256 } from '../crypto.js';
import { readState, ymdTaipei } from '../mcp/store.js';
import * as S from '../mcp/schedule.js';

/** 擁有者可以多勾哪幾種。events＝進展與交接、questions＝提問／回答／撤回、decisions＝決策、risks＝還開著的風險、prs＝PR。 */
export const SHARE_INCLUDES = ['events', 'questions', 'decisions', 'risks', 'prs'];
const KINDS_OF = {
  events: ['progress', 'handoff'],
  questions: ['question', 'answer', 'withdraw'],
  decisions: ['decision'],
};
const MAX_PUBLIC_EVENTS = 50;

const ownerView = r => ({
  id: r.id, projectId: r.project_id, createdAt: r.created_at,
  include: (() => { try { return JSON.parse(r.include_json); } catch { return []; } })(),
});

async function projectExists(env, user, projectId) {
  const { state } = await readState(env, user.id);
  return !!(state && (state.ganttProjects || []).some(g => g && g.id === projectId));
}

/** GET /api/projects/:pid/share：目前有效的那一個（不回 token——它只存雜湊，回不出來）。 */
export async function handleShareStatus(env, user, projectId) {
  const row = await env.DB.prepare(
    'SELECT * FROM project_shares WHERE user_id = ? AND project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1'
  ).bind(user.id, projectId).first();
  return json({ active: row ? ownerView(row) : null });
}

/** POST /api/projects/:pid/share { include? }：產生（或重新產生）。舊的當場撤銷，新的 token 只回這一次。 */
export async function handleShareCreate(request, env, user, projectId) {
  let body = {};
  try { body = await request.json(); } catch { /* 全部用預設：什麼都不多帶 */ }
  let include = body && body.include != null ? body.include : [];
  if (!Array.isArray(include) || !include.every(x => SHARE_INCLUDES.includes(x))) {
    return json({ error: `include 只能是 ${SHARE_INCLUDES.join('、')} 的陣列` }, 400);
  }
  include = [...new Set(include)];
  if (!(await projectExists(env, user, projectId))) return json({ error: '找不到這個專案' }, 404);

  const token = generateToken();
  const now = Date.now();
  const id = crypto.randomUUID();
  // 撤銷舊的與建立新的在同一個交易裡：中間任何時刻都不會有兩個有效的連結，也不會有「舊的撤了、新的沒建成」
  await env.DB.batch([
    env.DB.prepare('UPDATE project_shares SET revoked_at = ? WHERE user_id = ? AND project_id = ? AND revoked_at IS NULL')
      .bind(now, user.id, projectId),
    env.DB.prepare('INSERT INTO project_shares (id, user_id, project_id, token_hash, include_json, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .bind(id, user.id, projectId, await sha256(token), JSON.stringify(include), now),
  ]);
  const base = String(env.APP_URL || '').replace(/\/+$/, '') || new URL(request.url).origin;
  return json({ id, token, url: `${base}/p/${token}`, include, note: '網址只會顯示這一次；重新產生會讓舊的立刻失效。' });
}

/** DELETE /api/projects/:pid/share：撤銷。沒有有效的連結也回 ok（冪等）。 */
export async function handleShareRevoke(env, user, projectId) {
  const r = await env.DB.prepare('UPDATE project_shares SET revoked_at = ? WHERE user_id = ? AND project_id = ? AND revoked_at IS NULL')
    .bind(Date.now(), user.id, projectId).run();
  return json({ ok: true, revoked: r.meta?.changes ?? 0 });
}

const notFound = () => new Response(JSON.stringify({ error: '找不到這個連結' }), {
  status: 404, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/** 公開端點：以 token 取得那一個專案的唯讀內容。token 即憑證，不看 session。 */
export async function handlePublicProject(env, token) {
  // 擁有者被停用（status 不是 approved）時連結一起失效：停用要立即生效（同 session 銷毀），公開頁不是例外
  const share = await env.DB.prepare(
    `SELECT p.* FROM project_shares p JOIN users u ON u.id = p.user_id
      WHERE p.token_hash = ? AND p.revoked_at IS NULL AND u.status = 'approved'`
  ).bind(await sha256(token)).first();
  if (!share) return notFound();
  let state = null;
  try { state = (await readState(env, share.user_id)).state; } catch { /* 讀不到就當專案不在：404，不是 500 */ }
  const gp = state && Array.isArray(state.ganttProjects) ? state.ganttProjects.find(g => g && g.id === share.project_id) : null;
  if (!gp) return notFound();

  let include = [];
  try { include = JSON.parse(share.include_json).filter(x => SHARE_INCLUDES.includes(x)); } catch { /* 壞掉就什麼都不多帶 */ }
  const today = ymdTaipei();
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results || [];

  // 預設內容：只有這幾個欄位。**逐欄挑出來，不是整個物件複製再刪**：日後任務多了新欄位（認領、連結、卡住的原因…），
  // 預設不會跟著公開出去
  const out = {
    project: { name: String(gp.name || '') },
    today,
    milestones: (gp.milestones || []).map(m => {
      const st = S.milestoneStatus(gp, m, today);
      return { name: String(m.name || ''), date: m.date, atRisk: st.atRisk, ...(st.reason ? { reason: st.reason } : {}) };
    }),
    tasks: (gp.tasks || []).map(t => ({
      name: String(t.name || ''), start: t.start, end: t.end,
      status: S.TASK_STATUSES.includes(t.status) ? t.status : 'todo',
      progress: t.progress, done: S.effectiveDone(t),
      forecastEnd: S.isYmd(t.forecastEnd) ? t.forecastEnd : null,
    })),
    includes: include,
  };

  // 勾選的種類。**被遮蔽的（redacted_at 有值）一律不撈**；每一種各自一句查詢，沒勾的不查
  const wantKinds = include.flatMap(k => KINDS_OF[k] || []);
  if (wantKinds.length) {
    const rows = await q(
      `SELECT kind, actor, body, created_at FROM project_events
        WHERE user_id = ? AND project_id = ? AND redacted_at IS NULL AND kind IN (${wantKinds.map(() => '?').join(',')})
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      share.user_id, share.project_id, ...wantKinds, MAX_PUBLIC_EVENTS);
    out.events = rows.map(r => ({ kind: r.kind, by: r.actor, at: new Date(r.created_at).toISOString(), text: r.body }));
  }
  if (include.includes('risks')) {
    const rows = await q(
      "SELECT actor, body, created_at FROM project_events WHERE user_id = ? AND project_id = ? AND kind = 'risk' AND status = 'open' AND redacted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?",
      share.user_id, share.project_id, MAX_PUBLIC_EVENTS);
    out.risks = rows.map(r => ({ by: r.actor, at: new Date(r.created_at).toISOString(), text: r.body }));
  }
  if (include.includes('prs')) {
    const rows = await q(
      'SELECT repo, number, title, url, state, checks, review FROM project_prs WHERE user_id = ? AND project_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 50',
      share.user_id, share.project_id);
    out.prs = rows.map(r => ({ repo: r.repo, number: r.number, title: r.title || '', url: r.url, state: r.state, checks: r.checks, review: r.review }));
  }

  return new Response(JSON.stringify(out), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 與 ICS 同量級的短快取：輪詢頻率不一，短快取避免壓力又不至於太舊。private：別讓共用的代理快取留住
      'cache-control': 'private, max-age=60',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}
