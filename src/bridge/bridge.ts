/**
 * 注入到 LeetCode 页面（本地代理源）里的桥接脚本。
 *
 * 三个核心能力：
 *  1. **接管运行/提交**：改包 `fetch` / `XMLHttpRequest`，把发往
 *     `/problems/<slug>/(interpret_solution|submit)/` 的请求体里的 `typed_code` / `lang`
 *     换成「本地 IDE 里的代码 + 当前语言」。这样即使用户点的是网页上的按钮，
 *     判题用的也是本地代码；同时我们还能读到判题结果并回传给 IDE。
 *  2. **替换编辑器视觉**：站点编辑器是 `#editor` 里的 Monaco（懒加载、`window.monaco` 可用）。
 *     我们不改它的 DOM 结构（React 会打架），而是用一个覆盖层精确盖住 Monaco 的矩形区域，
 *     并在覆盖层里提示「代码已切换到本地 IDE」，保留站点自身的工具栏/结果面板。
 *  3. **路由同步**：监听 `/problems/<slug>/`，通知 IDE 打开/切换对应题目文件。
 *
 * 设计原则：所有补丁都必须能失败而无害（try/catch + 原始行为兜底），
 * 因为站点前端随时会变，宁可退化成普通网页也不能白屏。
 */
import type { BridgeMessage, HostMessage } from './protocol.js';
import {
  classifyLink,
  detectJudgeResult,
  detectSubmissionId,
  fixSelfProtocol,
  matchJudgeRequest,
  rewriteJudgeBody,
} from './judge.js';

const LC_NS = 'lcLocal';
const OVERLAY_ID = 'lc-local-overlay';
const STYLE_ID = 'lc-local-style';

interface BridgeState {
  slug?: string;
  lang?: string;
  code?: string;
  title?: string;
  fileName?: string;
  /** true = 只显示网页题面（隐藏线上 IDE 的代码区与测试用例区），false = 完整网页 */
  hideEditor: boolean;
  /** 站点是否已经挂载 monaco */
  hasMonaco: boolean;
  /** 上次同步进 Monaco 的代码与模型，避免每次 DOM 变更重复序列化整份代码 */
  lastSyncedCode?: string;
  lastSyncedModel?: unknown;
  /** 是否已把代码同步进站点 monaco（供用户点站点按钮时的一致性） */
  pendingSubmissions: Map<string, 'run' | 'submit'>;
  lastJudge?: unknown;
}

const state: BridgeState = {
  hideEditor: true,
  hasMonaco: false,
  pendingSubmissions: new Map(),
};

const logBuffer: Array<{ level: string; message: string }> = [];

function post(msg: BridgeMessage): void {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ [LC_NS]: true, ...msg }, '*');
      return;
    }
  } catch {
    /* ignore */
  }
  // 顶层页面（例如直接用浏览器打开代理地址）：退回本地日志通道，方便诊断
  try {
    void fetch('/__lc/log', { method: 'POST', body: JSON.stringify(msg), keepalive: true });
  } catch {
    /* ignore */
  }
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  const entry = { level, message };
  logBuffer.push(entry);
  if (logBuffer.length > 200) logBuffer.shift();
  post({ t: 'log', level, message });
}

function reportError(where: string, err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log('error', `[${where}] ${message}`);
}

// ------------------------------------------------------------------ 路由解析

function currentSlug(): string | undefined {
  const m = /^\/problems\/([a-zA-Z0-9-]+)(?:\/|$)/.exec(window.location.pathname);
  return m?.[1];
}

const NAV_STACK_KEY = '__lc_nav_stack';

function navStack(): string[] {
  try {
    const raw = sessionStorage.getItem(NAV_STACK_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 只记录「非题目页」（题库、学习计划、题解列表…），作为后退目标 */
function rememberNonProblemPage(href: string): void {
  try {
    if (currentSlug()) return;
    const stack = navStack();
    if (stack[stack.length - 1] === href) return;
    stack.push(href);
    while (stack.length > 20) stack.shift();
    sessionStorage.setItem(NAV_STACK_KEY, JSON.stringify(stack));
  } catch {
    /* ignore */
  }
}

/** 后退：优先回到上一个非题目页，实在没有就退回题库 */
function goBack(): void {
  let target = '';
  try {
    const stack = navStack();
    target = stack.pop() ?? '';
    sessionStorage.setItem(NAV_STACK_KEY, JSON.stringify(stack));
  } catch {
    /* ignore */
  }
  if (target) {
    log('info', `后退到 ${new URL(target, window.location.href).pathname}`);
    window.location.assign(target);
    return;
  }
  // 没有记录：尝试浏览器历史，再退到题库
  if (history.length > 1) history.back();
  else window.location.assign('/problemset/');
}

function notifyRoute(force = false): void {
  const slug = currentSlug();
  if (!force && slug === state.slug) return;
  state.slug = slug;
  if (slug) {
    log('info', `进入题目 ${slug}`);
  }
  rememberNonProblemPage(window.location.href);
  post({ t: 'route', slug, href: window.location.href, pathname: window.location.pathname });
  scheduleDomSync();
}

function patchHistory(): void {
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function patched(this: History, ...args: Parameters<History['pushState']>) {
      const ret = original.apply(this, args);
      try {
        notifyRoute();
      } catch (err) {
        reportError('history', err);
      }
      return ret;
    } as History[typeof method];
  }
  window.addEventListener('popstate', () => notifyRoute());
}

// -------------------------------------------------------- 接管运行/提交请求

function observingFetch(): void {
  const originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url = '';
    let bodyText: string | undefined;
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.body && typeof init.body === 'string') bodyText = init.body;
    } catch {
      /* ignore */
    }

    // 站点可能拼出 https://127.0.0.1:PORT/...（用 location.host 拼绝对地址），纠正回 http
    if (url) {
      const fixed = fixSelfProtocol(url, window.location.host, window.location.origin);
      if (fixed !== url) {
        url = fixed;
        if (typeof input === 'string' || input instanceof URL) input = fixed;
      }
    }
    const match = matchJudgeRequest(url, bodyText);
    let patchedInit = init;
    if (match) {
      const rewritten = rewriteJudgeBody(match, bodyText, { lang: state.lang, code: state.code });
      if (rewritten.changed && rewritten.body !== undefined) {
        patchedInit = { ...init, body: rewritten.body };
      }
      if (!state.code) post({ t: 'needCode', kind: match.kind });
      post({
        t: 'intercept',
        kind: match.kind,
        lang: rewritten.lang ?? state.lang,
        siteLang: siteLangOf(bodyText),
        slug: match.slug,
        codeLength: (rewritten.code ?? state.code ?? '').length,
        replaced: rewritten.changed,
      });
      if (rewritten.useLocalInput && rewritten.dataInput !== undefined) {
        log('info', '已用本地用例覆盖网页输入（data_input）');
      }
    }

    let response: Response;
    try {
      response = await originalFetch.call(window, input as RequestInfo, patchedInit);
    } catch (err) {
      if (match) post({ t: 'judgeError', kind: match.kind, message: String(err) });
      throw err;
    }

    if (match) {
      void observeJudgeResponse(response.clone(), match.kind);
    } else if (/\/submissions\/detail\/\d+\/(v2\/)?check\//.test(url)) {
      void observeJudgeResponse(response.clone(), 'run');
    }
    return response;
  } as typeof window.fetch;
}

function observingXhr(): void {
  const proto = XMLHttpRequest.prototype as XMLHttpRequest & { __lcPatched?: boolean };
  if (proto.__lcPatched) return;
  proto.__lcPatched = true;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const meta = new WeakMap<XMLHttpRequest, { url: string; body?: string }>();

  proto.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    try {
      meta.set(this, { url: typeof url === 'string' ? url : url.href });
    } catch {
      /* ignore */
    }
    return (originalOpen as unknown as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
  } as typeof proto.open;

  proto.send = function patchedSend(this: XMLHttpRequest, body?: unknown): void {
    try {
      const info = meta.get(this);
      if (info) {
        const text = typeof body === 'string' ? body : undefined;
        const match = matchJudgeRequest(info.url, text);
        if (match) {
          const rewritten = rewriteJudgeBody(match, text, { lang: state.lang, code: state.code });
          if (rewritten.changed && text !== undefined) {
            post({
              t: 'intercept',
              kind: match.kind,
              lang: rewritten.lang ?? state.lang,
              siteLang: siteLangOf(text),
              slug: match.slug,
              codeLength: (rewritten.code ?? '').length,
              replaced: true,
            });
            this.addEventListener('load', () => {
              try {
                void observeJudgeResponse(new Response(this.responseText, { status: this.status }), match.kind);
              } catch {
                /* responseText 不可用时忽略 */
              }
            });
            return (originalSend as unknown as (b?: unknown) => void).call(this, rewritten.body);
          }
        }
      }
    } catch (err) {
      reportError('xhr', err);
    }
    return (originalSend as unknown as (b?: unknown) => void).call(this, body);
  } as typeof proto.send;
}

/** 从原始请求体里读出网页想用的语言 */
function siteLangOf(bodyText: string | undefined): string | undefined {
  if (!bodyText) return undefined;
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const direct = parsed.lang;
    if (typeof direct === 'string') return direct;
    const vars = parsed.variables as Record<string, unknown> | undefined;
    if (vars && typeof vars.lang === 'string') return vars.lang;
  } catch {
    /* ignore */
  }
  return undefined;
}

async function observeJudgeResponse(response: Response, kind: 'run' | 'submit'): Promise<void> {
  try {
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const submissionId = detectSubmissionId(json);
    if (submissionId) {
      state.pendingSubmissions.set(submissionId, kind);
      post({ t: 'judgeStarted', kind, submissionId });
      return;
    }
    const result = detectJudgeResult(json);
    if (result) {
      state.lastJudge = result;
      post({ t: 'judgeResult', kind, result });
    }
  } catch (err) {
    reportError('judge-response', err);
  }
}

// -------------------------------------------------- 弹窗/新标签页接管

/** 返回一个假的 window，避免站点报「popup blocked」后走奇怪的兜底分支 */
function stubWindow(href: string): Window {
  return {
    closed: false,
    focus(): void {},
    blur(): void {},
    close(): void {},
    location: { href },
  } as unknown as Window;
}

function routeLink(url: string | null | undefined, mode: 'popup' | 'anchor'): void {
  const route = classifyLink(url, window.location.href, mode);
  if (route.kind === 'self') {
    // 同站（本地代理源）：当前面板内跳转，这样桥接和 IDE 联动都还在
    window.location.assign(route.href);
  } else if (route.kind === 'external') {
    post({ t: 'openExternal', url: route.href });
  }
}

function patchWindowOpen(): void {
  const original = window.open;
  if (typeof original !== 'function') return;
  window.open = function patchedOpen(
    url?: string | URL,
    target?: string,
    features?: string,
  ): Window | null {
    try {
      const href = url === undefined ? undefined : String(url);
      const route = classifyLink(href, window.location.href, 'popup');
      if (route.kind === 'self') {
        log('info', `题目/页面改为在当前面板内打开：${new URL(route.href).pathname}`);
        window.location.assign(route.href);
        return stubWindow(route.href);
      }
      if (route.kind === 'external') {
        post({ t: 'openExternal', url: route.href });
        return stubWindow(route.href);
      }
    } catch (err) {
      reportError('window.open', err);
    }
    return original.call(window, url as string, target, features) as Window | null;
  } as typeof window.open;
}

/** 拦截 target=_blank 的 <a>（题解、讨论等），避免在弹出的新窗口里丢掉 IDE 联动 */
function patchBlankAnchors(): void {
  document.addEventListener(
    'click',
    (ev) => {
      try {
        const target = ev.target as HTMLElement | null;
        const anchor = target?.closest?.('a') as HTMLAnchorElement | null;
        if (!anchor) return;
        if (anchor.getAttribute('target') !== '_blank') return;
        const href = anchor.getAttribute('href');
        const route = classifyLink(href, window.location.href, 'anchor');
        if (route.kind === 'ignore') return;
        ev.preventDefault();
        ev.stopPropagation();
        if (route.kind === 'self') {
          window.location.assign(route.href);
        } else {
          post({ t: 'openExternal', url: route.href });
        }
      } catch (err) {
        reportError('anchor', err);
      }
    },
    true,
  );
}

// ------------------------------------------------------------------ 界面接管

const FOCUS_STYLE_ID = 'lc-local-focus-style';
const DESC_TABSET_CLASS = 'lc-desc-tabset';
const DESC_PANE_CLASS = 'lc-desc-pane';

/**
 * 「只显示题面」的样式。
 *
 * 关键：**绝不改写 FlexLayout 元素的 inline style**。
 * 之前直接写 `element.style.width = '100% !important'`，关掉时再把 inline 样式清掉，
 * 结果 FlexLayout 自己的尺寸模型被破坏——题面那一栏变成 0x0（等于被折叠），
 * 只能整页刷新才恢复。现在改成：给要保留的元素打标记类，其余全部用 CSS 隐藏，
 * 关闭时只移除根节点上的 `lc-focus` 类，站点原本的 inline 样式一个字节都没动过。
 */
function ensureFocusStyle(): void {
  if (document.getElementById(FOCUS_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FOCUS_STYLE_ID;
  style.textContent = `
    /* 1) 隐藏除「题面」以外的所有面板 / 分割条 / sizer */
    html.lc-focus .flexlayout__layout > .flexlayout__tabset:not(.${DESC_TABSET_CLASS}),
    html.lc-focus .flexlayout__layout > .flexlayout__tab:not(.${DESC_PANE_CLASS}),
    html.lc-focus .flexlayout__layout > .flexlayout__splitter,
    html.lc-focus .flexlayout__layout > .flexlayout__tabset_sizer,
    html.lc-focus .flexlayout__layout > .flexlayout__tabset_header_sizer,
    html.lc-focus .flexlayout__layout > .flexlayout__border_sizer {
      display: none !important;
    }

    /* 2) 题面 tabset 铺满整栏 */
    html.lc-focus .flexlayout__layout > .flexlayout__tabset.${DESC_TABSET_CLASS} {
      display: flex !important;
      left: 0 !important;
      top: 0 !important;
      width: 100% !important;
      height: 100% !important;
    }

    /* 3) 题面内容面板铺满（留出顶部标签栏） */
    html.lc-focus .flexlayout__layout > .flexlayout__tab.${DESC_PANE_CLASS} {
      display: flex !important;
      left: 0 !important;
      top: var(--lc-desc-top, 36px) !important;
      width: 100% !important;
      height: calc(100% - var(--lc-desc-top, 36px)) !important;
      --width: 100% !important;
      --height: calc(100% - var(--lc-desc-top, 36px)) !important;
    }

    /* 4) 万一站点把这一栏折叠了（FlexLayout 的 collapsed 态），也强制展开 */
    html.lc-focus .flexlayout__tabset--collapsed.${DESC_TABSET_CLASS},
    html.lc-focus .flexlayout__tabset--collapsed.${DESC_TABSET_CLASS} .flexlayout__tabset_content {
      display: flex !important;
      width: 100% !important;
      height: 100% !important;
      transform: none !important;
    }
    html.lc-focus .flexlayout__tabset--collapsed.${DESC_TABSET_CLASS} .flexlayout__tabset_header {
      display: flex !important;
      transform: none !important;
      writing-mode: horizontal-tb !important;
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

function isDescTabset(el: HTMLElement): boolean {
  return /题目描述|Description/i.test(el.querySelector('.flexlayout__tab_button_content')?.textContent ?? '');
}

/** 找出题面 tabset（含「题目描述」标签的那个） */
function findDescTabset(tabsets: HTMLElement[]): HTMLElement | undefined {
  return tabsets.find((ts) => isDescTabset(ts)) ?? tabsets.find((ts) => !ts.querySelector('#editor') && ts.querySelector('.flexlayout__tab_button_content')) ?? tabsets[0];
}

/**
 * 找出题面内容面板。首选几何位置（与题面 tabset 左对齐），
 * 失败时退回「文字最多且不含线上编辑器」的那个 —— 面板被折叠时几何法会失效。
 */
function findDescPane(panes: HTMLElement[], tabset: HTMLElement): HTMLElement | undefined {
  const tsRect = tabset.getBoundingClientRect();
  const candidates = panes.filter((p) => !p.querySelector('#editor'));
  const byGeometry = candidates.find((p) => {
    const r = p.getBoundingClientRect();
    return r.width > 40 && r.height > 40 && Math.abs(r.left - tsRect.left) < 48;
  });
  if (byGeometry) return byGeometry;
  let best: HTMLElement | undefined;
  let bestLen = -1;
  for (const p of candidates) {
    const len = (p.innerText ?? '').length;
    if (len > bestLen) {
      bestLen = len;
      best = p;
    }
  }
  return bestLen > 80 ? best : undefined;
}

function clearFocusMarkers(): void {
  document.documentElement.classList.remove('lc-focus');
  for (const el of Array.from(document.getElementsByClassName(DESC_TABSET_CLASS))) el.classList.remove(DESC_TABSET_CLASS);
  for (const el of Array.from(document.getElementsByClassName(DESC_PANE_CLASS))) el.classList.remove(DESC_PANE_CLASS);
}

/**
 * 只保留题面：给题面 tabset / pane 打标记类，其它面板由 CSS 隐藏。
 * 不改任何 inline style —— 关闭时移除标记类即可完全复原。
 */
function applyFocusMode(): void {
  const layout = document.querySelector('.flexlayout__layout') as HTMLElement | null;
  const root = document.documentElement;

  if (!layout || !state.hideEditor || !currentSlug()) {
    // 非题目页 / 用户选择完整网页：撤销标记，站点原样显示
    clearFocusMarkers();
    return;
  }

  const kids = [...layout.children] as HTMLElement[];
  const tabsets = kids.filter((k) => k.classList.contains('flexlayout__tabset'));
  const panes = kids.filter((k) => k.classList.contains('flexlayout__tab'));
  if (!tabsets.length) return;

  const descTabset = findDescTabset(tabsets);
  if (!descTabset) return;
  const descPane = findDescPane(panes, descTabset);

  // 打标记（幂等）
  if (!descTabset.classList.contains(DESC_TABSET_CLASS)) descTabset.classList.add(DESC_TABSET_CLASS);
  if (descPane && !descPane.classList.contains(DESC_PANE_CLASS)) descPane.classList.add(DESC_PANE_CLASS);

  // 顶部标签栏高度 → 用 CSS 变量告知内容面板该从哪开始（不碰元素的 inline style）
  const headerEl = descTabset.querySelector('.flexlayout__tabset_header') as HTMLElement | null;
  const headerH = headerEl ? Math.round(headerEl.getBoundingClientRect().height) : 0;
  const paneTop = headerH > 8 ? headerH : 36;
  if (root.style.getPropertyValue('--lc-desc-top') !== `${paneTop}px`) {
    root.style.setProperty('--lc-desc-top', `${paneTop}px`);
  }
  root.classList.add('lc-focus');
  ensureFocusStyle();
}

/** 兼容旧调用名 */
function ensureOverlay(): void {
  applyFocusMode();
}

let domSyncTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleDomSync(withMonaco = false): void {
  if (withMonaco) state.lastSyncedCode = undefined;
  if (domSyncTimer) return;
  domSyncTimer = setTimeout(() => {
    domSyncTimer = undefined;
    try {
      ensureOverlay();
      syncMonaco();
    } catch (err) {
      reportError('dom-sync', err);
    }
  }, 120);
}

/** 把本地代码同步进站点自己的 Monaco 模型（按需同步，避免高频序列化大字符串）。 */
function syncMonaco(): void {
  if (!state.code) return;
  const monacoAny = (window as unknown as { monaco?: MonacoLike }).monaco;
  if (!monacoAny?.editor?.getModels) return;
  state.hasMonaco = true;
  try {
    const models = monacoAny.editor.getModels();
    if (!models?.length) return;
    const model = models[0];
    if (state.lastSyncedModel === model && state.lastSyncedCode === state.code) return;
    const current = typeof model.getValue === 'function' ? model.getValue() : '';
    if (current !== state.code && typeof model.setValue === 'function') {
      model.setValue(state.code);
      log('debug', '已把本地代码同步进站点 Monaco（保持网页状态一致）');
    }
    state.lastSyncedModel = model;
    state.lastSyncedCode = state.code;
  } catch (err) {
    reportError('sync-monaco', err);
  }
}

interface MonacoLike {
  editor?: {
    getModels?: () => Array<{ getValue?: () => string; setValue?: (v: string) => void }>;
  };
}

function watchDom(): void {
  const observer = new MutationObserver(() => scheduleDomSync(false));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('resize', () => scheduleDomSync(false), { passive: true });
}

/** 透传内嵌网页焦点下的快捷键到宿主（Cmd/Ctrl+Alt+Enter 本地运行，Cmd/Ctrl+Alt+S 提交，Cmd/Ctrl+Alt+H 提示） */
function patchShortcuts(): void {
  window.addEventListener('keydown', (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || !ev.altKey) return;
    const key = ev.key.toLowerCase();
    if (ev.key === 'Enter') {
      ev.preventDefault();
      post({ t: 'action', action: 'runLocal' });
    } else if (key === 's') {
      ev.preventDefault();
      post({ t: 'action', action: 'submit' });
    } else if (key === 'h') {
      ev.preventDefault();
      post({ t: 'action', action: 'aiHint' });
    }
  });
}

// -------------------------------------------------------------- 消息接收

function onHostMessage(ev: MessageEvent): void {
  const data = ev.data as (HostMessage & { [LC_NS]?: boolean }) | undefined;
  if (!data || typeof data !== 'object' || !('t' in data)) return;
  try {
    const msg: HostMessage = data;
    switch (msg.t) {
      case 'push': {
        const codeChanged = state.code !== msg.code;
        state.code = msg.code;
        state.lang = msg.lang;
        state.fileName = msg.fileName;
        state.hideEditor = msg.hideEditor ?? state.hideEditor;
        scheduleDomSync(codeChanged);
        post({ t: 'state', slug: state.slug, lang: state.lang, hasMonaco: state.hasMonaco, editorFound: !!document.querySelector('#editor') });
        break;
      }
      case 'hello': {
        post({ t: 'ready', href: window.location.href, slug: currentSlug() });
        scheduleDomSync(false);
        break;
      }
      case 'hideEditor': {
        state.hideEditor = msg.value;
        applyFocusMode();
        log('info', msg.value ? '已切换为「只显示题面」' : '已显示完整网页（含线上 IDE）');
        break;
      }
      case 'status': {
        post({
          t: 'state',
          slug: state.slug,
          lang: state.lang,
          hasMonaco: state.hasMonaco,
          editorFound: !!document.querySelector('#editor'),
        });
        scheduleDomSync(false);
        break;
      }
      case 'requestCode': {
        post({ t: 'needCode', kind: 'run' });
        break;
      }
      case 'history': {
        if (msg.action === 'back') goBack();
        else if (msg.action === 'forward') history.forward();
        else if (msg.action === 'reload') window.location.reload();
        else if (msg.action === 'home') window.location.assign('/problemset/');
        break;
      }
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        break;
      }
    }
  } catch (err) {
    reportError('host-message', err);
  }
}

// ------------------------------------------------------------------ 启动

declare global {
  interface Window {
    __lcBridge?: { alive: boolean; ticks: number; boot: string };
  }
}

function boot(): void {
  try {
    window.__lcBridge = { alive: true, ticks: 0, boot: new Date().toISOString() };
    patchHistory();
    patchWindowOpen();
    patchBlankAnchors();
    patchShortcuts();
    observingFetch();
    observingXhr();
    window.addEventListener('message', onHostMessage);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        watchDom();
        scheduleDomSync(true);
      });
    } else {
      watchDom();
      scheduleDomSync(true);
    }
    // 低频兜底心跳（页面隐藏时跳过，配合幂等样式写入实现零重排开销）
    setInterval(() => {
      if (document.hidden) return;
      try {
        if (window.__lcBridge) window.__lcBridge.ticks++;
        applyFocusMode();
      } catch (err) {
        reportError('overlay-heartbeat', err);
      }
    }, 1500);

    // SPA 路由兜底：某些跳转不经过 history API
    let lastPath = window.location.pathname;
    setInterval(() => {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        notifyRoute();
      }
    }, 1000);
    notifyRoute(true);
    post({ t: 'ready', href: window.location.href, slug: currentSlug() });
    log('info', '桥接脚本已注入');
  } catch (err) {
    reportError('boot', err);
  }
}

boot();
