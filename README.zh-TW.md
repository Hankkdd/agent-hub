[English](README.md) | 繁體中文

# Agent Hub

Agent Hub 是自行架設、供單人使用的網頁工作台，讓你在同一個地方操作 Claude 和 Codex。
它透過 Claude Agent SDK 使用你自己的 Claude Code 登入，並透過 Codex SDK 使用你自己的
ChatGPT 登入。你可以同時執行多個任務，讓代理各自在獨立的 git worktree 中工作，
再由作者與審查者來回修正；最後要合併哪些變更，仍由你決定。

## 功能

- **對話（Chat）：** 與一個代理對話，可指定工作目錄，回覆以串流即時顯示。
- **規劃（Plan）：** 在唯讀的 checkout 中討論變更、確認規格，再交給實作任務；
  結果會回報到原本的規劃對話。
- **實作（Implement）：** 代理在自己的 git worktree 中修改程式；Hub 每輪建立 commit，
  讓你檢視差異，再選擇合併或捨棄。
- **審查（Review）：** 作者與唯讀審查者來回修正，直到核准或達到輪次上限；
  核准後可執行選填的測試指令。任何合併都需要你決定。
- **討論室（Rooms）：** 與 Claude 和 GPT 討論文件，並審閱它們提出的修改建議；
  目前提供伺服器 API，討論室介面另行實作。
- **文件工作區：** 撰寫純文字文件，保留不可變的版本歷史，明確儲存與還原，
  並在接受前審閱手動匯入的段落修改建議。
- **裝置：** 登記機器後，透過 SSH 使用 `list_hosts`、`ssh_exec` 和 `copy_file`，
  各裝置均保留指令與傳檔紀錄。
- **影片摘要：** 擷取字幕或轉錄音訊，產生附章節連結的摘要，並繼續追問。
- **規則套件：** 載入含參數的儲存庫規則，並為每個任務保存快照。
- **Discord 通知：** 透過選用的 webhook 接收提問、待決事項與任務結果通知。
- **選用整合：** 透過 Antigravity 進行獨立的 Gemini 純文字對話、存取 Google Drive
  影片，以及透過外部 `e3sync` CLI 查詢 E3 學習管理系統的課程、作業與教材；
  另可選擇影片「Assignment Spec」分析，從課堂影片逐字稿擷取結構化的需求檢查清單。

## 專案狀態

這是持續開發中的個人專案，為單一使用者在透過 Tailscale 連線的私人網路上使用而設計。
目前未針對公開網際網路的暴露情境進行安全強化。API 與資料格式可能變動。

任務與事件保存在 SQLite 中，重新啟動後仍可繼續對話。
各工作流程的限制與復原細節請見[操作指南](docs/configuration.md)。

## 環境需求

- **Linux 主機**，並備有 Git 與 OpenSSH 用戶端工具。
- 執行 Hub 的使用者可使用 **Docker**；Codex 預設在容器中執行，
  影片處理則使用獨立的媒體容器。
- **[mise](https://mise.jdx.dev)**，用於安裝專案固定的 Node 22 與 pnpm 10 工具鏈。
- 依使用的代理，備妥 **Claude Code 登入及／或供 Codex 使用的 ChatGPT 登入**。

登入指令、容器設定與網路限制請見[主機需求](docs/runbook/host-requirements.md)。

## 快速開始

在本機 checkout 目錄中執行：

```bash
mise install
mise exec -- pnpm install
mise exec -- pnpm dev
```

API 會在 `http://127.0.0.1:8787` 啟動，網頁介面則位於
`http://127.0.0.1:5173`，並將 API 請求代理轉送至伺服器。

第一次啟動時，伺服器會建立 `data/token`（若有設定，則為 `$AGENT_HUB_DATA/token`）。
啟動紀錄只會顯示檔案位置，不會印出權杖。請在本機讀取該檔案，然後開啟：

```text
http://127.0.0.1:5173/?token=<token>
```

將 `<token>` 換成檔案內容。Hub 會將它交換為 HttpOnly cookie，並從網址列移除。
請妥善保管這個權杖。

第一次執行代理任務前，請以執行 Hub 的使用者登入 Claude Code，或執行
`mise exec -- pnpm codex:login`，建立 Codex 容器專用的登入狀態。
容器映像會在首次使用時建置；也可先執行 `mise exec -- pnpm images` 預先建置。

若要從其他裝置存取 Hub，請依照 [tailnet 綁定說明](docs/configuration.md#run)設定。
若要由 API 程序提供建置後的網頁介面，請執行 `mise exec -- pnpm start`。

## 安全模型

- **身分驗證：** 主要權杖具有完整存取權；瀏覽器在初次交換權杖後使用 HttpOnly cookie。
  請將權杖視同密碼保管。
- **受限遠端權杖：** 設定 `AGENT_HUB_REMOTE_API=1`，可啟用獨立且僅接受 bearer 驗證的
  轉送權杖。它只能使用受限 API，並只能啟動容器中的 Codex 任務，無法使用裝置工具
  或自訂測試指令。
- **代理執行環境：** Codex 預設在 Docker 中執行。Claude 可在主機上依權限模式執行，
  也可在容器中使用獨立的登入狀態。
- **裝置存取：** 裝置工具執行時不會要求確認。只登記你願意交給代理操作的機器；
  SSH 帳號的權限才是實際邊界。
- **機密資料：** Hub 伺服器權杖、裝置 SSH 金鑰、Google 憑證與 E3 工作階段 cookie
  只保留在主機，不會進入代理容器。代理容器在私有資料目錄中保有各自的服務登入狀態。

授予儲存庫或機器存取權前，請先閱讀[設定與操作指南](docs/configuration.md)、
[裝置設定](docs/runbook/device-setup.md)與
[主機網路限制](docs/runbook/host-requirements.md#known-gap-container-network-fence)。

## 文件

- [設定與操作](docs/configuration.md)：環境變數、儲存庫慣例、執行環境、整合與工作流程細節。
- [設計](docs/design.md)：架構與決策。
- [知識地圖](docs/knowledge-map.md)：依主題查找文件與程式進入點。
- [規劃指南](docs/guide/planning.md)：確認需求、將工作交給代理，並審閱回報。
- [操作手冊](docs/runbook/)：逐步操作程序，包含
  [部署與回復](docs/runbook/deploy.md)、
  [映像驗證](docs/runbook/verify-scripts.md)、
  [規則套件](docs/runbook/rule-packs.md)、
  [Google 設定](docs/runbook/google.md)與
  [Gemini 對話設定](docs/runbook/gemini-chat.md)。

## 授權

[MIT](LICENSE)。Copyright (c) 2026 Hankkdd.
