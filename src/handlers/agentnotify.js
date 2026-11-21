/**
 * agent 問了問題／提了提案，要通知到人（第一批 1B，設計文件 5-2）。
 *
 * 「等你回覆」只在打開網頁時看得到，agent 可能等三天。有新的提問或提案時寄信／推播：
 *
 *   - **它是訂閱信**（kind='agent'，不在 TX_KINDS 裡）：系統主動送的，退訂名單該擋得住它；
 *     帶退訂連結與 List-Unsubscribe，退訂只關「agent 通知」這一顆，不與逾期信、櫻花樹連坐。
 *   - **自己一個開關**（reminder_feed.agent_notify，預設開；沒有那一列也是開）。
 *   - **立刻送，不等每日 cron**——但同一個專案 30 分鐘內最多一封，多的併進 pending，
 *     下一次提問或每日 cron 合併成「還有 N 件」。agent 連問十題不該是十封信。
 *   - **休假那天不送**（同〈休假那幾天閉嘴〉）：只累計 pending，休假結束後由 cron 補上。
 *   - **信與推播裡絕不放問題或提案的全文**：那是 agent 寫的外部內容，也可能有機敏資訊
 *     （鎖定畫面是別人也看得到的地方）。只說「<連線名稱> 在「<專案名>」等你決定 N 件事」＋連結。
 *   - **失敗不寫 last_sent_at**：沒送成功就不算送過，下一次要能補（同 last_sent_ymd）。
 *
 * 失敗一律只 console.warn、不往上丟：通知寄不出去不該讓 agent 的提問變成錯誤
 * （提問已經寫進資料庫了，回錯誤會讓 agent 重送而問兩次）。
 */
import { sendMail, escHtml } from '../mail.js';
import { apnsConfigured } from '../apns.js';
import { sendToUser } from './push.js';
import {
  taipeiYmd, isOnLeave, ensureUnsubToken, unsubUrl, unsubHeaders, unsubBlock,
} from './reminder.js';

/** 同一個專案兩封之間至少隔這麼久。 */
export const AGENT_NOTIFY_MIN_GAP_MS = 30 * 60 * 1000;
const MAX_ERRORS = 5;

/** 連線名稱可能來自外部（OAuth 動態註冊的 client 名稱）：去換行、截短，HTML 輸出時另外跳脫。 */
function cleanName(v) {
  const t = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 60);
  return t || 'AI agent';
}

/** 「<連線名稱> 在「<專案名>」等你決定 N 件事」／沒有專案時「<連線名稱> 有 N 件事等你決定」。純函式，方便直接測。 */
export function agentAskLine(actor, projectName, n) {
  const who = cleanName(actor);
  return projectName
    ? `${who} 在「${projectName}」等你決定 ${n} 件事`
    : `${who} 有 ${n} 件事等你決定`;
}

/**
 * 信的內容。**只有「誰、哪個專案、幾件、連結」，沒有問題或提案的任何文字。**
 * more=true 是 cron 把先前被節流擋下來的合併送出：「還有 N 件」。
 */
export function buildAgentEmail({ actor, projectName, n, more = false }, appUrl, unsub = '') {
  const who = cleanName(actor);
  const line = more
    ? (projectName ? `${who} 在「${projectName}」還有 ${n} 件事等你決定` : `${who} 還有 ${n} 件事等你決定`)
    : agentAskLine(actor, projectName, n);
  const link = appUrl ? `${String(appUrl).replace(/\/+$/, '')}/` : '';
  const text = [
    line,
    '',
    '內容請打開系統看（為了保護隱私，信裡不放問題與提案的內容）。',
    link ? `\n前往「等你回覆」：${link}` : '',
    '',
    '— 工作排程確認系統',
    ...(unsub ? [
      '',
      '─────────────',
      '不想再收 agent 的通知？點這裡直接停掉：',
      unsub,
      ...(link ? [`想自己管全部的通知（信與推播）：${link}#notify`] : []),
    ] : []),
  ].join('\n');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#2A2A26">
<p style="margin:0 0 12px;font-size:15px"><b>${escHtml(line)}</b></p>
<p style="margin:0 0 14px;color:#71706A">為了保護隱私，信裡不放問題與提案的內容，請打開系統看。</p>
${link ? `<p style="margin:0 0 18px"><a href="${escHtml(link)}" style="color:#8A5716">前往「等你回覆」 →</a></p>` : ''}
<p style="margin:22px 0 0;color:#71706A;font-size:12px">agent 提問或提案時才會收到這封信；同一個專案 30 分鐘內最多一封。</p>
${unsub ? unsubBlock(unsub, link ? link.replace(/\/$/, '') : '', '不想再收 agent 的通知') : ''}
</div>`;
  return { subject: `【等你回覆】${line}`, text, html };
}

/** 專案名稱（讀不到就回 null：寧可寫「有 N 件事等你決定」，也不要為了名字讓通知整個失敗）。 */
async function projectNameOf(env, userId, projectId) {
  if (!projectId) return { name: null, exists: true };
  try {
    const row = await env.DB.prepare('SELECT state FROM user_state WHERE user_id = ?').bind(userId).first();
    if (!row) return { name: null, exists: true };
    const st = JSON.parse(row.state);
    const gp = (st.ganttProjects || []).find(g => g && g.id === projectId);
    return gp ? { name: String(gp.name || ''), exists: true } : { name: null, exists: false };
  } catch (e) {
    console.warn('agent notify: 讀不到專案名稱', e?.message || String(e));
    return { name: null, exists: true };
  }
}

/** 這個人的通知偏好與收信資料。沒有 reminder_feed 那一列時補一列（退訂 token 要有地方存）。 */
async function loadRecipient(env, userId) {
  await env.DB.prepare('INSERT OR IGNORE INTO reminder_feed (user_id, updated_at) VALUES (?, ?)').bind(userId, Date.now()).run();
  return env.DB.prepare(
    `SELECT r.agent_notify, r.leave_days, r.unsub_token, u.email, u.status
       FROM users u JOIN reminder_feed r ON r.user_id = u.id WHERE u.id = ?`
  ).bind(userId).first();
}

/**
 * 真正送出一封（信＋推播）。呼叫之前已經「領走」節流位子；回 true 代表至少一個管道送到了。
 * 兩個管道各自獨立：推播沒設定或沒有 token 就只寄信，反過來也一樣。
 */
async function deliver(env, rcpt, userId, { actor, projectName, n, more }) {
  let ok = false;
  const errors = [];
  try {
    const token = await ensureUnsubToken(env, userId, rcpt.unsub_token);
    const appUrl = env.APP_URL || '';
    const mail = buildAgentEmail({ actor, projectName, n, more }, appUrl, unsubUrl(appUrl, token, 'agent'));
    mail.headers = unsubHeaders(appUrl, token, 'agent');
    await sendMail(env, rcpt.email, mail, 'agent');
    ok = true;
  } catch (e) {
    console.warn('agent notify mail failed', userId, String(e));
    errors.push(String(e?.message || e).slice(0, 200));
  }
  if (apnsConfigured(env)) {
    try {
      const who = cleanName(actor);
      const r = await sendToUser(env, userId, 'agent',
        `${who} 在等你決定`,
        projectName ? `「${projectName}」有 ${n} 件事` : `有 ${n} 件事`);
      if (r.sent > 0) ok = true;
      for (const e of r.errors) errors.push(e.error);
    } catch (e) {
      console.warn('agent notify push failed', userId, String(e));
      errors.push(String(e?.message || e).slice(0, 200));
    }
  }
  return { ok, errors };
}

/**
 * 嘗試把「這個專案的待處理通知」送出去（節流已經過了才會呼叫）。
 *
 * **先「領走」再送**：以 `last_sent_at` 做 compare-and-swap——兩個併發的提問（agent 一次平行問三題）
 * 只有一個領得到，其餘留在 pending。送失敗就把 last_sent_at 還原成原值（等於沒寫），
 * 送成功才扣掉這一批的 pending（送的過程中新增的不會被吃掉）。
 */
async function claimAndSend(env, rcpt, st, userId, projectId, nowMs, more) {
  const n = st.pending;
  const claim = await env.DB.prepare(
    'UPDATE agent_notify_state SET last_sent_at = ? WHERE user_id = ? AND project_id = ? AND last_sent_at IS ?'
  ).bind(nowMs, userId, projectId, st.last_sent_at ?? null).run();
  if (claim.meta?.changes !== 1) return { sent: false, raced: true, errors: [] };

  const { name, exists } = await projectNameOf(env, userId, projectId);
  const rollback = () => env.DB.prepare(
    'UPDATE agent_notify_state SET last_sent_at = ? WHERE user_id = ? AND project_id = ? AND last_sent_at = ?'
  ).bind(st.last_sent_at ?? null, userId, projectId, nowMs).run();
  if (!exists) {
    // 專案已經不在了：通知沒有意義，清掉這一列
    await env.DB.prepare('DELETE FROM agent_notify_state WHERE user_id = ? AND project_id = ?').bind(userId, projectId).run();
    return { sent: false, gone: true, errors: [] };
  }
  const r = await deliver(env, rcpt, userId, { actor: st.actor, projectName: name, n, more });
  if (!r.ok) { await rollback(); return { sent: false, errors: r.errors }; }
  await env.DB.prepare(
    'UPDATE agent_notify_state SET pending = MAX(pending - ?, 0) WHERE user_id = ? AND project_id = ?'
  ).bind(n, userId, projectId).run();
  return { sent: true, errors: [] };
}

/**
 * agent 剛問了一個問題（或提了一份提案）。回 { action }：
 * 'off'（開關關著或帳號不是 approved）／'leave'（休假，只累計）／'throttled'（30 分鐘內，只累計）／
 * 'sent'／'failed'／'gone'。**永遠不丟例外**（見檔頭）。
 */
export async function notifyAgentAsk(env, userId, projectId, actor, nowMs = Date.now()) {
  const pid = projectId || '';
  try {
    const rcpt = await loadRecipient(env, userId);
    if (!rcpt || rcpt.status !== 'approved' || rcpt.agent_notify === 0) return { action: 'off' };

    // 先累計：不管接下來送不送，這一件都要算進去
    await env.DB.prepare(
      `INSERT INTO agent_notify_state (user_id, project_id, last_sent_at, pending, actor) VALUES (?, ?, NULL, 1, ?)
       ON CONFLICT(user_id, project_id) DO UPDATE SET pending = pending + 1, actor = excluded.actor`
    ).bind(userId, pid, cleanName(actor)).run();
    const st = await env.DB.prepare('SELECT * FROM agent_notify_state WHERE user_id = ? AND project_id = ?').bind(userId, pid).first();

    if (isOnLeave(rcpt.leave_days, taipeiYmd(nowMs))) return { action: 'leave' };
    if (st.last_sent_at != null && nowMs - st.last_sent_at < AGENT_NOTIFY_MIN_GAP_MS) return { action: 'throttled' };

    const r = await claimAndSend(env, rcpt, st, userId, pid, nowMs, st.pending > 1);
    if (r.raced) return { action: 'throttled' };
    if (r.gone) return { action: 'gone' };
    return { action: r.sent ? 'sent' : 'failed' };
  } catch (e) {
    console.warn('agent notify failed', userId, e?.stack || String(e));
    return { action: 'failed' };
  }
}

/**
 * 自動暫停的那一刻通知（同一個開關）。**不套 30 分鐘節流**：它一條連線一小時最多發生一次，
 * 而且是「你的 agent 被停住了」這種你想立刻知道的事。不寫節流表。
 * 休假那天**照送**：這是安全事件（它已經停了、你得知道為什麼），不是「又有事要你做」的打擾——
 * 但仍受開關控制。
 */
export async function notifyAgentPaused(env, userId, connName) {
  try {
    const rcpt = await loadRecipient(env, userId);
    if (!rcpt || rcpt.status !== 'approved' || rcpt.agent_notify === 0) return { action: 'off' };
    const who = cleanName(connName);
    const appUrl = env.APP_URL || '';
    const token = await ensureUnsubToken(env, userId, rcpt.unsub_token);
    const link = appUrl ? `${appUrl.replace(/\/+$/, '')}/#notify` : '';
    const unsub = unsubUrl(appUrl, token, 'agent');
    const line = `已自動暫停「${who}」`;
    const text = [
      line, '',
      '它一小時內被復原了 5 次以上，所以我們先讓它只能讀、不能寫。',
      '到「我的帳號 › 連接 AI agent」看看它改了什麼，確定沒問題再按「恢復」。',
      link ? `\n${link.replace('#notify', '')}` : '',
      '', '— 工作排程確認系統',
      ...(unsub ? ['', '─────────────', '不想再收 agent 的通知？點這裡直接停掉：', unsub] : []),
    ].join('\n');
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#2A2A26">
<p style="margin:0 0 12px;font-size:15px"><b>${escHtml(line)}</b></p>
<p style="margin:0 0 14px;color:#71706A">它一小時內被復原了 5 次以上，所以我們先讓它只能讀、不能寫。到「我的帳號 › 連接 AI agent」看看它改了什麼，確定沒問題再按「恢復」。</p>
${unsub ? unsubBlock(unsub, appUrl.replace(/\/+$/, ''), '不想再收 agent 的通知') : ''}
</div>`;
    const mail = { subject: `【agent 已暫停】${line}`, text, html };
    mail.headers = unsubHeaders(appUrl, token, 'agent');
    await sendMail(env, rcpt.email, mail, 'agent');
    return { action: 'sent' };
  } catch (e) {
    console.warn('agent paused notify failed', userId, String(e));
    return { action: 'failed' };
  }
}

/**
 * Cron 的一步：把先前被節流（或休假）擋下來的 pending 合併成「還有 N 件」送出。
 * 只處理 last_sent_at 已經超過 30 分鐘的；今天在休假的繼續留著（不寫任何東西）；
 * 開關關著的清掉 pending（再打開時不該收到一封過期的信）。
 * 回傳含 errors[]：step() 會把它當成「這一步有失敗」（同 sendOverdueReminders）。
 */
export async function sendAgentNotifyPending(env, nowMs = Date.now()) {
  const out = { checked: 0, sent: 0, off: 0, onLeave: 0, gone: 0, failed: 0, errors: [] };
  const rows = await env.DB.prepare(
    'SELECT * FROM agent_notify_state WHERE pending > 0 AND (last_sent_at IS NULL OR last_sent_at <= ?)'
  ).bind(nowMs - AGENT_NOTIFY_MIN_GAP_MS).all();
  const today = taipeiYmd(nowMs);
  for (const st of rows.results || []) {
    out.checked++;
    try {
      const rcpt = await loadRecipient(env, st.user_id);
      if (!rcpt || rcpt.status !== 'approved' || rcpt.agent_notify === 0) {
        await env.DB.prepare('UPDATE agent_notify_state SET pending = 0 WHERE user_id = ? AND project_id = ?').bind(st.user_id, st.project_id).run();
        out.off++;
        continue;
      }
      if (isOnLeave(rcpt.leave_days, today)) { out.onLeave++; continue; }
      const r = await claimAndSend(env, rcpt, st, st.user_id, st.project_id, nowMs, true);
      if (r.sent) out.sent++;
      else if (r.gone) out.gone++;
      else if (!r.raced) {
        out.failed++;
        for (const e of r.errors) if (out.errors.length < MAX_ERRORS) out.errors.push({ userId: st.user_id, error: e });
      }
    } catch (e) {
      out.failed++;
      if (out.errors.length < MAX_ERRORS) out.errors.push({ userId: st.user_id, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return out;
}

/** 呼叫端用：有 waitUntil 就丟進去（不拖慢工具的回應），沒有（測試、cron）就等它跑完。 */
export async function runDetached(ctx, promise) {
  const p = Promise.resolve(promise).catch(e => console.warn('agent notify detached failed', e?.message || String(e)));
  if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(p); return; }
  await p;
}
