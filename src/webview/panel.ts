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
    webview.html = renderHtml(webview, deps.extensionUri, deps.proxyOrigin);

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
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist', 'media')],
      },
    );
    panel.iconPath = undefined;
    return new SitePanel(panel, deps);
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

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, proxyOrigin: string): string {
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
  <div class="titles">
    <span id="title">LeetCode</span>
    <span id="subtitle"></span>
  </div>
  <span id="status" data-level="busy">初始化…</span>
  <span class="lc-sep"></span>
  <button class="icon" data-act="navBack" title="后退（回到学习计划/题库）">←</button>
  <button class="icon" data-act="navForward" title="前进">→</button>
  <button class="icon" data-act="navHome" title="回到题库列表">题库</button>
  <select id="lang" title="切换语言（与本地文件联动）"></select>
  <button data-act="toggleFocus" id="focusBtn" title="只显示题面 / 显示完整网页（含线上 IDE）">只显示题面</button>
  <button data-act="aiHint" title="获取不直接给答案的提示（⌘/Ctrl+Alt+H）">提示</button>
  <button data-act="reloadPage" title="刷新网页（登录后可重载）">刷新</button>
  <button data-act="openPanel" title="打开底部「LeetCode」面板（测试用例 / 结果）">面板</button>
  <button data-act="showLog" title="打开完整输出面板">输出</button>
  <button data-act="settings" title="打开设置">⚙</button>
</header>
<div id="stage">
  <iframe id="frame" src="about:blank" allow="clipboard-read; clipboard-write; fullscreen" referrerpolicy="no-referrer-when-downgrade"></iframe>
</div>
<div id="toast"></div>
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
