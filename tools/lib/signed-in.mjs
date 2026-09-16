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
export async function markSignedIn(page, owner = 'demo@example.test') {
  await page.addInitScript(o => {
    try {
      if (!localStorage.getItem('workSchedule.v1.cloudMeta')) {
        localStorage.setItem('workSchedule.v1.cloudMeta', JSON.stringify({ owner: o }));
      }
    } catch (e) { /* 記憶體模式下略過 */ }
  }, owner);
}
