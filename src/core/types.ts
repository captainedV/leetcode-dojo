/**
 * 与 LeetCode 数据结构相关的类型定义（纯数据，无 vscode 依赖，便于单测）。
 */

export type LangSlug = string;

export interface LcParam {
  name: string;
  /** LeetCode 的类型字符串，例如 `integer`、`integer[]`、`ListNode`、`TreeNode`、`character[][]` */
  type: string;
}

export interface LcReturn {
  type: string;
  size?: number;
}

/** GraphQL 里 `metaData` 字段解析后的结构。 */
export interface LcMetaData {
  name: string;
  params: LcParam[];
  return: LcReturn;
  /** true 表示答案由人工/特殊判定（例如返回多种合法结果） */
  manual?: boolean;
  /** 设计类题目（如 LRUCache）才有该类名 */
  classname?: string;
  /** true 表示设计类题目需要调用构造函数 */
  construct?: boolean;
  /** 系统设计题 */
  systemdesign?: boolean;
}

export interface LcCodeSnippet {
  lang: string;
  langSlug: string;
  code: string;
}

export interface LcQuestion {
  questionId: string;
  questionFrontendId?: string;
  title: string;
  titleSlug: string;
  difficulty: string;
  /** HTML 题面 */
  content: string;
  /** 每行一个参数，按 params 数量分组即为各示例输入 */
  exampleTestcases: string;
  /** JSON 字符串形式的 LcMetaData */
  metaData: string;
  codeSnippets: LcCodeSnippet[];
  sampleTestCase?: string;
  hints?: string[];
  translatedTitle?: string;
  isPaidOnly?: boolean;
}

/** 从题面解析出来的一个示例。 */
export interface ExampleBlock {
  index: number;
  /** 示例里的输入（原文，可能跨行） */
  input: string | null;
  /** 示例里的输出（原文） */
  output: string | null;
  explanation?: string | null;
}

/** 一个可执行的本地用例。 */
export interface TestCase {
  index: number;
  /** 每个参数对应的一行原文（已 json 解析前） */
  args: string[];
  /** 期望输出原文（来自题面 `Output:` 或用户自定义） */
  expected: string | null;
  /** 来源：example=题面示例；leet=LeetCode 官方示例输入；custom=用户自定义；ai=AI 生成 */
  source: 'example' | 'leet' | 'custom' | 'ai';
}

/** 单条用例的执行结果（跨语言统一）。 */
export interface CaseResult {
  index: number;
  ok: boolean | null;
  actual: string;
  expected: string | null;
  error?: string | null;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export interface RunResult {
  ok: boolean;
  cases: CaseResult[];
  /** 编译错误 / 运行时崩溃等整段日志 */
  stderr?: string;
  stdout?: string;
  durationMs: number;
  /** 使用了哪个语言实现 */
  langSlug: string;
  /** 脚手架来源 */
  harnessSource: 'builtin' | 'ai';
  /** 若脚手架不可用，给出原因与建议 */
  unsupportedReason?: string;
}

export const HARNESS_RESULT_PREFIX = '__LC_RESULT__ ';
export const HARNESS_DONE_PREFIX = '__LC_DONE__ ';
export const HARNESS_ERROR_PREFIX = '__LC_ERROR__ ';
