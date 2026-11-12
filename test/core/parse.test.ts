import { describe, expect, it } from 'vitest';
import {
  buildTestCases,
  compareOutputEx,
  parseCustomInput,
  unorderedEquivalent,
  cleanExpected,
  compareOutput,
  htmlToMarkdown,
  looseEqualArg,
  normalizeOutput,
  parseExamples,
  parseMetaData,
  splitExampleTestcases,
  splitInputArgs,
  splitNamedArgs,
  splitTopLevel,
} from '../../src/core/parse.js';

const META_TWO_SUM = JSON.stringify({
  name: 'twoSum',
  params: [
    { name: 'nums', type: 'integer[]' },
    { name: 'target', type: 'integer' },
  ],
  return: { type: 'integer[]', size: 2 },
});

/** 站点真实写法 A：<pre> 块（英文站老格式） */
const CONTENT_PRE = `<p>Given nums...</p>
<pre>
<strong>Input:</strong> nums = [2,7,11,15], target = 9
<strong>Output:</strong> [0,1]
<strong>Explanation:</strong> Because nums[0] + nums[1] == 9.
</pre>
<pre>
<strong>Input:</strong> nums = [3,2,4], target = 6
<strong>Output:</strong> [1,2]
</pre>`;

/** 站点真实写法 B：<p> 包着 <code>（leetcode.cn 实际返回的形式） */
const CONTENT_P = `<p><strong>Example 1:</strong></p>

<p><strong>Input:</strong> <code>nums = [2,7,11,15], target = 9</code></p>

<p><strong>Output:</strong> <code>[0,1]</code></p>

<p><strong>Explanation:</strong></p>

<p>The sum of <code>nums[0]</code> and <code>nums[1]</code> is 9.</p>

<p><strong>Example 2:</strong></p>

<p><strong>输入：</strong>nums = [3,2,4], target = 6</p>

<p><strong>输出：</strong>[1,2]</p>`;

const EXAMPLES_CN = '[2,7,11,15]\n9\n[3,2,4]\n6';

describe('parseExamples 兼容两种题面写法', () => {
  it('<pre> 写法（英文）', () => {
    const blocks = parseExamples(CONTENT_PRE);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].input).toContain('[2,7,11,15]');
    expect(blocks[0].output).toBe('[0,1]');
    expect(blocks[1].output).toBe('[1,2]');
  });

  it('<p><code> 写法（中英混排）', () => {
    const blocks = parseExamples(CONTENT_P);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].output).toBe('[0,1]');
    expect(blocks[0].explanation).toContain('sum');
    expect(blocks[1].output).toBe('[1,2]');
  });

  it('没有示例时返回空数组', () => {
    expect(parseExamples('<p>没有示例</p>')).toEqual([]);
    expect(parseExamples('')).toEqual([]);
  });
});

describe('buildTestCases', () => {
  it('按 输入内容 配对期望输出（两种写法都对）', () => {
    for (const content of [CONTENT_PRE, CONTENT_P]) {
      const cases = buildTestCases({ exampleTestcases: EXAMPLES_CN, content, metaData: META_TWO_SUM });
      expect(cases.map((c) => c.args)).toEqual([
        ['[2,7,11,15]', '9'],
        ['[3,2,4]', '6'],
      ]);
      expect(cases.map((c) => c.expected)).toEqual(['[0,1]', '[1,2]']);
    }
  });

  it('exampleTestcases 缺失时退化为题面示例', () => {
    const cases = buildTestCases({ exampleTestcases: '', content: CONTENT_P, metaData: META_TWO_SUM });
    expect(cases.length).toBe(2);
    expect(cases[0].source).toBe('example');
    expect(cases[0].args).toEqual(['[2,7,11,15]', '9']);
  });

  it('重复用例会被去重', () => {
    const cases = buildTestCases({
      exampleTestcases: '[1]\n1\n[1]\n1',
      content: CONTENT_P,
      metaData: META_TWO_SUM,
    });
    expect(cases.length).toBe(1);
  });
});

describe('splitExampleTestcases', () => {
  it('按参数个数分组并去掉尾部空行', () => {
    expect(splitExampleTestcases('a\nb\nc\nd\n\n', 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(splitExampleTestcases('', 2)).toEqual([]);
  });
});

describe('参数拆分', () => {
  it('named 形式', () => {
    expect(splitNamedArgs('nums = [2,7], target = 9')).toEqual({ nums: '[2,7]', target: '9' });
  });

  it('顶层逗号拆分不会切断括号内的逗号', () => {
    expect(splitTopLevel('[1,2,3], 4', ',')).toEqual(['[1,2,3]', '4']);
    expect(splitTopLevel('"a,b", c', ',')).toEqual(['"a,b"', 'c']);
  });

  it('splitInputArgs 优先用参数名对齐', () => {
    expect(splitInputArgs('target = 9, nums = [2,7]', ['nums', 'target'])).toEqual(['[2,7]', '9']);
    expect(splitInputArgs('[2,7], 9', ['nums', 'target'])).toEqual(['[2,7]', '9']);
  });
});

describe('输出归一化与比较', () => {
  it('normalizeOutput 统一布尔/浮点/空白', () => {
    expect(normalizeOutput('True')).toBe('true');
    expect(normalizeOutput('[1, 2]')).toBe('[1,2]');
    expect(normalizeOutput('2.00000')).toBe('2');
    expect(normalizeOutput('"abc"')).toBe('abc');
  });

  it('compareOutput 支持浮点容差与无法判定', () => {
    expect(compareOutput('2.0000001', '2.0')).toBe(true);
    expect(compareOutput('[0,1]', '[0,1]')).toBe(true);
    expect(compareOutput('[0,1]', '[1,0]')).toBe(false);
    expect(compareOutput('x', null)).toBeNull();
  });

  it('cleanExpected 去掉行内多余说明', () => {
    expect(cleanExpected('[0,1] (行 1)')).toBe('[0,1]');
    expect(cleanExpected('[[1,2],[3,4]]')).toBe('[[1,2],[3,4]]');
  });

  it('looseEqualArg 忽略格式差异', () => {
    expect(looseEqualArg('[1, 2]', '[1,2]')).toBe(true);
    expect(looseEqualArg('True', 'true')).toBe(true);
    expect(looseEqualArg('[1,2]', '[2,1]')).toBe(false);
  });
});

describe('其它', () => {
  it('parseMetaData 容错', () => {
    expect(parseMetaData('not json')).toBeUndefined();
    expect(parseMetaData(null)).toBeUndefined();
    expect(parseMetaData(META_TWO_SUM)?.name).toBe('twoSum');
    const noReturn = parseMetaData(JSON.stringify({ name: 'f', params: [] }));
    expect(noReturn?.return.type).toBe('void');
  });

  it('htmlToMarkdown 保留代码块与粗体', () => {
    const md = htmlToMarkdown('<p>a <code>x</code> <strong>b</strong></p><pre>line1\nline2</pre>');
    expect(md).toContain('`x`');
    expect(md).toContain('**b**');
    expect(md).toContain('line1');
  });
});


describe('乱序等价（多解题目不该被误判）', () => {
  it('两数之和返回 [1,0] 也能判过', () => {
    const r = compareOutputEx('[1,0]', '[0,1]');
    expect(r.ok).toBe(true);
    expect(r.note).toContain('顺序不同');
  });

  it('三数之和 / 全排列这类二维结果按内层也乱序', () => {
    const r = compareOutputEx('[[0,-1,1],[-1,0,1]]', '[[-1,0,1],[0,-1,1]]');
    expect(r.ok).toBe(true);
    expect(compareOutputEx('[[1,2,3],[4,5,6]]', '[[1,2,4],[3,5,6]]').ok).toBe(false);
  });

  it('元素个数不同 / 内容不同 → 仍然判错', () => {
    expect(compareOutputEx('[0,1,2]', '[0,1]').ok).toBe(false);
    expect(compareOutputEx('[0,2]', '[0,1]').ok).toBe(false);
    expect(compareOutputEx('true', 'false').ok).toBe(false);
  });

  it('严格相等时不需要宽松兜底', () => {
    const r = compareOutputEx('[0,1]', '[0,1]');
    expect(r.ok).toBe(true);
    expect(r.note).toBeUndefined();
  });

  it('没有期望输出时为 null（未判定）', () => {
    expect(compareOutputEx('[0,1]', null).ok).toBeNull();
  });

  it('非数组输出不做乱序比较', () => {
    expect(unorderedEquivalent('abc', 'cba')).toBe(false);
    expect(unorderedEquivalent('{"a":1}', '{"b":2}')).toBe(false);
  });
});


describe('自定义调试输入解析', () => {
  const names2 = ['l1', 'l2'];

  it('具名形式（LeetCode 复制粘贴风格）', () => {
    expect(parseCustomInput('l1 = [2,4,3], l2 = [5,6,4]', names2).args).toEqual(['[2,4,3]', '[5,6,4]']);
  });

  it('每个参数一行 / 分号分隔', () => {
    expect(parseCustomInput('[2,4,3]\n[5,6,4]', names2).args).toEqual(['[2,4,3]', '[5,6,4]']);
    expect(parseCustomInput('[2,4,3]; [5,6,4]', names2).args).toEqual(['[2,4,3]', '[5,6,4]']);
  });

  it('顶层逗号分隔（不会切断数组内部逗号）', () => {
    expect(parseCustomInput('[2,4,3], [5,6,4]', names2).args).toEqual(['[2,4,3]', '[5,6,4]']);
    expect(parseCustomInput('[2,7,11,15], 9', ['nums', 'target']).args).toEqual(['[2,7,11,15]', '9']);
  });

  it('单参数题', () => {
    expect(parseCustomInput('root = [4,2,7]', ['root']).args).toEqual(['[4,2,7]']);
  });

  it('参数个数不对时给出可读错误', () => {
    const r = parseCustomInput('[1,2,3]', names2);
    expect(r.args).toEqual([]);
    expect(r.error).toContain('需要 2 个参数');
  });

  it('空输入报错', () => {
    expect(parseCustomInput('   ', names2).error).toContain('为空');
  });
});


describe('错误提示（把 traceback 翻译成中文建议）', () => {
  it('ListNode 用 len()', async () => {
    const { hintForError } = await import('../../src/core/diagnose.js');
    const r = hintForError("TypeError: object of type 'ListNode' has no len()");
    expect(r?.errorType).toBe('TypeError');
    expect(r?.hint).toContain('ListNode');
  });

  it('空指针 / 越界 / 键错误 / 递归', async () => {
    const { hintForError } = await import('../../src/core/diagnose.js');
    expect(hintForError("AttributeError: 'NoneType' object has no attribute 'next'")?.hint).toContain('判空');
    expect(hintForError('IndexError: list index out of range')?.hint).toContain('越界');
    expect(hintForError('KeyError: 3')?.hint).toContain('get');
    expect(hintForError('RecursionError: maximum recursion depth exceeded')?.hint).toContain('递归');
  });

  it('C/C++/Java 常见错误', async () => {
    const { hintForError } = await import('../../src/core/diagnose.js');
    expect(hintForError('Segmentation fault: 11')?.hint).toContain('段错误');
    expect(hintForError('java.lang.IndexOutOfBoundsException: Index 3')?.hint).toContain('越界');
    expect(hintForError('cannot find symbol')?.hint).toContain('编译错误');
  });

  it('没有匹配规则时也给出错误类型', async () => {
    const { hintForError } = await import('../../src/core/diagnose.js');
    const r = hintForError('ValueError: something odd');
    expect(r?.errorType).toBe('ValueError');
    expect(r?.hint).toContain('ValueError');
  });

  it('空输入返回 undefined', async () => {
    const { hintForError } = await import('../../src/core/diagnose.js');
    expect(hintForError('')).toBeUndefined();
    expect(hintForError(null)).toBeUndefined();
  });
});
