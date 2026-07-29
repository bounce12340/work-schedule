/**
 * 工作排程確認系統 — Worker 入口
 *
 * 路由規則：
 *   /api/*  → 由此 Worker 處理
 *   其他     → 交給靜態資產（public/），根路徑即 index.html
 *
 * 靜態資產在 Workers 預設優先於 Worker script 服務，因此 /api/* 這種
 * 不存在於 public/ 的路徑才會落到這裡，不需要 run_worker_first。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  }
};
