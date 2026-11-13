/**
 * 测试用的 vscode API 替身：只实现扩展实际用到的那部分，行为尽量贴近真实。
 * 目的：在没有 VS Code 宿主的情况下也能对 activate()/命令/会话做端到端验证。
 */
import { EventEmitter as NodeEventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as nodePath from 'node:path';

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Field = 4,
  Variable = 5,
  Snippet = 14,
}

export class Disposable {
  constructor(private callOnDispose?: () => void) {}
  dispose(): void {
    this.callOnDispose?.();
    this.callOnDispose = undefined;
  }
  static from(...disposables: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => disposables.forEach((d) => d.dispose()));
  }
}

export class EventEmitter<T> {
  private emitter = new NodeEventEmitter();
  event = (listener: (e: T) => void): Disposable => {
    this.emitter.on('evt', listener);
    return new Disposable(() => this.emitter.off('evt', listener));
  };
  fire(value: T): void {
    this.emitter.emit('evt', value);
  }
  dispose(): void {
    this.emitter.removeAllListeners();
  }
}

export class Uri {
  readonly authority = '';
  readonly query = '';
  readonly fragment = '';
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly fsPath: string,
  ) {}
  toJSON(): { scheme: string; path: string } {
    return { scheme: this.scheme, path: this.path };
  }
  static file(p: string): Uri {
    return new Uri('file', p, p);
  }
  static parse(raw: string): Uri {
    const m = /^([a-zA-Z][\w+.-]*):\/\/(.*)$/.exec(raw);
    if (!m) return Uri.file(raw);
    const path = '/' + m[2];
    return new Uri(m[1], path, path);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = nodePath.join(base.fsPath, ...segments);
    return new Uri(base.scheme, joined, joined);
  }
  with(change: { path?: string; scheme?: string; fsPath?: string }): Uri {
    const fsPath = change.fsPath ?? change.path ?? this.fsPath;
    return new Uri(change.scheme ?? this.scheme, fsPath, fsPath);
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

// ------------------------------------------------------------------ 配置

/** 已装扩展贡献的配置项（key → 默认值），让 inspect 能像真实 VS Code 一样认出"已注册"的键 */
function contributedSettings(): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const pkg of installedExtensions.values()) {
    const conf = (pkg as { contributes?: { configuration?: unknown } } | undefined)?.contributes?.configuration;
    if (!conf) continue;
    const blocks = Array.isArray(conf) ? conf : [conf];
    for (const block of blocks as Array<{ properties?: Record<string, { default?: unknown }> }>) {
      for (const [k, v] of Object.entries(block.properties ?? {})) out.set(k, v?.default);
    }
  }
  return out;
}

class Config {
  constructor(private section: string) {}

  private full(key: string): string {
    return this.section ? `${this.section}.${key}` : key;
  }

  get<T>(key: string, defaultValue?: T): T {
    const full = this.full(key);
    if (workspaceSettings.has(full)) return workspaceSettings.get(full) as T;
    if (userSettings.has(full)) return userSettings.get(full) as T;
    if (globalConfigValues.has(full)) return globalConfigValues.get(full) as T;
    if (defaults.has(full)) return defaults.get(full) as T;
    return defaultValue as T;
  }
  has(key: string): boolean {
    const full = this.full(key);
    return (
      workspaceSettings.has(full) ||
      userSettings.has(full) ||
      globalConfigValues.has(full) ||
      defaults.has(full) ||
      contributedSettings().has(full)
    );
  }
  inspect(key: string) {
    const full = this.full(key);
    const contributed = contributedSettings();
    const known =
      workspaceSettings.has(full) ||
      userSettings.has(full) ||
      globalConfigValues.has(full) ||
      defaults.has(full) ||
      contributed.has(full);
    if (!known) return undefined;
    return {
      key: full,
      globalValue: userSettings.get(full),
      workspaceValue: workspaceSettings.get(full),
      workspaceFolderValue: undefined,
      defaultValue: defaults.has(full) ? defaults.get(full) : contributed.get(full),
    };
  }
  async update(key: string, value: unknown, target?: ConfigurationTarget): Promise<void> {
    const full = this.full(key);
    const scope = target === ConfigurationTarget.Global ? 'user' : 'workspace';
    if (scope === 'workspace' && !workspaceFolders.length) {
      // 真实 VS Code 在没有打开文件夹时会拒绝写工作区设置
      throw new Error('Unable to write to Workspace Settings because no workspace is opened.');
    }
    const store = scope === 'user' ? userSettings : workspaceSettings;
    if (value === undefined) store.delete(full);
    else store.set(full, value);
  }
}

export const globalConfigValues = new Map<string, unknown>();
/** user（Global）作用域写入的值 */
export const userSettings = new Map<string, unknown>();
/** workspace 作用域写入的值 */
export const workspaceSettings = new Map<string, unknown>();
/** 测试可改的默认配置 */
const defaults = new Map<string, unknown>([
  ['lcLocal.site', 'leetcode.cn'],
  ['lcLocal.hint.level', 'signature'],
  ['lcLocal.hint.maxLineChars', 80],
  ['lcLocal.ai.enabled', false],
  ['lcLocal.ai.baseUrl', 'https://api.deepseek.com/v1'],
  ['lcLocal.ai.model', 'deepseek-chat'],
  ['lcLocal.ai.apiKey', ''],
  ['lcLocal.proxy.port', 0],
  ['lcLocal.proxy.injectBridge', true],
  ['lcLocal.run.timeoutMs', 20000],
  ['lcLocal.run.defaultLang', 'python3'],
  ['lcLocal.aiGuard.enabled', true],
  ['lcLocal.workspace.subdir', 'leetcode'],
  ['lcLocal.editor.hideSiteEditor', true],
  ['editor.inlineSuggest.enabled', true],
  ['lcLocal.layout.autoSplit', true],
  ['lcLocal.layout.leftRatio', 0.45],
  ['lcLocal.layout.lockLeftGroup', true],
]);

export function __setConfig(key: string, value: unknown): void {
  defaults.set(key, value);
}

// ------------------------------------------------------------------ 文档

export interface MockDocument {
  uri: Uri;
  fileName: string;
  languageId: string;
  isDirty: boolean;
  lineCount: number;
  getText(): string;
  save(): Promise<boolean>;
}

const openDocs = new Map<string, MockDocument>();

function makeDocument(uri: Uri): MockDocument {
  let text = '';
  try {
    text = fsSyncRead(uri.fsPath);
  } catch {
    text = '';
  }
  const doc: MockDocument = {
    uri,
    fileName: uri.fsPath,
    languageId: '',
    isDirty: false,
    lineCount: text.split('\n').length,
    getText: () => text,
    save: async () => {
      await fs.writeFile(uri.fsPath, text, 'utf8');
      doc.isDirty = false;
      return true;
    },
  };
  return doc;
}

function fsSyncRead(p: string): string {
  return fsSync.readFileSync(p, 'utf8');
}

/** 测试用：磁盘变了之后重新读取文档内容 */
export function __reloadDocument(uri: Uri): void {
  openDocs.delete(uri.fsPath);
  openDocs.set(uri.fsPath, makeDocument(uri));
}

/** 测试用：直接改文档内容 */
export function __setDocumentText(uri: Uri, text: string): void {
  const doc = openDocs.get(uri.fsPath) ?? makeDocument(uri);
  (doc as unknown as { getText: () => string }).getText = () => text;
  doc.isDirty = true;
  openDocs.set(uri.fsPath, doc);
}

// ------------------------------------------------------------------ workspace / window

export const workspaceFolders: Array<{ uri: Uri; name: string; index: number }> = [];

export const workspace = {
  get workspaceFolders() {
    return workspaceFolders.length ? workspaceFolders : undefined;
  },
  get textDocuments(): MockDocument[] {
    return [...openDocs.values()];
  },
  getConfiguration(section: string) {
    return new Config(section);
  },
  async openTextDocument(uri: Uri | string): Promise<MockDocument> {
    const u = typeof uri === 'string' ? Uri.file(uri) : uri;
    const existing = openDocs.get(u.fsPath);
    if (existing) return existing;
    const doc = makeDocument(u);
    openDocs.set(u.fsPath, doc);
    return doc;
  },
  fs: {
    async createDirectory(uri: Uri): Promise<void> {
      await fs.mkdir(uri.fsPath, { recursive: true });
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      return fs.readFile(uri.fsPath);
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      await fs.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, content);
    },
    async delete(uri: Uri): Promise<void> {
      await fs.rm(uri.fsPath, { force: true, recursive: true });
    },
    async stat(uri: Uri) {
      const s = await fs.stat(uri.fsPath);
      return { type: s.isDirectory() ? 2 : 1, ctime: 0, mtime: s.mtimeMs, size: s.size };
    },
  },
  onDidChangeTextDocument: () => new Disposable(),
  onDidSaveTextDocument: () => new Disposable(),
  onDidChangeConfiguration: () => new Disposable(),
};

export interface MockPanel {
  webview: {
    html: string;
    options: unknown;
    cspSource: string;
    asWebviewUri(uri: Uri): Uri;
    postMessage(msg: unknown): Promise<boolean>;
    onDidReceiveMessage(cb: (msg: unknown) => void): Disposable;
  };
  visible: boolean;
  reveal(targetCol?: ViewColumn, preserveFocus?: boolean): void;
  onDidDispose(cb: () => void): Disposable;
  dispose(): void;
}

export const postedMessages: unknown[] = [];
export const panels: MockPanel[] = [];

/** 测试用：向面板 webview 注入一条「来自 shell」的消息 */
export function __sendToWebview(msg: unknown): void {
  for (const [, cb] of webviewListeners) cb(msg);
}
const webviewListeners = new Map<string, (msg: unknown) => void>();

/** 测试用：webview view 注册表 */
export interface MockWebviewView {
  viewId: string;
  webview: {
    html: string;
    options: unknown;
    cspSource: string;
    asWebviewUri(uri: Uri): Uri;
    postMessage(msg: unknown): Promise<boolean>;
    onDidReceiveMessage(cb: (msg: unknown) => void): Disposable;
  };
  visible: boolean;
  show?(preserveFocus?: boolean): void;
  onDidDispose(cb: () => void): Disposable;
  posted: unknown[];
}

const viewProviders = new Map<string, { resolveWebviewView: (view: MockWebviewView) => void }>();
export const __webviewViews = new Map<string, MockWebviewView>();

/** 测试用：模拟 VS Code 解析出某个 webview view（相当于面板被展开） */
export function __resolveWebviewView(viewId: string, opts: { visible?: boolean } = {}): MockWebviewView | undefined {
  const provider = viewProviders.get(viewId);
  if (!provider) return undefined;
  const listeners: Array<(msg: unknown) => void> = [];
  const posted: unknown[] = [];
  const view: MockWebviewView = {
    viewId,
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://mock-view',
      asWebviewUri: (uri: Uri) => uri,
      async postMessage(msg: unknown) {
        posted.push(msg);
        return true;
      },
      onDidReceiveMessage(cb: (msg: unknown) => void) {
        listeners.push(cb);
        return new Disposable();
      },
    },
    // 默认 false：模拟「面板尚未打开」的真实情况（真实编辑器里 visible 只在面板可见时为 true）
    visible: opts.visible ?? false,
    show() {},
    onDidDispose: () => new Disposable(),
    posted,
  };
  provider.resolveWebviewView(view);
  (view as unknown as { __send: (m: unknown) => void }).__send = (m: unknown) => listeners.forEach((l) => l(m));
  __webviewViews.set(viewId, view);
  return view;
}

/** 测试用：向某个 webview view 发消息（模拟用户点击面板里的按钮） */
export function __sendToWebviewView(viewId: string, msg: unknown): void {
  const view = __webviewViews.get(viewId) as (MockWebviewView & { __send?: (m: unknown) => void }) | undefined;
  view?.__send?.(msg);
}

export const messages = {
  info: [] as string[],
  warn: [] as string[],
  error: [] as string[],
  quickPickQueue: [] as unknown[],
  inputBoxQueue: [] as Array<string | undefined>,
  warningChoiceQueue: [] as Array<string | undefined>,
};

export interface MockTab {
  label: string;
  isDirty: boolean;
  input?: unknown;
}

export interface MockTabGroup {
  viewColumn: ViewColumn;
  isActive: boolean;
  isLocked: boolean;
  activeTab?: MockTab;
  tabs: MockTab[];
}

export const mockTabGroups: MockTabGroup[] = [
  { viewColumn: ViewColumn.One, isActive: true, isLocked: false, tabs: [] },
];
export const editorLayouts: unknown[] = [];
export const shownDocuments: Array<{ fsPath: string; viewColumn?: ViewColumn }> = [];
export const statusBarItems: Array<{ text: string; tooltip: string; command?: string; visible: boolean }> = [];

export function __resetTabGroups(groups?: MockTabGroup[]): void {
  mockTabGroups.length = 0;
  if (groups?.length) {
    mockTabGroups.push(...groups);
  } else {
    mockTabGroups.push({ viewColumn: ViewColumn.One, isActive: true, isLocked: false, tabs: [] });
  }
  editorLayouts.length = 0;
  shownDocuments.length = 0;
}

function ensureMockGroup(col: ViewColumn): MockTabGroup {
  let g = mockTabGroups.find((x) => x.viewColumn === col);
  if (!g) {
    g = { viewColumn: col, isActive: false, isLocked: false, tabs: [] };
    mockTabGroups.push(g);
  }
  return g;
}

export const __outputChannels: Array<{ name: string; lines: string[] }> = [];

export const window = {
  activeTextEditor: undefined,
  tabGroups: {
    get all() {
      return mockTabGroups;
    },
    get activeTabGroup() {
      return mockTabGroups.find((g) => g.isActive) ?? mockTabGroups[0];
    },
    async close(tab: MockTab | MockTab[]): Promise<boolean> {
      const list = Array.isArray(tab) ? tab : [tab];
      for (const t of list) {
        for (const g of mockTabGroups) {
          const idx = g.tabs.indexOf(t);
          if (idx >= 0) {
            g.tabs.splice(idx, 1);
            if (g.activeTab === t) g.activeTab = g.tabs[g.tabs.length - 1];
          }
        }
      }
      return true;
    },
  },
  createOutputChannel(name: string) {
    const lines: string[] = [];
    __outputChannels.push({ name, lines });
    return {
      name,
      lines,
      appendLine(line: string) {
        lines.push(line);
      },
      append(line: string) {
        lines.push(line);
      },
      show() {},
      hide() {},
      dispose() {},
      clear() {
        lines.length = 0;
      },
    };
  },
  createStatusBarItem(_align?: StatusBarAlignment, _priority?: number) {
    const item = {
      text: '',
      tooltip: '',
      command: undefined as string | undefined,
      visible: false,
      show() {
        item.visible = true;
      },
      hide() {
        item.visible = false;
      },
      dispose() {
        const i = statusBarItems.indexOf(item);
        if (i >= 0) statusBarItems.splice(i, 1);
      },
    };
    statusBarItems.push(item);
    return item;
  },
  createWebviewPanel(viewType: string, title: string, showOpts?: ViewColumn | { viewColumn?: ViewColumn; preserveFocus?: boolean }) {
    const col = typeof showOpts === 'number' ? showOpts : (showOpts?.viewColumn ?? ViewColumn.One);
    const preserveFocus = typeof showOpts === 'object' ? Boolean(showOpts?.preserveFocus) : false;
    const g = ensureMockGroup(col);
    const webTab: MockTab = { label: title, isDirty: false, input: { viewType } };
    g.tabs.push(webTab);
    g.activeTab = webTab;
    if (!preserveFocus) {
      for (const x of mockTabGroups) x.isActive = x === g;
    }

    const listeners: Array<(msg: unknown) => void> = [];
    const disposeListeners: Array<() => void> = [];
    const panel: MockPanel & { title?: string; iconPath?: unknown } = {
      title,
      webview: {
        html: '',
        options: {},
        cspSource: 'vscode-webview://mock',
        asWebviewUri: (uri: Uri) => uri,
        async postMessage(msg: unknown) {
          postedMessages.push(msg);
          return true;
        },
        onDidReceiveMessage(cb: (msg: unknown) => void) {
          listeners.push(cb);
          webviewListeners.set(title, cb);
          return new Disposable(() => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          });
        },
      },
      visible: true,
      reveal(targetCol?: ViewColumn, pFocus?: boolean) {
        const target = ensureMockGroup(targetCol ?? col);
        if (!pFocus) {
          for (const x of mockTabGroups) x.isActive = x === target;
        }
      },
      onDidDispose(cb: () => void) {
        disposeListeners.push(cb);
        return new Disposable();
      },
      dispose() {
        panel.visible = false;
        void window.tabGroups.close(webTab);
        for (const cb of disposeListeners) cb();
      },
    };
    panels.push(panel);
    return panel;
  },
  async showTextDocument(doc: MockDocument, opts?: { viewColumn?: ViewColumn; preserveFocus?: boolean; preview?: boolean }) {
    const requestedCol = opts?.viewColumn ?? ViewColumn.One;
    // 模拟真实 VS Code 的 revealIfOpen：如果某栏已经有该 URI 的标签页，会直接复用那一栏
    const existingGroup = mockTabGroups.find((g) =>
      g.tabs.some((t) => (t.input as { uri?: Uri } | undefined)?.uri?.fsPath === doc.uri.fsPath),
    );
    const actualGroup = existingGroup ?? ensureMockGroup(requestedCol);
    let tab = actualGroup.tabs.find((t) => (t.input as { uri?: Uri } | undefined)?.uri?.fsPath === doc.uri.fsPath);
    if (!tab) {
      tab = { label: nodePath.basename(doc.uri.fsPath), isDirty: doc.isDirty, input: { uri: doc.uri } };
      actualGroup.tabs.push(tab);
    }
    actualGroup.activeTab = tab;
    if (!opts?.preserveFocus) {
      for (const x of mockTabGroups) x.isActive = x === actualGroup;
    }
    shownDocuments.push({ fsPath: doc.uri.fsPath, viewColumn: actualGroup.viewColumn });
    return { document: doc, viewColumn: actualGroup.viewColumn };
  },
  async showInformationMessage(msg: string, ..._rest: unknown[]) {
    messages.info.push(msg);
    return undefined;
  },
  async showWarningMessage(msg: string, ...rest: unknown[]) {
    messages.warn.push(msg);
    const queued = messages.warningChoiceQueue.shift();
    if (queued !== undefined) return queued;
    // 兼容 (msg, {modal:true}, 'A', 'B') 形态
    const choices = rest.filter((r): r is string => typeof r === 'string');
    return choices[0];
  },
  async showErrorMessage(msg: string, ..._rest: unknown[]) {
    messages.error.push(msg);
    return undefined;
  },
  async showInputBox(_opts?: unknown) {
    return messages.inputBoxQueue.shift();
  },
  async showQuickPick(items: unknown, _opts?: unknown) {
    const queued = messages.quickPickQueue.shift();
    if (queued !== undefined) return queued;
    const arr = items as Array<{ label?: string; description?: string }>;
    return Array.isArray(arr) ? arr[0] : undefined;
  },
  async withProgress(_opts: unknown, task: (progress: unknown, token: { onCancellationRequested: () => Disposable; isCancellationRequested: boolean }) => unknown) {
    return task({ report: () => undefined }, { onCancellationRequested: () => new Disposable(), isCancellationRequested: false });
  },
  onDidChangeActiveTextEditor: () => new Disposable(),
  registerWebviewViewProvider(viewId: string, provider: { resolveWebviewView: (view: MockWebviewView) => void }) {
    viewProviders.set(viewId, provider);
    return new Disposable(() => viewProviders.delete(viewId));
  },
};

// ------------------------------------------------------------------ commands / languages / debug

export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
export const executedCommands: string[] = [];
export const contextKeys = new Map<string, unknown>();

export const commands = {
  /** 测试可指定：这些命令调用时抛错（模拟不支持该命令的编辑器） */
  failCommands: new Set<string>(),
  registerCommand(id: string, cb: (...args: unknown[]) => unknown) {
    registeredCommands.set(id, cb);
    return new Disposable(() => registeredCommands.delete(id));
  },
  async executeCommand(id: string, ...args: unknown[]) {
    executedCommands.push(id);
    if (commands.failCommands.has(id)) throw new Error(`command '${id}' not found`);
    if (id === 'setContext') {
      contextKeys.set(String(args[0]), args[1]);
      return undefined;
    }
    if (id === 'vscode.setEditorLayout') {
      const layout = args[0] as { groups?: unknown[] } | undefined;
      editorLayouts.push(layout);
      const count = layout?.groups?.length ?? 2;
      for (let i = 1; i <= count; i++) ensureMockGroup(i as ViewColumn);
      return undefined;
    }
    if (id === 'workbench.action.lockEditorGroup') {
      const active = window.tabGroups.activeTabGroup;
      if (active) active.isLocked = true;
      return undefined;
    }
    if (id === 'workbench.action.unlockEditorGroup') {
      const active = window.tabGroups.activeTabGroup;
      if (active) active.isLocked = false;
      return undefined;
    }
    if (id === 'workbench.action.focusFirstEditorGroup') {
      const g1 = ensureMockGroup(ViewColumn.One);
      for (const x of mockTabGroups) x.isActive = x === g1;
      return undefined;
    }
    const cb = registeredCommands.get(id);
    return cb ? cb(...args) : undefined;
  },
  async getCommands() {
    return [...registeredCommands.keys()];
  },
};

export const inlineProviders: unknown[] = [];
export const completionProviders: unknown[] = [];

export const languages = {
  registerInlineCompletionItemProvider(_sel: unknown, provider: unknown) {
    inlineProviders.push(provider);
    return new Disposable();
  },
  registerCompletionItemProvider(_sel: unknown, provider: unknown, ..._trigger: string[]) {
    completionProviders.push(provider);
    return new Disposable();
  },
  async setTextDocumentLanguage() {
    return undefined;
  },
};

/** 测试可配置的「已安装扩展」集合（可附带 package.json 以模拟贡献的设置项） */
const installedExtensions = new Map<string, unknown>();
export function __setInstalledExtensions(ids: string[], packages: Record<string, unknown> = {}): void {
  installedExtensions.clear();
  for (const id of ids) installedExtensions.set(id.toLowerCase(), packages[id] ?? packages[id.toLowerCase()]);
}

export const extensions = {
  get all() {
    return [...installedExtensions.entries()].map(([id, packageJSON]) => ({
      id,
      isActive: true,
      activate: async () => ({}),
      packageJSON,
    }));
  },
  getExtension(id: string) {
    return installedExtensions.has(id.toLowerCase()) ? { id, isActive: true, activate: async () => ({}) } : undefined;
  },
};

export const debug = {
  /** 测试可注入：模拟「该 debug type 不支持」等失败 */
  unsupportedTypes: new Set<string>(),
  startedConfigs: [] as unknown[],
  async startDebugging(_folder: unknown, config: unknown) {
    const type = (config as { type?: string } | undefined)?.type ?? '';
    if (debug.unsupportedTypes.has(type)) {
      throw new Error(`配置的类型 ${type} 不受支持。`);
    }
    debug.startedConfigs.push(config);
    return true;
  },
};

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}
export class InlineCompletionItem {
  constructor(
    readonly insertText: string,
    readonly range?: Range,
  ) {}
}
export class CompletionItem {
  kind?: CompletionItemKind;
  documentation?: unknown;
  detail?: string;
  constructor(
    readonly label: string,
    kind?: CompletionItemKind,
  ) {
    this.kind = kind;
  }
}
export class SnippetString {
  constructor(readonly value: string) {}
}
export class MarkdownString {
  constructor(public value: string) {}
}

export const externalOpened: string[] = [];
export const env = {
  appName: 'Visual Studio Code',
  machineId: 'mock',
  sessionId: 'mock',
  async openExternal(uri: { toString(): string }): Promise<boolean> {
    externalOpened.push(uri.toString());
    return true;
  },
};

export interface SharedState {
  globalState: Map<string, unknown>;
  secrets: Map<string, string>;
  workspaceState: Map<string, unknown>;
}

/** 测试用：跨"重启"共享的持久化存储 */
export function __makeSharedState(): SharedState {
  return { globalState: new Map(), secrets: new Map(), workspaceState: new Map() };
}

/** 测试用：构造 ExtensionContext（传 shared 可模拟 IDE 重启后读到同一份存储） */
export function __makeContext(extensionPath: string, storagePath: string, shared: SharedState = __makeSharedState()) {
  const workspaceState = shared.workspaceState;
  const globalState = shared.globalState;
  const secretStore = shared.secrets;
  return {
    extensionPath,
    extensionUri: Uri.file(extensionPath),
    globalStorageUri: Uri.file(nodePath.join(storagePath, 'global')),
    storageUri: Uri.file(storagePath),
    subscriptions: [] as Array<{ dispose(): void }>,
    workspaceState: {
      get<T>(key: string, def?: T): T {
        return (workspaceState.has(key) ? (workspaceState.get(key) as T) : def) as T;
      },
      update: async (key: string, value: unknown) => {
        workspaceState.set(key, value);
      },
      keys: () => [...workspaceState.keys()],
    },
    globalState: {
      get<T>(key: string, def?: T): T {
        return (globalState.has(key) ? (globalState.get(key) as T) : def) as T;
      },
      async update(key: string, value: unknown) {
        if (value === undefined) globalState.delete(key);
        else globalState.set(key, value);
      },
      keys: () => [...globalState.keys()],
    },
    secrets: {
      async get(key: string) {
        return secretStore.get(key);
      },
      async store(key: string, value: string) {
        secretStore.set(key, value);
      },
      async delete(key: string) {
        secretStore.delete(key);
      },
    },
    asAbsolutePath: (rel: string) => nodePath.join(extensionPath, rel),
    extensionMode: 3,
  };
}
