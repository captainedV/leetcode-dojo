import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestCases, parseMetaData } from '../../src/core/parse.js';
import { runLocalTests, runLocalTestsWith, findExecutable, materialize, parseProtocol, runStep } from '../../src/runner/execute.js';
import { PythonHarness } from '../../src/runner/harness/python.js';
import { resolvePython } from '../../src/runner/toolchain.js';

const TWO_SUM_META = JSON.stringify({
  name: 'twoSum',
  params: [
    { name: 'nums', type: 'integer[]' },
    { name: 'target', type: 'integer' },
  ],
  return: { type: 'integer[]', size: 2 },
  manual: false,
});

const TWO_SUM_CONTENT = `
<p>Given an array of integers <code>nums</code> and an integer <code>target</code>, return indices.</p>
<pre>
<strong>Input:</strong> nums = [2,7,11,15], target = 9
<strong>Output:</strong> [0,1]
<strong>Explanation:</strong> Because nums[0] + nums[1] == 9, we return [0, 1].
</pre>
<pre>
<strong>Input:</strong> nums = [3,2,4], target = 6
<strong>Output:</strong> [1,2]
</pre>
<pre>
<strong>Input:</strong> nums = [3,3], target = 6
<strong>Output:</strong> [0,1]
</pre>
`;

const TWO_SUM_EXAMPLES = '[2,7,11,15]\n9\n[3,2,4]\n6\n[3,3]\n6';

const SOLUTION_PY = `from typing import List


class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, v in enumerate(nums):
            if target - v in seen:
                return [seen[target - v], i]
            seen[v] = i
        return []
`;

describe('parse: 用例构造', () => {
  it('按 params 数量切分 exampleTestcases 并从题面取期望输出', () => {
    const cases = buildTestCases({
      exampleTestcases: TWO_SUM_EXAMPLES,
      content: TWO_SUM_CONTENT,
      metaData: TWO_SUM_META,
    });
    expect(cases).toHaveLength(3);
    expect(cases[0].args).toEqual(['[2,7,11,15]', '9']);
    expect(cases[0].expected).toBe('[0,1]');
    expect(cases[1].expected).toBe('[1,2]');
    expect(cases[2].expected).toBe('[0,1]');
  });

  it('metaData 可解析', () => {
    const meta = parseMetaData(TWO_SUM_META);
    expect(meta?.name).toBe('twoSum');
    expect(meta?.params.map((p) => p.type)).toEqual(['integer[]', 'integer']);
  });
});

describe('python3 脚手架', () => {
  it('能跑通正确解法', async () => {
    const py = await findExecutable(['python3']);
    if (!py) {
      console.warn('skip: python3 不可用');
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'lcpy-'));
    const src = join(dir, 'solution.py');
    await writeFile(src, SOLUTION_PY, 'utf8');
    await mkdir(join(dir, 'local'), { recursive: true });
    const cases = buildTestCases({
      exampleTestcases: TWO_SUM_EXAMPLES,
      content: TWO_SUM_CONTENT,
      metaData: TWO_SUM_META,
    });
    const result = await runLocalTests({
      langSlug: 'python3',
      meta: parseMetaData(TWO_SUM_META)!,
      testCases: cases,
      sourceFile: 'solution.py',
      sourceAbsPath: src,
      sourceCode: SOLUTION_PY,
      genDir: join(dir, 'local'),
      titleSlug: 'two-sum',
    });
    if (!result.ok && result.unsupportedReason) {
      throw new Error(`unexpected: ${result.unsupportedReason}\n${result.stderr ?? ''}`);
    }
    expect(result.cases.map((c) => c.ok)).toEqual([true, true, true]);
    expect(result.ok).toBe(true);
  });

  it('错误解法会被判错', async () => {
    const py = await findExecutable(['python3']);
    if (!py) return;
    const dir = await mkdtemp(join(tmpdir(), 'lcpy-bad-'));
    const src = join(dir, 'solution.py');
    const bad = `class Solution:\n    def twoSum(self, nums, target):\n        return [0, 0]\n`;
    await writeFile(src, bad, 'utf8');
    const cases = buildTestCases({
      exampleTestcases: TWO_SUM_EXAMPLES,
      content: TWO_SUM_CONTENT,
      metaData: TWO_SUM_META,
    });
    const result = await runLocalTests({
      langSlug: 'python3',
      meta: parseMetaData(TWO_SUM_META)!,
      testCases: cases,
      sourceFile: 'solution.py',
      sourceAbsPath: src,
      sourceCode: bad,
      genDir: join(dir, 'local'),
      titleSlug: 'two-sum',
    });
    expect(result.ok).toBe(false);
    expect(result.cases[0].actual.replace(/\s+/g, '')).toBe('[0,0]');
    expect(result.cases[0].ok).toBe(false);
  });
});


/**
 * 回归：LeetCode 新版 Python3 模板用 PEP 604（`ListNode | None`），
 * 本地 3.9 会在 class 定义时 TypeError —— 曾导致用户点调试直接崩。
 */
describe('python PEP 604 注解兼容（ListNode | None）', () => {
  const SRC = [
    'class Solution:',
    '    def addTwoNumbers(self, l1: ListNode | None, l2: ListNode | None) -> ListNode | None:',
    '        dummy = ListNode(0)',
    '        cur = dummy',
    '        carry = 0',
    '        while l1 or l2 or carry:',
    '            a = l1.val if l1 else 0',
    '            b = l2.val if l2 else 0',
    '            carry, s = divmod(a + b + carry, 10)',
    '            cur.next = ListNode(s)',
    '            cur = cur.next',
    '            l1 = l1.next if l1 else None',
    '            l2 = l2.next if l2 else None',
    '        return dummy.next',
    '',
  ].join('\n');
  const meta = {
    name: 'addTwoNumbers',
    params: [
      { name: 'l1', type: 'ListNode' },
      { name: 'l2', type: 'ListNode' },
    ],
    return: { type: 'ListNode' },
  };
  const cases = [{ index: 0, args: ['[2,4,3]', '[5,6,4]'], expected: '[7,0,8]', source: 'leet' as const }];

  it('普通运行入口（exec）能跑通', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lc-pep604-'));
    const src = join(dir, 'solution.py');
    await writeFile(src, SRC, 'utf8');
    const result = await runLocalTestsWith(PythonHarness, {
      langSlug: 'python3',
      meta,
      testCases: cases,
      sourceFile: 'solution.py',
      sourceAbsPath: src,
      sourceCode: SRC,
      genDir: join(dir, 'local'),
      titleSlug: 'add-two-numbers',
    });
    expect(result.unsupportedReason ?? '').toBe('');
    expect(result.cases[0]?.actual.replace(/\s+/g, '')).toBe('[7,0,8]');
    expect(result.cases[0]?.ok).toBe(true);
  });

  it('调试入口（标准 import）在 3.9 与 3.10+ 上都能跑通', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lc-pep604-dbg-'));
    const src = join(dir, 'solution.py');
    await writeFile(src, SRC, 'utf8');
    const genDir = join(dir, 'local');
    const artifact = PythonHarness.generate({
      langSlug: 'python3',
      meta,
      testCases: cases,
      sourceFile: 'solution.py',
      sourceAbsPath: src,
      sourceCode: SRC,
      genDir,
      titleSlug: 'add-two-numbers',
      debug: true,
    });
    await materialize(artifact, genDir);
    expect(artifact.debugEntry).toBe('_lc_debug_runner.py');

    const interpreters: string[] = [];
    const systemPython = await findExecutable(['python3']);
    if (systemPython) interpreters.push(systemPython);
    const modern = await resolvePython();
    if (modern && !interpreters.includes(modern.path)) interpreters.push(modern.path);
    if (!interpreters.length) {
      console.warn('skip: 没有可用 python');
      return;
    }
    for (const py of interpreters) {
      const out = await runStep(
        { label: 'run', cmd: py, args: [join(genDir, artifact.debugEntry), src] },
        genDir,
        {},
      );
      const parsed = parseProtocol(out.stdout);
      expect(out.stderr).not.toContain('unsupported operand type(s)');
      expect(parsed.fatal).toBeUndefined();
      expect(parsed.results[0]?.actual.replace(/\s+/g, '')).toBe('[7,0,8]');
    }
  });
});
