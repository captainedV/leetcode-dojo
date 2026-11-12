/**
 * AI 提示词与输出清洗（纯函数，**不依赖 vscode**，可直接单测）。
 *
 * 三个场景：
 *  1. 提示（hint）：分级（api / nudge / approach），绝不直接给可提交答案；
 *  2. 单行补全（line）：只补光标处当前这一行，输出被强制压成单行；
 *  3. AI 测试脚手架（harness）：要求严格 JSON，只往 local/ai 落盘，实现 __LC_RESULT__ 协议。
 */

export type HintLevel = 'api' | 'nudge' | 'approach';

export interface PromptContext {
  langSlug: string;
  title: string;
  contentMd: string;
  code: string;
  /** 用户光标所在的标识符（可选），用于让提示更聚焦 */
  focusWord?: string;
  level: HintLevel;
}

export interface LinePromptContext {
  langSlug: string;
  /** 当前行光标之前的文本 */
  linePrefix: string;
  /** 光标之前的完整文件内容 */
  before: string;
  /** 光标之后的文本（当前行剩余部分 + 后续代码） */
  after: string;
}

export interface HarnessPromptContext {
  langSlug: string;
  title: string;
  contentMd: string;
  metaJson: string;
  casesJson: string;
  sourceCode: string;
}

/** 各提示级别的简短说明（同时用于 system 与 user 消息） */
export const HINT_LEVEL_TITLES: Record<HintLevel, string> = {
  api: 'API 级：只解释 API 用法与边界情况，不给解题思路',
  nudge: '方向级：1-2 句方向，不展开、不含代码',
  approach: '思路级：分步思路，不含任何代码块',
};

/** 单行补全的字符上限（含缩进与空格） */
export const LINE_MAX_CHARS = 120;

/** 单行补全超过该长度就认为模型没有遵守约束，直接丢弃 */
export const LINE_HARD_LIMIT = 200;

const MAX_CONTENT_CHARS = 6000;
const MAX_CODE_CHARS = 4000;
const MAX_META_CHARS = 4000;
const MAX_CASES_CHARS = 6000;

function clip(text: string, max: number): string {
  const t = (text ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…（内容过长已截断）`;
}

function fenced(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

export function normalizeHintLevel(level: unknown): HintLevel {
  return level === 'api' || level === 'nudge' || level === 'approach' ? level : 'nudge';
}

/** 提示场景的 system prompt：约束「不给答案」的分级教练。 */
export const HINT_SYSTEM_PROMPT: string = [
  '你是「LeetCode Local IDE」里的算法教练。你的唯一目标是帮助用户自己想到解法，而不是替用户写答案。',
  '',
  '硬性约束（违反任何一条都算失败）：',
  '1. 不要给出完整的可提交答案：不要给出完整代码，也不要给出完整函数体，禁止输出可以直接复制粘贴提交的解答。',
  '2. 不要复述题面，也不要重复题目里的输入输出示例（用户已经读过题目）。',
  '3. 回答里不要出现代码块（三反引号围栏）；API 名称、函数签名、语言关键字可以用行内反引号提及。',
  '4. 必须用中文回答（API 名称、语言关键字保留原文）。',
  '5. 严格遵守用户指定的提示等级：',
  '   - api 级：只解释本题会用到的标准库 / API 的用法——参数含义、返回值、常见坑与边界（空输入、下标越界、去重、递归深度、整数溢出等），不要讲解题思路或算法选型。',
  '   - nudge 级：只用 1-2 句话点出该往哪类数据结构 / 算法上想，不展开步骤，不出现任何代码。',
  '   - approach 级：给出编号的分步思路（3-6 步），说明每步的目的与需要维持的不变式 / 边界，但不含代码块、不写具体语句。',
  '6. 不确定的地方直接说不确定，不要编造题目细节，也不要声称这是 LeetCode 官方提示。',
  '7. 篇幅：api 级不超过 200 字，nudge 级不超过 60 字，approach 级不超过 400 字。',
  '8. 不要追问、不要客套，直接输出提示内容本身。',
].join('\n');

/** 构造提示场景的 messages。 */
export function buildHintPrompt(ctx: PromptContext): { system: string; user: string } {
  const level = normalizeHintLevel(ctx.level);
  const lang = (ctx.langSlug || '未知').trim();
  const title = (ctx.title || '').trim() || '（未提供标题）';
  const focus = (ctx.focusWord ?? '').trim();
  const parts: string[] = [
    `语言：${lang}`,
    `题目：${title}`,
    `提示等级：${level}`,
    `本级别要求：${HINT_LEVEL_TITLES[level]}`,
    '',
    '【题面（仅供你理解题意，禁止在回答中复述）】',
    clip(ctx.contentMd, MAX_CONTENT_CHARS) || '（未提供题面）',
    '',
    '【用户当前代码（只读，供你判断用户卡在哪一步）】',
    fenced(clip(ctx.code, MAX_CODE_CHARS) || '（空文件）'),
  ];
  if (focus) {
    parts.push('', `【用户光标所在的词】${focus}`);
  }
  parts.push(
    '',
    `请按 ${level} 级要求输出提示内容本身（中文），不要复述题面，不要给完整代码。`,
  );
  return { system: HINT_SYSTEM_PROMPT, user: parts.join('\n') };
}

/** 单行补全场景的 system prompt。 */
export const LINE_SYSTEM_PROMPT: string = [
  '你是 LeetCode 刷题 IDE 里的单行补全引擎，只负责补全光标所在的这一行。',
  '',
  '输出规则（违反任何一条都算失败）：',
  '1. 只输出补全文本本身：不要换行，不要解释，不要 markdown 代码围栏，不要用引号或反引号包裹。',
  `2. 总长度不得超过 ${LINE_MAX_CHARS} 字符（包含空格和缩进）。`,
  '3. 只补当前这一行：不要重复用户已经写好的行前缀，只补光标处缺少的那部分文本。',
  '4. 不许生成循环、分支（if / for / while / switch）、函数定义、类定义等整段逻辑；如果补全需要多行才能完成，就只补一个函数调用与其参数（必要时可含 await / return 等当前行必需的片段）。',
  '5. 只给一个最自然的补全，不要给多个候选，也不要用注释列出备选方案。',
  '6. 如果无法在当前一行内安全补全（例如需要跨行改写用户代码），就输出空字符串（什么都不要输出）。',
].join('\n');

/** 构造单行补全的 messages（before / after / linePrefix 都会进入 user 内容）。 */
export function buildLineCompletionPrompt(ctx: LinePromptContext): { system: string; user: string } {
  const lang = (ctx.langSlug || '未知').trim();
  const linePrefix = ctx.linePrefix ?? '';
  const before = ctx.before && ctx.before.length > 0 ? ctx.before : '（空：光标在文件开头）';
  const after = ctx.after && ctx.after.length > 0 ? ctx.after : '（空：光标在文件末尾）';
  const user = [
    `语言：${lang}`,
    '',
    '【光标之前的文件内容（当前行之前的部分）】',
    fenced(before),
    '',
    '【当前行的行前缀（光标之前、属于本行的文本）】',
    fenced(linePrefix.length > 0 ? linePrefix : '（空：光标在本行开头）'),
    '',
    '【光标之后的文本（当前行剩余部分 + 后续代码）】',
    fenced(after),
    '',
    '请只输出光标处需要补全的这一行剩余文本（单行、不含前缀、不含解释）；无法单行补全则输出空字符串。',
  ];
  return { system: LINE_SYSTEM_PROMPT, user: user.join('\n') };
}

/** AI 脚手架场景的 system prompt：严格 JSON + 安全边界 + 协议。 */
export const HARNESS_SYSTEM_PROMPT: string = [
  '你是「LeetCode Local IDE」的本地测试脚手架生成器。你的输出会被解析成 JSON 并直接落盘执行，因此必须严格。',
  '',
  '硬性约束（违反任何一条都算失败）：',
  '1. 只输出严格 JSON（RFC 8259）：不要 markdown 代码围栏，不要注释，不要前后解释文字。',
  '2. 只生成测试脚手架文件（runner / 驱动 / 用例序列化），绝不修改、绝不重写用户的代码文件；用户代码只能以只读方式引用（python exec / import，js require / import，cpp #include，java 组合等）。',
  '3. 所有文件名必须是相对路径，最终只会写入 `<题目目录>/local/ai/` 目录；禁止绝对路径，禁止出现 `..`，禁止以 `.` 开头的隐藏文件，文件名只允许字母、数字、下划线、点和 `/`。',
  '4. 每一步的 cmd 必须是可执行命令名（python3 / python / node / g++ / clang++ / gcc / clang / javac / java / go / rustc / ruby / php / dotnet / kotlinc / swiftc / tsc 等）或以 ./ 开头的生成物；参数一律放在 args 数组里，不要使用 shell 语法（`;` `&` `|` `>` `<` `$` 反引号 都不要出现）。',
  '5. 运行时必须实现统一的输出协议（每行一个 JSON）：',
  '   - 每个用例输出一行：`__LC_RESULT__ {"i":<用例下标>,"actual":"<序列化后的实际输出字符串>","error":null}`；',
  '   - 非致命错误把堆栈写进该行的 error 字段；启动 / 编译等致命错误输出 `__LC_ERROR__ {"fatal":"原因"}`；',
  '   - 全部跑完输出 `__LC_DONE__ {"elapsedMs":<耗时毫秒>}`。',
  '6. actual 必须是**字符串**，按 LeetCode 的序列化习惯渲染（数组用 JSON、布尔用 true/false、链表与二叉树展开成数组、char[][] 用字符串数组），由 IDE 侧归一化比较，不要在脚手架里做判题。',
  '7. 不要联网、不要读取题目目录以外的文件、不要写入 `local/ai/` 以外的路径，也不要尝试安装依赖。',
  '8. 设计类题目用操作序列驱动：构造参数、方法名、返回 null 的操作按题面示例逐条调用，并逐步记录输出。',
  '',
  '输出 JSON schema（只允许这些字段）：',
  '{',
  '  "files": [{ "name": "相对路径（例如 _lc_runner.py）", "content": "文件全文" }],',
  '  "steps": [{ "label": "run", "cmd": "python3", "args": ["_lc_runner.py"], "fatal": false }],',
  '  "note": "可选的中文说明，告诉用户这个脚手架怎么用、有哪些限制"',
  '}',
  '',
  'steps 中编译步骤用 "fatal": true，运行步骤用 "fatal": false；至少一个 run 步骤必须打印协议行。',
].join('\n');

/** 构造 AI 脚手架的 messages。 */
export function buildHarnessPrompt(ctx: HarnessPromptContext): { system: string; user: string } {
  const lang = (ctx.langSlug || '未知').trim();
  const title = (ctx.title || '').trim() || '（未提供标题）';
  const user = [
    `语言：${lang}`,
    `题目：${title}`,
    '',
    '【题面（Markdown）】',
    clip(ctx.contentMd, MAX_CONTENT_CHARS) || '（未提供题面）',
    '',
    '【题目元数据 metaData（JSON：name / params / return / classname / construct 等）】',
    fenced(clip(ctx.metaJson, MAX_META_CHARS) || '（未提供）'),
    '',
    '【本地用例 cases（JSON：每项 i 为下标，args 是参数原文数组，expected 是期望输出原文，可能为 null）】',
    fenced(clip(ctx.casesJson, MAX_CASES_CHARS) || '（未提供）'),
    '',
    '【用户代码（只读参考，禁止修改；文件名由 IDE 侧提供）】',
    fenced(clip(ctx.sourceCode, MAX_CODE_CHARS * 2) || '（空文件）'),
    '',
    '请输出严格 JSON（files / steps / note），生成物只写入 local/ai/ 目录，运行步骤必须实现 __LC_RESULT__ 协议。',
  ];
  return { system: HARNESS_SYSTEM_PROMPT, user: user.join('\n') };
}

/** 去掉 markdown 代码围栏，保留内部文本。 */
export function stripCodeFences(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, inner: string) => inner)
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 完全删除围栏代码块（提示接口的安全兜底：宁可不显示，也不给整段代码）。 */
export function dropCodeBlocks(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 把模型输出清洗成「单行补全文本」：
 * 去代码围栏、去首尾空白、取第一行有意义的内容；空则返回 null。
 * 超过 LINE_HARD_LIMIT 视为模型没有遵守「只补一行」，返回 null。
 */
export function cleanSingleLine(raw: string): string | null {
  if (!raw) return null;
  const normalized = raw.replace(/\r\n?/g, '\n');
  for (const rawLine of normalized.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    // 整行都是围栏（```/```python 之类）→ 跳过
    if (/^(```|~~~)/.test(line)) continue;
    // 行内残留的围栏标记
    line = line.replace(/```[a-zA-Z0-9+#._-]*/g, '').replace(/~~~/g, '').trim();
    // 被反引号整体包裹的单行
    if (line.length > 2 && line.startsWith('`') && line.endsWith('`') && !line.slice(1, -1).includes('`')) {
      line = line.slice(1, -1).trim();
    }
    if (!line) continue;
    // 去掉常见的「补全：」前缀
    line = line.replace(/^(?:补全|completion|output)\s*[:：]\s*/i, '').trim();
    if (!line) continue;
    if (line.length > LINE_HARD_LIMIT) return null;
    return line;
  }
  return null;
}
