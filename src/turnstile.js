const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * 驗證 Turnstile token。
 *
 * 除了 success 之外還必須檢查 hostname：token 是綁在網域上的，不驗 hostname
 * 的話，攻擊者可以在自己掛同一個 sitekey 的頁面上取得 token，再拿來打這裡。
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyTurnstile(token, env, remoteIp) {
  if (!env.TURNSTILE_SECRET) {
    // 未設定金鑰時一律擋下。放行等於整個真人驗證形同虛設。
    return { ok: false, reason: 'turnstile-not-configured' };
  }
  if (!token) return { ok: false, reason: 'missing-token' };

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);

  let data;
  try {
    const res = await fetch(SITEVERIFY, { method: 'POST', body: form });
    data = await res.json();
  } catch (e) {
    return { ok: false, reason: 'siteverify-unreachable' };
  }

  if (!data.success) {
    return { ok: false, reason: (data['error-codes'] || []).join(',') || 'failed' };
  }

  const allowed = allowedHostnames(env);
  if (data.hostname && allowed.length && !allowed.includes(data.hostname)) {
    return { ok: false, reason: 'hostname-mismatch' };
  }
  return { ok: true };
}

function allowedHostnames(env) {
  return String(env.TURNSTILE_HOSTNAMES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}
