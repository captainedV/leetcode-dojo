# 贡献指南

感谢你愿意改进 LeetCode Dojo！下面是让改动顺利合入的几个约定。

## 开发环境

```bash
npm ci             # 锁定依赖
npm run build      # esbuild：扩展 + webview + 注入脚本
npm run typecheck  # tsc --noEmit（必须干净）
npm test           # 299 个测试
```

在 VS Code 里调试插件：`npm run build` 后执行 `code --extensionDevelopmentPath=.`。

## 代码结构

| 目录 | 职责 |
|---|---|
| `src/core/` | 站点适配、GraphQL 客户端、题面解析、题目工作区、会话编排、会话存储 |
| `src/proxy/` | 本地反向代理、请求 / 响应改写、CookieJar |
| `src/bridge/` | 注入到页面的桥接脚本（判题请求接管、焦点模式、路由同步） |
| `src/webview/` | 左栏 shell 与底部面板（WebviewView） |
| `src/runner/` | 跨语言测试脚手架、执行器、工具链探测、调试配置 |
| `src/ai/` | 签名库、单行补全闸门、提示词、AI 守卫 |

## 提交前自检清单

- [ ] `npm run typecheck` 与 `npm test` 全绿
- [ ] 新增的纯逻辑（解析 / 规则 / 判定）**必须带单测**；能真跑的语言请真跑
- [ ] 涉及站点 DOM / 网络的改动，请在 PR 描述里附上**实测依据**（例如 `docs/verification` 里的方式）
- [ ] 不要提交 `dist/`、`*.vsix`、`leetcode/`（运行期题目目录）
- [ ] 面向用户的文案统一用「LeetCode Dojo」；配置键前缀保持 `lcLocal.`

## 报告问题

请附上：

1. 编辑器与版本（VS Code / Cursor）
2. `LeetCode Dojo: 显示诊断信息` 的输出（含 `langToolchain` / `debuggers` / `layout` 三行）
3. 复现步骤与期望行为

如果是页面相关的异常，再附上浏览器控制台 / 扩展宿主日志里对应的 `[bridge]`、`[proxy]`、`[layout]` 行。

## 许可

提交 PR 即表示同意以 [MIT](LICENSE) 许可发布你的贡献。
