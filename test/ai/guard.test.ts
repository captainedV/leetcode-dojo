/**
 * AI 守卫：进入练习模式时压制 Copilot / Cursor 的补全设置。
 *
 * 重点回归两件事：
 *  1. **没有打开工作区文件夹时**（题目落在 globalStorage 的场景），写工作区设置会被 VS Code 拒绝
 *     —— 过去整条链路被静默跳过，用户感觉"Copilot 完全没被限制"。现在会降级写用户设置并在退出时还原。
 *  2. 键名会随 Copilot 版本变化（VS Code 1.138 内置 copilot-chat 已移除 `inlineSuggest.enable`），
 *     所以从已装扩展的 package.json **自动发现**贡献项，而不是写死。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import * as vscodeMock from '../mocks/vscode.js';
import { AiGuard } from '../../src/ai/guard.js';

const COPILOT_PKG = {
  contributes: {
    configuration: {
      properties: {
        'github.copilot.enable': { type: 'object', default: { '*': true, plaintext: false } },
        'github.copilot.nextEditSuggestions.enabled': { type: 'boolean', default: true },
        'github.copilot.renameSuggestions.triggerAutomatically': { type: 'boolean', default: true },
        'github.copilot.editor.enableCodeActions': { type: 'boolean', default: true },
        // 聊天类不应被我们碰
        'github.copilot.chat.imageUpload.enabled': { type: 'boolean', default: true },
      },
    },
  },
};

function makeGuard(withFolder: boolean) {
  vscodeMock.workspaceFolders.length = 0;
  if (withFolder) vscodeMock.workspaceFolders.push({ uri: vscodeMock.Uri.file('/tmp/ws'), name: 'ws', index: 0 });
  const ctx = vscodeMock.__makeContext('/tmp/ext', '/tmp/storage');
  const logs: string[] = [];
  const guard = new AiGuard(ctx as never, (l) => logs.push(l));
  return { guard, ctx, logs };
}

describe('AiGuard', () => {
  beforeEach(() => {
    vscodeMock.userSettings.clear();
    vscodeMock.workspaceSettings.clear();
    vscodeMock.__setInstalledExtensions(['github.copilot'], { 'github.copilot': COPILOT_PKG });
  });

  it('有工作区文件夹：写到工作区设置，并压掉 Copilot 的补全开关', async () => {
    const { guard, logs } = makeGuard(true);
    const result = await guard.enable(vscodeMock.Uri.file('/tmp/ws/leetcode'));
    expect(result.changed).toContain('github.copilot.enable');
    expect(vscodeMock.workspaceSettings.get('github.copilot.enable')).toEqual({ '*': false });
    expect(vscodeMock.workspaceSettings.get('github.copilot.nextEditSuggestions.enabled')).toBe(false);
    expect(vscodeMock.workspaceSettings.get('github.copilot.renameSuggestions.triggerAutomatically')).toBe(false);
    // 聊天类键不碰
    expect(vscodeMock.workspaceSettings.has('github.copilot.chat.imageUpload.enabled')).toBe(false);
    expect(guard.describe()).toContain('工作区设置');
    expect(logs.join('\n')).toContain('[aiGuard] 已压制 github.copilot.enable');
  });

  it('没有工作区文件夹：降级写到用户设置（这正是"完全没生效"的场景）', async () => {
    const { guard, logs } = makeGuard(false);
    const result = await guard.enable(vscodeMock.Uri.file('/tmp/storage/leetcode'));
    expect(result.changed.length).toBeGreaterThan(0);
    expect(vscodeMock.userSettings.get('github.copilot.enable')).toEqual({ '*': false });
    expect(vscodeMock.workspaceSettings.size).toBe(0);
    expect(guard.describe()).toContain('用户设置');
    expect(result.detail).toContain('用户设置');
    expect(logs.join('\n')).toContain('没有打开文件夹');
  });

  it('退出时按写入的作用域精确还原，不残留、不过度还原', async () => {
    // 用户原本在全局开了 copilot，且原本没有设置 nextEditSuggestions
    vscodeMock.userSettings.set('github.copilot.enable', { '*': true, plaintext: false });
    const { guard } = makeGuard(false);
    await guard.enable(vscodeMock.Uri.file('/tmp/storage/leetcode'));
    expect(vscodeMock.userSettings.get('github.copilot.enable')).toEqual({ '*': false });

    await guard.disable();
    expect(vscodeMock.userSettings.get('github.copilot.enable')).toEqual({ '*': true, plaintext: false });
    expect(guard.describe()).toContain('关');
  });

  it('激进模式会连 editor.inlineSuggest.enabled 一起关掉', async () => {
    vscodeMock.__setConfig('lcLocal.aiGuard.aggressive', true);
    try {
      const { guard } = makeGuard(true);
      const result = await guard.enable(vscodeMock.Uri.file('/tmp/ws/leetcode'));
      expect(result.changed).toContain('editor.inlineSuggest.enabled');
      expect(vscodeMock.workspaceSettings.get('editor.inlineSuggest.enabled')).toBe(false);
      expect(result.detail).toContain('激进模式');
    } finally {
      vscodeMock.__setConfig('lcLocal.aiGuard.aggressive', false);
    }
  });

  it('Copilot 未注册时也照写（启用后立刻生效），Cursor 键则跳过', async () => {
    vscodeMock.__setInstalledExtensions([]);
    const { guard, logs } = makeGuard(true);
    const result = await guard.enable(vscodeMock.Uri.file('/tmp/ws/leetcode'));
    // github.copilot.* 属于精选键：无条件写入
    expect(result.changed).toContain('github.copilot.enable');
    expect(vscodeMock.workspaceSettings.get('github.copilot.enable')).toEqual({ '*': false });
    expect(logs.join('\n')).toContain('当前未注册');
    // Cursor 的键没注册就跳过
    expect(result.changed.some((k) => k.startsWith('cursor.'))).toBe(false);
  });

  it('诊断会说明哪些键未注册', async () => {
    vscodeMock.__setInstalledExtensions([]);
    const { guard } = makeGuard(true);
    await guard.enable(vscodeMock.Uri.file('/tmp/ws/leetcode'));
    expect(guard.effectiveValues().some((l) => l.includes('未注册'))).toBe(true);
  });
});
