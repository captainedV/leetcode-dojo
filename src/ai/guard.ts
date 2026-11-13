/**
 * AI 守卫：进入练习模式时，临时把「其它 AI 补全插件」在题目目录里压下去。
 *
 * 诚实说明（这点必须写在代码里，别让用户以为开了就万无一失）：
 * - VS Code 的扩展只能改**工作区设置**，改不了别的扩展的行为本身。Coupon 类插件
 *   （Copilot / Cursor）是否立刻响应设置变化由它们自己决定，通常需要重开窗口。
 * - Cursor 的 Tab 补全**没有官方的工作区级开关**（官方设置是全局/用户级），
 *   所以这里只能对已知的 `cursor.*` 配置项做尽力而为的压制，并在 detail 里提示
 *   用户手动关闭；`.cursorignore` 也只是让 AI 索引/上下文忽略该目录，不阻止 Tab。
 * - 我们只恢复「自己改过的键」，用户原本的值（含 workspace 级覆盖）来自备份。
 */
import * as vscode from 'vscode';

/** backups 存在 workspaceState 里的 key */
const BACKUP_KEY = 'lcLocal.aiGuard.backup';

interface SuppressTarget {
  /** 配置节，例如 `github.copilot` */
  section: string;
  /** 节内的键，例如 `inlineSuggest.enable` */
  key: string;
  /** 压制时写入的值 */
  value: unknown;
  /** true 表示「该扩展可能没装」：写失败只记日志不报错 */
  optional: boolean;
}

/**
 * 精选键（即使扩展未装也值得尝试）：Copilot 的 `enable` 是按 languageId 的开关，
 * 是官方文档里唯一能"按语言关掉补全"的键。
 */
const CURATED_TARGETS: SuppressTarget[] = [
  { section: 'github.copilot', key: 'enable', value: { '*': false }, optional: true },
  // 旧版本用 inlineSuggest.enable，新版本（内置 copilot-chat 0.66+）已移除；写失败会被自动跳过
  { section: 'github.copilot', key: 'inlineSuggest.enable', value: false, optional: true },
  { section: 'github.copilot', key: 'nextEditSuggestions.enabled', value: false, optional: true },
  { section: 'cursor.cpp', key: 'enableTabCompletion', value: false, optional: true },
  { section: 'cursor.composer', key: 'enableGlobal', value: false, optional: true },
];

/** 这些键与「编辑器内的 AI 行为」无关（聊天、索引、组织策略…），不碰 */
const IGNORED_KEY_PATTERN = /\.chat\.|organization|codesearch|mcp|agent|prompt|telemetry|index/i;
/** 认为是「AI 生成/补全」相关的键 */
const RELEVANT_KEY_PATTERN = /enable|enabled|inline|complet|suggest|tab/i;

type ConfigScope = 'workspace' | 'user';

interface DiscoveredTarget extends SuppressTarget {
  /** 解释这条键是从哪来的，便于日志 */
  origin: string;
}

interface ContributionShape {
  properties?: Record<string, { default?: unknown; type?: string; description?: string }>;
}

/** 从扩展的 package.json 里读出它贡献的配置节与键 */
function readContributedSettings(pkg: unknown): Array<{ section: string; key: string; def: unknown; type?: string }> {
  const out: Array<{ section: string; key: string; def: unknown; type?: string }> = [];
  const contributes = (pkg as { contributes?: { configuration?: unknown } } | undefined)?.contributes;
  const configuration = contributes?.configuration;
  if (!configuration) return out;
  const blocks: Array<ContributionShape & { title?: string }> = Array.isArray(configuration)
    ? (configuration as ContributionShape[])
    : [configuration as ContributionShape];
  for (const block of blocks) {
    for (const [fullKey, schema] of Object.entries(block.properties ?? {})) {
      const dot = fullKey.indexOf('.');
      if (dot <= 0) continue;
      out.push({
        section: fullKey.slice(0, dot),
        key: fullKey.slice(dot + 1),
        def: schema?.default,
        type: schema?.type,
      });
    }
  }
  return out;
}

/**
 * 自动发现「Copilot / Cursor 的 AI 补全相关设置键」。
 *
 * 为什么要发现而不是写死：VS Code 1.138 把 Copilot 变成内置扩展（copilot-chat 0.66），
 * 键名已经变过（`inlineSuggest.enable` 被移除、新增 `nextEditSuggestions.*` 等）。
 * 写死不存在的键会被 VS Code 拒绝，写死新键又会过时——所以直接读已装扩展的贡献项。
 */
function discoverTargets(log?: (line: string) => void): DiscoveredTarget[] {
  const found: DiscoveredTarget[] = [];
  let extensions: readonly { id?: string; packageJSON?: unknown }[] = [];
  try {
    extensions = vscode.extensions?.all ?? [];
  } catch {
    return found;
  }
  const related = extensions.filter((e) => /copilot|cursor/i.test(e.id ?? ''));
  log?.(
    `[aiGuard] 扫描扩展：共 ${extensions.length} 个，AI 相关 ${related.length} 个${
      related.length ? `（${related.map((e) => e.id).join(', ')}）` : ''
    }`,
  );
  for (const ext of extensions) {
    const id = (ext.id ?? '').toLowerCase();
    if (!/copilot|cursor/.test(id)) continue;
    const contributed = readContributedSettings(ext.packageJSON);
    log?.(`[aiGuard] ${ext.id} 贡献了 ${contributed.length} 项设置`);
    for (const item of contributed) {
      const full = `${item.section}.${item.key}`;
      if (IGNORED_KEY_PATTERN.test(full) || !RELEVANT_KEY_PATTERN.test(item.key)) continue;
      if (item.type === 'boolean' && item.def === true) {
        found.push({ section: item.section, key: item.key, value: false, optional: true, origin: id });
      }
    }
  }
  return found;
}

interface BackupEntry {
  section: string;
  key: string;
  /** 备份时该键在「我们写入的作用域」里的原值；undefined 表示原本没有覆盖 */
  previousValue: unknown;
  /** 我们写到了哪个作用域 */
  scope: ConfigScope;
}

interface GuardBackup {
  at: string;
  root: string;
  entries: BackupEntry[];
  /** 我们写过的 `.cursorignore` 路径（已存在则没写，这里不记录） */
  cursorIgnore?: string;
}

const CURSOR_IGNORE_BODY = [
  '# LeetCode Dojo：练习模式',
  '# 让 Cursor 的 AI 索引/上下文忽略题目代码，避免整题被自动补全。',
  '# （Cursor 的 Tab 补全无法按目录关闭，请在 Cursor 设置里手动关闭或降低强度。）',
  '*',
  '',
].join('\n');

function fullKey(target: SuppressTarget): string {
  return `${target.section}.${target.key}`;
}

/** 该配置键在当前环境里是否真的存在（用 inspect 判断默认值/各级值是否出现过） */
function configurationExists(target: SuppressTarget): boolean {
  try {
    const inspected = vscode.workspace.getConfiguration(target.section).inspect(target.key);
    if (!inspected) return false;
    return (
      inspected.defaultValue !== undefined ||
      inspected.globalValue !== undefined ||
      inspected.workspaceValue !== undefined ||
      inspected.workspaceFolderValue !== undefined
    );
  } catch {
    return false;
  }
}

export class AiGuard {
  private active = false;
  /** 本次 enable 实际改动的键，供 UI 展示 */
  private changed: string[] = [];
  /** 本次压制实际写入的作用域（诊断用） */
  private scope?: ConfigScope;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void,
  ) {
    // 重载窗口后 workspaceState 仍在：有备份就说明练习模式还开着，别骗自己说没开
    const backup = this.context.workspaceState.get<GuardBackup>(BACKUP_KEY);
    this.active = Boolean(backup);
    this.changed = backup?.entries.map((e) => `${e.section}.${e.key}`) ?? [];
  }

  /** 诊断：把关键键的实际生效值列出来（用户能不能被压住，一看就知道） */
  effectiveValues(): string[] {
    const keys = [
      ['github.copilot', 'enable'],
      ['github.copilot', 'nextEditSuggestions.enabled'],
      ['github.copilot', 'inlineSuggest.enable'],
      ['github.copilot', 'editor.enableCodeActions'],
      ['editor', 'inlineSuggest.enabled'],
      ['cursor.cpp', 'enableTabCompletion'],
    ] as const;
    const out: string[] = [];
    for (const [section, key] of keys) {
      try {
        const inspected = vscode.workspace.getConfiguration(section).inspect(key);
        if (!inspected) {
          out.push(`${section}.${key}=未注册（该版本/该账号下可能未启用）`);
          continue;
        }
        const scope =
          inspected.workspaceValue !== undefined ? '工作区' : inspected.globalValue !== undefined ? '用户' : '默认';
        const value =
          inspected.workspaceValue !== undefined
            ? inspected.workspaceValue
            : inspected.globalValue !== undefined
              ? inspected.globalValue
              : inspected.defaultValue;
        out.push(`${section}.${key}=${JSON.stringify(value)}(${scope})`);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  /** 诊断信息：作用域与已压制的键 */
  describe(): string {
    const scope = this.scope === 'user' ? '用户设置（全局）' : this.scope === 'workspace' ? '工作区设置' : '未写入';
    return `${this.active ? '开' : '关'} / ${scope} / ${this.changed.length} 项`;
  }

  get enabled(): boolean {
    return this.active;
  }

  /**
   * 进入练习模式：压制其它 AI 补全设置 + 写 `.cursorignore`。
   * 返回实际改动了哪些配置键，以及一段给用户看的说明。
   */
  /**
   * 进入练习模式：压制其它 AI 补全。
   *
   * 作用域策略：优先写**工作区设置**（只影响当前窗口）；若当前窗口没有打开文件夹，
   * 写工作区设置会被 VS Code 拒绝 —— 这是之前"完全没生效"的主要原因，
   * 此时降级为**用户设置**（全局生效，但退出练习模式时精确还原），并在日志/提示里说明。
   */
  async enable(practiceRoot: vscode.Uri): Promise<{ changed: string[]; detail: string }> {
    if (this.active) {
      return { changed: this.changed, detail: '练习模式已开启（AI 补全限制仍在生效）。' };
    }

    const previous = this.context.workspaceState.get<GuardBackup>(BACKUP_KEY);
    const entries: BackupEntry[] = previous?.entries ? [...previous.entries] : [];
    const changed: string[] = [];
    const skipped: string[] = [];
    const usedScopes = new Set<ConfigScope>();

    // 精选键 + 从内置/已装扩展里自动发现的键（去看看它现在还叫不叫这个名字）
    const discovered = discoverTargets((l) => this.log(l));
    // 激进模式：连编辑器的灰字补全（editor.inlineSuggest）一起关掉。
    // 代价是本插件自己的 ghost text 也会失效（签名提示仍然可用），但能彻底静音 Copilot。
    const aggressive = vscode.workspace.getConfiguration('lcLocal').get<boolean>('aiGuard.aggressive', false);
    if (aggressive) {
      discovered.push({ section: 'editor', key: 'inlineSuggest.enabled', value: false, optional: true, origin: 'aggressive' });
    }
    const targets: DiscoveredTarget[] = [];
    const seen = new Set<string>();
    for (const t of [...CURATED_TARGETS.map((x) => ({ ...x, origin: 'curated' })), ...discovered]) {
      const full = fullKey(t);
      if (seen.has(full)) continue;
      seen.add(full);
      targets.push(t);
    }

    // 从扩展 package.json 里发现的键一定是合法键；即使 inspect 取不到（扩展尚未注册设置）也应该写
    const discoveredKeys = new Set(discovered.map((t) => fullKey(t)));
    for (const target of targets) {
      const registered = configurationExists(target);
      // Copilot 的键：即使当前窗口里 Copilot 尚未注册（例如刚登录/未启用），也照写——
      // VS Code 接受写入，Copilot 在就生效；退出练习模式时会清理掉，不留垃圾。
      // Cursor 的键：不在就跳过（不同版本差异大，避免写死键名污染用户设置）。
      const alwaysWrite = target.section === 'github.copilot';
      // 既不在已注册设置里、也不是该扩展贡献/精选键 → 跳过
      if (!registered && !alwaysWrite && !discoveredKeys.has(fullKey(target))) {
        skipped.push(`${fullKey(target)}（未找到该设置项）`);
        continue;
      }
      const config = vscode.workspace.getConfiguration(target.section);
      // 先记下原值（必须在写入之前，否则备份到的就是我们自己写进去的值）
      const before = config.inspect(target.key);
      const alreadyBackedUp = entries.some((e) => e.section === target.section && e.key === target.key);
      const applied = await this.updateWithBestScope(config, target);
      if (!applied.scope) {
        skipped.push(`${fullKey(target)}（写入失败：${applied.error ?? '未知原因'}）`);
        continue;
      }
      if (!registered) {
        this.log(`[aiGuard] ${fullKey(target)} 当前未注册（Copilot 可能未启用），仍写入以便启用后立即生效`);
      }
      usedScopes.add(applied.scope);
      changed.push(fullKey(target));
      if (!alreadyBackedUp) {
        entries.push({
          section: target.section,
          key: target.key,
          scope: applied.scope,
          previousValue: applied.scope === 'user' ? before?.globalValue : before?.workspaceValue,
        });
      }
      // 写后校验：读回生效值，别"以为写了"
      const effective = config.inspect(target.key);
      const actual = applied.scope === 'user' ? effective?.globalValue : effective?.workspaceValue;
      this.log(
        `[aiGuard] 已压制 ${fullKey(target)} = ${JSON.stringify(actual)}（${applied.scope === 'user' ? '用户' : '工作区'}设置${
          target.origin === 'curated' ? '' : `，来自 ${target.origin}`
        }）`,
      );
    }

    const cursorIgnore = await this.ensureCursorIgnore(practiceRoot);
    const backup: GuardBackup = {
      at: new Date().toISOString(),
      root: practiceRoot.fsPath,
      entries,
      cursorIgnore: cursorIgnore.written ? cursorIgnore.path : previous?.cursorIgnore,
    };
    await this.context.workspaceState.update(BACKUP_KEY, backup);

    this.active = true;
    this.changed = changed;
    const scopeText = [...usedScopes].map((sc) => (sc === 'user' ? '用户设置（全局）' : '工作区设置')).join(' + ');
    this.scope = [...usedScopes][0];

    const detailParts: string[] = [];
    detailParts.push(
      changed.length
        ? `已限制 ${changed.length} 项 AI 补全设置（写入${scopeText || '设置'}）：${changed.slice(0, 6).join('、')}${changed.length > 6 ? ' …' : ''}`
        : '没有可改的 AI 补全设置（相关扩展可能未安装）',
    );
    if (skipped.length) detailParts.push(`已跳过：${skipped.slice(0, 6).join('、')}${skipped.length > 6 ? ' …' : ''}`);
    detailParts.push(cursorIgnore.written ? `已写入 ${cursorIgnore.path}` : `已存在 ${cursorIgnore.path}，未覆盖`);
    if (aggressive) {
      detailParts.push('已开启激进模式：连编辑器的灰字补全一起关闭（本插件的 ghost text 也会停用，签名提示仍可用）');
    }
    if (usedScopes.has('user')) {
      detailParts.push('当前窗口没有打开文件夹，因此写入了**用户设置**（全局生效），退出练习模式时会自动还原');
    }
    detailParts.push('Copilot 的设置变更可能需要重载窗口才完全生效（命令：Developer: Reload Window）');
    const detail = detailParts.join('；');
    this.log(`[aiGuard] enable 完成：${detail}`);
    return { changed, detail };
  }

  /**
   * 写一个键：先尝试工作区作用域，失败（没有打开文件夹 / 键被锁定）再降级到用户作用域。
   * 返回实际使用的作用域。
   */
  private async updateWithBestScope(
    config: vscode.WorkspaceConfiguration,
    target: SuppressTarget,
  ): Promise<{ scope?: ConfigScope; error?: string }> {
    const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const order: ConfigScope[] = hasFolder ? ['workspace', 'user'] : ['user', 'workspace'];
    let lastError: string | undefined;
    for (const scope of order) {
      try {
        await config.update(
          target.key,
          target.value,
          scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace,
        );
        return { scope };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return { error: lastError };
  }

  /** 退出练习模式：只还原我们自己改过的那几个键（按当时写入的作用域）。 */
  async disable(): Promise<void> {
    if (!this.active) {
      this.log('[aiGuard] disable 被调用，但当前并未开启练习模式（忽略）');
      return;
    }
    const backup = this.context.workspaceState.get<GuardBackup>(BACKUP_KEY);
    if (!backup || !backup.entries.length) {
      this.active = false;
      this.changed = [];
      this.scope = undefined;
      await this.context.workspaceState.update(BACKUP_KEY, undefined);
      this.log('[aiGuard] 没有备份可还原');
      return;
    }
    const restored: string[] = [];
    for (const entry of backup.entries) {
      const config = vscode.workspace.getConfiguration(entry.section);
      try {
        // undefined 表示删掉该作用域的覆盖，恢复成更宽松作用域/默认值
        await config.update(
          entry.key,
          entry.previousValue === undefined ? undefined : entry.previousValue,
          entry.scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace,
        );
        restored.push(`${entry.section}.${entry.key}`);
        this.log(`[aiGuard] 已还原 ${entry.section}.${entry.key}（${entry.scope === 'user' ? '用户' : '工作区'}）`);
      } catch (err) {
        this.log(
          `[aiGuard] 还原 ${entry.section}.${entry.key} 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this.context.workspaceState.update(BACKUP_KEY, undefined);
    this.active = false;
    this.changed = [];
    this.scope = undefined;
    this.log(`[aiGuard] disable 完成，已还原 ${restored.length} 项设置（.cursorignore 保留）`);
  }

  /** 写 `.cursorignore`（已存在则不覆盖，避免踩用户的文件）。 */
  private async ensureCursorIgnore(practiceRoot: vscode.Uri): Promise<{ written: boolean; path: string }> {
    const target = vscode.Uri.joinPath(practiceRoot, '.cursorignore');
    try {
      await vscode.workspace.fs.stat(target);
      return { written: false, path: target.fsPath };
    } catch {
      // 不存在才写
    }
    try {
      await vscode.workspace.fs.createDirectory(practiceRoot);
      await vscode.workspace.fs.writeFile(target, Buffer.from(CURSOR_IGNORE_BODY, 'utf8'));
      this.log(`[aiGuard] 已写入 ${target.fsPath}`);
      return { written: true, path: target.fsPath };
    } catch (err) {
      this.log(
        `[aiGuard] 写 .cursorignore 失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return { written: false, path: target.fsPath };
    }
  }
}
