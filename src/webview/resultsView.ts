/**
 * 底部面板 WebviewView：对标并增强 LeetCode 新版工作台的下半部分（Testcase & Test Result）。
 *
 * 核心体验：
 *   1. 顶部紧凑工具栏：题号标题 + 难度胶囊 + 代码路径跳转 + 语言切换 + 本地运行/可取消/调试/官方运行/提交/分栏归位
 *   2. 「测试用例」Tab：支持 Case 胶囊标签切换、按参数名独立编辑输入与期望输出、一键新建/克隆/删除用例并自动落盘 cases.json，以及单用例一键断点调试
 *   3. 「测试结果」Tab：运行中实时进度条，完成后展示汇总横幅（含耗时与官方击败率）、Case 状态胶囊切换（自动聚焦首个失败用例）、Input / Stdout / Actual vs Expected 并排对比卡片与中文诊断建议
 */
import * as vscode from 'vscode';
import type { TestCase } from '../core/types.js';
import type { LangOption } from './protocol.js';

export type ResultsViewAction =
  | 'runLocal'
  | 'cancelRun'
  | 'runOnLeetCode'
  | 'submit'
  | 'debugLocal'
  | 'regenerateHarness'
  | 'openCases'
  | 'reloadSnippet'
  | 'focusLocal'
  | 'openOutput'
  | 'openPanel'
  | 'resetLayout'
  | 'debugCase';

export interface ParamSpec {
  name: string;
  type: string;
}

export interface ResultsViewState {
  title: string;
  slug: string;
  difficulty?: string;
  langSlug: string;
  langs: LangOption[];
  fileName: string;
  params?: ParamSpec[];
  cases: TestCase[];
  note?: string;
}

export interface ResultsViewItem {
  kind: 'pass' | 'fail' | 'unknown' | 'info';
  text: string;
  detail?: string;
}

export interface ResultsCaseDetail {
  index: number;
  ok: boolean | null;
  args: string[];
  actual: string;
  expected: string | null;
  durationMs?: number;
  logs?: string;
  error?: string | null;
  hint?: string;
  note?: string;
}

export interface ResultsViewResult {
  source: 'local' | 'judge';
  ok: boolean;
  title: string;
  detail?: string;
  durationMs?: number;
  runtimePercentile?: number;
  memoryPercentile?: number;
  compileError?: string;
  runtimeError?: string;
  caseDetails?: ResultsCaseDetail[];
  items: ResultsViewItem[];
}

export interface RunningBannerState {
  active: boolean;
  label?: string;
  cancellable?: boolean;
}

type ViewMessage =
  | { type: 'ready' }
  | { type: 'action'; action: ResultsViewAction; index?: number }
  | { type: 'lang'; lang: string }
  | { type: 'tab'; tab: 'cases' | 'results' }
  | { type: 'saveCases'; cases: Array<{ args: string[]; expected: string | null; source?: TestCase['source'] }> };

export interface ResultsViewDeps {
  extensionUri: vscode.Uri;
  onAction: (action: ResultsViewAction, payload?: { index?: number }) => void;
  onLang: (lang: string) => void;
  onSaveCases?: (cases: TestCase[]) => void;
  log?: (line: string) => void;
}

export class ResultsView implements vscode.WebviewViewProvider {
  public static readonly viewId = 'lcLocal.results';

  private view?: vscode.WebviewView;
  private ready = false;
  private queue: unknown[] = [];
  private state: ResultsViewState | undefined;
  private result: ResultsViewResult | undefined;
  private running: RunningBannerState = { active: false };
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
      switch (msg.type) {
        case 'ready': {
          this.ready = true;
          const queue = this.queue;
          this.queue = [];
          for (const m of queue) void view.webview.postMessage(m);
          this.pushAll();
          return;
        }
        case 'action':
          this.deps.onAction(msg.action, { index: msg.index });
          break;
        case 'lang':
          this.deps.onLang(msg.lang);
          break;
        case 'tab':
          this.activeTab = msg.tab;
          break;
        case 'saveCases': {
          if (!Array.isArray(msg.cases)) break;
          const normalized: TestCase[] = msg.cases.map((c, idx) => ({
            index: idx,
            args: Array.isArray(c.args) ? c.args.map((a) => String(a ?? '')) : [],
            expected: c.expected === null || c.expected === undefined || String(c.expected).trim() === '' ? null : String(c.expected),
            source: c.source ?? 'custom',
          }));
          if (this.state) {
            this.state = { ...this.state, cases: normalized };
          }
          this.deps.onSaveCases?.(normalized);
          break;
        }
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
          break;
        }
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

  setRunning(running: RunningBannerState): void {
    this.running = running;
    if (running.active) {
      this.activeTab = 'results';
    }
    this.post({ type: 'running', running, tab: this.activeTab });
  }

  setResults(result: ResultsViewResult): void {
    this.running = { active: false };
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
   */
  async reveal(opts: { focusView?: boolean } = {}): Promise<boolean> {
    const focusView = opts.focusView ?? true;
    const focusCmd = `${ResultsView.viewId}.focus`;
    const containerCmd = 'workbench.view.extension.lcLocalPanel';
    if (this.view?.visible) {
      if (focusView) await this.safeCommand(focusCmd);
      return true;
    }
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
      `[panel] 底部面板 reveal ${visible ? '成功' : '失败：可手动执行「LeetCode Dojo: 打开底部面板」或 查看→面板→LeetCode'}`,
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
    if (this.running.active) this.post({ type: 'running', running: this.running, tab: this.activeTab });
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
    difficulty: state.difficulty,
    langSlug: state.langSlug,
    langs: state.langs,
    fileName: state.fileName,
    params: state.params ?? [],
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
  :root {
    color-scheme: light dark;
    --lc-accent: #ffa116;
    --lc-emerald: var(--vscode-testing-iconPassed, #10b981);
    --lc-emerald-bg: rgba(16, 185, 129, 0.13);
    --lc-amber: var(--vscode-editorWarning-foreground, #f59e0b);
    --lc-amber-bg: rgba(245, 158, 11, 0.13);
    --lc-rose: var(--vscode-errorForeground, #ef4444);
    --lc-rose-bg: rgba(239, 68, 68, 0.13);
    --lc-bg: var(--vscode-panel-background, #1b1b1f);
    --lc-card: rgba(128, 128, 128, 0.065);
    --lc-card-strong: rgba(128, 128, 128, 0.11);
    --lc-border: var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
    --lc-fg: var(--vscode-foreground, #d4d4d8);
    --lc-muted: var(--vscode-descriptionForeground, rgba(161, 161, 170, 0.85));
    --lc-mono: var(--vscode-editor-font-family, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--lc-fg); background: var(--lc-bg);
    -webkit-font-smoothing: antialiased;
  }

  /* 顶部操作条 */
  .head {
    display: flex; align-items: center; gap: 6px; padding: 6px 12px; flex-wrap: wrap;
    border-bottom: 1px solid var(--lc-border);
    background: rgba(128, 128, 128, 0.03);
  }
  .prob-meta {
    display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 44%;
    cursor: pointer; padding: 2px 6px; border-radius: 5px; transition: background .14s ease;
  }
  .prob-meta:hover { background: var(--lc-card-strong); }
  .head .title { font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .diff-pill {
    flex: 0 0 auto; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 999px;
  }
  .diff-pill[hidden] { display: none !important; }
  .diff-pill[data-diff='easy'] { color: var(--lc-emerald); background: var(--lc-emerald-bg); }
  .diff-pill[data-diff='medium'] { color: var(--lc-amber); background: var(--lc-amber-bg); }
  .diff-pill[data-diff='hard'] { color: var(--lc-rose); background: var(--lc-rose-bg); }
  .head .file {
    color: var(--lc-muted); font-size: 11px; font-family: var(--lc-mono);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .head .spacer { flex: 1 1 auto; }

  button, select {
    font: inherit; font-size: 11.5px; font-weight: 500; height: 26px; padding: 0 9px;
    border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
    border: 1px solid rgba(128, 128, 128, 0.22);
    background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.12));
    color: var(--vscode-button-secondaryForeground, var(--lc-fg));
    transition: background .14s ease, border-color .14s ease, transform .08s ease;
    white-space: nowrap;
  }
  button:hover, select:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.2));
  }
  button:active { transform: scale(0.97); }
  button:disabled { opacity: .5; cursor: not-allowed; transform: none; }
  button.run-btn {
    border-color: rgba(16, 185, 129, 0.36);
    background: rgba(16, 185, 129, 0.15);
    color: var(--lc-emerald);
    font-weight: 600;
  }
  button.run-btn:hover { background: rgba(16, 185, 129, 0.25); }
  button.primary {
    border-color: transparent;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    font-weight: 600;
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  button.ghost {
    background: transparent; border-color: transparent; color: var(--lc-muted); padding: 0 7px;
  }
  button.ghost:hover { background: var(--lc-card-strong); color: var(--lc-fg); }
  button.danger-ghost {
    background: transparent; border-color: rgba(239,68,68,.28); color: var(--lc-rose);
  }
  button.danger-ghost:hover { background: var(--lc-rose-bg); }
  button.mini { height: 22px; font-size: 11px; padding: 0 7px; border-radius: 5px; }

  /* 二级导航栏（Tabs + 快捷状态） */
  .subbar {
    display: flex; align-items: center; justify-content: space-between; padding: 0 12px;
    border-bottom: 1px solid var(--lc-border);
    gap: 8px;
  }
  .tabs { display: flex; gap: 2px; }
  .tabs .tab {
    position: relative; padding: 7px 12px; cursor: pointer; font-size: 12px; font-weight: 500;
    color: var(--lc-muted); user-select: none; transition: color .14s ease;
    display: inline-flex; align-items: center; gap: 5px;
  }
  .tabs .tab:hover { color: var(--lc-fg); }
  .tabs .tab.active { color: var(--lc-fg); font-weight: 600; }
  .tabs .tab.active::after {
    content: ''; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px;
    border-radius: 2px; background: var(--lc-accent);
  }
  .tabs .count {
    font-size: 10.5px; padding: 0 5px; border-radius: 999px;
    background: var(--lc-card-strong); color: var(--lc-muted);
  }
  .save-indicator { font-size: 11px; color: var(--lc-muted); opacity: 0; transition: opacity .2s ease; }
  .save-indicator.show { opacity: 1; }

  /* 主内容滚动区 */
  .body { flex: 1 1 auto; overflow: auto; padding: 12px; }

  .empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; gap: 8px; padding: 28px 16px; color: var(--lc-muted);
    border: 1px dashed var(--lc-border); border-radius: 10px; background: var(--lc-card);
    line-height: 1.65;
  }
  .empty-title { font-size: 13px; font-weight: 600; color: var(--lc-fg); }

  .warn-banner {
    display: flex; align-items: center; gap: 8px; padding: 7px 11px; margin-bottom: 10px;
    border-radius: 7px; background: var(--lc-amber-bg); color: var(--lc-amber);
    border: 1px solid rgba(245, 158, 11, 0.3); font-size: 11.5px;
  }

  /* ==================== 测试用例编辑器 ==================== */
  .case-toolbar {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-bottom: 10px; flex-wrap: wrap;
  }
  .case-pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .case-pill {
    height: 26px; padding: 0 10px; border-radius: 6px; font-size: 11.5px; font-weight: 500;
    background: var(--lc-card); border: 1px solid transparent; color: var(--lc-muted);
    cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  }
  .case-pill:hover { background: var(--lc-card-strong); color: var(--lc-fg); }
  .case-pill.active {
    background: var(--lc-card-strong); border-color: rgba(255, 161, 22, 0.45);
    color: var(--lc-fg); font-weight: 600;
  }
  .case-pill .dot { width: 6px; height: 6px; border-radius: 50%; }
  .case-pill .dot.pass { background: var(--lc-emerald); }
  .case-pill .dot.fail { background: var(--lc-rose); }
  .case-pill .dot.unknown { background: var(--lc-amber); }

  .case-editor {
    display: flex; flex-direction: column; gap: 10px;
    padding: 12px; border-radius: 9px; background: var(--lc-card);
    border: 1px solid var(--lc-border);
  }
  .field-group { display: flex; flex-direction: column; gap: 4px; }
  .field-label {
    display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--lc-muted);
    font-family: var(--lc-mono);
  }
  .field-label .pname { color: var(--lc-fg); font-weight: 600; }
  .field-label .ptype { font-size: 10.5px; opacity: .65; }
  .code-input {
    width: 100%; min-height: 32px; padding: 6px 10px; border-radius: 6px;
    border: 1px solid var(--lc-border);
    background: var(--vscode-input-background, rgba(0, 0, 0, 0.2));
    color: var(--vscode-input-foreground, var(--lc-fg));
    font-family: var(--lc-mono); font-size: 12px; line-height: 1.5;
    resize: vertical; outline: none; transition: border-color .14s ease;
  }
  .code-input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .case-foot {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding-top: 4px; flex-wrap: wrap;
  }
  .case-foot-hint { font-size: 11px; color: var(--lc-muted); }
  .case-foot-actions { display: flex; align-items: center; gap: 6px; }

  /* ==================== 测试结果视图 ==================== */
  .running-card {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 14px; border-radius: 9px; margin-bottom: 12px;
    background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3);
  }
  .running-left { display: flex; align-items: center; gap: 10px; font-weight: 500; }
  .spinner {
    width: 15px; height: 15px; border-radius: 50%;
    border: 2px solid rgba(59, 130, 246, 0.28); border-top-color: #3b82f6;
    animation: lc-spin 0.75s linear infinite;
  }
  @keyframes lc-spin { to { transform: rotate(360deg); } }

  .summary-hero {
    display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
    padding: 10px 13px; border-radius: 9px; margin-bottom: 10px;
    border: 1px solid var(--lc-border); background: var(--lc-card);
  }
  .summary-hero[data-ok='true'] {
    background: var(--lc-emerald-bg); border-color: rgba(16, 185, 129, 0.32);
  }
  .summary-hero[data-ok='false'] {
    background: var(--lc-rose-bg); border-color: rgba(239, 68, 68, 0.32);
  }
  .summary-badge { font-size: 14px; font-weight: 700; letter-spacing: -0.01em; }
  .summary-hero[data-ok='true'] .summary-badge { color: var(--lc-emerald); }
  .summary-hero[data-ok='false'] .summary-badge { color: var(--lc-rose); }
  .metric-pill {
    font-size: 11px; padding: 2px 8px; border-radius: 999px;
    background: rgba(128, 128, 128, 0.15); color: var(--lc-fg); font-family: var(--lc-mono);
  }
  .summary-detail { width: 100%; font-size: 11.5px; color: var(--lc-muted); line-height: 1.5; }

  .diff-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px;
  }
  .kv-block { display: flex; flex-direction: column; gap: 4px; }
  .kv-title {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
    color: var(--lc-muted);
  }
  .kv-box {
    margin: 0; padding: 8px 10px; border-radius: 7px;
    background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.22));
    border: 1px solid var(--lc-border);
    font-family: var(--lc-mono); font-size: 12px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word;
  }
  .kv-box.ok { border-color: rgba(16, 185, 129, 0.38); }
  .kv-box.bad { border-color: rgba(239, 68, 68, 0.45); color: var(--lc-rose); }
  .kv-param-row { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
  .kv-param-row + .kv-param-row { border-top: 1px dashed rgba(128, 128, 128, 0.16); }
  .kv-param-name { font-size: 11px; color: var(--lc-muted); }

  .error-box {
    margin: 0; padding: 9px 11px; border-radius: 7px;
    background: var(--lc-rose-bg); border: 1px solid rgba(239, 68, 68, 0.35);
    color: var(--lc-rose); font-family: var(--lc-mono); font-size: 11.5px;
    line-height: 1.55; white-space: pre-wrap; word-break: break-word;
  }
  .hint-callout {
    display: flex; align-items: flex-start; gap: 8px; padding: 8px 11px; border-radius: 7px;
    background: var(--lc-amber-bg); border: 1px solid rgba(245, 158, 11, 0.35);
    font-size: 12px; line-height: 1.55;
  }

  /* 通用结果列表兜底 */
  .row {
    display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border-radius: 6px;
    font-family: var(--lc-mono); font-size: 12px; line-height: 1.5;
  }
  .row:hover { background: var(--lc-card); }
  .row .icon { flex: 0 0 auto; }
  .row .main { flex: 1 1 auto; white-space: pre-wrap; word-break: break-word; }
  .row.fail .main { color: var(--lc-rose); }
  .row .sub { display: block; color: var(--lc-muted); font-size: 11px; margin-top: 2px; }
</style></head>
<body>
<div class="head">
  <div class="prob-meta" data-act="focusLocal" title="点击定位到右侧代码编辑器">
    <span class="title" id="title">LeetCode</span>
    <span class="diff-pill" id="diffPill" hidden></span>
    <span class="file" id="file"></span>
  </div>
  <span class="spacer"></span>
  <select id="lang" title="切换编程语言"></select>
  <button class="run-btn" id="runLocalBtn" data-act="runLocal" title="在本地毫秒级运行所有测试用例（⌘/Ctrl+Alt+Enter）">▶ 本地运行</button>
  <button data-act="debugLocal" title="使用本地调试器启动断点调试">🐞 调试</button>
  <button data-act="runOnLeetCode" title="调用 LeetCode 官方判题机试运行">官方运行</button>
  <button class="primary" data-act="submit" title="提交本地代码到 LeetCode（⌘/Ctrl+Alt+S）">提交</button>
  <button class="ghost" data-act="regenerateHarness" title="从题面示例重新生成用例与本地测试脚手架">重建用例</button>
  <button class="ghost" data-act="openCases" title="在编辑器中打开 cases.json 源文件">用例文件</button>
  <button class="ghost" data-act="resetLayout" title="恢复左栏题面 + 右栏代码分栏布局">◫ 分栏</button>
</div>
<div class="subbar">
  <div class="tabs">
    <div class="tab active" data-tab="cases">测试用例<span class="count" id="count-cases">0</span></div>
    <div class="tab" data-tab="results">测试结果<span class="count" id="count-results">0</span></div>
  </div>
  <span class="save-indicator" id="saveIndicator">✓ 已保存至 cases.json</span>
</div>
<div class="body" id="body"><div class="empty"><div class="empty-title">准备就绪</div><div>进入一道 LeetCode 题目后，示例用例与判题结果将自动显示在这里。</div></div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let state = null;
  let result = null;
  let running = { active: false };
  let tab = 'cases';
  let activeCaseIdx = 0;
  let activeResultIdx = 0;
  let saveTimer = null;

  const ICONS = { pass: '✅', fail: '❌', unknown: '➖', info: 'ℹ️' };

  function esc(t) {
    return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function syncDifficulty(diff) {
    const el = document.getElementById('diffPill');
    if (!el) return;
    const raw = String(diff || '').trim();
    if (!raw) { el.hidden = true; return; }
    const k = raw.toLowerCase();
    el.dataset.diff = (k === 'easy' || raw === '简单') ? 'easy' : (k === 'hard' || raw === '困难') ? 'hard' : 'medium';
    el.textContent = el.dataset.diff === 'easy' ? '简单' : el.dataset.diff === 'hard' ? '困难' : '中等';
    el.hidden = false;
  }

  function flashSaved() {
    const el = document.getElementById('saveIndicator');
    if (!el) return;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1800);
  }

  function scheduleSaveCases() {
    if (!state || !Array.isArray(state.cases)) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      vscode.postMessage({
        type: 'saveCases',
        cases: state.cases.map((c) => ({ args: c.args, expected: c.expected, source: c.source || 'custom' })),
      });
      flashSaved();
    }, 320);
  }

  function render() {
    const titleEl = document.getElementById('title');
    const fileEl = document.getElementById('file');
    const langEl = document.getElementById('lang');
    const runBtn = document.getElementById('runLocalBtn');

    if (runBtn) {
      runBtn.textContent = running.active ? '⏳ 运行中…' : '▶ 本地运行';
      runBtn.disabled = Boolean(running.active);
    }

    if (state) {
      titleEl.textContent = state.title || 'LeetCode';
      fileEl.textContent = state.fileName || '';
      syncDifficulty(state.difficulty);
      if (langEl.dataset.lang !== state.langSlug || langEl.options.length !== (state.langs || []).length) {
        langEl.innerHTML = (state.langs || []).map((l) =>
          '<option value="' + esc(l.slug) + '">' + esc(l.label) + (l.localHarness ? '' : '（仅官方）') + '</option>').join('');
        langEl.value = state.langSlug;
        langEl.dataset.lang = state.langSlug;
      }
      document.getElementById('count-cases').textContent = state.cases ? String(state.cases.length) : '0';
      if (state.cases && activeCaseIdx >= state.cases.length) {
        activeCaseIdx = Math.max(0, state.cases.length - 1);
      }
    }

    const resCount = result
      ? (result.caseDetails && result.caseDetails.length ? result.caseDetails.length : (result.items ? result.items.length : 0))
      : 0;
    document.getElementById('count-results').textContent = String(resCount);

    for (const el of document.querySelectorAll('.tabs .tab')) {
      el.classList.toggle('active', el.dataset.tab === tab);
    }
    document.getElementById('body').innerHTML = tab === 'cases' ? renderCases() : renderResults();
  }

  function paramMetaAt(idx) {
    const list = (state && state.params) || [];
    return list[idx] || { name: 'arg' + (idx + 1), type: '' };
  }

  function renderCases() {
    if (!state || !state.slug) {
      return '<div class="empty"><div class="empty-title">尚未打开题目</div><div>在左侧 LeetCode 网页点进任意题目，右侧将自动创建代码文件并在此展示测试用例。</div></div>';
    }
    const noteHtml = state.note ? '<div class="warn-banner">⚠️ 本语言/题型提示：' + esc(state.note) + '</div>' : '';
    const cases = state.cases || [];
    if (!cases.length) {
      return noteHtml + '<div class="empty"><div class="empty-title">暂无自动解析的示例用例</div>' +
        '<div>可点击下方按钮手动新建用例，或点击顶栏「重建用例」重新解析题面。</div>' +
        '<div><button class="run-btn" data-case-op="add">+ 新建第一个测试用例</button></div></div>';
    }

    const cur = cases[activeCaseIdx] || cases[0];
    const paramCount = Math.max((state.params && state.params.length) || 0, (cur.args && cur.args.length) || 1);

    const pills = cases.map((c, idx) => {
      return '<button type="button" class="case-pill' + (idx === activeCaseIdx ? ' active' : '') + '" data-select-case="' + idx + '">' +
        'Case ' + (idx + 1) + '</button>';
    }).join('') + '<button type="button" class="case-pill" data-case-op="add" title="新增一组自定义用例">＋ 新增</button>';

    let fields = '';
    for (let p = 0; p < paramCount; p++) {
      const pm = paramMetaAt(p);
      const val = (cur.args && cur.args[p] !== undefined) ? cur.args[p] : '';
      const rows = String(val).includes('\\n') ? Math.min(5, String(val).split('\\n').length) : 1;
      fields += '<div class="field-group">' +
        '<label class="field-label"><span class="pname">' + esc(pm.name) + '</span> = ' +
        (pm.type ? '<span class="ptype">(' + esc(pm.type) + ')</span>' : '') + '</label>' +
        '<textarea class="code-input" rows="' + rows + '" data-edit-arg="' + p + '" spellcheck="false" placeholder="输入 JSON 格式参数值…">' + esc(val) + '</textarea>' +
        '</div>';
    }

    const expVal = cur.expected !== null && cur.expected !== undefined ? cur.expected : '';
    fields += '<div class="field-group">' +
      '<label class="field-label"><span class="pname">期望输出</span> <span class="ptype">(可选，留空则仅展示实际运行结果)</span></label>' +
      '<textarea class="code-input" rows="1" data-edit-expected="1" spellcheck="false" placeholder="例如 [0,1]；留空表示不校验期望值">' + esc(expVal) + '</textarea>' +
      '</div>';

    return noteHtml +
      '<div class="case-toolbar"><div class="case-pills">' + pills + '</div>' +
      '<div class="case-foot-actions">' +
      '<button type="button" class="mini" data-debug="' + activeCaseIdx + '" title="仅针对当前用例启动断点调试">🐞 单例调试 #' + (activeCaseIdx + 1) + '</button>' +
      '<button type="button" class="mini" data-case-op="clone" title="复制当前用例为新用例">⎘ 克隆</button>' +
      (cases.length > 1 ? '<button type="button" class="mini danger-ghost" data-case-op="delete" title="删除当前用例">删除</button>' : '') +
      '</div></div>' +
      '<div class="case-editor">' + fields +
      '<div class="case-foot"><span class="case-foot-hint">💡 直接修改上方参数会自动同步至 cases.json，下次本地运行立即生效。</span></div></div>';
  }

  function renderResults() {
    let banner = '';
    if (running && running.active) {
      banner = '<div class="running-card"><div class="running-left"><span class="spinner"></span><span>' +
        esc(running.label || '正在执行测试…') + '</span></div>' +
        (running.cancellable ? '<button type="button" class="mini danger-ghost" data-act="cancelRun">取消运行</button>' : '') +
        '</div>';
    }

    if (!result) {
      if (banner) return banner;
      return '<div class="empty"><div class="empty-title">暂无运行记录</div><div>点击右上角「▶ 本地运行」（⌘/Ctrl+Alt+Enter）在本地毫秒级验证所有用例，或点「官方运行」调用 LeetCode 判题。</div></div>';
    }

    const metrics = [];
    if (typeof result.durationMs === 'number') metrics.push('<span class="metric-pill">⏱ ' + result.durationMs + ' ms</span>');
    if (typeof result.runtimePercentile === 'number') metrics.push('<span class="metric-pill">🚀 耗时击败 ' + result.runtimePercentile.toFixed(1) + '%</span>');
    if (typeof result.memoryPercentile === 'number') metrics.push('<span class="metric-pill">💾 内存击败 ' + result.memoryPercentile.toFixed(1) + '%</span>');
    metrics.push('<span class="metric-pill">' + (result.source === 'local' ? '本地执行' : 'LeetCode 官方判题') + '</span>');

    const summary = '<div class="summary-hero" data-ok="' + (result.ok ? 'true' : 'false') + '">' +
      '<span class="summary-badge">' + (result.ok ? '✓ ' : '✕ ') + esc(result.title) + '</span>' +
      metrics.join('') +
      (result.detail ? '<div class="summary-detail">' + esc(result.detail) + '</div>' : '') +
      '</div>';

    let extraErrors = '';
    if (result.compileError) {
      extraErrors += '<div class="kv-block" style="margin-bottom:10px"><div class="kv-title">编译错误 (Compile Error)</div><pre class="error-box">' + esc(result.compileError) + '</pre></div>';
    }
    if (result.runtimeError) {
      extraErrors += '<div class="kv-block" style="margin-bottom:10px"><div class="kv-title">运行时错误 (Runtime Error)</div><pre class="error-box">' + esc(result.runtimeError) + '</pre></div>';
    }

    const details = result.caseDetails || [];
    if (details.length > 0) {
      if (activeResultIdx >= details.length) activeResultIdx = 0;
      const d = details[activeResultIdx] || details[0];
      const pills = details.map((item, idx) => {
        const dotCls = item.ok === true ? 'pass' : item.ok === false ? 'fail' : 'unknown';
        const dur = item.durationMs !== undefined ? ' · ' + item.durationMs + 'ms' : '';
        return '<button type="button" class="case-pill' + (idx === activeResultIdx ? ' active' : '') + '" data-select-result="' + idx + '">' +
          '<span class="dot ' + dotCls + '"></span>Case ' + (item.index + 1) + dur + '</button>';
      }).join('');

      const argsHtml = (d.args && d.args.length)
        ? d.args.map((a, i) => {
            const pm = paramMetaAt(i);
            return '<div class="kv-param-row"><span class="kv-param-name">' + esc(pm.name) + ' =</span><span>' + esc(a) + '</span></div>';
          }).join('')
        : '<span style="opacity:.6">（无输入参数记录）</span>';

      const actualCls = d.ok === true ? 'kv-box ok' : d.ok === false ? 'kv-box bad' : 'kv-box';

      let card = '<div class="case-toolbar"><div class="case-pills">' + pills + '</div>' +
        '<button type="button" class="mini" data-debug="' + d.index + '">🐞 调试此用例 #' + (d.index + 1) + '</button></div>' +
        '<div class="case-editor">';

      if (d.hint) {
        card += '<div class="hint-callout"><span>💡</span><span>' + esc(d.hint) + '</span></div>';
      }
      if (d.note) {
        card += '<div class="hint-callout"><span>ℹ️</span><span>' + esc(d.note) + '</span></div>';
      }
      if (d.error) {
        card += '<div class="kv-block"><div class="kv-title">异常信息</div><pre class="error-box">' + esc(d.error) + '</pre></div>';
      }

      card += '<div class="kv-block"><div class="kv-title">输入 (Input)</div><div class="kv-box">' + argsHtml + '</div></div>';

      if (d.logs && String(d.logs).trim()) {
        card += '<div class="kv-block"><div class="kv-title">标准输出 (Stdout)</div><pre class="kv-box">' + esc(String(d.logs).trim()) + '</pre></div>';
      }

      card += '<div class="diff-grid">' +
        '<div class="kv-block"><div class="kv-title">实际输出 (Actual)</div><pre class="' + actualCls + '">' + esc(d.actual || '<空>') + '</pre></div>' +
        '<div class="kv-block"><div class="kv-title">期望输出 (Expected)</div><pre class="kv-box">' + esc(d.expected !== null && d.expected !== undefined ? d.expected : '（未提供期望输出）') + '</pre></div>' +
        '</div></div>';

      return banner + summary + extraErrors + card;
    }

    const rows = (result.items || []).map((it) => {
      const icon = ICONS[it.kind] || '•';
      const text = it.detail ? esc(it.text) + '<span class="sub">' + esc(it.detail) + '</span>' : esc(it.text);
      return '<div class="row ' + it.kind + '"><span class="icon">' + icon + '</span><span class="main">' + text + '</span></div>';
    }).join('');
    return banner + summary + extraErrors + rows;
  }

  document.querySelectorAll('.head [data-act]').forEach((btn) => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'action', action: btn.dataset.act }));
  });

  // 主体区域事件委托
  document.getElementById('body').addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!btn) return;
    if (btn.dataset.act) {
      vscode.postMessage({ type: 'action', action: btn.dataset.act });
      return;
    }
    if (btn.dataset.debug !== undefined) {
      vscode.postMessage({ type: 'action', action: 'debugCase', index: Number(btn.dataset.debug) });
      return;
    }
    if (btn.dataset.selectCase !== undefined) {
      activeCaseIdx = Number(btn.dataset.selectCase);
      render();
      return;
    }
    if (btn.dataset.selectResult !== undefined) {
      activeResultIdx = Number(btn.dataset.selectResult);
      render();
      return;
    }
    if (btn.dataset.caseOp && state) {
      const op = btn.dataset.caseOp;
      state.cases = state.cases || [];
      const paramLen = Math.max((state.params && state.params.length) || 0, (state.cases[0] && state.cases[0].args.length) || 1);
      if (op === 'add') {
        const templateArgs = state.cases.length
          ? [...state.cases[state.cases.length - 1].args]
          : Array.from({ length: paramLen }, () => '');
        state.cases.push({ index: state.cases.length, args: templateArgs, expected: null, source: 'custom' });
        activeCaseIdx = state.cases.length - 1;
      } else if (op === 'clone' && state.cases[activeCaseIdx]) {
        const src = state.cases[activeCaseIdx];
        state.cases.splice(activeCaseIdx + 1, 0, {
          index: activeCaseIdx + 1,
          args: [...(src.args || [])],
          expected: src.expected,
          source: 'custom',
        });
        state.cases.forEach((c, i) => { c.index = i; });
        activeCaseIdx += 1;
      } else if (op === 'delete' && state.cases.length > 1) {
        state.cases.splice(activeCaseIdx, 1);
        state.cases.forEach((c, i) => { c.index = i; });
        activeCaseIdx = Math.max(0, Math.min(activeCaseIdx, state.cases.length - 1));
      }
      render();
      scheduleSaveCases();
    }
  });

  document.getElementById('body').addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t || !state || !state.cases || !state.cases[activeCaseIdx]) return;
    const cur = state.cases[activeCaseIdx];
    if (t.dataset.editArg !== undefined) {
      const pIdx = Number(t.dataset.editArg);
      while (cur.args.length <= pIdx) cur.args.push('');
      cur.args[pIdx] = t.value;
      cur.source = 'custom';
      scheduleSaveCases();
    } else if (t.dataset.editExpected !== undefined) {
      const v = t.value.trim();
      cur.expected = v === '' ? null : v;
      scheduleSaveCases();
    }
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
    if (msg.type === 'state') {
      const slugChanged = !state || state.slug !== msg.state.slug;
      state = msg.state;
      if (slugChanged) { activeCaseIdx = 0; activeResultIdx = 0; result = null; }
      render();
    } else if (msg.type === 'running') {
      running = msg.running || { active: false };
      if (msg.tab) tab = msg.tab;
      render();
    } else if (msg.type === 'result') {
      running = { active: false };
      result = msg.result;
      if (result && result.tab) tab = result.tab;
      if (result && Array.isArray(result.caseDetails) && result.caseDetails.length) {
        const firstBad = result.caseDetails.findIndex((d) => d.ok === false);
        activeResultIdx = firstBad >= 0 ? firstBad : 0;
      }
      render();
    } else if (msg.type === 'tab') {
      tab = msg.tab;
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });
  render();
</script>
</body></html>`;
}
