import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JavaHarness } from '../../src/runner/harness/java.js';
import { CASES_FILE } from '../../src/runner/harness/types.js';
import { findExecutable, runLocalTestsWith } from '../../src/runner/execute.js';
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

const TWO_SUM_META = mkMeta('twoSum', ['integer[]', 'integer'], 'integer[]');
const TWO_SUM_CASES = mkCases([
  [['[2,7,11,15]', '9'], '[0,1]'],
  [['[3,2,4]', '6'], '[1,2]'],
  [['[3,3]', '6'], '[0,1]'],
]);
const TWO_SUM_JAVA = `class Solution {
    public int[] twoSum(int[] nums, int target) {
        for (int i = 0; i < nums.length; i++) {
            for (int j = i + 1; j < nums.length; j++) {
                if (nums[i] + nums[j] == target) return new int[] { i, j };
            }
        }
        return new int[0];
    }
}
`;

function generate(
  code = TWO_SUM_JAVA,
  meta: LcMetaData = TWO_SUM_META,
  options: { sourceFile?: string; cases?: TestCase[] } = {},
) {
  const sourceFile = options.sourceFile ?? 'solution.java';
  return JavaHarness.generate({
    langSlug: 'java',
    meta,
    testCases: options.cases ?? TWO_SUM_CASES,
    sourceFile,
    sourceAbsPath: `/tmp/lcjava/${sourceFile}`,
    sourceCode: code,
    genDir: '/tmp/lcjava/local',
    titleSlug: 'two-sum',
  });
}

/**
 * 静态检查生成的 Java 源码：括号配平（忽略注释与字符串/字符字面量）。
 * 本机没有 JDK 时用它兜住模板级的语法错误。
 */
function javaDelimiterErrors(source: string): string[] {
  const errors: string[] = [];
  const stack: Array<{ ch: string; line: number }> = [];
  const closing: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  let line = 1;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let inChar = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '\n') {
      line++;
      inLineComment = false;
      continue;
    }
    if (inLineComment) continue;
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (inChar) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === "'") inChar = false;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "'") {
      inChar = true;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      stack.push({ ch: c, line });
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      const top = stack.pop();
      if (!top || top.ch !== closing[c]) errors.push(`第 ${line} 行：没有配对的 ${c}`);
      continue;
    }
  }
  if (inString || inChar || inBlockComment) errors.push('字符串 / 注释未闭合');
  for (const open of stack) errors.push(`第 ${open.line} 行：${open.ch} 未闭合`);
  return errors;
}

function probe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * 判断本机是否真的能编译/运行 Java。
 * macOS 自带 /usr/bin/javac 是一个报错的 stub（未装 JDK 时 `which javac` 仍然能命中），
 * 所以除了 findExecutable 之外还要真跑一次 `-version`。
 */
async function javaToolchainReady(): Promise<boolean> {
  const javac = await findExecutable(['javac']);
  const java = await findExecutable(['java']);
  if (!javac || !java) return false;
  if (!(await probe(javac, ['-version']))) return false;
  if (!(await probe(java, ['-version']))) return false;
  return true;
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
  fileName = 'solution.java',
): Promise<RunOnce> {
  const dir = await mkdtemp(join(tmpdir(), 'lcjava-'));
  const sourcePath = join(dir, fileName);
  await writeFile(sourcePath, code, 'utf8');
  const genDir = join(dir, 'local');
  await mkdir(genDir, { recursive: true });
  const result = await runLocalTestsWith(JavaHarness, {
    langSlug: 'java',
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

describe('java 脚手架：supports', () => {
  it('设计类题目返回明确的不支持原因', () => {
    const meta = mkMeta('MedianFinder', [], 'void', { construct: true, classname: 'MedianFinder' });
    const support = JavaHarness.supports(meta);
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toBe('设计类题目（多步操作）暂不支持本地脚手架');
  });

  it('未知类型返回「暂不支持的类型：X」', () => {
    const support = JavaHarness.supports(mkMeta('foo', ['integer'], 'WeirdType'));
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toBe('暂不支持的类型：WeirdType');
  });

  it('常见类型可以通过', () => {
    expect(JavaHarness.supports(TWO_SUM_META).ok).toBe(true);
    expect(JavaHarness.supports(mkMeta('f', ['ListNode', 'TreeNode[]'], 'character[][]')).ok).toBe(true);
  });
});

describe('java 脚手架：生成物', () => {
  it('生成用例文件 + Main.java，编译与运行步骤正确', () => {
    const artifact = generate();
    expect(artifact.files.map((f) => f.name)).toEqual([CASES_FILE, 'Main.java', 'Solution.java']);
    expect(artifact.debugEntry).toBe('Main.java');
    expect(artifact.debugType).toBe('java');
    expect(artifact.steps.map((s) => s.label)).toEqual(['compile', 'run']);

    const compile = artifact.steps[0];
    expect(compile.cmd).toBe('javac');
    expect(compile.args.slice(0, 3)).toEqual(['-encoding', 'UTF-8', '-d']);
    expect(compile.args).toContain('/tmp/lcjava/local/Solution.java');
    expect(compile.args).toContain('/tmp/lcjava/local/Main.java');
    expect(compile.fatal).toBe(true);

    const run = artifact.steps[1];
    expect(run.cmd).toBe('java');
    expect(run.args).toEqual(['-cp', '/tmp/lcjava/local', 'Main']);
    expect(run.fatal).toBe(false);
  });

  it('用例文件来自 serializeCases，且包含本题 meta 与 args 原文', () => {
    const artifact = generate();
    const cases = JSON.parse(artifact.files.find((f) => f.name === CASES_FILE)?.content ?? '{}');
    expect(cases.meta.name).toBe('twoSum');
    expect(cases.cases[0].args).toEqual(['[2,7,11,15]', '9']);
    expect(cases.cases[0].expected).toBe('[0,1]');
  });

  it('类名与文件名不一致时把用户代码复制进 genDir，且不改原文件', () => {
    const artifact = generate();
    const copied = artifact.files.find((f) => f.name === 'Solution.java');
    expect(copied?.content).toBe(TWO_SUM_JAVA);
    // 生成是纯函数式：不会把用户原文件当成生成物，也不会改写它
    expect(artifact.files.some((f) => f.name === 'solution.java')).toBe(false);
    expect(artifact.files.find((f) => f.name === 'Main.java')?.content).not.toBe(TWO_SUM_JAVA);
  });

  it('类名与文件名一致时直接编译原文件（便于在用户文件上打断点）', () => {
    const artifact = generate(TWO_SUM_JAVA, TWO_SUM_META, { sourceFile: 'Solution.java' });
    expect(artifact.files.map((f) => f.name)).toEqual([CASES_FILE, 'Main.java']);
    expect(artifact.steps[0].args).toContain('/tmp/lcjava/Solution.java');
    expect(artifact.notes?.some((n) => n.includes('断点'))).toBe(true);
  });

  it('Main.java 带节点定义、协议常量与本题注入信息', () => {
    const main = generate().files.find((f) => f.name === 'Main.java')?.content ?? '';
    expect(main).toContain('public class Main');
    expect(main).toContain('class ListNode');
    expect(main).toContain('class TreeNode');
    expect(main).toContain('class Node');
    expect(main).toContain('__LC_RESULT__ ');
    expect(main).toContain('__LC_ERROR__ ');
    expect(main).toContain('__LC_DONE__ ');
    expect(main).toContain('static final String CLASS_NAME = "Solution";');
    expect(main).toContain('static final String METHOD_NAME = "twoSum";');
    expect(main).toContain('static final String[] ARG_KINDS = new String[] { "int[]", "int" };');
    expect(main).toContain('static final String RETURN_KIND = "int[]";');
    expect(main).toContain('_lc_cases.json');
    expect(main).toContain('Class.forName(CLASS_NAME)');
  });

  it('Main.java 括号配平、没有模板残留（本机无 JDK 时的语法兜底检查）', () => {
    for (const meta of [
      TWO_SUM_META,
      mkMeta('reverseList', ['ListNode'], 'ListNode'),
      mkMeta('invertTree', ['TreeNode'], 'TreeNode'),
      mkMeta('sortColors', ['integer[]'], 'void'),
      mkMeta('cloneGraph', ['Node'], 'Node'),
      mkMeta('groupAnagrams', ['string[]'], 'string[][]'),
      mkMeta('reverseString', ['character[]'], 'void'),
    ]) {
      const main = generate(TWO_SUM_JAVA, meta).files.find((f) => f.name === 'Main.java')?.content ?? '';
      expect(javaDelimiterErrors(main)).toEqual([]);
      expect(main).not.toContain('${');
      expect(main.trimEnd().endsWith('}')).toBe(true);
      // 一行一个声明的粗查：不能有未闭合的引号导致的换行断裂
      expect(main.split('\n').length).toBeGreaterThan(200);
    }
  });

  it('类名取自 meta.classname，非法字符会被清掉', () => {
    const artifact = generate(TWO_SUM_JAVA, mkMeta('twoSum', ['integer[]', 'integer'], 'integer[]', {
      classname: 'My Class',
    }));
    const main = artifact.files.find((f) => f.name === 'Main.java')?.content ?? '';
    expect(main).toContain('static final String CLASS_NAME = "MyClass";');
    expect(artifact.files.some((f) => f.name === 'MyClass.java')).toBe(true);
  });
});

describe('java 脚手架：真实执行（需要本机 JDK）', () => {
  it('two-sum 正确解法全绿', async () => {
    if (!(await javaToolchainReady())) {
      console.warn('skip: javac 不可用');
      return;
    }
    const { result, sourcePath } = await runOnce(TWO_SUM_JAVA, TWO_SUM_META, TWO_SUM_CASES);
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.cases.map((c) => c.ok)).toEqual([true, true, true]);
    expect(result.ok).toBe(true);
    expect(await readFile(sourcePath, 'utf8')).toBe(TWO_SUM_JAVA);
  });

  it('错误解法被判错', async () => {
    if (!(await javaToolchainReady())) {
      console.warn('skip: javac 不可用');
      return;
    }
    const bad = `class Solution {
    public int[] twoSum(int[] nums, int target) {
        return new int[] { 0, 0 };
    }
}
`;
    const { result } = await runOnce(bad, TWO_SUM_META, TWO_SUM_CASES.slice(0, 1));
    expect(result.cases[0].ok).toBe(false);
    expect(result.cases[0].actual).toBe('[0,0]');
  });

  it('ListNode 与 void 原地修改', async () => {
    if (!(await javaToolchainReady())) {
      console.warn('skip: javac 不可用');
      return;
    }
    const reverse = `class Solution {
    public ListNode reverseList(ListNode head) {
        ListNode prev = null;
        ListNode cur = head;
        while (cur != null) {
            ListNode next = cur.next;
            cur.next = prev;
            prev = cur;
            cur = next;
        }
        return prev;
    }
}
`;
    const listRun = await runOnce(reverse, mkMeta('reverseList', ['ListNode'], 'ListNode'), mkCases([
      [['[1,2,3,4,5]'], '[5,4,3,2,1]'],
      [['[]'], '[]'],
    ]));
    expect(listRun.result.cases.map((c) => c.ok)).toEqual([true, true]);

    const sort = `class Solution {
    public void sortColors(int[] nums) {
        java.util.Arrays.sort(nums);
    }
}
`;
    const voidRun = await runOnce(sort, mkMeta('sortColors', ['integer[]'], 'void'), mkCases([
      [['[2,0,2,1,1,0]'], '[0,0,1,1,2,2]'],
    ]));
    expect(voidRun.result.cases[0].actual).toBe('[0,0,1,1,2,2]');
  });

  it('入口不存在时报 entry_not_found', async () => {
    if (!(await javaToolchainReady())) {
      console.warn('skip: javac 不可用');
      return;
    }
    const { result } = await runOnce(TWO_SUM_JAVA, mkMeta('threeSum', ['integer[]'], 'integer[][]'), TWO_SUM_CASES);
    expect(result.ok).toBe(false);
    expect(String(result.cases[0].error)).toContain('entry_not_found');
  });
});
