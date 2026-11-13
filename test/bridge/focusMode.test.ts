/**
 * 回归守卫：「只显示题面」不能改写 FlexLayout 元素的 inline style。
 *
 * 曾经的实现直接写 `el.style.setProperty('width','100%','important')`，关闭焦点模式时再
 * `removeProperty` 掉；结果 FlexLayout 对题面那一栏的尺寸模型被破坏，那一栏变成 0x0
 * （表现就是「题目描述 / 题解 / 提交记录 这一栏被折叠，只有切回完整网页才能展开」）。
 * 现在改成：只打标记类 + CSS `!important`，站点 inline 样式一个字节都不动。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '..', '..', 'src', 'bridge', 'bridge.ts'), 'utf8');

describe('焦点模式实现约束', () => {
  it('通过标记类 + CSS 选择器实现，而不是逐元素写 inline style', () => {
    expect(source).toContain("const DESC_TABSET_CLASS = 'lc-desc-tabset'");
    expect(source).toContain("const DESC_PANE_CLASS = 'lc-desc-pane'");
    expect(source).toContain('html.lc-focus .flexlayout__layout > .flexlayout__tabset:not(.${DESC_TABSET_CLASS})');
    expect(source).toContain('clearFocusMarkers');
  });

  it('不再对布局元素写/删几何 inline 样式（宽度、位置）', () => {
    expect(source).not.toMatch(/setProperty\(\s*['"](width|height|left|top)['"]/);
    expect(source).not.toMatch(/style\.removeProperty\(/);
  });

  it('只在根节点上设置一个 CSS 变量告知标签栏高度', () => {
    expect(source).toContain("root.style.setProperty('--lc-desc-top'");
  });

  it('只在题目页生效（避免误伤题库 / 学习计划列表）', () => {
    expect(source).toMatch(/!currentSlug\(\)/);
  });

  it('兼容站点自身把该栏折叠的情况（collapsed 态强制展开）', () => {
    expect(source).toContain('flexlayout__tabset--collapsed');
  });
});
