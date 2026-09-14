/**
 * 給測試用的「假 Apple」：自己產一組 EC 金鑰、自簽一個根、簽出憑證鏈，再用 leaf
 * 簽出一段形狀與 AppTransaction 相同的 JWS。
 *
 * 為什麼不用 openssl 指令：測試零相依是專案前提，而且 Windows 上不一定有 openssl。
 * Node 內建的 WebCrypto 能產金鑰、簽章、匯出 SPKI，缺的只有「把這些包成 X.509」
 * 那一層 DER 編碼——需要的欄位很少，自己寫比引進套件便宜。
 *
 * 這裡的編碼器只夠用來**產測試資料**，不是通用的 X.509 產生器。
 */

const enc = new TextEncoder();

// ---- DER 編碼 ---------------------------------------------------------------

function derLen(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag, content) {
  const c = content instanceof Uint8Array ? content : new Uint8Array(content);
  return new Uint8Array([tag, ...derLen(c.length), ...c]);
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const SEQ = c => tlv(0x30, concat(...c));
const SET = c => tlv(0x31, concat(...c));

function INT(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.slice(1);
  if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
  return tlv(0x02, b);
}

function OID(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const v of parts.slice(2)) {
    const stack = [v & 0x7f];
    let x = Math.floor(v / 128);
    while (x > 0) { stack.unshift((x & 0x7f) | 0x80); x = Math.floor(x / 128); }
    out.push(...stack);
  }
  return tlv(0x06, out);
}

function UTF8(s) { return tlv(0x0c, enc.encode(s)); }

function utcTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  const s = `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
            `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, enc.encode(s));
}

function name(cn) {
  return SEQ([SET([SEQ([OID('2.5.4.3'), UTF8(cn)])])]);
}

const ECDSA_SHA256 = SEQ([OID('1.2.840.10045.4.3.2')]);

/** WebCrypto 的 r||s → X.509 用的 DER SEQUENCE { r, s } */
function rawSigToDer(raw) {
  const half = raw.length / 2;
  return SEQ([INT(raw.slice(0, half)), INT(raw.slice(half))]);
}

// ---- 憑證與金鑰 ---------------------------------------------------------------

async function genKey() {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

/**
 * 簽一張憑證：subject 的公鑰，由 issuerKey 簽。
 * @returns {Promise<Uint8Array>} DER
 */
async function makeCert({ subjectCn, subjectPub, issuerCn, issuerKey, serial, notBefore, notAfter }) {
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', subjectPub));
  const tbs = SEQ([
    tlv(0xa0, INT([2])),          // [0] version v3
    INT([serial]),
    ECDSA_SHA256,
    name(issuerCn),
    SEQ([utcTime(notBefore), utcTime(notAfter)]),
    name(subjectCn),
    spki,
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, issuerKey, tbs));
  return SEQ([tbs, ECDSA_SHA256, tlv(0x03, concat(new Uint8Array([0]), rawSigToDer(sig)))]);
}

function b64(bytes) { return Buffer.from(bytes).toString('base64'); }
function b64url(bytes) { return Buffer.from(bytes).toString('base64url'); }

/**
 * 產一條鏈（根 → 中繼 → leaf）與簽 JWS 的能力。
 *
 * @param {object} [opts]
 * @param {number} [opts.now]  憑證有效期以此為中心（前後各一年）
 */
export async function makeFakeApple({ now = Date.now() } = {}) {
  const root = await genKey();
  const inter = await genKey();
  const leaf = await genKey();
  const notBefore = now - 365 * 86400_000;
  const notAfter = now + 365 * 86400_000;

  const rootDer = await makeCert({ subjectCn: 'Fake Root', subjectPub: root.publicKey, issuerCn: 'Fake Root', issuerKey: root.privateKey, serial: 1, notBefore, notAfter });
  const interDer = await makeCert({ subjectCn: 'Fake Intermediate', subjectPub: inter.publicKey, issuerCn: 'Fake Root', issuerKey: root.privateKey, serial: 2, notBefore, notAfter });
  const leafDer = await makeCert({ subjectCn: 'Fake Leaf', subjectPub: leaf.publicKey, issuerCn: 'Fake Intermediate', issuerKey: inter.privateKey, serial: 3, notBefore, notAfter });

  /**
   * 簽一段 AppTransaction 形狀的 JWS。
   * @param {object} payload  會與預設欄位合併
   * @param {object} [o]
   * @param {Uint8Array[]} [o.chain]  自訂 x5c（測「鏈接不到根」用）
   * @param {CryptoKey} [o.signer]    自訂簽章金鑰（測「簽章不對」用）
   */
  async function signJws(payload, { chain = [leafDer, interDer, rootDer], signer = leaf.privateKey } = {}) {
    const header = { alg: 'ES256', x5c: chain.map(b64) };
    const body = {
      bundleId: 'com.bounceto.workschedule',
      appTransactionId: '100000000000001',
      originalPurchaseDate: now - 86400_000,
      receiptType: 'Production',
      ...payload,
    };
    const h = b64url(enc.encode(JSON.stringify(header)));
    const p = b64url(enc.encode(JSON.stringify(body)));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, enc.encode(`${h}.${p}`)));
    return `${h}.${p}.${b64url(sig)}`;
  }

  return { rootDer, interDer, leafDer, signJws, keys: { root, inter, leaf } };
}
