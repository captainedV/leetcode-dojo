/**
 * 扩展入口：注册命令、状态栏、受限补全。
 *
 * 使用范式：
 *   点状态栏「LeetCode」→ 自动划分左右两栏（左栏内嵌 LeetCode 网页 + 右栏本地代码 IDE + 底部测试工作台）
 *   → 本地写代码 → 一键运行 / 断点调试 / 官方运行 / 提交。
 */
import * as vscode from 'vscode';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  register('lcLocal.resetLayout', () => s().resetLayout());
  register('lcLocal.quickMenu', () => s().showQuickMenu());
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

  // 自检探针：只在设置了 LC_LOCAL_SELFTEST 时启用，用来在真实宿主里核对「自动分栏」的最终布局
  if (process.env.LC_LOCAL_SELFTEST) {
    scheduleSelfTest(context, log);
  }
}

/**
 * 自检：模拟用户点「进入 LeetCode 模式」，然后把真实的 tabGroups 布局写进 JSON。
 * 仅在 LC_LOCAL_SELFTEST 环境变量存在时运行，正常使用完全不受影响。
 */
function scheduleSelfTest(context: vscode.ExtensionContext, log: (line: string) => void): void {
  void (async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const outPath =
      process.env.LC_LOCAL_SELFTEST_OUT || join(context.globalStorageUri.fsPath, 'selftest.json');
    const dump = async (phase: string): Promise<void> => {
      try {
        const snap = session ? await session.layoutSnapshot() : { error: 'no session' };
        const payload = { phase, at: new Date().toISOString(), env: process.env.LC_LOCAL_SELFTEST, snapshot: snap };
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(`${outPath}.${phase}.json`, JSON.stringify(payload, null, 2), 'utf8');
        log(`[selftest] ${phase} → ${outPath}.${phase}.json（分栏数=${(snap as { groupCount?: number }).groupCount}）`);
      } catch (err) {
        log(`[selftest] dump 失败：${(err as Error).message}`);
      }
    };
    try {
      await wait(2500);
      await dump('before');
      await vscode.commands.executeCommand('lcLocal.enter');
      await wait(5000);
      await dump('after-enter');
      // 关键：真正打开一道题，看代码文件是否落在右栏、题面是否还在左栏
      const s2 = session as unknown as { openProblem?: (slug: string, opts?: unknown) => Promise<void> };
      if (typeof s2?.openProblem === 'function') {
        await s2.openProblem('two-sum', { fromPage: false });
        await wait(6000);
        await dump('after-problem');
        // 再切一道题，检查 revealIfOpen / 复用标签页是否会抢回左栏
        await s2.openProblem('add-two-numbers', { fromPage: false });
        await wait(6000);
        await dump('after-problem2');
      } else {
        log('[selftest] 无法调用 openProblem，跳过题目阶段');
      }
      // 模拟用户把文件开到左栏（点文件树 / 断点跳转），验证布局守护能否自愈
      const snap = (await session?.layoutSnapshot()) as { sourceFile?: string } | undefined;
      if (snap?.sourceFile) {
        const doc = await vscode.workspace.openTextDocument(snap.sourceFile);
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false,
          preview: false,
        });
        await wait(2500);
        await dump('after-steal');
      }
      await vscode.commands.executeCommand('lcLocal.resetLayout');
      await wait(3000);
      await dump('after-reset');
      log('[selftest] 完成');
    } catch (err) {
      log(`[selftest] 失败：${(err as Error).message}`);
    }
  })();
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
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
}
