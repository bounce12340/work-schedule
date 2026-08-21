/**
 * 破窗鎚：直接對 D1 重設某個帳號的密碼。
 *
 * 什麼時候用
 * ---------------------------------------------------------------------------
 * 正常情況請走 `/login` 的「忘記密碼」（自助、不需要任何後台權限），或 `/admin`
 * 的「重設密碼」（管理者代為處理）。這支是**那兩條都走不通**時才用的：
 *
 *   - AgentMail 掛了、或 AGENTMAIL_* 設定錯了，信根本寄不出去
 *   - 使用者的信箱本身進不去了
 *   - 系統裡一個管理者都沒有（全部被停用、或第一個帳號還沒建立）
 *
 * 也就是說，它存在的意義是「連寄信這條路都斷了」的那一天。因此它刻意**不經過
 * Worker**——Worker 壞掉時它仍然要能用。
 *
 * 它比原本的繞路安全在哪
 * ---------------------------------------------------------------------------
 * 在這支之前，名單內帳號的唯一救法是：去 Cloudflare 把那個 email 從 ADMIN_EMAILS
 * 拿掉 → 回 /admin 按重設 → **再加回去**。最後那一步一旦忘記，那個帳號就永遠
 * 失去「不能被其他管理者接管」的保護，而畫面上完全看不出來。
 *
 * 這支不碰 ADMIN_EMAILS，所以沒有那個地雷。
 *
 * 用法
 * ---------------------------------------------------------------------------
 *     node tools/reset-password.mjs someone@example.com --yes
 *     node tools/reset-password.mjs someone@example.com --yes --local   # 本機 D1
 *
 * 需要 wrangler 已登入（`npx wrangler login`）。--yes 是刻意的：這支會立刻改掉
 * 別人的密碼並把他所有裝置登出，不該因為打錯一個指令就發生。
 */
import { spawnSync } from 'node:child_process';
import { hashPassword, generateToken } from '../src/crypto.js';

/**
 * SQL 字串常值的跳脫。雜湊是 base64（可能含 + / = $），email 來自命令列。
 * 單引號是 SQL 字串裡唯一需要處理的字元，重複一次即為跳脫。
 *
 * wrangler d1 execute 只收 --command，沒有參數化介面，所以只能自己組字串——
 * 因此把它抽成純函式並且有測試，而不是在指令中間硬拼。
 */
export function sqlQuote(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * 兩句話：換掉密碼、清掉所有 session。
 *
 * 清 session 不是順手做的：重設密碼的前提就是「這個帳號可能已經不安全」，
 * 留著任何一個舊 session 等於重設完了對方還在裡面。與 handlers 的行為一致。
 */
export function buildSql(email, hash) {
  return [
    `UPDATE users SET password_hash = ${sqlQuote(hash)} WHERE email = ${sqlQuote(email)};`,
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${sqlQuote(email)});`,
  ].join(' ');
}

/** 直接執行時才跑；被測試 import 時不會動到任何東西 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const email = args.find(a => !a.startsWith('--'));
  const yes = args.includes('--yes');
  const local = args.includes('--local');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('用法：node tools/reset-password.mjs <email> --yes [--local]');
    process.exit(2);
  }
  if (!yes) {
    console.error(`這會立刻改掉 ${email} 的密碼，並把他所有裝置登出。`);
    console.error('確定的話請加上 --yes。');
    process.exit(2);
  }

  // 與 handlers/admin.js 的 handleResetPassword 相同的產生方式：12 碼、去掉易混淆字元
  const tempPassword = generateToken().replace(/[-_]/g, '').slice(0, 12);
  const sql = buildSql(email, await hashPassword(tempPassword));

  const r = spawnSync('npx', [
    'wrangler', 'd1', 'execute', 'work-schedule-db',
    local ? '--local' : '--remote', '--command', sql,
  ], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

  if (r.status !== 0) {
    console.error('\n✗ wrangler 執行失敗。請確認已經 npx wrangler login。');
    process.exit(1);
  }

  // 改到 0 列代表那個 email 根本不存在——沒有這個檢查的話，打錯 email 會安靜地
  // 什麼都沒發生，而畫面上看起來完全成功，然後拿著一組永遠登不進去的密碼去問人
  const changed = /"changes"\s*:\s*(\d+)/.exec(r.stdout || '');
  if (changed && Number(changed[1]) === 0) {
    console.error(`\n✗ 沒有任何一列被改到——${email} 這個帳號不存在？`);
    process.exit(1);
  }

  console.log(`\n✓ ${email} 的密碼已重設，所有裝置已登出`);
  console.log(`\n  臨時密碼：${tempPassword}\n`);
  console.log('請透過既有的聯絡管道轉交，並提醒對方登入後立即到「變更密碼」改掉。');
}
