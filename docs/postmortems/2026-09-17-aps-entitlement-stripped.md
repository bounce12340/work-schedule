# build 13：打包全綠、上傳成功，手機上卻「找不到有效的 aps-environment 授權字串」

**日期**：2026-09-17
**症狀**：TestFlight build 13，帳號頁按下推播開關 →
`開啟推播失敗：push registration failed: 找不到應用程式的有效「aps-environment」授權字串`
**狀態**：build 14 仍然失敗，找到**第二個、而且更根本的**根因（見〈第二輪〉）；等 build 15 真機驗收

## 經過

推播（子專案 B）在 #43 上線，`mobile/ios/App/App/App.entitlements` 帶著 `aps-environment`，
`tools/check-native-plugin.mjs` 也加了一條「entitlements 有沒有這一欄」的檢查。CI 綠、
`ios.yml` 打包綠、上傳 App Store Connect 成功、TestFlight 裝得起來。

但那個 build 打完之後，使用者才去 Apple Developer 後台把 App ID 的 Push Notifications
勾起來。順序反了，而**反了不會有任何徵兆**。

## 根因

`aps-environment` 不是「寫在原始碼裡就算數」的東西。`xcodebuild -exportArchive` 重簽時，
會拿自動產生的描述檔去對：**描述檔裡沒有的 entitlement，它安靜地拔掉再簽**，不報錯、
不警告到會被看見的地方。而描述檔有沒有這一欄，取決於 App ID 的 capability。

於是整條路上每一個綠燈都是真的綠燈——它們檢查的都不是「簽好的 app 身上有沒有這一欄」：

| 關卡 | 當時的結果 | 它其實在看什麼 |
|---|---|---|
| `check-native-plugin.mjs` | ✓ | 原始碼裡**有沒有寫**這一欄 |
| `xcodebuild archive` | ✓ | 那一步 `CODE_SIGNING_ALLOWED=NO`，根本沒簽 |
| `xcodebuild -exportArchive` | ✓ | 拔掉之後簽成功了，對它而言就是成功 |
| App Store Connect | ✓ | 收到一個簽章合法的 app |

**沒有任何一關看的是結果。** 這與〈看得見的備份才是備份〉是同一種形狀：每一步都回報成功，
而那件事從頭到尾沒發生。

## 第二個坑（還沒咬到，但一定會咬）

修的時候發現 `App.entitlements` 寫死 `development`，而 Debug 與 Release **共用同一個檔案**。
`aps-environment` 決定 device token 是**哪一台 APNs 的**：TestFlight 是 production。
原本指望 `exportArchive` 會自己換成 production——**那是指望，不是保證**，而它猜錯時
同樣不報錯，症狀是推播送得出去卻永遠收不到（400 `BadDeviceToken`，看起來像「token 壞了」）。

Swift 那側的 `apsEnvironment()` 早就用 `#if DEBUG` 分兩條路了。兩側對不上而沒有東西去比，
正是〈跨語言的接線要有一個地方比對兩側〉那一條。

## 改法

1. `App.entitlements` → `production`（Release 專用）
2. 新增 `AppDebug.entitlements` → `development`（Debug 專用）
3. `project.pbxproj` 的兩個 configuration 各指各的
4. `check-native-plugin.mjs` 從「有沒有這個字」改成**驗值、驗兩個 configuration 各指各的、
   並比對 Swift 的 `#if DEBUG` 分支**。突變驗證過三種改法各自會紅：
   - Release 也寫 `development`（＝修好之前的狀態）
   - Debug 指回同一個檔案
   - Swift 的 Debug 分支改成 production

## 學到的

1. **「有沒有寫」與「有沒有生效」是兩件事**，而靜態檢查天生只看得到前者。這支檢查從頭到尾
   都是綠的，因為它問的問題本身就不涵蓋這個 bug。加檢查時要問的是「它綠的時候，到底證明了
   什麼」——而不是「它有沒有涵蓋這個檔案」。
2. **原始碼這一側驗不到 Apple 後台的設定，那就要把它寫進檢查的註解裡。** 驗不到的東西留白，
   下一個人會以為綠燈代表全部都好。現在 `check-native-plugin.mjs` 的註解明說「App ID 有沒有
   勾 Push Notifications 這裡驗不到，打包綠燈證明不了那一欄在裡面」。
3. **設定的順序有方向性。** App ID 的 capability 要在打包**之前**開好，與 migration 要在部署
   之前跑是同一種依賴——而兩者的共同點是：順序反了不會報錯，只會安靜地做出一個壞掉的東西。
4. **「打包綠燈」不是驗收。** 同〈真機驗收要分讀與寫兩半〉：只有手機上真的按下那顆開關才算數。


## 第二輪：build 14 仍然是同一行字

App ID 勾好了、`App.entitlements` 拆成兩份也對了，build 14 打包上傳一切正常——**手機上仍然是
同一行「找不到有效的 aps-environment 授權字串」**。

### 真正的根因

`ios.yml` 的 archive 那一步刻意**完全不簽章**（`CODE_SIGNING_ALLOWED=NO`），簽章整個留給
`exportArchive`。那個安排本身有很好的理由（前兩次打包失敗換來的：開發用描述檔要綁裝置、
硬指定 Distribution 會被判定為 conflicting provisioning settings）。

但它有一個當時沒想到的副作用：**entitlements 是在簽章那一步才被寫進 app 的。** 沒有簽章，
archive 裡那個 `App.app` 身上什麼 entitlement 都沒有。而 `exportArchive` 重簽時，是從
archive 身上讀「這個 app 原本要求了什麼」——讀到空的，就簽出一個沒有推播權限的 app。

**所以 App ID 勾不勾其實都一樣**，那一欄從來沒有機會進去。第一輪的診斷（「App ID 沒勾，
Xcode 把它拔掉」）方向對、機制錯：它不是被拔掉，是根本沒有被放進去。

### 改法

1. archive 改成 **ad-hoc 簽章**（`CODE_SIGN_STYLE=Manual` + `CODE_SIGN_IDENTITY="-"` +
   `AD_HOC_CODE_SIGNING_ALLOWED=YES`）。它會把 entitlements 真的寫進去，而且**一樣不需要
   描述檔、不綁裝置、不需要 .p12**——原本那三個 `CODE_SIGNING_*=NO` 要避開的兩次失敗，
   ad-hoc + Manual 同樣避得開。正式簽章仍然只發生在 `exportArchive`。
2. archive 之後**斷言** `aps-environment = production` 真的在簽好的 app 裡，缺了就擋下這次
   打包，並把那個 app 實際帶著的全部 entitlements 印出來。

### 學到的（補在第一輪四條之後）

5. **第一輪的修正是對的，但它修的不是這個 bug。** 拆兩個 entitlements 檔案、把檢查從「有沒有
   這個字」改成驗值——每一條都該做，而且第二個坑真的存在。但它們全部作用在**原始碼那一側**，
   而這個 bug 在**建置那一側**：原始碼寫得再對，沒有被寫進 app 就是沒有。修完之後症狀一模一樣，
   正是因為兩者在不同的層。
6. **「這一關綠燈時到底證明了什麼」要問到底。** 第一輪已經寫下這一條，卻只套用到靜態檢查，
   沒有回頭問同一句話給打包那一關——而它的答案是「證明了上傳成功，沒有證明 app 身上有什麼」。
   一條學到的教訓只套用在發現它的那個地方，就會在隔壁再發生一次。
7. **診斷要放在產物上，不是放在原始碼上。** 現在那條斷言讀的是 `codesign -d --entitlements`
   ——簽好的 app 自己說它有什麼，而不是我們說我們要什麼。這是唯一問得到結果的位置。
