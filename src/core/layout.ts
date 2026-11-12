/**
 * 窗口分栏编排器：负责把编辑器自动维护为「左栏网页题面 + 右栏本地代码 + 底部测试面板」的标准三区布局。
 *
 * 解决的核心痛点：
 *  1. 单栏工作区进入 LeetCode 模式时不自动拆出右栏，需要用户手动点编辑器拆分按钮；
 *  2. VS Code / Cursor 默认开启 `workbench.editor.revealIfOpen`：若代码文件上次留在左栏，
 *     `showTextDocument(doc, { viewColumn: ViewColumn.Two })` 会直接激活左栏旧标签页并把题面盖住；
 *  3. 左栏未锁定时，从文件树点开文件、`cases.json` 或断点调试跳转会把文件开在左栏遮挡题面。
 */
import * as vscode from 'vscode';

export interface LayoutConfig {
  autoSplit: boolean;
  leftRatio: number;
  lockLeftGroup: boolean;
}

export function readLayoutConfig(): LayoutConfig {
  const cfg = vscode.workspace.getConfiguration('lcLocal');
  const rawRatio = cfg.get<number>('layout.leftRatio', 0.45);
  const leftRatio = Number.isFinite(rawRatio) ? Math.min(0.7, Math.max(0.25, rawRatio)) : 0.45;
  return {
    autoSplit: cfg.get<boolean>('layout.autoSplit', true),
    leftRatio,
    lockLeftGroup: cfg.get<boolean>('layout.lockLeftGroup', true),
  };
}

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input as { uri?: vscode.Uri } | undefined;
  if (input && typeof input === 'object' && input.uri && typeof input.uri.fsPath === 'string') {
    return input.uri;
  }
  return undefined;
}

/**
 * 判断一个标签页是不是 webview。
 *
 * 注意：`TabInputWebview.viewType` 在 VS Code 里会带 `mainThreadWebview-` 前缀
 * （实测 `createWebviewPanel('lcLocal.site')` → `mainThreadWebview-lcLocal.site`），
 * 所以不能用全等匹配——这正是之前「锁左栏/守护」完全没生效的原因。
 */
export function isWebviewTab(tab: vscode.Tab, expectedViewType?: string): boolean {
  const input = tab.input as { viewType?: string } | undefined;
  const viewType = input && typeof input === 'object' ? input.viewType : undefined;
  if (typeof viewType !== 'string') return false;
  if (!expectedViewType) return true;
  return viewType === expectedViewType || viewType.endsWith(`-${expectedViewType}`) || viewType.endsWith(expectedViewType);
}

function isGroupLocked(group: vscode.TabGroup | undefined): boolean {
  if (!group) return false;
  return Boolean((group as unknown as { isLocked?: boolean }).isLocked);
}

export class WorkspaceLayoutManager {
  private lockedByUs = false;
  private evacuating = false;
  private guarding: vscode.Disposable[] = [];
  private fixTimer?: ReturnType<typeof setTimeout>;
  private fixing = false;
  private isOurWebview: (tab: vscode.Tab) => boolean = () => false;

  constructor(private readonly log: (line: string) => void) {}

  /** 当前打开的编辑器分栏组数量 */
  groupCount(): number {
    try {
      return vscode.window.tabGroups?.all?.length ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * 启动「布局守护」。
   *
   * 为什么不能只靠 `workbench.action.lockEditorGroup`：实测（VS Code 1.138 / Cursor 1.128）
   * 该命令执行后 `tabGroups.all[0].isLocked` 仍然是 false，锁左栏并不生效。
   * 于是用户只要在左栏打开任何文件（点文件树、cases.json、断点跳转），题面就被盖住，
   * 看上去就像「自动分栏没生效」。这里改成主动守护：左栏一旦出现普通文件，就搬回右栏。
   */
  startGuarding(isOurWebview: (tab: vscode.Tab) => boolean): void {
    this.isOurWebview = isOurWebview;
    this.stopGuarding();
    try {
      this.guarding.push(
        vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleFix('tabs')),
        vscode.window.tabGroups.onDidChangeTabGroups(() => this.scheduleFix('groups')),
      );
      this.log('[layout] 布局守护已启动（左栏只放题面，其它文件自动归位到右栏）');
    } catch (err) {
      this.log(`[layout] 启动布局守护失败：${(err as Error).message}`);
    }
  }

  stopGuarding(): void {
    for (const d of this.guarding) d.dispose();
    this.guarding = [];
    if (this.fixTimer) {
      clearTimeout(this.fixTimer);
      this.fixTimer = undefined;
    }
  }

  private scheduleFix(reason: string): void {
    if (this.fixTimer) return;
    this.fixTimer = setTimeout(() => {
      this.fixTimer = undefined;
      void this.fixLayout(reason);
    }, 200);
  }

  /** 守护逻辑：单栏 → 补分栏；左栏出现普通文件 → 搬回右栏 */
  private async fixLayout(reason: string): Promise<void> {
    if (this.fixing) return;
    const cfg = readLayoutConfig();
    if (!cfg.autoSplit) return;
    const groups = vscode.window.tabGroups?.all;
    if (!groups?.length) return;
    const hasPanel = groups.some((g) => g.tabs.some((t) => this.isOurWebview(t)));
    this.log(
      `[layout] guard(${reason}) groups=${groups.length} 检测到题面=${hasPanel} 左栏=[${groups[0]?.tabs
        .map((t) => (this.isOurWebview(t) ? '[webview]' : t.label))
        .join(', ')}]`,
    );
    if (!hasPanel) return; // 不在题目模式
    this.fixing = true;
    try {
      const left = groups[0];
      const right = groups[1];
      if (!right) {
        // 只剩一栏（用户拖掉了或者被合并了）：补回来
        await this.ensureTwoColumnLayout(true);
        this.log(`[layout] 检测到只剩一栏（${reason}），已重新分栏`);
        return;
      }
      const moved = await this.moveLeftTextTabsToRight(`守护/${reason}`);
      if (!moved) this.log(`[layout] 左栏有文件但未能搬运（${reason}）`);
    } catch (err) {
      this.log(`[layout] guard 执行出错：${(err as Error).message}`);
    } finally {
      this.fixing = false;
    }
  }

  /** 当前布局的文字摘要（诊断用） */
  describe(): string {
    const groups = vscode.window.tabGroups?.all ?? [];
    return groups
      .map((g, i) => {
        const tabs = g.tabs.map((t) => (this.isOurWebview(t) ? '[题面]' : t.label)).join(', ') || '空';
        return `#${i + 1}(col${g.viewColumn}${g.isActive ? ',激活' : ''}${isGroupLocked(g) ? ',锁定' : ''})=${tabs}`;
      })
      .join(' | ');
  }

  /**
   * 确保工作区至少划分为左右两栏。
   * @param force 为 true 时即使已有 ≥2 栏也强制重置比例（用于「分栏归位」命令）
   */
  async ensureTwoColumnLayout(force = false): Promise<boolean> {
    const cfg = readLayoutConfig();
    if (!force && !cfg.autoSplit) return false;
    const count = this.groupCount();
    if (!force && count >= 2) return true;

    const left = Number(cfg.leftRatio.toFixed(2));
    const right = Number((1 - left).toFixed(2));
    try {
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{ size: left }, { size: right }],
      });
      this.log(`[layout] 已自动设置左右分栏（左 ${Math.round(left * 100)}% / 右 ${Math.round(right * 100)}%）`);
      return true;
    } catch (err) {
      this.log(`[layout] setEditorLayout 不可用：${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 把左栏（Group 1）里除 Webview 外的普通文本标签页迁移到右栏（Group 2），
   * 保证左栏专用于展示 LeetCode 网页题面，用户原有的代码留在右栏不丢失。
   */
  /** 左栏的普通文件全部搬到右栏（先开右栏副本再关左栏副本，不丢内容也不丢未保存状态） */
  async moveLeftTextTabsToRight(reason: string): Promise<number> {
    const groups = vscode.window.tabGroups?.all;
    const left = groups?.[0];
    const right = groups?.[1];
    if (!left || !right) return 0;
    const strays = left.tabs.filter((t) => !this.isOurWebview(t) && tabUri(t)?.scheme === 'file');
    let moved = 0;
    for (const tab of strays) {
      const uri = tabUri(tab);
      if (!uri) continue;
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          viewColumn: right.viewColumn,
          preserveFocus: true,
          preview: false,
        });
        await vscode.window.tabGroups.close(tab, true);
        moved += 1;
      } catch (err) {
        this.log(`[layout] 搬运 ${tab.label} 失败：${(err as Error).message}`);
      }
    }
    if (moved) this.log(`[layout] 已把左栏 ${moved} 个文件搬到右栏（${reason}）`);
    return moved;
  }

  async evacuateLeftTextTabs(): Promise<void> {
    if (this.evacuating) return;
    const groups = vscode.window.tabGroups?.all;
    if (!groups?.length) return;
    const leftGroup = groups.find((g) => g.viewColumn === vscode.ViewColumn.One);
    if (!leftGroup) return;

    const textTabs = leftGroup.tabs.filter((t) => !isWebviewTab(t) && !!tabUri(t));
    if (!textTabs.length) return;

    this.evacuating = true;
    try {
      // 保留左栏原先激活的那份文本文件到右栏展示，其余非脏重复标签从左栏关闭或迁往右栏
      const activeUri =
        (leftGroup.activeTab && !isWebviewTab(leftGroup.activeTab) ? tabUri(leftGroup.activeTab) : undefined) ??
        tabUri(textTabs[textTabs.length - 1]);

      for (const tab of textTabs) {
        const uri = tabUri(tab);
        if (!uri || uri.scheme !== 'file') continue;
        if (tab.isDirty) {
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
          if (doc?.isDirty) {
            try {
              await doc.save();
            } catch {
              continue; // 无法保存的脏文件绝不强关
            }
          } else {
            continue;
          }
        }
        try {
          await vscode.window.tabGroups.close(tab, true);
        } catch {
          /* ignore */
        }
      }

      if (activeUri && activeUri.scheme === 'file') {
        try {
          const doc = await vscode.workspace.openTextDocument(activeUri);
          await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Two,
            preserveFocus: true,
            preview: false,
          });
        } catch {
          /* ignore */
        }
      }
    } finally {
      this.evacuating = false;
    }
  }

  /**
   * 锁定左栏编辑器组（需要左栏当前处于聚焦态时调用），防止后续打开文件或断点跳转覆盖左栏题面。
   */
  async lockLeftEditorGroup(): Promise<void> {
    const cfg = readLayoutConfig();
    if (!cfg.lockLeftGroup) return;
    try {
      const leftGroup = vscode.window.tabGroups?.all?.find((g) => g.viewColumn === vscode.ViewColumn.One);
      if (isGroupLocked(leftGroup)) return;
      await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
      this.lockedByUs = true;
      this.log('[layout] 已锁定左栏编辑器组（新打开文件将自动落入右栏）');
    } catch {
      /* 部分宿主版本可能不支持该命令，静默降级 */
    }
  }

  /** 退出模式时解锁我们锁定的左栏 */
  async unlockLeftEditorGroupIfNeeded(): Promise<void> {
    if (!this.lockedByUs) return;
    this.lockedByUs = false;
    try {
      const leftGroup = vscode.window.tabGroups?.all?.find((g) => g.viewColumn === vscode.ViewColumn.One);
      if (leftGroup && !isGroupLocked(leftGroup)) return;
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      await vscode.commands.executeCommand('workbench.action.unlockEditorGroup');
    } catch {
      /* ignore */
    }
  }

  /**
   * 强制在右栏（ViewColumn.Two）打开文档。
   * 若该文件已在左栏（ViewColumn.One）存在标签页，先安全移除左栏副本，绕过 `revealIfOpen` 把焦点拉回左栏。
   */
  async openDocumentInRightColumn(
    uri: vscode.Uri,
    opts: { preserveFocus?: boolean; preview?: boolean } = {},
  ): Promise<vscode.TextEditor> {
    await this.ensureTwoColumnLayout(false);

    // 清理左栏里同路径的旧标签页，防止 revealIfOpen 抢回左栏盖住网页
    try {
      const leftGroup = vscode.window.tabGroups?.all?.find((g) => g.viewColumn === vscode.ViewColumn.One);
      if (leftGroup) {
        const dupTabs = leftGroup.tabs.filter((t) => tabUri(t)?.fsPath === uri.fsPath);
        for (const tab of dupTabs) {
          if (tab.isDirty) {
            const dirtyDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
            if (dirtyDoc?.isDirty) await dirtyDoc.save();
          }
          await vscode.window.tabGroups.close(tab, true);
        }
      }
    } catch {
      /* ignore */
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: opts.preserveFocus ?? false,
      preview: opts.preview ?? false,
    });
  }
}
