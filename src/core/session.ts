/**
 * 会话编排：进入/退出练习模式，把「内嵌网页 ↔ 本地文件 ↔ 本地测试 ↔ 官方判题」串起来。
 */
import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CookieJar } from '../proxy/cookies.js';
import { LeetCodeProxy } from '../proxy/server.js';
import { getSite, type SiteConfig } from './site.js';
import { LcClient } from './lcapi.js';
import { ProblemStore, type ProblemFiles } from './workspace.js';
import { SessionStore } from './cookieStore.js';
import { SitePanel } from '../webview/panel.js';
import { ResultsView } from '../webview/resultsView.js';
import type { ResultsViewAction, ResultsViewItem } from '../webview/resultsView.js';
import type { HostToShell, LangOption, ShellAction, ShellToHost } from '../webview/protocol.js';
import type { BridgeMessage, HostMessage, JudgeKind } from '../bridge/protocol.js';
import { formatJudgeResult } from '../bridge/judge.js';
import { runLocalTests, runStep } from '../runner/execute.js';
import { checkLangToolchain, resolveExecutable, resolvePython, resolvePython2 } from '../runner/toolchain.js';
import { debugPlanFor, describeBlocked, orderDebugCandidates, toDebugCompileSteps } from '../runner/debug.js';
import { materialize } from '../runner/execute.js';
import { getHarness } from '../runner/harness/index.js';
import { classifyType } from '../runner/harness/types.js';
import { allLangs, getLang, normalizeLangSlug } from './langs.js';
import type { LcMetaData, LcQuestion, RunResult, TestCase } from './types.js';
import { parseCustomInput, parseMetaData } from './parse.js';
import { hintForError } from './diagnose.js';
import { AssistantClient, readAiConfig } from '../ai/provider.js';
import { requestHint, requestLineCompletion } from '../ai/hints.js';
import { buildHintPrompt } from '../ai/prompts.js';
import { generateHarnessWithAI } from '../ai/aiHarness.js';
import { AiGuard } from '../ai/guard.js';

interface ActiveProblem {
  slug: string;
  question: LcQuestion;
  meta?: LcMetaData;
  files: ProblemFiles;
  langSlug: string;
  casesOverride?: TestCase[];
}

export interface SessionDeps {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  store: ProblemStore;
}

export class LcSession implements vscode.Disposable {
  private readonly jar: CookieJar;
  private readonly client: LcClient;
  private readonly ai: AssistantClient;
  private readonly guard: AiGuard;
  private proxy?: LeetCodeProxy;
  private panel?: SitePanel;
  private active?: ActiveProblem;
  private disposables: vscode.Disposable[] = [];
  private pushTimer?: ReturnType<typeof setTimeout>;
  private statusBar: vscode.StatusBarItem;
  private resultsView: ResultsView;
  private readonly sessionStore: SessionStore;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private username?: string;
  private lastReportedSignedIn?: boolean;
  private lastPush = { lang: '', code: '' };

  constructor(private readonly deps: SessionDeps) {
    const site = currentSite();
    this.sessionStore = new SessionStore(deps.context, (l) => this.log(l));
    // cookie 一变就（防抖）持久化：登录态、csrftoken 都不会因为重开 IDE 而丢
    this.jar = new CookieJar(site, (reason) => this.onCookiesChanged(reason));
    this.client = new LcClient({ site, jar: this.jar, log: (l) => this.log(l) });
    this.ai = new AssistantClient(readAiConfig(), (l) => this.log(`[ai] ${l}`));
    this.guard = new AiGuard(deps.context, (l) => this.log(`[guard] ${l}`));
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.resultsView = ResultsView.register(deps.context, {
      extensionUri: deps.context.extensionUri,
      onAction: (action, payload) => void this.onResultsViewAction(action, payload),
      onLang: (lang) => void this.switchLanguage(lang, { silent: true }),
      log: (line) => this.log(line),
    });
    this.statusBar.command = 'lcLocal.enter';
    this.statusBar.text = '$(browser) LeetCode';
    this.statusBar.tooltip = '进入 LeetCode 练习模式（左侧网页 + 右侧本地 IDE）';
  }

  // ------------------------------------------------------------------ 生命周期

  get isActive(): boolean {
    return !!this.panel;
  }

  async enter(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const cfg = vscode.workspace.getConfiguration('lcLocal');
    const site = getSite(cfg.get<string>('site', 'leetcode.cn'));
    this.jar.setSite(site);
    await this.loadCookies(site.id);
    const bridgePath = join(this.deps.context.extensionPath, 'dist', 'media', 'bridge.js');
    // 端口固定复用：站点页面的 localStorage 按源隔离，端口一变草稿/语言选择就丢了
    const savedPort = this.sessionStore.getPort(site.id);
    const configuredPort = cfg.get<number>('proxy.port', 0);
    const proxy = new LeetCodeProxy({
      site,
      jar: this.jar,
      port: savedPort ?? configuredPort,
      bridgeScriptPath: bridgePath,
      injectBridge: cfg.get<boolean>('proxy.injectBridge', true),
      log: (l) => this.log(l),
      onBridgeLog: (payload) => this.log(`[bridge] ${JSON.stringify(payload).slice(0, 500)}`),
    });
    try {
      await proxy.start();
    } catch (err) {
      void vscode.window.showErrorMessage(`启动本地代理失败：${(err as Error).message}`);
      return;
    }
    this.proxy = proxy;
    if (proxy.port !== savedPort && proxy.port > 0) {
      await this.sessionStore.setPort(site.id, proxy.port);
    }

    if (!site.embeddable) {
      void vscode.window.showWarningMessage(site.note ?? `${site.host} 无法内嵌，已退化为 API 模式。`);
    }

    this.panel = SitePanel.create({
      extensionUri: this.deps.context.extensionUri,
      proxyOrigin: proxy.origin(),
      onMessage: (msg) => void this.onShellMessage(msg),
      onDispose: () => void this.onPanelDisposed(),
    });
    await vscode.commands.executeCommand('setContext', 'lcLocal.active', true);
    this.statusBar.show();
    this.statusBar.text = '$(browser) LeetCode 模式';
    this.registerListeners();
    await vscode.commands.executeCommand('setContext', 'lcLocal.active', true);
    this.guard.enable(this.deps.store.baseDir()).then((r) => {
      if (r.changed.length) this.log(`[guard] 已压制 ${r.changed.join(', ')}`);
    });
    void this.pushPanelInit();
    // 底部面板需要主动打开一次（贡献出来的容器不会自动出现）
    void this.ensureResultsPanelVisible();
    void this.refreshSession();
  }

  async exit(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persistCookies('exit');
    await this.guard.disable();
    this.panel?.dispose();
    this.panel = undefined;
    await this.proxy?.stop();
    this.proxy = undefined;
    this.active = undefined;
    this.statusBar.text = '$(browser) LeetCode';
    await vscode.commands.executeCommand('setContext', 'lcLocal.active', false);
    this.disposeListeners();
  }

  dispose(): void {
    this.disposeListeners();
    void this.proxy?.stop();
    this.statusBar.dispose();
  }

  private registerListeners(): void {
    this.disposeListeners();
    const push = () => this.schedulePush();
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.isPracticeFile(e.document)) push();
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.isPracticeFile(doc)) {
          this.schedulePush();
          void this.syncActiveDocument(doc);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && this.isPracticeFile(editor.document)) void this.syncActiveDocument(editor.document);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('lcLocal')) void this.pushPanelState();
      }),
    );
  }

  private disposeListeners(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
  }

  // ------------------------------------------------------------------ 面板联动

  private async pushPanelInit(): Promise<void> {
    if (!this.panel || !this.proxy) return;
    const langs = this.langOptions();
    const signedIn = this.jar.isSignedIn();
    const lastSlug = this.sessionStore.getLastSlug();
    const landing = lastSlug ? `/problems/${lastSlug}/` : '/problemset/';
    this.panel.post({
      type: 'init',
      frameUrl: this.proxy.url(landing),
      title: this.active?.question.title ?? 'LeetCode 题库',
      lang: this.active?.langSlug ?? defaultLang(),
      langs,
      signedIn,
      fileName: this.active ? relativeName(this.active) : '',
    });
    this.pushCodeToBridge();
  }

  /** 确保底部「LeetCode」面板可见（不抢焦点） */
  private async ensureResultsPanelVisible(): Promise<void> {
    try {
      const visible = await this.resultsView.reveal({ focusView: false });
      if (!visible) {
        this.log('[panel] 底部面板仍未显示，可手动：查看 → 面板 → LeetCode，或执行命令「LeetCode Local: 打开底部面板」');
        // 有些发行版/布局下扩展面板容器不会自动展开，给一个可见的入口，别让用户去猜
        void vscode.window
          .showInformationMessage(
            '测试用例 / 结果面板没能自动打开。可以手动打开它（查看 → 面板），或把结果显示在输出面板里。',
            '打开面板',
            '用输出面板',
          )
          .then((pick) => {
            if (pick === '打开面板') void this.openResultsPanel();
            if (pick === '用输出面板') this.deps.output.show(true);
          });
      }
      // 面板打开后把焦点还给左栏网页，避免打断用户
      this.panel?.reveal(true);
    } catch (err) {
      this.log(`[panel] reveal 失败：${(err as Error).message}`);
    }
  }

  /** 把当前题目/语言/用例同步到底部面板 */
  private async pushResultsViewState(): Promise<void> {
    const active = this.active;
    if (!active) {
      this.resultsView.setState({
        title: 'LeetCode',
        slug: '',
        langSlug: defaultLang(),
        langs: this.langOptions(),
        fileName: '',
        cases: [],
      });
      return;
    }
    let cases: TestCase[] = [];
    try {
      cases = await this.deps.store.readCases(active.files, active.question);
    } catch {
      cases = [];
    }
    const harness = getHarness(active.langSlug);
    const support = harness && active.meta ? harness.supports(active.meta) : undefined;
    this.resultsView.setState({
      title: `${active.question.questionFrontendId ?? active.question.questionId}. ${active.question.title}`,
      slug: active.question.titleSlug,
      langSlug: active.langSlug,
      langs: this.langOptions(),
      fileName: relativeName(active),
      cases,
      note: support && support.ok === false ? support.reason : undefined,
    });
  }

  private async pushPanelState(): Promise<void> {
    if (!this.panel) return;
    this.panel.post({
      type: 'state',
      lang: this.active?.langSlug,
      title: this.active?.question.title,
      fileName: this.active ? relativeName(this.active) : '',
      signedIn: this.jar.isSignedIn(),
    });
  }

  private langOptions(): LangOption[] {
    const snippets = this.active?.question.codeSnippets ?? [];
    const seen = new Set<string>();
    const out: LangOption[] = [];
    for (const s of snippets) {
      const slug = normalizeLangSlug(s.langSlug);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ slug, label: s.lang, localHarness: !!getHarness(slug) });
    }
    if (!out.length) {
      for (const l of allLangs()) out.push({ slug: l.slug, label: l.label, localHarness: l.harness });
    }
    return out;
  }

  private async onShellMessage(msg: ShellToHost): Promise<void> {
    if (msg.type === 'bridge') {
      await this.onBridgeMessage(msg.msg);
      return;
    }
    if (msg.type === 'lang') {
      await this.switchLanguage(msg.lang, { silent: true });
      return;
    }
    if (msg.type === 'action') {
      await this.handleAction(msg.action);
    }
  }

  private async handleAction(action: ShellAction): Promise<void> {
    switch (action) {
      case 'runLocal':
        await this.runLocal();
        break;
      case 'debugLocal':
        await this.debugLocal();
        break;
      case 'runOnLeetCode':
        await this.runOnLeetCode();
        break;
      case 'submit':
        await this.submitToLeetCode();
        break;
      case 'aiHint':
        await vscode.commands.executeCommand('lcLocal.aiHint');
        break;
      case 'reloadSnippet':
        await this.reloadSnippet();
        break;
      case 'regenerateHarness':
        await this.regenerateHarness();
        break;
      case 'reloadPage':
        await this.reloadPage();
        break;
      case 'focusLocal':
        await this.focusLocalEditor();
        break;
      case 'showLog':
        this.deps.output.show(true);
        break;
      case 'openPanel':
        await this.ensureResultsPanelVisible();
        await this.resultsView.reveal({ focusView: true });
        break;
      case 'navBack':
        this.panel?.post({ type: 'bridge', msg: { t: 'history', action: 'back' } });
        break;
      case 'navForward':
        this.panel?.post({ type: 'bridge', msg: { t: 'history', action: 'forward' } });
        break;
      case 'navHome':
        this.panel?.post({ type: 'bridge', msg: { t: 'history', action: 'home' } });
        break;
      case 'toggleFocus': {
        const cfg = vscode.workspace.getConfiguration('lcLocal');
        const next = !cfg.get<boolean>('editor.hideSiteEditor', true);
        await cfg.update('editor.hideSiteEditor', next, vscode.ConfigurationTarget.Global);
        this.pushCodeToBridge();
        this.panel?.post({ type: 'toast', text: next ? '已切换为「只显示题面」' : '已显示完整网页（含线上 IDE）', level: 'info' });
        break;
      }
      case 'settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'lcLocal');
        break;
      case 'openProblem':
        await vscode.commands.executeCommand('lcLocal.openProblem');
        break;
      case 'login':
        await this.refreshSession(true);
        break;
    }
  }

  private async onBridgeMessage(msg: BridgeMessage): Promise<void> {
    switch (msg.t) {
      case 'ready': {
        this.log('[bridge] ready');
        this.pushCodeToBridge();
        void this.pushPanelState();
        break;
      }
      case 'route': {
        if (msg.slug) await this.openProblem(msg.slug, { fromPage: true });
        break;
      }
      case 'state': {
        this.log(`[bridge] state slug=${msg.slug ?? '-'} lang=${msg.lang ?? '-'} monaco=${msg.hasMonaco} editor=${msg.editorFound}`);
        break;
      }
      case 'intercept': {
        this.log(
          `[bridge] 拦截 ${msg.kind} slug=${msg.slug} lang=${msg.siteLang ?? msg.lang} 已替换=${msg.replaced} 代码 ${msg.codeLength}B`,
        );
        if (msg.siteLang && this.active && normalizeLangSlug(msg.siteLang) !== this.active.langSlug) {
          void this.followSiteLanguage(msg.siteLang);
        } else if (msg.replaced) {
          this.panel?.post({ type: 'status', text: msg.kind === 'submit' ? '已接管提交' : '已接管运行', level: 'ok' });
        }
        break;
      }
      case 'judgeStarted': {
        this.panel?.post({ type: 'status', text: '判题中…', level: 'busy' });
        break;
      }
      case 'judgeResult': {
        this.renderJudgeResult(msg.kind, msg.result);
        break;
      }
      case 'judgeError': {
        this.log(`[bridge] ${msg.kind} 失败：${msg.message}`);
        break;
      }
      case 'needCode': {
        this.pushCodeToBridge();
        break;
      }
      case 'openExternal': {
        // 站点里指向站外（或需要新窗口）的链接：交给系统浏览器
        try {
          const uri = vscode.Uri.parse(msg.url);
          if (uri.scheme === 'https' || uri.scheme === 'http') {
            await vscode.env.openExternal(uri);
          }
        } catch (err) {
          this.log(`[bridge] 打开外部链接失败：${(err as Error).message}`);
        }
        break;
      }
      case 'action': {
        if (msg.action === 'focusLocal') await this.focusLocalEditor();
        else if (msg.action === 'aiHint') await vscode.commands.executeCommand('lcLocal.aiHint');
        break;
      }
      case 'log': {
        if (msg.level !== 'debug') this.log(`[bridge/${msg.level}] ${msg.message}`);
        break;
      }
    }
  }

  /** 底部面板按钮 */
  private async onResultsViewAction(
    action: ResultsViewAction,
    payload?: { index?: number },
  ): Promise<void> {
    switch (action) {
      case 'runLocal':
        await this.runLocal();
        break;
      case 'runOnLeetCode':
        await this.runOnLeetCode();
        break;
      case 'submit':
        await this.submitToLeetCode();
        break;
      case 'debugLocal':
        await this.debugLocal();
        break;
      case 'debugCase':
        await this.debugLocal(payload?.index);
        break;
      case 'regenerateHarness':
        await this.regenerateHarness();
        break;
      case 'openCases': {
        const active = this.active;
        if (!active) return;
        const doc = await vscode.workspace.openTextDocument(active.files.cases);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preview: true });
        break;
      }
      case 'reloadSnippet':
        await this.reloadSnippet();
        break;
      case 'focusLocal':
        await this.focusLocalEditor();
        break;
      case 'openOutput':
        this.deps.output.show(true);
        break;
      case 'openPanel':
        await this.resultsView.reveal({ focusView: true });
        break;
    }
  }

  private async onPanelDisposed(): Promise<void> {
    this.panel = undefined;
    await this.proxy?.stop();
    this.proxy = undefined;
    this.statusBar.text = '$(browser) LeetCode';
    await vscode.commands.executeCommand('setContext', 'lcLocal.active', false);
    await this.guard.disable();
    this.disposeListeners();
  }

  // ------------------------------------------------------------------ 代码同步

  /** 该文档是否属于练习目录（供补全提供器判断） */
  isPracticeFile(doc: vscode.TextDocument): boolean {
    const base = this.deps.store.baseDir().fsPath;
    return doc.uri.fsPath.startsWith(base);
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      this.pushCodeToBridge();
    }, 300);
  }

  /** 把当前代码 + 语言推给页面桥接（页面在用户点运行/提交时使用） */
  private pushCodeToBridge(): void {
    if (!this.panel || !this.active) return;
    const code = this.activeDocumentCode();
    const lang = this.active.langSlug;
    this.lastPush = { lang, code };
    const msg: HostMessage = {
      t: 'push',
      lang,
      code,
      fileName: relativeName(this.active),
      hideEditor: vscode.workspace.getConfiguration('lcLocal').get<boolean>('editor.hideSiteEditor', true),
    };
    this.panel.post({ type: 'bridge', msg });
  }

  private activeDocumentCode(): string {
    const active = this.active;
    if (!active) return '';
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === active.files.source.fsPath);
    if (open) return open.getText();
    try {
      // 同步读取（文件由我们管理，体积很小）
      return readFileSync(active.files.source.fsPath, 'utf8');
    } catch {
      return '';
    }
  }

  private async syncActiveDocument(doc: vscode.TextDocument): Promise<void> {
    if (!this.active) return;
    if (doc.uri.fsPath !== this.active.files.source.fsPath) {
      // 用户切到了同题的另一个语言文件
      const lang = this.inferLangFromDocument(doc);
      if (lang && lang !== this.active.langSlug) {
        this.active.langSlug = lang;
        this.active.files = await this.deps.store.files(this.active.question, lang);
        await this.deps.store.updateMeta(this.active.files.meta, { langSlug: lang });
        void this.pushPanelState();
      }
    }
    this.schedulePush();
  }

  private inferLangFromDocument(doc: vscode.TextDocument): string | undefined {
    const snippets = this.active?.question.codeSnippets ?? [];
    const fileName = doc.uri.path.split('/').pop() ?? '';
    const exact = snippets.find((s) => this.deps.store.sourceFileName(normalizeLangSlug(s.langSlug)) === fileName);
    if (exact) return normalizeLangSlug(exact.langSlug);
    return undefined;
  }

  // ------------------------------------------------------------------ 打开题目

  async openProblem(slug: string, opts: { fromPage?: boolean } = {}): Promise<void> {
    if (this.active?.slug === slug) {
      this.pushCodeToBridge();
      return;
    }
    const site = currentSite();
    this.panel?.post({ type: 'status', text: '加载题目…', level: 'busy' });
    let question: LcQuestion;
    try {
      question = await this.client.fetchQuestion(slug);
    } catch (err) {
      const msg = (err as Error).message;
      this.log(`[problem] 拉取失败：${msg}`);
      this.panel?.post({ type: 'toast', text: `拉取题目失败：${msg}`, level: 'error' });
      return;
    }
    if (question.isPaidOnly) {
      this.panel?.post({ type: 'toast', text: '这是会员题，可能无法获取完整题面。', level: 'warn' });
    }
    const langSlug = this.pickInitialLang(question);
    const { files, created } = await this.deps.store.ensureProblem(question, langSlug);
    const meta = parseMetaData(question.metaData);
    this.active = { slug, question, meta, files, langSlug };
    this.log(`[problem] ${slug} → ${files.dir.fsPath}（${langSlug}，${created ? '新建' : '已存在'}）`);

    const doc = await vscode.workspace.openTextDocument(files.source);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: !!opts.fromPage ? false : true,
      preview: false,
    });
    await this.deps.store.updateMeta(files.meta, { langSlug });
    void this.sessionStore.setLastSlug(slug);
    await this.pushPanelState();
    this.panel?.post({ type: 'status', text: site.id, level: 'ok' });
    this.pushCodeToBridge();
    await this.pushResultsViewState();
    void this.ensureResultsPanelVisible();
    this.statusBar.tooltip = `${question.title}（${langSlug}）`;
    // 预热脚手架（失败不影响主流程）
    void this.ensureHarnessQuietly();

    const harness = getHarness(langSlug);
    const support = harness && meta ? harness.supports(meta) : { ok: false as const, reason: '无内置脚手架' };
    if (!support.ok) {
      this.panel?.post({
        type: 'toast',
        text: `本地测试不可用：${support.reason}\n仍可用「官方运行 / 提交」。`,
        level: 'warn',
      });
    }
  }

  private pickInitialLang(question: LcQuestion): string {
    const prev = this.active;
    void prev;
    const cfgLang = vscode.workspace.getConfiguration('lcLocal').get<string>('run.defaultLang', '');
    const available = (question.codeSnippets ?? []).map((s) => normalizeLangSlug(s.langSlug));
    const preferred = [cfgLang, defaultLang(), 'python3'].map((l) => normalizeLangSlug(l)).filter(Boolean);
    for (const p of preferred) if (available.includes(p)) return p;
    return available[0] ?? 'python3';
  }

  // ------------------------------------------------------------------ 语言切换

  async switchLanguage(langSlug?: string, opts: { silent?: boolean } = {}): Promise<void> {
    const active = this.active;
    if (!active) {
      void vscode.window.showInformationMessage('请先进入一道题目。');
      return;
    }
    let target = langSlug ? normalizeLangSlug(langSlug) : undefined;
    if (!target) {
      const options = this.langOptions().map((l) => ({
        label: l.label,
        description: l.slug,
        detail: l.localHarness ? '支持本地运行/调试' : '仅支持官方判题',
        slug: l.slug,
      }));
      const picked = await vscode.window.showQuickPick(options, {
        title: '切换语言（会同步本地文件与提交语言）',
        placeHolder: `当前：${active.langSlug}`,
      });
      if (!picked) return;
      target = picked.slug;
    }
    if (target === active.langSlug) return;
    const files = await this.deps.store.files(active.question, target);
    const snippet = this.deps.store.pickSnippet(active.question, target);
    if (!existsSync(files.source.fsPath)) {
      await this.deps.store.writeFile(files.source, snippet || `// ${active.question.title}\n`);
      this.log(`[lang] 新建 ${files.source.fsPath}`);
    }
    active.langSlug = target;
    active.files = files;
    await this.deps.store.updateMeta(files.meta, { langSlug: target });
    const doc = await vscode.workspace.openTextDocument(files.source);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preview: false, preserveFocus: true });
    this.pushCodeToBridge();
    await this.pushPanelState();
    await this.pushResultsViewState();
    if (!opts.silent) {
      const harness = getHarness(target);
      const support = harness && active.meta ? harness.supports(active.meta) : undefined;
      this.panel?.post({
        type: 'toast',
        text: support?.ok === false ? `已切换到 ${target}：${support.reason}` : `已切换到 ${target}`,
        level: support?.ok === false ? 'warn' : 'info',
      });
    }
    void this.ensureHarnessQuietly();
  }

  /** 用户在网页上切了语言：本地跟着切（并提示本次判题可能用了旧语言） */
  private async followSiteLanguage(siteLang: string): Promise<void> {
    const active = this.active;
    if (!active) return;
    const target = normalizeLangSlug(siteLang);
    if (!this.langOptions().some((l) => l.slug === target)) return;
    await this.switchLanguage(target, { silent: true });
    this.panel?.post({
      type: 'toast',
      text: `检测到你在网页上切换到了 ${target}，本地文件已跟着切换；请重新点击运行/提交。`,
      level: 'warn',
    });
  }

  // ------------------------------------------------------------------ 本地测试

  private async ensureHarnessQuietly(): Promise<void> {
    try {
      const active = this.active;
      if (!active?.meta) return;
      const harness = getHarness(active.langSlug);
      if (!harness) return;
      const support = harness.supports(active.meta);
      if (!support.ok) return;
      const cases = await this.deps.store.readCases(active.files, active.question);
      const artifact = harness.generate({
        langSlug: active.langSlug,
        meta: active.meta,
        testCases: cases,
        sourceFile: nameOf(active.files.source.fsPath),
        sourceAbsPath: active.files.source.fsPath,
        sourceCode: await this.deps.store.readSource(active.files),
        genDir: active.files.localDir.fsPath,
        titleSlug: active.question.titleSlug,
      });
      await materialize(artifact, active.files.localDir.fsPath);
      this.log(`[harness] 已生成 ${artifact.files.map((f) => f.name).join(', ')}`);
    } catch (err) {
      this.log(`[harness] 生成失败：${(err as Error).message}`);
    }
  }

  async runLocal(): Promise<void> {
    const active = await this.requireActive();
    if (!active) return;
    if (!active.meta) {
      void vscode.window.showErrorMessage('拿不到题目的函数签名（metaData），无法生成本地测试。');
      return;
    }
    const harness = getHarness(active.langSlug);
    if (!harness) {
      const pick = await vscode.window.showWarningMessage(
        `${active.langSlug} 暂无内置本地测试脚手架。`,
        '用 AI 生成',
        '在 LeetCode 上运行',
      );
      if (pick === '用 AI 生成') await this.aiHarness();
      else if (pick === '在 LeetCode 上运行') await this.runOnLeetCode();
      return;
    }
    await this.saveActiveDocument();
    const cases = await this.deps.store.readCases(active.files, active.question);
    this.log(`[run] 本地测试 ${active.langSlug}，${cases.length} 个用例`);
    this.panel?.post({ type: 'status', text: '本地运行中…', level: 'busy' });
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LeetCode 本地运行', cancellable: false },
      () =>
        runLocalTests(
          {
            langSlug: active.langSlug,
            meta: active.meta!,
            testCases: cases,
            sourceFile: nameOf(active.files.source.fsPath),
            sourceAbsPath: active.files.source.fsPath,
            sourceCode: this.activeDocumentCode(),
            genDir: active.files.localDir.fsPath,
            titleSlug: active.question.titleSlug,
          },
          {
            timeoutMs: vscode.workspace.getConfiguration('lcLocal').get<number>('run.timeoutMs', 20000),
            pythonPath: vscode.workspace.getConfiguration('lcLocal').get<string>('python.path', '') || undefined,
            onLog: (line) => this.log(line.trimEnd()),
          },
        ),
    );
    this.renderLocalResult(result);
    await this.pushResultsViewState();
  }

  private renderLocalResult(result: RunResult): void {
    const passed = result.cases.filter((c) => c.ok === true).length;
    const failed = result.cases.filter((c) => c.ok === false).length;
    const unknown = result.cases.filter((c) => c.ok === null).length;

    this.log('──────────────── 本地测试结果 ────────────────');
    if (result.unsupportedReason) {
      this.log(`⚠️ ${result.unsupportedReason}`);
      if (result.stderr?.trim()) this.log(result.stderr.trim());
      this.resultsView.setResults({
        source: 'local',
        ok: false,
        title: '本地测试未能执行',
        detail: result.unsupportedReason,
        items: [{ kind: 'info', text: result.unsupportedReason }],
      });
      void this.resultsView.reveal();
      this.panel?.post({ type: 'status', text: '本地测试不可用', level: 'warn' });
      this.deps.output.show(true);
      void vscode.window
        .showErrorMessage(`本地测试未能执行：${firstLine(result.unsupportedReason)}`, '查看输出', '重建脚手架', '在 LeetCode 上运行')
        .then((pick) => {
          if (pick === '查看输出') this.deps.output.show(true);
          if (pick === '重建脚手架') void this.regenerateHarness();
          if (pick === '在 LeetCode 上运行') void this.runOnLeetCode();
        });
      return;
    }

    const items: Array<{ kind: 'pass' | 'fail' | 'unknown' | 'info'; text: string }> = [];
    for (const c of result.cases) {
      const kind: 'pass' | 'fail' | 'unknown' = c.ok === true ? 'pass' : c.ok === false ? 'fail' : 'unknown';
      const mark = kind === 'pass' ? '✅' : kind === 'fail' ? '❌' : '➖';
      const note = c.meta?.note as string | undefined;
      let text = `用例 ${c.index + 1}：实际 ${c.actual || '<空>'}${c.expected ? ` ｜ 期望 ${c.expected}` : ''}${note ? ` ｜ ${note}` : ''}`;
      this.log(`${mark} ${text}${c.durationMs !== undefined ? `（${c.durationMs}ms）` : ''}`);
      if (c.error) {
        const errMsg = c.error.split('\n').slice(0, 6).join('\n');
        this.log(`    错误：\n${errMsg}`);
        const hint = hintForError(c.error);
        text += ` ｜ 错误：${firstLine(c.error)}`;
        if (hint) {
          this.log(`    💡 ${hint.hint}`);
          items.push({ kind: 'info', text: `💡 ${hint.hint}` });
        }
      }
      const logs = (c.meta?.logs as string | undefined) ?? '';
      if (logs.trim()) {
        this.log(`    输出：${logs.trim().split('\n').slice(0, 10).join('\n')}`);
        text += ` ｜ 你的输出：${firstLine(logs.trim())}`;
      }
      items.push({ kind, text });
    }
    if (result.stderr?.trim() && result.cases.length === 0) {
      this.log(result.stderr.trim());
      items.push({ kind: 'info', text: firstLine(result.stderr.trim()) });
    }
    const total = result.cases.length;
    this.log(`合计：通过 ${passed} / 失败 ${failed}${unknown ? ` / 未判定 ${unknown}` : ''}，耗时 ${result.durationMs}ms`);
    const title = total ? `本地测试 ${passed}/${total} 通过` : '本地测试未产生结果';
    const firstFail = result.cases.find((c) => c.ok === false);
    const detailParts: string[] = [];
    if (unknown) detailParts.push(`${unknown} 个用例没有期望输出（可在 cases.json 里补 expected）`);
    if (!result.ok && firstFail) {
      detailParts.push(
        `首个失败：用例 ${firstFail.index + 1} 实际 ${firstFail.actual || '<空>'} / 期望 ${firstFail.expected ?? '（无）'}`,
      );
      const hint = hintForError(firstFail.error);
      if (hint) detailParts.push(`💡 ${hint.hint}`);
    }

    this.resultsView.setResults({
      source: 'local',
      ok: result.ok,
      title,
      detail: detailParts.join('；'),
      items: items as ResultsViewItem[],
    });
    void this.resultsView.reveal();
    this.panel?.post({
      type: 'status',
      text: result.ok ? '本地全部通过' : failed ? `本地 ${passed}/${total}` : '本地完成',
      level: result.ok ? 'ok' : 'warn',
    });

    if (result.ok) {
      void vscode.window
        .showInformationMessage(`本地测试全部通过（${passed}/${total}）`, '打开面板', '在 LeetCode 上运行', '提交')
        .then((pick) => {
          if (pick === '打开面板') void this.openResultsPanel();
          if (pick === '在 LeetCode 上运行') void this.runOnLeetCode();
          if (pick === '提交') void this.submitToLeetCode();
        });
    } else {
      // 关键：失败时自动把输出面板带出来（之前只提示「详情见输出面板」，用户找不到）
      this.deps.output.show(true);
      void vscode.window
        .showWarningMessage(
          `本地测试未通过（${passed}/${total}）${firstFail ? `：用例 ${firstFail.index + 1} 实际 ${firstFail.actual || '<空>'}，期望 ${firstFail.expected ?? '（无）'}` : ''}`,
          '打开面板',
          '查看输出',
          '在 LeetCode 上运行',
        )
        .then((pick) => {
          if (pick === '打开面板') void this.openResultsPanel();
          if (pick === '查看输出') this.deps.output.show(true);
          if (pick === '在 LeetCode 上运行') void this.runOnLeetCode();
        });
    }
  }

  /**
   * 选要调试的用例：默认「全部」，也可以挑某个用例，或手写自定义输入。
   */
  private async pickDebugCases(
    cases: TestCase[],
    active: ActiveProblem,
    caseIndex?: number,
  ): Promise<TestCase[] | undefined> {
    if (caseIndex !== undefined) {
      const hit = cases.find((c) => c.index === caseIndex);
      if (hit) return [hit];
      this.log(`[debug] 找不到用例 #${caseIndex + 1}，改为让用户选择`);
    }
    const preview = (c: TestCase): string => {
      const text = c.args.join(' | ').replace(/\s+/g, ' ');
      return text.length > 64 ? `${text.slice(0, 64)}…` : text;
    };
    const items: Array<vscode.QuickPickItem & { value: 'all' | 'custom' | number }> = [
      { label: '$(debug-all) 全部用例', description: `${cases.length} 个，逐个跑`, value: 'all' },
      ...cases.map((c) => ({
        label: `$(circle-outline) 用例 ${c.index + 1}`,
        description: preview(c),
        value: c.index,
      })),
      { label: '$(edit) 自定义输入…', description: '手动指定这次调试的参数', value: 'custom' as const },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: '调试用哪个用例？',
      placeHolder: `当前 ${active.langSlug} 共 ${cases.length} 个用例`,
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    if (picked.value === 'all') return cases;
    if (typeof picked.value === 'number') {
      const hit = cases.find((c) => c.index === picked.value);
      return hit ? [hit] : cases;
    }
    // 自定义输入
    const paramNames = active.meta?.params.map((p) => p.name) ?? [];
    const text = await vscode.window.showInputBox({
      title: '自定义调试输入',
      prompt: `共 ${paramNames.length} 个参数（${paramNames.join(', ')}）：可写 \`l1 = [2,4,3], l2 = [5,6,4]\`，或每个参数一行/分号分隔`,
      placeHolder: paramNames.map((n) => `${n} = …`).join(', '),
      ignoreFocusOut: true,
      value: cases[0]?.args.map((a, i) => (paramNames[i] ? `${paramNames[i]} = ${a}` : a)).join(', ') ?? '',
    });
    if (text === undefined) return undefined;
    const parsed = parseCustomInput(text, paramNames);
    if (parsed.error || !parsed.args.length) {
      void vscode.window.showErrorMessage(`自定义输入无法解析：${parsed.error ?? '参数为空'}`);
      return undefined;
    }
    this.log(`[debug] 自定义输入：${parsed.args.map((a) => a.replace(/\s+/g, ' ')).join(' | ')}`);
    return [{ index: 0, args: parsed.args, expected: null, source: 'custom' }];
  }

  /**
   * 本地调试。
   * @param caseIndex 指定要调试的用例序号（底部面板的「调试」按钮会传）；不传则弹选择：
   *        全部用例 / 某个用例 / 自定义输入
   */
  async debugLocal(caseIndex?: number): Promise<void> {
    const active = await this.requireActive();
    if (!active?.meta) return;
    const lang = active.langSlug;
    const harness = getHarness(lang);
    if (!harness) {
      void vscode.window.showErrorMessage(`${lang} 暂不支持本地调试。`, '改为本地运行').then((p) => {
        if (p === '改为本地运行') void this.runLocal();
      });
      return;
    }

    // 先确认工具链（GUI 编辑器 PATH 不全时，报错要能指导用户）
    const tc = await checkLangToolchain(lang);
    if (tc.missing.length) {
      this.log(`[debug] 缺少工具链：${tc.missing.join(', ')}\n${tc.hints.join('\n')}`);
      void vscode.window.showErrorMessage(`无法调试：找不到 ${tc.missing.join(' / ')}。${tc.hints.join(' ')}`, '查看输出');
      return;
    }

    await this.saveActiveDocument();
    const allCases = await this.deps.store.readCases(active.files, active.question);
    const chosen = await this.pickDebugCases(allCases, active, caseIndex);
    if (!chosen) return;
    this.log(`[debug] 调试用例：${chosen.map((c) => `#${c.index + 1}`).join(', ')}`);
    const artifact = harness.generate({
      langSlug: lang,
      meta: active.meta,
      testCases: chosen,
      sourceFile: nameOf(active.files.source.fsPath),
      sourceAbsPath: active.files.source.fsPath,
      sourceCode: this.activeDocumentCode(),
      genDir: active.files.localDir.fsPath,
      titleSlug: active.question.titleSlug,
      debug: true,
    });
    await materialize(artifact, active.files.localDir.fsPath);
    // 调试需要调试信息：把编译步骤换成 -g -O0（否则断点绑不上）
    const debugSteps = toDebugCompileSteps(lang, artifact.steps);
    this.log(`[debug] 入口=${artifact.debugEntry}，编译步骤=${debugSteps
      .filter((s) => s.label === 'compile' || s.label === 'build')
      .map((s) => `${s.cmd} ${s.args.join(' ')}`)
      .join(' | ') || '（无需编译）'}`);
    for (const step of debugSteps) {
      if (step.label === 'compile' || step.label === 'build') {
        const out = await runStep(step, active.files.localDir.fsPath, {
          timeoutMs: 60000,
          onLog: (l) => this.log(l.trimEnd()),
        });
        if (out.code !== 0) {
          this.deps.output.show(true);
          void vscode.window.showErrorMessage('编译失败，无法开始调试（详见输出面板）。');
          return;
        }
      }
    }

    const runStepDef = artifact.steps.find((s) => s.label === 'run');
    const binary =
      runStepDef && runStepDef.cmd.startsWith('./') ? join(active.files.localDir.fsPath, runStepDef.cmd.slice(2)) : undefined;
    // 调试器必须用「和本地运行同一个」解释器；python 优先 3.10+（PEP 604 注解）
    const cfgPython = vscode.workspace.getConfiguration('lcLocal').get<string>('python.path', '') || undefined;
    const singleCase = chosen.length === 1;
    const pythonPath = lang.startsWith('python')
      ? (lang === 'python' ? await resolvePython2() : await resolvePython(cfgPython))?.path
      : undefined;
    if (pythonPath) this.log(`[debug] 使用解释器 ${pythonPath}`);
    const plan = debugPlanFor({
      langSlug: lang,
      localDir: active.files.localDir.fsPath,
      entry: join(active.files.localDir.fsPath, artifact.debugEntry),
      sourceAbs: active.files.source.fsPath,
      binary,
      pythonPath,
      // 只调试一个用例时，让异常照常抛出来，调试器会停在出错那一行
      extraArgs: singleCase ? ['--raise-on-error'] : [],
    });
    const isInstalled = (id: string): boolean => {
      try {
        return !!vscode.extensions?.getExtension(id);
      } catch {
        return false;
      }
    };
    const { usable, blocked } = orderDebugCandidates(plan, isInstalled);

    if (!usable.length) {
      const blockedText = blocked.length ? `缺少调试扩展：${describeBlocked(blocked)}。` : '';
      this.log(`[debug] 没有可用的调试器。${blockedText}${plan.hint}`);
      const pick = await vscode.window.showErrorMessage(`无法启动调试。${blockedText}${plan.hint}`, '搜索扩展', '改为本地运行');
      if (pick === '搜索扩展') {
        await vscode.commands.executeCommand('workbench.extensions.search', plan.searchTerm);
      } else if (pick === '改为本地运行') {
        await this.runLocal();
      }
      return;
    }

    let lastError: string | undefined;
    for (const candidate of usable) {
      try {
        this.log(`[debug] 尝试 ${candidate.label}（type=${candidate.type}）`);
        await vscode.debug.startDebugging(undefined, candidate.config as vscode.DebugConfiguration);
        this.log(`[debug] 已用 ${candidate.label} 启动调试`);
        return;
      } catch (err) {
        lastError = (err as Error).message ?? String(err);
        this.log(`[debug] ${candidate.label} 启动失败：${lastError}`);
      }
    }

    const pick = await vscode.window.showErrorMessage(
      `启动调试失败：${lastError ?? '未知原因'}。${plan.hint}`,
      '搜索扩展',
      '改为本地运行',
      '查看输出',
    );
    if (pick === '搜索扩展') await vscode.commands.executeCommand('workbench.extensions.search', plan.searchTerm);
    else if (pick === '改为本地运行') await this.runLocal();
    else if (pick === '查看输出') this.deps.output.show(true);
  }

  // ------------------------------------------------------------------ 官方运行/提交

  async runOnLeetCode(): Promise<void> {
    const active = await this.requireActive();
    if (!active) return;
    await this.saveActiveDocument();
    const code = this.activeDocumentCode();
    const dataInput = this.exampleInput(active.question);
    this.panel?.post({ type: 'status', text: '官方判题中…', level: 'busy' });
    this.log('[judge] 通过 REST 接口请求官方「运行」…');
    try {
      const { submissionId } = await this.client.run(
        active.question.titleSlug,
        active.question.questionId,
        active.langSlug,
        code,
        dataInput,
      );
      this.log(`[judge] interpret_id=${submissionId}，轮询结果…`);
      const result = await this.client.pollResult(submissionId, { timeoutMs: 90000 });
      this.renderJudgeResult('run', result);
    } catch (err) {
      const msg = (err as Error).message;
      this.log(`[judge] 运行失败：${msg}`);
      this.panel?.post({ type: 'status', text: '官方运行失败', level: 'error' });
      const pick = await vscode.window.showErrorMessage(`官方运行失败：${msg}`, '在网页里点运行', '登录状态检查');
      if (pick === '在网页里点运行') this.panel?.post({ type: 'toast', text: '请在左侧网页里点「运行」按钮，桥接会接管代码。', level: 'info' });
      if (pick === '登录状态检查') await this.refreshSession(true);
    }
  }

  async submitToLeetCode(): Promise<void> {
    const active = await this.requireActive();
    if (!active) return;
    const confirm = await vscode.window.showWarningMessage(
      `确认提交到 LeetCode？（${active.question.title}，${active.langSlug}）`,
      { modal: true },
      '提交',
    );
    if (confirm !== '提交') return;
    await this.saveActiveDocument();
    const code = this.activeDocumentCode();
    this.panel?.post({ type: 'status', text: '提交中…', level: 'busy' });
    this.log('[judge] 通过 REST 接口提交…');
    try {
      const { submissionId } = await this.client.submit(
        active.question.titleSlug,
        active.question.questionId,
        active.langSlug,
        code,
      );
      this.log(`[judge] submission_id=${submissionId}，轮询结果…`);
      const result = await this.client.pollResult(submissionId, { timeoutMs: 120000 });
      this.renderJudgeResult('submit', result);
    } catch (err) {
      const msg = (err as Error).message;
      this.log(`[judge] 提交失败：${msg}`);
      this.panel?.post({ type: 'status', text: '提交失败', level: 'error' });
      void vscode.window.showErrorMessage(`提交失败：${msg}`);
    }
  }

  private renderJudgeResult(kind: JudgeKind, result: Parameters<typeof formatJudgeResult>[1]): void {
    const lines = formatJudgeResult(kind, result);
    for (const line of lines) this.log(line);
    const accepted = /accepted|通过/i.test(result.statusMsg ?? '');
    this.resultsView.setResults({
      source: 'judge',
      ok: accepted,
      title: `${kind === 'submit' ? '提交' : '运行'}：${result.statusMsg ?? result.state ?? '已返回'}`,
      detail:
        typeof result.totalCorrect === 'number' && typeof result.totalTestcases === 'number'
          ? `通过用例 ${result.totalCorrect}/${result.totalTestcases}`
          : undefined,
      items: lines.slice(1).map((text) => ({ kind: accepted ? ('pass' as const) : ('info' as const), text })),
    });
    void this.resultsView.reveal();
    this.panel?.post({
      type: 'status',
      text: result.statusMsg ?? (accepted ? '通过' : '已判题'),
      level: accepted ? 'ok' : 'warn',
    });
    this.panel?.post({ type: 'toast', text: lines.slice(0, 4).join('\n'), level: accepted ? 'info' : 'warn' });
    if (kind === 'submit') {
      void vscode.window
        .showInformationMessage(`提交结果：${result.statusMsg ?? '已返回'}`, '查看详情')
        .then((pick) => {
          if (pick === '查看详情') this.deps.output.show();
        });
    }
  }

  private exampleInput(question: LcQuestion): string {
    const meta = parseMetaData(question.metaData);
    const params = meta?.params.length ?? 1;
    const lines = (question.exampleTestcases ?? '').split('\n').filter((l) => l.trim() !== '');
    return lines.slice(0, params).join('\n');
  }

  // ------------------------------------------------------------------ 其它命令

  async reloadSnippet(): Promise<void> {
    const active = await this.requireActive();
    if (!active) return;
    const snippet = this.deps.store.pickSnippet(active.question, active.langSlug);
    if (!snippet) {
      void vscode.window.showWarningMessage('没有该语言的官方模板。');
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      '将当前文件覆盖为官方模板，本地改动会丢失。继续？',
      { modal: true },
      '覆盖',
    );
    if (confirm !== '覆盖') return;
    await this.deps.store.writeFile(active.files.source, snippet);
    const doc = await vscode.workspace.openTextDocument(active.files.source);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preview: false });
    this.pushCodeToBridge();
  }

  async regenerateHarness(): Promise<void> {
    const active = await this.requireActive();
    if (!active) return;
    // 从题面重新生成 cases.json，再重建脚手架
    const cases = await this.deps.store.readCases(active.files, active.question);
    await this.deps.store.writeCases(active.files, cases);
    await this.ensureHarnessQuietly();
    this.panel?.post({ type: 'toast', text: `已重建测试脚手架（${cases.length} 个用例）`, level: 'info' });
    this.log(`[harness] 重建完成：${active.files.localDir.fsPath}`);
  }

  async aiHarness(): Promise<void> {
    const active = await this.requireActive();
    if (!active?.meta) return;
    if (!this.ai.available) {
      const pick = await vscode.window.showWarningMessage('AI 未启用（需要 API Key）。', '设置 API Key');
      if (pick === '设置 API Key') await vscode.commands.executeCommand('lcLocal.setAiKey');
      return;
    }
    const cases = await this.deps.store.readCases(active.files, active.question);
    const plan = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'AI 正在生成测试脚手架…', cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return generateHarnessWithAI(this.ai, {
          langSlug: active.langSlug,
          title: active.question.title,
          contentMd: active.question.content,
          meta: active.meta!,
          cases,
          sourceCode: this.activeDocumentCode(),
          sourceFileName: nameOf(active.files.source.fsPath),
          sourceAbsPath: active.files.source.fsPath,
        });
      },
    );
    const dir = join(active.files.localDir.fsPath, 'ai');
    for (const f of plan.files) {
      await this.deps.store.writeFile(vscode.Uri.file(join(dir, f.name)), f.content);
    }
    this.log(`[ai-harness] 已写入 ${plan.files.length} 个文件到 ${dir}`);
    if (plan.note) this.log(`[ai-harness] 说明：${plan.note}`);
    for (const step of plan.steps) {
      const out = await runStep(step, dir, { timeoutMs: 60000, onLog: (l) => this.log(l.trimEnd()) });
      if (out.code !== 0 && step.fatal !== false) {
        void vscode.window.showErrorMessage('AI 脚手架执行失败，详见输出面板。');
        return;
      }
      for (const line of out.stdout.split('\n')) {
        if (line.startsWith('__LC_RESULT__')) this.log(line.replace('__LC_RESULT__', '结果'));
      }
    }
    await this.deps.store.updateMeta(active.files.meta, { harnessSource: 'ai' });
  }

  async aiHint(): Promise<void> {
    const active = await this.requireActive();
    if (!active) return;
    if (!this.ai.available) {
      const pick = await vscode.window.showWarningMessage(
        'AI 未启用。提示功能需要配置 API Key（也可以在本地查看题面与官方提示）。',
        '设置 API Key',
        '查看官方提示',
      );
      if (pick === '设置 API Key') await vscode.commands.executeCommand('lcLocal.setAiKey');
      if (pick === '查看官方提示' && active.question.hints?.length) {
        this.log('官方提示：\n' + active.question.hints.map((h, i) => `${i + 1}. ${h}`).join('\n'));
        this.deps.output.show();
      }
      return;
    }
    const levelPick = await vscode.window.showQuickPick(
      [
        { label: '$(symbol-method) API 用法', description: 'api', detail: '只解释当前用到的 API 怎么用' },
        { label: '$(lightbulb) 方向提示', description: 'nudge', detail: '一句话方向，不给代码' },
        { label: '$(list-ordered) 思路分步', description: 'approach', detail: '分步骤思路，不含代码' },
      ],
      { title: '提示力度' },
    );
    if (!levelPick) return;
    const level = levelPick.description as 'api' | 'nudge' | 'approach';
    const words = this.wordAtCursor();
    const prompt = buildHintPrompt({
      langSlug: active.langSlug,
      title: active.question.title,
      contentMd: active.question.content,
      code: this.activeDocumentCode(),
      focusWord: words,
      level,
    });
    this.log(`[ai] 请求提示（${level}）…`);
    try {
      const hint = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在请求提示…' },
        () => requestHint(this.ai, {
          langSlug: active.langSlug,
          title: active.question.title,
          contentMd: active.question.content,
          code: this.activeDocumentCode(),
          focusWord: words,
          level,
        }),
      );
      void prompt;
      this.log(`──── 提示（${level}）────\n${hint}`);
      this.deps.output.show();
      void vscode.window.showInformationMessage(hint.split('\n')[0].slice(0, 120), '查看完整提示');
    } catch (err) {
      void vscode.window.showErrorMessage(`请求提示失败：${(err as Error).message}`);
    }
  }

  private wordAtCursor(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const range = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_][A-Za-z0-9_]*/);
    return range ? editor.document.getText(range) : undefined;
  }

  /** 供行内补全使用：AI 单行补全 */
  requestLineCompletion(input: { langSlug: string; linePrefix: string; before: string; after: string }): Promise<string | null> {
    return requestLineCompletion(this.ai, input);
  }

  async reloadPage(): Promise<void> {
    if (!this.panel) return;
    this.panel.post({ type: 'reload' });
    this.panel.post({ type: 'status', text: '页面刷新中…', level: 'busy' });
  }

  async focusLocalEditor(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const doc = await vscode.workspace.openTextDocument(active.files.source);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preview: false });
  }

  /** cookie 变化：防抖持久化；会话 cookie 变化时顺带确认一次登录状态 */
  private onCookiesChanged(reason: string): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistCookies(reason);
    }, 600);
    if (reason === 'session-cookie') {
      // 登录/登出都由这一支触发，避免用户手动点「刷新登录状态」
      setTimeout(() => void this.refreshSession(false), 400);
    }
  }

  async refreshSession(interactive = false): Promise<void> {
    const info = await this.client.refreshSession();
    const signedIn = info.signedIn || this.jar.isSignedIn();
    if (info.username) this.username = info.username;
    if (signedIn) {
      if (this.lastReportedSignedIn !== true) {
        this.log(`[session] 已登录${this.username ? `：${this.username}` : ''}`);
        if (!interactive) {
          this.panel?.post({
            type: 'toast',
            text: `已登录 LeetCode${this.username ? `：${this.username}` : ''}（登录态已保存，下次打开无需重登）`,
            level: 'info',
          });
        }
      }
      await this.persistCookies('signin');
      this.panel?.post({ type: 'state', signedIn: true, signedInName: this.username });
      if (interactive) void vscode.window.showInformationMessage(`已登录 LeetCode${this.username ? `：${this.username}` : ''}`);
    } else {
      if (this.lastReportedSignedIn === true) this.log('[session] 登录态已失效');
      this.panel?.post({ type: 'state', signedIn: false });
      if (interactive) void vscode.window.showWarningMessage('尚未检测到登录态，请在左侧网页登录。');
    }
    this.lastReportedSignedIn = signedIn;
  }

  /** 命令：打开底部面板（并聚焦到结果视图） */
  async openResultsPanel(): Promise<void> {
    await this.ensureResultsPanelVisible();
    await this.resultsView.reveal({ focusView: true });
  }

  /** 退出登录（清掉本地保存的 cookie） */
  async signOut(): Promise<void> {
    const pick = await vscode.window.showWarningMessage('确定退出登录？会清除本地保存的 LeetCode 登录态。', { modal: true }, '退出登录');
    if (pick !== '退出登录') return;
    const names = this.jar.summary().map((c) => c.name);
    this.proxy?.scheduleBrowserCookieClear(names);
    this.jar.clear();
    await this.sessionStore.clearCookies(currentSite().id);
    this.lastReportedSignedIn = false;
    this.username = undefined;
    this.panel?.post({ type: 'state', signedIn: false });
    this.panel?.post({ type: 'toast', text: '已退出登录，请刷新网页重新登录。', level: 'warn' });
    await this.reloadPage();
  }

  // ------------------------------------------------------------------ 持久化

  private async loadCookies(siteId: string): Promise<void> {
    try {
      const count = await this.sessionStore.loadCookies(siteId, this.jar);
      if (count > 0) {
        this.lastReportedSignedIn = this.jar.isSignedIn() ? undefined : false;
      }
    } catch (err) {
      this.log(`[cookie] 恢复失败：${(err as Error).message}`);
    }
  }

  /** 立刻把当前 cookie 写进安全存储（防抖版本见 onCookiesChanged） */
  async persistCookies(reason = 'manual'): Promise<void> {
    try {
      await this.sessionStore.saveCookies(currentSite().id, this.jar, this.username);
      if (reason === 'signin' && this.lastReportedSignedIn !== undefined) this.lastReportedSignedIn = true;
    } catch (err) {
      this.log(`[cookie] 保存失败：${(err as Error).message}`);
    }
  }

  /** 手动粘贴 cookie（leetcode.com API 模式） */
  async setSessionFromInput(): Promise<void> {
    const input = await vscode.window.showInputBox({
      title: '粘贴 LeetCode 登录 Cookie',
      prompt: '从浏览器 DevTools → Application → Cookies 复制 LEETCODE_SESSION 与 csrftoken，按 name=value; name2=value2 粘贴',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'LEETCODE_SESSION=...; csrftoken=...',
    });
    if (!input) return;
    const jar = this.jar;
    for (const part of input.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (name) jar.set(name, value, Date.now() + 1000 * 60 * 60 * 24 * 30);
    }
    await this.persistCookies('paste');
    await this.refreshSession(true);
  }

  // ------------------------------------------------------------------ 工具

  private async requireActive(): Promise<ActiveProblem | undefined> {
    if (this.active) {
      if (!this.panel) {
        await this.enter();
      }
      return this.active;
    }
    const slug = await vscode.window.showInputBox({
      title: '打开题目（输入 slug，例如 two-sum）',
      placeHolder: 'two-sum',
      ignoreFocusOut: true,
    });
    if (!slug) return undefined;
    await this.enter();
    await this.openProblem(slug.trim());
    return this.active;
  }

  private async saveActiveDocument(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === active.files.source.fsPath);
    if (doc?.isDirty) await doc.save();
  }

  private log(line: string): void {
    this.deps.output.appendLine(line);
  }

  /** 命令行：打开任意题目 */
  async openProblemInteractive(): Promise<void> {
    const slug = await vscode.window.showInputBox({
      title: '打开题目',
      prompt: '输入题目标题 slug（例如 two-sum），或直接粘贴题目链接',
      ignoreFocusOut: true,
    });
    if (!slug) return;
    const parsed = /problems\/([a-zA-Z0-9-]+)/.exec(slug)?.[1] ?? slug.trim();
    await this.enter();
    await this.openProblem(parsed);
  }

  /** 命令行：开/关 AI 补全限制 */
  async toggleGuard(): Promise<boolean> {
    if (this.guard.enabled) {
      await this.guard.disable();
      return false;
    }
    const r = await this.guard.enable(this.deps.store.baseDir());
    if (r.detail) this.log(`[guard] ${r.detail}`);
    return true;
  }

  /** 诊断信息（含工具链与调试器可用性），供「显示诊断信息」命令使用 */
  async diagnosticsAsync(): Promise<string> {
    const base = this.diagnostics();
    const lang = this.active?.langSlug ?? 'python3';
    const tc = await checkLangToolchain(lang);
    const lines = [base, `langToolchain(${lang})=${tc.missing.length ? `缺少 ${tc.missing.join(',')}` : '齐全'}`];
    if (tc.hints.length) lines.push(...tc.hints.map((h) => `  提示：${h}`));
    const plan = debugPlanFor({
      langSlug: lang,
      localDir: this.active?.files.localDir.fsPath ?? '',
      entry: '',
      sourceAbs: this.active?.files.source.fsPath ?? '',
    });
    const installed = (id: string): boolean => {
      try {
        return !!vscode.extensions?.getExtension(id);
      } catch {
        return false;
      }
    };
    const { usable, blocked } = orderDebugCandidates(plan, installed);
    lines.push(`debuggers(${lang})=${usable.map((c) => c.type).join(',') || '无可用'}`);
    if (blocked.length) lines.push(`  需要扩展：${describeBlocked(blocked)}`);
    lines.push(`resultsPanel=${this.resultsView.isResolved ? '已连接' : '未创建（可能被关闭）'}`);
    lines.push(`outputChannel=已创建（命令「LeetCode Local: 显示输出面板」可打开）`);
    return lines.join('\n');
  }

  diagnostics(): string {
    const cfg = vscode.workspace.getConfiguration('lcLocal');
    return [
      `site=${cfg.get('site')}`,
      `proxy=${this.proxy?.origin() ?? '未启动'}`,
      `signedIn=${this.jar.isSignedIn()}`,
      `cookies=${this.jar.summary().map((c) => `${c.name}(${c.length})`).join(',') || '无'}`,
      `active=${this.active?.slug ?? '无'}`,
      `lang=${this.active?.langSlug ?? '-'}`,
      `file=${this.active?.files.source.fsPath ?? '-'}`,
      `hintLevel=${cfg.get('hint.level')}`,
      `ai=${this.ai.available ? '已启用' : '未启用'}`,
      `guard=${this.guard.enabled ? '开' : '关'}`,
    ].join('\n');
  }
}

// ---------------------------------------------------------------- 辅助函数

function currentSite(): SiteConfig {
  return getSite(vscode.workspace.getConfiguration('lcLocal').get<string>('site', 'leetcode.cn'));
}

function defaultLang(): string {
  const cfg = vscode.workspace.getConfiguration('lcLocal').get<string>('run.defaultLang', '');
  return cfg || 'python3';
}

function firstLine(text: string, max = 160): string {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function nameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

function relativeName(active: ActiveProblem): string {
  const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const full = active.files.source.fsPath;
  if (base && full.startsWith(base)) return full.slice(base.length + 1);
  return full;
}

/** 构造调试配置（不依赖 launch.json；直接传对象给 startDebugging） */
export function buildDebugConfig(
  langSlug: string,
  artifact: { debugEntry: string; debugType?: string; steps: Array<{ label: string; cmd: string; args: string[] }> },
  active: { files: ProblemFiles; question: LcQuestion },
  store: ProblemStore,
): vscode.DebugConfiguration | undefined {
  const localDir = active.files.localDir.fsPath;
  const entry = join(localDir, artifact.debugEntry);
  const sourceAbs = active.files.source.fsPath;
  const runStepCmd = artifact.steps.find((s) => s.label === 'run');
  const binary = runStepCmd && runStepCmd.cmd.startsWith('./') ? join(localDir, runStepCmd.cmd.slice(2)) : undefined;
  void store;

  switch (normalizeLangSlug(langSlug)) {
    case 'python3':
    case 'python':
      return {
        type: 'debugpy',
        request: 'launch',
        name: `LeetCode 调试 (${langSlug})`,
        program: entry,
        args: [sourceAbs],
        cwd: localDir,
        console: 'integratedTerminal',
        justMyCode: false,
      };
    case 'javascript':
    case 'typescript':
      return {
        type: 'node',
        request: 'launch',
        name: `LeetCode 调试 (${langSlug})`,
        program: entry,
        args: [sourceAbs],
        cwd: localDir,
        console: 'integratedTerminal',
        skipFiles: ['<node_internals>/**'],
      };
    case 'cpp':
    case 'c':
    case 'rust':
      if (!binary) return undefined;
      return {
        type: process.platform === 'darwin' ? 'lldb' : 'cppdbg',
        request: 'launch',
        name: `LeetCode 调试 (${langSlug})`,
        program: binary,
        args: [],
        cwd: localDir,
        ...(process.platform === 'darwin'
          ? {}
          : { MIMode: 'gdb', miDebuggerPath: 'gdb' }),
      };
    case 'java':
      return {
        type: 'java',
        request: 'launch',
        name: 'LeetCode 调试 (Java)',
        mainClass: 'Main',
        cwd: localDir,
      };
    case 'golang':
      return {
        type: 'go',
        request: 'launch',
        name: 'LeetCode 调试 (Go)',
        mode: 'debug',
        program: localDir,
        cwd: localDir,
      };
    default:
      return undefined;
  }
}

export function classifyForLog(meta: LcMetaData): string {
  return `${meta.name}(${meta.params.map((p) => `${p.name}:${classifyType(p.type)}`).join(', ')}) -> ${classifyType(meta.return.type)}`;
}

export async function cleanupHarness(files: ProblemFiles): Promise<void> {
  for (const name of ['_lc_cases.json', '_lc_runner.py', '_lc_main.cpp']) {
    try {
      await unlink(join(files.localDir.fsPath, name));
    } catch {
      /* 忽略 */
    }
  }
}
