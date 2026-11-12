/**
 * 用户自带 API Key 的 AI 客户端（OpenAI 兼容 /chat/completions）。
 *
 * 设计要点：
 *  - 只用全局 `fetch`，不引入任何 SDK / provider 私有字段；
 *  - 超时 60s，可被 `abort()` 或外部 AbortSignal 取消；
 *  - 错误统一抛成「可读中文原因」，方便直接显示在通知里；
 *  - `chatJson` 负责剥离 ```json 围栏并 JSON.parse，失败时给出原文摘要。
 */
import * as vscode from 'vscode';

export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxOutputTokens: number;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-chat';
export const DEFAULT_MAX_OUTPUT_TOKENS = 1200;
/** 单次请求超时 */
export const CHAT_TIMEOUT_MS = 60_000;

/** 读取 `lcLocal.ai.*` 配置；apiKey 为空时回退环境变量 `LC_LOCAL_AI_KEY`。 */
export function readAiConfig(): AiConfig {
  const cfg = vscode.workspace.getConfiguration('lcLocal');
  const fromSettings = (cfg.get<string>('ai.apiKey', '') ?? '').trim();
  const fromEnv = (process.env.LC_LOCAL_AI_KEY ?? '').trim();
  const maxOutputTokens = cfg.get<number>('ai.maxOutputTokens', DEFAULT_MAX_OUTPUT_TOKENS) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return {
    enabled: cfg.get<boolean>('ai.enabled', false),
    baseUrl: (cfg.get<string>('ai.baseUrl', DEFAULT_BASE_URL) ?? '').trim() || DEFAULT_BASE_URL,
    model: (cfg.get<string>('ai.model', DEFAULT_MODEL) ?? '').trim() || DEFAULT_MODEL,
    apiKey: fromSettings || fromEnv,
    maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.floor(maxOutputTokens) : DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

/** baseUrl → /chat/completions 完整地址（已含则不重复）。 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

/** 把响应原文压成一小段，用于错误信息。 */
export function summarizeForError(raw: string, max = 400): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '（空响应）';
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function httpErrorMessage(status: number, detail: string, url: string, model: string): string {
  const extra = detail ? `；原文：${summarizeForError(detail)}` : '';
  switch (status) {
    case 400:
      return `AI 请求被服务端拒绝（HTTP 400）：请确认模型名 ${model} 存在、请求未超出上下文长度。${extra}`;
    case 401:
    case 403:
      return `AI 认证失败（HTTP ${status}）：API Key 无效或没有权限，请检查设置项 lcLocal.ai.apiKey 或环境变量 LC_LOCAL_AI_KEY。${extra}`;
    case 402:
      return `AI 账户额度不足（HTTP 402）：请到服务商后台充值后重试。${extra}`;
    case 404:
      return `AI 接口地址不存在（HTTP 404）：baseUrl 应指向 OpenAI 兼容根路径（例如 https://api.deepseek.com/v1），当前请求 ${url}。${extra}`;
    case 413:
      return `AI 请求体过大（HTTP 413）：题目内容或代码太长，请缩短后重试。${extra}`;
    case 429:
      return `AI 被限流或额度用尽（HTTP 429）：请稍后再试，或检查账户余额 / 模型配额。${extra}`;
    default:
      if (status >= 500) {
        return `AI 服务端错误（HTTP ${status}）：稍后重试；若持续失败请检查 baseUrl 与模型可用性。${extra}`;
      }
      return `AI 请求失败（HTTP ${status}）：${extra || '服务端未返回原因'}`;
  }
}

function networkErrorMessage(err: unknown, timedOut: boolean, url: string): string {
  if (timedOut) return `AI 请求超时（>${Math.round(CHAT_TIMEOUT_MS / 1000)}s）：请检查网络/代理，或改用响应更快的模型。`;
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'AbortError') return 'AI 请求已被取消。';
  const code = e?.cause?.code ?? '';
  const msg = e?.message ?? String(err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|CERT|self-signed/i.test(`${code} ${msg}`)) {
    return `无法连接 AI 服务（${url}）：${code || msg}。请检查网络、代理与 lcLocal.ai.baseUrl 是否正确。`;
  }
  return `调用 AI 服务失败：${msg}`;
}

/** 从 OpenAI 兼容响应里取文本内容。 */
function extractContent(data: unknown): string {
  const record = data as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
  const choice = record?.choices?.[0];
  if (!choice) return '';
  const content = choice.message?.content ?? choice.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const p = part as { text?: unknown };
        return typeof p?.text === 'string' ? p.text : '';
      })
      .join('');
  }
  return '';
}

/** 剥离 ```json 围栏（并尽量截取最外层 JSON 片段）。 */
export function extractJsonText(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  const fence = /```(?:json|JSON|javascript|js)?\s*\n?([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1].trim() : text;
  return sliceOutermostJson(body) || body.trim();
}

function sliceOutermostJson(text: string): string {
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  let start = -1;
  let close = '}';
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
    start = firstObj;
    close = '}';
  } else if (firstArr >= 0) {
    start = firstArr;
    close = ']';
  }
  if (start < 0) return '';
  const end = text.lastIndexOf(close);
  if (end <= start) return '';
  return text.slice(start, end + 1);
}

export class AssistantClient {
  private controller: AbortController | null = null;

  constructor(
    private readonly cfg: AiConfig,
    private readonly log: (msg: string) => void,
  ) {}

  get config(): AiConfig {
    return this.cfg;
  }

  /** 配置齐全且带 Key 才可用 */
  get available(): boolean {
    return this.cfg.enabled && this.cfg.apiKey.length > 0 && this.cfg.baseUrl.length > 0 && this.cfg.model.length > 0;
  }

  /** 取消当前请求 */
  abort(): void {
    this.controller?.abort();
    this.controller = null;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    if (!this.available) {
      throw new Error(
        'AI 未启用或缺少 API Key：请在设置中打开 lcLocal.ai.enabled 并填写 lcLocal.ai.apiKey（或设置环境变量 LC_LOCAL_AI_KEY）。',
      );
    }
    const url = chatCompletionsUrl(this.cfg.baseUrl);
    const maxTokens = opts.maxTokens ?? this.cfg.maxOutputTokens;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts.temperature ?? 0.2,
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.floor(maxTokens);

    // 新请求会顶掉旧请求
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CHAT_TIMEOUT_MS);
    const onOuterAbort = (): void => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onOuterAbort);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = networkErrorMessage(err, timedOut, url);
      this.log(`[ai] ${reason}`);
      throw new Error(reason);
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
      if (this.controller === controller) this.controller = null;
    }

    let rawText = '';
    try {
      rawText = await res.text();
    } catch {
      rawText = '';
    }

    if (!res.ok) {
      const reason = httpErrorMessage(res.status, rawText, url, this.cfg.model);
      this.log(`[ai] ${reason}`);
      throw new Error(reason);
    }

    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`AI 返回的内容不是合法 JSON（HTTP ${res.status}）：${summarizeForError(rawText)}`);
    }
    const content = extractContent(data);
    if (!content.trim()) {
      throw new Error(`AI 返回了空内容（HTTP ${res.status}）：${summarizeForError(rawText)}`);
    }
    this.log(`[ai] 完成：model=${this.cfg.model} chars=${content.length}`);
    return content;
  }

  /** 要求模型输出 JSON：内部剥离 ```json 围栏后解析，失败时附上原文摘要。 */
  async chatJson<T>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
    const raw = await this.chat(messages, opts);
    const text = extractJsonText(raw);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(
        `模型输出不是合法 JSON：${(err as Error).message}；原文摘要：${summarizeForError(raw)}`,
      );
    }
  }
}
