import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscodeMock from '../mocks/vscode.js';
import { CookieJar } from '../../src/proxy/cookies.js';
import { getSite } from '../../src/core/site.js';
import { SessionStore } from '../../src/core/cookieStore.js';

const site = getSite('leetcode.cn');

async function makeStore(shared = vscodeMock.__makeSharedState()) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-session-'));
  const ctx = vscodeMock.__makeContext('/tmp/ext', dir, shared);
  const logs: string[] = [];
  return { store: new SessionStore(ctx as never, (l) => logs.push(l)), logs, shared, ctx, dir };
}

describe('登录态持久化', () => {
  it('保存到 secrets，并能在"重启"后恢复到 jar', async () => {
    const { store, shared, logs } = await makeStore();
    const jar = new CookieJar(site);
    jar.absorbSetCookie(['LEETCODE_SESSION=abc123; Path=/; HttpOnly', 'csrftoken=tok; Path=/']);
    await store.saveCookies('leetcode.cn', jar, 'alice');

    expect(shared.secrets.has('lcLocal.cookies.leetcode.cn')).toBe(true);
    const raw = shared.secrets.get('lcLocal.cookies.leetcode.cn') ?? '';
    expect(raw).toContain('abc123');
    expect(raw).toContain('alice');
    expect(logs.join('\n')).toContain('已保存登录态');

    // 模拟 IDE 重启：新的 jar + 同一份 shared 存储
    const jar2 = new CookieJar(site);
    const { store: store2 } = await makeStore(shared);
    const count = await store2.loadCookies('leetcode.cn', jar2);
    expect(count).toBe(2);
    expect(jar2.isSignedIn()).toBe(true);
    expect(jar2.csrfToken()).toBe('tok');
  });

  it('secrets 不可用时退回文件存储，仍能恢复', async () => {
    const { store, ctx, dir } = await makeStore();
    // 抹掉 secrets 能力
    (ctx as unknown as { secrets: undefined }).secrets = undefined;
    const jar = new CookieJar(site);
    jar.absorbSetCookie(['LEETCODE_SESSION=xyz']);
    await store.saveCookies('leetcode.cn', jar);
    const file = join(dir, 'global', 'session-leetcode.cn.json');
    const { readFile } = await import('node:fs/promises');
    const saved = JSON.parse(await readFile(file, 'utf8')) as { cookies: Record<string, unknown> };
    expect(saved.cookies.LEETCODE_SESSION).toBeTruthy();

    const jar2 = new CookieJar(site);
    const ctx2 = vscodeMock.__makeContext('/tmp/ext', dir);
    (ctx2 as unknown as { secrets: undefined }).secrets = undefined;
    const store2 = new SessionStore(ctx2 as never, () => undefined);
    expect(await store2.loadCookies('leetcode.cn', jar2)).toBe(1);
    expect(jar2.isSignedIn()).toBe(true);
  });

  it('清除登录态会把 secrets 与文件都删掉', async () => {
    const { store, shared } = await makeStore();
    const jar = new CookieJar(site);
    jar.absorbSetCookie(['LEETCODE_SESSION=a']);
    await store.saveCookies('leetcode.cn', jar);
    await store.clearCookies('leetcode.cn');
    expect(shared.secrets.has('lcLocal.cookies.leetcode.cn')).toBe(false);
  });

  it('空 jar 保存等于清除', async () => {
    const { store, shared } = await makeStore();
    const jar = new CookieJar(site);
    await store.saveCookies('leetcode.cn', jar);
    expect(shared.secrets.size).toBe(0);
  });

  it('代理端口与上次题目会记住（跨重启）', async () => {
    const { store, shared } = await makeStore();
    await store.setPort('leetcode.cn', 31234);
    await store.setLastSlug('two-sum');
    const { store: store2 } = await makeStore(shared);
    expect(store2.getPort('leetcode.cn')).toBe(31234);
    expect(store2.getLastSlug()).toBe('two-sum');
  });

  it('非法值会被忽略（端口范围 / slug 字符集）', async () => {
    const shared = vscodeMock.__makeSharedState();
    shared.globalState.set('lcLocal.port.leetcode.cn', 80);
    shared.globalState.set('lcLocal.lastSlug', '../etc/passwd');
    const { store } = await makeStore(shared);
    expect(store.getPort('leetcode.cn')).toBeUndefined();
    expect(store.getLastSlug()).toBeUndefined();
  });

  it('损坏的 JSON 不会抛错，只返回 0', async () => {
    const shared = vscodeMock.__makeSharedState();
    shared.secrets.set('lcLocal.cookies.leetcode.cn', '{not json');
    const { store } = await makeStore(shared);
    const jar = new CookieJar(site);
    expect(await store.loadCookies('leetcode.cn', jar)).toBe(0);
  });
});

describe('CookieJar 变化通知', () => {
  it('会话 cookie 变化会带上 session-cookie 原因', () => {
    const events: string[] = [];
    const jar = new CookieJar(site, (r) => events.push(r));
    jar.absorbSetCookie(['LEETCODE_SESSION=s1']);
    jar.absorbSetCookie(['foo=bar']);
    expect(events[0]).toBe('session-cookie');
    expect(events[1]).toBe('cookie');
  });

  it('值没变不触发通知', () => {
    const events: string[] = [];
    const jar = new CookieJar(site, (r) => events.push(r));
    jar.absorbSetCookie(['LEETCODE_SESSION=s1']);
    jar.absorbSetCookie(['LEETCODE_SESSION=s1']);
    expect(events).toHaveLength(1);
  });

  it('HttpOnly 会被保留（会话 cookie 不该被页面脚本读到）', () => {
    const jar = new CookieJar(site);
    jar.absorbSetCookie(['LEETCODE_SESSION=s1; HttpOnly', 'csrftoken=t']);
    const cookies = jar.toBrowserSetCookie();
    const session = cookies.find((c) => c.startsWith('LEETCODE_SESSION=')) ?? '';
    const csrf = cookies.find((c) => c.startsWith('csrftoken=')) ?? '';
    expect(session).toContain('HttpOnly');
    expect(csrf).not.toContain('HttpOnly');
    // 仍要去掉 Domain/Secure，SameSite 降级
    for (const c of cookies) {
      expect(c).not.toContain('Domain=');
      expect(c).not.toContain('Secure');
      expect(c).toContain('SameSite=Lax');
    }
  });
});
