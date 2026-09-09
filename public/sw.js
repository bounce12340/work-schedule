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
 *
 * **這件事實際上被忘記過。** 新皮膚（#25）與前置作業／「不在」（#26）兩次上線
 * 都沒有動這個版本號，使用者回報「為何我沒看到任何改動」——部署是成功的
 * （GET / 回 302、版本 ID 換了），只是他的瀏覽器端出舊的那一份。
 *
 * 導覽走 network-first 本來就該擋住這件事，但**下面那條「其餘靜態資源快取優先」
 * 會端出舊的 index.html**：`req.mode === 'navigate'` 不是每次開啟頁面都成立
 * （PWA 的某些啟動路徑、iOS 的返回上一頁、預抓）。少了版本號的話，舊的那一份
 * 沒有任何時機會被清掉。
 */
const CACHE = 'work-schedule-v3';

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

  // HTML 一律不走快取優先。導覽請求上面已經處理掉，能走到這裡的是
  // 「不是導覽、但要的是一份 HTML」——PWA 的啟動、返回上一頁、預抓都可能是
  // 這個形狀，而快取優先在這裡的後果正是「部署了但使用者看不到」。
  // 網路失敗才回頭找快取，離線仍然打得開。
  if (req.destination === 'document' || url.pathname === '/' || url.pathname.endsWith('.html')) {
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

  // 其餘靜態資源（圖示、manifest）：快取優先，但背景更新，下次載入就會是新版
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
