import { jwtVerify, createRemoteJWKSet } from 'jose';

/**
 * 驗證 Cloudflare Access 加在請求上的 JWT，回傳使用者 email。
 *
 * Access 會在邊緣擋掉未登入的請求，但 Worker 仍必須自行驗證這個 header：
 * 若有人繞過 Access 直接打到 Worker 的 origin，沒驗證就等於完全沒有保護。
 *
 * @returns {Promise<{email: string} | {error: string, status: number}>}
 */
let jwksCache = null;

export async function authenticate(request, env) {
  // 未設定 Access 時的單人模式：僅允許本機開發，正式環境一律要求設定
  if (!env.POLICY_AUD || !env.TEAM_DOMAIN) {
    if (env.ALLOW_UNAUTHENTICATED === 'true') {
      return { email: 'local-dev@localhost' };
    }
    return { error: 'Server not configured for authentication', status: 500 };
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) {
    return { error: 'Missing Cloudflare Access token', status: 403 };
  }

  try {
    // createRemoteJWKSet 內部自帶快取，但每次呼叫會建立新的抓取狀態，
    // 因此在模組層級重用同一個實例
    if (!jwksCache) {
      jwksCache = createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`));
    }
    const { payload } = await jwtVerify(token, jwksCache, {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD
    });
    const email = payload.email;
    if (!email) {
      return { error: 'Token has no email claim', status: 403 };
    }
    return { email };
  } catch (err) {
    return { error: `Invalid token: ${err.message}`, status: 403 };
  }
}
