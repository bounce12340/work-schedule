/**
 * Service worker：讓應用可以加到主畫面、並在離線時仍打得開。
 *
 * 三條規則，其中第一條是安全性而非效能考量：
 *
 * 1. **`/api/*` 一律不快取。** 那裡面是使用者資料與登入狀態。快取住的話，
 *    登出後或換人登入時，前一位使用者的排程會從快取被端出來——那是資料外洩，
 *    不是「比較快」。連 `cache.put` 都不要碰，直接交給網路。
 *
 * 2. **導覽請求走 network-first。** 快取優先會讓部署後的新版本要等到下次
 *    清快取才生效，使用者會回報「改的東西沒有上線」。網路失敗時才用快取，
 *    離線仍能打開。
 *
 * 3. **只快取 200 且非重新導向的同源 GET。** `/` 在未登入時會 302 到
 *    `/login`，把那個回應存起來就會變成「永遠被導向登入頁」的假象。
 *
 * 改版時把 CACHE 的版本號往上加，activate 會自動清掉舊的。
 */
const CACHE = 'work-schedule-v1';

// 這幾個不需要登入就取得，install 階段預先抓下來
const PRECACHE = [
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // 個別失敗不該讓整個安裝失敗（例如某個圖示暫時取不到）
      .then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

function cacheable(response) {
  return response && response.status === 200 && !response.redirected && response.type === 'basic';
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 字型等跨網域資源交給瀏覽器自己處理
  if (url.pathname.startsWith('/api/')) return;         // 規則 1

  // 規則 2：導覽（開啟頁面）走 network-first
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
    );
    return;
  }

  // 其餘靜態資源：快取優先，但背景更新，下次載入就會是新版
  event.respondWith(
    caches.match(req).then(hit => {
      const network = fetch(req).then(res => {
        if (cacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
});
