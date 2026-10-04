/**
 * 讓瀏覽器驗證腳本過得了登入閘門。
 *
 * index.html 現在「沒登入就不能用」：後端不存在（tools/ 底下的靜態伺服器對 /api/* 一律
 * 回 404）而且這台裝置從來沒登入過，畫面會是全螢幕的「請登入」，什麼都點不到。
 * 「登入過」的證據是 cloudMeta 裡有 owner——寫上去之後，index.html 走的是「登入過、
 * 現在後端不在」那條路：本機資料、沒有同步，正是這些工具原本就在測的形狀。
 *
 * 不要在 index.html 裡加任何「測試模式」的開關來繞閘門：產品程式碼不該知道測試的存在。
 * 一定要在 page.goto 之前呼叫（addInitScript 只對之後的導覽生效）。
 */
export async function markSignedIn(page, owner = 'demo@example.test', { boot = false } = {}) {
  await page.addInitScript(o => {
    try {
      if (!localStorage.getItem('workSchedule.v1.cloudMeta')) {
        localStorage.setItem('workSchedule.v1.cloudMeta', JSON.stringify({ owner: o }));
      }
    } catch (e) { /* 記憶體模式下略過 */ }
  }, owner);
  if (!boot) await skipBootScene(page);
}

/**
 * 把開機的載入畫面拿掉（2026-10-03 起它是 3 秒、會吃點擊的一層，見 index.html 的
 * .boot-sakura）。這些工具要驗的是底下的 app，每一次載入都等 3 秒只是在燒時間，
 * 而 elementFromPoint 這類量法會直接量到那一層。
 *
 * **從外面注入樣式，不在 index.html 加任何測試開關**——同上面那條「產品程式碼不該知道
 * 測試的存在」。載入畫面本身由 check-ambience.mjs 負責（它呼叫時帶 `{ boot: true }`），
 * smoke.mjs 不經過這支 helper，所以它走的是真的載入畫面。
 */
export async function skipBootScene(page) {
  await page.addInitScript(() => {
    const add = () => {
      const st = document.createElement('style');
      st.textContent = '#bootSakura{display:none!important}';
      (document.head || document.documentElement).appendChild(st);
    };
    if (document.documentElement) add();
    else new MutationObserver((m, ob) => { if (document.documentElement) { add(); ob.disconnect(); } })
      .observe(document, { childList: true });
  });
}
