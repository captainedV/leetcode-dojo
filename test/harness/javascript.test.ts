import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JavaScriptHarness } from '../../src/runner/harness/javascript.js';
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

interface RunOnce {
  result: RunResult;
  /** 用户代码文件绝对路径 */
  sourcePath: string;
  /** 生成物目录 */
  genDir: string;
}

async function runOnce(
  code: string,
  meta: LcMetaData,
  cases: TestCase[],
  fileName = 'solution.js',
): Promise<RunOnce> {
  const dir = await mkdtemp(join(tmpdir(), 'lcjs-'));
  const sourcePath = join(dir, fileName);
  await writeFile(sourcePath, code, 'utf8');
  const genDir = join(dir, 'local');
  await mkdir(genDir, { recursive: true });
  const result = await runLocalTestsWith(JavaScriptHarness, {
    langSlug: 'javascript',
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
const TWO_SUM_CASES = mkCases([[['[2,7,11,15]', '9'], '[0,1]']]);

const TWO_SUM_SOLUTION = `var twoSum = function(nums, target) {
  var seen = {};
  for (var i = 0; i < nums.length; i++) {
    var need = target - nums[i];
    if (seen[need] !== undefined) return [seen[need], i];
    seen[nums[i]] = i;
  }
  return [];
};
`;

describe('javascript 脚手架：supports', () => {
  it('设计类题目返回明确的不支持原因', () => {
    const meta = mkMeta('MedianFinder', [], 'void', { construct: true, classname: 'MedianFinder' });
    const support = JavaScriptHarness.supports(meta);
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toBe('设计类题目（多步操作）暂不支持本地脚手架');
  });

  it('未知类型返回「暂不支持的类型：X」', () => {
    const support = JavaScriptHarness.supports(mkMeta('foo', ['TreeNode2'], 'integer'));
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toBe('暂不支持的类型：TreeNode2');
  });

  it('常见类型可以通过', () => {
    expect(JavaScriptHarness.supports(TWO_SUM_META).ok).toBe(true);
    expect(JavaScriptHarness.supports(mkMeta('f', ['ListNode[]', 'TreeNode'], 'boolean')).ok).toBe(true);
  });
});

describe('javascript 脚手架：生成物', () => {
  it('只生成 genDir 下的三个文件，且不修改用户代码', async () => {
    const code = `var twoSum = function(nums, target) {\n  return [0, 1];\n};\n`;
    const { result, genDir, sourcePath } = await runOnce(
      code,
      TWO_SUM_META,
      mkCases([[['[2,7,11,15]', '9'], '[0,1]']]),
    );
    expect(result.ok).toBe(true);
    const names = (await readdir(genDir)).sort();
    expect(names).toEqual([CASES_FILE, '_lc_runner.js', '_lc_sandbox.js'].sort());
    expect(await readFile(sourcePath, 'utf8')).toBe(code);
    const cases = JSON.parse(await readFile(join(genDir, CASES_FILE), 'utf8'));
    expect(cases.cases[0].args).toEqual(['[2,7,11,15]', '9']);
    expect(cases.meta.name).toBe('twoSum');
  });

  it('debugEntry 指向可直接运行的入口，debugType 为 node', () => {
    const artifact = JavaScriptHarness.generate({
      langSlug: 'javascript',
      meta: TWO_SUM_META,
      testCases: [],
      sourceFile: 'solution.js',
      sourceAbsPath: '/tmp/x/solution.js',
      sourceCode: '',
      genDir: '/tmp/x/local',
      titleSlug: 'two-sum',
    });
    expect(artifact.debugEntry).toBe('_lc_runner.js');
    expect(artifact.debugType).toBe('node');
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0].label).toBe('run');
    expect(artifact.steps[0].cmd).toBe('node');
    expect(artifact.steps[0].args).toEqual(['_lc_runner.js', '/tmp/x/solution.js']);
    const runner = artifact.files.find((f) => f.name === '_lc_runner.js');
    expect(runner?.content).toContain('__LC_RESULT__');
    expect(runner?.content).toContain('__LC_ERROR__');
    expect(runner?.content).toContain('__LC_DONE__');
    // 生成是纯函数式：不读取也不改写用户代码内容
    expect(artifact.files.some((f) => f.name === 'solution.js')).toBe(false);
  });
});

describe('javascript 脚手架：真实执行', () => {
  it('顶层 var 声明的函数（LeetCode 题面写法）能跑通', async () => {
    const cases = mkCases([
      [['[2,7,11,15]', '9'], '[0,1]'],
      [['[3,2,4]', '6'], '[1,2]'],
      [['[3,3]', '6'], '[0,1]'],
    ]);
    const { result } = await runOnce(TWO_SUM_SOLUTION, TWO_SUM_META, cases);
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.cases.map((c) => c.ok)).toEqual([true, true, true]);
    expect(result.cases[0].actual).toBe('[0,1]');
    expect(result.ok).toBe(true);
  });

  it('顶层 function 声明也能跑通', async () => {
    const code = `function twoSum(nums, target) {
  return [0, 1];
}
`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.cases[0].ok).toBe(true);
    expect(result.cases[0].actual).toBe('[0,1]');
  });

  it('class Solution { method() {} } 形式能跑通', async () => {
    const code = `class Solution {
  twoSum(nums, target) {
    const map = new Map();
    for (let i = 0; i < nums.length; i++) {
      const need = target - nums[i];
      if (map.has(need)) return [map.get(need), i];
      map.set(nums[i], i);
    }
    return [];
  }
}
`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.cases.map((c) => c.ok)).toEqual([true]);
    expect(result.cases[0].actual).toBe('[0,1]');
  });

  it('错误解法被判错，并给出 actual', async () => {
    const code = `var twoSum = function(nums, target) {\n  return [0, 0];\n};\n`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.ok).toBe(false);
    expect(result.cases[0].ok).toBe(false);
    expect(result.cases[0].actual).toBe('[0,0]');
  });

  it('ListNode 参数与返回值（链表序列化）', async () => {
    const code = `var reverseList = function(head) {
  var prev = null;
  while (head) {
    var next = head.next;
    head.next = prev;
    prev = head;
    head = next;
  }
  return prev;
};
`;
    const meta = mkMeta('reverseList', ['ListNode'], 'ListNode');
    const cases = mkCases([
      [['[1,2,3,4,5]'], '[5,4,3,2,1]'],
      [['[]'], '[]'],
      [['[1]'], '[1]'],
    ]);
    const { result } = await runOnce(code, meta, cases);
    expect(result.cases.map((c) => c.actual)).toEqual(['[5,4,3,2,1]', '[]', '[1]']);
    expect(result.cases.map((c) => c.ok)).toEqual([true, true, true]);
  });

  it('用户代码自己声明的 ListNode 也能用（自定义类优先）', async () => {
    const code = `function ListNode(val, next) {
  this.val = val === undefined ? 0 : val;
  this.next = next === undefined ? null : next;
}
var reverseList = function(head) {
  var prev = null;
  while (head) {
    var next = head.next;
    head.next = prev;
    prev = head;
    head = next;
  }
  return prev;
};
`;
    const meta = mkMeta('reverseList', ['ListNode'], 'ListNode');
    const { result } = await runOnce(code, meta, mkCases([[['[1,2,3]'], '[3,2,1]']]));
    expect(result.cases[0].ok).toBe(true);
    expect(result.cases[0].actual).toBe('[3,2,1]');
  });

  it('TreeNode 参数与返回值（层序、末尾去 null）', async () => {
    const code = `var invertTree = function(root) {
  if (!root) return null;
  var tmp = root.left;
  root.left = invertTree(root.right);
  root.right = invertTree(tmp);
  return root;
};
`;
    const meta = mkMeta('invertTree', ['TreeNode'], 'TreeNode');
    const cases = mkCases([
      [['[4,2,7,1,3,6,9]'], '[4,7,2,9,6,3,1]'],
      [['[1,2]'], '[1,null,2]'],
      [['[]'], '[]'],
    ]);
    const { result } = await runOnce(code, meta, cases);
    expect(result.cases.map((c) => c.actual)).toEqual(['[4,7,2,9,6,3,1]', '[1,null,2]', '[]']);
    expect(result.cases.map((c) => c.ok)).toEqual([true, true, true]);
  });

  it('void 返回值取第一个参数（原地修改）', async () => {
    const code = `var sortColors = function(nums) {
  nums.sort(function (a, b) { return a - b; });
};
`;
    const meta = mkMeta('sortColors', ['integer[]'], 'void');
    const { result } = await runOnce(code, meta, mkCases([[['[2,0,2,1,1,0]'], '[0,0,1,1,2,2]']]));
    expect(result.cases[0].actual).toBe('[0,0,1,1,2,2]');
    expect(result.cases[0].ok).toBe(true);
  });

  it('char[] 原地修改', async () => {
    const code = `var reverseString = function(s) {\n  s.reverse();\n};\n`;
    const meta = mkMeta('reverseString', ['character[]'], 'void');
    const { result } = await runOnce(code, meta, mkCases([[['["h","e","l","l","o"]'], '["o","l","l","e","h"]']]));
    expect(result.cases[0].actual).toBe('["o","l","l","e","h"]');
    expect(result.cases[0].ok).toBe(true);
  });

  it('每个用例单独 try/catch，互不影响', async () => {
    const code = `var twoSum = function(nums, target) {
  if (target === 6) throw new Error('boom-6');
  return [0, 1];
};
`;
    const cases = mkCases([
      [['[2,7,11,15]', '9'], '[0,1]'],
      [['[3,2,4]', '6'], '[1,2]'],
      [['[1,2]', '3'], '[0,1]'],
    ]);
    const { result } = await runOnce(code, TWO_SUM_META, cases);
    expect(result.cases[0].ok).toBe(true);
    expect(result.cases[1].ok).toBe(false);
    expect(result.cases[1].error).toContain('boom-6');
    expect(result.cases[2].ok).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('入口不存在时报 entry_not_found', async () => {
    const code = `var somethingElse = function(nums, target) { return [0, 1]; };\n`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.ok).toBe(false);
    expect(String(result.cases[0].error)).toContain('entry_not_found');
  });

  it('用户代码语法错误时报 load_error', async () => {
    const code = `var twoSum = function(nums, target) { return [[[ };\n`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.ok).toBe(false);
    expect(String(result.cases[0].error)).toContain('load_error');
  });

  it('boolean / double / string / 二维数组 / 字符串数组的序列化', async () => {
    const code = `var f = function(n) {
  return n > 0;
};
var g = function(arr) {
  return arr[0] + arr[1];
};
var h = function(s, n) {
  return s + ':' + n;
};
var k = function() {
  return [[1, 2], [3]];
};
var m = function() {
  return ['ab', 'cd'];
};
`;
    const bool = await runOnce(code, mkMeta('f', ['integer'], 'boolean'), mkCases([[['3'], 'true']]));
    expect(bool.result.cases[0].actual).toBe('true');
    expect(bool.result.cases[0].ok).toBe(true);

    const dbl = await runOnce(code, mkMeta('g', ['double[]'], 'double'), mkCases([[['[0.1,0.2]'], '0.3']]));
    expect(dbl.result.cases[0].actual).toBe('0.3');
    expect(dbl.result.cases[0].ok).toBe(true);

    const str = await runOnce(
      code,
      mkMeta('h', ['string', 'integer'], 'string'),
      mkCases([[['abc', '2'], 'abc:2']]),
    );
    expect(str.result.cases[0].actual).toBe('abc:2');
    expect(str.result.cases[0].ok).toBe(true);

    const matrix = await runOnce(code, mkMeta('k', [], 'integer[][]'), mkCases([[[''], '[[1,2],[3]]']]));
    expect(matrix.result.cases[0].actual).toBe('[[1,2],[3]]');
    expect(matrix.result.cases[0].ok).toBe(true);

    const strings = await runOnce(code, mkMeta('m', [], 'string[]'), mkCases([[[''], '["ab","cd"]']]));
    expect(strings.result.cases[0].actual).toBe('["ab","cd"]');
    expect(strings.result.cases[0].ok).toBe(true);
  });

  it('N 叉树 Node（children）能原样往返', async () => {
    const code = `var echo = function(root) { return root; };\n`;
    const meta = mkMeta('echo', ['Node'], 'Node');
    const { result } = await runOnce(code, meta, mkCases([[['[1,null,3,2,4,null,5,6]'], '[1,null,3,2,4,null,5,6]']]));
    expect(result.cases[0].actual).toBe('[1,null,3,2,4,null,5,6]');
    expect(result.cases[0].ok).toBe(true);
  });

  it('克隆图（邻接表输入）能原样往返', async () => {
    const code = `var cloneGraph = function(node) {\n  return node;\n};\n`;
    const meta = mkMeta('cloneGraph', ['Node'], 'Node');
    const { result } = await runOnce(
      code,
      meta,
      mkCases([[['[[2,4],[1,3],[2,4],[1,3]]'], '[[2,4],[1,3],[2,4],[1,3]]']]),
    );
    expect(result.cases[0].actual).toBe('[[2,4],[1,3],[2,4],[1,3]]');
    expect(result.cases[0].ok).toBe(true);
  });

  it('用户代码里的 console.log 会被收集到 logs 而不污染协议', async () => {
    const code = `var twoSum = function(nums, target) {
  console.log('debug', nums.length);
  return [0, 1];
};
`;
    const { result } = await runOnce(code, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.cases[0].ok).toBe(true);
    expect(String(result.cases[0].meta?.logs ?? '')).toContain('debug');
  });
});
