/**
 * 每週摘要信（第三批 3A）。每個專案一行數字：這週完成幾件、逾期幾件、等你回覆幾題、還開著幾個風險、
 * 幾個里程碑有風險。走既有的 cron 與 mail_log，訂閱信的規則全部適用：
 *
 *   - **訂閱信**（kind='weekly'，不在 TX_KINDS）：系統主動送的，退訂名單該擋得住它；帶退訂連結與
 *     List-Unsubscribe；退訂只關「每週摘要」這一顆（`weekly_mail`），與另外六顆互不連坐
 *   - **自己一個開關，預設關**：這是所有既有使用者都沒同意過的新一種信。突然每週寄一封，換來的是有人去按
 *     Gmail 的「取消訂閱」——那會把整個帳號送進寄信商的退訂名單，連密碼重設信都收不到（helen 2026-09-09）。
 *     要收的人在「我的帳號」自己打開
 *   - **沒事就閉嘴**：所有專案都沒有任何一項非零就完全不寄
 *   - **休假那天不送、也不記成送過**（同〈休假那幾天閉嘴〉）：隔天補
 *   - **寄失敗不寫 weekly_mail_week**：沒送成功就不算送過（同 last_sent_ymd）
 *   - **一週一封**：weekly_mail_week 記「最後一次寄成功的那一週（星期一的日期）」
 *   - **信裡沒有任何日誌、提問、風險的文字**，只有數字與專案名稱（專案名是使用者自己取的）
 *
 * 哪天寄：星期一（台北）早上的 cron；星期一休假或失敗的話，星期二、三的 cron 補寄（同一週的 weekly_mail_week
 * 還沒寫就是還沒送過）。星期四之後這一週就過了，不補——一封「上週」的週報在週末才到達只是噪音。
 * 中途打開開關的人：下一個星期一（或當週的二、三）收到第一封。
 *
 * 「這週完成幾件」的來源：甘特任務沒有完成時間戳，所以拿**最近 7 天內最早的一版歷史**（Pro 才有）
 * 與現在比，數「現在完成、當時沒完成」的任務。沒有那一版（免費帳號、剛開始留）就**不列這個數字**，
 * 而不是寫 0——寫 0 是一句假話。
 */
import { escHtml, sendMail } from '../mail.js';
import {
  taipeiYmd, addDays, isOnLeave, ensureUnsubToken, unsubUrl, unsubHeaders, unsubBlock,
} from './reminder.js';
import * as S from '../mcp/schedule.js';
import { readVersionBody } from '../mcp/history.js';

const MAX_ERRORS = 5;
const WEEK_MS = 7 * 24 * 3600 * 1000;
/** 星期一到星期三（getUTCDay：一＝1）。 */
const SEND_DOWS = [1, 2, 3];

/** 這一天所在那一週的星期一（YYYY-MM-DD）。 */
export function weekKeyOf(ymd) {
  const dow = new Date(ymd + 'T00:00:00Z').getUTCDay();   // 0＝週日
  return addDays(ymd, -((dow + 6) % 7));
}
const dowOf = ymd => new Date(ymd + 'T00:00:00Z').getUTCDay();

/** 最近 7 天內最早的那一版（拿來數「這週完成」）。讀不到回 null。 */
async function weeklyBaseline(env, userId, nowMs) {
  if (!env.BACKUPS) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT id FROM state_versions WHERE user_id = ? AND created_at >= ? ORDER BY created_at ASC, rowid ASC LIMIT 1'
    ).bind(userId, nowMs - WEEK_MS).first();
    if (!row) return null;
    const body = await readVersionBody(env, userId, row.id);
    return body ? JSON.parse(body) : null;
  } catch (e) {
    console.warn('weekly baseline failed', userId, e?.message || String(e));
    return null;
  }
}

/**
 * 每個專案的數字。純函式：state（現在）、baseline（7 天內最早的一版，可為 null）、counts（資料庫算好的
 * 提問與風險數）、今天。沒有任何一項非零的專案不列。
 */
export function digestProjects(state, baseline, counts, today) {
  const baseDone = new Map();
  if (baseline && Array.isArray(baseline.ganttProjects)) {
    for (const gp of baseline.ganttProjects) for (const t of gp.tasks || []) baseDone.set(`${gp.id}/${t.id}`, S.effectiveDone(t));
  }
  const out = [];
  for (const gp of (state && state.ganttProjects) || []) {
    const tasks = gp.tasks || [];
    const done = baseline ? tasks.filter(t => S.effectiveDone(t) && baseDone.get(`${gp.id}/${t.id}`) !== true).length : null;
    const overdue = tasks.filter(t => !S.effectiveDone(t) && typeof t.end === 'string' && t.end < today).length;
    const c = counts.get(gp.id) || { questions: 0, risks: 0 };
    const atRisk = (gp.milestones || []).filter(m => S.milestoneStatus(gp, m, today).atRisk).length;
    if (!(done > 0 || overdue || c.questions || c.risks || atRisk)) continue;
    out.push({ name: String(gp.name || ''), done, overdue, questions: c.questions, risks: c.risks, milestonesAtRisk: atRisk });
  }
  return out;
}

const parts = p => [
  p.done != null && p.done > 0 ? `完成 ${p.done} 件` : null,
  p.overdue ? `逾期 ${p.overdue} 件` : null,
  p.questions ? `等你回覆 ${p.questions} 題` : null,
  p.risks ? `風險 ${p.risks} 個` : null,
  p.milestonesAtRisk ? `${p.milestonesAtRisk} 個里程碑有風險` : null,
].filter(Boolean);

/** 信的內容：只有專案名與數字。 */
export function buildWeeklyEmail(projects, appUrl, unsub = '') {
  const link = appUrl ? `${String(appUrl).replace(/\/+$/, '')}/` : '';
  const lines = projects.map(p => `・${p.name}：${parts(p).join('、')}`);
  const text = [
    `這週有 ${projects.length} 個專案有動靜：`,
    '',
    ...lines,
    link ? `\n打開系統看細節：${link}` : '',
    '',
    '— 工作排程確認系統',
    ...(unsub ? ['', '─────────────', '不想再收每週摘要？點這裡直接停掉：', unsub,
      ...(link ? [`想自己管全部的通知（信與推播）：${link}#notify`] : [])] : []),
  ].join('\n');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#2A2A26">
<p style="margin:0 0 12px;font-size:15px"><b>這週有 ${projects.length} 個專案有動靜</b></p>
<ul style="margin:0 0 16px;padding-left:20px">
${projects.map(p => `<li><b>${escHtml(p.name)}</b>：${escHtml(parts(p).join('、'))}</li>`).join('\n')}
</ul>
${link ? `<p style="margin:0 0 18px"><a href="${escHtml(link)}" style="color:#8A5716">打開系統看細節 →</a></p>` : ''}
<p style="margin:22px 0 0;color:#71706A;font-size:12px">每週一次，只有數字；沒有任何動靜的那週不會寄。</p>
${unsub ? unsubBlock(unsub, link ? link.replace(/\/$/, '') : '', '不想再收每週摘要') : ''}
</div>`;
  return { subject: `【每週摘要】${projects.length} 個專案有動靜`, text, html };
}

/** 每日 cron 的一步。回傳含 errors[]（step() 因此不會把失敗記成乾淨的成功）。 */
export async function sendWeeklyDigest(env, nowMs = Date.now()) {
  const today = taipeiYmd(nowMs);
  const out = { checked: 0, sent: 0, nothingToSay: 0, alreadySent: 0, notApproved: 0, onLeave: 0, failed: 0, notSendDay: false, errors: [] };
  if (!SEND_DOWS.includes(dowOf(today))) { out.notSendDay = true; return out; }
  const week = weekKeyOf(today);
  const rows = await env.DB.prepare(
    `SELECT r.user_id, r.weekly_mail_week, r.leave_days, r.unsub_token, u.email, u.status
       FROM reminder_feed r JOIN users u ON u.id = r.user_id
      WHERE r.weekly_mail = 1`
  ).all();

  for (const row of rows.results || []) {
    out.checked++;
    if (row.status !== 'approved') { out.notApproved++; continue; }
    if (row.weekly_mail_week === week) { out.alreadySent++; continue; }
    if (isOnLeave(row.leave_days, today)) { out.onLeave++; continue; }

    try {
      const st = await env.DB.prepare('SELECT state FROM user_state WHERE user_id = ?').bind(row.user_id).first();
      const state = st ? JSON.parse(st.state) : null;
      const cnt = await env.DB.prepare(
        `SELECT project_id, kind, COUNT(*) AS n FROM project_events
          WHERE user_id = ? AND status = 'open' AND kind IN ('question', 'risk') GROUP BY project_id, kind`
      ).bind(row.user_id).all();
      const counts = new Map();
      for (const c of cnt.results || []) {
        const e = counts.get(c.project_id) || { questions: 0, risks: 0 };
        if (c.kind === 'question') e.questions = c.n; else e.risks = c.n;
        counts.set(c.project_id, e);
      }
      const projects = digestProjects(state, await weeklyBaseline(env, row.user_id, nowMs), counts, today);
      if (!projects.length) { out.nothingToSay++; continue; }

      const token = await ensureUnsubToken(env, row.user_id, row.unsub_token);
      const mail = buildWeeklyEmail(projects, env.APP_URL || '', unsubUrl(env.APP_URL || '', token, 'weekly'));
      mail.headers = unsubHeaders(env.APP_URL || '', token, 'weekly');
      await sendMail(env, row.email, mail, 'weekly');
      await env.DB.prepare('UPDATE reminder_feed SET weekly_mail_week = ? WHERE user_id = ?').bind(week, row.user_id).run();
      out.sent++;
    } catch (e) {
      console.warn('weekly mail failed', row.user_id, String(e));
      out.failed++;
      if (out.errors.length < MAX_ERRORS) out.errors.push({ email: row.email, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return out;
}
