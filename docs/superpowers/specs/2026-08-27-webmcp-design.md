# WebMCP：讓 AI 助理操作這個網站

日期：2026-08-27
狀態：**設計完成，尚未實作**（依使用者決定先寫文件）

## 這是什麼

[WebMCP](https://github.com/webmachinelearning/webmcp) 是 W3C Web Machine Learning 社群的一個**瀏覽器 API 提案**，不是可安裝的套件。它讓網頁用 `document.modelContext.registerTool()` 主動宣告「我有哪些功能」，瀏覽器裡的 AI 助理就能直接呼叫，而不必隔著畫面猜按鈕在哪。

```js
await document.modelContext.registerTool({
  name: 'add-todo',
  description: "Add a new item to the user's active todo list",
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute({ text }) {
    await addTodoItemToCollection(text);
    return { content: [{ type: 'text', text: `Added todo item: "${text}" successfully.` }] };
  }
}, { signal: controller.signal });
```

### 實作狀態（2026-08-27 查證）

| 瀏覽器 | 狀態 |
|---|---|
| Chrome 149 | origin trial（需權杖） |
| Edge 150 | origin trial |
| Brave | Leo 有實驗性支援 |
| ChatGPT 桌面版 | 有支援 |
| Firefox / Safari | 仍在標準立場審查中 |

**尚未在任何瀏覽器正式上線。** 這代表兩件事：規格可能還會變，而且要用得先申請 origin trial 權杖（綁網域、會過期）。

## 為什麼這個專案適合

| 專案前提 | 為什麼相容 |
|---|---|
| 零依賴 | WebMCP 不需要安裝任何套件，是瀏覽器內建 API |
| 全部包在一個 IIFE 內 | 註冊工具的程式碼放同一個 IIFE，工具的 `execute` 直接呼叫既有函式 |
| 單檔可離線開啟 | 偵測不到 `document.modelContext` 就完全不做——與雲端同步同一個漸進增強模式 |
| 功能都是現成的純函式 | `getAllOccurrences()`、`commit()`、`setOccurrenceDone()` 直接包成工具 |

## 範圍：讀 + 有限的寫

### 唯讀工具

| 工具 | 用途 |
|---|---|
| `list-schedule` | 查詢某個日期區間的排程 |
| `list-overdue` | 逾期與即將到期的項目 |
| `list-projects` | 甘特專案與各任務進度 |

### 可寫工具（只有兩個）

| 工具 | 用途 |
|---|---|
| `add-item` | 新增一個小項目 |
| `set-done` | 把某一次標記為完成／未完成 |

### 刻意不給的三件事

**刪除、改日期、改名稱一律不開放。**

理由不是「危險」而是**發現得了發現不了**：

- AI 多新增一個項目 → 你**看得到**，畫面上多一列
- AI 誤刪一個項目 → 你**看不到**，畫面上少一列而已
- AI 把日期改錯一天 → 你**永遠不會發現**，畫面看起來完全正常，只是那個日期默默地不對了

第三種最糟。而排程系統的價值就建立在「上面的日期是對的」——一旦那件事不可信，整個系統就沒有意義。這條線之後若要放寬，必須是明確的決定，不能順手。

## 兩個關鍵的介面設計

### 一、AI 怎麼指到「哪一個項目的哪一次」

循環項目的每一次發生（occurrence）在系統裡的身分是 `(item.id, occKey)`，而 occurrence **從不被儲存**（見〈核心架構：occurrence 引擎〉）。AI 沒辦法憑空拼出 occKey。

因此：**唯讀工具的回應必須帶出 `itemId` 與 `occKey`**，`set-done` 才有東西可以指。這不是實作細節，是這兩個工具之間的契約——先查再改。

暴露這些 id 沒有安全問題：它們不是憑證，而且 AI 只能透過這些工具動作，動不到別人的資料（工具跑在使用者自己的分頁裡，用的是他自己的 session）。

### 二、日期必須是絕對的，而且要給 AI 一個錨點

`inputSchema` 一律要求 `YYYY-MM-DD`，**不接受「明天」「下週三」這種相對說法**——語言模型換算相對日期很容易差一天，而差一天在排程系統裡就是錯的。

但光是要求絕對日期還不夠：AI 得先知道今天是幾號。因此**每一個唯讀工具的回應都附上 `today`**。這樣「幫我看這週」就變成 AI 自己算得出來的事，而基準是我們給的，不是它猜的。

## 安全與可追蹤性

### 每一次寫入都可以當場復原

沿用既有的 `deleteWithUndo(desc, mutate)` 機制（拍一份 `snapshot()` → `commit(mutate)` → 顯示 6 秒復原 toast）。抽成通用的形狀，讓刪除與 AI 寫入共用；文案改成「AI 新增了「○○」」。

**這是最重要的一道防線**，因為它讓「AI 做錯」從「要人工修回來」變成「按一下」。

### 但復原有個前提：你要在場

6 秒的 toast 只在使用者正在看著畫面時有用。AI 操作時使用者可能在看別的地方——**這正是需要第二層的理由**。

### 第二層：永久記錄

新增 `ai_activity` 表，與既有的 `admin_activity` 同一個模式：

```sql
CREATE TABLE IF NOT EXISTS ai_activity (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  tool       TEXT NOT NULL,      -- 'add-item' / 'set-done'
  summary    TEXT NOT NULL,      -- 伺服器不產生，由前端寫入時附上人可讀的描述
  created_at INTEGER NOT NULL
);
```

- **保留 90 天**，寫入時順手清理（同 `share_activity`）。
- 顯示在「我的帳號」頁的一個新區塊。
- **寫入失敗只 `console.warn`，不讓已經成功的操作變成錯誤**——資料已經改了，回錯誤只會讓人重試而重複操作。

**與 `admin_activity` 有一個刻意的不同**：那張表的描述由伺服器依前後值產生，因為「讓操作者自己決定記錄寫什麼，記錄就沒有意義」。這裡的 `summary` 由**前端**產生——但寫入的不是 AI，是我們自己的 `execute` 程式碼，AI 只能提供參數。差別在此。

### 單機模式下記錄不了，要說清楚

`ai_activity` 在雲端。雙擊開啟單檔時沒有後端，**只有 toast、沒有永久記錄**。

這是真實的限制，不該假裝沒有。實作時要在「我的帳號」的該區塊寫明「單機模式下不留記錄」，而不是顯示一個永遠空白的清單。

### AI 傳來的參數是外部輸入

`inputSchema` 由瀏覽器驗證，但**不能假設它一定驗過**——規格還在變，而且我們自己的 `execute` 是最後一道。因此：

- 型別、長度、日期格式在 `execute` 內再驗一次，不合就回錯誤而不是丟例外
- 標題等文字走既有的顯示路徑（`escapeHtml`），不新增任何 `innerHTML` 的注入點
- 新增的項目一律經 `normalizeItems()` 的同一套必填欄位檢查——缺 `date` 的項目會讓 occurrence 展開時 `parseYMD` 直接拋錯

### 一切寫入必須走 `commit()`

不可以自己 `items.push()` 之後呼叫 `persist()`。理由見〈唯一的寫入入口：commit()〉：漏走一次就是「畫面對了但沒存檔」的靜默 bug。

## 偵測不到時完全靜默

```js
if (!document.modelContext) return;   // 不註冊、不顯示、不留 log
```

**這與〈降級可以，沉默不行〉並不衝突。** 那條規則針對的是「本來應該運作、這次失敗了」——例如 `cloudPull()` 收到 502。而「這個瀏覽器沒有這個 API」屬於另一類，等同於 `cloudPull()` 的 `absent` 分支（偵測不到 `/api/state`），靜默才是對的：使用者不該看到一個他永遠用不了的功能。

### 但這個選擇有代價，要寫下來

Origin trial 的權杖**會過期**（綁網域、有效期以季計）。而依照「完全靜默」的決定，**權杖過期時不會有任何徵兆**——AI 就只是突然不能操作這個網站了，沒有錯誤訊息、沒有 log。

補償措施（實作時一併做）：

1. 把權杖的到期日寫進 `CLAUDE.md` 的維運清單，與 R2 儲存桶、AgentMail 金鑰放在一起。
2. 權杖過期與「瀏覽器不支援」在使用者端長得一樣，所以**至少要在 console 印一行 debug 等級的訊息**（不是 error），讓開發者按 F12 時查得到。這不違反「靜默」——靜默指的是**使用者介面上**不出現東西。

## 測試

### 關鍵洞見：不需要等瀏覽器支援也能測

`document.modelContext` 只是一個物件。**在測試裡塞一個假的進去，整條路徑都能驗**：註冊了哪些工具、`execute` 收到參數後做了什麼、回傳的 `content` 形狀對不對。

因此測試分兩層：

| 層 | 測什麼 | 怎麼測 |
|---|---|---|
| 純函式 | occurrence → AI 看得懂的形狀、參數驗證、日期格式 | `node:test`，從 `index.html` 抽原始碼求值（同 occurrence 引擎的做法） |
| 整條路徑 | 註冊、execute、寫入真的走 commit、復原真的復原得回來 | `tools/smoke.mjs` 內注入假的 `document.modelContext` |

### 必須用突變驗證的幾條

- 拿掉參數驗證 → 塞進缺 `date` 的項目應該要紅
- `execute` 不走 `commit()` → 「畫面對了但沒存檔」要被抓到
- 把 `set-done` 的 occKey 比對拿掉 → 應該改到錯的那一次
- 偵測不到 `modelContext` 時仍然註冊 → 單機模式應該要紅

### 一件測不到、要誠實說的事

**真正的瀏覽器 AI 助理會怎麼呼叫這些工具，測不到。** 假的 `modelContext` 驗的是「我們這一側的行為」，不是「AI 會不會正確使用」。工具描述寫得好不好、AI 會不會誤用，只能在真的環境裡試。

因此上線後的第一件事是**用唯讀工具實際問幾個問題**，確認 AI 理解得對，再考慮開放寫入。

## 實作順序

分兩個 PR，理由同「我的帳號」那次——風險性質不同：

**PR 一：唯讀工具。** 三個查詢工具 + 偵測 + 靜默降級。**AI 改不了任何東西**，可以放心在真實環境試，順便驗證工具描述寫得好不好。

**PR 二：可寫工具。** `add-item`、`set-done`、通用的復原機制、`ai_activity` 表與「我的帳號」的記錄區塊。

## 尚未決定的事

- **權杖何時申請。** 需要使用者自己去 Chrome 的 origin trial 頁面登記（綁網域，無法代勞）。在拿到之前，PR 一可以先合併——程式碼會靜默不啟用，沒有任何副作用。
- **要不要限制單次操作量。** 例如「AI 一次最多新增 5 個項目」。目前傾向不限制，因為每一次都有 toast 與記錄；但如果實際用起來發現 AI 會一口氣塞十幾個，那就要加。等真的用過再決定。
