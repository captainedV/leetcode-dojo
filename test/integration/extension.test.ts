/**
 * 集成测试：用 vscode 替身把扩展真的「跑起来」一次。
 *
 * 覆盖主链路（真实网络访问 leetcode.cn）：
 *   activate → 注册命令 → 进入 LeetCode 模式（起代理 + 建面板）
 *   → 模拟页面桥接上报路由 → 自动创建本地题目文件并推送代码给页面
 *   → 本地运行测试（真实执行 python3）→ 语言切换 → 退出
 *
 * 网络不可用时整组跳过（不会让 CI 变红）。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscodeMock from '../mocks/vscode.js';

let online = false;

async function checkOnline(): Promise<boolean> {
  try {
    const res = await fetch('https://leetcode.cn/graphql/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query{__typename}' }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const TWO_SUM_SOLUTION = `from typing import List


class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, v in enumerate(nums):
            if target - v in seen:
                return [seen[target - v], i]
            seen[v] = i
        return []
`;

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 30000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`等待超时：${label}`);
}

describe('扩展集成（真实网络 + 真实 python3）', () => {
  let wsRoot = '';
  let sharedState = vscodeMock.__makeSharedState();
  let extModule: { activate: (ctx: never) => void } | undefined;
  let firstFrameUrl = '';
  let storageRoot = '';

  beforeAll(async () => {
    online = await checkOnline();
    if (!online) {
      console.warn('skip: 无法访问 leetcode.cn');
      return;
    }
    wsRoot = await mkdtemp(join(tmpdir(), 'lc-int-'));
    await mkdir(wsRoot, { recursive: true });
    vscodeMock.workspaceFolders.length = 0;
    vscodeMock.workspaceFolders.push({ uri: vscodeMock.Uri.file(wsRoot), name: 'ws', index: 0 });
    const extPath = resolve(__dirname, '..', '..');
    storageRoot = join(wsRoot, '.storage');
    sharedState = vscodeMock.__makeSharedState();
    const ctx = vscodeMock.__makeContext(extPath, storageRoot, sharedState);
    const mod = await import('../../src/extension.js');
    extModule = mod;
    mod.activate(ctx as never);
    // 模拟 VS Code 展开底部「LeetCode」面板（并发送 ready，真实环境里由面板脚本发送）
    vscodeMock.__resolveWebviewView('lcLocal.results');
    vscodeMock.__sendToWebviewView('lcLocal.results', { type: 'ready' });
  });

  afterAll(async () => {
    try {
      await vscodeMock.commands.executeCommand('lcLocal.exit');
    } catch {
      /* ignore */
    }
  });

  it('注册了全部命令', async () => {
    if (!online) return;
    const ids = await vscodeMock.commands.getCommands();
    for (const id of [
      'lcLocal.enter',
      'lcLocal.exit',
      'lcLocal.runLocal',
      'lcLocal.debugLocal',
      'lcLocal.runOnLeetCode',
      'lcLocal.submit',
      'lcLocal.switchLanguage',
      'lcLocal.aiHint',
      'lcLocal.showDiagnostics',
    ]) {
      expect(ids).toContain(id);
    }
    expect(vscodeMock.inlineProviders.length).toBeGreaterThan(0);
    expect(vscodeMock.completionProviders.length).toBeGreaterThan(0);
  });

  it('进入模式后启动代理并渲染左栏（含 CSP frame-src 与自动左右分栏）', async () => {
    if (!online) return;
    // 只创建唯一一个状态栏入口（修复双状态栏按钮问题）
    expect(vscodeMock.statusBarItems.filter((i) => i.visible)).toHaveLength(1);
    await vscodeMock.commands.executeCommand('lcLocal.enter');
    await waitFor(() => vscodeMock.panels.length > 0, 15000, 'panel created');
    // 进入模式后依然只有一个状态栏项，且自动拆出了左右两栏
    expect(vscodeMock.statusBarItems.filter((i) => i.visible)).toHaveLength(1);
    expect(vscodeMock.executedCommands).toContain('vscode.setEditorLayout');
    expect(vscodeMock.mockTabGroups.length).toBeGreaterThanOrEqual(2);
    // 模拟 shell.js 启动后发的 ready（面板在 ready 之前会把消息排队）
    vscodeMock.__sendToWebview({ type: 'ready' });
    await waitFor(
      () => vscodeMock.postedMessages.some((m) => (m as { type?: string }).type === 'init'),
      8000,
      'init message',
    );
    const panel = vscodeMock.panels[0];
    expect(panel.webview.html).toContain('Content-Security-Policy');
    expect(panel.webview.html).toMatch(/frame-src http:\/\/127\.0\.0\.1:\d+/);
    const init = vscodeMock.postedMessages.find((m) => (m as { type?: string }).type === 'init') as
      | { frameUrl: string; langs: unknown[] }
      | undefined;
    expect(init?.frameUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    firstFrameUrl = init?.frameUrl ?? '';
    await waitFor(() => vscodeMock.contextKeys.get('lcLocal.active') === true, 5000, 'context key');
  });

  it('进入模式时会主动把底部面板打开（用户不该需要自己去找）', async () => {
    if (!online) return;
    await waitFor(
      () =>
        vscodeMock.executedCommands.includes('lcLocal.results.focus') ||
        vscodeMock.executedCommands.includes('workbench.view.extension.lcLocalPanel'),
      10000,
      'reveal 底部面板',
    );
  });

  it('页面进入题目后自动创建本地文件并推送代码', async () => {
    if (!online) return;
    vscodeMock.__sendToWebview({
      type: 'bridge',
      msg: { t: 'route', slug: 'two-sum', href: 'http://127.0.0.1/x/problems/two-sum/', pathname: '/problems/two-sum/' },
    });
    const problemDir = join(wsRoot, 'leetcode', '001.two-sum');
    await waitFor(async () => {
      try {
        const files = await readdir(problemDir);
        return files.includes('solution.py');
      } catch {
        return false;
      }
    }, 40000, 'solution.py 创建');
    const snippet = await readFile(join(problemDir, 'solution.py'), 'utf8');
    expect(snippet).toContain('class Solution');
    const meta = JSON.parse(await readFile(join(problemDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta.slug).toBe('two-sum');
    expect(meta.langSlug).toBe('python3');
    const cases = JSON.parse(await readFile(join(problemDir, 'cases.json'), 'utf8')) as { cases: unknown[] };
    expect(cases.cases.length).toBeGreaterThan(0);
    const readme = await readFile(join(problemDir, 'problem.md'), 'utf8');
    expect(readme).toContain('两数之和');
    await waitFor(
      () =>
        vscodeMock.postedMessages.some(
          (m) => (m as { type?: string }).type === 'bridge' && (m as { msg?: { t?: string } }).msg?.t === 'push',
        ),
      8000,
      'push code to bridge',
    );
    const push = vscodeMock.postedMessages.find(
      (m) => (m as { type?: string }).type === 'bridge' && (m as { msg?: { t?: string } }).msg?.t === 'push',
    ) as { msg: { lang: string; code: string; fileName: string } };
    expect(push.msg.lang).toBe('python3');
    expect(push.msg.code).toContain('class Solution');
    expect(push.msg.fileName).toContain('solution.py');
  });

  it('本地运行测试：真实跑 python3 并全部通过', async () => {
    if (!online) return;
    const solutionPath = join(wsRoot, 'leetcode', '001.two-sum', 'solution.py');
    await writeFile(solutionPath, TWO_SUM_SOLUTION, 'utf8');
    vscodeMock.__reloadDocument(vscodeMock.Uri.file(solutionPath));
    await vscodeMock.commands.executeCommand('lcLocal.runLocal');
    const logs = findOutputLogs();
    const text = logs.join('\n');
    if (!/合计：通过 3/.test(text)) console.log('=== OUTPUT LOGS ===\n' + text);
    expect(text).toContain('本地测试结果');
    const resultsMsg = viewMessages().filter((m) => (m as { type?: string }).type === 'result').pop() as
      | { result: { ok: boolean; title: string; items: Array<{ kind: string }> } }
      | undefined;
    expect(resultsMsg?.result.ok).toBe(true);
    expect(resultsMsg?.result.title).toContain('3/3');
    expect(resultsMsg?.result.items.filter((i) => i.kind === 'pass')).toHaveLength(3);
    expect(text).toMatch(/通过 3 \/ 失败 0|合计：通过 3/);
    expect(vscodeMock.postedMessages.some((m) => (m as { type?: string }).type === 'status')).toBe(true);
  });

  it('没装调试扩展时给出可操作的提示，而不是抛「类型不受支持」', async () => {
    if (!online) return;
    vscodeMock.__setInstalledExtensions([]);
    vscodeMock.messages.error.length = 0;
    await vscodeMock.commands.executeCommand('lcLocal.debugLocal');
    const err = vscodeMock.messages.error.join('\n');
    expect(err).toContain('无法启动调试');
    expect(err).toContain('ms-python');
    // 不应该尝试启动任何调试器
    expect(vscodeMock.debug.startedConfigs).toHaveLength(0);
  });

  it('装了 Python 扩展但 debugpy 不可用时会自动降级到 python 类型', async () => {
    if (!online) return;
    vscodeMock.__setInstalledExtensions(['ms-python.python', 'ms-python.debugpy']);
    vscodeMock.debug.unsupportedTypes = new Set(['debugpy']);
    vscodeMock.debug.startedConfigs.length = 0;
    await vscodeMock.commands.executeCommand('lcLocal.debugLocal');
    expect(vscodeMock.debug.startedConfigs).toHaveLength(1);
    const cfg = vscodeMock.debug.startedConfigs[0] as { type: string; program: string; args: string[] };
    expect(cfg.type).toBe('python');
    expect(cfg.program).toContain('_lc_debug_runner.py');
    expect(cfg.args[0]).toMatch(/solution\.py$/);
    vscodeMock.debug.unsupportedTypes = new Set();
  });

  it('底部面板按用例调试：只把选中的用例写进脚手架', async () => {
    if (!online) return;
    vscodeMock.__setInstalledExtensions(['ms-python.python']);
    vscodeMock.debug.unsupportedTypes = new Set();
    vscodeMock.debug.startedConfigs.length = 0;
    vscodeMock.__sendToWebviewView('lcLocal.results', { type: 'action', action: 'debugCase', index: 1 });
    await waitFor(() => vscodeMock.debug.startedConfigs.length > 0, 20000, '启动用例调试');
    const casesFile = join(wsRoot, 'leetcode', '001.two-sum', 'local', '_lc_cases.json');
    const payload = JSON.parse(await readFile(casesFile, 'utf8')) as { cases: Array<{ i: number; args: string[] }> };
    expect(payload.cases).toHaveLength(1);
    expect(payload.cases[0].i).toBe(1);
    expect(payload.cases[0].args).toEqual(['[3,2,4]', '6']);
    expect(findOutputLogs().join('\n')).toContain('调试用例：#2');
  });

  it('调试时可选「自定义输入」，走 parseCustomInput 解析', async () => {
    if (!online) return;
    vscodeMock.__setInstalledExtensions(['ms-python.python']);
    vscodeMock.debug.startedConfigs.length = 0;
    // QuickPick 选「自定义输入…」（队列返回第二项 = 最后一个 item）
    const quickPickItems: unknown[] = [];
    vscodeMock.messages.quickPickQueue.push({
      label: '$(edit) 自定义输入…',
      description: '手动指定这次调试的参数',
      value: 'custom',
    });
    void quickPickItems;
    vscodeMock.messages.inputBoxQueue.push('nums = [3,3], target = 6');
    await vscodeMock.commands.executeCommand('lcLocal.debugLocal');
    await waitFor(() => vscodeMock.debug.startedConfigs.length > 0, 20000, '自定义输入调试启动');
    const casesFile = join(wsRoot, 'leetcode', '001.two-sum', 'local', '_lc_cases.json');
    const payload = JSON.parse(await readFile(casesFile, 'utf8')) as { cases: Array<{ args: string[] }> };
    expect(payload.cases).toHaveLength(1);
    expect(payload.cases[0].args).toEqual(['[3,3]', '6']);
  });

  it('切换语言会创建并打开对应文件', async () => {
    if (!online) return;
    await vscodeMock.commands.executeCommand('lcLocal.switchLanguage', 'cpp');
    const problemDir = join(wsRoot, 'leetcode', '001.two-sum');
    await waitFor(async () => {
      try {
        return (await readdir(problemDir)).includes('solution.cpp');
      } catch {
        return false;
      }
    }, 8000, 'solution.cpp 创建');
    const cpp = await readFile(join(problemDir, 'solution.cpp'), 'utf8');
    expect(cpp).toContain('class Solution');
    const meta = JSON.parse(await readFile(join(problemDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta.langSlug).toBe('cpp');
  });

  it('C++ 本地测试同样可跑（真实编译）', async () => {
    if (!online) return;
    const solutionPath = join(wsRoot, 'leetcode', '001.two-sum', 'solution.cpp');
    await writeFile(
      solutionPath,
      `#include <vector>
#include <unordered_map>
using namespace std;

class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int,int> seen;
        for (int i = 0; i < (int)nums.size(); ++i) {
            auto it = seen.find(target - nums[i]);
            if (it != seen.end()) return {it->second, i};
            seen[nums[i]] = i;
        }
        return {};
    }
};
`,
      'utf8',
    );
    vscodeMock.__reloadDocument(vscodeMock.Uri.file(solutionPath));
    await vscodeMock.commands.executeCommand('lcLocal.runLocal');
    const text = findOutputLogs().join('\n');
    expect(text).toMatch(/通过 3 \/ 失败 0|合计：通过 3/);
  });

  it('本地测试失败时会把结果条置为失败并自动展开输出面板', async () => {
    if (!online) return;
    const solutionPath = join(wsRoot, 'leetcode', '001.two-sum', 'solution.cpp');
    const original = await readFile(solutionPath, 'utf8');
    await writeFile(solutionPath, original.replace('return {it->second, i};', 'return {0, 0};'), 'utf8');
    vscodeMock.__reloadDocument(vscodeMock.Uri.file(solutionPath));
    vscodeMock.postedMessages.length = 0;
    await vscodeMock.commands.executeCommand('lcLocal.runLocal');
    const resultsMsg = viewMessages().filter((m) => (m as { type?: string }).type === 'result').pop() as
      | { result: { ok: boolean; items: Array<{ kind: string }> } }
      | undefined;
    expect(resultsMsg?.result.ok).toBe(false);
    expect(resultsMsg?.result.items.some((i) => i.kind === 'fail')).toBe(true);
    expect(vscodeMock.messages.warn.join('\n')).toContain('本地测试未通过');
    await writeFile(solutionPath, original, 'utf8');
    vscodeMock.__reloadDocument(vscodeMock.Uri.file(solutionPath));
  });

  it('底部面板收到题目/用例状态，并能用面板按钮触发本地运行', async () => {
    if (!online) return;
    const states = viewMessages().filter((m) => (m as { type?: string }).type === 'state') as Array<{
      state: { title: string; langSlug: string; cases: unknown[]; fileName: string };
    }>;
    const last = states[states.length - 1];
    expect(last?.state.title).toMatch(/Two Sum|两数之和/);
    expect(last?.state.cases.length).toBeGreaterThan(0);
    expect(last?.state.fileName).toContain('solution');
    // 通过底部面板按钮触发一次本地运行
    vscodeMock.__sendToWebviewView('lcLocal.results', { type: 'action', action: 'runLocal' });
    await waitFor(
      () => viewMessages().filter((m) => (m as { type?: string }).type === 'result').length >= 2,
      30000,
      '面板触发的本地运行结果',
    );
  });

  it('登录态 / 端口 / 上次题目在"重启 IDE"后仍然保留', async () => {
    if (!online) return;
    // 1) 模拟用户在网页里登录成功后我们拿到的 cookie（走粘贴入口）
    vscodeMock.messages.inputBoxQueue.push('LEETCODE_SESSION=fake-session-for-test; csrftoken=fake-csrf');
    await vscodeMock.commands.executeCommand('lcLocal.setSession');
    await waitFor(() => findOutputLogs().join('\n').includes('已保存登录态'), 10000, 'cookie 已保存');
    expect(sharedState.secrets.has('lcLocal.cookies.leetcode.cn')).toBe(true);

    const firstPort = /:(\d+)\//.exec(firstFrameUrl)?.[1];
    expect(firstPort).toBeTruthy();

    await vscodeMock.commands.executeCommand('lcLocal.showDiagnostics');
    expect(findOutputLogs().join('\n')).toContain('signedIn=true');

    // 2) 退出并“重启”：复用同一份 globalState / secrets 重新 activate
    await vscodeMock.commands.executeCommand('lcLocal.exit');
    const ctx2 = vscodeMock.__makeContext(resolve(__dirname, '..', '..'), storageRoot, sharedState);
    extModule?.activate(ctx2 as never);
    vscodeMock.__resolveWebviewView('lcLocal.results');
    vscodeMock.__sendToWebviewView('lcLocal.results', { type: 'ready' });

    const before = vscodeMock.postedMessages.length;
    await vscodeMock.commands.executeCommand('lcLocal.enter');
    vscodeMock.__sendToWebview({ type: 'ready' });
    await waitFor(
      () => vscodeMock.postedMessages.slice(before).some((m) => (m as { type?: string }).type === 'init'),
      15000,
      '重启后的 init 消息',
    );
    const restartInit = vscodeMock.postedMessages.slice(before).find((m) => (m as { type?: string }).type === 'init') as {
      frameUrl: string;
      signedIn: boolean;
    };
    // 端口复用（站点源不变 → localStorage/草稿也保留）
    expect(/:([0-9]+)\//.exec(restartInit.frameUrl)?.[1]).toBe(firstPort);
    // 直接回到上次那道题
    expect(restartInit.frameUrl).toContain('/problems/two-sum/');
    // 登录态已恢复
    expect(restartInit.signedIn).toBe(true);
    expect(findOutputLogs().join('\n')).toContain('已恢复登录态');
  });

  it('诊断信息与退出', async () => {
    if (!online) return;
    await vscodeMock.commands.executeCommand('lcLocal.showDiagnostics');
    const text = findOutputLogs().join('\n');
    expect(text).toContain('signedIn=');
    expect(text).toContain('site=leetcode.cn');
    await vscodeMock.commands.executeCommand('lcLocal.exit');
    expect(vscodeMock.contextKeys.get('lcLocal.active')).toBe(false);
  });
});

/** 底部面板收到的消息 */
function viewMessages(): unknown[] {
  const view = vscodeMock.__webviewViews.get('lcLocal.results') as { posted?: unknown[] } | undefined;
  return view?.posted ?? [];
}

/** 从 mock 的 output channel 里取日志（扩展用 createOutputChannel 建了一个） */
function findOutputLogs(): string[] {
  return vscodeMock.__outputChannels.flatMap((c) => c.lines);
}
