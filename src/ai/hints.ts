/**
 * 提示 / 单行补全的薄封装：只拼 prompt、调 client、清洗输出。
 * 不依赖 vscode（UI 侧自己决定怎么展示），方便单测。
 */
import type { AssistantClient } from './provider.js';
import type { PromptContext } from './prompts.js';
import {
  buildHintPrompt,
  buildLineCompletionPrompt,
  cleanSingleLine,
  dropCodeBlocks,
} from './prompts.js';

export type { PromptContext } from './prompts.js';
export { cleanSingleLine } from './prompts.js';

export interface LineCompletionContext {
  langSlug: string;
  linePrefix: string;
  before: string;
  after: string;
}

/** 请求分级提示；返回值已去掉代码块，符合「不给完整代码」的要求。 */
export async function requestHint(client: AssistantClient, ctx: PromptContext): Promise<string> {
  const { system, user } = buildHintPrompt(ctx);
  const maxTokens = ctx.level === 'nudge' ? 200 : ctx.level === 'api' ? 500 : 700;
  const raw = await client.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens, temperature: 0.3 },
  );
  const text = dropCodeBlocks(raw) || raw.trim();
  if (!text) throw new Error('AI 没有返回任何提示内容，请重试。');
  return text;
}

/** 请求单行补全；返回值保证是单行字符串，空则 null。 */
export async function requestLineCompletion(
  client: AssistantClient,
  ctx: LineCompletionContext,
): Promise<string | null> {
  const { system, user } = buildLineCompletionPrompt(ctx);
  const raw = await client.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 80, temperature: 0 },
  );
  return cleanSingleLine(raw);
}
