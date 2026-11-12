/**
 * 底部面板 WebviewView：模仿 LeetCode 线上 IDE 的下半部分。
 *
 * 布局：
 *   标题 + 语言 + 操作按钮（本地运行 / 官方运行 / 提交 / 调试）
 *   [测试用例] [测试结果]  两个 tab
 *   用例列表 / 结果列表（每个用例：实际值、期望值、耗时、stdout）
 *
 * 为什么放底部面板而不是塞在左侧网页里：VS Code 的原生面板本来就"在编辑器下方"，
 * 和 LeetCode 的布局一致；而且不依赖页面 DOM，站点改版也不会影响它。
 */
import * as vscode from 'vscode';
import type { TestCase } from '../core/types.js';
import type { LangOption } from './protocol.js';

export type ResultsViewAction =
  | 'runLocal'
  | 'runOnLeetCode'
  | 'submit'
  | 'debugLocal'
  | 'regenerateHarness'
  | 'openCases'
  | 'reloadSnippet'
  | 'focusLocal'
  | 'openOutput'
  | 'openPanel'
  | 'debugCase';

export interface ResultsViewState {
  title: string;
  slug: string;
  langSlug: string;
  langs: LangOption[];
  fileName: string;
  cases: TestCase[];
  note?: string;
}

export interface ResultsViewItem {
  kind: 'pass' | 'fail' | 'unknown' | 'info';
  text: string;
  detail?: string;
}

export interface ResultsViewResult {
  source: 'local' | 'judge';
  ok: boolean;
  title: string;
  detail?: string;
  items: ResultsViewItem[];
}

type ViewMessage =
  | { type: 'ready' }
  | { type: 'action'; action: ResultsViewAction; index?: number }
  | { type: 'lang'; lang: string }
  | { type: 'tab'; tab: 'cases' | 'results' };

export interface ResultsViewDeps {
  extensionUri: vscode.Uri;
  onAction: (action: ResultsViewAction, payload?: { index?: number }) => void;
  onLang: (lang: string) => void;
  log?: (line: string) => void;
}

export class ResultsView implements vscode.WebviewViewProvider {
  public static readonly viewId = 'lcLocal.results';

  private view?: vscode.WebviewView;
  private ready = false;
  private queue: unknown[] = [];
  private state: ResultsViewState | undefined;
  private result: ResultsViewResult | undefined;
  private activeTab: 'cases' | 'results' = 'cases';

  private log(line: string): void {
    this.deps.log?.(line);
  }

  constructor(private readonly deps: ResultsViewDeps) {}

  static register(context: vscode.ExtensionContext, deps: ResultsViewDeps): ResultsView {
    const instance = new ResultsView(deps);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ResultsView.viewId, instance, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );
    return instance;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'media')],
    };
    view.webview.html = renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: ViewMessage) => {
      if (msg.type === 'ready') {
        this.ready = true;
        const queue = this.queue;
        this.queue = [];
        for (const m of queue) void view.webview.postMessage(m);
        this.pushAll();
        return;
      }
      if (msg.type === 'action') this.deps.onAction(msg.action, { index: msg.index });
      else if (msg.type === 'lang') this.deps.onLang(msg.lang);
      else if (msg.type === 'tab') {
        this.activeTab = msg.tab;
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
    this.pushAll();
  }

  setState(state: ResultsViewState): void {
    this.state = state;
    this.post({ type: 'state', state: serializeState(state) });
  }

  setResults(result: ResultsViewResult): void {
    this.result = result;
    this.activeTab = 'results';
    this.post({ type: 'result', result: { ...result, tab: this.activeTab } });
  }

  /** 视图是否已经被 VS Code 解析出来（面板是否已创建） */
  get isResolved(): boolean {
    return !!this.view;
  }

  /**
   * 让底部面板真正出现在用户眼前。
   *
   * 为什么需要这么多兜底：`viewsContainers.panel` 贡献出来的容器**不会自动打开**，
   * 用户必须先手动把面板叫出来。而不同版本/发行版（Cursor 等）对
   * `<viewId>.focus` / `workbench.view.extension.<container>` 的行为不完全一致，
   * 所以按顺序尝试并检查 `visible`。
   */
  async reveal(opts: { focusView?: boolean } = {}): Promise<boolean> {
    const focusView = opts.focusView ?? true;
    const focusCmd = `${ResultsView.viewId}.focus`;
    const containerCmd = 'workbench.view.extension.lcLocalPanel';
    if (this.view?.visible) {
      if (focusView) await this.safeCommand(focusCmd);
      return true;
    }
    // 注意：这里**不能**用 workbench.action.togglePanel 兜底——面板已经可见时它会把面板关掉。
    const attempts = focusView ? [focusCmd, containerCmd] : [containerCmd, focusCmd];
    for (const cmd of attempts) {
      await this.safeCommand(cmd);
      await delay(80);
      if (this.view?.visible) {
        if (focusView && cmd !== focusCmd) await this.safeCommand(focusCmd);
        return true;
      }
    }
    const visible = !!this.view?.visible;
    this.log(
      `[panel] 底部面板 reveal ${visible ? '成功' : '失败：可手动执行「LeetCode Local: 打开底部面板」或 查看→面板→LeetCode'}`,
    );
    return visible;
  }

  private async safeCommand(cmd: string): Promise<boolean> {
    try {
      await vscode.commands.executeCommand(cmd);
      return true;
    } catch (err) {
      this.log(`[panel] 命令 ${cmd} 不可用：${(err as Error).message}`);
      return false;
    }
  }

  private pushAll(): void {
    if (this.state) this.post({ type: 'state', state: serializeState(this.state) });
    if (this.result) this.post({ type: 'result', result: { ...this.result, tab: this.activeTab } });
    this.post({ type: 'tab', tab: this.activeTab });
  }

  private post(msg: unknown): void {
    if (!this.view || !this.ready) {
      this.queue.push(msg);
      return;
    }
    void this.view.webview.postMessage(msg);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeState(state: ResultsViewState): Record<string, unknown> {
  return {
    title: state.title,
    slug: state.slug,
    langSlug: state.langSlug,
    langs: state.langs,
    fileName: state.fileName,
    note: state.note,
    cases: state.cases.map((c) => ({ index: c.index, args: c.args, expected: c.expected, source: c.source })),
  };
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = randomNonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family, -apple-system, sans-serif); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground, #ccc); background: var(--vscode-panel-background, #1e1e1e);
  }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex-wrap: wrap;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); }
  .head .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
  .head .file { opacity: .65; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); }
  .head .spacer { flex: 1 1 auto; }
  button, select { font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ddd); }
  button:hover, select:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
  button.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .tabs { display: flex; gap: 4px; padding: 4px 10px 0; }
  .tabs .tab { padding: 4px 10px; border-radius: 4px 4px 0 0; cursor: pointer; font-size: 12px; opacity: .7;
    border: 1px solid transparent; border-bottom: none; }
  .tabs .tab.active { opacity: 1; background: var(--vscode-editor-background, #252526);
    border-color: var(--vscode-panel-border, rgba(128,128,128,.3)); }
  .tabs .count { opacity: .6; margin-left: 4px; }
  .body { flex: 1 1 auto; overflow: auto; padding: 8px 10px 12px; }
  .empty { opacity: .6; padding: 12px 4px; line-height: 1.7; }
  .row { display: flex; gap: 8px; align-items: flex-start; padding: 5px 6px; border-radius: 4px;
    font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace); font-size: 12px; line-height: 1.5; }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
  .row .icon { flex: 0 0 auto; }
  .row .idx { flex: 0 0 auto; opacity: .6; min-width: 3.2em; }
  .row .main { flex: 1 1 auto; white-space: pre-wrap; word-break: break-word; }
  .row.fail .main { color: var(--vscode-errorForeground, #f85149); }
  .row.pass .icon { color: var(--vscode-testing-iconPassed, #3fb950); }
  .row.fail .icon { color: var(--vscode-errorForeground, #f85149); }
  .row.unknown .icon { color: var(--vscode-editorWarning-foreground, #d29922); }
  .row .sub { display: block; opacity: .7; font-size: 11px; margin-top: 2px; }
  .summary { display: flex; gap: 10px; align-items: center; padding: 4px 6px 8px; font-size: 12px; }
  .summary .badge { font-weight: 700; }
  .summary[data-ok='true'] .badge { color: var(--vscode-testing-iconPassed, #3fb950); }
  .summary[data-ok='false'] .badge { color: var(--vscode-errorForeground, #f85149); }
  .hint { opacity: .65; font-size: 11.5px; padding: 0 6px 8px; }
  button.mini { font-size: 11px; padding: 1px 7px; align-self: center; }
</style></head>
<body>
<div class="head">
  <span class="title" id="title">LeetCode</span>
  <span class="file" id="file"></span>
  <span class="spacer"></span>
  <select id="lang" title="切换语言"></select>
  <button class="primary" data-act="runLocal" title="在本地跑所有用例">本地运行</button>
  <button data-act="runOnLeetCode" title="用 LeetCode 官方判题跑示例用例">官方运行</button>
  <button data-act="submit" title="提交到 LeetCode">提交</button>
  <button data-act="debugLocal" title="用本地调试器运行">调试</button>
  <button data-act="regenerateHarness" title="从题面重建测试脚手架">重建用例</button>
  <button data-act="openCases" title="编辑 cases.json 自定义用例">用例文件</button>
</div>
<div class="tabs">
  <div class="tab active" data-tab="cases">测试用例<span class="count" id="count-cases"></span></div>
  <div class="tab" data-tab="results">测试结果<span class="count" id="count-results"></span></div>
</div>
<div class="body" id="body"><div class="empty">正在初始化…</div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let state = null;
  let result = null;
  let tab = 'cases';

  const ICONS = { pass: '✅', fail: '❌', unknown: '➖', info: 'ℹ️' };

  function esc(t) {
    return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render() {
    const titleEl = document.getElementById('title');
    const fileEl = document.getElementById('file');
    const langEl = document.getElementById('lang');
    if (state) {
      titleEl.textContent = state.title || 'LeetCode';
      fileEl.textContent = state.fileName || '';
      if (langEl.dataset.lang !== state.langSlug) {
        langEl.innerHTML = (state.langs || []).map((l) =>
          '<option value="' + esc(l.slug) + '">' + esc(l.label) + (l.localHarness ? '' : '（仅官方判题）') + '</option>').join('');
        langEl.value = state.langSlug;
        langEl.dataset.lang = state.langSlug;
      }
      document.getElementById('count-cases').textContent = state.cases ? '（' + state.cases.length + '）' : '';
    }
    document.getElementById('count-results').textContent = result && result.items ? '（' + result.items.length + '）' : '';
    for (const el of document.querySelectorAll('.tabs .tab')) el.classList.toggle('active', el.dataset.tab === tab);
    document.getElementById('body').innerHTML = tab === 'cases' ? renderCases() : renderResults();
  }

  function renderCases() {
    if (!state) return '<div class="empty">先进入 LeetCode 模式并打开一道题。</div>';
    if (!state.cases || !state.cases.length) {
      return '<div class="empty">这道题没有解析到用例。' +
        '<br>可以点上方「重建用例」，或点「用例文件」在 cases.json 里手写（args 是每个参数一行的原文，expected 是期望输出）。</div>';
    }
    const rows = state.cases.map((c) => {
      const args = (c.args || []).join('\\n');
      return '<div class="row"><span class="icon">▸</span><span class="idx">#' + (c.index + 1) + '</span>' +
        '<span class="main">' + esc(args) +
        (c.expected !== null && c.expected !== undefined ? '<span class="sub">期望输出：' + esc(c.expected) + '</span>' : '<span class="sub">（题面没有给出期望输出，运行后只展示实际值）</span>') +
        '</span><button class="mini" data-debug="' + c.index + '" title="用这个用例启动调试">调试</button></div>';
    }).join('');
    return '<div class="hint">用例来自 LeetCode 官方示例输入 + 题面输出解析；可在 cases.json 里增删。</div>' + rows;
  }

  function renderResults() {
    if (!result) return '<div class="empty">还没有运行结果。点「本地运行」在本地跑用例（毫秒级），或「官方运行」走 LeetCode 判题。</div>';
    const summary = '<div class="summary" data-ok="' + (result.ok ? 'true' : 'false') + '">' +
      '<span class="badge">' + (result.ok ? '✅' : '❌') + ' ' + esc(result.title) + '</span>' +
      (result.detail ? '<span>' + esc(result.detail) + '</span>' : '') + '</div>';
    const rows = (result.items || []).map((it) => {
      const icon = ICONS[it.kind] || '•';
      const text = it.detail ? esc(it.text) + '<span class="sub">' + esc(it.detail) + '</span>' : esc(it.text);
      return '<div class="row ' + it.kind + '"><span class="icon">' + icon + '</span><span class="main">' + text + '</span></div>';
    }).join('');
    return summary + rows;
  }

  document.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'action', action: btn.dataset.act }));
  });
  // 用例行的「调试」按钮（行是动态渲染的，用事件委托）
  document.getElementById('body').addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.dataset || t.dataset.debug === undefined) return;
    vscode.postMessage({ type: 'action', action: 'debugCase', index: Number(t.dataset.debug) });
  });
  document.querySelectorAll('.tabs .tab').forEach((el) => {
    el.addEventListener('click', () => {
      tab = el.dataset.tab;
      vscode.postMessage({ type: 'tab', tab });
      render();
    });
  });
  document.getElementById('lang').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'lang', lang: e.target.value });
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') { state = msg.state; render(); }
    else if (msg.type === 'result') { result = msg.result; if (msg.result && msg.result.tab) tab = msg.result.tab; render(); }
    else if (msg.type === 'tab') { tab = msg.tab; render(); }
  });

  vscode.postMessage({ type: 'ready' });
  render();
</script>
</body></html>`;
}
