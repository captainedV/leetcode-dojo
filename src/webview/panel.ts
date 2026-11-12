/**
 * 左侧栏 Webview：承载代理后的 LeetCode 页面，并在页面桥接与扩展宿主之间转发消息。
 */
import * as vscode from 'vscode';
import type { HostToShell, ShellToHost } from './protocol.js';

export interface SitePanelDeps {
  extensionUri: vscode.Uri;
  proxyOrigin: string;
  onMessage: (msg: ShellToHost) => void;
  onDispose: () => void;
}

export class SitePanel {
  private disposables: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private queued: HostToShell[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    deps: SitePanelDeps,
  ) {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist', 'media')],
    };
    webview.html = renderShellHtml(webview, deps.extensionUri, deps.proxyOrigin);

    webview.onDidReceiveMessage(
      (msg: ShellToHost) => {
        if (msg.type === 'ready') {
          this.ready = true;
          const queue = this.queued;
          this.queued = [];
          for (const m of queue) this.post(m);
          return;
        }
        deps.onMessage(msg);
      },
      undefined,
      this.disposables,
    );

    panel.onDidDispose(
      () => {
        // 不再回调 this.dispose()：那会触发 panel.dispose() → onDidDispose 的递归
        if (!this.disposed) {
          this.disposed = true;
          deps.onDispose();
        }
      },
      undefined,
      this.disposables,
    );
  }

  static create(deps: SitePanelDeps): SitePanel {
    const panel = vscode.window.createWebviewPanel(
      'lcLocal.site',
      'LeetCode',
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist', 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'dist', 'media', 'leetcode.svg');
    return new SitePanel(panel, deps);
  }

  setTitle(title: string): void {
    if (this.disposed) return;
    try {
      this.panel.title = title;
    } catch {
      /* ignore */
    }
  }

  post(msg: HostToShell): void {
    if (!this.ready) {
      this.queued.push(msg);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  reveal(preserveFocus = true): void {
    this.panel.reveal(vscode.ViewColumn.One, preserveFocus);
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    try {
      this.panel.dispose();
    } catch {
      /* already disposed */
    }
  }
}

/** 渲染左栏 shell 的完整 HTML（导出以便截图脚本与测试复用） */
export function renderShellHtml(webview: vscode.Webview, extensionUri: vscode.Uri, proxyOrigin: string): string {
  const nonce = randomNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'media', 'shell.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'media', 'shell.css'));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: https:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    // iframe 指向本地代理（真实 LeetCode 页面）
    `frame-src ${proxyOrigin} ${webview.cspSource}`,
    `child-src ${proxyOrigin}`,
  ].join('; ');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${styleUri}">
<title>LeetCode</title>
</head>
<body>
<header id="bar">
  <div class="nav-cluster" role="toolbar" aria-label="页面导航">
    <div class="seg-group">
      <button class="seg-btn icon-only" data-act="navBack" title="后退（返回上一非题目页：题库 / 学习计划）">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5L5.5 8 10 12.5"/></svg>
      </button>
      <button class="seg-btn icon-only" data-act="navForward" title="前进">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8 6 12.5"/></svg>
      </button>
      <button class="seg-btn" data-act="navHome" title="回到 LeetCode 题库列表">
        <svg viewBox="0 0 16 16" width="13.5" height="13.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.8L8 2.2l5.5 4.6v6.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V6.8z"/><path d="M6.2 14V9.2h3.6V14"/></svg>
        <span class="label">题库</span>
      </button>
      <button class="seg-btn icon-only" data-act="openProblem" title="输入题号/链接快速跳题">
        <svg viewBox="0 0 16 16" width="13.5" height="13.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.3"/><path d="M10.3 10.3L13.5 13.5"/></svg>
      </button>
    </div>
  </div>

  <button id="problemChip" class="problem-chip" data-act="focusLocal" title="点击定位到右侧本地代码编辑器">
    <span class="brand-dot" aria-hidden="true"></span>
    <span id="title" class="p-title">LeetCode</span>
    <span id="diffBadge" class="diff-badge" hidden></span>
    <span id="subtitle" class="p-file"></span>
  </button>

  <div class="ctrl-cluster">
    <div class="select-wrap" title="切换编程语言（与右侧本地代码文件联动）">
      <select id="lang" aria-label="编程语言"></select>
      <svg class="select-caret" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5L6 7.5 9 4.5"/></svg>
    </div>

    <div class="run-group">
      <button class="btn btn-run" data-act="runLocal" title="在本地运行所有测试用例（⌘/Ctrl+Alt+Enter）">
        <svg viewBox="0 0 16 16" width="12.5" height="12.5" fill="currentColor"><path d="M4.2 2.8a.7.7 0 0 1 1.06-.6l7.6 4.7a.7.7 0 0 1 0 1.2l-7.6 4.7a.7.7 0 0 1-1.06-.6V2.8z"/></svg>
        <span class="label">运行</span>
      </button>
      <button class="btn btn-submit" data-act="submit" title="提交当前本地代码到 LeetCode（⌘/Ctrl+Alt+S）">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 11.5V3.2"/><path d="M4.8 6.2L8 3l3.2 3.2"/><path d="M3 13.2h10"/></svg>
        <span class="label">提交</span>
      </button>
    </div>

    <div class="seg-group">
      <button class="seg-btn is-active" data-act="toggleFocus" id="focusBtn" title="切换「专注题面」/「显示完整网页」">
        <svg viewBox="0 0 16 16" width="13.5" height="13.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="1.8"/><path d="M7.5 2.5v11"/></svg>
        <span class="label" id="focusLabel">专注题面</span>
      </button>
      <button class="seg-btn icon-only" data-act="resetLayout" title="一键恢复标准布局（左栏题面 + 右栏代码 + 底部测试面板）">
        <svg viewBox="0 0 16 16" width="13.5" height="13.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="2.2" width="12.4" height="11.6" rx="1.8"/><path d="M7.4 2.2v11.6"/><path d="M7.4 9.5h6.8"/></svg>
      </button>
      <button class="seg-btn icon-only" data-act="openPanel" title="打开底部测试工作台（测试用例 / 测试结果）">
        <svg viewBox="0 0 16 16" width="13.5" height="13.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="1.8"/><path d="M2 9.8h12"/></svg>
      </button>
    </div>

    <button id="status" class="status-pill" data-act="login" data-level="busy" title="点击检查/刷新登录状态">
      <span class="status-dot"></span>
      <span id="statusText">初始化…</span>
    </button>

    <div class="menu-anchor">
      <button id="moreBtn" class="seg-btn icon-only" type="button" aria-haspopup="true" aria-expanded="false" title="更多操作（提示 / 刷新 / 模板 / 日志 / 设置）">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="3.2" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.8" cy="8" r="1.25"/></svg>
      </button>
      <div id="moreMenu" class="popover-menu" hidden role="menu">
        <button class="menu-item" data-act="aiHint" role="menuitem">
          <span class="mi-icon">💡</span>
          <span class="mi-text">渐进式思路提示</span>
          <kbd>⌘⌥H</kbd>
        </button>
        <button class="menu-item" data-act="debugLocal" role="menuitem">
          <span class="mi-icon">🐞</span>
          <span class="mi-text">启动本地断点调试</span>
        </button>
        <button class="menu-item" data-act="runOnLeetCode" role="menuitem">
          <span class="mi-icon">☁️</span>
          <span class="mi-text">LeetCode 官方试运行</span>
        </button>
        <div class="menu-sep"></div>
        <button class="menu-item" data-act="reloadPage" role="menuitem">
          <span class="mi-icon">↻</span>
          <span class="mi-text">刷新当前网页</span>
        </button>
        <button class="menu-item" data-act="regenerateHarness" role="menuitem">
          <span class="mi-icon">⇄</span>
          <span class="mi-text">重建本地测试脚手架</span>
        </button>
        <button class="menu-item" data-act="reloadSnippet" role="menuitem">
          <span class="mi-icon">↺</span>
          <span class="mi-text">重置为官方代码模板</span>
        </button>
        <div class="menu-sep"></div>
        <button class="menu-item" data-act="showLog" role="menuitem">
          <span class="mi-icon">📋</span>
          <span class="mi-text">打开完整输出日志</span>
        </button>
        <button class="menu-item" data-act="settings" role="menuitem">
          <span class="mi-icon">⚙</span>
          <span class="mi-text">打开插件设置</span>
        </button>
        <button class="menu-item danger" data-act="exitMode" role="menuitem">
          <span class="mi-icon">✕</span>
          <span class="mi-text">退出 LeetCode 模式</span>
        </button>
      </div>
    </div>
  </div>
</header>

<div id="loader" class="loader-bar is-busy" aria-hidden="true"></div>

<div id="stage">
  <iframe id="frame" src="about:blank" allow="clipboard-read; clipboard-write; fullscreen" referrerpolicy="no-referrer-when-downgrade"></iframe>
</div>

<div id="toast" role="status" aria-live="polite">
  <span id="toastIcon" class="toast-icon"></span>
  <span id="toastText" class="toast-text"></span>
  <button id="toastClose" class="toast-close" type="button" title="关闭提示">✕</button>
</div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
