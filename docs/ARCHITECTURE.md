# 技术细节（开发者向）

README 面向使用者，这里放实现的来龙去脉——尤其是那些"看起来应该能用但其实不能用"的坑，避免重复踩。

## 架构

```
VS Code / Cursor 窗口
├── 左栏 Webview：本地反向代理 127.0.0.1:PORT → leetcode.cn
│   ├─ 去掉 X-Frame-Options / CSP，改写文本内绝对 URL（防止 iframe 跳出代理源）
│   ├─ 注入 bridge.js（同源脚本）
│   └─ CookieJar ⇄ 系统钥匙串（登录态免重登）
├── 右栏 编辑器：真实本地文件（solution.py / Solution.java …）
└── 底部面板 WebviewView：测试用例 / 测试结果

扩展宿主（Node）
├── LcSession       题目切换、语言同步、布局守护、会话持久化
├── LeetCodeProxy   文档 + CDN 转发、HTML 注入
├── bridge.js       接管 fetch/XHR 判题请求、路由同步、焦点模式、window.open 拦截
├── 本地测试        9 语言脚手架 + 执行器 + 工具链探测 + 调试配置
└── AI              签名库/单行补全闸门/提示词/AI 守卫
```

## 关键实现与坑

1. **必须代理 CDN 并改写文本**：站点用绝对地址 `https://leetcode.cn/...` 做路由跳转；不改写则 iframe 整页跳出代理源、桥接失效。所以 `static.leetcode.cn` 的 JS/CSS 也经代理，并把 `https://leetcode.cn` 改写为代理源。
2. **焦点模式要压 FlexLayout**：站点面板是绝对定位的 FlexLayout，单纯 `display:none` 会留白，必须同时把题面 tabset 拉到 100%，且只在 `/problems/<slug>/` 生效（否则会误伤题库/学习计划列表）。
3. **接管判题靠改请求体**，不靠点按钮：拦截 `POST /problems/{slug}/(interpret_solution|submit)/`（含 GraphQL 变体），替换 `typed_code` / `lang`，其余字段原样保留。
4. **`window.open` 必须接管**：学习计划里的题目行不是链接而是 `window.open()`，webview 里 popup 会被拦 → 表现为"点了没反应"。
5. **布局守护的两个坑**：`TabInputWebview.viewType` 实际带 `mainThreadWebview-` 前缀；`workbench.action.lockEditorGroup` 在 VS Code 1.138 / Cursor 1.128 里不生效（`isLocked` 恒为 false）。最终方案：监听 `tabGroups.onDidChangeTabs/TabGroups`，把左栏的普通文件搬到右栏。
6. **Python 调试必须走标准 import**：`exec(compile(...))` 生成的代码对象在部分调试器下不绑断点；调试入口改为 `importlib.import_module`，并把 `typing`/`ListNode`/`TreeNode` 注入 `builtins`（不修改用户文件）。单用例调试追加 `--raise-on-error`，让调试器停在出错行。
7. **PEP 604 兼容**：LeetCode 新模板写 `ListNode | None`（需要 3.10+）。运行时自动挑选最高的 3.10+ 解释器；给注入的节点类加兼容 metaclass，使 3.9 也能跑。
8. **乱序等价比较**：多解题目（两数之和下标 / 三数之和 / 全排列 / 异位词分组）官方用 special checker，本地若只做严格比较会误报失败 → 严格不等时做多重集合比较并标注「内容一致但顺序不同」。

## 验证手段

- **299 个自动化测试**：解析、代理改写、判题请求改写、9 语言脚手架真实编译执行（本机 Python 3.9/3.13、Node 25、clang 17、Ruby 2.6 真跑；Java/Go/Rust 无工具链时跳过）、8 条补全规则、布局与 viewType 回归。
- **端到端集成测试**（真实访问 leetcode.cn）：激活 → 起代理 → 建面板 → 路由 → 建文件 → 推送代码 → 本地 Python 3/3 → 切 C++ 编译 3/3 → 退出。
- **真实宿主自检探针**：设置 `LC_LOCAL_SELFTEST=1`（或 `=shot` 生成演示截图状态）后启动编辑器，插件会自动进入模式、打开题目，并把真实 `tabGroups` 状态 dump 成 JSON，用于核对"左题面 / 右代码"是否成立。
- 截图素材与代码同源：`npx vitest run test/docs/uiSnapshot.test.ts` 导出现有 UI 的 HTML，再用真实 Chromium 截图。

## 发布（当前网络下的注意事项）

本机处于校园 MITM 代理后：`git-receive-pack`（push 的 POST）会被 403 拦截，`ls-remote`（GET）正常。

变通方案（`scripts/publish.sh` 即为此实现）：

1. 计算本地每个文件的 blob SHA（内容寻址，与 GitHub 一致）；
2. 用 `GET /repos/{owner}/{repo}/git/trees/main?recursive=1` 拿到远端已有 blob 集合；
3. 仅上传缺失的 blob → 创建 tree → 以远端 `main` 为父提交创建 commit → `PATCH /git/refs/heads/main`；
4. 需要时创建 `refs/tags/*`。

网络恢复后可直接 `git push`：先 `git fetch origin && git reset --soft origin/main` 对齐一次即可。
