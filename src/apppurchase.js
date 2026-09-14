/**
 * App Store 購買證明（StoreKit 2 的 AppTransaction）的離線驗證。
 *
 * app 是**付費下載**：錢在 App Store 那一刻就收完了，後端唯一要回答的問題是
 * 「這個帳號的主人真的買了 app 嗎」。iOS 16 起 StoreKit 會給 app 一段 Apple 簽過
 * 名的 JWS（`AppTransaction.shared.jwsRepresentation`），裡面有 bundleId、環境、
 * 一個代表這次購買的 appTransactionId。app 註冊時把它附上來，這裡驗。
 *
 * 為什麼離線驗、不打 Apple 的 API
 * ---------------------------------------------------------------------------
 * JWS 的 header 帶著完整的憑證鏈（x5c：leaf → 中繼 → 根），根必須是 Apple Root
 * CA - G3。只要根憑證內建在這裡、鏈上每一段簽章都對、JWS 本體用 leaf 的公鑰驗
 * 得過，就能確定這段資料是 Apple 簽出來的——不需要網路、不需要 App Store Connect
 * 的金鑰、不會因為 Apple 那邊的 API 限流而讓註冊失敗。
 *
 * 為什麼可以注入根憑證
 * ---------------------------------------------------------------------------
 * 正式路徑永遠用內建的 Apple 根。`trustedRootDer` 這個參數只給測試用：測試自己
 * 產一組 EC 金鑰與自簽根、簽出 JWS，才能驗「正確通過、改一個 byte 失敗、bundleId
 * 不對失敗、Sandbox 未放行失敗」。沒有這個口，這個模組就只能在正式環境靠真的
 * Apple 簽章驗，而那等於沒有測試。
 *
 * 不做的事：不檢查憑證的 CRL／OCSP（Workers 裡沒有合理的作法，而且 Apple 的這
 * 條鏈不是為了給第三方線上驗的）；不檢查 leaf 的 extendedKeyUsage（Apple 沒有
 * 公開這條鏈的 OID 約定，寫死一個猜的值只會在 Apple 換憑證時把所有註冊擋掉）。
 */

/** Apple Root CA - G3（DER，base64）。取自 https://www.apple.com/certificateauthority/AppleRootCA-G3.cer */
const APPLE_ROOT_CA_G3_B64 =
  'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==';

const ROOT_DER = b64ToBytes(APPLE_ROOT_CA_G3_B64);

/** 鏈上允許的簽章演算法 OID → WebCrypto 的雜湊名 */
const SIG_ALG = {
  '1.2.840.10045.4.3.2': 'SHA-256',   // ecdsa-with-SHA256
  '1.2.840.10045.4.3.3': 'SHA-384',   // ecdsa-with-SHA384
  '1.2.840.10045.4.3.4': 'SHA-512',   // ecdsa-with-SHA512
};

/** SPKI 內的曲線 OID → WebCrypto namedCurve */
const CURVE = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

/**
 * @param {string} jws            AppTransaction 的 jwsRepresentation
 * @param {object} opts
 * @param {string} opts.bundleId  期望的 Bundle ID
 * @param {boolean} [opts.allowSandbox]  TestFlight／Xcode 環境放不放行
 * @param {Uint8Array} [opts.trustedRootDer]  只給測試注入；正式路徑不傳
 * @param {number} [opts.nowMs]
 * @returns {Promise<{ok:true, appTransactionId:string, originalPurchaseDate:number|null, environment:string}
 *                  |{ok:false, reason:'format'|'chain'|'signature'|'bundle'|'environment'|'expired'}>}
 */
export async function verifyAppTransaction(jws, opts) {
  const root = opts.trustedRootDer || ROOT_DER;
  const now = opts.nowMs ?? Date.now();

  let header, payload, signingInput, signature;
  try {
    const parts = String(jws || '').split('.');
    if (parts.length !== 3) return fail('format');
    header = JSON.parse(utf8(b64urlToBytes(parts[0])));
    payload = JSON.parse(utf8(b64urlToBytes(parts[1])));
    signingInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    signature = b64urlToBytes(parts[2]);
  } catch {
    return fail('format');
  }

  if (header.alg !== 'ES256') return fail('format');
  if (!Array.isArray(header.x5c) || header.x5c.length < 1) return fail('format');

  // 憑證鏈：x5c[0] 是簽 JWS 的 leaf，後面每一張簽前一張，最後一張必須就是我們信任的根。
  let certs;
  try {
    certs = header.x5c.map(b64 => parseCert(b64ToBytes(b64)));
  } catch {
    return fail('format');
  }
  const last = certs[certs.length - 1];
  if (!bytesEqual(last.der, root)) return fail('chain');

  for (let i = 0; i < certs.length - 1; i++) {
    const cert = certs[i];
    const issuer = certs[i + 1];
    if (cert.notBefore > now || cert.notAfter < now) return fail('expired');
    const hash = SIG_ALG[cert.sigAlgOid];
    if (!hash) return fail('chain');
    let ok = false;
    try {
      const key = await importSpki(issuer.spki, issuer.curveOid);
      ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash }, key,
        derSigToRaw(cert.signature, issuer.curveOid), cert.tbs
      );
    } catch {
      ok = false;
    }
    if (!ok) return fail('chain');
  }

  // JWS 本體：ES256，簽章是 JWS 格式的 r||s（不是 DER），直接餵給 WebCrypto。
  let sigOk = false;
  try {
    const leafKey = await importSpki(certs[0].spki, certs[0].curveOid);
    sigOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, leafKey, signature, signingInput);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail('signature');

  if (payload.bundleId !== opts.bundleId) return fail('bundle');

  // AppTransaction 用 receiptType 表達環境（Production / Sandbox / Xcode）；
  // 其他 App Store JWS 用 environment。兩個都看，哪個有就用哪個。
  const environment = String(payload.receiptType || payload.environment || '');
  if (environment !== 'Production' && !(opts.allowSandbox && (environment === 'Sandbox' || environment === 'Xcode'))) {
    return fail('environment');
  }

  const appTransactionId = String(payload.appTransactionId || '');
  if (!appTransactionId) return fail('format');

  return {
    ok: true,
    appTransactionId,
    originalPurchaseDate: Number.isFinite(payload.originalPurchaseDate) ? payload.originalPurchaseDate : null,
    environment,
  };
}

function fail(reason) { return { ok: false, reason }; }

// ---------------------------------------------------------------------------
// 最小的 DER 解析：只讀 X.509 裡驗鏈需要的欄位。
// ---------------------------------------------------------------------------

/**
 * 解析一張 DER 憑證，回傳驗鏈要用的部分。
 *
 *   Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 *   TBSCertificate ::= SEQUENCE { [0] version, serialNumber, signature, issuer,
 *                                  validity, subject, subjectPublicKeyInfo, ... }
 */
export function parseCert(der) {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error('cert: not a SEQUENCE');
  const tbs = readTlv(der, cert.start);
  const sigAlg = readTlv(der, tbs.end);
  const sigVal = readTlv(der, sigAlg.end);
  if (sigVal.tag !== 0x03) throw new Error('cert: signature not BIT STRING');

  // TBS 內部
  let p = tbs.start;
  let t = readTlv(der, p);
  if (t.tag === 0xa0) { p = t.end; t = readTlv(der, p); }   // [0] version（選填）
  // t = serialNumber
  const tbsSigAlg = readTlv(der, t.end);
  const issuer = readTlv(der, tbsSigAlg.end);
  const validity = readTlv(der, issuer.end);
  const subject = readTlv(der, validity.end);
  const spki = readTlv(der, subject.end);

  const nb = readTlv(der, validity.start);
  const na = readTlv(der, nb.end);

  // SPKI ::= SEQUENCE { algorithm AlgorithmIdentifier, subjectPublicKey BIT STRING }
  const algId = readTlv(der, spki.start);
  const algOid = readTlv(der, algId.start);
  const curve = readTlv(der, algOid.end);

  return {
    der,
    tbs: der.slice(tbs.outerStart, tbs.end),
    sigAlgOid: oidToString(der.slice(readTlv(der, sigAlg.start).start, readTlv(der, sigAlg.start).end)),
    signature: der.slice(sigVal.start + 1, sigVal.end),   // 跳過 BIT STRING 的 unused-bits byte
    spki: der.slice(spki.outerStart, spki.end),
    curveOid: curve.tag === 0x06 ? oidToString(der.slice(curve.start, curve.end)) : null,
    notBefore: parseTime(der, nb),
    notAfter: parseTime(der, na),
  };
}

/** 讀一個 TLV，回傳 { tag, outerStart, start, end }（start/end 是內容的範圍） */
function readTlv(buf, pos) {
  if (pos >= buf.length) throw new Error('der: out of range');
  const tag = buf[pos];
  let p = pos + 1;
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('der: bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p++];
  }
  const start = p;
  const end = start + len;
  if (end > buf.length) throw new Error('der: truncated');
  return { tag, outerStart: pos, start, end };
}

function oidToString(bytes) {
  const out = [];
  let first = bytes[0];
  out.push(Math.floor(first / 40), first % 40);
  let v = 0;
  for (let i = 1; i < bytes.length; i++) {
    v = (v * 128) + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) { out.push(v); v = 0; }
  }
  return out.join('.');
}

/** UTCTime（YYMMDDHHMMSSZ）或 GeneralizedTime（YYYYMMDDHHMMSSZ）→ ms */
function parseTime(der, tlv) {
  const s = utf8(der.slice(tlv.start, tlv.end));
  let year, rest;
  if (tlv.tag === 0x17) {            // UTCTime
    const yy = Number(s.slice(0, 2));
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
    rest = s.slice(2);
  } else if (tlv.tag === 0x18) {     // GeneralizedTime
    year = Number(s.slice(0, 4));
    rest = s.slice(4);
  } else {
    throw new Error('der: bad time tag');
  }
  const mo = Number(rest.slice(0, 2)), d = Number(rest.slice(2, 4));
  const h = Number(rest.slice(4, 6)), mi = Number(rest.slice(6, 8)), se = Number(rest.slice(8, 10));
  return Date.UTC(year, mo - 1, d, h, mi, se);
}

async function importSpki(spki, curveOid) {
  const namedCurve = CURVE[curveOid];
  if (!namedCurve) throw new Error('unsupported curve ' + curveOid);
  return crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve }, false, ['verify']);
}

/**
 * X.509 裡的 ECDSA 簽章是 DER 的 SEQUENCE { r INTEGER, s INTEGER }；WebCrypto 要
 * 固定長度的 r||s。INTEGER 可能多一個 0x00 前導、也可能比曲線短，這裡兩種都補齊。
 */
export function derSigToRaw(sig, curveOid) {
  const size = curveOid === '1.3.132.0.34' ? 48 : curveOid === '1.3.132.0.35' ? 66 : 32;
  const seq = readTlv(sig, 0);
  const r = readTlv(sig, seq.start);
  const s = readTlv(sig, r.end);
  const out = new Uint8Array(size * 2);
  out.set(fixInt(sig.slice(r.start, r.end), size), 0);
  out.set(fixInt(sig.slice(s.start, s.end), size), size);
  return out;
}

function fixInt(bytes, size) {
  let b = bytes;
  while (b.length > size && b[0] === 0) b = b.slice(1);
  if (b.length > size) throw new Error('der: integer too long');
  const out = new Uint8Array(size);
  out.set(b, size - b.length);
  return out;
}

// ---------------------------------------------------------------------------
// bytes 小工具
// ---------------------------------------------------------------------------

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  return b64ToBytes(b64);
}

function utf8(bytes) { return new TextDecoder().decode(bytes); }

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
