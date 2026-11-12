/**
 * 文档用：把两个 webview 的真实 HTML 导出到临时目录，供 scripts/screenshots 用真实 Chromium 截图。
 * 这不是断言型测试，只是让「README 截图」与「实际 UI」保持同源（改样式后重跑即可更新素材）。
 */
import { describe, expect, it } from 'vitest';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscodeMock from '../mocks/vscode.js';
import { renderShellHtml } from '../../src/webview/panel.js';
import { ResultsView } from '../../src/webview/resultsView.js';

const repoRoot = resolve(__dirname, '..', '..');
const outDir = join(tmpdir(), 'lc-ui-snapshot');

function stripCsp(html: string): string {
  return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
}

describe('导出 UI HTML（供截图）', () => {
  it('左栏 shell + 底部面板', async () => {
    await mkdir(outDir, { recursive: true });
    await cp(join(repoRoot, 'dist', 'media'), join(outDir, 'media'), { recursive: true }).catch(async () => {
      await mkdir(join(outDir, 'media'), { recursive: true });
    });

    // ---- 左栏 shell ----
    const extensionUri = vscodeMock.Uri.file(repoRoot);
    const fakeWebview = {
      cspSource: 'vscode-webview://snapshot',
      asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `file://${uri.fsPath}` }),
    };
    let shell = renderShellHtml(fakeWebview as never, extensionUri as never, 'http://127.0.0.1:39123');
    shell = stripCsp(shell)
      .replaceAll(`file://${join(repoRoot, 'dist', 'media')}/`, 'media/')
      .replaceAll(`file://${join(repoRoot, 'dist', 'media')}`, 'media');
    await writeFile(join(outDir, 'left-pane.html'), shell, 'utf8');

    // ---- 底部面板 ----
    let viewHtml = '';
    const view = new ResultsView({
      extensionUri: extensionUri as never,
      onAction: () => undefined,
      onLang: () => undefined,
      log: () => undefined,
    });
    const fakeView = {
      visible: true,
      webview: {
        cspSource: 'vscode-webview://snapshot',
        asWebviewUri: (uri: unknown) => uri,
        get html() {
          return viewHtml;
        },
        set html(v: string) {
          viewHtml = v;
        },
        options: {},
        postMessage: async () => true,
        onDidReceiveMessage: () => ({ dispose() {} }),
      },
      onDidDispose: () => ({ dispose() {} }),
    };
    view.resolveWebviewView(fakeView as never);
    await writeFile(join(outDir, 'results-view.html'), stripCsp(viewHtml), 'utf8');

    expect(shell).toContain('id="frame"');
    expect(viewHtml).toContain('data-act="runLocal"');
    // eslint-disable-next-line no-console
    console.log(`[ui-snapshot] 已导出到 ${outDir}`);
  });
});
