/**
 * 本地测试脚手架的跨语言契约。
 *
 * 设计要点：
 *  1. **绝不覆盖用户代码文件**：脚手架生成到 `<problem>/local/` 目录下；
 *  2. **不往用户代码里注入任何东西**（不插 `#include`、不插 `main`、不插 import），
 *     而是在独立入口文件里通过 `#include "solution.cpp"` / `import` / `exec` 引用用户代码；
 *  3. 统一输出协议（见 core/types.ts 的 `HARNESS_*_PREFIX`）：
 *       __LC_RESULT__ {"i":0,"actual":"...","error":null}
 *       __LC_ERROR__  {"fatal":"..."}
 *       __LC_DONE__   {"elapsedMs":12}
 *     `actual` 是**字符串**，由各语言按 LeetCode 的序列化习惯渲染，再由 TS 侧归一化比较。
 */
import type { LcMetaData, TestCase } from '../../core/types.js';

export interface HarnessFile {
  /** 相对 genDir 的文件名 */
  name: string;
  content: string;
  /** 是否可执行（python/js 入口） */
  executable?: boolean;
}

export interface CmdStep {
  label: string;
  cmd: string;
  args: string[];
  /** 该步骤失败是否致命（compile 步骤致命，run 步骤不致命） */
  fatal?: boolean;
}

export interface HarnessInput {
  langSlug: string;
  meta: LcMetaData;
  testCases: TestCase[];
  /** 用户代码文件名（不含目录），例如 `solution.py` */
  sourceFile: string;
  /** 用户代码绝对路径 */
  sourceAbsPath: string;
  /** 用户代码内容 */
  sourceCode: string;
  /** 生成物目录（绝对路径） */
  genDir: string;
  /** 题目 slug，用于命名 */
  titleSlug: string;
  /** 调试模式：只生成一次，由 IDE 调试器驱动 */
  debug?: boolean;
  debugPort?: number;
}

export interface HarnessArtifact {
  files: HarnessFile[];
  steps: CmdStep[];
  /** 供调试用的入口文件（相对 genDir） */
  debugEntry: string;
  /** 调试入口被调试器 `program` 指向；语言调试器类型 */
  debugType?: string;
  env?: Record<string, string>;
  notes?: string[];
}

export type HarnessSupport = { ok: true; notes?: string[] } | { ok: false; reason: string };

export interface LanguageHarness {
  /** 规范化后的 langSlug */
  slug: string;
  /** 生成脚手架（同步，纯函数式：不触碰磁盘） */
  generate(input: HarnessInput): HarnessArtifact;
  /** 该语言对这道题是否支持（例如设计类题目、需要特殊判定的题目） */
  supports(meta: LcMetaData): HarnessSupport;
  /** 本地缺失编译器时的提示 */
  installHint: string;
}

/** 把用例序列化成 JSON（写进 `_lc_cases.json`，由脚手架读取）。 */
export function serializeCases(input: HarnessInput): string {
  const payload = {
    titleSlug: input.titleSlug,
    meta: input.meta,
    cases: input.testCases.map((c) => ({ i: c.index, args: c.args, expected: c.expected })),
  };
  return JSON.stringify(payload, null, 2);
}

/** 生成用例文件名常量 */
export const CASES_FILE = '_lc_cases.json';

/** 语言无关的「序列化类型」分类，脚手架按此分派。 */
export type TypeKind =
  | 'int'
  | 'long'
  | 'double'
  | 'bool'
  | 'string'
  | 'char'
  | 'int[]'
  | 'long[]'
  | 'double[]'
  | 'bool[]'
  | 'string[]'
  | 'char[]'
  | 'char[][]'
  | 'int[][]'
  | 'string[][]'
  | 'listnode'
  | 'listnode[]'
  | 'treenode'
  | 'treenode[]'
  | 'node'
  | 'graph'
  | 'json'
  | 'void'
  | 'unknown';

/** LeetCode 类型字符串 → 分类。覆盖绝大多数题型。 */
export function classifyType(type: string): TypeKind {
  const t = (type || '').trim().toLowerCase();
  switch (t) {
    case 'integer':
    case 'int':
      return 'int';
    case 'long':
    case 'bigint':
      return 'long';
    case 'double':
    case 'float':
      return 'double';
    case 'boolean':
    case 'bool':
      return 'bool';
    case 'string':
    case 'str':
      return 'string';
    case 'character':
    case 'char':
      return 'char';
    case 'void':
      return 'void';
    case 'integer[]':
    case 'int[]':
    case 'list[integer]':
      return 'int[]';
    case 'long[]':
      return 'long[]';
    case 'double[]':
    case 'float[]':
      return 'double[]';
    case 'boolean[]':
    case 'bool[]':
      return 'bool[]';
    case 'string[]':
    case 'list[string]':
      return 'string[]';
    case 'character[]':
    case 'char[]':
      return 'char[]';
    case 'character[][]':
    case 'char[][]':
      return 'char[][]';
    case 'integer[][]':
    case 'int[][]':
    case 'list[list[integer]]':
      return 'int[][]';
    case 'string[][]':
      return 'string[][]';
    case 'listnode':
      return 'listnode';
    case 'listnode[]':
    case 'list[listnode]':
      return 'listnode[]';
    case 'treenode':
      return 'treenode';
    case 'treenode[]':
    case 'list[treenode]':
      return 'treenode[]';
    case 'node':
      return 'node';
    case 'graph':
      return 'graph';
    case 'json':
    case 'array':
    case 'object':
    case 'nestedinteger':
      return 'json';
    default:
      return 'unknown';
  }
}

/** LeetCode 返回值类型为「可变参数原地修改」时，答案从第一个参数读取。 */
export function inPlaceAnswerParam(meta: LcMetaData): number {
  if (classifyType(meta.return.type) !== 'void') return -1;
  return meta.params.length > 0 ? 0 : -1;
}
