# 事故紀錄：iOS app 安靜地變成「單機模式」

- **日期**：2026-09-16（TestFlight build 7）
- **影響**：app 裡所有資料都只留在手機上，完全沒有同步。畫面上沒有任何錯誤，看起來像「還沒登入的正常狀態」
- **狀態**：build 8 仍未解，第二輪修正後待 build 9

---

## 症狀

使用者回報：「為何我手機版的都說目前是單機模式？」附上的截圖裡有兩件事：

1. 看板上是**示範資料**（`客戶提案會議`、`整理個人學習筆記`、`每月部門會議`——這三個名字整份程式裡只出現在 `seed()`）
2. 帳號頁寫著「目前為單機模式，資料只存在這個瀏覽器」，而且**沒有任何紅字**

網頁版同一時間完全正常（`/` 回 302、`/api/state` 未登入回 401、登入後同步正常）。

## 為什麼這個狀態「不可能」——推理過程

app 裡只要 `NATIVE` 為真，打的就是線上網址，`cloudPull()` 只有四種結果，**沒有一種長這樣**：

| 結果 | 畫面 |
|---|---|
| `ok` | 正常同步 |
| `expired`（401） | 清 Keychain、回 app 的登入畫面 |
| `failed` | 紅字「連線失敗，暫時只用本機資料」 |
| `absent`（404） | 安靜變單機 ← 線上真的有 `/api/state`，不可能 |

而且沒有 token 時 `nativeBoot()` 會顯示 app 的登入畫面，使用者也沒看到那個。所以：**啟動流程在叫出登入畫面之前就中斷了**，或者**根本沒進入 app 的那條路**。

## 根因（三個各自獨立、畫面完全相同的洞）

### 1. 「我是不是在 app 裡」只問了一個名字

```js
const NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
```

這是**同一個 bug class 的第二次**。第一次是 `Capacitor.Plugins.WorkScheduleNative`（見〈iOS app〉）：真機上的 `window.Capacitor` 是 WKWebView 注入的 `native-bridge.js`，它給的東西與 `@capacitor/core` 不一樣，而冒煙測試的假物件剛好把那個名字補好了，所以全綠。

`NATIVE` 判錯的後果比插件判錯更大——它不是「少一點功能」，是**整個 app 退回網頁版那條路**：

- `API_BASE` 從線上網址變成空字串 → `/api/state` 打到 app 自己肚子裡 → 必然失敗
- `fetch` 的那層包裝不安裝 → 不帶 Bearer
- `nativeBoot()` 不執行 → 不讀 Keychain、不顯示 app 的登入畫面
- 失敗被 `cloudPull()` 判成 `absent` → **靜默降級**

五個條件串起來，剛好就是截圖上那個畫面。

### 2. `nativeBoot()` 是 fire-and-forget，沒有人接住它

```js
if(NATIVE) nativeBoot(loadedFromStorage);   // ← 沒有 .catch
```

`initCloudSync()` 有 catch（那是〈降級可以，沉默不行〉那條規則的產物），`nativeBoot()` 沒有。async 函式在這種呼叫方式下摔倒只會變成 **unhandledrejection**——它連 `pageerror` 都不算，`tools/smoke.mjs` 原本的錯誤收集器看不到，手機上也沒有 console 可看。結果同樣是：畫面停在示範資料、狀態列一片乾淨。

### 3. `absent` 在 app 裡是謊話

`absent` 這條路是為了**單檔開啟與未部署**而存在的：那兩種情況「沒有後端」是正常且預期的，所以刻意靜默。但 app 裡 `API_BASE` 永遠是線上網址，`/api/state` 一定存在——收到 404 只可能代表有東西壞了。把它當 `absent`，等於親手製造出這條規則要防的那種沉默。

## 修法

| 改動 | 理由 |
|---|---|
| `NATIVE` 改用**五個互相獨立的訊號**（`isNativePlatform`／`getPlatform`／`nativePromise`／`webkit.messageHandlers.bridge`／`capacitor:`｜`ionic:` protocol），任一成立即為真 | 單一名字消失就整個判錯，代價太大。其中兩個是注入的 bridge 一定有的，protocol 連 bridge 都不必載入就成立 |
| `nativeBoot()` 的呼叫加 `.catch`，摔倒時 `console.error` **並寫在畫面上** | unhandledrejection 沒有任何人看得到。〈降級可以，沉默不行〉本來就涵蓋這裡，只是漏了一格 |
| 插件不在時在登入畫面出現前就說出來 | 「登入得了但存不住」是 build 6 的症狀（登入成功 → reload → 又回到登入畫面）。與其讓人重試第三次才懷疑，不如當場講 |
| app 裡的 404 改判 `failed` | 見根因 3 |
| 新增 `nativeDiag()`：protocol、有沒有 Capacitor、哪些訊號成立、插件在不在 | **手機上沒有 console。** 同「拿不到購買證明」附上原因的那個判斷 |
| 登入閘門在「看起來像 app」時多印一行診斷 | 閘門在 app 裡永遠不該出現，真的出現就是偵測全部落空——那時畫面必須自己說得出話 |

### `nativeDiag()` 自己不能爆炸

第一版的 `nativeDiag()` 直接呼叫 `nativePlugin()`。外殼壞到「讀 `Capacitor.nativePromise` 就丟例外」時，它會在 `.catch` 裡**再爆一次**，把自己要傳達的那則訊息一起吞掉，畫面又回到安靜的單機模式。

**會爆炸的診斷函式比沒有診斷更糟**，所以每一格都各自包 try/catch。這是探針 4 實際抓到的（不是想出來的）。

## 為什麼所有既有的檢查都是綠的

- `npm test`（336 個）不碰前端整合
- `node --check`／`check-syntax` 只驗語法
- `tools/smoke.mjs` 的假 `window.Capacitor` **把 `isNativePlatform` 補好了**，所以第一個洞測不到；第二、三個洞的失敗形狀是「畫面少了東西」而不是例外，錯誤收集器也看不到
- Worker、D1、CORS 全部正常——**問題完全在 app 那一側**

## 現在守著它的東西

`tools/smoke.mjs` 第七輪「iOS app 外殼的五個探針」，各塞一個**殘缺的** `window.Capacitor`，每支只驗一件事：

| 探針 | 外殼長什麼樣 | 斷言 |
|---|---|---|
| 1 | 只有 `nativePromise` | 仍要認出自己是 app（app 的登入畫面要蓋上來） |
| 2 | 只有 `isNativePlatform`，插件不在 | 狀態列要出現「app 啟動異常」並附診斷 |
| 3 | 外殼正常、有 token，`/api/state` 回 404 | 要是**紅字**的連線失敗，不是單機模式 |
| 4 | 讀 bridge 就丟例外 | 摔倒要被接住並寫在畫面上 |
| 5 | 外殼與網路都正常，`/api/state` 回 **200 但沒有 `user`** | 帳號頁那一格要印出診斷（見〈第二輪〉） |

刻意**不把第五輪的假 Capacitor 改殘缺**：那一輪要驗的是「正常的 app 走得完」，混在一起哪個壞了都分不出來。

突變驗證（五種改法各自紅一支，而且只紅那一支）：

1. `NATIVE` 退回只問 `isNativePlatform` → 探針 1 紅
2. 拿掉「插件不在就說出來」 → 探針 2 紅
3. 404 一律回 `absent` → 探針 3 紅
4. 拿掉 `nativeBoot(...).catch(...)` → 探針 4 紅
5. 拿掉帳號頁那一格的診斷 → 探針 5 紅

## 第二輪：build 8 上線後症狀仍在，而且**連新加的紅字都沒出現**

修完三個洞、打包成 build 8 之後，畫面還是一樣：單機模式、沒有紅字、沒有 app 的登入畫面。但這一次多了一個關鍵事實——**遊戲化那一區出現在畫面上了**，所以 build 8 確實裝上去了，跑的是新程式碼。

新程式碼裡還剩下**三條**沉默的路：

| 路 | 為什麼還是安靜 |
|---|---|
| `/api/state` 回 **200 但 body 裡沒有 `user`** | `if(!remote \|\| !remote.user)` 那條分支 `setCloudNote('')`，而 `NATIVE` 為真時連閘門都不顯示 |
| `appAuthShow()` 的 `if(!appAuthView) return` | 元素不在就靜默 no-op，畫面停在示範資料 |
| `NATIVE` 為 false 而 `signedInBefore()` 為真 | `absent` 靜默降級，閘門被 owner 擋掉 |

**逐條堵洞是輸的打法。** 這已經是第二輪了，而每一輪都還會剩下「下一條」。所以第二輪的修法換了層次：

> **不問「是哪一條路」，只問「現在這個狀態合不合法」。**

帳號頁多一格 `#acctSignedOutDiag`：**只要走到單機模式、而環境看起來像 app，就把當下的訊號印出來**。它在 `renderAccountView()` 裡，每次繪製都重算，不管是哪一條路帶來的。

兩個實作上不能改的判斷：

- **用 `looksNativeShell()` 判斷，不是 `NATIVE`。** `NATIVE` 判錯本身就是要診斷的故障之一；讓它決定診斷要不要出現，等於讓最需要說話的那一種情況剛好最安靜。`looksNativeShell()` 只看「有沒有 `window.Capacitor`」與「protocol 是不是 http(s)／file」，兩個都不經過訊號偵測。
- **印在帳號頁，不是只印在狀態列。** 使用者回報時拍的就是那一頁（兩次都是）。訊息要出現在人本來就會看的地方。

另外把那三條路各自也補上說明（200 沒有 user、登入畫面元素不在、走完了卻沒同步也沒錯誤），但那些是補強；真正的保險是上面那一格。

## 帶走的東西

1. **同一個 bug class 出現第二次，就不要再修那一個實例。** 第一次是 `Plugins`、第二次是 `isNativePlatform`，兩次都是「注入的 bridge 與 `@capacitor/core` 不一樣」。修法不該是換一個名字，而是不要只靠一個名字。
2. **假的東西不能比真的多給，也不能剛好補上真的缺的那一格。** 這句話上次寫進 CLAUDE.md 時只套用到 `Plugins`。
3. **fire-and-forget 的 async 一定要 `.catch`。** unhandledrejection 比未捕捉的例外更難發現——它連 `pageerror` 都不算。
4. **靜默降級的分支要寫清楚「哪個環境才合法」。** `absent` 對單檔是對的，對 app 是謊話。同一段程式在兩個環境下的正確答案不一樣時，要問的是環境而不是狀態碼。
5. **逐條堵沉默的洞會一直漏掉下一條。** 第一輪堵了三條，build 8 走的是第四條。有效的做法是換一個層次問問題：不列舉「哪些路會導致單機模式」，而是宣告「在 app 裡單機模式本身就不合法」，然後在那個狀態被畫出來的地方檢查一次。
6. **診斷的可見性不能依賴正在被診斷的那個判斷。** 用 `NATIVE` 決定要不要印診斷，會讓「`NATIVE` 判錯」這一種故障永遠印不出來。
