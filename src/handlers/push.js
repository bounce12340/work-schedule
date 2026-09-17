/**
 * 推播（子專案 B）與 F3。設計文件：docs/superpowers/specs/2026-09-17-push-design.md
 *
 * 三種推播，各有一個開關，**與 email 的兩個開關互不相干**：畫面上就是五顆按鈕。
 * 關掉逾期信不代表不想要逾期推播，反過來也一樣。
 *
 * 內容一律用前端推上來的 digest 算（`reminder_feed.digest`），與 ICS、提醒信、F2
 * 完全相同的模式：occurrence 引擎只存在 public/index.html 裡，在 Worker 重寫一份
 * 必然分歧，而**推播推錯日期比沒有推播更糟**——使用者會信任它。
 */
import { json } from './auth.js';
import { apnsSend, apnsConfigured } from '../apns.js';
import {
  taipeiYmd, addDays, pickOverdue, pickUpcoming, dayReport, isOnLeave, DEFAULT_LEAD_DAYS,
} from './reminder.js';

/** 連續不到兩天不吵人。與 email 版同一個門檻——兩邊不一樣的話會出現「信說斷了、推播沒推」。 */
const MIN_STREAK_FOR_PUSH = 2;
const MAX_ERRORS = 5;

/** 三種推播。`kind` 同時是開關欄位、去重欄位與 apns-collapse-id 的前綴。 */
export const PUSH_KINDS = ['overdue', 'streak', 'today'];

/**
 * POST /api/push/register   { token, environment }
 *
 * **token 是主鍵，換人登入就整列搬過去。** 同一支手機換人登入時那個 token 屬於
 * 後登入的人；若允許一個 token 對兩個 user，前一位使用者的排程會推到現在這個人的
 * 鎖定畫面上——那是資料外洩，不是重複資料。
 */
export async function handlePushRegister(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '格式錯誤' }, 400); }

  const token = String(body?.token || '').trim();
  // device token 是 hex；長度隨 iOS 版本變過，所以只驗字元集與一個寬鬆的上下界
  if (!/^[0-9a-fA-F]{32,256}$/.test(token)) return json({ error: 'token 格式錯誤' }, 400);
  const environment = body?.environment === 'sandbox' ? 'sandbox' : 'production';
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO device_tokens (token, user_id, environment, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id,
                                      environment = excluded.environment,
                                      last_seen_at = excluded.last_seen_at`
  ).bind(token, user.id, environment, now, now).run();

  return json({ ok: true });
}

/** DELETE /api/push/register  — 使用者在這台裝置上關掉推播 */
export async function handlePushUnregister(request, env, user) {
  let body = {};
  try { body = await request.json(); } catch { /* 沒帶 body 就刪這個人全部的 */ }
  const token = String(body?.token || '').trim();
  if (token) {
    await env.DB.prepare('DELETE FROM device_tokens WHERE token = ? AND user_id = ?').bind(token, user.id).run();
  } else {
    await env.DB.prepare('DELETE FROM device_tokens WHERE user_id = ?').bind(user.id).run();
  }
  return json({ ok: true });
}

/**
 * 送給某個人的所有裝置，並清掉 APNs 說已經不存在的 token。
 * 回 { sent, failed, errors }。**一支手機送不出去不該讓其他支也不送**（同寄信）。
 */
async function sendToUser(env, userId, kind, title, body) {
  const rows = await env.DB.prepare(
    'SELECT token, environment FROM device_tokens WHERE user_id = ?'
  ).bind(userId).all();

  const out = { sent: 0, failed: 0, errors: [] };
  for (const dev of rows.results || []) {
    let r;
    try {
      r = await apnsSend(env, { token: dev.token, environment: dev.environment, title, body, collapseId: kind });
    } catch (e) {
      // 網路層的例外（連不上、協定被拒）——**這是 HTTP/2 那個風險真的發生時的形狀**，
      // 所以錯誤訊息要進 errors，讓 cron_runs 與 /admin 看得到，而不是只留在 console。
      out.failed++;
      if (out.errors.length < MAX_ERRORS) out.errors.push({ userId, error: String(e?.message || e).slice(0, 200) });
      continue;
    }
    if (r.ok) { out.sent++; continue; }
    if (r.gone) {
      // 那支手機上已經沒有這個 app 了（或環境搞錯）。不刪的話這張表會慢慢長滿
      // 再也送不到的 token，而每天都會為它們各打一次 API。
      await env.DB.prepare('DELETE FROM device_tokens WHERE token = ?').bind(dev.token).run();
      continue;   // 不算失敗：這是正常的生命週期，不是故障
    }
    out.failed++;
    if (out.errors.length < MAX_ERRORS) {
      out.errors.push({ userId, error: `APNs ${r.status} ${r.reason}`.trim() });
    }
  }
  return out;
}

/**
 * cron 的一步：三種推播一起跑。
 *
 * **沒設 secret 就安靜地跳過並記成「未設定」，不是失敗。** 把它記成紅色會讓管理頁
 * 天天發假警報，而假綠燈與假紅燈一樣糟——兩者都會讓人不再相信那一頁。
 */
export async function sendPushes(env, nowMs = Date.now()) {
  if (!apnsConfigured(env)) return { skipped: 'APNs 未設定', sent: 0 };

  const today = taipeiYmd(nowMs);
  const yesterday = addDays(today, -1);
  const rows = await env.DB.prepare(
    `SELECT r.user_id, r.digest, r.lead_days, r.streak_current, r.leave_days,
            r.push_overdue, r.push_streak, r.push_today,
            r.push_overdue_ymd, r.push_streak_ymd, r.push_today_ymd,
            u.status
       FROM reminder_feed r JOIN users u ON u.id = r.user_id
      WHERE (r.push_overdue = 1 OR r.push_streak = 1 OR r.push_today = 1)`
  ).all();

  // 跳過的原因分開計數，同 sendOverdueReminders：分不出原因的數字等於沒有記
  const out = { checked: 0, sent: 0, nothingToSay: 0, alreadySent: 0, notApproved: 0, onLeave: 0, failed: 0, errors: [] };

  for (const row of rows.results || []) {
    out.checked++;
    if (row.status !== 'approved') { out.notApproved++; continue; }
    // 今天請假就三種全部不推（C-3），**不是只跳過其中一種**：休假那天要的是安靜，
    // 而震動手機比多一封未讀的信打擾得多。三個 *_ymd 一個都不寫——沒推就不算推過。
    if (isOnLeave(row.leave_days, today)) { out.onLeave++; continue; }

    let digest = [];
    try { digest = JSON.parse(row.digest); } catch { digest = []; }

    // 一個人可能同時符合多種，各自判斷、各自去重
    const jobs = [];

    if (row.push_overdue === 1 && row.push_overdue_ymd !== today) {
      const overdue = pickOverdue(digest, today);
      const upcoming = pickUpcoming(digest, today, row.lead_days == null ? DEFAULT_LEAD_DAYS : row.lead_days);
      // **沒有逾期、也沒有即將到期就完全不推。** 每天一則「你今天沒事」會震動手機，
      // 而那會訓練人把這個 app 的通知整個關掉，然後真的有事時什麼都收不到。
      if (overdue.length || upcoming.length) {
        jobs.push({
          kind: 'overdue', col: 'push_overdue_ymd',
          title: overdue.length ? `有 ${overdue.length} 件事逾期了` : '接下來有事要做',
          body: pushBody(overdue.length ? overdue : upcoming),
        });
      }
    }

    if (row.push_streak === 1 && row.push_streak_ymd !== today) {
      const day = dayReport(digest, yesterday);
      const days = Number(row.streak_current) || 0;
      // 與 email 版同一組條件：斷了、而且連續至少兩天。門檻不一樣的話會出現
      // 「信說斷了、推播沒推」這種自己打自己的狀況。
      if (day.broken && days >= MIN_STREAK_FOR_PUSH) {
        jobs.push({
          kind: 'streak', col: 'push_streak_ymd',
          title: '🌱 我在等你回來',
          body: `我們一起走了 ${days} 天，昨天斷掉了。今天回來看看好嗎？`,
        });
      }
    }

    if (row.push_today === 1 && row.push_today_ymd !== today) {
      const todayRows = digest.filter(r => r && r.d === today && !r.done);
      // N = 0 就不推，同上
      if (todayRows.length) {
        jobs.push({
          kind: 'today', col: 'push_today_ymd',
          title: `今天有 ${todayRows.length} 件事`,
          body: pushBody(todayRows),
        });
      }
    }

    if (!jobs.length) { out.nothingToSay++; continue; }

    for (const job of jobs) {
      const r = await sendToUser(env, row.user_id, job.kind, job.title, job.body);
      out.sent += r.sent;
      out.failed += r.failed;
      for (const e of r.errors) if (out.errors.length < MAX_ERRORS) out.errors.push(e);
      // **送失敗刻意不寫那個欄位**：沒送成功就不算推過，下一次排程要能補。
      // 同逾期提醒的 last_sent_ymd。
      if (r.sent > 0) {
        await env.DB.prepare(`UPDATE reminder_feed SET ${job.col} = ? WHERE user_id = ?`)
          .bind(today, row.user_id).run();
      }
    }
  }
  return out;
}

/**
 * 通知內容只點名前兩件。**鎖定畫面是別人也看得到的地方**，所以不放日期以外的細節，
 * 也不把整份清單攤開。
 */
function pushBody(rows) {
  const names = rows.slice(0, 2).map(r => `〈${r.t}〉`);
  const rest = rows.length - names.length;
  return rest > 0 ? `${names.join('、')}，還有 ${rest} 件` : names.join('、');
}

/**
 * POST /api/admin/push-test  （管理者）
 *
 * **設定完當天就要能證明它通不通**，不必等到隔天早上八點才發現一片安靜。
 * 這是〈看得見的備份才是備份〉在推播上的版本：APNs 的回應原樣回給管理頁，
 * 因為「金鑰不對」與「token 不對」在只有狀態碼時看起來一模一樣。
 */
export async function handlePushTest(env, user) {
  if (!apnsConfigured(env)) {
    return json({ error: 'APNs 還沒設定（需要 APNS_KEY_ID、APNS_TEAM_ID、APNS_P8 三個 secret）' }, 400);
  }
  const rows = await env.DB.prepare(
    'SELECT token, environment FROM device_tokens WHERE user_id = ?'
  ).bind(user.id).all();
  const devices = rows.results || [];
  if (!devices.length) return json({ error: '這個帳號還沒有註冊任何裝置，先在 app 裡打開推播' }, 400);

  const results = [];
  for (const dev of devices) {
    try {
      const r = await apnsSend(env, {
        token: dev.token, environment: dev.environment,
        title: '測試推播', body: '收得到這一則就代表推播設定好了。',
        collapseId: 'test',
      });
      results.push({ environment: dev.environment, status: r.status, reason: r.reason, gone: r.gone });
      if (r.gone) await env.DB.prepare('DELETE FROM device_tokens WHERE token = ?').bind(dev.token).run();
    } catch (e) {
      // 這裡是 HTTP/2 那個風險真的發生時會走到的地方——訊息要原樣回去，
      // 因為它是唯一能分辨「協定被拒」與「金鑰不對」的線索。
      results.push({ environment: dev.environment, status: 0, reason: String(e?.message || e).slice(0, 300), gone: false });
    }
  }
  return json({ ok: true, results });
}
