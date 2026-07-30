/**
 * 密碼雜湊與 token 工具。
 *
 * 用 Web Crypto 的 PBKDF2：Workers 原生支援，不需要 WASM。
 * 格式 pbkdf2$<iterations>$<salt_b64>$<hash_b64> 把迭代次數存進去，
 * 日後調高迭代次數時舊密碼仍能驗證，不必強迫所有人重設。
 *
 * 迭代次數卡在 100,000，因為那是 Workers 正式環境的硬上限，超過會直接丟：
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported
 *
 * 而且**本機 workerd 不強制這條**。曾經照 OWASP 建議設成 210,000，本機從註冊到
 * 登入一路正常，線上卻每次都回 Error 1101——雜湊還沒開始算就丟例外，所以 CPU
 * 只燒 3～5ms、DB 一筆都沒寫進去，看起來完全不像雜湊出問題。要再往上調之前，
 * 先確認平台是否放寬了上限，不要只看本機測得過。
 */

const MAX_ITERATIONS = 100000;   // 平台硬上限，不是我們自己選的
const ITERATIONS = MAX_ITERATIONS;
const KEY_BITS = 256;

function toB64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS
  );
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  // 本機不受上限限制，因此可能產生線上重算不了的雜湊。放著讓 deriveBits 丟例外
  // 會變成 500，看起來像伺服器壞掉；當成驗證失敗並留下日誌才對得上實際情況。
  if (iterations > MAX_ITERATIONS) {
    console.warn(`stored hash uses ${iterations} iterations, above the platform cap ${MAX_ITERATIONS}`);
    return false;
  }

  let expected;
  try { expected = fromB64(parts[3]); } catch { return false; }

  const bits = new Uint8Array(await pbkdf2(password, fromB64(parts[2]), iterations));
  return timingSafeEqual(bits, expected);
}

/**
 * 逐位元組 XOR 後累加，執行時間不隨「第幾個位元組開始不同」而變化。
 * 直接用 === 比較字串會提早回傳，洩漏出正確前綴的長度。
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** session token 原文：交給瀏覽器，DB 只留它的雜湊 */
export function generateToken() {
  return toB64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toB64(digest);
}

export function uuid() {
  return crypto.randomUUID();
}
