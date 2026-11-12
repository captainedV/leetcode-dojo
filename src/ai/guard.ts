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

/** Copilot：键名稳定，直接尝试写；没装扩展时 update 会抛错，捕获后跳过 */
const COPILOT_TARGETS: SuppressTarget[] = [
  { section: 'github.copilot', key: 'enable', value: { '*': false }, optional: true },
  { section: 'github.copilot', key: 'inlineSuggest.enable', value: false, optional: true },
  { section: 'github.copilot', key: 'nextEditSuggestions.enabled', value: false, optional: true },
];

/** Cursor：这些键不是每个版本都有，必须先 inspect 确认存在（绝不瞎写不存在的键） */
const CURSOR_TARGETS: SuppressTarget[] = [
  { section: 'cursor.cpp', key: 'enableTabCompletion', value: false, optional: true },
  { section: 'cursor.composer', key: 'enableGlobal', value: false, optional: true },
];

interface BackupEntry {
  section: string;
  key: string;
  /** 备份时该键的 workspace 级值；undefined 表示当时没有 workspace 覆盖 */
  workspaceValue: unknown;
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void,
  ) {
    // 重载窗口后 workspaceState 仍在：有备份就说明练习模式还开着，别骗自己说没开
    const backup = this.context.workspaceState.get<GuardBackup>(BACKUP_KEY);
    this.active = Boolean(backup);
    this.changed = backup?.entries.map((e) => `${e.section}.${e.key}`) ?? [];
  }

  get enabled(): boolean {
    return this.active;
  }

  /**
   * 进入练习模式：压制其它 AI 补全设置 + 写 `.cursorignore`。
   * 返回实际改动了哪些配置键，以及一段给用户看的说明。
   */
  async enable(practiceRoot: vscode.Uri): Promise<{ changed: string[]; detail: string }> {
    if (this.active) {
      return { changed: this.changed, detail: '练习模式已开启（AI 补全限制仍在生效）。' };
    }

    const previous = this.context.workspaceState.get<GuardBackup>(BACKUP_KEY);
    const entries: BackupEntry[] = previous?.entries ? [...previous.entries] : [];
    const changed: string[] = [];
    const skipped: string[] = [];

    for (const target of [...COPILOT_TARGETS, ...CURSOR_TARGETS]) {
      // Cursor 的键先探测是否存在，不存在就不写
      const isCursorKey = target.section.startsWith('cursor.');
      if (isCursorKey && !configurationExists(target)) {
        skipped.push(`${fullKey(target)}（未找到该设置项）`);
        continue;
      }
      const config = vscode.workspace.getConfiguration(target.section);
      const inspected = config.inspect(target.key);
      const alreadyBackedUp = entries.some((e) => e.section === target.section && e.key === target.key);
      if (!alreadyBackedUp) {
        entries.push({
          section: target.section,
          key: target.key,
          workspaceValue: inspected?.workspaceValue,
        });
      }
      try {
        await config.update(target.key, target.value, vscode.ConfigurationTarget.Workspace);
        changed.push(fullKey(target));
        this.log(`[aiGuard] 已压制 ${fullKey(target)} = ${JSON.stringify(target.value)}`);
      } catch (err) {
        // 没装对应扩展/键未注册时 VS Code 会拒绝写入：跳过即可，不影响其它项
        skipped.push(`${fullKey(target)}（写入失败）`);
        this.log(
          `[aiGuard] 压制 ${fullKey(target)} 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
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

    const detailParts: string[] = [];
    detailParts.push(
      changed.length
        ? `已限制 ${changed.length} 项 AI 补全设置：${changed.join('、')}`
        : '没有可改的 AI 补全设置（相关扩展可能未安装）',
    );
    if (skipped.length) detailParts.push(`已跳过：${skipped.join('、')}`);
    detailParts.push(
      cursorIgnore.written
        ? `已写入 ${cursorIgnore.path}`
        : `已存在 ${cursorIgnore.path}，未覆盖`,
    );
    detailParts.push(
      '注意：Cursor 的 Tab 补全没有官方工作区级开关，若仍出现补全请手动关闭（Settings → Cursor Tab / 停用 Copilot），新建的设置在部分插件上需要重开窗口才生效。',
    );
    const detail = detailParts.join('；');
    this.log(`[aiGuard] enable 完成：${detail}`);
    return { changed, detail };
  }

  /** 退出练习模式：只还原我们自己改过的那几个键。 */
  async disable(): Promise<void> {
    if (!this.active) {
      this.log('[aiGuard] disable 被调用，但当前并未开启练习模式（忽略）');
      return;
    }
    const backup = this.context.workspaceState.get<GuardBackup>(BACKUP_KEY);
    if (!backup || !backup.entries.length) {
      this.active = false;
      this.changed = [];
      await this.context.workspaceState.update(BACKUP_KEY, undefined);
      this.log('[aiGuard] 没有备份可还原');
      return;
    }
    const restored: string[] = [];
    for (const entry of backup.entries) {
      const config = vscode.workspace.getConfiguration(entry.section);
      try {
        // undefined 表示删掉 workspace 级覆盖，恢复成用户/默认值
        await config.update(
          entry.key,
          entry.workspaceValue === undefined ? undefined : entry.workspaceValue,
          vscode.ConfigurationTarget.Workspace,
        );
        restored.push(`${entry.section}.${entry.key}`);
        this.log(`[aiGuard] 已还原 ${entry.section}.${entry.key}`);
      } catch (err) {
        this.log(
          `[aiGuard] 还原 ${entry.section}.${entry.key} 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this.context.workspaceState.update(BACKUP_KEY, undefined);
    this.active = false;
    this.changed = [];
    // `.cursorignore` 故意保留：删掉它反而让 AI 在下次进入练习模式前就索引了题目
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
