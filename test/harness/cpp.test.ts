import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestCases, parseMetaData } from '../../src/core/parse.js';
import { findExecutable, runLocalTestsWith } from '../../src/runner/execute.js';
import { CppHarness } from '../../src/runner/harness/cpp.js';
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

/** 正确解法：故意用 LeetCode 用户惯用的 bits/stdc++.h，验证兼容头 */
const SOLUTION_CPP = `#include <bits/stdc++.h>
using namespace std;

class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int, int> seen;
        for (int i = 0; i < (int)nums.size(); ++i) {
            auto it = seen.find(target - nums[i]);
            if (it != seen.end()) return {it->second, i};
            seen[nums[i]] = i;
        }
        return {};
    }
};
`;

/** 错误解法：永远返回 [0,0] */
const BAD_CPP = `#include <vector>
using namespace std;

class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        (void)target;
        return vector<int>{0, 0};
    }
};
`;

let compilerReady: boolean | undefined;

async function hasCompiler(): Promise<boolean> {
  if (compilerReady === undefined) {
    compilerReady = (await findExecutable(['g++', 'clang++'])) !== undefined;
    if (!compilerReady) console.warn('skip: 本机没有 g++/clang++');
  }
  return compilerReady;
}

interface CppRun {
  dir: string;
  genDir: string;
  sourcePath: string;
  result: Awaited<ReturnType<typeof runLocalTestsWith>>;
}

/**
 * 在临时目录里写好 solution.cpp，再用 CppHarness 跑一遍。
 * 注意 genDir 故意与用户文件不在同一个目录：验证「绝对路径 include」这条路。
 */
async function runCpp(sourceCode: string): Promise<CppRun> {
  const dir = await mkdtemp(join(tmpdir(), 'lccpp-'));
  const genDir = join(dir, 'local');
  const sourcePath = join(dir, 'solution.cpp');
  await writeFile(sourcePath, sourceCode, 'utf8');
  await mkdir(genDir, { recursive: true });
  const meta = parseMetaData(TWO_SUM_META);
  if (!meta) throw new Error('metaData 解析失败');
  const testCases = buildTestCases({
    exampleTestcases: TWO_SUM_EXAMPLES,
    content: TWO_SUM_CONTENT,
    metaData: TWO_SUM_META,
  });
  const input: Omit<HarnessInput, 'debug'> = {
    langSlug: 'cpp',
    meta,
    testCases,
    sourceFile: 'solution.cpp',
    sourceAbsPath: sourcePath,
    sourceCode,
    genDir,
    titleSlug: 'two-sum',
  };
  const result = await runLocalTestsWith(CppHarness, input, {});
  return { dir, genDir, sourcePath, result };
}

/** 用任意 meta + 用例跑一次（覆盖更多类型） */
async function runCppCustom(
  metaJson: string,
  args: string[][],
  expected: string[],
  source: string,
): Promise<Awaited<ReturnType<typeof runLocalTestsWith>>> {
  const dir = await mkdtemp(join(tmpdir(), 'lccpp-t-'));
  const genDir = join(dir, 'local');
  const sourcePath = join(dir, 'solution.cpp');
  await writeFile(sourcePath, source, 'utf8');
  await mkdir(genDir, { recursive: true });
  const meta = parseMetaData(metaJson);
  if (!meta) throw new Error(`metaData 解析失败：${metaJson}`);
  const result = await runLocalTestsWith(
    CppHarness,
    {
      langSlug: 'cpp',
      meta,
      testCases: args.map((a, i) => ({ index: i, args: a, expected: expected[i], source: 'custom' })),
      sourceFile: 'solution.cpp',
      sourceAbsPath: sourcePath,
      sourceCode: source,
      genDir,
      titleSlug: 'custom',
    },
    {},
  );
  return result;
}

/** 断言整轮跑绿，失败时把编译/运行输出带出来 */
async function expectAllOk(run: () => Promise<Awaited<ReturnType<typeof runLocalTestsWith>>>): Promise<void> {
  const result = await run();
  if (!result.ok) {
    throw new Error(
      `用例未通过：${result.unsupportedReason ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  expect(result.cases.length).toBeGreaterThan(0);
  expect(result.cases.every((c) => c.ok === true)).toBe(true);
}

describe('cpp 脚手架：能力声明', () => {
  it('拒绝设计类题目', () => {
    const support = CppHarness.supports({
      name: 'LRUCache',
      params: [{ name: 'capacity', type: 'integer' }],
      return: { type: 'void' },
      construct: true,
      classname: 'LRUCache',
    });
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain('设计类题目');
  });

  it('拒绝不认识的类型', () => {
    const support = CppHarness.supports({
      name: 'foo',
      params: [{ name: 'a', type: 'SomeWeirdType' }],
      return: { type: 'integer' },
    });
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toBe('暂不支持的类型：SomeWeirdType');
  });

  it('接受常见题型', () => {
    const support = CppHarness.supports({
      name: 'solve',
      params: [
        { name: 'a', type: 'ListNode' },
        { name: 'b', type: 'character[][]' },
        { name: 'c', type: 'string[]' },
        { name: 'd', type: 'double' },
      ],
      return: { type: 'TreeNode' },
    });
    expect(support.ok).toBe(true);
  });
});

describe('cpp 脚手架：真实编译运行', () => {
  it('two-sum 正确解法 3 个用例全过（含 bits/stdc++.h 兼容头）', async () => {
    if (!(await hasCompiler())) return;
    const { result } = await runCpp(SOLUTION_CPP);
    if (!result.ok) {
      throw new Error(`用例未通过：${result.unsupportedReason ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    }
    expect(result.cases).toHaveLength(3);
    expect(result.cases.map((c) => c.ok)).toEqual([true, true, true]);
    expect(result.cases.map((c) => c.actual.replace(/\s+/g, ''))).toEqual(['[0,1]', '[1,2]', '[0,1]']);
    expect(result.ok).toBe(true);
  });

  it('错误解法会被判错', async () => {
    if (!(await hasCompiler())) return;
    const { result } = await runCpp(BAD_CPP);
    expect(result.ok).toBe(false);
    expect(result.cases).toHaveLength(3);
    expect(result.cases[0].ok).toBe(false);
    expect(result.cases[0].actual.replace(/\s+/g, '')).toBe('[0,0]');
  });

  it('不修改用户代码文件，生成物只落在 genDir', async () => {
    if (!(await hasCompiler())) return;
    const { genDir, sourcePath } = await runCpp(SOLUTION_CPP);
    const after = await readFile(sourcePath, 'utf8');
    expect(after).toBe(SOLUTION_CPP);
    const art = CppHarness.generate({
      langSlug: 'cpp',
      meta: parseMetaData(TWO_SUM_META)!,
      testCases: buildTestCases({
        exampleTestcases: TWO_SUM_EXAMPLES,
        content: TWO_SUM_CONTENT,
        metaData: TWO_SUM_META,
      }),
      sourceFile: 'solution.cpp',
      sourceAbsPath: sourcePath,
      sourceCode: SOLUTION_CPP,
      genDir,
      titleSlug: 'two-sum',
    });
    for (const f of art.files) {
      const content = await readFile(join(genDir, f.name), 'utf8');
      expect(content).toBe(f.content);
    }
    // 编译步骤必须致命、运行步骤不致命
    expect(art.steps[0].label).toBe('compile');
    expect(art.steps[0].fatal).toBe(true);
    expect(art.steps[1].label).toBe('run');
    expect(art.steps[1].fatal).toBe(false);
    expect(art.debugEntry).toBe('_lc_main.cpp');
  });

  it('每个用例互相隔离：单例抛异常不影响其它用例', async () => {
    if (!(await hasCompiler())) return;
    const src = `class Solution {
public:
    int boom(int x) {
        if (x == 2) throw std::runtime_error("故意抛异常");
        return x * 2;
    }
};
`;
    const result = await runCppCustom(
      JSON.stringify({ name: 'boom', params: [{ name: 'x', type: 'integer' }], return: { type: 'integer' } }),
      [['1'], ['2'], ['3']],
      ['2', '4', '6'],
      src,
    );
    expect(result.cases).toHaveLength(3);
    expect(result.cases[0].ok).toBe(true);
    expect(result.cases[1].ok).toBe(false);
    expect(result.cases[1].error ?? '').toContain('故意抛异常');
    expect(result.cases[2].ok).toBe(true);
    expect(result.cases[2].actual).toBe('6');
  });
});

describe('cpp 脚手架：类型覆盖', () => {
  it('链表与二叉树', async () => {
    if (!(await hasCompiler())) return;
    const listSrc = `class Solution {
public:
    ListNode* swapPairs(ListNode* head) {
        ListNode dummy;
        ListNode* tail = &dummy;
        while (head && head->next) {
            ListNode* a = head;
            ListNode* b = head->next;
            head = b->next;
            tail->next = b;
            b->next = a;
            tail = a;
            tail->next = nullptr;
        }
        if (head) tail->next = head;
        return dummy.next;
    }
};
`;
    await expectAllOk(() =>
      runCppCustom(
        JSON.stringify({ name: 'swapPairs', params: [{ name: 'head', type: 'ListNode' }], return: { type: 'ListNode' } }),
        [['[1,2,3,4]'], ['[]'], ['[1]']],
        ['[2,1,4,3]', '[]', '[1]'],
        listSrc,
      ),
    );

    const treeSrc = `class Solution {
public:
    TreeNode* invertTree(TreeNode* root) {
        if (!root) return nullptr;
        TreeNode* l = invertTree(root->left);
        TreeNode* r = invertTree(root->right);
        root->left = r;
        root->right = l;
        return root;
    }
};
`;
    await expectAllOk(() =>
      runCppCustom(
        JSON.stringify({
          name: 'invertTree',
          params: [{ name: 'root', type: 'TreeNode' }],
          return: { type: 'TreeNode' },
        }),
        [['[4,2,7,1,3,6,9]'], ['[]']],
        ['[4,7,2,9,6,3,1]', '[]'],
        treeSrc,
      ),
    );
  });

  it('原地修改（void）、二维数组、字符串与 bool', async () => {
    if (!(await hasCompiler())) return;
    const inPlaceSrc = `#include <bits/stdc++.h>
using namespace std;

class Solution {
public:
    void reverseString(vector<char>& s) {
        reverse(s.begin(), s.end());
    }
};
`;
    const inPlace = await runCppCustom(
      JSON.stringify({
        name: 'reverseString',
        params: [{ name: 's', type: 'character[]' }],
        return: { type: 'void' },
      }),
      [['["h","e","l","l","o"]']],
      ['["o","l","l","e","h"]'],
      inPlaceSrc,
    );
    expect(inPlace.ok).toBe(true);
    expect(inPlace.cases[0].actual.replace(/\s+/g, '')).toBe('["o","l","l","e","h"]');

    const matrixSrc = `#include <bits/stdc++.h>
using namespace std;

class Solution {
public:
    vector<vector<int>> merge(vector<vector<int>>& intervals) {
        sort(intervals.begin(), intervals.end());
        vector<vector<int>> out;
        for (auto& t : intervals) {
            if (!out.empty() && t[0] <= out.back()[1]) out.back()[1] = max(out.back()[1], t[1]);
            else out.push_back(t);
        }
        return out;
    }
};
`;
    await expectAllOk(() =>
      runCppCustom(
        JSON.stringify({
          name: 'merge',
          params: [{ name: 'intervals', type: 'integer[][]' }],
          return: { type: 'integer[][]' },
        }),
        [['[[1,3],[2,6],[8,10],[15,18]]'], ['[[1,4],[4,5]]']],
        ['[[1,6],[8,10],[15,18]]', '[[1,5]]'],
        matrixSrc,
      ),
    );

    const strSrc = `#include <string>
#include <vector>

class Solution {
public:
    bool isPalindrome(std::string s) {
        int i = 0;
        int j = (int)s.size() - 1;
        while (i < j) {
            if (s[i] != s[j]) return false;
            ++i;
            --j;
        }
        return true;
    }
    std::string join(std::vector<std::string>& parts) {
        std::string out;
        for (auto& p : parts) out += p;
        return out;
    }
};
`;
    const palin = await runCppCustom(
      JSON.stringify({ name: 'isPalindrome', params: [{ name: 's', type: 'string' }], return: { type: 'boolean' } }),
      [['"aba"'], ['"ab"']],
      ['true', 'false'],
      strSrc,
    );
    expect(palin.ok).toBe(true);
    expect(palin.cases.map((c) => c.actual)).toEqual(['true', 'false']);

    await expectAllOk(() =>
      runCppCustom(
        JSON.stringify({
          name: 'join',
          params: [{ name: 'parts', type: 'string[]' }],
          return: { type: 'string' },
        }),
        [['["a","b","c"]']],
        ['"abc"'],
        strSrc,
      ),
    );
  });
});
