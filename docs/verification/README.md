# 验证记录

本目录记录构建过程中的实测证据（不是设计意图，而是真跑出来的结果）。

## 1. 站点可行性实测

| 探测 | 结果 |
|---|---|
| `GET https://leetcode.com/problems/two-sum/`（Node fetch / curl / 真实 Chromium 无登录） | `403`，`cf-mitigated: challenge`，另有 `x-frame-options: SAMEORIGIN` |
| `GET https://leetcode.cn/problems/two-sum/`（Node fetch） | `200`，202 KB，**无** `X-Frame-Options`、**无** CSP |
| `POST https://leetcode.cn/graphql/` | `200`，`metaData` / `exampleTestcases` / `codeSnippets` 齐全 |
| `https://static.leetcode.cn/...` 静态资源 | `200`，`access-control-allow-origin: *` |

结论：`leetcode.cn` 可以在 IDE 内完整代理，`leetcode.com` 只能走 API 模式。

## 2. 隐藏的坑（都是实测发现后修的）

1. **页面会跳出代理**：站点前端用绝对地址 `https://leetcode.cn/problems/x/description/` 做路由跳转，
   iframe 一离开代理源，注入的桥接就没了。→ 修法：把 CDN 的 JS/CSS 也纳入代理并改写文本内的绝对 URL。
2. **覆盖层被 React 删掉**：把覆盖层塞进 `#editor` 后，第一次渲染成功了，2 秒后消失。
   → 修法：改挂 `document.body` + `position:fixed` + 400ms 心跳，按 Monaco 的 `getBoundingClientRect()` 定位。
3. **期望输出解析不出来**：`leetcode.cn` 题面用 `<p><strong>Output:</strong>` 而不是老的 `<pre>`，
   原解析器只扫 `<pre>`，导致所有用例都是“未判定”。
   → 修法：改成按文本行扫描（两种写法都支持），并按输入内容匹配期望输出。
4. **`SitePanel.dispose()` 递归**：`panel.dispose()` → `onDidDispose` → `dispose()` → …（集成测试抓到栈溢出）。
5. **站点用 `location.host` 拼 https 地址**：内嵌到 http 代理源后会 `ERR_SSL_PROTOCOL_ERROR`。
   → 修法：桥接里把指向自身但 scheme 为 https 的请求纠正回 http。

## 3. 真实 Chromium 下的页面状态（`leetcode-mode.png`）

用 Playwright + 打包后的 `dist/media/bridge.js` 加载 `http://127.0.0.1:<port>/problems/two-sum/`：

```
title                : 1. 两数之和 - 力扣（LeetCode）
window.monaco        : object
monaco models        : 2
#editor              : 存在
覆盖层 #lc-local-overlay : 存在，z-index 900，文字「代码编辑已切换到本地 IDE」
Monaco 矩形           : {t:116, l:724, w:706, h:650}
覆盖层矩形            : {t:116, l:724, w:706, h:650}   ← 逐像素一致
站点工具栏「提交」按钮 : 仍然可见可用
页面内绝对跳转        : 不再发生（始终停留在代理源）
```

## 4. 自动化测试（241 passed）

- `test/core/parse.test.ts` — 题面解析（两种 HTML 写法）、用例构造、输出归一化
- `test/proxy/rewrite.test.ts` — 请求/响应头改写、cookie 罐、注入位置、Cloudflare 识别
- `test/bridge/judge.test.ts` — 判题请求识别/请求体改写（含 GraphQL 变体）、结果归一化、self-protocol 修正
- `test/harness/*.test.ts` — 9 种语言脚手架；**本机真跑**：Python 3.9 / Node 25 / Apple clang 17 / Ruby 2.6；
  Java·Go·Rust 因本机无工具链只做生成物结构断言（测试里 skip）
- `test/ai/*.test.ts` — 提示词约束、受限补全 8 条硬规则、签名库完整性、AI 脚手架输出安全校验
- `test/integration/extension.test.ts` — **真实网络**端到端：激活 → 起代理 → 建面板 → 路由 → 建文件 → 推送代码 →
  本地 python3 跑 3/3 通过 → 切 C++ → 本地 C++ 编译跑 3/3 通过 → 诊断 → 退出

## 5. 真实宿主

- `code --install-extension leetcode-local-ide-0.1.0.vsix` ✅
- `cursor --install-extension leetcode-local-ide-0.1.0.vsix` ✅
- 用独立 profile 启动 VS Code 并读取扩展宿主日志：
  `_doActivateExtension xialc.leetcode-local-ide … activationEvent: 'onStartupFinished'`
  → `loadModule [cjs] -> …/dist/extension.js` → `_callActivateOptional`，**无报错**。

## 6. 未验证（需要你的账号/环境）

- 真实**登录**与真实**提交流程**（无账号凭据；端点与请求体已按站点前端产物核对，桥接与 REST 直连两条路都实现）
- Java / Go / Rust 脚手架的**真实编译运行**（本机无 JDK/go/rustc）
- Cursor 中 Tab 补全的实际行为（Cursor 无工作区级开关，需手动关）


## 7. 第二轮问题修复（用户实测反馈）

用户实测反馈两件事，都已定位并修复，且有回归用例：

| 反馈 | 根因 | 修复 |
|---|---|---|
| 点「调试」提示「配置的类型 debugpy 不受支持」 | `debugpy` 由扩展 `ms-python.debugpy` 提供，Cursor 里没装任何 Python/C++ 调试扩展 | 改成「候选链 + 扩展探测 + 降级」：不再直接抛原始错误，而是给出「缺少哪个扩展」并提供 `搜索扩展` / `改为本地运行` 按钮；`debugpy` 失败会自动退到 `python` |
| 「本地测试未通过，详情见输出面板」但找不到输出面板 | 失败分支只弹提示，从不 `output.show()`；左栏也没有结果展示 | ① 左栏新增结果条（失败自动展开，含每个用例的实际/期望）② 失败时自动打开输出面板 ③ 弹窗直接给出首个失败用例 ④ 工具栏新增 `输出` 按钮 |

顺带修掉的系统性误判：多解题目（两数之和下标、三数之和、全排列、异位词分组等）以前用严格字符串比较，
顺序不同会误报失败 → 现在严格不等后做**乱序等价**比较并标注「内容相同但顺序不同」。
以及 GUI 编辑器 PATH 不全导致「找不到命令」→ 现在按「进程 PATH → 登录 shell → 常见安装目录」解析。

结果条在真实 Chromium 里渲染验证过：`results-strip.png`（失败时自动展开、点标题行可折叠、`输出` 按钮回传 `showLog` 动作）。


## 8. 第二轮 UI 重构与断点修复（用户实测反馈 2）

| 反馈 | 根因 | 修复 |
|---|---|---|
| 调试不进断点 | Python 调试入口用 `exec(compile())` 加载用户代码；C++/Rust 编译没有 `-g` | 新增 `_lc_debug_runner.py`（标准 `import` + preamble 注入 `builtins`）；C++ 调试编译改 `-g -O0`，Rust `-g -C opt-level=0`，Java `-g`，Go `-gcflags=all=-N -l`；并把探测到的 python 绝对路径传给调试器 |
| 覆盖层挡住编辑器太丑、希望左栏只留题面 | 站点用 FlexLayout（绝对定位面板） | 删掉覆盖层，改成**焦点模式**：隐藏「代码」与「测试用例/测试结果」两个 tabset + 分割条，把题面 tabset/pane 拉到 100% |
| 希望右侧像线上 IDE：下方是测试用例/结果 | 原来结果塞在左栏 | 新增底部面板（`contributes.viewsContainers.panel` + WebviewView），含「测试用例 / 测试结果」两个 tab 与运行/提交/调试按钮 |

验证证据：

- 真实 Chromium（900×900 窄栏）下左栏只剩题面：`flexlayout__tabset` 880×842，`#editor`/`.monaco-editor` 的 `getClientRects().length === 0`（完全不在屏上），题面 pane 806px 高、tab 按钮行保留。截图 `left-pane-description-only.png`。
- 底部面板真实渲染：标题/文件名/语言下拉、两个 tab 与计数、「❌ 本地测试 1/2 通过」摘要与逐用例 ✅/❌ 行、点「本地运行」正确回传 action。截图 `bottom-panel.png`、`bottom-panel-cases.png`。
- Python 调试入口实测（真实 python3.9）：two-sum 两例、`Optional[TreeNode]` 树题一例，均正常输出 `__LC_RESULT__`（说明标准 import + builtins 注入可用）。


## 9. 登录态保留（v0.2.1）

之前 `persistCookies()` 只在手动「刷新登录状态」时调用一次，而且有 `cookiesPersisted` 一次性守卫 —— 实际效果是**登录后从不落盘**，重开 IDE 必然要重登。现在：

1. `CookieJar` 增加 `onChange` 回调（区分 `session-cookie` / `cookie` / `set` / `clear`），会话 cookie 一出现就触发 600ms 防抖持久化，并顺带自动确认一次登录状态；
2. 新增 `SessionStore`：cookie 存 `context.secrets`（钥匙串），不可用时退回 `globalStorage/session-<site>.json`；端口与上次题目存 `globalState`；
3. **固定复用代理端口**（localStorage 按源隔离，端口变 = 站点草稿/语言丢失），端口被占用时自动回退随机端口；
4. 退出登录会清理钥匙串 + 文件，并让浏览器把旧 cookie `Max-Age=0`。

验证（自动化，共 22 个新用例）：

- `test/core/cookieStore.test.ts`（10）：secrets 往返、secrets 不可用时文件兜底、清除、空 jar=清除、端口/上次题目跨重启、非法值（端口越界、`../etc/passwd` 之类 slug）被忽略、损坏 JSON 不抛错；`CookieJar` 变化通知（含「值没变不通知」）与 **HttpOnly 保留**。
- `test/integration/extension.test.ts` 新增「登录态 / 端口 / 上次题目在重启 IDE 后仍然保留」：粘贴 cookie → 断言已写入 keys → 退出 → **用同一份 globalState/secrets 重新 activate** → 断言新的 `init` 里 **端口与首次完全相同**、`frameUrl` 直接是 `/problems/two-sum/`、`signedIn: true`，且日志出现「已恢复登录态」。


## 10. v0.2.5：真实使用中暴露的两个问题

| 现象 | 判定 | 处理 |
|---|---|---|
| `TypeError: object of type 'ListNode' has no len()`（用户对 addTwoNumbers 的参数调 `len`） | **不是插件 bug**：LeetCode 的链表参数就是 `ListNode` 对象（`.val/.next`）。但插件把错误只打成了 `__LC_RESULT__ {...}` 一行转义 JSON，无法阅读 | 调试入口改为先打人类可读摘要（用例号、异常类型、**用户自己的栈帧** `solution.py:3（addTwoNumbers）`、中文提示），再打协议行；单用例调试加 `--raise-on-error` 让调试器停在出错行 |
| 之前 `ListNode \| None` 在系统 Python 3.9 上直接崩 | PEP 604 需要 3.10+ | 自动挑选最高 3.10+ 解释器（本机选中 `/opt/homebrew/bin/python3.13`）+ 给注入节点类加兼容 metaclass |

新增测试：`test/core/parse.test.ts` 里 5 组 `hintForError`（Python/C/C++/Java 常见错误 + 未知错误 + 空输入）；
`test/harness/python.test.ts` 里 PEP 604 双解释器回归。总计 284 passed。


## 11. v0.2.6：学习计划里点不进题目

**根因（实测）**：`/studyplan/top-interview-150/` 里的题目行不是 `<a href>`，而是 `div` + React `onClick` → **`window.open()`**。
真实浏览器里这会开新标签页；而在 VS Code / Cursor 的 webview iframe 里 popup 会被直接拦掉，于是"点了没反应"。

Playwright 实测（修复前）：

```
题目行 chain: div.max-w… → div → div → div.flex.h-[52px] → div(hasOnclick:true)
点击后: POPUP → http://127.0.0.1:<port>/problems/merge-sorted-array/?envType=study-plan-v2&envId=top-interview-150
        页面仍停留在 /studyplan/top-interview-150/（iframe 内没有任何跳转）
```

**修复**：

1. 桥接里接管 `window.open` 与 `target=_blank` 的 `<a>`：同站链接改成**当前面板内跳转**，站外链接交给 `vscode.env.openExternal`；
   返回一个 stub window，避免站点走「popup blocked」的兜底分支。
2. 焦点模式**只在 `/problems/<slug>/` 生效**，题库/学习计划等页面不再做布局改造（避免误伤列表）。
3. 左栏新增 `←` `→` `题库` 导航；后退用**自维护的导航栈**（只记非题目页，存 `sessionStorage`），
   因为站点的 SPA 会把 `/problems/x/` 重定向成 `/problems/x/description/`，直接 `history.back()` 会被绕回原页（实测无效）。

修复后实测：

```
点击学习计划里的题目 → NAV /problems/merge-sorted-array/?envType=… → /description/…
popup 次数: 0        bridgeAlive: true      focus: true      editorOnScreen: false
后退 → /studyplan/top-interview-150/        focus: false
```

新增测试：`classifyLink` 5 例（同站/站外/javascript:/空链接/下载链接）。总计 289 passed。
