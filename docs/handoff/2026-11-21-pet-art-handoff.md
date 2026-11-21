# 交接：夥伴的 AI 圖與動畫（2026-11-21）

> 給下一個 Claude 對話看的。使用者會在新對話把這份貼進來。
> **一律用繁體中文回覆，用講給五歲小孩聽的方式解釋。**

## 一句話

把「專案的夥伴」（甘特專案養的小動物）從現在的手繪向量圖（SVG），換成 **AI 生成的羊毛氈風格圖**，接著用 **Gemini 做成會動的動畫**。先只做「貓」一整套，使用者看過滿意再複製到另外 7 種。

## 使用者已經做的決定

| 問題 | 裁決 |
|---|---|
| 夥伴的圖要不要用 AI 生成 | 要。方式 **A**：我們先生好、放進系統（不是讓使用者當場打字生成） |
| 貓的 6 個成長階段（`sheet-stages.webp`） | **「我覺得可以」**——通過 |
| 貓的六個方向＋五種表情（`sheet-views-emotions.webp`） | 剛畫完，使用者說「好，存起來」，**還沒有明確說每一張都 OK**，新對話開頭可以先問一句 |
| 動畫 | 要做：**圖 → Gemini 生成影片 → 遮罩去背 → 動物動畫** |
| 開機畫面在湖邊走路的小動物 | 我的建議是**維持現在的 SVG**（腳會擺、會跟主題換色），AI 圖只換「專案頁的夥伴卡」那一張大圖。使用者沒有反對，但也沒明說——做進系統前再確認一次 |

## 已經有的東西（都在 `design/pets/`，這個資料夾**不會被部署**）

```
design/pets/gen.sh                       產生腳本（generations／edits 兩種用法，提示詞都在裡面）
design/pets/cat/reference/adult-1024.png 成年貓原圖（1024，透明背景）——之後所有 edits 的參考圖，用這張
design/pets/cat/stages/1-baby … 6-adult  六個成長階段（768 WebP，透明）
design/pets/cat/views/d1-front … d6-front-left  六個方向：正面、右前、右側（站姿）、背面、左側（站姿）、左前
design/pets/cat/emotions/e1-happy … e5-bored    喜、怒、愛（抱愛心）、樂（跳起來）、無聊（趴著）
design/pets/cat/trials/                  最早試畫的貓與狐狸（狐狸像柴犬、尾巴有綠毛——那是提示詞寫了 moss green 的錯）
design/pets/cat/sheet-*.webp             給人看的對照圖（亮色／暗色卡片上的樣子）
```

成長階段的檔名對應系統裡的 `PET_STAGES`（`public/index.html` 的〈專案的夥伴〉區段）：
`baby`(0%)＝1-baby、`small`(1–24%)＝2-small、`half`(25–49%)＝3-half、`big`(50–74%)＝4-big、`almost`(75–99%)＝5-almost、`adult`(100%)＝6-adult。

## 怎麼生的（踩過的坑）

- **OpenAI 金鑰**：雲端環境的 Network secrets 已經有 `api.openai.com` 的 key，送 `Authorization: Bearer dummy` 就好，代理會換成真的。**不要叫使用者把 key 貼進對話。**
- **模型用 `gpt-image-1.5`**。`gpt-image-1` 不存在了；`gpt-image-2` 不支援透明背景（`Transparent background is not supported for this model`）。透明背景是放進卡片的前提。
- **一致性的作法**：先 `generations` 畫成年那一隻當參考，其他每一張都用 `edits` 帶著 `reference/adult-1024.png` 生。各自從頭生的話每一張都是不同的貓。
- 提示詞**不要寫 green**：第一次寫了「moss green accents」，兩隻的尾巴尖都長出綠毛。
- 透明度驗過：角落像素 alpha＝0；邊緣有一圈半透明的柔光，在暗色卡片上看起來是淡淡的影子，可以接受。
- 本機沒有 Python PIL（壞的），圖片處理用 **Playwright 的 canvas**（`toDataURL('image/webp', 0.88)` 保留透明度）。Chromium 在 `/opt/pw-browsers/chromium-*/chrome-linux64/chrome`，`playwright` 從 repo 根目錄 `createRequire` 進來（不在 package.json，零相依是前提；需要時 `npm install --no-save playwright`）。

## 下一步：動畫（Gemini）

**Gemini 的 key**：使用者已經加在雲端環境的 Network secrets（主機 `generativelanguage.googleapis.com`、標頭 `x-goog-api-key`）。上一個對話測的時候回 403，因為**新加的 secret 要新對話才生效**——新對話先打一次 `curl -s -o /dev/null -w "%{http_code}" https://generativelanguage.googleapis.com/v1beta/models` 確認是 200。是 403 的話，請使用者確認主機與標頭名稱，不要叫他貼 key。

建議的流程（跟使用者講過的，他同意）：

1. **先只做一段**：拿 `views/d1-front` 或 `emotions/e4-joy` 當第一格，用 Veo 生 2～4 秒的影片（例如眨眼、搖尾巴、跳一下）。**Veo 按秒計費、比畫圖貴很多**，一次只生一兩段，給使用者看過再繼續。可用的模型名稱先用 `GET /v1beta/models` 查，不要憑記憶寫。
2. **去背**：影片沒有透明背景。叫它在**純色背景**上生（提示詞寫明 plain solid background），再逐格去背。羊毛氈的毛邊細，用綠幕色會染到毛邊——優先試接近背景的中性純色＋分割模型；效果要實際做出來給使用者看，不要先保證。
3. **輸出格式**：**有透明背景的 animated WebP**（iPhone Safari 也能播；WebM 的透明在 Safari 不行）。目標一段 200～500KB、12fps 左右、邊長 256～384。
4. 放進系統之前要另外確認的（都是 CLAUDE.md 寫死的規則）：
   - `prefers-reduced-motion` 開著時**不播**，顯示靜態圖。
   - 圖要能**離線**看到（PWA）：放 `public/` 底下、加進 `sw.js` 的預快取，並把 `CACHE` 版本號往上加（`tools/check-sw-version.mjs` 會擋）。
   - **iOS app 只內建 `public/index.html`**（`mobile/scripts/prepare-www.mjs` 只複製它），新的圖檔要另外處理才會進 app——這一點要先想好再動手。
   - 動 `index.html` 一定要跑 `npm test`、`node tools/check-syntax.mjs`、`node tools/smoke.mjs`；顏色／版面要跑 `tools/check-contrast.mjs`、`tools/check-ambience.mjs`（夥伴卡與開機畫面都有斷言守著，見 CLAUDE.md〈專案的夥伴〉）。
   - 動到視覺要**先拍前後對照給使用者看過再合併**（CLAUDE.md〈早晨的苔庭〉F 列）。

## 這個 session 其他已經完成的事（背景）

- **MCP 伺服器**（讓 Claude／ChatGPT 等 agent 連進來讀寫排程）已上線：PR #74、#75（授權頁登入後回得來）、#76（`get_schedule` 的完成狀態以當下資料為準）。使用者已經用 Claude 連接器實測過讀、寫、勾完成、復原，全部正常。
- 網頁版訂閱（Paddle）PR #73 已合併；Paddle 的商品與兩個價格已建立。

## 還在等使用者自己做的事（提醒，不要催）

1. 到 Apple 開發者網站**接受新的合約（PLA）**，iPhone app 才能重新打包上傳。
2. **Paddle**：網站審核通過後，設定 6 個 Worker secret（`PADDLE_API_KEY`、`PADDLE_WEBHOOK_SECRET`、`PADDLE_CLIENT_TOKEN`、`PADDLE_PRICE_MONTHLY`、`PADDLE_PRICE_YEARLY`、`PADDLE_ENV`）。
3. 換掉 **KiddieFinance** 那個 Paddle webhook 的 secret（之前讀 Paddle API 時意外露出，**不要重複、不要使用**）。

## 工作規則（這個 repo 一直遵守的）

- 分支 `claude/init-fch9ea`；PR 開成**草稿**；使用者說「合併」才 **squash 合併**。
- **不要把任何 API key／secret 貼進對話或寫進檔案**，只報「有沒有、長度」。
- 要跑 migration 的話**合併之前**先跑（CI 合併後自動部署）。
- commit、PR、程式碼裡**不要寫模型名稱**。
