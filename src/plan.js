/**
 * 方案（free / pro）與上限。設計文件：docs/superpowers/specs/2026-09-16-subscription-design.md
 *
 * 「這個帳號是不是 Pro」只看 users 表上的兩個欄位（plan_source、plan_expires_at），
 * 不在請求當下問 Apple——同購買證明的離線驗簽：沒有網路依賴、沒有限流、沒有另一把金鑰。
 *
 * PLAN_LIMITS 在 public/index.html 有一份形狀相同的副本（前端用來擋「新增」按鈕）；
 * tests/plan.test.mjs 逐字比對兩邊，改這裡一定要改那裡。
 */
export const PLAN_LIMITS = {
  free: { majorProjects: 3, ganttProjects: 3, aiPerDay: 5 },
  pro:  { majorProjects: Infinity, ganttProjects: Infinity, aiPerDay: 20 },
};

/**
 * 到期後的寬限：Apple 續訂失敗有 billing retry，那幾天 Apple 那邊仍算訂閱中。
 * 沒有這段的話，信用卡過期當天使用者就被降級，而 Apple 自己還在幫他重試。
 */
export const GRACE_MS = 3 * 24 * 3600 * 1000;

/**
 * 判斷方案。接受 session 的 camelCase（planSource / planExpiresAt）與 D1 列的
 * snake_case（plan_source / plan_expires_at），因為兩種形狀都會走到這裡：前者是
 * 請求裡的 user，後者是管理頁列出全部帳號時的每一列。
 *
 *   plan_source 為空                → free
 *   有 source、到期日為空            → pro（永久：既有的兩個帳號，由管理者設定）
 *   有 source、到期日 + 寬限 > 現在  → pro
 *   否則                            → free（降級：資料一個都不刪，只是不能再新增）
 */
export function planOf(user, nowMs = Date.now()) {
  if (!user) return 'free';
  const source = user.planSource ?? user.plan_source ?? null;
  const expiresAt = user.planExpiresAt ?? user.plan_expires_at ?? null;
  if (!source) return 'free';
  if (expiresAt == null) return 'pro';
  return expiresAt + GRACE_MS > nowMs ? 'pro' : 'free';
}

/** 給前端與管理頁的公開形狀：不含任何 Apple 交易 id。 */
export function planInfo(user, nowMs = Date.now()) {
  return {
    plan: planOf(user, nowMs),
    planSource: user?.planSource ?? user?.plan_source ?? null,
    planExpiresAt: user?.planExpiresAt ?? user?.plan_expires_at ?? null,
  };
}

/** 兩種「專案」各算各的（使用者的裁決：兩種各 3 個）。缺陣列當 0。 */
export function countProjects(state) {
  const len = v => (Array.isArray(v) ? v.length : 0);
  return {
    majorProjects: len(state?.majorProjects),
    ganttProjects: len(state?.ganttProjects),
  };
}

/** 這份 state 有哪些種類超過方案上限（不看變化，只看數量）。 */
export function capViolations(state, plan) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const counts = countProjects(state);
  return Object.keys(counts)
    .filter(k => counts[k] > limits[k])
    .map(k => ({ kind: k, count: counts[k], limit: limits[k] }));
}

/**
 * 該不該擋這次寫入。規則不是「數量 ≤ 上限」，而是
 *
 *     新的數量 ≤ max(上限, 舊的數量)
 *
 * 只有**變多而且超過上限**才擋。Pro 到期變回 free 的人可能有 10 個專案，一個都不刪、
 * 一個都不鎖：全部照常看、照常改、照常勾，只是不能再新增。把人的資料變不見是最壞的事，
 * 付費與否都一樣。
 *
 * 回 null（放行）或第一個超過的 { kind, count, limit }。
 */
export function exceedsPlanCap(oldState, newState, plan) {
  const violations = capViolations(newState, plan);
  if (!violations.length) return null;
  const before = countProjects(oldState);
  const grew = violations.find(v => v.count > before[v.kind]);
  return grew || null;
}
