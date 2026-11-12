import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LcMetaData, TestCase } from '../../src/core/types.js';
import { GoHarness } from '../../src/runner/harness/golang.js';
import { findExecutable, runLocalTestsWith } from '../../src/runner/execute.js';

function makeMeta(
  name: string,
  params: Array<[string, string]>,
  ret: string,
  extra: Partial<LcMetaData> = {},
): LcMetaData {
  return {
    name,
    params: params.map(([n, t]) => ({ name: n, type: t })),
    return: { type: ret },
    ...extra,
  };
}

interface GenOptions {
  sourceCode: string;
  meta: LcMetaData;
  cases?: Array<[string[], string | null]>;
}

function gen(opts: GenOptions) {
  const cases: TestCase[] = (opts.cases ?? [[['[2,7,11,15]', '9'], '[0,1]']]).map(([args, expected], i) => ({
    index: i,
    args,
    expected,
    source: 'custom',
  }));
  const artifact = GoHarness.generate({
    langSlug: 'golang',
    meta: opts.meta,
    testCases: cases,
    sourceFile: 'solution.go',
    sourceAbsPath: '/tmp/solution.go',
    sourceCode: opts.sourceCode,
    genDir: '/tmp/local-go',
    titleSlug: 'demo',
  });
  const get = (name: string) => artifact.files.find((f) => f.name === name)!.content;
  return {
    artifact,
    cases,
    main: get('_lc_main.go'),
    solution: get('_lc_solution_gen.go'),
    gomod: get('go.mod'),
    casesJson: get('_lc_cases.json'),
  };
}

const TWO_SUM_META = makeMeta('twoSum', [['nums', 'integer[]'], ['target', 'integer']], 'integer[]');
const TWO_SUM_GO = `func twoSum(nums []int, target int) []int {
	seen := map[int]int{}
	for i, v := range nums {
		if j, ok := seen[target-v]; ok {
			return []int{j, i}
		}
		seen[v] = i
	}
	return []int{}
}
`;

let goAvailable: boolean | undefined;

/** 本机没有 go：console.warn 后让测试直接返回（代码仍是静态可检查的）。 */
async function ensureGo(): Promise<boolean> {
  if (goAvailable === undefined) goAvailable = Boolean(await findExecutable(['go']));
  if (!goAvailable) console.warn('skip: go 不可用');
  return goAvailable;
}

describe('golang 脚手架：support 判定', () => {
  it('slug 是 golang', () => {
    expect(GoHarness.slug).toBe('golang');
    expect(GoHarness.installHint).toContain('go');
  });

  it('设计类题目不支持', () => {
    const r = GoHarness.supports(makeMeta('LRUCache', [['capacity', 'integer']], 'integer', { construct: true }));
    expect(r).toEqual({ ok: false, reason: '设计类题目（多步操作）暂不支持本地脚手架' });
  });

  it('未知类型给出可读原因', () => {
    const r = GoHarness.supports(makeMeta('f', [['x', 'Weird']], 'integer'));
    expect(!r.ok && r.reason).toBe('暂不支持的类型：Weird');
  });

  it('ListNode / TreeNode / 多阶数组 / json / void 都支持', () => {
    const r = GoHarness.supports(
      makeMeta(
        'f',
        [
          ['a', 'integer[]'],
          ['b', 'integer[][]'],
          ['c', 'character[][]'],
          ['d', 'string[][]'],
          ['e', 'ListNode'],
          ['f', 'ListNode[]'],
          ['g', 'TreeNode'],
          ['h', 'TreeNode[]'],
          ['i', 'json'],
        ],
        'void',
      ),
    );
    expect(r.ok).toBe(true);
  });
});

describe('golang 脚手架：生成物', () => {
  it('文件、go.mod、steps、调试入口', () => {
    const { artifact, solution, gomod, casesJson } = gen({ sourceCode: TWO_SUM_GO, meta: TWO_SUM_META });
    expect(artifact.files.map((f) => f.name)).toEqual([
      '_lc_cases.json',
      '_lc_solution_gen.go',
      '_lc_main.go',
      'go.mod',
    ]);
    // 用户源文件只被复制，不改动：复制件补上 package main
    expect(solution.startsWith('package main\n\n')).toBe(true);
    expect(solution).toContain('func twoSum(nums []int, target int) []int');
    expect(solution).not.toBe(TWO_SUM_GO);
    expect(gomod).toContain('module lcuser');
    expect(gomod).toContain('go 1.20');
    expect(artifact.steps.map((s) => [s.label, s.cmd, s.args.join(' ')])).toEqual([
      ['compile', 'go', 'build -o _lc_bin .'],
      ['run', './_lc_bin', ''],
    ]);
    expect(artifact.steps[0].fatal).toBe(true);
    expect(artifact.debugEntry).toBe('_lc_main.go');
    expect(artifact.debugType).toBe('go');
    expect(JSON.parse(casesJson).cases).toHaveLength(1);
  });

  it('调用点按 meta 类型构造实参并序列化返回值', () => {
    const { main } = gen({ sourceCode: TWO_SUM_GO, meta: TWO_SUM_META });
    expect(main).toContain('a0 := lcInts(raw[0])');
    expect(main).toContain('a1 := lcInt(raw[1])');
    expect(main).toContain('ret := twoSum(a0, a1)');
    expect(main).toContain('return lcSerInts(ret)');
    expect(main).toContain('__LC_RESULT__');
    expect(main).toContain('__LC_ERROR__');
    expect(main).toContain('__LC_DONE__');
    expect(main).toContain('recover()');
    // 模板占位符必须全部替换（协议前缀 __LC_RESULT__ 等是合法的输出字面量）
    expect(main).not.toContain('__LC_ENTRY_FOUND__');
    expect(main).not.toContain('__LC_TYPE_DEFS__');
    expect(main).not.toContain('__LC_DISPATCH__');
    expect(main).not.toContain('%BT%');
  });

  it('用户代码若自带 package 声明则不重复添加', () => {
    const src = 'package main\n\nfunc twoSum(nums []int, target int) []int { return nil }\n';
    const { solution } = gen({ sourceCode: src, meta: TWO_SUM_META });
    expect(solution).toBe(src);
  });

  it('void（原地修改）从第一个参数取答案', () => {
    const src = 'func rotate(nums []int, k int) {\n\tn := len(nums)\n\t_ = n\n}\n';
    const { main } = gen({
      sourceCode: src,
      meta: makeMeta('rotate', [['nums', 'integer[]'], ['k', 'integer']], 'void'),
      cases: [[['[1,2,3,4,5,6,7]', '3'], '[5,6,7,1,2,3,4]']],
    });
    expect(main).toContain('rotate(a0, a1)');
    expect(main).toContain('return lcSerInts(a0)');
  });

  it('ListNode 用 LeetCode 的 struct 定义；题面注释里出现不算用户已定义', () => {
    const commented = `/**
 * Definition for singly-linked list.
 * type ListNode struct {
 *     Val int
 *     Next *ListNode
 * }
 */
func reverseList(head *ListNode) *ListNode {
	return head
}
`;
    const a = gen({
      sourceCode: commented,
      meta: makeMeta('reverseList', [['head', 'ListNode']], 'ListNode'),
      cases: [[['[1,2,3]'], '[3,2,1]']],
    });
    expect(a.main).toContain('type ListNode struct {');
    expect(a.main).toContain('Next *ListNode');
    expect(a.main).toContain('a0 := lcList(raw[0])');
    expect(a.main).toContain('return lcSerList(ret)');
  });

  it('用户真的定义了 ListNode 时不再重复生成', () => {
    const userDefined = `type ListNode struct {
	Val  int
	Next *ListNode
}

func reverseList(head *ListNode) *ListNode {
	return head
}
`;
    const { main } = gen({
      sourceCode: userDefined,
      meta: makeMeta('reverseList', [['head', 'ListNode']], 'ListNode'),
      cases: [[['[1,2,3]'], '[3,2,1]']],
    });
    expect(main).not.toContain('type ListNode struct {');
  });

  it('TreeNode / TreeNode[] / char[][] 也能生成', () => {
    const src = `func invertTree(root *TreeNode) *TreeNode {
	return root
}

func allTrees(trees []*TreeNode) [][]byte {
	return nil
}
`;
    const a = gen({
      sourceCode: src,
      meta: makeMeta('invertTree', [['root', 'TreeNode']], 'TreeNode'),
      cases: [[['[4,2,7,1,3,6,9]'], '[4,7,2,9,6,3,1]']],
    });
    expect(a.main).toContain('type TreeNode struct {');
    expect(a.main).toContain('Left  *TreeNode');
    expect(a.main).toContain('a0 := lcTree(raw[0])');
    expect(a.main).toContain('lcSerTree(ret)');
  });

  it('入口函数不存在时走 entry_not_found 分支', () => {
    const src = 'func somethingElse(nums []int) []int {\n\treturn nums\n}\n';
    const { main, artifact } = gen({ sourceCode: src, meta: TWO_SUM_META });
    expect(main).toContain('const lcEntryFound = false');
    expect(main).toContain('lcFatal("entry_not_found")');
    expect(main).not.toContain('twoSum(a0, a1)');
    expect(artifact.steps[0].label).toBe('compile');
  });

  it('存在入口函数时 lcEntryFound 为 true', () => {
    const { main } = gen({ sourceCode: TWO_SUM_GO, meta: TWO_SUM_META });
    expect(main).toContain('const lcEntryFound = true');
  });
});

describe('golang 脚手架：真实运行', () => {
  it('有 go 工具链时能跑通正确解法', async () => {
    if (!(await ensureGo())) return;
    const dir = await mkdtemp(join(tmpdir(), 'lcgo-'));
    const src = join(dir, 'solution.go');
    await writeFile(src, TWO_SUM_GO, 'utf8');
    const cases: TestCase[] = [
      { index: 0, args: ['[2,7,11,15]', '9'], expected: '[0,1]', source: 'custom' },
      { index: 1, args: ['[3,2,4]', '6'], expected: '[1,2]', source: 'custom' },
    ];
    const result = await runLocalTestsWith(GoHarness, {
      langSlug: 'golang',
      meta: TWO_SUM_META,
      testCases: cases,
      sourceFile: 'solution.go',
      sourceAbsPath: src,
      sourceCode: TWO_SUM_GO,
      genDir: join(dir, 'local'),
      titleSlug: 'two-sum',
    });
    if (result.unsupportedReason) throw new Error(`${result.unsupportedReason}\n${result.stderr ?? ''}`);
    expect(result.cases.map((c) => c.actual)).toEqual(['[0,1]', '[1,2]']);
    expect(result.ok).toBe(true);
    expect(await readFile(src, 'utf8')).toBe(TWO_SUM_GO);
  });

  it('有 go 工具链时 ListNode / panic 隔离也能跑', async () => {
    if (!(await ensureGo())) return;
    const dir = await mkdtemp(join(tmpdir(), 'lcgo-list-'));
    const src = join(dir, 'solution.go');
    const code = `func reverseList(head *ListNode) *ListNode {
	var prev *ListNode
	for head != nil {
		next := head.Next
		head.Next = prev
		prev = head
		head = next
	}
	return prev
}

func boom(nums []int) []int {
	panic("boom")
}
`;
    await writeFile(src, code, 'utf8');
    const listCases: TestCase[] = [
      { index: 0, args: ['[1,2,3,4,5]'], expected: '[5,4,3,2,1]', source: 'custom' },
    ];
    const r1 = await runLocalTestsWith(GoHarness, {
      langSlug: 'golang',
      meta: makeMeta('reverseList', [['head', 'ListNode']], 'ListNode'),
      testCases: listCases,
      sourceFile: 'solution.go',
      sourceAbsPath: src,
      sourceCode: code,
      genDir: join(dir, 'local'),
      titleSlug: 'reverse-linked-list',
    });
    if (r1.unsupportedReason) throw new Error(r1.unsupportedReason);
    expect(r1.cases[0].actual).toBe('[5,4,3,2,1]');

    const r2 = await runLocalTestsWith(GoHarness, {
      langSlug: 'golang',
      meta: makeMeta('boom', [['nums', 'integer[]']], 'integer[]'),
      testCases: [
        { index: 0, args: ['[1]'], expected: '[1]', source: 'custom' },
        { index: 1, args: ['[2]'], expected: '[2]', source: 'custom' },
      ],
      sourceFile: 'solution.go',
      sourceAbsPath: src,
      sourceCode: code,
      genDir: join(dir, 'local2'),
      titleSlug: 'boom',
    });
    if (r2.unsupportedReason) throw new Error(r2.unsupportedReason);
    expect(r2.cases.map((c) => c.ok)).toEqual([false, false]);
    expect(String(r2.cases[0].error)).toContain('panic');
  });
});
