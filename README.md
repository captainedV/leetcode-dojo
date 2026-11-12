# LeetCode Local IDE

在 **VS Code / Cursor** 里刷 LeetCode：左侧内嵌 LeetCode 网页（可登录、可点官方按钮），右侧用**本地 IDE** 写代码 —— 支持多语言、本地测试、本地断点调试、限制 AI 补全、一键提交。

> 一句话使用范式：点状态栏 `LeetCode` → 左栏是你的 LeetCode 网站 → 点进任意题目 → 右栏自动出现同名本地文件 + 官方类框架 → 本地写/调/测 → 工具栏提交。

```
┌───────────────────────────┬────────────────────────────────┐
│ 左侧：只显示题面的 LeetCode │ 右侧：本地 IDE（真实文件）        │
│ ───────────────────────── │ ────────────────────────────── │
│ [题目描述][题解][提交记录]  │  solution.py                    │
│                           │  （断点调试 / 补全 / 重构都在这里）│
│ 1. 两数之和  简单          │                                │
│ 给定一个整数数组 nums …    │  ← 线上 IDE 已被自动隐藏，      │
│ 示例 1: 输入 … 输出 …      │     题面铺满整栏                │
│ （题面滚动区）             │                                │
└───────────────────────────┴────────────────────────────────┘
┌─ 底部面板：LeetCode ───────────────────────────────────────────┐
│ 1. 两数之和  leetcode/001.two-sum/solution.py  [Python3 ▾]      │
│ [本地运行] [官方运行] [提交] [调试] [重建用例] [用例文件]         │
│ [测试用例] [测试结果]                                           │
│ ✅ 用例 1：实际 [0,1] ｜ 期望 [0,1]      12ms                   │
│ ❌ 用例 2：实际 [0,0] ｜ 期望 [1,2]      9ms                    │
└────────────────────────────────────────────────────────────────┘
```

---

## 1. 安装

```bash
# VS Code
code --install-extension leetcode-local-ide-0.1.0.vsix
# Cursor
cursor --install-extension leetcode-local-ide-0.1.0.vsix
```

从源码构建：

```bash
npm install
npm run build       # 打包扩展 + webview + 注入脚本到 dist/
npm test            # 220 个单元/集成测试
npm run package     # 产出 .vsix
```

---

## 2. 快速上手

1. 点左下角状态栏 **`LeetCode`**（或命令面板 `LeetCode Local: 进入 LeetCode 模式`）。
2. 左栏加载 LeetCode 题库页面 —— **在左栏里直接登录**。登录态会自动保存（见下节），重开 IDE 不用再登录。
3. 点进任意题目：右栏自动创建并打开本地文件（已填好官方类框架）；
   **左栏会自动只保留题面**（隐藏线上 IDE 的代码区与测试用例区，题面铺满整栏）。
   想临时看完整网页（例如用站点自己的按钮 / 看站点题解高亮），点左栏工具栏的「只显示题面 / 显示完整网页」开关。
4. 写代码。**保存即同步**到网页（网页内部状态与你的文件一致）。
5. 用工具栏（左栏顶部）或命令面板：
   - **本地运行** `⌘/Ctrl+Alt+Enter` — 在本地跑测试用例（毫秒级，可反复）
   - **调试** — 用本地调试器打断点
   - **官方运行** — 调 LeetCode 官方判题（用示例用例），结果显示在输出面板
   - **提交** `⌘/Ctrl+Alt+S` — 提交到 LeetCode
   - **语言** 下拉框 — 切换语言，自动切换/新建对应语言的本地文件
   - **提示** `⌘/Ctrl+Alt+H` — 分级的 AI 提示（默认只讲 API 用法，不给代码）
6. **从任何入口进题都行**：题库列表、**学习计划（面试经典 150 等）**、每日一题、竞赛题单…
   学习计划里的题目行原本用 `window.open` 弹新窗口（IDE 里会被拦），现在会在**当前面板内跳转**；
   左栏还提供 `←` `→` `题库` 导航按钮，方便"回学习计划点下一题"。
7. 也可以直接在网页里点 LeetCode 自己的「运行 / 提交」按钮 —— 桥接脚本会把请求体里的代码替换成**你本地的代码和当前语言**，所以两边行为一致。

### 结果在哪里看：底部「LeetCode」面板

> **v0.2.3 修复**：之前面板只是被"贡献"出来，但没有任何地方主动打开它，所以你进模式后看不到。
> 现在进入 LeetCode 模式 / 打开题目时会自动把底部面板叫出来（复用你已有的面板区域，不新建窗口），
> 打开后焦点仍留在左侧题面。想手动叫出来：左栏工具栏 `面板` 按钮、编辑器标题栏的布局图标、
> 或命令 `LeetCode Local: 打开底部面板`。若你的编辑器里压根没有「LeetCode」这个面板 tab（个别发行版会隐藏扩展面板容器），
> 执行一次 `查看 → 面板` 让它展开即可。若自动打开失败，会弹一个提示给你两个按钮（`打开面板` / `用输出面板`），
不会让你去猜；`LeetCode Local: 显示诊断信息` 里的 `resultsPanel=已连接/未创建` 也能告诉你面板到底有没有创建。

运行/提交完，底部面板会自动展开并切到「测试结果」：

```
1. 两数之和   leetcode/001.two-sum/solution.py   [Python3 ▾]
[本地运行] [官方运行] [提交] [调试] [重建用例] [用例文件]
 [测试用例（3）]  [测试结果（3）]
 ❌ 本地测试 2/3 通过    首个失败：用例 3 实际 [0,0] / 期望 [0,1]
   ✅ 用例 1：实际 [0,1] ｜ 期望 [0,1]
   ❌ 用例 3：实际 [0,0] ｜ 期望 [0,1]
```

- 布局刻意模仿 LeetCode 线上 IDE 的下半部分；「测试用例」tab 能看到每个用例的输入与期望输出。
- 失败时还会**自动打开输出面板**（`输出 → LeetCode Local`）并在弹窗里给出首个失败用例。
- 面板被关掉了？命令面板执行 `LeetCode Local: 显示输出面板`，或再跑一次运行/提交；也可以在底部面板右上角重新打开「LeetCode」容器。
- 截图：`docs/verification/bottom-panel.png`、`docs/verification/left-pane-description-only.png`

### 登录态保留（v0.2.1）

登录一次之后就不用再登了，做了四件事：

| 保存什么 | 存在哪 | 为什么 |
|---|---|---|
| `LEETCODE_SESSION` / `csrftoken` 等 cookie | **系统钥匙串**（`context.secrets`），不可用时退回 `globalStorage/*.json` | 登录态本体；用钥匙串避免明文落盘 |
| 代理端口 | `globalState` | 站点页面跑在 `http://127.0.0.1:<port>`，而 **localStorage 按源隔离**——端口一变，站点的语言选择、题目草稿就全丢了。所以端口固定复用 |
| 上次打开的题目 | `globalState` | 重开 IDE 直接回到那道题，左栏直接加载该题页面、右栏直接打开文件 |
| 登录用户名的脱敏记录 | 随 cookie 一起 | 用于在左栏状态条显示「已登录：xxx」 |

细节：

- **cookie 一变就（600ms 防抖）自动保存**，并在检测到会话 cookie 出现时自动刷新一次登录状态（不需要手动点「刷新登录状态」）；`exit()` / 窗口关闭时再兜底保存一次。
- 会话 cookie 回给浏览器时**保留 `HttpOnly`**（页面脚本读不到），`csrftoken` 照旧可读（站点需要）。
- 想彻底清掉登录态：命令面板 `LeetCode Local: 退出登录` —— 会删掉钥匙串里的记录、`globalStorage` 里的文件，并让浏览器把旧 cookie 置为过期。
- 端口被别的程序占用了？会自动退回随机端口（会话仍可用，只是那一次的站点 localStorage 会换源）。

---

## 3. 为什么是 `leetcode.cn`（以及 `leetcode.com` 怎么办）

实测结论（本项目实测，非推测）：

| 站点 | 能否内嵌到 IDE | 原因 |
|---|---|---|
| **leetcode.cn** | ✅ 可以 | 无 `X-Frame-Options`、无 CSP，Node 能正常取到文档 |
| **leetcode.com** | ❌ 不行 | Cloudflare 对非浏览器 TLS 指纹返回 `403 challenge`（`cf-mitigated: challenge`），且响应带 `X-Frame-Options: SAMEORIGIN` |

因此默认站点是 `leetcode.cn`（中文站，题目与 leetcode.com 基本一一对应）。
用 `leetcode.com` 时退化为 **API 模式**：命令面板 `LeetCode Local: 设置登录 Cookie`，粘贴浏览器里的 `LEETCODE_SESSION` 与 `csrftoken`，即可用本地 IDE + 官方判题 + 提交（但没有内嵌网页）。

---

## 4. 本地测试是怎么做的

**优先从 LeetCode 拿数据，拿不到才用 AI**——顺序如下：

1. **官方元数据**：`GraphQL question()` 给 `metaData`（函数名、每个参数名与类型、返回类型）+ `codeSnippets`（各语言官方模板）+ `exampleTestcases`（官方判题机用的示例输入）。
2. **期望输出**：从题面 HTML 解析 `Input/Output/输入/输出` 块（两种 HTML 写法都支持），并按**输入内容**匹配，避免题面顺序错位。
3. **生成脚手架**：在 `local/` 下生成跨语言测试驱动（绝不修改你的代码文件）：
   - 与 LeetCode 评测机一致的运行环境（Python 注入 `typing` / `ListNode` / `TreeNode` 的 preamble 并 `exec` 你的文件）
   - 参数反序列化 / 返回值序列化（含链表、二叉树层序去尾 null、原地修改取首参等）
   - 统一协议行 `__LC_RESULT__ {...}`，由 TS 侧归一化比较（浮点容差、布尔大小写、空白）
4. **AI 兜底**：设计类题目、特殊输入，或某语言没有内置脚手架时，用你自己的 API Key 让模型生成脚手架（严格 JSON 输出 + 文件名/命令白名单校验，只写入 `local/ai/`）。

**比较策略（重要）**：先严格比较（忽略空白/引号/浮点误差）；严格不等时再做**乱序等价**比较
（把数组（含二维）当多重集合比较）。因为 LeetCode 上不少题接受任意顺序（两数之和的下标、
三数之和、全排列、字母异位词分组…），官方用 special checker，只做严格比较会出现
「本地未通过但提交 Accepted」的假阴性。乱序命中时会标注「内容一致但顺序不同」。

`cases.json` 你可以手改（加自己的边界用例），本地运行会读它。

### 语言支持

| 语言 | 本地运行 | 本地调试 | 说明 |
|---|---|---|---|
| Python3 / Python | ✅ | ✅ | 与官方评测机同款 preamble |
| C++ / C | ✅ | ✅ | 自带 `bits/stdc++.h` 兼容头（macOS 无该头） |
| JavaScript / TypeScript | ✅ | ✅ | TS 用 Node 内置 `stripTypeScriptTypes`（需 Node ≥ 22.7） |
| Java | ✅ | ✅ | 需本地 JDK |
| Go / Rust | ✅ | ✅ | 需本地 `go` / `rustc` |
| Ruby | ✅ | — | |
| C# / Kotlin / Swift / PHP / Dart / Scala / Elixir / Erlang / Racket / 仓颉 | — | — | 用「官方运行 / 提交」+ AI 脚手架 |

所有语言都支持**官方运行/提交**（走 LeetCode 自己的判题机），本地脚手架缺失不影响提交。

### 本地调试需要装对应的调试扩展

调试器类型（`debugpy` / `cppdbg` / `java` / `go` / `lldb` …）都不是 VS Code 内置的，由扩展注册：

| 语言 | 需要的扩展 | 调试器类型候选（顺序尝试） |
|---|---|---|
| Python | `ms-python.debugpy`（Python Debugger）或 `ms-python.python` | `debugpy` → `python` |
| JavaScript / TypeScript | 内置 js-debug | `node` → `pwa-node` |
| C / C++ | `ms-vscode.cpptools`（C/C++）或 `vadimcn.vscode-lldb`（CodeLLDB） | `cppdbg` → `lldb` |
| Rust | `vadimcn.vscode-lldb` | `lldb` |
| Java | `redhat.java` | `java` |
| Go | `golang.go` | `go` |
| Ruby | `shopify.ruby-lsp` | `rdbg` |

点「调试」时插件会**先检查扩展是否已安装**：

- 有可用调试器 → 直接启动（`debugpy` 不可用会自动降级到 `python` 等候选）；
- 一个都没有 → 不再抛「配置的类型 debugpy 不受支持」，而是弹出
  **「无法启动调试。缺少调试扩展：ms-python.debugpy…」**，并给两个按钮：`搜索扩展` / `改为本地运行`。
- 装了但启动失败 → 逐个候选尝试，全失败时同样给出安装指引 + 输出面板里的详细日志。

> Cursor 默认**没有**装 Python / C++ / Java 调试扩展，所以第一次用 Python 调试会看到上述提示，装一个 Python Debugger 即可。

**调试时的报错信息（v0.2.5）**：调试终端里不再只有一行转义 JSON，而是：

```
[LeetCode] 用例 1 · 运行出错
[LeetCode]   TypeError: object of type 'ListNode' has no len()
[LeetCode]   在 solution.py:3（addTwoNumbers）
[LeetCode]   提示：LeetCode 的链表/树参数是 ListNode / TreeNode 对象（.val / .next / .left / .right），不是 list，不能对它用 len()。
```

- 只调试**单个用例**时会带 `--raise-on-error`：异常照常抛出，调试器会停在出错的那一行（可看栈帧/变量）。
- 底部面板「测试结果」和失败通知里也会附上同一句中文提示。

**调试用哪个用例（v0.2.4）**：点「调试」时会让你选 —— `全部用例` / `某个用例` / `自定义输入…`
（自定义可以写 `l1 = [2,4,3], l2 = [5,6,4]`，也能每行一个参数）。底部面板「测试用例」里每个用例右侧也有一个 `调试` 按钮，
点它就只跑那一个用例。这样断点不会被别的用例先命中。

**断点为什么现在能命中（v0.1.1 修复）**：

| 语言 | 之前 | 现在 |
|---|---|---|
| Python | 调试入口用 `exec(compile(...))` 加载你的文件，不少调试器不会把断点绑到这种代码对象 | 调试专入口 `_lc_debug_runner.py` 用**标准 `import`** 加载你的文件（preamble 注入 `builtins`，你的文件一行都不用改），断点稳定命中 |
| C / C++ | 编译用 `-O2`，没有调试信息 | 调试时自动改成 `-g -O0 -fno-omit-frame-pointer` |
| Rust | `rustc -O` | 调试时 `-g -C opt-level=0` |
| Java / Go | 无 `-g` / 优化内联 | 调试时加 `-g` / `-gcflags=all=-N -l` |
| JS / TS | 已经用 `filename` 映射到你的文件 | 不变（本来就命中） |

另外调试时会用探测到的同一个解释器（`python` 字段传绝对路径），避免「调试器用另一个 python」。

**Python 版本（v0.2.4）**：LeetCode 新版 Python3 模板会用 PEP 604 注解（`ListNode | None`），这需要 **3.10+**；
macOS 自带的 `/usr/bin/python3` 是 3.9，直接跑会 `TypeError: unsupported operand type(s) for |`。现在：

- 自动挑选 **最高的 3.10+** 解释器（本机会选中 `/opt/homebrew/bin/python3.13` 之类），本地运行与调试用同一个；
- 想指定的话设置 `lcLocal.python.path`；
- 即使只能用 3.9，注入的 `ListNode`/`TreeNode`/`Node` 也带了兼容 metaclass，`ListNode | None` 在 3.9 上同样可用。

---

## 5. 限制 AI 补全（这个插件的重点之一）

直接让 AI 写完整题会让练习失去意义；完全不给提示，在 vibe coding 时代又记不住 API 细节。所以做成**分级 + 硬约束**：

| 级别 | 行为 |
|---|---|
| `off` | 本扩展完全不提供补全 |
| `signature`（默认） | 只提示**你正在调用的那个 API** 的签名/用法（内置 274 条刷题高频 API：`bisect_left`、`heapq` 堆操作、`sort(key=)` 的坑、`priority_queue` 大小顶堆写法、`HashMap.getOrDefault`…）。**不生成任何算法逻辑** |
| `line` | 允许补全**当前这一行**，且必须通过硬规则过滤：不能换行、不能超过字符上限、不能开新块（`:`/`{`/`do`）、不能出现 2 个以上控制流关键字、不能出现函数/类定义、不能与后文重复、只能单语句 |

另外：

- 进模式时自动压制其他 AI 助手在题目目录里的补全：`github.copilot.enable`、`github.copilot.inlineSuggest.enable`、`github.copilot.nextEditSuggestions.enabled`，写入 `<题目根>/.cursorignore`；退出时**只还原自己改过的键**。
- **诚实的限制**：Cursor 的 Tab 补全没有官方的工作区级开关，插件无法在你的练习时段自动关掉它，需要你在 Cursor 设置里手动关（或临时停用）。`lcLocal.hint.level=off` 只关闭**本扩展**提供的补全。

参考的既有方案：Copilot/IntelliCode 的「单行 inline suggestion」思路、LeetCode 官方 Hint 分级、以及 `leetcode local debug` 类项目在本地复刻评测环境 preamble 的做法。本项目的取舍是：**默认只给 API 级提示，把「写出一行有效代码」的门槛留给你自己**。

---

## 6. 配置项（`settings.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `lcLocal.site` | `leetcode.cn` | 站点；`leetcode.com` 走 API 模式 |
| `lcLocal.hint.level` | `signature` | `off` / `signature` / `line` |
| `lcLocal.hint.maxLineChars` | `80` | `line` 级单行补全上限 |
| `lcLocal.ai.enabled` | `false` | 启用 AI（提示 / 行补全 / AI 脚手架） |
| `lcLocal.ai.baseUrl` | `https://api.deepseek.com/v1` | 任意 OpenAI 兼容接口 |
| `lcLocal.ai.model` | `deepseek-chat` | |
| `lcLocal.ai.apiKey` | `""` | 也可用环境变量 `LC_LOCAL_AI_KEY` |
| `lcLocal.run.defaultLang` | `python3` | 进题目时的默认语言 |
| `lcLocal.run.timeoutMs` | `20000` | 本地测试超时 |
| `lcLocal.proxy.port` | `0` | 内嵌网页代理端口（0=自动） |
| `lcLocal.proxy.injectBridge` | `true` | 是否注入桥接（关掉就退化成普通浏览器） |
| `lcLocal.editor.hideSiteEditor` | `true` | 是否用覆盖层替换网页编辑器 |
| `lcLocal.aiGuard.enabled` | `true` | 是否压制其他 AI 补全 |
| `lcLocal.workspace.subdir` | `leetcode` | 题目存放目录 |
| `lcLocal.proxy.port` | `0` | 首次使用的代理端口；之后固定复用（存于 globalState） |

命令：`LeetCode Local: 显示诊断信息` 会打印当前站点/代理端口/登录态/cookie 名/当前题目/提示级别/AI 状态/工具链与可用调试器。

---

## 7. 架构

```
扩展宿主 (dist/extension.js)
├── LcSession            会话编排：进入/退出、题目切换、命令
├── LeetCodeProxy        本地反向代理 127.0.0.1:port
│   ├─ 文档转发 + 去 X-Frame-Options/CSP + 注入 bridge.js
│   ├─ CookieJar（浏览器登录态 ↔ 扩展宿主共用，可持久化）
│   ├─ CDN 转发 + 文本内绝对 URL 改写（关键：防止页面跳出代理源）
│   └─ 缓存（CDN 静态资源）
├── LcClient             GraphQL 拉题 + REST 直连判题（interpret_solution / submit / check）
├── ProblemStore         题目目录、meta.json、cases.json、模板快照
├── runner/              9 种语言的本地脚手架 + 执行器（编译/运行/协议解析/结果比较）
└── ai/                  分级提示、受限行补全（274 条签名库 + 硬规则闸门）、AI 脚手架、AI 守卫
Webview (dist/media/shell.js + shell.css)  左栏：工具栏 + iframe → 代理
注入脚本 (dist/media/bridge.js → 页面内)     覆盖层替换编辑器、改包 fetch/XHR 接管判题请求、路由同步
```

几个关键实现细节（都是实测踩出来的）：

1. **必须代理 CDN 并改写文本**：站点前端会用绝对地址 `https://leetcode.cn/...` 做路由跳转，若不改写，iframe 会整页跳到真实站点、桥接直接失效。所以 `static.leetcode.cn` 的 JS/CSS 也经代理，并把 `https://leetcode.cn` 改写成代理源、`https://static.leetcode.cn` 改写成 `/__lc/cdn/...`。
2. **覆盖层不能塞进 `#editor`**：React 每次重渲染都会删掉非它管理的子节点（实测），所以覆盖层挂在 `document.body` 上、`position:fixed`，用 400ms 心跳对齐到 Monaco 的 `getBoundingClientRect()`（实测与编辑器矩形逐像素一致）。
3. **接管判题靠改请求体**，不靠点按钮：拦截 `POST /problems/{slug}/(interpret_solution|submit)/`（含 GraphQL 变体），替换 `typed_code` / `lang`，其余字段原样保留；命中后把 `submission_id` 与后续 `/submissions/detail/{id}/check/` 的结果回传给 IDE。
4. **登录态复用**：代理的 CookieJar 既服务浏览器请求，也让扩展宿主能直连 REST 判题接口（`X-CSRFToken` 取自 `csrftoken` cookie），所以「官方运行/提交」在网页桥接失效时依然可用。

---

## 8. 验证状态（诚实版）

已实测：

- **220 个自动化测试全绿**（`npm test`）：解析器、cookie 罐、代理改写规则、判题请求识别/改写、9 种语言脚手架的**真实编译执行**（Python 3.9 / Node 25 / Apple clang 17 / Ruby 2.6 在本机真跑；Java·Go·Rust 因本机无工具链只做结构断言并 skip）、AI 提示词与脚手架输出校验、受限补全闸门的 8 条硬规则。
- **端到端集成测试**（`test/integration/extension.test.ts`，真实访问 leetcode.cn）：激活 → 起代理 → 建面板（含 CSP）→ 模拟页面路由 → 自动建 `001.two-sum/solution.py` 与 `cases.json`/`problem.md` → 推送代码给页面 → **本地 python3 跑 3 用例全过** → 切 C++ 建 `solution.cpp` → **本地 C++ 编译跑 3 用例全过** → 诊断 → 退出。
- **真实 Chromium 验证内嵌页面**（Playwright + 打包后的 bridge.js）：`leetcode.cn` 题目页在代理后完整渲染（标题「1. 两数之和」、`window.monaco` 存在、2 个 model），覆盖层稳定盖住编辑器且矩形与 Monaco **完全一致**，页面不再跳出代理源。截图见 `docs/verification/leetcode-mode.png`。
- **打包后的 bundle 可加载**：用 vscode 替身 require `dist/extension.js`，`activate()` 注册 19 个命令、建面板、正常退出。

**尚未验证（需要你的账号/环境）**：

- **登录与真实提交**：无账号凭据，未跑过真实 `submit` 的完整链路（请求体改写与端点已按前端产物核对，桥接/直连两条路都实现并可从诊断信息自查）。
- **Cursor 里的实际体验**：扩展已装入 Cursor，但 Cursor Tab 补全的行为只能由你手动观察（见第 5 节）。
- **Java / Go / Rust** 本地脚手架：本机无 JDK/go/rustc，未真正编译运行过。
- **IDE 内的 webview iframe**：浏览器中验证的是同一个页面（iframe 内容与顶层页面一致），webview 的 CSP `frame-src` 已在集成测试中断言。

---

## 9. 常见问题

- **左栏空白/一直转圈**：看 `输出 → LeetCode Local`。若是 Cloudflare 验证，说明你选了 `leetcode.com`，切回 `leetcode.cn`。
- **本地测试提示“未判定”**：说明题面里没解析到该用例的期望输出（部分新题/会员题）。可以在 `cases.json` 里手写 `expected`，或用 `LeetCode Local: AI 生成测试脚手架`。
- **学习计划里点题目没反应**：v0.2.6 已修（题目行是 `window.open` 弹窗，IDE 里会被拦 → 改成面板内跳转）；若仍异常请把 `LeetCode Local: 显示诊断信息` 的输出发我。
- **点提交没反应 / 提示未登录**：登录态会保存，但 LeetCode 自己的会话过期后需要重新登录；先 `LeetCode Local: 刷新登录状态`，仍不行就在左栏网页里重新登录一次。
- **提示「找不到命令 node / python3」**：GUI 启动的编辑器 PATH 常常不含 Homebrew/nvm。
  插件会按「进程 PATH → 登录 shell → 常见安装目录」顺序找可执行文件，仍找不到时提示里会直接给出安装命令
  （`brew install node` / `xcode-select --install` 等）。装好后重开窗口即可。
- **点调试提示需要扩展**：见上面「本地调试需要装对应的调试扩展」表；也可以先点「本地运行」。
- **本地未通过但 LeetCode 提交 Accepted**：如果输出里标注了「内容一致但顺序不同」就是宽松通过；
  若是别的差异，把输出面板里的实际/期望值贴给我，或把 `cases.json` 的 `expected` 改成题面原值。
- **网页编辑器没被替换**：`lcLocal.editor.hideSiteEditor` 是否为 `true`；覆盖层被关掉时点工具栏「刷新」恢复。
- **macOS 无 `bits/stdc++.h`**：已自动生成兼容头，无需处理。

## 10. 隐私

- 代码只在你本机、以及你主动点击「官方运行/提交」时发往 LeetCode。
- AI 功能只有在你自己配置了 API Key 且显式触发时才会把**当前题目与代码**发给你配置的服务商（`lcLocal.ai.baseUrl`，默认 DeepSeek）；`hint.level=off` + `ai.enabled=false` 时完全离线。
- 登录 Cookie 保存在扩展的 `globalStorage` 目录，仅用于本地代理与 LeetCode 接口。
