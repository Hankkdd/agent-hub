# Agent Hub 設計文件

> 狀態：v2，2026-10-14。Step 1–4 已完成；Step 5 已完成 SSH 設備、設備間傳檔（copy_file）與影片逐字稿。
> 接下來要做的功能（CD、看 code 的助手、Gemini、依額度切換、文件協作、學習模式）在 [future-features.md](future-features.md)。
> 方向：**範圍照「個人 AI 開發工作台」做，架構照「可擴充的 framework」設計。**
> 先把自己會用的做出來，但 Agent、Workflow、Tool 都留好可以替換、擴充的介面。

## 1. 為什麼要做

每天在 Claude Code、Codex、終端機、ssh 之間切換，而且常常要手動把 A 的輸出複製貼上給 B。
Agent Hub 讓我只做兩件事：**提出需求**和**做最後決定**。中間的協調多個 agent、管理工作環境、
執行、驗證、留紀錄，都交給框架。

例如輸入：「修復社團系統的部署問題，先分析原因再改程式，請另一個 agent review，測試通過後讓我確認。」
Agent Hub 就照工作流程跑完，只在需要我決定的地方停下來。

## 2. 需求範圍

### 2.1 最終要有的功能

1. 本機網頁介面，可以和 agent 對話
2. agent 可以 ssh 進我登記過的設備執行指令
3. Claude 和 Codex 合作：一個改、一個審，來回修正
4. 可以同時跑多個任務，互不干擾
5. 貼一個影片網址，抓逐字稿並整理

### 2.2 MVP（第一個可用版本）的驗收標準

- [x] 能從瀏覽器建立、切換、查看多個任務
- [x] 每個任務可以和 Claude 各自獨立對話
- [x] agent 的回應即時串流到介面
- [x] 重新整理網頁不會遺失對話紀錄
- [x] server 重啟後，任務和歷史紀錄都還在，被中斷的那次執行有正確標示出來
- [x] 程式碼裡已經有 Agent adapter 和 Workflow 的介面，但 MVP 不需要做 Codex 和雙 agent 協作

### 2.3 不做（目前）

- 自己寫 agent 迴圈。讀檔、改檔、跑指令交給 Claude Code 和 Codex 本身，Agent Hub 只負責「管理」。
- 登入、多使用者、遠端部署（只綁 localhost，之後可以考慮 tailscale）
- Docker、Kubernetes、沙盒（任務之間用 git worktree 隔開就夠了）
- 桌面 App、手機 App（之後要的話，用 Tauri 把網頁包起來）
- 通用的圖狀工作流程引擎（像 LangGraph 那種）

## 3. 設計原則

1. **Agent 可替換**：Claude、Codex 只是不同的 adapter，上層不認識任何 SDK。
2. **Workflow 可自訂**：「Claude 寫、Codex 審」只是其中一種流程，不寫死在核心裡。
3. **狀態可恢復**：任務、事件、agent 的 thread id、worktree 路徑全部存進 DB。
   但**「可恢復」不代表「可以自動重跑」**，見 §8。
4. **安全邊界放在工具層**，不放在提示詞裡。agent 能做什麼由工具決定，不是靠 prompt 拜託它。

## 4. 核心概念與關係

這一節決定之後好不好擴充，所以先把名詞定清楚：

```
Task（任務）── 我交代的一件事；介面左欄的一列
 ├─ workflow：這個任務用哪種流程跑（chat / implement / review / custom）
 ├─ Workspace：任務的工作目錄（某個 repo 的 git worktree，或者沒有）
 ├─ Session × N：參與這個任務的每個 agent 各一條對話
 │    └─ agent：用哪個 Adapter（claude / codex）、扮演什麼角色（main / author / reviewer）
 │    └─ sdk_thread_id：SDK 的對話 id，接續對話靠它
 └─ Event × N：這個任務發生過的每件事，依序號排列（訊息、工具呼叫、狀態轉移、review 結果……）
```

- **Task 和 Session 是一對多**：chat 任務只有一條 session；review 任務有 author 和 reviewer 兩條。
- **Event 是唯一的真相**：介面上看到的對話、diff 紀錄、執行紀錄，全部從 event 組出來。
  顯示順序只看 event 的序號，不看時間戳記。
- **Workflow 是一段普通的 TS 函式**，用 Adapter 和 Workspace 這些積木把流程寫出來。
  它不是設定檔，也不是狀態機 DSL。

## 5. 架構

```
Web UI（React，localhost）
  任務清單 · 對話 · Diff · Events
        │  HTTP（送指令） + SSE（收即時事件）
        ▼
Agent Hub Core（Node + TypeScript, Hono）
  Task Scheduler · Workflow Runner · Event Stream · Session Manager
        │
        ├─ Agent Adapters ──── Claude（claude-agent-sdk） / Codex（codex-sdk） / 之後的模型
        ├─ Tool Registry ───── SSH / Git / Shell，透過 MCP 掛給 agent
        ├─ Workspace Manager ─ git worktree 的建立、diff、合併、清理
        └─ Storage ─────────── SQLite（tasks / sessions / events / hosts / ssh_log）
```

### 5.1 Agent Adapter 介面

```ts
interface AgentAdapter {
  kind: string; // "claude" | "codex" | ...
  run(input: {
    prompt: string;
    cwd?: string;           // Workspace 路徑
    threadId?: string;      // 有值就接續同一條對話
    systemPrompt?: string;  // 固定指令；Codex 只在新對話第一則訊息送一次
    turnContext?: string;   // 每輪都送的即時內容（例如其他任務清單）
    tools?: ToolSpec[];     // 從 Tool Registry 選出的工具
    signal?: AbortSignal;   // 我按了停止
  }): AsyncIterable<AgentEvent>;
}

type AgentEvent =
  | { type: "thread"; threadId: string }   // 一拿到就存進 DB，不等這一輪跑完
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown; output?: string }
  | { type: "done"; text: string; usage?: Usage }
  | { type: "error"; message: string };
```

### 5.2 Workflow 介面

```ts
interface Workflow {
  id: string; // "chat" | "implement" | "review" | ...
  run(ctx: WorkflowContext): Promise<void>;
}

interface WorkflowContext {
  task: Task;
  workspace?: Workspace;
  session(role: string, agent: string): Session; // 取得或建立一條 session
  emit(event: TaskEvent): void;                   // 寫入 event，並推給介面
  waitForUser(prompt: string): Promise<UserReply>; // 停下來等我決定（狀態存 DB，不佔住 process）
  signal: AbortSignal;
}
```

The `plan` workflow discusses a change read-only in the repository, follows [guide/planning.md](guide/planning.md), and records a self-contained proposal. After a later user reply agrees, `start_task` dispatches implement + review; after a ready report and another user reply agrees, `open_pr` uses Hub publishing. Merging always belongs to the user.

Following the reference project workstream, each dispatched worker stores a durable `reportsTo` link to its planning conversation. The Hub delivers a persisted report at each end state, keyed by worker id and final event sequence, and recovers missed reports at startup. Reports are signals, never mutations: the planner compares the result with the agreed specification and asks the human what to do next. A busy planner receives the report through the existing persistent message queue; worker cooperation is unnecessary.

Planning decisions are persisted `ask` events. An ask ends the planner turn without waiting for a
reply and stays pinned below the transcript until any user message answers it; another ask supersedes
it. `message_task` sends a marked user message through the existing worker queue, restricted to workers
this plan started and gated by a fresh user reply after the latest report or ask. Both tools exist only
in planning turns, over the shared MCP endpoint for Claude and Codex. Workers appear nested under their
plan in the desktop and phone lists, with a banner directing replies to that planning conversation.

Discord notifies each new ask loudly. Report notifications wait for the persisted `plan_turn_end`
boundary; an ask in that turn replaces its report notifications. Reports still notify if the planner
ends without an ask. Event updates and reloads do not send the same notification again.

Workflow overview:

| Workflow | 說明 | 哪個階段做 |
|---|---|---|
| `chat` | 和一個 agent 對話 | Step 3 |
| `plan` | Read-only planning, user-approved dispatch, completion reports and PR opening | Available |
| `implement` | 一個 agent 在 worktree 裡實作，最後由我看 diff | Step 4 |
| `review` | 一個 agent 實作、另一個 agent 審，來回修正 | Step 4 |
| `custom` | 自己組合流程 | Step 5 之後 |

Chat tasks on Codex or Claude accept an optional `outputSchema` JSON object (up to 32 KB) for a structured final answer. The Hub snapshots it in task options at creation and uses it for every main-session turn, including follow-ups and resume after restart; auxiliary calls do not receive it. Raw reply text remains in the transcript, and `turn_result.output` stores the structured result. Other workflows and Gemini do not support this option.

## 6. 資料模型（SQLite + Drizzle）

```
tasks      id, title, workflow, status, workspace_id, created_at, updated_at
sessions   id, task_id, agent, role, sdk_thread_id, status
events     id, task_id, session_id?, seq, type, payload(json), created_at
workspaces id, repo_path, worktree_path, branch, base_ref, status
hosts      name, address, user, port, key_path, note
ssh_log    id, task_id, session_id, host, command, exit_code, stdout, stderr, started_at, duration_ms
```

- `tasks.status`：`idle | running | waiting_user | done | failed | interrupted`
- `events.type` 例如：`user_message`、`agent_text`、`tool_call`、`status_change`、`review_result`、`diff_snapshot`
- 細節之後若變多，再拆成 `data-model.md`。

### Sidebar task-list presentation

Desktop and phone share the same project-first sidebar. A conversation and its nested
`reportsTo` workers inherit the root conversation's repository. The server resolves the
normalized Git root from `workspace.repoPath` or the conversation's cwd; subdirectories
share a project, duplicate basenames show path hints, and unidentified repositories appear
under Other conversations. Repository discovery uses read-only Git argument arrays.

Each project shows nonempty Needs you, Running, Standby, PR awaiting merge, and Finished
sections, counting root conversations rather than worker rows. Decisions outrank execution,
execution outranks open PRs, and open PRs outrank standby. Failed/interrupted tasks and
retained worktrees awaiting acceptance need the user; drafts are not published PRs. An idle
planner with only finished workers settles into Finished, while standalone idle conversations
remain Standby. Root subtitles explain the aggregate state; workers retain their own states.

The authenticated `/api/task-list` read returns compact repository and pending-decision facts
from persisted tasks and events. Full transcripts remain on demand. Additive SSE summaries
update decisions and lifecycle facts; text/tool deltas and activity-only changes do not trigger
repository discovery. Reloads, reconnects and server restarts rebuild these derived facts.
Project buttons expose expansion to assistive technology and keep nonzero counts visible when
collapsed. Browser preferences use repository identities; initial or changed task selection
reveals its project without reopening a deliberately collapsed project on every stream update.

Manual browser checks for both desktop and phone: tab to a project heading and toggle it
with Enter/Space; confirm collapsed blocked/running counts and narrow-screen truncation;
reload to check saved expansion; open a deep-linked worker and select another project's
conversation to reveal its project; deliberately collapse the selected project and confirm
text streaming leaves it collapsed. Check task/chat creation, device navigation, language
switching, worker indentation and scrolling in the shared Sidebar.

## 7. 功能設計

### 7.1 對話與多任務（需求 1、4）

- **畫面**：左欄是任務清單，每列顯示狀態（例如「Codex 審查中」「Claude 執行中」「完成」）；
  右邊是目前的任務，用分頁切換 **Chat / Diff / Events**。
- **同時多任務**：每個任務由 scheduler 各自跑，互不阻塞。可以設一個同時執行的上限（預設 4），
  避免一次燒光訂閱額度。
- **任務正在跑時又送訊息**：不另外開第二輪，訊息排進佇列，這一輪結束後送出。
  （同一條 thread 同時跑兩輪會把對話弄壞。）
- **停止**：用 AbortSignal 中斷，已經輸出的內容保留。

### 7.2 Claude + Codex 合作（需求 3，`review` workflow）

```
我描述需求
  ▼
建立 worktree（agent-hub/task-<id> 分支）
  ▼
[author] 實作，在 worktree 裡 commit
  ▼
server 取出 diff（base..HEAD），連同原始需求交給 reviewer
  ▼
[reviewer] 審查，輸出固定格式：
   VERDICT: approve | changes
   FINDINGS: 嚴重度 / 檔案:行號 / 說明
  ├─ changes ─▶ findings 交回 author（接續同一條 thread）─▶ 再改、再審，最多 N 輪（預設 3）
  └─ approve ─▶ 跑測試（若有設定測試指令）
                 ▼
               停下來等我：看 Monaco diff → 合併 / 繼續改 / 丟掉
```

- 角色可以對調（Codex 改、Claude 審），之後也可以加「兩個都審」。
- 我隨時可以插話，訊息排進下一輪。
- **永遠不會自動合併。** 合併一律由我按。

**實作紀錄（Step 4，2026-10-14）**

For team repositories, PR publishing follows draft → optional edit → confirm. The Chat draft card shows the exact remote branch, squash commit message, title, and complete body that will be published. Preparing a draft changes no remote history; only the user's confirmation publishes it, and subsequent code changes invalidate the draft.

- **commit 由 Hub 負責，不是 agent**：每一輪作者結束後，Hub 把 worktree 裡的所有變更 commit 起來。
  agent 被告知不要自己 commit。這樣 diff 永遠是「base..HEAD」，不依賴 agent 記得 commit；Codex 的沙盒也寫不到
  主 repo 的 `.git`，本來就 commit 不了。
- **審查者是唯讀的，而且有雙重保險**：Claude 審查時拿掉 Edit / Write 工具，Codex 用 `read-only` 沙盒；審查結束後
  Hub 一律 `git reset --hard && git clean -fd`，不管它做了什麼。
- **審查格式**：結尾必須是 `VERDICT: approve | changes` 加 `FINDINGS:` 清單。取最後一個 VERDICT（審查者常在
  前文提到這個字）；找不到 VERDICT 就停下來給我看，不會把一段讀不懂的回覆當成「要修改」丟回作者。
- **合併**：只有在原 repo 停在 base 分支、而且沒有未 commit 的變更時才合併（`--no-ff`），有衝突就 `merge --abort`，
  什麼都不留下。否則會把 agent 的成果混進我正在做的事。
- **Codex 的沙盒在這台機器上起不來**：Ubuntu 用 AppArmor 限制一般使用者建立 user namespace
  （`kernel.apparmor_restrict_unprivileged_userns=1`），Codex 的 bubblewrap 沙盒因此失敗，**Codex 執行的每個指令都會失敗**。
  它還是能改檔、讀 prompt 裡的 diff，但跑不了測試。實測時 Codex 審查者說「沙盒初始化失敗，沒辦法跑測試」，然後只看 diff
  就核准了；那次是 Hub 自己跑的測試指令擋住了風險。
- **決定（2026-10-14）：Codex 改在 Docker 容器裡跑**，而不是修主機的
  AppArmor。每一輪 Codex 都在一個只看得到該任務目錄的容器裡執行：審查者唯讀掛載、作者可寫，主 repo 的 `.git` 唯讀掛載
  （能 `git status` 不能 commit），容器以我的 uid 執行，結束或停止時自動刪除，server 開機時清掉 `kill -9` 留下的容器。
  容器有自己的 Codex 登入（`data/codex-home`），不共用主機的 `~/.codex`，避免 agent 改到主機 Codex 會讀的設定。
  實測：審查者寫檔得到 `Read-only file system`；作者寫的檔案在主機上屬於我；兩者都看不到主機的家目錄、都無法 commit；
  按停止 2 秒內容器消失。Claude 目前仍在主機上跑（auto 權限），之後可以沿用同一套容器做法。
- **Decision (2026-11-15): Claude can run in the same container, opt-in with `AGENT_HUB_CLAUDE_RUNTIME=docker`.**
  On the host Claude has Bash and can read the whole home directory, including the Hub token in `data/`.
  The `auto` classifier was its only guard, which made it the weakest boundary in the Hub.
  - **How it runs.** The adapter passes the Agent SDK's `spawnClaudeCodeProcess`, which runs
    `docker run --rm -i --init` with the exact Claude Code binary the SDK resolved, mounted read-only.
    The CLI therefore cannot drift from the SDK, and no build argument or wrapper script is needed.
  - **Same image and mounts as Codex.** It reuses the Codex image and toolchain images and the Codex
    mount rules (`claude-docker.ts`), and adds a read-only mount for read-only turns, so Bash cannot
    write there either.
  - **Environment allowlist.** Only Claude Code's own variables cross in, because the SDK hands the
    spawner the server's whole environment.
  - **Separate login and history.** Login and conversations live in `data/claude-home`, apart from
    `~/.claude`. A host-era conversation is copied in the first time it resumes.
  - **Why not the SDK's own `sandbox` setting.** On Linux it uses bubblewrap, which hits the same
    AppArmor user-namespace block that forced Codex into Docker.
  - **What Claude loses.** In the container Claude loses the host's `gh`, `docker`, `ssh` and
    user-level settings, the same gap Codex has. Devices are reached through the Hub's `ssh_exec`, and
    pushes and PRs stay the Hub's job.
  - **Default stays `host`.** An automatic deploy must not leave Claude without a login. Flip it after
    `pnpm claude:login`.

### 7.3 SSH（需求 2）

依照我的選擇，**指令不跳確認，全部直接執行**。所以安全措施要放在工具層：

- **主機白名單**：agent 只能連 `hosts` 表裡登記過的主機，在介面的「設備」頁管理。
  （目前這台機器沒有 `~/.ssh/config`，之後有的話再加匯入功能。）
- **執行身分分開**：每台主機登記一個專給 agent 用的帳號和金鑰，權限開到夠用就好，
  不要拿 root 或我自己的主帳號。這是真正擋得住錯誤的那一層。
- **主機分級（選用）**：主機可以標記為 `prod`。標記後在介面上特別顯示，之後若要對 prod 加確認，只需改這裡。
- **全部記錄**：每一次呼叫都寫入 `ssh_log`，在任務畫面顯示為可以展開的一行。
- **逾時**：預設 120 秒。長時間的工作建議用 `nohup … &` 背景執行，之後再查結果。
- **實作**：一份 `ssh_exec(host, command, timeout?)`。Claude 在同一個 process 內掛上去；Codex 走 stdio MCP server。

**Claude 本身的工具權限（Step 3 之後，2026-10-14 決定）**：預設用 Claude Code 的 `auto` 模式，而不是全部放行。
每個工具呼叫先由分類模型判斷是允許還是拒絕；分類模型判斷不了時，網頁上會出現 Allow / Deny 卡片，任務狀態變成
`waiting_user`。按停止、server 重啟時，等待中的請求會自動取消或過期，不會卡住。實測：分類模型直接放行了唯讀的 `ls`，
也直接放行了明確要求刪除 `/tmp` 測試目錄的 `rm -rf`。要改回全部放行，設 `AGENT_HUB_CLAUDE_PERMISSION=bypassPermissions`。

### 7.2.1 Task base and planning checkout

A task can name a branch on origin as its base, for a change stacked on unmerged work. The stack is only
that link: nothing records it separately, and nothing rebases a layer yet. A plan with a base reads a
detached worktree at it instead of the user's checkout, because a spec written against a feature branch
can name code a worker from `origin/main` does not have. `task.cwd` stays the repository, since settings,
forge lookups and proposals are keyed by it. Only the agent's working directory moves, and the worktree is
refreshed each turn and removed with the task. Existing plans have no such worktree and keep their checkout
so their resumed sessions keep working.

### 7.3.1 E3 tools

The user's `e3sync` owns E3 access and sends deadline reminders without a model. Agents reach it as
`e3_*` tools on the Hub's tool server, not as an MCP server handed to each agent, because Codex's
container must not see the binary or the cookie. Each call starts one `e3sync mcp` (`tools/e3.ts`) with the
transport's default environment, and the turn's abort stops it. Only chat grants get
`e3_download_material`: planners get no tools that write, and implement and review have no use for it. The
tools take no URL, so an agent can only fetch what a course lists. Downloads land outside the task's
working directory, so a Codex agent cannot read them; reading materials is a separate decision.
Claude allows these tools without a prompt, like the other Hub tools. Gemini has no tool access.

### 7.4 影片逐字稿（需求 5）

```
貼網址
  ▼
yt-dlp 抓字幕（含自動字幕，優先中文、英文）
  ├─ 有字幕 → 轉成純文字，保留時間戳記
  └─ 沒有字幕 → yt-dlp 只抓音訊 → 本機 Whisper 轉文字
  ▼
Claude 整理：摘要、章節（含時間戳記）、重點
  ▼
存成 Markdown，顯示在介面上；這個任務本身就是一段對話，可以繼續追問
```

- 呈現方式之後再決定，第一版先輸出 Markdown。
- **實作紀錄（Step 5，2026-10-14）**：yt-dlp、ffmpeg、faster-whisper 都放在 media 容器裡，主機不用安裝。
  ARM 上的 ctranslate2 只有 CPU 版，所以 Whisper 先用 CPU（`small`、int8），19 秒的音訊約 4 秒。大部分影片有字幕，
  用不到 Whisper；如果之後常遇到沒字幕的長影片，再換 GPU（這台的 NVIDIA 容器工具可以把 GPU 給容器用）。
  - 自動字幕只取影片原語言（`*-orig`），不取 YouTube 的機器翻譯。
  - 摘要語言由程式決定：只貼網址或附註有中文就用繁體中文，標題固定為 摘要／章節／重點。原本交給模型判斷時，
    英文提示詞讓它寫成了英文。
  - faster-whisper 1.2.1 需要 PyAV 15（16 以後拿掉了它用的參數），所以映像檔鎖定 `av==15.1.0`。

## 8. 重啟與中斷：可恢復 ≠ 可重跑

DB 保存每一次狀態轉移和事件，所以 server 重啟後，任務和歷史紀錄都完整。但**正在跑的那一次執行不能自動重跑**，
因為它可能已經做了一半有副作用的事（commit 了、ssh 改了設定、部署了一半）。

server 開機時：

1. 狀態是 `running` 的任務一律改成 `interrupted`，並記一筆 event。
2. 找出中斷前最後幾個工具呼叫，標示有副作用的那些（ssh、git commit、shell），讓我一眼看到「可能已經做了什麼」。
3. **不自動重跑。** 由我決定：接續（用原本的 thread 告訴 agent 剛剛被中斷了）、重來，或結束任務。

**實測紀錄（Step 3，2026-10-14）**

- **正常關閉（Ctrl+C / SIGTERM）**：server 會先中止所有執行中的 turn，SDK 會連帶結束 Claude Code 子程序，
  所以不會留下孤兒程序，跑到一半的指令也會被終止。任務狀態刻意保持 `running`，下次開機才會被標成
  `interrupted`，不會被記成「你按了停止」。
- **強制終止（`kill -9`、斷電）**：Claude Code 子程序會變成孤兒，**繼續把手上的工具呼叫跑完**。實測時，
  一個 25 秒的指令在 server 死後仍然完成並寫出了檔案。這正是「可能做了、也可能沒做完」清單存在的理由：
  按 Continue 後，Claude 會先檢查實際狀態，發現檔案已存在，就不會重跑。
- Claude Code 會把前景的 `sleep N` 改成背景執行；背景工作結束時，同一次 query 會再跑一輪，產生第二筆
  `turn_result`。Hub 可以正確處理一個 turn 裡有多筆結果的情況。

## 9. 技術選型

| 元件 | 選擇 | 理由 |
|---|---|---|
| 前端 | React + TypeScript + Vite | 生態完整 |
| UI 元件 | Tailwind + shadcn/ui | 好客製化，不用自己刻元件 |
| Diff 檢視 | Monaco Diff Editor | 接近 VS Code 的體驗 |
| 後端 | Node.js + TypeScript + Hono | 好整合兩家 SDK，輕量 |
| 即時更新 | SSE（收）+ HTTP POST（送） | 事件只需要 server 推到網頁，單向就夠；比 WebSocket 簡單 |
| DB | SQLite + Drizzle | 不用另外架資料庫 |
| 排程 | 自己寫的 queue，狀態存在 SQLite | 先不引入 Redis |
| 程式碼隔離 | git worktree | 每個任務獨立的工作目錄 |
| Claude | `@anthropic-ai/claude-agent-sdk` | 使用 Claude Code 的登入 |
| Codex | `@openai/codex-sdk` | 支援建立、接續 thread 和串流事件；使用 ChatGPT 登入 |
| 影片 | yt-dlp、ffmpeg、faster-whisper 或 whisper.cpp | 在本機處理 |

## 10. 專案結構

TypeScript monorepo（pnpm workspaces），**一開始只拆三塊**，等某塊真的長大了再拆出去：

```
agent-hub/
├── apps/
│   ├── web/          # React UI
│   └── server/       # Hono、SSE，以及現階段的所有核心程式：
│       └── src/
│           ├── core/        # task、scheduler、event stream
│           ├── agents/      # claude / codex adapter
│           ├── workflows/   # chat / implement / review
│           ├── tools/       # ssh / git / shell
│           ├── workspace/   # worktree
│           └── db/          # drizzle schema
├── packages/
│   └── shared/       # 前後端共用的型別（API、event）
├── docs/
│   └── design.md     # 這份文件
└── data/             # gitignore：SQLite、worktree、影片產物
```

`server/src/` 底下的資料夾就是之後拆 package 的邊界。等要開源，或有第二個程式要用到 `agents/` 時，
再把它搬到 `packages/agents/`。不要一開始就拆成七個 package。

## 11. 開發步驟

| 步驟 | 內容 | 完成的標準 |
|---|---|---|
| **Step 1** | 設計文件（本文件） | 我看過並同意 |
| **Step 2** | 網頁介面：任務清單、對話區、狀態顯示，先用假資料 | 畫面能點、能切換，版面確定 |
| **Step 3** | 後端 + Claude：任務存進 DB、串流、同時跑多個任務、重啟恢復 | §2.2 的 MVP 驗收全部通過 |
| **Step 4** | Codex adapter、worktree、`implement` / `review` workflow、Monaco diff、跑測試、人工驗收 | 一個需求可以跑完「改 → 審 → 修 → 測試」，最後由我合併 |
| **Step 5** | SSH 主機管理、影片逐字稿、`custom` workflow | 叫 agent 去設備查狀態；貼網址拿到摘要 |

## 12. 待決定

- [ ] 影片整理的呈現方式：使用者想用一份 prompt（輸出範本）把結果規範成固定格式（2026-10-14 提出，之後做）
- [ ] `review` workflow 的預設輪數，以及「兩個都審」時意見衝突怎麼處理
- [ ] 同時執行的任務上限
- [ ] 要不要開放手機透過 tailscale 連線
- [x] Subscription quota is shown in the sidebar and phone task list; see Live subscription quota below.

## 13. 風險

- **訂閱用量**：多任務加上 review 來回好幾輪，額度用得很快。要有輪數上限和同時執行上限；任何程式都不能無限重試。
- **SSH 不跳確認**：agent 判斷錯誤時會直接改到設備。保護靠白名單、專用帳號的權限和紀錄（§7.3）。
- **SDK 變動快**：Codex SDK 還在 0.x，兩家都包在 §5.1 的 adapter 後面，變動只影響那一層。

## Live subscription quota

Quota is a replaceable account reading, not task state, context capacity, token balance, or API billing.
Adapters own all provider protocols: Claude's experimental SDK usage control method is called without
iterating a prompt, and Codex's pinned CLI App Server performs initialization, account read, and rate-limit
read without starting a thread or turn. Codex Docker queries mount only the configured login directory,
use the existing image and orphan label, and have bounded process/output/container cleanup. Unsupported
APIs or non-subscription accounts degrade to unavailable; raw provider errors are discarded.

A Hub-owned in-memory service caches each configured adapter/login, coalesces concurrent ordinary/manual
requests across tabs, and enforces a ten-second manual cooldown. Visible browsers poll every five minutes
and at due reset boundaries; hidden browsers pause and refresh due data on return. Failures back off from
one to five minutes independently per provider and retain the last successful reading as stale. Successful
readings expire after five minutes or at any displayed reset; affected windows show awaiting update,
never inferred full allowance. Repeated source timestamps already in the past wait until the next ordinary
interval rather than creating a refresh loop. Manual refresh bypasses ordinary freshness caching.

The desktop sidebar keeps a wrapping summary outside the task list scroll area. Phones show the same
summary on the task list, with an accessible modal for bucket/window percentages, browser-local reset
dates and countdowns, last successful updates, and manual refresh. Restart discards the cache and in-flight
bookkeeping; the next authenticated initialization queries again. No database schema or task events are
needed for polling. Quota-aware scheduling, normal-turn agent switching and history remain future work.

Auxiliary PR metadata, change briefings and diff explanations use the other configured agent when a
primary quota window is exhausted with a future reset and the other agent is not exhausted. A
usage-limit failure refreshes quota once and permits one retry with the other agent if no fallback
has happened; other failures, aborts and timeouts never retry. Unknown quota does not imply exhaustion.
Successful events record `writtenBy` and optional `fallbackFrom`; final quota failures retain the
agent and reset time. PR fallback uses a separate writer session with a fresh thread for every call,
leaving the coding author and reviewer sessions intact.

Compatibility was checked against the installed Claude Agent SDK 0.3.296 declarations and schemas generated
by the pinned Codex CLI 0.162.1, including nullable windows and the multi-bucket response. Tests use scripted
adapters and mocked transports; they do not verify live account availability or invoke vendor quota endpoints.
The experimental Claude API and account-specific Codex quota availability can still fail at runtime.

## Read-only project knowledge

A repository's optional `documentsDir` in the existing data-directory `repos.json` is saved in planning
task options. New configuration affects new plans; document contents are read live. Before each planning
adapter run, the host reads a bounded root README, frames it as background separate from Hub authority
and the user request, and persists the exact result/status in a normal completed read-only tool event.
The three shared planning MCP tools provide bounded outline discovery, literal search and targeted line
reads. No index or model summary is required; planners make worker briefs self-contained.

Document-only settings are excluded from coding publication settings. Existing explicit conventions
and global references keep their semantics. Document directories are not native agent references or
mounts. Canonical containment, excluded components, symlink and special-file rejection apply to Hub
reads, not a host-wide Claude sandbox. Documents never grant authority. See the planning guide for
file types, budgets, continuation behavior and unavailable statuses. Document writes, findings and
commits belong to the later #12 workflow, not this read-only phase of #14.

## Scope signals and governed finding exports

Out-of-scope observations are typed `finding_recorded` events, separate from `review_result.findings`.
Each turn's MCP grant binds them to its task/session and canonical original project; agents cannot
select another project or output root. Exact submission digests deduplicate retries, while project/topic
identity combines later evidence into one logical observation. `list_findings` is a bounded pageable
catalogue, not semantic deduplication. Worker reports include bounded finding/export summaries through
`reportsTo`, without waking the planner for each record or dispatching corrective work.

Task options independently snapshot export directory/owner and optional structured scope estimates.
Document-only repository settings retain ordinary coding/publication defaults. Event projections rebuild
finding state after restart; startup does not replay external writes. Normal turn completion and an
authenticated task-scoped retry are the only export entry points. Existing workflow readiness, review
parsing/limits and fresh-user-message gates remain authoritative.

The focused exporter serializes canonical document repositories and journals batches before file writes.
It requires a distinct clean Git repository and confines files to `personal-view/agent-findings/`.
Managed content hashes, Draft status and directory descriptors protect against human edits and path
replacement. Files are fully staged before exclusive replacement, with retained original inodes and
hash-checked journal recovery. The asynchronous Git/filesystem path has finite Git timeouts and
cancellation; a canonical-root promise chain waits and re-projects pending work for every caller.
Normal reports and HTTP retries await completion without blocking unrelated tasks. Historical
observations enrich same-root authorized topics; another document repository cannot process them.
The note itself is canonical for its observation, the README defines governance, and Hub events
provide provenance. Fixed Traditional Chinese output lives in a dedicated zh-TW dictionary.
Captured blobs in a private index form the commit; a ref compare-and-swap and index lock
avoid committing unrelated staged files. Commit markers and journals reconcile interrupted progress.
Unknown file/index changes remain conflicts. Notes stay unverified Tech Debt drafts, with Traditional
Chinese prose and configured ownership; ADRs remain authoritative. No external synchronization,
resolution, promotion, tickets or general artifact/job framework is introduced.

Diff estimates compare cumulative file counts and additions plus deletions to saved optional maxima.
Binary line counts remain explicitly unknown. The same presentation appears on phone, desktop,
snapshots and reports, and derives warnings from durable options/events after reconnect or restart.
Warnings never pause work, rewrite scope, change a review verdict or authorize new fixes.

## Whole-change briefing at the PR boundary

A briefing is an event-backed reference card, separate from hunk explanations, author prose and the
review verdict. Only explicit implementation PR prepare/open or briefing retry/rewrite can generate
it. The common Hub boundary serves UI/API and planner `open_pr`; team publication still requires a
human-confirmed draft. One successful structured result deterministically renders the Hub Markdown
and a single Traditional Chinese collapsible appendix. The editable main template retains its own
language and metadata. Saving edits persists a new draft; a rewrite preserves those edits and requires
fresh confirmation. Generated HTML/fences cannot replace the controlled wrapper.

`briefing_started`, `briefing_completed` and `briefing_failed` retain generation identity, outcome,
bounded content and captured base/head/tree/context/style provenance. In-flight controllers/promises
alone are transient. Reuse compares code trees and relevant input/style hashes, excluding briefing
and publication events; publication squashes with unchanged trees remain current. Old successful
content survives failures with stale/failed status. Source reads use immutable ordinary Git blobs,
never mutable checkout files or main. Dirty/concurrent changes fail before accepting or publishing.
Stop/timeout/shutdown/restart cannot accept late results or trigger automatic retries.

Host-collected requests, evidence, manifests, full cumulative patches and committed source feed an
isolated tools-disabled AgentAdapter call with the author's existing defaults. No MCP, finding/export,
external document directory, dispatch or shell authority is granted. README/AGENTS and identified
explanation-style guides, including the optional issue-named guide, are presentation data only.
Coverage and structured-output validation fail closed at the documented [configuration limits](configuration.md#whole-change-pr-briefing). Fake scripts
verify lifecycle and source binding, not real-model explanation quality. Mermaid is lazy-loaded,
strict, bounded to a non-interactive flowchart subset and rendered with source fallback; global renderer
configuration is serialized and component lifetimes discard old theme/unmount results. General
Markdown HTML remains disabled. Interactive Q&A and learning/artifact frameworks remain deferred.

## Global pinned task shortcuts

`TaskOptions.pinnedAt` is an optional server-owned projection of a typed `pin_changed` event.
The authenticated `POST /api/tasks/:id/pin` accepts only `{ pinned: boolean }`. An immediate SQLite
transaction reads the current state, allocates an ascending pin timestamp, inserts the event and
updates only the options projection. Exact-state retries do nothing; publication follows commit.
Pin changes leave activity/updatedAt, workflow evidence, briefing source and PR confirmations intact.
No new table, migration, task queue or persistent memory cache is involved.

Normal task reads and task-list snapshots include pins. Existing SSE task upserts and buffered
reconnect replay synchronize devices, including unopened tasks and deletion. Pin HTTP responses do
not replace client task records, which could overwrite newer streamed lifecycle state. The existing
task-list fingerprint excludes pin metadata, avoiding repository/status recomputation.

The scrollable sidebar derives global shortcuts from existing project/tree rows, retaining inherited
projects, aggregate parent status, path hints and available parent titles. Shortcuts never contribute
to project counts or expand children. Original rows remain in place; project collapse is still a browser
preference. Pins sort by server timestamp then task ID; parent/child pins are independent and deletion
removes only the deleted task's shortcut. Native sibling selection/pin buttons support touch and keyboard,
share transient per-task pending/error state and use the existing dictionaries. Manual ordering,
numbered slots, keybindings, limits and per-user ownership remain deferred.

## Explicit chat/plan handoff

A task may retain several historical main sessions; `options.activeMainSessionId` selects its current
main session. Legacy tasks fall back only when exactly one main exists. A present invalid reference
is an error, never a reason to choose a retired thread. `options.mainHandoffId` links the durable
`handoff_completed` event. This uses existing task JSON and events without a schema migration.

An authenticated command supplies the expected source session and opposite configured backend. A
quiescent task reserves one normal concurrency slot for an isolated tools-disabled outgoing summary.
`handoff_started` and `handoff_failed` preserve operation identity, source identity/range and outcome;
Stop/shutdown abort its controller. No ordinary turn result, review state or completion notification is
created. An atomic transaction inserts one fresh destination main, completion material and active
references; events publish only after commit. Source identity excludes pin/status presentation events,
but includes dialogue, asks/proposals/reports and current child state. Latest task options preserve pins.

Bounded summary, separately bounded original dialogue and a host-owned image manifest are event data.
Earlier notes cover their source prefix; subsequent evidence extends them without recursive notes.
The first normal incoming SDK call receives peer context before its real request, while fresh system
instructions and MCP grants remain separate and authoritative. `handoff_delivery` records attempted
versus successful delivery tied to the SDK thread. Failed calls keep context available, even if a thread
ID was emitted. Restart clears only the selected conversation's thread and therefore resupplies its
note. Unconfirmed earlier inputs are explicitly historical, never new work authorization. Startup
marks incomplete operations interrupted and never retries a model. See [configuration](configuration.md#change-agent-within-chat-or-planning-8-phase-1) for finite bounds,
image omissions, failure behavior and manual/real-backend verification limits.

## Explicit public issue requirements records

Issue comments are an auxiliary host operation, independent of planning turns and worker dispatch.
`propose_task.issueSummary` is optional bounded public Traditional Chinese data from the existing turn;
the self-contained English implementation spec is never copied into the comment. Proposal and initial
draft commit in one SQLite transaction, with SSE released only after commit. Draft events bind the
proposal event/content identity, normalized repository/issue, source reference, exact body/hash and
operation/revision. Append-only outcome events record preparation, write intent, publication ID/URL,
definite failure or uncertainty; no schema or in-memory-only durable state is added.

Authenticated task-scoped edit/confirm/reconcile commands cannot change destination or implementation
instructions. Revisions and later same-issue proposals invalidate stale confirmation; dispatch alone does
not. Only UI confirmation can initiate POST, with intent durable beforehand. Published versions are
idempotent; ambiguous operations only reconcile exact remote marker/body/destination and host author
through a bounded complete search. No match is not permission to repost, and startup only records
interrupted intent as uncertain. This is conservative duplicate prevention, not a mathematical
exactly-once guarantee. Saved history survives planner handoff without granting agreement or tool authority.

## Google access

Google access belongs to the Hub server. A capability registry maps stable names to explicitly requested
scopes; initially only `drive.read` maps to `drive.readonly`. Every consent includes `openid email`,
incremental authorization (`include_granted_scopes=true`), offline consent, S256 PKCE and a single-use,
ten-minute state. Callback and pasted-loopback modes share the completion path. Pending consent state
may disappear on restart; it is retried rather than persisted.

The versioned credential store is keyed by OpenID `sub` for a later multi-account design, but currently
enforces one account per Hub and revokes a replaced account best-effort. Private files use atomic writes
(0600) under a private directory (0700). Refresh tokens and client secrets remain server-side; access
tokens are cached only in memory. Public API projections contain email, usable capabilities and a
reauthorization flag. No credential goes to agents, prompts, task events, containers or logs.

One injectable HTTP client restricts all Google requests to `https://oauth2.googleapis.com` and
`https://www.googleapis.com`, refuses redirects, and sanitizes transport/provider errors. The
`https://accounts.google.com/o/oauth2/v2/auth` URL is only built for browser navigation. Pasted URLs are
parsed, never fetched. Drive downloads are streamed with size, disk-space, timeout and cancellation
checks; source media is temporary and removed before an agent sees the task directory.

Future Docs, Sheets and Gmail integrations will reuse capabilities and incremental authorization.
Agents will receive Google access only through Hub MCP tools executed server-side, never credentials.
Cloud writes, including writing back a document or sending mail, always require explicit user confirmation.
This phase adds no agent-facing Google tools.

## Invocation usage measurement

The accounting unit is one consumed `AgentAdapter.run` iterable. A small measured boundary wraps
all four call sites: `Hub.streamAgent` (chat/plan/video/implement/review and PR metadata), change
briefings, diff explanations and handoff summaries. Each actual fallback invocation gets a fresh
server UUID; quota/model-catalog control reads and issue-summary text from existing turns get none.
Fresh isolated auxiliaries without a Hub SDK session have null association, while explanations use
their actual selected-provider session. Auxiliary operation IDs link model outcomes to subsequent
validation/publication evidence. Review author/reviewer calls carry explicit round metadata.

`invocation_started` precedes provider consumption; `invocation_finished` is authoritative. The
custom migration adds a partial unique `(type, json_extract(payload, '$.callId'))` index, leaving
legacy events alone and allowing start/final to share identity. Append checks/inserts run in SQLite
transactions; no independent totals table or memory accounting ledger exists. Final records survive
normal reload/reconnect replay. Abort closes pending auxiliaries immediately, even when an SDK is
slow to stop; a late result cannot rewrite the final. Throw, consumer return and normal exhaustion
close the boundary. An abort the Hub causes on purpose records `endReason` beside the provider status:
a planner `ask` stays a cancelled provider call (its usage unknown) with no failure and
`endReason: "planner_ask"`, while user Stop and shutdown keep `failure: "abort"` with `user_stop` or
`shutdown`. Startup finalizes unmatched starts as interrupted/unknown once, without new
provider calls or changing existing task recovery. Task deletion retains its existing semantics.
Lifecycle events do not touch activity time, render in chat, affect briefing evidence or enter handoff
source hashes; they remain inspectable in Events.

Producer evidence is local and version-specific; scripted fixtures test the mapping, not real model
behavior. The installed `@anthropic-ai/claude-agent-sdk/package.json` identifies SDK 0.3.296,
`claudeCodeVersion` 2.1.296 and matching platform-artifact dependencies; its `manifest.json` identifies
the bundled producer. No custom executable is configured by this adapter. Its `sdk.d.ts`
`ModelUsage` and result-message `modelUsage`, `usage`, `total_cost_usd` comments explicitly document:

- `modelUsage` covers the main query pipeline, Task subagents, sidechains and internal compaction,
  excluding helpers outside that pipeline (permission classifier/token probes).
- Per-model totals and USD accumulate across streamed results and can continue saved totals after
  resume/fork; clear resets and startup/crash zeroed counters are possible. The latest observation
  replaces earlier results; result messages are never summed.
- Main-loop `usage` is per-turn and narrower; it is kept as source evidence only, not added to
  `modelUsage`. Thinking is included in output and can be missing or partial after older sessions.
- Fresh input, cache read and cache creation are distinct buckets. Inclusive input is explicitly
  derived; reasoning is never added to output again. USD is an SDK estimate, not a bill.

A fresh non-resumed Claude query uses the new-session baseline. Resumed queries look back over the
same task/Hub session/SDK thread for the nearest trusted reading: a complete, non-zero, identified,
untruncated cumulative observation, whatever status its invocation ended with. It must match source,
SDK/runtime version, coverage, field semantics and model/canonical/provider identity. When it is the
immediately preceding call, the difference is this call's delta. When calls without readings (an ask,
a Stop) sit between, the difference is an unattributed `usage.interval` on the closing call: it names
both bounds and every covered call, and the call's own counters stay unknown. A thread's first call
bounds an interval at zero. Calls are passed over only when they share the producer and counted
nothing themselves (no token and no USD value), so per-call deltas and intervals cover disjoint pairs of consecutive readings.
Newly seen models on resumed sessions remain unknown. Missing fields, missing/truncated/incompatible
baselines and negative/reset counters yield null for affected exact totals (and no interval) while
preserving bounded observations.
A failed zeroed result cannot erase an earlier useful observation or establish measured zero on its
own, including startup errors with an empty model map. Repeated result identities are ignored for
accounting even when replayed after a newer result. The invocation keeps at most 128 identities;
exceeding that budget makes its totals and its eligibility as a resumed baseline unknown. Missing
or truncated model sets leave call totals unknown while retaining proven per-model subtotals.
At most 16 reported model entries and two sanitized observations are retained. Token fields
accept only nonnegative safe integers. USD separately accepts finite nonnegative reported values.
Resumed thinking details remain unknown because older transcript coverage can be partial. No
inference about invisible provider calls or silent positive counter resets is possible.

Codex evidence: the installed SDK 0.162.1 `dist/index.d.ts` declares `Usage` and the installed
`dist/index.js` forwards JSON `turn.completed.usage`. The existing `codexVersion()` reads its exact
CLI dependency, and `codex.Dockerfile` installs that build argument (0.162.1). Host executable version
is not verified by monitoring. These declarations/forwarding and official JSON examples do not prove
the pinned exec producer's first/resumed/multiple-result accounting implementation; a pinned source
lookup was unavailable. Accordingly Codex raw numeric counters are retained with unknown scope,
coverage and cache/reasoning inclusion, and excluded from exact call totals. Cache-write/reasoning
fields missing at runtime stay null despite mandatory declarations. Future support needs producer
source evidence, not a more optimistic fixture. Gemini explicitly exposes unavailable usage without
accessing OAuth state or adding capabilities. Fixtures in `test/fixtures/usage.ts` cite these local
contracts; `usage-adapters.test.ts` uses mocked SDK streams, never live requests.

The authenticated task API separates full-task summaries from detail pages (default 20, maximum
100, strict positive limits/nonnegative safe sequence cursors, increasing final-event order).
Summaries aggregate only final usage events and expose known subtotals with incomplete/unknown
counts; unlike raw input buckets are not added as though identical. Interval usage is reported
separately as `unattributed` and never inside per-call `counters`; their sum is the measured total.
Raw cumulative observations stay per call and are never summed. Derived inclusive input is the
comparable measure when supported. Source/start/baseline event IDs permit audit through Events.
Legacy `turn_result.costUsd` remains compatible and is never counted again. Old tasks without
instrumented events show not recorded; all summaries cover instrumented activity only.

The bilingual desktop/phone panel uses bounded detail pages and refreshes on lifecycle identity or
connection changes, not text deltas. SSE identity prevents duplicate projections; summary totals
come from durable full-task queries. Metadata is allowlisted and bounded, with no raw SDK envelopes,
prompts, tool output, credentials or errors. Subscription quota snapshots use only the existing
read-only cache accessor: bounded windows, remaining percentages, reset/sample timestamps and
staleness, with absent samples unknown. They are shared-account references, never per-call spend.
Tokens, quota, reported/estimated USD and context occupancy remain distinct; no token pricing,
subscription balance, context-capacity inference, tracing service, new refresh schedule or model
probe is introduced.

### Observe-only Host input diagnostics

New invocation start/final events optionally carry version 1 `hostInput` metadata. Legacy events
remain without it; no migration, backfill, separate ledger or provider-usage calculation is added.
Events and the existing authenticated usage detail response expose the same bounded metadata.
The fixed fields measure UTF-8 bytes in the Host's `prompt`, `systemPromptCandidate` and
`turnContext` strings. They are not wire bytes, provider tokens, billing, or context occupancy.
In particular, a Codex resumed call can have a nonempty Host system-prompt candidate even though
the adapter does not resend it. SDK presets, native history/compaction, images, tool schemas and
provider-internal requests are outside this coverage. No token estimate or transmitted-byte total
is inferred. Missing fields or strings over 256,000 UTF-16 code units yield null, not zero or a
truncated measurement. Empty strings measure zero. Diagnostic failures do not cancel or retry calls.

Planner bootstrap components reference the existing `project_docs_bootstrap` event and measure
its returned text and JSON-encoded injected fragment, including framing/status/truncation notices.
They do not measure the full external file. Comparisons inspect only the previous matching event
in the same task and Hub session within 128 event sequence positions; SQL returns at most one
bounded string. Missing, oversized, cross-session or out-of-window evidence is `unknown`.
`same`/`changed` compare the supplied bootstrap result, including unavailable results: `same` is
not evidence that omitted document content is unchanged, already known to the model, or wasteful.
Existing live reads, security budgets, tool-event text and per-turn injection remain unchanged.

Review components measure the sum of raw request-string bytes and the supplied bounded diff,
before `reviewPrompt` formatting. At most 128 requests and 256,000 total request UTF-16 code units
are inspected. Loop-local, length-framed fingerprints compare requests and diff in the same
reviewer session; no fingerprint is persisted or passed to an adapter. A new loop/session starts
`unknown`. An unchanged truncated diff means only the supplied fragment matches. The same rule
applies to integration reviews; no review, dispatch, publication or permission behavior changes.

Components overlap or precede formatting of `prompt`; never add them to prompt bytes. Only fixed
numeric fields, comparison enums and existing event UUID references are persisted, with no new
prompt text, document paths, secrets, error text or durable content fingerprints. Metadata remains
on existing invocation lifecycle events, excluded from handoff/briefing evidence and rendered only
as an event type in planner task-log reads. No diagnostic data is injected into model context.

## Explicit updates of existing PR branches

The host-side Forge boundary reads lifecycle, mergeability, actual target/source names and immutable
SHAs. Lifecycle polling remains available to providers without mergeability support. Only explicit
`CONFLICTING` creates a typed `pr_conflict` event; repeated observations with identical revisions remain
deduplicated through restart. Known clean/closed/changed revisions retire the unresolved observation;
unknown mergeability does not imply resolution. Planner reports use the existing durable queue and
`reportsTo` ownership, keyed by source event sequence. A conflict report asks about updating the same
PR, never opening another one.

`update_pr` requires a task started by that plan and a fresh user message after the latest report/ask
and any consumed update authorization. The planning instruction requires explicit agreement, rather
than interpreting report delivery as approval. The authenticated standalone HTTP action requires an
explicit confirmation with the observed head/target revisions; planning-owned tasks must use their
original conversation. Both enter one Hub operation, reserve a normal concurrency slot, share Stop
and shutdown controllers, and serialize against turns, publication and auxiliary repository operations.
When all slots are occupied, the request is refused for explicit retry. All synchronous gates run
before accepting the operation. After intent is persisted and the slot reserved, update MCP/HTTP
commands return the operation id/stage immediately; HTTP uses 202. The tracked `turnDone` promise
remains available to settled/shutdown, and final outcomes use only the durable report path. The whole
operation body, including reviewer-session creation, is guarded: setup failures persist a terminal
failure, return the task to idle and report to its planner. An authorization marker is recorded only
after a start succeeds.

The operation checks the active branch, clean worktree, pending Git operations, origin identity, open
PR and expected remote revisions. Fetch only updates remote-tracking refs. Merge is a separate,
explicit host-owned write against the fetched target SHA; no rebase or history rewrite occurs. A clean
merge needs only configured tests. A conflicted merge keeps its index for the author, carries original
and cumulative requirements plus bounded conflict context, and uses bounded author/reviewer rounds.
Hub stages resolutions, rejects remaining conflict markers/index entries, and completes even an
unchanged-tree merge commit. Review is read-only; reviewer edits are retained as a failure instead of
resetting local work. Requirement changes and unrelated repairs stop for user judgment. Configured
test failure stops publication. Missing tests are recorded explicitly.

Typed `pr_update` events persist intent, PR identity, pre-update/target/result revisions, stage, review
and test evidence, validation SHA and publication outcome. Test/review events name their operation and
commit. Only the exact clean, resolved, approved/tested result can be pushed, after rechecking PR
identity and target. The push sends that SHA to the same remote branch without force and is never
retried automatically. The update path never invokes the ordinary snapshot publisher; ordinary task
snapshot behavior stays intact. Display/review baselines advance to the fetched target while historical
requests and events remain unchanged. Existing PR titles, bodies and briefings remain untouched.

Restart marks unfinished operations interrupted without running agents or publishing. Owned integration
progress blocks ordinary turns and snapshots until an explicit approved retry completes it or the user
explicitly abandons the safely unpublished integration. Retry checks
the retained merge's target/source and exact completed result; an unrecorded merge commit is accepted
only with the expected two parents. It never resets unrelated edits. An uncertain push is reconciled
against the remote before retry; an already accepted exact result needs no second push. Unavailable
remote evidence leaves uncertainty visible. Closed/changed PRs and unexplained local/remote edits stop
for the user. Lifecycle polling retains a worktree containing an unfinished update even if its PR merges
externally. Reports distinguish detection, update completion, failure and interruption in both languages.

`abandon_pr_update` shares ownership, fresh-user and consumed-approval gates with `update_pr`.
Authenticated standalone HTTP/Diff abandonment requires explicit confirmation; planning-owned tasks
must return to the plan. The operation reserves the same scheduler slot and returns its id/stage
immediately. It is eligible only for an idle failed/interrupted owned update, with no active turn,
publication, briefing or explanation, and no uncertain/published outcome. Forge and `ls-remote` must
both confirm the remote head still equals the original source/pre-update SHA; no remote write occurs.

The intent saves the previous `baseSha`/`prBase` and preserves them through retries. Immediately after
Git merge, before the author runs, Hub records bounded content hashes for non-ignored untracked merge
artifacts. Abandonment allows only pre-update HEAD (optionally with the matching pending MERGE_HEAD)
or the exact two-parent owned merge commit. Unrelated operations/commits, changed artifacts, symlink
cleanup parents, or untracked/ignored files obstructing restoration cause refusal before reset. Hub
runs argument-array `merge --abort` when needed and `reset --hard <preSha>`, then removes only recorded,
unchanged untracked artifacts. It never performs a broad clean or follows cleanup paths outside the
worktree. Missing original baseline/provenance is not guessed. User files outside the merge are kept.

The saved baseline is restored. The terminal `abandoned`, `owned: false` event records any remaining
non-ignored untracked files as `retainedUntracked`: a bounded path list plus the full count. These files
are preserved, shown in Diff and included in the original planner's distinct `update_abandoned` report.
Ordinary messages, scheduling, restart and snapshots remain blocked while a listed path is untracked;
the user must review and stage it, or remove it, before continuing. A truncated list conservatively
blocks on all remaining non-ignored untracked files. Read-only checks survive restart, and viewing Diff
does not stage these leftovers. A new update cannot replace this protection with another intent.
With no remaining leftovers, ordinary turns become available again. Failed/interrupted update prompts
offer retry, abandon, or inspect the existing PR, never a new PR. Publication uncertainty must first be
reconciled with an explicit update retry. Restart never automatically resumes either operation; a
partially completed local abandonment is retained for another explicit, safety-checked decision.

## Durable planning and publication issue relationships

The first validated creation issue or successful active-turn planning read is persisted as a typed
`planning_issue` event and `options.planningIssue` in one transaction. The commit rereads current
options and compares the saved default, preventing concurrent reads or stale turn snapshots from
replacing it or dropping unrelated options. Failed/late reads and listing never establish defaults.
Bounded current planning context makes the durable association available to either backend after
restart or handoff.

Proposal issue omission inherits the plan default, a number overrides only that proposal and null
detaches it. Host Forge resolves numbers using the actual repository. New linked proposals persist
an explicit partial completion mode (Refs); complete requires an explicit choice (Closes). Legacy
missing modes retain Closes without migration. Creation and dispatch preserve overrides/detach and
source/one-start/ticket/user-approval gates. Public summaries bind to the resolved saved proposal issue;
worker and publication overrides cannot retarget comments or change their separate confirmation.

Team draft events save the validated publication selection and exact Hub-generated issue block.
Task options project the latest publication choice as `prIssueLink`, retaining the worker's initial
issue for immutable briefing provenance. Structured edits replace/remove only the exact tracked block;
conflicting human edits require explicit correction in the draft editor. Other prose and protected
briefing appendices remain byte-for-byte unchanged. Draft revisions, source and briefing gates reject
older confirmations. Prepare/rewrite/retry retain explicit overrides and user branch/title/commit/body.
Ordinary PRs render the same deterministic Refs/Closes/none selection without requiring team drafts.
No remote issue-state mutation, historical repair or additional model call is involved.


## Document Core and immutable revisions

Documents are an independent storage domain, not a Task workflow or the external read-only
`ProjectDocuments` knowledge source. The HTTP API uses the existing Hub cookie/Bearer authentication.
The independent Documents UI uses this API. Rooms expose document context and a suggestion-only tool
to their two members; agents cannot save or accept document changes. There is no document SSE or
delete API. Suggestion storage and atomic acceptance are described below.

`documents` stores only the identity and creation time. `document_revisions` stores complete title and
content snapshots, with a unique `(document_id, revision_number)` starting at 1. The highest number is
the current revision; there is no mutable current pointer or duplicate current body. Titles are part of
the snapshot. Read projections join the identity and its tip in one SQL snapshot. Task state remains
event-backed; document state is backed by the immutable revision history, never Task events.

The only canonical content format is `plain_text`, stored as SQLite TEXT. Content preserves whitespace,
CRLF, Unicode and emoji without normalization. Empty content is a valid draft. Titles are trimmed and
must occupy 1–200 UTF-16 code units, with no line breaks, NUL or unpaired surrogates. Content must be
well-formed Unicode without NUL, at most 256 KiB of UTF-8 bytes. The HTTP reader counts actual incoming
bytes (including JSON whitespace/escapes), caps the body at 2 MiB even with misleading Content-Length,
and accepts only uncompressed UTF-8 JSON. Client-supplied IDs/timestamps and unknown body fields fail.

The synchronous Documents service uses immediate SQLite transactions for create, save and restore.
Create commits the identity and first snapshot together. Save/restore compare `expectedRevisionId`
inside the write transaction before appending; stale requests return 409 without writing. A save with a
fresh expected revision and identical title/format/content returns `revisionCreated: false` without a
new revision or timestamp. Restore copies the historical title/format/content into a new revision and
records `restoredFromRevisionId`, even when the source equals current. The source must belong to the
same document. Transaction failures roll back completely; locks return 503 with Retry-After, not 409.

Foreign keys are explicitly enabled and verified on each application connection. The document migration
adds only the two new tables, indexes, constraints and three revision triggers: reject UPDATE, reject
DELETE, and guard INSERT for duplicate identity/sequence, continuous numbering, and same-document
restore sources. The insert guard rejects REPLACE before SQLite can implicitly delete an old snapshot.
**These custom triggers are not modeled in Drizzle snapshots. Preserve them in future document
migrations, including table rebuilds, and verify their behavior after upgrade/reopen. The three
`document_suggestions` guards from `0008_tense_captain_flint.sql` must also be recreated verbatim
after any suggestion table rebuild (as in the room source migration).** Schema changes still require drizzle-kit
generation. Existing Task/Session/Event tables are neither rebuilt nor rewritten by this migration.

| Endpoint | Request | Success response |
| --- | --- | --- |
| `POST /api/documents` | `{ title, contentFormat: "plain_text", content }` | 201 DocumentDetail; Location points to the document |
| `GET /api/documents` | `limit=50` (1–100), `offset=0` | `{ documents: DocumentSummary[], nextOffset }`, no content |
| `GET /api/documents/:id` | None | DocumentDetail with its current full revision |
| `PUT /api/documents/:id` | Full content fields plus `expectedRevisionId` | `{ document: DocumentDetail, revisionCreated }` |
| `GET /api/documents/:id/revisions` | `limit=50`, optional positive `beforeRevisionNumber` | `{ revisions: DocumentRevisionMetadata[], nextBeforeRevisionNumber }`, no content |
| `GET /api/documents/:id/revisions/:revisionId` | None | Full DocumentRevision, scoped to that document |
| `POST /api/documents/:id/revisions/:revisionId/restore` | `{ expectedRevisionId }` | `{ document: DocumentDetail, revisionCreated: true }` |

DocumentDetail is `{ id, createdAt, updatedAt, currentRevision }`; updatedAt is the tip's creation time.
Revision has `{ id, documentId, revisionNumber, title, contentFormat, content,
restoredFromRevisionId, createdAt }`. Lists sort documents by immutable creation time and ID descending;
offset pagination is not a snapshot across requests. Revisions sort by number descending; a history
cursor excludes that number. Query integers must be canonical decimal safe integers. IDs are server
UUID v4 values; input IDs accept either case and normalize to lowercase.

Document responses, including failures and 401s, set Cache-Control: no-store. The error shape is
`{ error, code, currentRevisionId? }`. Invalid input/IDs/pagination/format are 400; existing Hub auth
returns 401 unchanged; missing documents or foreign/missing revisions are 404; `revision_conflict` is
409 with only the current revision ID; oversized payloads are 413; unsupported media/encoding is 415;
`storage_error` is a safe 500; `storage_busy` and an unconfigured `documents_unavailable` are 503.
The document namespace sanitizes unknown errors before the generic logger, because SQL/Drizzle errors
can contain body parameters. Do not enable query logging, attach raw causes, or log request text.

Create is not idempotent: identical POST bodies create separate documents. Do not automatically retry a
lost create response. Repeating a successful save/restore with the old expected ID returns 409 without
another revision. A conflict requires re-reading and an explicit resolution, never silent rebasing.
Snapshot storage grows with history; there is currently no purge, soft delete, retention policy or
multi-user ACL. Existing shared-token access is the security boundary. Future rich text requires an
explicit new format/schema and migration; old plain-text snapshots must retain their original format
and bytes. Rich text editing remains separate work; manual suggestion storage and operation receipts are
described below.


## Document Editor workspace

The Documents sidebar entry opens a separate workspace (`?view=documents&document=<id>`), using the
shared Document DTOs and seven existing API endpoints. The desktop shows a document list and editor;
phones show either the list or editor, with revision history in a dialog. There is no placeholder chat
pane. Task/Agent state is never used to store document content or drive a save.

Desktop navigation keeps the existing in-memory view strategy: entering/leaving Documents or selecting
a document replaces the current browser entry and updates its query/state; it does not push an entry
per view or document. Browser Back therefore skips those internal switches, and Forward returns to the
last replacement. Use the in-app document list to switch documents. Other desktop Task/Devices switches
retain their existing behavior. Phone navigation still has its separate two-level Back/Forward stack.
Neither strategy provides persistent draft recovery when a browser traversal unloads the page.

The native textarea edits **LF-only** content. New documents start empty. A saved body containing any CR
is projected to LF for read-only display while its complete canonical string stays in memory. A
**title-only save uses the original canonical body**. Only an explicit click on Convert and edit
creates a local editable LF draft (no second confirmation dialog: conversion is local and reversible by Discard); conversion does not write. Save appends a revision through existing
CAS, leaving the original snapshot in history. Discard returns to the latest acknowledged snapshot.
Restoring a non-LF snapshot re-enables the conversion gate. No mixed-EOL edit mapping is attempted.

`document-text.ts` owns pure validation, conversion, statistics and UTF-16 selection. The editor session
keeps raw textarea input separate from a validated save candidate: NUL, incomplete surrogate pairs,
oversized input and IME composition remain visible and dirty. Save is blocked until valid and composition
has ended. React synchronously adopts the DOM input without normalizing it or remounting the textarea
on each save; Undo/Redo belongs to the browser. Programmatic session switches, discard and restore are
explicit replacements, not an undo history spanning documents. Word counts are English-token estimates;
characters count Unicode code points in the LF display, including whitespace; bytes count canonical UTF-8.

`DocumentWorkspaceModel` is a UI-local external store owned by App above the authentication rendering
branch. It holds one active document session, list metadata, revision metadata and a read-only preview.
No document bodies or drafts enter browser storage, URLs, telemetry, SSE or console logs. Switching Hub
views retains the session in memory. Replacing a dirty session requires confirmation; browser unload
uses the native warning. Mobile Back/Forward keeps the retained session; these warnings do not provide
crash/reload recovery, and mobile browsers may terminate without firing beforeunload.

A save captures an immutable request snapshot and the base revision ID. A single flight covers create,
save and restore. Typing remains enabled during save. On acknowledgment the returned revision becomes
the new base, while input typed after submission remains dirty; the next save uses that new base ID.
In particular, after converting a CR document, saving A and continuing to B, discard returns to the
acknowledged LF A rather than the old CR snapshot. Late GET responses cannot replace newer input.

409 retains the draft and blocks further saves until the user explicitly inspects/discards and reloads;
it never substitutes the server ID into the draft. 401 keeps the memory session and offers cookie
recheck after signing in in another tab. Failed writes are never automatically retried. Network or
unreadable responses are marked as unknown outcomes. Create failures have their own `createError` and
`createUnknown` state; they never change the existing editor's phase, error or unknown update outcome.
The workspace warning survives closing the create dialog, having no editor, inspecting the list,
switching documents and saving other documents. The list can be incomplete: absence (or a matching
title) does not establish which Create committed. Each additional Create while uncertainty remains
requires a fresh explicit duplicate-risk checkbox. The model checks and consumes the warning's current
confirmation version, so a stale checkbox cannot authorize another POST. Known 400/401/503 failures do
not introduce uncertainty or erase an earlier unresolved Create. Successful new creates also do not
prove the earlier request failed. This remains page-memory state, included in the unload warning;
there is no automatic resolution, retry, idempotency key or backend protocol change.

Restore requires confirmation, uses CAS, and adopts its returned snapshot before a follow-up GET: a
failed GET retries only the read, never the committed restore POST. Both success and failure of that
read check the editor identity, session key, navigation generation and latest refresh sequence. A late
refresh for A cannot replace B or report an A failure there; an older request cannot clear or introduce
the newest refresh status even if the document ID stays the same.

Selection carries document ID, base revision ID, UTF-16 range and draft version. A dirty selection is
explicitly local (`revisionId: null`), never falsely attributed to a saved snapshot. Input, title edits,
composition, conversion, save, restore, document/view switches and preview opening invalidate selection.
A separate manual suggestions panel freezes a saved selection before opening its dialog, as described
below. No provider integration or automatic document editing is involved.

The client uses cookie credentials, no-store requests and structured safe document errors; it never
renders server error text/SQL parameters. The body limit is 262144 UTF-8 bytes and the encoded request
limit is 2 MiB. No new dependency, schema, migration or backend workflow is required. Future rich text
must introduce an explicit format contract rather than reinterpret plain-text revisions.

Automated tests cover the state races with deferred promises, client/auth errors, raw invalid input,
selection and navigation. After building the web application, the optional
`scripts/check-document-ui-browser.mjs` runs installed Chrome against
`apps/server/test/fixtures/documents-ui-server.ts`, a loopback-only FakeAdapter server and temporary
SQLite database. It uses fictional content and a fresh browser profile, performs native input/Undo/Redo,
simulated composition, real API saves and restore, and responsive/history checks. This is not evidence
for physical OS IMEs, virtual keyboards, Safari/Firefox or macOS shortcuts; those need manual acceptance.


## Manual document suggestions and atomic acceptance

The backend supports persisted suggestions independently of Tasks and quota. The manual review UI
uses `manual_import`; room tools use `claude` or `codex`. Importing data itself never calls a model.
The source records the import path; room tool sources are bound to the authenticated session by the
server. A source supplied through the ordinary import API is not verified provider provenance.

`document_suggestions` stores its server UUID, document ID, case-sensitive import request ID, source,
base revision ID, half-open UTF-16 selection offsets, exact original text, a server-computed SHA-256 of
its UTF-8 bytes, replacement text, pending/accepted/rejected state, accepted revision ID, creation time
and resolution time. The base and receipt reference immutable revisions of the same document. Unique
indexes enforce `(document_id, import_request_id)` and accepted revision identity; an index on document,
creation time and ID supports metadata lists. No current document pointer or revision schema is added.

The immutable payload cannot be updated. Inserts start pending; only pending -> accepted/rejected is
allowed. Terminal records cannot change or be deleted. Custom SQLite insert/update/delete guards also
reject REPLACE collisions before SQLite can implicitly delete another record. These guards, like the
three existing revision guards, are not represented in Drizzle snapshots and must survive future
migrations. Foreign keys remain enabled and verified per connection.

### Suggestion API

All routes use the existing Hub Cookie/Bearer authentication, document no-store middleware and safe
error handler. Lookups always scope the suggestion ID to its document. Cross-document IDs return 404.
JSON must be uncompressed UTF-8; actual raw request bytes, including whitespace and escapes, cannot
exceed 2 MiB. Unknown fields are rejected, including Prompt/Context/provider fields.

The base path below is `/api/documents/:id/suggestions`.

| Endpoint | Request | Success |
| --- | --- | --- |
| `POST /` | `{ importRequestId, source: "manual_import" | "claude" | "codex", baseRevisionId, selection: { startUtf16, endUtf16, originalText }, replacementText }` | 201 `{ suggestion: SuggestionDetail, replayed: false }` with Location; exact-key replay returns 200 and replayed true |
| `GET /` | Optional limit (default 50, maximum 100), offset, status, importRequestId | `{ suggestions: SuggestionMetadata[], nextOffset }`; no original or replacement text |
| `GET /:suggestionId` | None | SuggestionDetail with exact original/replacement text and permanent receipt metadata |
| `POST /:suggestionId/accept` | `{ expectedRevisionId }` | `{ suggestion: SuggestionMetadata, acceptedRevisionId, acceptedRevisionNumber, replayed, document: DocumentDetail }` |
| `POST /:suggestionId/reject` | `{}` | `{ suggestion: SuggestionMetadata, replayed }`; no revision is created |

List order is creation time then ID descending. Offset pagination is not a cross-request snapshot;
callers deduplicate by ID and restart at the first page when refreshing. `importRequestId` is an exact
filter for reconciling an uncertain import. Import keys contain 16-96 ASCII letters, digits, `_` or `-`;
they are case-sensitive operation identities, never authentication credentials.

Selection must be nonempty, contain 1-16384 UTF-8 bytes and have safe integer UTF-16 offsets with an
exclusive end. Boundaries cannot split a surrogate pair. Original text must exactly equal the saved
base slice. Replacement can contain 0-65536 UTF-8 bytes; empty means deletion. Equal original and
replacement returns `no_change` without a record. Base and replacement must be LF-only. Neither
whitespace nor Unicode normalization is applied. NUL and unpaired surrogates are rejected. The entire
spliced document must remain within the existing 262144 UTF-8 byte limit. SQLite length is not used to
interpret UTF-16 offsets; the service validates and slices the JavaScript string.

### Import, CAS and permanent receipts

Import uses a synchronous immediate transaction. The same document/key and exact immutable payload
returns the existing suggestion, including after acceptance/rejection or later document edits. A reused
key with a different valid payload returns 409 `import_key_conflict`. New keys require the base to be
current and the exact selection to match. Import only creates a pending suggestion; it does not write
a revision. Identical text with different keys is not treated as the same operation.

Accept runs entirely inside **one synchronous SQLite immediate transaction** in Documents. It validates
the document/suggestion identity and that expectedRevisionId equals the stored base. An already accepted
record returns its receipt before current-tip CAS; a rejected record returns 409. Pending acceptance
compares current with base, validates LF, offsets, exact original and SHA-256, constructs prefix +
replacement + suffix, validates the full result, appends one complete immutable revision, and updates
the suggestion to accepted with that revision ID. Any failure rolls back both writes. It uses private
compare/append helpers, never a public PUT/update followed by a separate status write or a nested public
update transaction. Title and format stay unchanged; restoredFromRevisionId is null.

The accepted revision is an operation receipt, not necessarily the current tip. If r5 -> Accept S -> r6
-> Save -> r7, repeating Accept S with its original r5 expected ID returns receipt r6, current document
r7 and replayed true. It never creates r8 or labels r6 as current. The receipt survives server restart.
Repeated Reject returns rejected with replayed true; an accepted suggestion cannot be rejected.
Rejecting does not undo acceptance. A later explicit Document Restore creates a new revision without
changing the suggestion's permanent accepted state.

Any changed current revision makes pending acceptance stale, even a title-only edit or restore. 409
`revision_conflict`/`selection_mismatch` does not write. There is no automatic search for identical text,
range relocation, merge, rebasing, latest-ID substitution or retry. Two writers serialize through SQLite:
the same suggestion can append at most once; different suggestions sharing a base cannot both apply.
A real busy lock returns safe 503 `storage_busy` with Retry-After, distinct from stale 409.

### Unknown outcomes, privacy and retention

No write is automatically retried. After an unreadable/lost response, callers can GET the known
suggestion or query the import key. A pending/absent result is a read snapshot, not proof that an older
in-flight POST will fail; WAL readers can see the pre-commit state. Explicitly resending the same
immutable import key/payload or accepting the same suggestion/base is idempotent. Do not create a new
key, infer success by comparing text, or substitute a newer base to resolve uncertainty. An acknowledged
accept remains accepted if a later refresh fails; retry only the read. No browser recovery/UI protocol
is delivered by this backend-only change.

Original text and replacement are private persisted data. Pending, rejected and accepted records and
receipts have **no deletion API, automatic cleanup or retention expiry** in this MVP. SQLite/WAL/backups
therefore retain them. A future purge policy must explicitly preserve or redefine the idempotency
contract. Manual imports do not store prompts or surrounding context. Rooms separately persist user
messages, quotes and selections in task events, briefs in task options, and suggestion excerpts and
agent tool calls in the task transcript. Shared-token Hub authentication remains the
access boundary; there is no per-document ACL, multi-user collaboration or new encryption guarantee.
Outside the explicit room transcript above, do not copy document payloads into Task events or SSE.
Telemetry and ordinary logs must not include private text, raw SQL parameters or error causes.
Only fixed allowlisted errors leave the document namespace; unexpected storage errors never reach the
generic logger. The Documents service itself invokes no SDK, model, agent job or quota operation.


## Manual suggestions review UI

The Documents editor now provides manual collaboration with an external official ChatGPT conversation.
Hub never opens that conversation, sends a prompt, reads a clipboard or contacts a model. The user
explicitly copies a prompt and pastes a candidate. `manual_import` describes that import, not a claim
that Hub generated the text. No dependencies, backend schema, migration or transaction changes are
needed for this UI.

### Frozen target and bounded prompt

`lib/document-suggestions.ts` freezes document/revision identity, revision number, session key, draft
version, exact UTF-16 offsets, original text and bounded context. Only a clean, valid, saved LF-only
session with a nonempty scalar-aligned selection can start. Dirty title edits, composition, save,
restore, unresolved writes and conflicts block it. Opening/blur never re-reads a DOM selection to
redefine the target. Editing, conversion, save acknowledgment, restore and session changes invalidate
the old intent; there is no search for repeated text, reanchoring, rebase or implicit save.

Limits are 16 KiB selected text, 2 KiB before and after, 4 KiB instructions, 64 KiB complete prompt and
64 KiB replacement, measured as UTF-8. Context is a contiguous scalar-safe suffix/prefix, with clipping
flags; original text is never truncated or normalized. Generated JSON escapes count toward the final
prompt limit: context can be omitted to fit, otherwise generation fails explicitly. Human-readable
saved version numbers are included; internal UUIDs and machine offsets appear only after advanced
opt-in and regeneration. Editing the preview cannot mutate the frozen target. Changed instructions
or advanced options mark the previous preview stale until regeneration; copying stale previews is
blocked. A user can still explicitly select/copy/edit the visible text themselves.

Clipboard writes occur only on click, via the existing helper. Secure clipboard refusal shows failure;
the insecure-context fallback runs its temporary textarea inside the active dialog to preserve focus.
The visible preview has Select all for Ctrl/Cmd+C or long-press. No automatic external navigation,
clipboard reads or writes happen in load effects. Both language dictionaries include the workflow.

### Import and retained input

The candidate is untrusted plain text, never HTML, commands, parsed JSON or auto-stripped Markdown
fences. It is not trimmed. NUL, invalid Unicode, CR and oversize values remain in raw local state and
block Import; composition also blocks it. CR paste is intercepted before textarea newline folding,
retained exactly and displayed read-only with a separate explicit local LF-conversion confirmation.
Conversion sends nothing. Empty replacement means deletion and needs a separate checkbox. Identical
replacement is no change. The main editor's approved LF-only text contract is unchanged.

Only Import freezes a new key and the complete payload, before the first POST. The key is a transport
identity, never a secret. The backend rejects collisions or changed payloads. Unknown Import retains
that same frozen key/payload across document/view switches, other saves and list refreshes, separately
from Document Create uncertainty. Inspect uses importRequestId filtering followed by exact detail
comparison. An absent list result does not prove failure. Retry needs a fresh explicit confirmation
bound to that operation ID, uses the identical payload, and never auto-generates another key.

Unimported drafts and unknown-operation handles live only in page memory. Confirmed imported data can
be recovered by listing the document after refresh. Reload loses unsent text and retry handles; it does
not undo server commits. Before import, a notice explains that original/candidate text persists in the
database even after Reject, with no automatic cleanup. Browser unload warnings are not crash recovery.

### Review, receipt and mutation coordination

The five typed Suggestion methods live in the existing API client and reuse shared DTOs, cookie auth,
no-store and safe errors. Metadata pages are deduplicated by ID; offset pagination is not a snapshot.
Detail loads original/candidate on demand. Malformed metadata/detail is rejected before rendering.
The panel lists pending suggestions first, with resolved ones collapsed, and opens the first pending
detail automatically (never after a failed read, so it cannot loop). Rows and detail show status,
creation time, base revision number and the last-read snapshot; IDs, offsets and byte counts stay out
of the default UI. An accepted receipt always identifies its original revision; it is not relabeled as
the current tip.

A pending-count badge on the editor's More actions menu reads `status=pending` (limit 100) for the open
document after each revision change, finished operation or panel close. It is advisory: stale responses
are discarded by document/session scope, and a failed read shows no count rather than zero and never
changes the document error or authentication state.

The prompt dialog is three steps: describe the change (showing the frozen original passage), copy the
prompt (preview and the advanced identifier option collapsed), and paste the result. Next generates the
prompt only when it is missing or stale, so manual prompt edits survive moving between steps. Resuming
a draft opens the furthest step its material supports. Byte counters appear only above 80% of a limit.
When a nonempty selection cannot start a revision, the editor shows the reason (unsaved draft, size or
another operation) instead of only disabling the button.

A Documents-specific read-only Monaco wrapper reuses the local loader/worker. It owns two anonymous
plaintext models and disposes both plus its editor on close, replacement or failed initialization.
Models have no task IDs or content-bearing URLs. Model values never become save input. The wrapper
never changes the global Git worker factory; loading/worker errors offer selectable plain comparison.
Phones default to Original/Candidate text tabs rather than a cramped side-by-side editor. The existing
Git/PR diff and navigation domains are unchanged.

Accept and Reject each require confirmation bound to the displayed suggestion ID. Closing the dialog,
Escape or mobile navigation never rejects. Accept verifies clean saved target/base/exact slice and
uses the suggestion's original expectedRevisionId. A 409 retains text, disables that attempt and offers
explicit server inspection. It never substitutes the latest ID or merges. Stale suggestions can be
rejected. Backend transaction/idempotency remains authoritative; new revisions are never synthesized
by the client. Accepted rows cannot Reject; repeated Reject returns its terminal state.

One model write slot covers create/save/restore/import/accept/reject. Accept pending or unknown also
locks title, input, composition, conversion, discard, Save and Restore in the model, not just buttons.
Ordinary Save still permits subsequent typing and acknowledges A while retaining B. Lost responses
latch uncertainty; pending GET cannot unlock Accept. Recovery reads the stored receipt, then refreshes
the current document. Failure after an accepted receipt retries only GET, not Accept. The acknowledged
snapshot may be newer than the receipt. A lost Reject discovering another tab's accepted receipt never
overwrites a dirty/composing/unknown editor: retain that draft and offer explicit server inspection.

All suggestion reads, writes and errors check document/session/navigation generations and their own
request sequence. A validated Import/Accept/Reject acknowledgment or operation reconciliation invalidates
all outstanding display list/detail generations and aborts those reads before publishing the confirmed
state together with cleared loading flags. Their older successes, failures and finalizers cannot erase
an imported row, roll a terminal state back to pending or clear a newer Refresh's loading flags. The
reconciliation sequence remains independent so an accepted receipt can continue its document refresh.
A later explicit Refresh starts new generations normally; no permanent read block or text-based receipt
inference is used. Closing also invalidates and aborts list/detail reads. An aborted read may still complete
on the server; scope checks remain mandatory. Operation-owned cleanup releases its write slot even
when its own acceptance creates a new editor session. Unknown state outlives dialog closure; opening a
different document requires the existing draft warning and cannot resolve the old operation. Authentication
failures preserve page-memory material. No background retries, polling or browser draft persistence exist.

### Verification boundary

Vitest covers pure bounds/Unicode, typed client errors, deferred model races, operation identity,
receipt recovery, raw candidate interactions, clipboard focus cleanup and Monaco model disposal. The
loopback Chrome fixture extends the original 15 editor groups with manual prompt/copy/import/diff,
unknown acknowledgments before and after commit, repeated-text targeting, stale CAS, persisted receipts,
late reads, worker failure and 320/390px review, including internal panel overflow. Temporary databases apply existing migrations and use
FakeAdapter only. No production data, real provider calls or quota increments are required.

The isolated Chrome runner disables BFCache to avoid retaining EventSource connections across many
full-page fixture navigations. In-app Back/Forward remains tested; BFCache behavior is not verified.
Chrome CDP composition and simulated clipboard outcomes do not verify physical IMEs or OS clipboard
integration. Physical mobile keyboards, Safari/Firefox and macOS Cmd+S remain manual acceptance tasks.
Documents/prompts/candidates never enter Task events, browser storage, URLs, telemetry or ordinary logs.


## Rooms

A room is a Task with workflow `room`, a document ID and optional brief in `options.room`, and exactly
two main sessions: Claude and Codex (labelled GPT). It uses a per-task scratch directory, no devices,
and each member's own resumable SDK thread. Creating a room sends no first message. The newest room
for a document is discoverable through `GET /api/rooms?documentId=...`.

Every user message runs one sequential round. Case-insensitive `@claude`, `@gpt` and `@codex` with a
word boundary select members; without mentions both answer. The starting member alternates per round,
even for targeted messages. The count of persisted user messages with a lower sequence number
determines the round index across restarts.
Agent mentions never dispatch work. Unlike Codync's automatic multi-round groups, rooms keep each
user input bounded to one round to preserve user control, latency and quota. The explicit exchange
endpoint queues the shared exchange text as a normal user message with `exchange: true`; it runs one
more round and gives both members the other's latest reply. Stop aborts the round. One member's
failure or usage limit does not cancel the other; any success makes the round successful. When all
fail, ordinary failure/quota-pause behavior applies.

Prompts start with `[Room with the user, Claude and GPT]` and contain only the conversation delta
since that member last spoke: consumed user messages and the other member's final text blocks,
labelled `[Claude]:` or `[GPT]:`. Own replies and tool calls are excluded. Each member resumes its own
thread. The exchange instruction also precedes an exchange delta. Host `room_context` read events
use the existing durable tool-call envelope, recording the consumed user sequence, conversation
sequence and document revision. Separate user and conversation cursors prevent inputs queued during
an earlier reply from being lost. A successful delivery confirms the cursor; failed delivery does not.

The brief is sent every turn and its PUT endpoint validates the shared 4,000-character limit before
persisting task options. Full current title, revision number and content are sent only when that
member has not seen the revision; otherwise context says `Document unchanged (revision N)`. Frozen
selections include their base revision and exact UTF-16 range. They validate against that saved
revision on message submission, even when stale; a later tool call rejects stale use.

Quotes reference only user messages or agent text in the same room. The server resolves authors and
snapshots the requested nonempty part or complete message, capped at 4,000 UTF-8 bytes on a scalar
boundary. The prompt renders `[Quoting Claude's reply: "..."]`, `[Quoting GPT's reply: "..."]` or
`[Quoting the user's message: "..."]` before the user's text. Room-only input fields on other workflows
are rejected. Quotes are stored in user-message events, independent of subsequent prompt assembly.

Only room MCP grants expose `suggest_document_edit`. An explicit original passage must match exactly
once in the current revision, otherwise the tool asks for more surrounding text. Without it, the tool
uses the current message's frozen selection. All imports reuse Documents validation, including LF,
size limits, unchanged replacements and current-base CAS. The server generates the import request
ID and binds the source to `claude` or `codex`; `document_suggestions.source` now permits those values
alongside `manual_import`. A successful import appends a `room_suggestion` event with the suggestion
ID, member, reason and excerpts capped at 300 Unicode scalars. Suggestions remain pending until the
user accepts them through the existing suggestion API. Agents never edit the document directly or
accept their own suggestions.
