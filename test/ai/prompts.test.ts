import { describe, expect, it } from 'vitest';
import {
  HARNESS_SYSTEM_PROMPT,
  HINT_SYSTEM_PROMPT,
  LINE_SYSTEM_PROMPT,
  buildHarnessPrompt,
  buildHintPrompt,
  buildLineCompletionPrompt,
  cleanSingleLine,
  dropCodeBlocks,
  normalizeHintLevel,
  stripCodeFences,
} from '../../src/ai/prompts.js';
import type { PromptContext } from '../../src/ai/prompts.js';
import { requestHint, requestLineCompletion } from '../../src/ai/hints.js';
import type { AssistantClient } from '../../src/ai/provider.js';

const HINT_CTX: PromptContext = {
  langSlug: 'python3',
  title: '1. Two Sum',
  contentMd: '给定整数数组 nums 和整数 target，返回和为 target 的两个下标。',
  code: 'class Solution:\n    def twoSum(self, nums, target):\n        ',
  focusWord: 'enumerate',
  level: 'approach',
};

/** 只实现 chat 的最小假客户端（不走网络，也不触碰 vscode） */
function fakeClient(reply: string | (() => Promise<string>)): AssistantClient {
  const fake = {
    available: true,
    chat: async () => (typeof reply === 'function' ? reply() : reply),
    chatJson: async () => {
      throw new Error('not used');
    },
  };
  return fake as unknown as AssistantClient;
}

describe('HINT_SYSTEM_PROMPT：分级且不给答案', () => {
  it('包含「不要给出完整（代码/函数体）」等关键约束', () => {
    expect(HINT_SYSTEM_PROMPT).toContain('不要给出完整');
    expect(HINT_SYSTEM_PROMPT).toContain('不要复述题面');
    expect(HINT_SYSTEM_PROMPT).toContain('代码块');
    expect(HINT_SYSTEM_PROMPT).toContain('必须用中文回答');
  });

  it('三个级别各自的关键词都在提示里', () => {
    expect(HINT_SYSTEM_PROMPT).toContain('api 级');
    expect(HINT_SYSTEM_PROMPT).toContain('nudge 级');
    expect(HINT_SYSTEM_PROMPT).toContain('approach 级');
    expect(HINT_SYSTEM_PROMPT).toMatch(/不含代码块|不要出现代码块/);
    expect(HINT_SYSTEM_PROMPT).toMatch(/1-2 句/);
  });

  it('buildHintPrompt：system 固定，user 带语言/题目/题面/代码/等级', () => {
    const { system, user } = buildHintPrompt(HINT_CTX);
    expect(system).toBe(HINT_SYSTEM_PROMPT);
    expect(user).toContain('python3');
    expect(user).toContain('Two Sum');
    expect(user).toContain(HINT_CTX.contentMd);
    expect(user).toContain('def twoSum');
    expect(user).toContain('enumerate');
    expect(user).toContain('提示等级：approach');
    expect(user).toContain('不含任何代码块');
  });

  it('非法/缺失等级回退到 nudge', () => {
    expect(normalizeHintLevel('api')).toBe('api');
    expect(normalizeHintLevel('approach')).toBe('approach');
    expect(normalizeHintLevel('full-solution')).toBe('nudge');
    expect(normalizeHintLevel(undefined)).toBe('nudge');
    const { user } = buildHintPrompt({ ...HINT_CTX, level: 'bogus' as never });
    expect(user).toContain('提示等级：nudge');
  });
});

describe('LINE_SYSTEM_PROMPT：只补一行', () => {
  it('包含单行 / 无围栏 / 长度 / 空输出等约束', () => {
    expect(LINE_SYSTEM_PROMPT).toContain('不要换行');
    expect(LINE_SYSTEM_PROMPT).toContain('markdown 代码围栏');
    expect(LINE_SYSTEM_PROMPT).toContain('120 字符');
    expect(LINE_SYSTEM_PROMPT).toContain('空字符串');
    expect(LINE_SYSTEM_PROMPT).toContain('函数调用与其参数');
    expect(LINE_SYSTEM_PROMPT).toMatch(/不许生成循环、分支/);
  });

  it('buildLineCompletionPrompt：before / after / linePrefix 都进入 user', () => {
    const before = 'def f(nums):\n    total = 0\n    for v in nums:\n';
    const linePrefix = '        total += ';
    const after = 'v\n    return total\n';
    const { system, user } = buildLineCompletionPrompt({
      langSlug: 'python3',
      linePrefix,
      before,
      after,
    });
    expect(system).toBe(LINE_SYSTEM_PROMPT);
    expect(user).toContain(before);
    expect(user).toContain(linePrefix);
    expect(user).toContain(after);
    expect(user).toContain('python3');
    // 光有 before 没有 after 时也要有明确占位，不吞掉字段
    const tail = buildLineCompletionPrompt({ langSlug: 'cpp', linePrefix: 'int x = ', before: 'int main() {\n', after: '' });
    expect(tail.user).toContain('int main() {');
    expect(tail.user).toContain('文件末尾');
  });
});

describe('HARNESS_SYSTEM_PROMPT：严格 JSON + 协议 + 安全边界', () => {
  it('要求严格 JSON 且实现协议', () => {
    expect(HARNESS_SYSTEM_PROMPT).toContain('严格 JSON');
    expect(HARNESS_SYSTEM_PROMPT).toContain('__LC_RESULT__');
    expect(HARNESS_SYSTEM_PROMPT).toContain('__LC_DONE__');
    expect(HARNESS_SYSTEM_PROMPT).toContain('__LC_ERROR__');
    expect(HARNESS_SYSTEM_PROMPT).toContain('local/ai');
    expect(HARNESS_SYSTEM_PROMPT).toContain('禁止绝对路径');
    expect(HARNESS_SYSTEM_PROMPT).toMatch(/不要 markdown 代码围栏/);
    expect(HARNESS_SYSTEM_PROMPT).toMatch(/绝不修改|禁止修改/);
  });

  it('buildHarnessPrompt 带上 meta / cases / 用户代码', () => {
    const { system, user } = buildHarnessPrompt({
      langSlug: 'python3',
      title: '146. LRU Cache',
      contentMd: '请你设计一个满足 LRU 约束的缓存。',
      metaJson: '{"name":"LRUCache","construct":true,"classname":"LRUCache"}',
      casesJson: '[{"i":0,"args":["2"],"expected":null}]',
      sourceCode: 'class LRUCache:\n    pass\n',
    });
    expect(system).toBe(HARNESS_SYSTEM_PROMPT);
    expect(user).toContain('LRUCache');
    expect(user).toContain('construct');
    expect(user).toContain('"expected":null');
    expect(user).toContain('class LRUCache');
    expect(user).toContain('__LC_RESULT__');
  });
});

describe('输出清洗', () => {
  it('cleanSingleLine 去围栏、取第一行', () => {
    expect(cleanSingleLine('```python\nnums.append(x)\n```')).toBe('nums.append(x)');
    expect(cleanSingleLine('  total += v  ')).toBe('total += v');
    expect(cleanSingleLine('nums.append(x)\nprint(nums)')).toBe('nums.append(x)');
    expect(cleanSingleLine('```\n```')).toBeNull();
    expect(cleanSingleLine('')).toBeNull();
    expect(cleanSingleLine('   \n\t\n')).toBeNull();
    expect(cleanSingleLine('`x + 1`')).toBe('x + 1');
    expect(cleanSingleLine('补全：return total')).toBe('return total');
  });

  it('cleanSingleLine 丢弃明显不是单行的输出', () => {
    expect(cleanSingleLine(`x${'y'.repeat(300)}`)).toBeNull();
  });

  it('stripCodeFences 保留内容，dropCodeBlocks 直接删块', () => {
    expect(stripCodeFences('思路：\n```py\nx = 1\n```\n完成')).toContain('x = 1');
    const dropped = dropCodeBlocks('先用哈希表\n```py\nx = 1\n```\n再扫一遍');
    expect(dropped).not.toContain('x = 1');
    expect(dropped).toContain('再扫一遍');
  });
});

describe('hints：薄封装行为', () => {
  it('requestHint 去掉代码块', async () => {
    const client = fakeClient('先把数组扫一遍\n```py\ndef twoSum(nums, target):\n    return []\n```\n再看差值');
    const text = await requestHint(client, HINT_CTX);
    expect(text).toContain('先把数组扫一遍');
    expect(text).toContain('再看差值');
    expect(text).not.toContain('def twoSum');
  });

  it('requestHint 空响应抛错', async () => {
    await expect(requestHint(fakeClient('   '), HINT_CTX)).rejects.toThrow(/没有返回/);
  });

  it('requestLineCompletion 只返回单行，空则 null', async () => {
    expect(await requestLineCompletion(fakeClient('```python\n    total += v\n```'), {
      langSlug: 'python3',
      linePrefix: '    total += ',
      before: 'def f(nums):\n',
      after: 'v\n',
    })).toBe('total += v');
    expect(await requestLineCompletion(fakeClient('   '), {
      langSlug: 'python3',
      linePrefix: 'x = ',
      before: '',
      after: '',
    })).toBeNull();
  });
});
