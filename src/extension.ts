/**
 * 扩展入口：注册命令、状态栏、受限补全。
 *
 * 使用范式（与需求一致）：
 *   点状态栏「LeetCode」→ 左栏内嵌 LeetCode 网页（可登录）→ 进入题目后右栏自动打开同名本地文件
 *   → 本地写代码 → 工具栏「本地运行 / 调试 / 官方运行 / 提交」。
 */
import * as vscode from 'vscode';
import { LcSession } from './core/session.js';
import { ProblemStore } from './core/workspace.js';
import { normalizeLangSlug } from './core/langs.js';
import { createPracticeCompletionProvider, createSignatureCompletionProvider } from './ai/completion.js';

let session: LcSession | undefined;
let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('LeetCode Local');
  const log = (line: string) => output?.appendLine(line);
  const store = new ProblemStore(context, log);
  session = new LcSession({ context, output, store });

  const register = (id: string, handler: () => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await handler();
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          log(`[command:${id}] ${message}`);
          void vscode.window.showErrorMessage(`LeetCode Local: ${message}`);
        }
      }),
    );

  const s = () => {
    if (!session) throw new Error('会话未初始化');
    return session;
  };

  register('lcLocal.enter', () => s().enter());
  register('lcLocal.exit', () => s().exit());
  register('lcLocal.runLocal', () => s().runLocal());
  register('lcLocal.debugLocal', () => s().debugLocal());
  register('lcLocal.runOnLeetCode', () => s().runOnLeetCode());
  register('lcLocal.submit', () => s().submitToLeetCode());
  register('lcLocal.switchLanguage', () => s().switchLanguage());
  register('lcLocal.reloadSnippet', () => s().reloadSnippet());
  register('lcLocal.regenerateHarness', () => s().regenerateHarness());
  register('lcLocal.aiHarness', () => s().aiHarness());
  register('lcLocal.aiHint', () => s().aiHint());
  register('lcLocal.setSession', () => s().setSessionFromInput());
  register('lcLocal.signOut', () => s().signOut());
  register('lcLocal.openPanel', () => s().openResultsPanel());
  register('lcLocal.openProblem', () => s().openProblemInteractive());
  register('lcLocal.reloadPage', () => s().reloadPage());
  register('lcLocal.refreshSession', () => s().refreshSession(true));
  register('lcLocal.showDiagnostics', async () => {
    log('──────── 诊断 ────────');
    log(await s().diagnosticsAsync());
    output?.show(true);
  });
  register('lcLocal.setAiKey', async () => {
    const key = await vscode.window.showInputBox({
      title: 'AI API Key',
      prompt: '保存在用户设置 lcLocal.ai.apiKey（也可用环境变量 LC_LOCAL_AI_KEY）',
      password: true,
      ignoreFocusOut: true,
    });
    if (!key) return;
    await vscode.workspace.getConfiguration('lcLocal').update('ai.apiKey', key, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('lcLocal').update('ai.enabled', true, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('已保存 API Key 并启用 AI 辅助。');
  });
  register('lcLocal.toggleAiGuard', async () => {
    const enabled = await s().toggleGuard();
    void vscode.window.showInformationMessage(`AI 补全限制：${enabled ? '已开启' : '已关闭'}`);
  });

  registerCompletionProviders(context, () => session);

  context.subscriptions.push(
    vscode.commands.registerCommand('lcLocal.showLog', () => output?.show()),
    { dispose: () => session?.dispose() },
    { dispose: () => output?.dispose() },
  );

  void vscode.commands.executeCommand('setContext', 'lcLocal.active', false);
  log('LeetCode Local IDE 已激活（点状态栏「LeetCode」进入练习模式）');
}

function registerCompletionProviders(context: vscode.ExtensionContext, getSession: () => LcSession | undefined): void {
  const isPracticeFile = (doc: vscode.TextDocument): boolean => {
    try {
      return getSession()?.isPracticeFile(doc) ?? false;
    } catch {
      return false;
    }
  };
  const log = (msg: string) => output?.appendLine(`[completion] ${msg}`);

  const inline = createPracticeCompletionProvider({
    getLevel: () => vscode.workspace.getConfiguration('lcLocal').get<'off' | 'signature' | 'line'>('hint.level', 'signature'),
    getMaxChars: () => vscode.workspace.getConfiguration('lcLocal').get<number>('hint.maxLineChars', 80),
    isPracticeFile,
    requestLine: async (ctx) => {
      const s = getSession();
      if (!s) return null;
      return s.requestLineCompletion({
        langSlug: normalizeLangSlug(ctx.langSlug),
        linePrefix: ctx.linePrefix,
        before: ctx.before,
        after: ctx.after,
      });
    },
    log,
  });
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, inline),
  );

  const signature = createSignatureCompletionProvider({
    getLevel: () => vscode.workspace.getConfiguration('lcLocal').get<'off' | 'signature' | 'line'>('hint.level', 'signature'),
    getMaxChars: () => vscode.workspace.getConfiguration('lcLocal').get<number>('hint.maxLineChars', 80),
    isPracticeFile,
    log,
  });
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ scheme: 'file' }, signature, '.', '(', '>', ':'),
  );

  // 状态栏入口：一个按钮进入 LeetCode 模式
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  status.command = 'lcLocal.enter';
  status.text = '$(browser) LeetCode';
  status.tooltip = '进入 LeetCode 模式：左侧 LeetCode 网页（可登录）+ 右侧本地 IDE';
  status.show();
  context.subscriptions.push(status);
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
}
