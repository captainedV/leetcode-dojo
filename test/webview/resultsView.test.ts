import { describe, expect, it, beforeAll } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscodeMock from '../mocks/vscode.js';
import { ResultsView } from '../../src/webview/resultsView.js';

interface FakeView {
  visible: boolean;
  webview: {
    html: string;
    options: unknown;
    cspSource: string;
    asWebviewUri: (u: unknown) => unknown;
    postMessage: (m: unknown) => Promise<boolean>;
    onDidReceiveMessage: (cb: (m: unknown) => void) => { dispose(): void };
  };
  onDidDispose: (cb: () => void) => { dispose(): void };
}

function makeView(): { view: FakeView; posted: unknown[]; send: (m: unknown) => void } {
  const posted: unknown[] = [];
  const listeners: Array<(m: unknown) => void> = [];
  const view: FakeView = {
    visible: true,
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (u) => u,
      postMessage: async (m: unknown) => {
        posted.push(m);
        return true;
      },
      onDidReceiveMessage: (cb) => {
        listeners.push(cb);
        return { dispose() {} };
      },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  return { view, posted, send: (m) => listeners.forEach((l) => l(m)) };
}

let html = '';
const actions: string[] = [];
const langs: string[] = [];

beforeAll(() => {
  const view = new ResultsView({
    extensionUri: vscodeMock.Uri.file('/tmp/ext'),
    onAction: (a) => actions.push(a),
    onLang: (l) => langs.push(l),
  });
  const { view: fakeView } = makeView();
  view.resolveWebviewView(fakeView as never);
  html = fakeView.webview.html;
});

describe('底部面板（测试用例 / 测试结果）', () => {
  it('HTML 结构包含操作按钮、两个 tab、语言选择与 CSP', () => {
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('nonce-');
    for (const act of ['runLocal', 'runOnLeetCode', 'submit', 'debugLocal', 'regenerateHarness', 'openCases']) {
      expect(html).toContain(`data-act="${act}"`);
    }
    expect(html).toContain('data-tab="cases"');
    expect(html).toContain('data-tab="results"');
    expect(html).toContain('id="lang"');
    // 中文界面
    expect(html).toContain('本地运行');
    expect(html).toContain('测试结果');
  });

  it('消息转发：按钮点击 → onAction，语言切换 → onLang', () => {
    const view = new ResultsView({
      extensionUri: vscodeMock.Uri.file('/tmp/ext'),
      onAction: (a) => actions.push(a),
      onLang: (l) => langs.push(l),
    });
    const { view: fakeView, send } = makeView();
    view.resolveWebviewView(fakeView as never);
    send({ type: 'ready' });
    send({ type: 'action', action: 'runLocal' });
    send({ type: 'lang', lang: 'cpp' });
    expect(actions).toContain('runLocal');
    expect(langs).toContain('cpp');
  });

  it('ready 之前的消息会排队，ready 后补发', async () => {
    const view = new ResultsView({
      extensionUri: vscodeMock.Uri.file('/tmp/ext'),
      onAction: () => undefined,
      onLang: () => undefined,
    });
    const { view: fakeView, posted, send } = makeView();
    view.resolveWebviewView(fakeView as never);
    view.setResults({ source: 'local', ok: false, title: '本地测试 1/3 通过', items: [{ kind: 'fail', text: '用例 1' }] });
    expect(posted.length).toBe(0);
    send({ type: 'ready' });
    expect(posted.some((m) => (m as { type?: string }).type === 'result')).toBe(true);
  });

  it('把 HTML 导出到临时文件供真实浏览器渲染验证', async () => {
    const dir = join(tmpdir(), 'lc-view');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'results-view.html');
    await writeFile(file, html, 'utf8');
    expect(file).toContain('results-view.html');
  });
});

describe('底部面板 reveal（为什么用户看不到面板）', () => {
  function makeViewInstance() {
    const view = new ResultsView({
      extensionUri: vscodeMock.Uri.file('/tmp/ext'),
      onAction: () => undefined,
      onLang: () => undefined,
      log: () => undefined,
    });
    const fake = makeView();
    view.resolveWebviewView(fake.view as never);
    return { view, fake };
  }

  it('视图已可见时不去点命令（只聚焦）', async () => {
    const { view } = makeViewInstance();
    vscodeMock.executedCommands.length = 0;
    const ok = await view.reveal({ focusView: false });
    expect(ok).toBe(true);
    expect(vscodeMock.executedCommands).toHaveLength(0);
  });

  it('优先用 <viewId>.focus 打开面板', async () => {
    const { view } = makeViewInstance();
    vscodeMock.executedCommands.length = 0;
    await view.reveal();
    expect(vscodeMock.executedCommands).toContain('lcLocal.results.focus');
  });

  it('focus 命令不可用时降级到容器命令', async () => {
    const { view } = makeViewInstance();
    vscodeMock.executedCommands.length = 0;
    vscodeMock.commands.failCommands = new Set(['lcLocal.results.focus']);
    // 模拟「未解析」：让 visible=false
    (view as unknown as { view: { visible: boolean } }).view.visible = false;
    await view.reveal({ focusView: false });
    expect(vscodeMock.executedCommands).toContain('workbench.view.extension.lcLocalPanel');
    vscodeMock.commands.failCommands = new Set();
  });

  it('isResolved 反映视图是否创建', () => {
    const { view } = makeViewInstance();
    expect(view.isResolved).toBe(true);
  });
});
