/**
 * 会话持久化：让「重开 IDE 不用再登录一遍」真正成立。
 *
 * 需要持久化三样东西：
 *  1. **Cookie**（LEETCODE_SESSION / csrftoken…）——登录态本体。放 `context.secrets`（系统钥匙串），
 *     不可用时退回 globalStorage 文件。
 *  2. **代理端口**——站点页面跑在 `http://127.0.0.1:<port>`，而 localStorage 是**按源隔离**的：
 *     端口一变，站点的语言选择、题目草稿等本地状态就全丢了。所以端口要固定复用。
 *  3. **上次打开的题目**——重开 IDE 直接回到那道题，而不是重新翻题库。
 */
import * as vscode from 'vscode';
import type { CookieJar, CookieEntry } from '../proxy/cookies.js';

const COOKIE_KEY_PREFIX = 'lcLocal.cookies.';
const PORT_KEY_PREFIX = 'lcLocal.port.';
const LAST_SLUG_KEY = 'lcLocal.lastSlug';

export interface PersistedCookiePayload {
  site: string;
  savedAt: number;
  username?: string;
  cookies: Record<string, CookieEntry>;
}

export class SessionStore {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (line: string) => void,
  ) {}

  // ------------------------------------------------------------------ cookie

  /** 保存 cookie（脱敏日志只打印名字与长度） */
  async saveCookies(site: string, jar: CookieJar, username?: string): Promise<void> {
    const payload: PersistedCookiePayload = {
      site,
      savedAt: Date.now(),
      username,
      cookies: jar.toJSON(),
    };
    const names = Object.keys(payload.cookies);
    if (names.length === 0) {
      await this.clearCookies(site);
      return;
    }
    const json = JSON.stringify(payload, null, 2);
    const stored = await this.writeSecret(COOKIE_KEY_PREFIX + site, json);
    if (!stored) {
      // secrets 不可用时落盘（仍然只有本机可读）
      const uri = vscode.Uri.joinPath(this.context.globalStorageUri, `session-${site}.json`);
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(json));
    }
    this.log(`[session] 已保存登录态（${site}）：${names.join(', ')}${stored ? '' : '（落盘存储）'}`);
  }

  /** 读取 cookie 到 jar，返回恢复的条数 */
  async loadCookies(site: string, jar: CookieJar): Promise<number> {
    const raw = (await this.readSecret(COOKIE_KEY_PREFIX + site)) ?? (await this.readSessionFile(site));
    if (!raw) return 0;
    try {
      const payload = JSON.parse(raw) as PersistedCookiePayload;
      if (!payload?.cookies) return 0;
      jar.loadJSON(payload.cookies);
      const count = Object.keys(payload.cookies).length;
      const age = Date.now() - (payload.savedAt ?? 0);
      const days = Math.max(0, Math.round((age / 86400000) * 10) / 10);
      this.log(
        `[session] 已恢复登录态（${site}）：${Object.keys(payload.cookies).join(', ')}，${days} 天前保存` +
          (payload.username ? `，账号 ${payload.username}` : ''),
      );
      return count;
    } catch (err) {
      this.log(`[session] 解析登录态失败：${(err as Error).message}`);
      return 0;
    }
  }

  async clearCookies(site: string): Promise<void> {
    await this.deleteSecret(COOKIE_KEY_PREFIX + site);
    try {
      const uri = vscode.Uri.joinPath(this.context.globalStorageUri, `session-${site}.json`);
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    } catch {
      /* 文件不存在 */
    }
    this.log(`[session] 已清除登录态（${site}）`);
  }

  // ------------------------------------------------------------------ 端口

  /** 固定复用代理端口：保证站点源不变（localStorage / cookie 才能跨重启保留） */
  getPort(site: string): number | undefined {
    const value = this.context.globalState.get<number>(PORT_KEY_PREFIX + site);
    return typeof value === 'number' && value > 1024 && value < 65536 ? value : undefined;
  }

  async setPort(site: string, port: number): Promise<void> {
    await this.context.globalState.update(PORT_KEY_PREFIX + site, port);
  }

  // ------------------------------------------------------------------ 上次题目

  getLastSlug(): string | undefined {
    const value = this.context.globalState.get<string>(LAST_SLUG_KEY);
    return typeof value === 'string' && /^[a-zA-Z0-9-]+$/.test(value) ? value : undefined;
  }

  async setLastSlug(slug: string): Promise<void> {
    await this.context.globalState.update(LAST_SLUG_KEY, slug);
  }

  // ------------------------------------------------------------------ 工具

  private async readSecret(key: string): Promise<string | undefined> {
    try {
      const secrets = this.context.secrets;
      if (!secrets) return undefined;
      const value = await secrets.get(key);
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private async writeSecret(key: string, value: string): Promise<boolean> {
    try {
      const secrets = this.context.secrets;
      if (!secrets) return false;
      await secrets.store(key, value);
      return true;
    } catch {
      return false;
    }
  }

  private async deleteSecret(key: string): Promise<void> {
    try {
      await this.context.secrets?.delete(key);
    } catch {
      /* ignore */
    }
  }

  private async readSessionFile(site: string): Promise<string | undefined> {
    try {
      const uri = vscode.Uri.joinPath(this.context.globalStorageUri, `session-${site}.json`);
      const data = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder().decode(data);
    } catch {
      return undefined;
    }
  }
}
