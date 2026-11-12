import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LcMetaData, TestCase } from '../../src/core/types.js';
import { RustHarness } from '../../src/runner/harness/rust.js';
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

function gen(opts: { sourceCode: string; meta: LcMetaData; cases?: Array<[string[], string | null]> }) {
  const cases: TestCase[] = (opts.cases ?? [[['[2,7,11,15]', '9'], '[0,1]']]).map(([args, expected], i) => ({
    index: i,
    args,
    expected,
    source: 'custom',
  }));
  const artifact = RustHarness.generate({
    langSlug: 'rust',
    meta: opts.meta,
    testCases: cases,
    sourceFile: 'solution.rs',
    sourceAbsPath: '/tmp/solution.rs',
    sourceCode: opts.sourceCode,
    genDir: '/tmp/local-rs',
    titleSlug: 'demo',
  });
  const get = (name: string) => artifact.files.find((f) => f.name === name)!.content;
  return { artifact, cases, main: get('_lc_main.rs'), casesJson: get('_lc_cases.json') };
}

const TWO_SUM_META = makeMeta('twoSum', [['nums', 'integer[]'], ['target', 'integer']], 'integer[]');
const TWO_SUM_RS = `impl Solution {
    pub fn two_sum(nums: Vec<i32>, target: i32) -> Vec<i32> {
        let mut seen = std::collections::HashMap::new();
        for (i, v) in nums.iter().enumerate() {
            if let Some(j) = seen.get(&(target - v)) {
                return vec![*j as i32, i as i32];
            }
            seen.insert(v, i);
        }
        vec![]
    }
}
`;

let rustcAvailable: boolean | undefined;

/** 本机没有 rustc：console.warn 后让测试直接返回（代码仍是静态可检查的）。 */
async function ensureRustc(): Promise<boolean> {
  if (rustcAvailable === undefined) rustcAvailable = Boolean(await findExecutable(['rustc']));
  if (!rustcAvailable) console.warn('skip: rustc 不可用');
  return rustcAvailable;
}

describe('rust 脚手架：support 判定', () => {
  it('slug 是 rust', () => {
    expect(RustHarness.slug).toBe('rust');
    expect(RustHarness.installHint).toContain('rustc');
  });

  it('设计类题目不支持', () => {
    const r = RustHarness.supports(makeMeta('LRUCache', [['capacity', 'integer']], 'integer', { construct: true }));
    expect(r).toEqual({ ok: false, reason: '设计类题目（多步操作）暂不支持本地脚手架' });
  });

  it('未知类型给出可读原因', () => {
    const r = RustHarness.supports(makeMeta('f', [['x', 'NestedInteger2']], 'integer'));
    expect(!r.ok && r.reason).toBe('暂不支持的类型：NestedInteger2');
  });

  it('Node / graph 明确拒绝，常见类型通过', () => {
    expect(RustHarness.supports(makeMeta('f', [['x', 'Node']], 'integer')).ok).toBe(false);
    expect(RustHarness.supports(makeMeta('f', [['x', 'graph']], 'integer')).ok).toBe(false);
    expect(
      RustHarness.supports(
        makeMeta(
          'f',
          [
            ['a', 'integer[]'],
            ['b', 'integer[][]'],
            ['c', 'string[][]'],
            ['d', 'ListNode'],
            ['e', 'ListNode[]'],
            ['g', 'TreeNode'],
            ['h', 'TreeNode[]'],
            ['i', 'json'],
          ],
          'void',
        ),
      ).ok,
    ).toBe(true);
  });
});

describe('rust 脚手架：生成物', () => {
  it('只生成 cases 与 _lc_main.rs，steps 用 rustc 编译', () => {
    const { artifact, casesJson } = gen({ sourceCode: TWO_SUM_RS, meta: TWO_SUM_META });
    expect(artifact.files.map((f) => f.name)).toEqual(['_lc_cases.json', '_lc_main.rs']);
    expect(artifact.steps.map((s) => [s.label, s.cmd, s.args.join(' ')])).toEqual([
      ['compile', 'rustc', '-O -o _lc_bin _lc_main.rs'],
      ['run', './_lc_bin', ''],
    ]);
    expect(artifact.steps[0].fatal).toBe(true);
    expect(artifact.debugEntry).toBe('_lc_main.rs');
    expect(artifact.debugType).toBe('lldb');
    expect(JSON.parse(casesJson).cases).toHaveLength(1);
  });

  it('用户代码原样嵌入（不用 include!），并补 struct Solution', () => {
    const { main } = gen({ sourceCode: TWO_SUM_RS, meta: TWO_SUM_META });
    expect(main).toContain('pub fn two_sum(nums: Vec<i32>, target: i32) -> Vec<i32>');
    expect(main).toContain('struct Solution;');
    expect(main).not.toContain('include!');
    expect(main).toContain('fn main() {');
    expect(main).toContain('__LC_RESULT__');
    expect(main).toContain('__LC_ERROR__');
    expect(main).toContain('__LC_DONE__');
    expect(main).toContain('std::panic::catch_unwind');
    expect(main).not.toContain('__LC_ENTRY_FOUND__');
  });

  it('调用点使用 snake_case 关联函数与类型转换', () => {
    const { main } = gen({ sourceCode: TWO_SUM_RS, meta: TWO_SUM_META });
    expect(main).toContain('let a0 = lc_as_i32_vec(lc_j_at(args, 0));');
    expect(main).toContain('let a1 = lc_j_i64(lc_j_at(args, 1)) as i32;');
    expect(main).toContain('Solution::two_sum(a0, a1)');
    expect(main).toContain('lc_dump_i32_vec(&ret)');
  });

  it('用户自己写了 struct Solution 就不重复声明', () => {
    const src = `struct Solution;

impl Solution {
    pub fn two_sum(nums: Vec<i32>, target: i32) -> Vec<i32> {
        let _ = (nums, target);
        vec![]
    }
}
`;
    const { main } = gen({ sourceCode: src, meta: TWO_SUM_META });
    expect(main.split('struct Solution').length - 1).toBe(1);
  });

  it('链表/树：按 LeetCode 固定结构生成，注释里的定义不算用户已定义', () => {
    const commented = `// Definition for singly-linked list.
// #[derive(PartialEq, Eq, Clone, Debug)]
// pub struct ListNode {
//   pub val: i32,
//   pub next: Option<Box<ListNode>>
// }
impl Solution {
    pub fn reverse_list(head: Option<Box<ListNode>>) -> Option<Box<ListNode>> {
        head
    }
}
`;
    const a = gen({
      sourceCode: commented,
      meta: makeMeta('reverseList', [['head', 'ListNode']], 'ListNode'),
      cases: [[['[1,2,3]'], '[3,2,1]']],
    });
    expect(a.main).toContain('pub struct ListNode {');
    expect(a.main).toContain('pub next: Option<Box<ListNode>>,');
    expect(a.main).toContain('let a0 = lc_as_list(lc_j_at(args, 0));');
    expect(a.main).toContain('lc_dump_list(&ret)');
    // 链表不需要 Rc / RefCell
    expect(a.main).not.toContain('use std::rc::Rc;');
  });

  it('用户定义了 ListNode 就不重复生成', () => {
    const src = `pub struct ListNode {
    pub val: i32,
    pub next: Option<Box<ListNode>>,
}

impl Solution {
    pub fn reverse_list(head: Option<Box<ListNode>>) -> Option<Box<ListNode>> {
        head
    }
}
`;
    const { main } = gen({
      sourceCode: src,
      meta: makeMeta('reverseList', [['head', 'ListNode']], 'ListNode'),
      cases: [[['[1,2,3]'], '[3,2,1]']],
    });
    expect(main).not.toContain('#[derive(PartialEq, Eq, Clone, Debug)]');
  });

  it('树题目补 use Rc/RefCell，用户已有则不重复', () => {
    const treeMeta = makeMeta('invertTree', [['root', 'TreeNode']], 'TreeNode');
    const withUse = `use std::rc::Rc;
use std::cell::RefCell;
impl Solution {
    pub fn invert_tree(root: Option<Rc<RefCell<TreeNode>>>) -> Option<Rc<RefCell<TreeNode>>> {
        root
    }
}
`;
    const a = gen({ sourceCode: withUse, meta: treeMeta, cases: [[['[4,2,7]'], '[4,7,2]']] });
    expect(a.main.split('use std::rc::Rc;').length - 1).toBe(1);
    expect(a.main.split('use std::cell::RefCell;').length - 1).toBe(1);
    expect(a.main).toContain('pub left: Option<Rc<RefCell<TreeNode>>>,');
    expect(a.main).toContain('let a0 = lc_as_tree(lc_j_at(args, 0));');
    expect(a.main).toContain('lc_dump_tree(&ret)');

    const withoutUse = 'impl Solution {\n    pub fn invert_tree(root: Option<Rc<RefCell<TreeNode>>>) -> Option<Rc<RefCell<TreeNode>>> {\n        root\n    }\n}\n';
    const b = gen({ sourceCode: withoutUse, meta: treeMeta, cases: [[['[4,2,7]'], '[4,7,2]']] });
    expect(b.main).toContain('use std::rc::Rc;');
    expect(b.main).toContain('use std::cell::RefCell;');
  });

  it('void（原地修改）用 &mut 传容器并取第一个参数', () => {
    const src = `impl Solution {
    pub fn rotate(nums: &mut Vec<i32>, k: i32) {
        let _ = k;
        nums.reverse();
    }
}
`;
    const { main } = gen({
      sourceCode: src,
      meta: makeMeta('rotate', [['nums', 'integer[]'], ['k', 'integer']], 'void'),
      cases: [[['[1,2,3,4,5,6,7]', '3'], '[7,6,5,4,3,2,1]']],
    });
    expect(main).toContain('let mut a0 = lc_as_i32_vec(lc_j_at(args, 0));');
    expect(main).toContain('Solution::rotate(&mut a0, a1)');
    expect(main).toContain('lc_dump_i32_vec(&a0)');
  });

  it('入口函数不存在时走 entry_not_found 分支', () => {
    const src = 'impl Solution {\n    pub fn other(nums: Vec<i32>) -> Vec<i32> {\n        nums\n    }\n}\n';
    const { main } = gen({ sourceCode: src, meta: TWO_SUM_META });
    expect(main).toContain('const LC_ENTRY_FOUND: bool = false;');
    expect(main).toContain('entry_not_found');
    expect(main).not.toContain('Solution::two_sum');
  });

  it('&self 形态的方法也能识别', () => {
    const src = 'impl Solution {\n    pub fn two_sum(&self, nums: Vec<i32>, target: i32) -> Vec<i32> {\n        vec![]\n    }\n}\n';
    const { main } = gen({ sourceCode: src, meta: TWO_SUM_META });
    expect(main).toContain('const LC_ENTRY_FOUND: bool = true;');
    expect(main).toContain('(Solution {}).two_sum(a0, a1)');
  });
});

describe('rust 脚手架：真实运行', () => {
  it('有 rustc 时能跑通正确解法', async () => {
    if (!(await ensureRustc())) return;
    const dir = await mkdtemp(join(tmpdir(), 'lcrs-'));
    const src = join(dir, 'solution.rs');
    await writeFile(src, TWO_SUM_RS, 'utf8');
    const cases: TestCase[] = [
      { index: 0, args: ['[2,7,11,15]', '9'], expected: '[0,1]', source: 'custom' },
      { index: 1, args: ['[3,2,4]', '6'], expected: '[1,2]', source: 'custom' },
    ];
    const result = await runLocalTestsWith(RustHarness, {
      langSlug: 'rust',
      meta: TWO_SUM_META,
      testCases: cases,
      sourceFile: 'solution.rs',
      sourceAbsPath: src,
      sourceCode: TWO_SUM_RS,
      genDir: join(dir, 'local'),
      titleSlug: 'two-sum',
    });
    if (result.unsupportedReason) throw new Error(`${result.unsupportedReason}\n${result.stderr ?? ''}`);
    expect(result.cases.map((c) => c.actual)).toEqual(['[0,1]', '[1,2]']);
    expect(result.ok).toBe(true);
    expect(await readFile(src, 'utf8')).toBe(TWO_SUM_RS);
  });

  it('有 rustc 时链表 / 树 / panic 隔离也能跑', async () => {
    if (!(await ensureRustc())) return;
    const dir = await mkdtemp(join(tmpdir(), 'lcrs2-'));
    const src = join(dir, 'solution.rs');
    const code = `impl Solution {
    pub fn reverse_list(head: Option<Box<ListNode>>) -> Option<Box<ListNode>> {
        let mut prev: Option<Box<ListNode>> = None;
        let mut cur = head;
        while let Some(mut node) = cur {
            cur = node.next.take();
            node.next = prev;
            prev = Some(node);
        }
        prev
    }
}
`;
    await writeFile(src, code, 'utf8');
    const r1 = await runLocalTestsWith(RustHarness, {
      langSlug: 'rust',
      meta: makeMeta('reverseList', [['head', 'ListNode']], 'ListNode'),
      testCases: [{ index: 0, args: ['[1,2,3]'], expected: '[3,2,1]', source: 'custom' }],
      sourceFile: 'solution.rs',
      sourceAbsPath: src,
      sourceCode: code,
      genDir: join(dir, 'local'),
      titleSlug: 'reverse-linked-list',
    });
    if (r1.unsupportedReason) throw new Error(`${r1.unsupportedReason}\n${r1.stderr ?? ''}`);
    expect(r1.cases[0].actual).toBe('[3,2,1]');
  });
});
