/**
 * 极简 Cookie 罐：代理与扩展宿主共用。
 *
 * 为什么需要它：
 *  - 内嵌网页的登录态是本地代理站点的 cookie，扩展宿主想直接调 LeetCode 的 REST 判题接口
 *    （interpret_solution / submit / check）就必须拿到同一份 cookie；
 *  - 同时把 cookie 持久化，IDE 重启后不必重新登录。
 *
 * 只保留 name=value，不区分 path/domain（本地代理只有一个源，够用）。
 */
import type { SiteConfig } from '../core/site.js';

export interface CookieEntry {
  value: string;
  /** 过期时间戳；undefined 表示会话 cookie */
  expires?: number;
  /** 上游是否标记为 HttpOnly（仅记录，用于诊断） */
  httpOnly?: boolean;
}

export class CookieJar {
  private cookies = new Map<string, CookieEntry>();

  /**
   * @param site 站点配置
   * @param onChange cookie 变化回调（登录/登出就靠它触发持久化）
   */
  constructor(
    private site: SiteConfig,
    private onChange?: (reason: string) => void,
  ) {}

  setSite(site: SiteConfig): void {
    this.site = site;
  }

  /** 解析上游 `set-cookie` 并写入罐子 */
  absorbSetCookie(setCookies: string[], now = Date.now()): void {
    let changed = false;
    let sessionTouched = false;
    for (const raw of setCookies) {
      const parsed = parseSetCookie(raw);
      if (!parsed) continue;
      if (parsed.maxAge !== undefined && parsed.maxAge <= 0) {
        if (this.cookies.delete(parsed.name)) changed = true;
        continue;
      }
      if (parsed.expires !== undefined && parsed.expires < now) {
        if (this.cookies.delete(parsed.name)) changed = true;
        continue;
      }
      const before = this.cookies.get(parsed.name)?.value;
      this.cookies.set(parsed.name, {
        value: parsed.value,
        expires: parsed.expires,
        httpOnly: parsed.httpOnly,
      });
      changed = changed || before !== parsed.value;
      if (parsed.name === this.site.sessionCookie && before !== parsed.value) {
        sessionTouched = true;
      }
    }
    if (changed) {
      this.onChange?.(sessionTouched ? 'session-cookie' : 'cookie');
    }
  }

  /** 生成发给上游的 `cookie` 头 */
  header(now = Date.now()): string {
    this.purge(now);
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v.value}`).join('; ');
  }

  /**
   * 生成回给浏览器的 `set-cookie`。
   * - 去掉 Domain、Secure（本站是 http://127.0.0.1），SameSite 统一下降为 Lax；
   * - 上游标了 HttpOnly 的（例如 LEETCODE_SESSION）**保留 HttpOnly**，避免页面脚本读到会话。
   */
  toBrowserSetCookie(): string[] {
    return [...this.cookies.entries()].map(([name, entry]) => {
      const parts = [`${name}=${entry.value}`, 'Path=/', 'SameSite=Lax'];
      if (entry.httpOnly) parts.push('HttpOnly');
      if (entry.expires) parts.push(`Expires=${new Date(entry.expires).toUTCString()}`);
      return parts.join('; ');
    });
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)?.value;
  }

  has(name: string): boolean {
    return (this.cookies.get(name)?.value ?? '').length > 0;
  }

  /** 是否已登录（会话 cookie 存在） */
  isSignedIn(): boolean {
    return this.has(this.site.sessionCookie);
  }

  csrfToken(): string | undefined {
    return this.get(this.site.csrfCookie);
  }

  set(name: string, value: string, expires?: number): void {
    this.cookies.set(name, { value, expires });
    this.onChange?.('set');
  }

  clear(): void {
    this.cookies.clear();
    this.onChange?.('clear');
  }

  /** 名字脱敏的列表，便于诊断输出 */
  summary(): Array<{ name: string; length: number; session: boolean }> {
    return [...this.cookies.entries()].map(([name, v]) => ({
      name,
      length: v.value.length,
      session: name === this.site.sessionCookie,
    }));
  }

  toJSON(): Record<string, CookieEntry> {
    this.purge(Date.now());
    return Object.fromEntries(this.cookies.entries());
  }

  loadJSON(obj: Record<string, CookieEntry> | undefined | null): void {
    if (!obj) return;
    this.cookies.clear();
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.value === 'string') this.cookies.set(k, v);
    }
  }

  private purge(now: number): void {
    for (const [k, v] of this.cookies) {
      if (v.expires !== undefined && v.expires < now) this.cookies.delete(k);
    }
  }
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  expires?: number;
  maxAge?: number;
  httpOnly?: boolean;
}

export function parseSetCookie(raw: string): ParsedSetCookie | undefined {
  if (!raw) return undefined;
  const parts = raw.split(';');
  const first = parts.shift() ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return undefined;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return undefined;
  const out: ParsedSetCookie = { name, value };
  for (const part of parts) {
    const [rawKey, ...rest] = part.split('=');
    const key = rawKey.trim().toLowerCase();
    const val = rest.join('=').trim();
    if (key === 'expires') {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) out.expires = t;
    } else if (key === 'max-age') {
      const n = Number(val);
      if (Number.isFinite(n)) out.maxAge = n;
    } else if (key === 'httponly') {
      out.httpOnly = true;
    }
  }
  if (out.maxAge !== undefined && out.maxAge > 0 && out.expires === undefined) {
    out.expires = Date.now() + out.maxAge * 1000;
  }
  return out;
}
