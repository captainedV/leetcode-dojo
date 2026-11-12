import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LcMetaData, TestCase } from '../../src/core/types.js';
import { RubyHarness } from '../../src/runner/harness/ruby.js';
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

interface RunOutcome {
  ok: boolean;
  cases: Array<{ ok: boolean | null; actual: string; error?: string | null }>;
  unsupportedReason?: string;
  stderr?: string;
  stdin?: string;
  sourceOnDisk: string;
}

async function runRuby(
  source: string,
  meta: LcMetaData,
  cases: Array<[string[], string | null]>,
): Promise<RunOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'lcruby-'));
  const src = join(dir, 'solution.rb');
  await writeFile(src, source, 'utf8');
  const testCases: TestCase[] = cases.map(([args, expected], i) => ({
    index: i,
    args,
    expected,
    source: 'custom',
  }));
  const result = await runLocalTestsWith(RubyHarness, {
    langSlug: 'ruby',
    meta,
    testCases,
    sourceFile: 'solution.rb',
    sourceAbsPath: src,
    sourceCode: source,
    genDir: join(dir, 'local'),
    titleSlug: 'demo',
  });
  return {
    ok: result.ok,
    cases: result.cases.map((c) => ({ ok: c.ok, actual: c.actual, error: c.error })),
    unsupportedReason: result.unsupportedReason,
    stderr: result.stderr,
    sourceOnDisk: await readFile(src, 'utf8'),
  };
}

let rubyAvailable: boolean | undefined;

/** ruby 缺失时跳过；本机 ruby 2.6.10 可用，所以这些用例都会真跑。 */
async function ensureRuby(): Promise<boolean> {
  if (rubyAvailable === undefined) rubyAvailable = Boolean(await findExecutable(['ruby']));
  if (!rubyAvailable) console.warn('skip: ruby 不可用');
  return rubyAvailable;
}

describe('ruby 脚手架：support 判定', () => {
  it('slug / 调试入口 / 安装提示', () => {
    expect(RubyHarness.slug).toBe('ruby');
    expect(RubyHarness.installHint).toContain('ruby');
  });

  it('设计类题目不支持', () => {
    const r = RubyHarness.supports(makeMeta('LRUCache', [['capacity', 'integer']], 'integer', { construct: true }));
    expect(r).toEqual({ ok: false, reason: '设计类题目（多步操作）暂不支持本地脚手架' });
  });

  it('未知类型给出可读原因', () => {
    const r = RubyHarness.supports(makeMeta('f', [['x', 'someWeirdType']], 'integer'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('暂不支持的类型：someWeirdType');
  });

  it('Node / graph 类型明确拒绝', () => {
    const r1 = RubyHarness.supports(makeMeta('f', [['x', 'Node']], 'integer'));
    const r2 = RubyHarness.supports(makeMeta('f', [['x', 'graph']], 'integer'));
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it('常见类型全部支持', () => {
    const supported = [
      ['int', 'integer'],
      ['long', 'long'],
      ['double', 'double'],
      ['bool', 'boolean'],
      ['str', 'string'],
      ['ch', 'character'],
      ['ints', 'integer[]'],
      ['longs', 'long[]'],
      ['doubles', 'double[]'],
      ['bools', 'boolean[]'],
      ['strs', 'string[]'],
      ['chars', 'character[]'],
      ['chars2', 'character[][]'],
      ['m', 'integer[][]'],
      ['sm', 'string[][]'],
      ['l', 'ListNode'],
      ['ls', 'ListNode[]'],
      ['t', 'TreeNode'],
      ['ts', 'TreeNode[]'],
      ['j', 'json'],
    ] as Array<[string, string]>;
    const r = RubyHarness.supports(makeMeta('f', supported, 'void'));
    expect(r.ok).toBe(true);
  });
});

describe('ruby 脚手架：生成物', () => {
  it('生成 _lc_cases.json 与 _lc_main.rb，steps 用 ruby 运行入口', () => {
    const src = 'def two_sum(nums, target)\n  []\nend\n';
    const artifact = RubyHarness.generate({
      langSlug: 'ruby',
      meta: makeMeta('twoSum', [['nums', 'integer[]'], ['target', 'integer']], 'integer[]'),
      testCases: [{ index: 0, args: ['[2,7]', '9'], expected: '[0,1]', source: 'custom' }],
      sourceFile: 'solution.rb',
      sourceAbsPath: '/tmp/solution.rb',
      sourceCode: src,
      genDir: '/tmp/local',
      titleSlug: 'two-sum',
    });
    expect(artifact.files.map((f) => f.name)).toEqual(['_lc_cases.json', '_lc_main.rb']);
    expect(artifact.debugEntry).toBe('_lc_main.rb');
    expect(artifact.debugType).toBe('rdbg');
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0].cmd).toBe('ruby');
    expect(artifact.steps[0].args).toEqual(['_lc_main.rb', '/tmp/solution.rb']);
    const main = artifact.files.find((f) => f.name === '_lc_main.rb')!.content;
    expect(main).toContain('LC_ENTRY_NAMES = [\'two_sum\', \'twoSum\'].freeze');
    expect(main).toContain('__LC_RESULT__');
    expect(main).toContain('__LC_ERROR__');
    expect(main).toContain('__LC_DONE__');
    const cases = artifact.files.find((f) => f.name === '_lc_cases.json')!.content;
    expect(JSON.parse(cases).cases[0].args).toEqual(['[2,7]', '9']);
  });
});

describe('ruby 脚手架：真实运行', () => {
  it('顶层方法 def two_sum 跑通（不修改用户源文件）', async () => {
    if (!(await ensureRuby())) return;
    const src = `def two_sum(nums, target)
  seen = {}
  nums.each_with_index do |v, i|
    return [seen[target - v], i] if seen.key?(target - v)
    seen[v] = i
  end
  []
end
`;
    const out = await runRuby(
      src,
      makeMeta('twoSum', [['nums', 'integer[]'], ['target', 'integer']], 'integer[]'),
      [
        [['[2,7,11,15]', '9'], '[0,1]'],
        [['[3,2,4]', '6'], '[1,2]'],
        [['[3,3]', '6'], '[0,1]'],
      ],
    );
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases.map((c) => c.actual)).toEqual(['[0,1]', '[1,2]', '[0,1]']);
    expect(out.cases.map((c) => c.ok)).toEqual([true, true, true]);
    expect(out.ok).toBe(true);
    expect(out.sourceOnDisk).toBe(src);
  });

  it('错误解法判错', async () => {
    if (!(await ensureRuby())) return;
    const src = 'def two_sum(nums, target)\n  [0, 0]\nend\n';
    const out = await runRuby(
      src,
      makeMeta('twoSum', [['nums', 'integer[]'], ['target', 'integer']], 'integer[]'),
      [[['[2,7,11,15]', '9'], '[0,1]']],
    );
    expect(out.ok).toBe(false);
    expect(out.cases[0].actual).toBe('[0,0]');
    expect(out.cases[0].ok).toBe(false);
  });

  it('class Solution 形态 + string/boolean', async () => {
    if (!(await ensureRuby())) return;
    const src = `class Solution
  def is_palindrome(s)
    t = s.downcase.gsub(/[^a-z0-9]/, '')
    t == t.reverse
  end
end
`;
    const out = await runRuby(src, makeMeta('isPalindrome', [['s', 'string']], 'boolean'), [
      [['"A man, a plan, a canal: Panama"'], 'true'],
      [['"abc"'], 'false'],
    ]);
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases.map((c) => c.actual)).toEqual(['true', 'false']);
    expect(out.cases.map((c) => c.ok)).toEqual([true, true]);
  });

  it('double / char / long[] 序列化', async () => {
    if (!(await ensureRuby())) return;
    const src = `def average(nums)
  return 0.0 if nums.empty?
  nums.sum.to_f / nums.size
end

def first_char(s)
  s[0]
end

def sum_longs(xs)
  xs.sum
end
`;
    const m1 = makeMeta('average', [['nums', 'integer[]']], 'double');
    const r1 = await runRuby(src, m1, [[['[1,2,3]'], '2.0'], [['[3,4]'], '3.5']]);
    if (r1.unsupportedReason) throw new Error(r1.unsupportedReason);
    expect(r1.cases.map((c) => c.ok)).toEqual([true, true]);

    const r2 = await runRuby(src, makeMeta('firstChar', [['s', 'string']], 'character'), [
      [['"leetcode"'], 'l'],
    ]);
    expect(r2.cases[0].actual).toBe('l');
    expect(r2.cases[0].ok).toBe(true);

    const r3 = await runRuby(src, makeMeta('sumLongs', [['xs', 'long[]']], 'long'), [
      [['[1,2,3]'], '6'],
    ]);
    expect(r3.cases[0].actual).toBe('6');
  });

  it('ListNode 参数与返回值', async () => {
    if (!(await ensureRuby())) return;
    const src = `def reverse_list(head)
  prev = nil
  cur = head
  while cur
    nxt = cur.next
    cur.next = prev
    prev = cur
    cur = nxt
  end
  prev
end
`;
    const out = await runRuby(src, makeMeta('reverseList', [['head', 'ListNode']], 'ListNode'), [
      [['[1,2,3,4,5]'], '[5,4,3,2,1]'],
      [['[]'], '[]'],
    ]);
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases.map((c) => c.actual)).toEqual(['[5,4,3,2,1]', '[]']);
    expect(out.cases.map((c) => c.ok)).toEqual([true, true]);
  });

  it('TreeNode 参数与返回值（层序末尾去 null）', async () => {
    if (!(await ensureRuby())) return;
    const src = `def invert_tree(root)
  return nil if root.nil?
  left = invert_tree(root.left)
  right = invert_tree(root.right)
  root.left = right
  root.right = left
  root
end
`;
    const out = await runRuby(src, makeMeta('invertTree', [['root', 'TreeNode']], 'TreeNode'), [
      [['[4,2,7,1,3,6,9]'], '[4,7,2,9,6,3,1]'],
      [['[]'], '[]'],
    ]);
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases.map((c) => c.actual)).toEqual(['[4,7,2,9,6,3,1]', '[]']);
    expect(out.cases.map((c) => c.ok)).toEqual([true, true]);
  });

  it('ListNode[] 参数', async () => {
    if (!(await ensureRuby())) return;
    const src = `def merge_k_lists(lists)
  vals = []
  lists.each do |h|
    cur = h
    while cur
      vals << cur.val
      cur = cur.next
    end
  end
  head = nil
  tail = nil
  vals.sort.each do |v|
    node = ListNode.new(v)
    if head.nil?
      head = node
      tail = node
    else
      tail.next = node
      tail = node
    end
  end
  head
end
`;
    const out = await runRuby(src, makeMeta('mergeKLists', [['lists', 'ListNode[]']], 'ListNode'), [
      [['[[1,4,5],[1,3,4],[2,6]]'], '[1,1,2,3,4,4,5,6]'],
      [['[]'], '[]'],
    ]);
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases.map((c) => c.actual)).toEqual(['[1,1,2,3,4,4,5,6]', '[]']);
    expect(out.cases.map((c) => c.ok)).toEqual([true, true]);
  });

  it('ListNode[] 返回值', async () => {
    if (!(await ensureRuby())) return;
    const src = `def split_half(head)
  return [] if head.nil?
  slow = head
  fast = head
  prev = nil
  while fast && fast.next
    prev = slow
    slow = slow.next
    fast = fast.next.next
  end
  prev.next = nil if prev
  [head, slow]
end
`;
    const out = await runRuby(src, makeMeta('splitHalf', [['head', 'ListNode']], 'ListNode[]'), [
      [['[1,2,3,4]'], '[[1,2],[3,4]]'],
    ]);
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases[0].actual).toBe('[[1,2],[3,4]]');
    expect(out.cases[0].ok).toBe(true);
  });

  it('TreeNode[] 参数 → 二阶数组返回值', async () => {
    if (!(await ensureRuby())) return;
    const src = `def inorder_all(trees)
  trees.map do |root|
    res = []
    stack = []
    cur = root
    while cur || !stack.empty?
      while cur
        stack.push(cur)
        cur = cur.left
      end
      cur = stack.pop
      res << cur.val
      cur = cur.right
    end
    res
  end
end
`;
    const out = await runRuby(src, makeMeta('inorderAll', [['trees', 'TreeNode[]']], 'integer[][]'), [
      [['[[1,null,2,3],[4,5,6]]'], '[[1,3,2],[5,4,6]]'],
    ]);
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases[0].actual).toBe('[[1,3,2],[5,4,6]]');
    expect(out.cases[0].ok).toBe(true);
  });

  it('三阶数组：int[][] / char[][] / string[][]', async () => {
    if (!(await ensureRuby())) return;
    const src = `def rotate_matrix(m)
  m.transpose.map(&:reverse)
end

def upper_grid(grid)
  grid.map { |row| row.map { |c| c.upcase } }
end

def cells(grid)
  grid.map { |r| r.size }.sum
end
`;
    const r1 = await runRuby(src, makeMeta('rotateMatrix', [['m', 'integer[][]']], 'integer[][]'), [
      [['[[1,2,3],[4,5,6],[7,8,9]]'], '[[7,4,1],[8,5,2],[9,6,3]]'],
    ]);
    if (r1.unsupportedReason) throw new Error(r1.unsupportedReason);
    expect(r1.cases[0].actual).toBe('[[7,4,1],[8,5,2],[9,6,3]]');

    const r2 = await runRuby(src, makeMeta('upperGrid', [['grid', 'character[][]']], 'character[][]'), [
      [['[["a","b"],["c","d"]]'], '[["A","B"],["C","D"]]'],
    ]);
    expect(r2.cases[0].actual).toBe('[["A","B"],["C","D"]]');
    expect(r2.cases[0].ok).toBe(true);

    const r3 = await runRuby(src, makeMeta('cells', [['grid', 'string[][]']], 'integer'), [
      [['[["a","b"],["c"]]'], '3'],
    ]);
    expect(r3.cases[0].actual).toBe('3');
    expect(r3.cases[0].ok).toBe(true);
  });

  it('void（原地修改）取第一个参数作答案', async () => {
    if (!(await ensureRuby())) return;
    const src = `def rotate(nums, k)
  n = nums.size
  return if n.zero?
  k %= n
  cut = (n - k) % n
  nums.replace(nums[cut, n] + nums[0, cut])
end
`;
    const out = await runRuby(src, makeMeta('rotate', [['nums', 'integer[]'], ['k', 'integer']], 'void'), [
      [['[1,2,3,4,5,6,7]', '3'], '[5,6,7,1,2,3,4]'],
      [['[-1,-100,3,99]', '2'], '[3,99,-1,-100]'],
    ]);
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases.map((c) => c.actual)).toEqual(['[5,6,7,1,2,3,4]', '[3,99,-1,-100]']);
    expect(out.cases.map((c) => c.ok)).toEqual([true, true]);
  });

  it('json 类型原样往返', async () => {
    if (!(await ensureRuby())) return;
    const src = `def echo_json(value)
  value
end
`;
    const out = await runRuby(src, makeMeta('echoJson', [['value', 'json']], 'json'), [
      [['{"a":[1,2],"b":"c"}'], '{"a":[1,2],"b":"c"}'],
      [['[1,[2,3],{"k":true}]'], '[1,[2,3],{"k":true}]'],
    ]);
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases.map((c) => c.ok)).toEqual([true, true]);
  });

  it('异常只影响单个用例，后续用例继续执行', async () => {
    if (!(await ensureRuby())) return;
    const src = `def divide(a, b)
  raise ArgumentError, 'divide by zero' if b.zero?
  a / b
end
`;
    const out = await runRuby(src, makeMeta('divide', [['a', 'integer'], ['b', 'integer']], 'integer'), [
      [['1', '0'], null],
      [['6', '3'], '2'],
    ]);
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases[0].ok).toBe(false);
    expect(String(out.cases[0].error)).toContain('divide by zero');
    expect(out.cases[1].actual).toBe('2');
    expect(out.cases[1].ok).toBe(true);
    expect(out.ok).toBe(false);
  });

  it('找不到入口方法时报 entry_not_found', async () => {
    if (!(await ensureRuby())) return;
    const src = 'def something_else(a)\n  a\nend\n';
    const out = await runRuby(src, makeMeta('twoSum', [['nums', 'integer[]'], ['target', 'integer']], 'integer[]'), [
      [['[1,2]', '3'], '[0,1]'],
    ]);
    expect(out.ok).toBe(false);
    expect(String(out.cases[0].error)).toContain('entry_not_found');
  });

  it('用户代码里的 puts 被隔离，不污染协议输出', async () => {
    if (!(await ensureRuby())) return;
    const src = `def noisy(nums, target)
  puts 'debug noise'
  [0, 1]
end
`;
    const out = await runRuby(src, makeMeta('noisy', [['nums', 'integer[]'], ['target', 'integer']], 'integer[]'), [
      [['[1,2]', '3'], '[0,1]'],
    ]);
    if (out.unsupportedReason) throw new Error(out.unsupportedReason);
    expect(out.cases[0].actual).toBe('[0,1]');
    expect(out.cases[0].ok).toBe(true);
  });
});
