# Changelog

本项目遵循「版本号对齐 `package.json` + 每个版本一条 tag」的约定。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，日期为本地时间。

## [0.4.3] — 2026-11-13

### Fixed
- **登录后 Copilot 仍会整函数补全**（约束没生效）。根因：`AiGuard` 只写**工作区设置**，
  而当前窗口没有打开文件夹时 VS Code 会拒绝写工作区设置（错误被吞掉）——题目文件落在
  `globalStorage` 就是这种情况，于是一条约束都没生效。
  - 作用域自动降级：有文件夹 → 工作区设置；没有文件夹 → 用户设置（全局，退出练习模式时按作用域精确还原）
  - **自动发现设置键**：VS Code 1.138 的 Copilot 已是内置扩展（copilot-chat 0.66），
    `github.copilot.inlineSuggest.enable` 已被移除。现在读取已装扩展的 `package.json`，
    把「AI 补全相关且默认为 true」的开关自动加入压制列表（跳过 `chat.*`/索引类，避免误伤）
  - 写入后**读回校验**，日志打印实际生效值；诊断信息新增 `guardSettings=…`（每项带作用域）
  - 首次压制后给出一次「重载窗口」提示（Copilot 对设置变更通常需要重载才完全生效）
  - 新增 `lcLocal.aiGuard.aggressive`：连 `editor.inlineSuggest.enabled` 一起关（彻底静音灰字，本插件 ghost text 也会停用）
  - Copilot 的三个精选键**无条件尝试写入**（VS Code 对未注册的键会拒绝并给出原因，日志里会显示
    `not a registered configuration`，说明当前窗口里 Copilot 没有注册这些设置）
  - 实测（真实 VS Code 1.138，无文件夹 profile）：日志明确报出写入被拒的具体键名与原因，
    证明链路已到达写入点；文件夹 + 已启用 Copilot 时即写到工作区设置

## [0.4.2] — 2026-11-13

### Fixed
- **提交后一直显示「判题中」，且语言被切到 C++**
  1. 语言：旧逻辑只要「网页上的语言 ≠ 本地语言」就切本地文件，而站点本身常是 C++（我们又把提交语言改成你的语言），
     于是每次提交都会把右侧从 Python 换成 C++。现在只在你**真的在网页上切换过语言**时才跟随（比较前后两次观察值）。
  2. 状态：原来只有拿到桥接解析出的结果才会清除「判题中」。现在增加**宿主侧兜底轮询**（用同一份登录态自己去查结果）
     与**超时复位**（新增设置 `lcLocal.judge.timeoutMs`，默认 120s），三者任一先到都会正确收尾。
  3. 顺带修掉一个自己造成的缺陷：开始看护时会无条件发一条 `running:false`，把刚出现的「判题中」横幅立刻关掉。
- 命令现在会转发参数（例如 `lcLocal.switchLanguage` 可直接指定语言，便于脚本与测试）。

## [0.4.1] — 2026-11-13

### Fixed
- **「只显示题面」后，题目描述 / 题解 / 提交记录 那一栏被折叠**：旧实现直接改写 FlexLayout 的 inline 样式，
  关闭焦点模式时又把它们清掉，导致站点对那一栏的尺寸模型被破坏（变成 `0x0`），只有刷新页面才恢复。
  现在改为「只给题面面板打标记类 + CSS `!important`」，**完全不碰站点的 inline 样式**，
  关闭时移除标记类即可原样复原；并额外兼容站点自身把该栏折叠的情况。
  （新增回归守卫测试 `test/bridge/focusMode.test.ts`，禁止再出现对布局元素写/删几何 inline 样式）

## [0.4.0] — 2026-11-12

首个公开发布版本（仓库更名为 **LeetCode Dojo**，扩展 ID 仍为 `xialc.leetcode-local-ide`）。

### Added
- 左栏内嵌 `leetcode.cn`（本地反向代理），支持**栏内登录**；Cookie 持久化到系统钥匙串，重开 IDE 免登录
- **焦点模式**：题目页自动隐藏线上 IDE（代码区 / 测试用例区），题面铺满整栏；可一键切换回完整网页
- 底部面板（WebviewView）：**测试用例 / 测试结果** 双 tab，含按用例调试、自定义输入、运行 / 提交 / 重建按钮
- 本地测试脚手架：Python、C、C++、Java、JavaScript、TypeScript、Go、Rust、Ruby（真实进程执行）
- 官方运行 / 提交：REST 直连 + 页面桥接（改包 `fetch`/`XHR`）双通道
- 断点调试：调试器类型按扩展探测并自动降级；Python 走标准 `import` 入口
- AI 受限补全：`off` / `signature`（274 条 API 签名）/ `line`（8 条硬规则闸门）
- 分级提示（`api` / `nudge` / `approach`）、AI 生成测试脚手架
- AI 守卫：进入练习模式时压制 Copilot 与已知 Cursor 设置，写 `.cursorignore`
- 自动左右分栏 + **布局守护**（左栏出现普通文件自动搬回右栏）
- 学习计划 / 每日一题等入口进题：接管 `window.open`，同站链接在面板内跳转

### Fixed（本版本内的重要修复，均带回归测试）
- `TabInputWebview.viewType` 带 `mainThreadWebview-` 前缀导致「布局守护」从未生效
- `workbench.action.lockEditorGroup` 在新版 VS Code / Cursor 中不生效 → 改为主动搬移
- Python PEP 604 注解（`ListNode | None`）在系统 3.9 上崩溃 → 自动选 3.10+ + 兼容 metaclass
- 学习计划里点题目无反应（`window.open` 被 webview 拦截）
- 多解题目顺序不同被误判为失败 → 增加乱序等价比较
- 底部面板「贡献了但从不打开」→ 进入模式时自动打开 + 失败兜底提示
- 站点用绝对地址路由导致 iframe 跳出代理源 → 代理 CDN 并改写文本内绝对 URL

## 历史里程碑（提交记录）

| 标签 | 说明 |
|---|---|
| `v0.2.6` | 支持学习计划等入口进题（接管 `window.open`）、按用例调试、登录态持久化 |
| `v0.3.1` | 界面重做 + 修复自动分栏（viewType 前缀 / 布局守护） |
| `v0.4.0` | 首次对外发布，品牌更名 LeetCode Dojo，补全 README / CI / 文档 |

[0.4.0]: https://github.com/captainedV/leetcode-dojo/releases/tag/v0.4.0
