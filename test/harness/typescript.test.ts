import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeScriptHarness, TS_STRIP_MIN_NODE } from '../../src/runner/harness/typescript.js';
import { CASES_FILE } from '../../src/runner/harness/types.js';
import { runLocalTestsWith } from '../../src/runner/execute.js';
import type { LcMetaData, RunResult, TestCase } from '../../src/core/types.js';

function mkMeta(
  name: string,
  paramTypes: string[],
  returnType: string,
  extra: Partial<LcMetaData> = {},
): LcMetaData {
  return {
    name,
    params: paramTypes.map((type, i) => ({ name: `p${i}`, type })),
    return: { type: returnType },
    manual: false,
    ...extra,
  };
}

/** rows: [每个参数的原文数组, 期望输出] */
function mkCases(rows: Array<[string[], string | null]>): TestCase[] {
  return rows.map(([args, expected], index) => ({
    index,
    args,
    expected,
    source: 'custom' as const,
  }));
}

/** 当前 Node 是否内置了 module.stripTypeScriptTypes（Node >= 22.7）。 */
async function hasStripTypes(): Promise<boolean> {
  try {
    const mod = (await import('node:module')) as unknown as Record<string, unknown>;
    return typeof mod.stripTypeScriptTypes === 'function';
  } catch {
    return false;
  }
}

interface RunOnce {
  result: RunResult;
  sourcePath: string;
  genDir: string;
}

async function runOnce(
  code: string,
  meta: LcMetaData,
  cases: TestCase[],
  fileName = 'solution.ts',
): Promise<RunOnce> {
  const dir = await mkdtemp(join(tmpdir(), 'lcts-'));
  const sourcePath = join(dir, fileName);
  await writeFile(sourcePath, code, 'utf8');
  const genDir = join(dir, 'local');
  await mkdir(genDir, { recursive: true });
  const result = await runLocalTestsWith(TypeScriptHarness, {
    langSlug: 'typescript',
    meta,
    testCases: cases,
    sourceFile: fileName,
    sourceAbsPath: sourcePath,
    sourceCode: code,
    genDir,
    titleSlug: 'demo',
  });
  return { result, sourcePath, genDir };
}

const TWO_SUM_META = mkMeta('twoSum', ['integer[]', 'integer'], 'integer[]');
const TWO_SUM_CASES = mkCases([
  [['[2,7,11,15]', '9'], '[0,1]'],
  [['[3,2,4]', '6'], '[1,2]'],
]);

describe('typescript 脚手架：supports', () => {
  it('设计类题目返回明确的不支持原因', () => {
    const meta = mkMeta('MedianFinder', [], 'void', { construct: true, classname: 'MedianFinder' });
    const support = TypeScriptHarness.supports(meta);
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toBe('设计类题目（多步操作）暂不支持本地脚手架');
  });

  it('未知类型返回「暂不支持的类型：X」', () => {
    const support = TypeScriptHarness.supports(mkMeta('foo', ['integer'], 'WeirdType'));
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toBe('暂不支持的类型：WeirdType');
  });
});

describe('typescript 脚手架：生成物', () => {
  it('运行器开启类型剥离，调试入口为 node', () => {
    const artifact = TypeScriptHarness.generate({
      langSlug: 'typescript',
      meta: TWO_SUM_META,
      testCases: [],
      sourceFile: 'solution.ts',
      sourceAbsPath: '/tmp/x/solution.ts',
      sourceCode: '',
      genDir: '/tmp/x/local',
      titleSlug: 'two-sum',
    });
    expect(artifact.debugEntry).toBe('_lc_runner.js');
    expect(artifact.debugType).toBe('node');
    expect(artifact.steps[0].cmd).toBe('node');
    expect(artifact.steps[0].args).toEqual(['_lc_runner.js', '/tmp/x/solution.ts']);
    const runner = artifact.files.find((f) => f.name === '_lc_runner.js');
    expect(runner?.content).toContain('const STRIP_TYPES = true;');
    expect(runner?.content).toContain('stripTypeScriptTypes');
    expect(artifact.notes?.some((n) => n.includes(TS_STRIP_MIN_NODE))).toBe(true);
    expect(TypeScriptHarness.installHint).toContain(TS_STRIP_MIN_NODE);
  });

  it('只生成 genDir 下的三个文件，且不修改用户代码', async () => {
    const code = `function twoSum(nums: number[], target: number): number[] {\n  return [0, 1];\n}\n`;
    const { result, sourcePath, genDir } = await runOnce(
      code,
      TWO_SUM_META,
      mkCases([[['[2,7,11,15]', '9'], '[0,1]']]),
    );
    expect(result.ok).toBe(true);
    expect(await readFile(sourcePath, 'utf8')).toBe(code);
    const names = (await readdir(genDir)).sort();
    expect(names).toEqual([CASES_FILE, '_lc_runner.js', '_lc_sandbox.js'].sort());
  });
});

describe('typescript 脚手架：真实执行', () => {
  it('function 声明 + 类型注解能跑通', async () => {
    if (!(await hasStripTypes())) {
      console.warn('skip: module.stripTypeScriptTypes 不可用（需要 Node >= ' + TS_STRIP_MIN_NODE + '）');
      return;
    }
    const code = `function twoSum(nums: number[], target: number): number[] {
  const seen = new Map<number, number>();
  for (let i = 0; i < nums.length; i++) {
    const need: number = target - nums[i];
    if (seen.has(need)) return [seen.get(need)!, i];
    seen.set(nums[i], i);
  }
  return [];
}
`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.cases.map((c) => c.ok)).toEqual([true, true]);
    expect(result.cases[0].actual).toBe('[0,1]');
  });

  it('LeetCode 题面的 var twoSum = function(...) 写法能跑通', async () => {
    if (!(await hasStripTypes())) {
      console.warn('skip: module.stripTypeScriptTypes 不可用');
      return;
    }
    const code = `var twoSum = function(nums: number[], target: number): number[] {
  var seen: Record<number, number> = {};
  for (var i = 0; i < nums.length; i++) {
    if (seen[target - nums[i]] !== undefined) return [seen[target - nums[i]], i];
    seen[nums[i]] = i;
  }
  return [];
};
`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.cases.map((c) => c.ok)).toEqual([true, true]);
  });

  it('class Solution { method(): T {} } 形式能跑通', async () => {
    if (!(await hasStripTypes())) {
      console.warn('skip: module.stripTypeScriptTypes 不可用');
      return;
    }
    const code = `interface Answer {
  pair: number[];
}

class Solution {
  twoSum(nums: number[], target: number): number[] {
    const answer: Answer = { pair: [] as number[] };
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        if (nums[i] + nums[j] === target) {
          answer.pair = [i, j];
          return answer.pair;
        }
      }
    }
    return answer.pair;
  }
}
`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.cases.map((c) => c.ok)).toEqual([true, true]);
  });

  it('ListNode 类型 + 类型注解', async () => {
    if (!(await hasStripTypes())) {
      console.warn('skip: module.stripTypeScriptTypes 不可用');
      return;
    }
    const code = `function reverseList(head: ListNode | null): ListNode | null {
  let prev: ListNode | null = null;
  let cur: ListNode | null = head;
  while (cur !== null) {
    const next: ListNode | null = cur.next;
    cur.next = prev;
    prev = cur;
    cur = next;
  }
  return prev;
}
`;
    const meta = mkMeta('reverseList', ['ListNode'], 'ListNode');
    const { result } = await runOnce(code, meta, mkCases([[['[1,2,3]'], '[3,2,1]']]));
    expect(result.cases[0].actual).toBe('[3,2,1]');
    expect(result.cases[0].ok).toBe(true);
  });

  it('enum 之类 strip-only 不支持的语法会退回 transform 模式', async () => {
    if (!(await hasStripTypes())) {
      console.warn('skip: module.stripTypeScriptTypes 不可用');
      return;
    }
    const code = `enum Kind {
  Even = 0,
  Odd = 1,
}

function twoSum(nums: number[], target: number): number[] {
  const kind: Kind = nums.length % 2 === 0 ? Kind.Even : Kind.Odd;
  void kind;
  return [0, 1];
}
`;
    const { result } = await runOnce(code, TWO_SUM_META, mkCases([[['[2,7,11,15]', '9'], '[0,1]']]));
    expect(result.cases.map((c) => c.ok)).toEqual([true]);
    expect(result.cases[0].actual).toBe('[0,1]');
  });

  it('入口不存在时报 entry_not_found', async () => {
    if (!(await hasStripTypes())) {
      console.warn('skip: module.stripTypeScriptTypes 不可用');
      return;
    }
    const code = `function other(nums: number[], target: number): number[] {\n  return [0, 1];\n}\n`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.ok).toBe(false);
    expect(String(result.cases[0].error)).toContain('entry_not_found');
  });

  it('import / export 属于已知限制（报 load_error 而不是静默失败）', async () => {
    if (!(await hasStripTypes())) {
      console.warn('skip: module.stripTypeScriptTypes 不可用');
      return;
    }
    const code = `import { readFileSync } from 'node:fs';

export function twoSum(nums: number[], target: number): number[] {
  void readFileSync;
  return [0, 1];
}
`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.ok).toBe(false);
    expect(String(result.cases[0].error)).toContain('load_error');
  });
});
