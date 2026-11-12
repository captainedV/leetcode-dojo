import { describe, expect, it } from 'vitest';
import * as vscodeMock from '../mocks/vscode.js';
import { isWebviewTab } from '../../src/core/layout.js';

/**
 * 回归：`TabInputWebview.viewType` 会被 VS Code 加上 `mainThreadWebview-` 前缀。
 * 之前用全等匹配 `'lcLocal.site'`，导致「锁左栏」和「布局守护」从来没生效——
 * 用户把文件开到左栏就把题面盖住了，表现成「自动分栏没解决」。
 */
function tab(viewType?: string, fsPath?: string): { input: unknown } {
  if (viewType) return { input: { viewType } };
  return { input: { uri: vscodeMock.Uri.file(fsPath ?? '/tmp/x.py') } };
}

describe('isWebviewTab（viewType 前缀兼容）', () => {
  it('识别带 mainThreadWebview- 前缀的题面标签', () => {
    expect(isWebviewTab(tab('mainThreadWebview-lcLocal.site') as never)).toBe(true);
    expect(isWebviewTab(tab('mainThreadWebview-lcLocal.site') as never, 'lcLocal.site')).toBe(true);
  });

  it('也兼容不带前缀的形式', () => {
    expect(isWebviewTab(tab('lcLocal.site') as never, 'lcLocal.site')).toBe(true);
  });

  it('普通文件标签不算 webview', () => {
    expect(isWebviewTab(tab(undefined, '/a/solution.py') as never)).toBe(false);
    expect(isWebviewTab(tab(undefined, '/a/solution.py') as never, 'lcLocal.site')).toBe(false);
  });

  it('别的 webview 不算我们的题面', () => {
    expect(isWebviewTab(tab('mainThreadWebview-markdown.preview') as never, 'lcLocal.site')).toBe(false);
    expect(isWebviewTab(tab('mainThreadWebview-markdown.preview') as never)).toBe(true);
  });
});
