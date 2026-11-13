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

## 更新截图

README 引用的图片都在 `docs/images/`，**覆盖同名文件即可**（命名对照见 [`docs/images/README.md`](docs/images/README.md)）。
建议宽度 ≥1400px 的 PNG；改完执行：

```bash
npm run build && npx vsce package --no-dependencies --allow-missing-repository
```

## 发布（本机网络注意事项）

本机在校园 MITM 代理后，`git-receive-pack`（push 的 POST）会被 403 拦截，`git clone/fetch`（GET）正常。
用 `scripts/publish.sh`：它会构建 vsix，并通过 GitHub Git Data API 把当前提交同步到远端
（只上传改动过的文件，然后建 commit 并更新 `refs/heads/main`）。

网络恢复后可以直接 `git push`（先 `git fetch origin && git reset --soft origin/main` 对齐一次）。

## 报告问题

请附上：

1. 编辑器与版本（VS Code / Cursor）
2. `LeetCode Dojo: 显示诊断信息` 的输出（含 `langToolchain` / `debuggers` / `layout` 三行）
3. 复现步骤与期望行为

如果是页面相关的异常，再附上浏览器控制台 / 扩展宿主日志里对应的 `[bridge]`、`[proxy]`、`[layout]` 行。

## 许可

提交 PR 即表示同意以 [MIT](LICENSE) 许可发布你的贡献。
