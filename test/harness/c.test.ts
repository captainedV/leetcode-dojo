import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestCases, parseMetaData } from '../../src/core/parse.js';
import { findExecutable, runLocalTestsWith } from '../../src/runner/execute.js';
import { CHarness } from '../../src/runner/harness/c.js';
import type { HarnessInput } from '../../src/runner/harness/types.js';

/** two-sum 的官方用例输入：每行一个参数 */
const TWO_SUM_EXAMPLES = '[2,7,11,15]\n9\n[3,2,4]\n6\n[3,3]\n6';

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
<pre>
<strong>Input:</strong> nums = [2,7,11,15], target = 9
<strong>Output:</strong> [0,1]
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

/** 正确解法：LeetCode C 约定——数组参数成对出现，返回数组靠 returnSize 出参 */
const SOLUTION_C = `
int* twoSum(int* nums, int numsSize, int target, int* returnSize) {
    int* res = (int*)malloc(sizeof(int) * 2);
    for (int i = 0; i < numsSize; i++) {
        for (int j = i + 1; j < numsSize; j++) {
            if (nums[i] + nums[j] == target) {
                res[0] = i;
                res[1] = j;
                *returnSize = 2;
                return res;
            }
        }
    }
    *returnSize = 0;
    return res;
}
`;

/** 错误解法：永远返回 [0,0] */
const BAD_C = `
int* twoSum(int* nums, int numsSize, int target, int* returnSize) {
    (void)nums;
    (void)numsSize;
    (void)target;
    int* res = (int*)malloc(sizeof(int) * 2);
    res[0] = 0;
    res[1] = 0;
    *returnSize = 2;
    return res;
}
`;

let compilerReady: boolean | undefined;

async function hasCompiler(): Promise<boolean> {
  if (compilerReady === undefined) {
    compilerReady = (await findExecutable(['gcc', 'clang'])) !== undefined;
    if (!compilerReady) console.warn('skip: 本机没有 gcc/clang');
  }
  return compilerReady;
}

/**
 * 在临时目录里写好 solution.c，再用 CHarness 跑一遍。
 * genDir 故意与用户文件不同目录：验证「绝对路径 include」这条路。
 */
async function runC(sourceCode: string): Promise<{ genDir: string; sourcePath: string; result: Awaited<ReturnType<typeof runLocalTestsWith>> }> {
  const dir = await mkdtemp(join(tmpdir(), 'lcc-'));
  const genDir = join(dir, 'local');
  const sourcePath = join(dir, 'solution.c');
  await writeFile(sourcePath, sourceCode, 'utf8');
  await mkdir(genDir, { recursive: true });
  const meta = parseMetaData(TWO_SUM_META);
  if (!meta) throw new Error('metaData 解析失败');
  const input: Omit<HarnessInput, 'debug'> = {
    langSlug: 'c',
    meta,
    testCases: buildTestCases({
      exampleTestcases: TWO_SUM_EXAMPLES,
      content: TWO_SUM_CONTENT,
      metaData: TWO_SUM_META,
    }),
    sourceFile: 'solution.c',
    sourceAbsPath: sourcePath,
    sourceCode,
    genDir,
    titleSlug: 'two-sum',
  };
  const result = await runLocalTestsWith(CHarness, input, {});
  return { genDir, sourcePath, result };
}

/** 用任意 meta + 用例跑一次（覆盖更多类型） */
async function runCCustom(
  metaJson: string,
  args: string[][],
  expected: string[],
  source: string,
): Promise<Awaited<ReturnType<typeof runLocalTestsWith>>> {
  const dir = await mkdtemp(join(tmpdir(), 'lcc-t-'));
  const genDir = join(dir, 'local');
  const sourcePath = join(dir, 'solution.c');
  await writeFile(sourcePath, source, 'utf8');
  await mkdir(genDir, { recursive: true });
  const meta = parseMetaData(metaJson);
  if (!meta) throw new Error(`metaData 解析失败：${metaJson}`);
  return runLocalTestsWith(
    CHarness,
    {
      langSlug: 'c',
      meta,
      testCases: args.map((a, i) => ({ index: i, args: a, expected: expected[i], source: 'custom' })),
      sourceFile: 'solution.c',
      sourceAbsPath: sourcePath,
      sourceCode: source,
      genDir,
      titleSlug: 'custom',
    },
    {},
  );
}

function assertOk(result: Awaited<ReturnType<typeof runLocalTestsWith>>): void {
  if (!result.ok) {
    throw new Error(
      `用例未通过：${result.unsupportedReason ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
}

describe('c 脚手架：能力声明', () => {
  it('拒绝设计类题目', () => {
    const support = CHarness.supports({
      name: 'LRUCache',
      params: [{ name: 'capacity', type: 'integer' }],
      return: { type: 'void' },
      construct: true,
      classname: 'LRUCache',
    });
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain('设计类题目');
  });

  it('如实拒绝 C 无法静态承接的类型', () => {
    for (const type of ['SomeWeirdType', 'ListNode[]', 'TreeNode[]', 'string[][]', 'array']) {
      const support = CHarness.supports({
        name: 'foo',
        params: [{ name: 'a', type }],
        return: { type: 'integer' },
      });
      expect(support.ok).toBe(false);
      if (!support.ok) expect(support.reason).toBe(`暂不支持的类型：${type}`);
    }
  });

  it('接受常见 C 题型', () => {
    const support = CHarness.supports({
      name: 'solve',
      params: [
        { name: 'a', type: 'ListNode' },
        { name: 'b', type: 'character[][]' },
        { name: 'c', type: 'string[]' },
        { name: 'd', type: 'double[]' },
      ],
      return: { type: 'TreeNode' },
    });
    expect(support.ok).toBe(true);
  });
});

describe('c 脚手架：真实编译运行', () => {
  it('two-sum 正确解法 3 个用例全过', async () => {
    if (!(await hasCompiler())) return;
    const { result } = await runC(SOLUTION_C);
    assertOk(result);
    expect(result.cases).toHaveLength(3);
    expect(result.cases.map((c) => c.ok)).toEqual([true, true, true]);
    expect(result.cases.map((c) => c.actual.replace(/\s+/g, ''))).toEqual(['[0,1]', '[1,2]', '[0,1]']);
  });

  it('错误解法会被判错', async () => {
    if (!(await hasCompiler())) return;
    const { result } = await runC(BAD_C);
    expect(result.ok).toBe(false);
    expect(result.cases).toHaveLength(3);
    expect(result.cases[0].ok).toBe(false);
    expect(result.cases[0].actual.replace(/\s+/g, '')).toBe('[0,0]');
  });

  it('不修改用户代码文件，生成物只落在 genDir', async () => {
    if (!(await hasCompiler())) return;
    const { genDir, sourcePath } = await runC(SOLUTION_C);
    const after = await readFile(sourcePath, 'utf8');
    expect(after).toBe(SOLUTION_C);
    const art = CHarness.generate({
      langSlug: 'c',
      meta: parseMetaData(TWO_SUM_META)!,
      testCases: buildTestCases({
        exampleTestcases: TWO_SUM_EXAMPLES,
        content: TWO_SUM_CONTENT,
        metaData: TWO_SUM_META,
      }),
      sourceFile: 'solution.c',
      sourceAbsPath: sourcePath,
      sourceCode: SOLUTION_C,
      genDir,
      titleSlug: 'two-sum',
    });
    for (const f of art.files) {
      const content = await readFile(join(genDir, f.name), 'utf8');
      expect(content).toBe(f.content);
    }
    expect(art.steps[0].label).toBe('compile');
    expect(art.steps[0].fatal).toBe(true);
    expect(art.steps[1].label).toBe('run');
    expect(art.steps[1].fatal).toBe(false);
    expect(art.debugEntry).toBe('_lc_main.c');
  });
});

describe('c 脚手架：类型覆盖', () => {
  it('原地修改（void）与 bool / string', async () => {
    if (!(await hasCompiler())) return;
    const inPlace = await runCCustom(
      JSON.stringify({
        name: 'reverseString',
        params: [{ name: 's', type: 'character[]' }],
        return: { type: 'void' },
      }),
      [['["h","e","l","l","o"]']],
      ['["o","l","l","e","h"]'],
      `void reverseString(char* s, int sSize) {
    for (int i = 0, j = sSize - 1; i < j; i++, j--) {
        char t = s[i];
        s[i] = s[j];
        s[j] = t;
    }
}
`,
    );
    assertOk(inPlace);
    expect(inPlace.cases[0].actual.replace(/\s+/g, '')).toBe('["o","l","l","e","h"]');

    const boolRun = await runCCustom(
      JSON.stringify({ name: 'isValid', params: [{ name: 's', type: 'string' }], return: { type: 'boolean' } }),
      [['"()[]{}"'], ['"(]"']],
      ['true', 'false'],
      `bool isValid(char* s) {
    char stack[10000];
    int top = 0;
    for (int i = 0; s[i]; i++) {
        char c = s[i];
        if (c == '(') stack[top++] = ')';
        else if (c == '[') stack[top++] = ']';
        else if (c == '{') stack[top++] = '}';
        else if (top == 0 || stack[--top] != c) return false;
    }
    return top == 0;
}
`,
    );
    assertOk(boolRun);
    expect(boolRun.cases.map((c) => c.actual)).toEqual(['true', 'false']);
  });

  it('链表与二叉树', async () => {
    if (!(await hasCompiler())) return;
    const listRun = await runCCustom(
      JSON.stringify({ name: 'reverseList', params: [{ name: 'head', type: 'ListNode' }], return: { type: 'ListNode' } }),
      [['[1,2,3,4,5]'], ['[]']],
      ['[5,4,3,2,1]', '[]'],
      `struct ListNode* reverseList(struct ListNode* head) {
    struct ListNode* prev = NULL;
    while (head) {
        struct ListNode* next = head->next;
        head->next = prev;
        prev = head;
        head = next;
    }
    return prev;
}
`,
    );
    assertOk(listRun);
    expect(listRun.cases.map((c) => c.actual.replace(/\s+/g, ''))).toEqual(['[5,4,3,2,1]', '[]']);

    const treeRun = await runCCustom(
      JSON.stringify({ name: 'invertTree', params: [{ name: 'root', type: 'TreeNode' }], return: { type: 'TreeNode' } }),
      [['[4,2,7,1,3,6,9]'], ['[]']],
      ['[4,7,2,9,6,3,1]', '[]'],
      `struct TreeNode* invertTree(struct TreeNode* root) {
    if (!root) return NULL;
    struct TreeNode* left = invertTree(root->left);
    struct TreeNode* right = invertTree(root->right);
    root->left = right;
    root->right = left;
    return root;
}
`,
    );
    assertOk(treeRun);
    expect(treeRun.cases.map((c) => c.actual.replace(/\s+/g, ''))).toEqual(['[4,7,2,9,6,3,1]', '[]']);
  });

  it('二维数组（返回带 returnColumnSizes）', async () => {
    if (!(await hasCompiler())) return;
    const result = await runCCustom(
      JSON.stringify({
        name: 'merge',
        params: [{ name: 'intervals', type: 'integer[][]' }],
        return: { type: 'integer[][]' },
      }),
      [['[[1,3],[2,6],[8,10],[15,18]]'], ['[[1,4],[4,5]]']],
      ['[[1,6],[8,10],[15,18]]', '[[1,5]]'],
      `static int cmp(const void* a, const void* b) {
    return (*(int**)a)[0] - (*(int**)b)[0];
}

int** merge(int** intervals, int intervalsSize, int* intervalsColSize, int* returnSize, int** returnColumnSizes) {
    (void)intervalsColSize;
    int** out = (int**)malloc(sizeof(int*) * (intervalsSize ? intervalsSize : 1));
    int* cols = (int*)malloc(sizeof(int) * (intervalsSize ? intervalsSize : 1));
    int n = 0;
    qsort(intervals, intervalsSize, sizeof(int*), cmp);
    for (int i = 0; i < intervalsSize; i++) {
        if (n > 0 && intervals[i][0] <= out[n - 1][1]) {
            if (intervals[i][1] > out[n - 1][1]) out[n - 1][1] = intervals[i][1];
        } else {
            out[n] = (int*)malloc(sizeof(int) * 2);
            out[n][0] = intervals[i][0];
            out[n][1] = intervals[i][1];
            cols[n] = 2;
            n++;
        }
    }
    *returnSize = n;
    *returnColumnSizes = cols;
    return out;
}
`,
    );
    assertOk(result);
    expect(result.cases.map((c) => c.actual.replace(/\s+/g, ''))).toEqual([
      '[[1,6],[8,10],[15,18]]',
      '[[1,5]]',
    ]);
  });
});
