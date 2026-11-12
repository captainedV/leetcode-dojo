import { describe, expect, it } from 'vitest';
import { checkLineCompletion, isHintLevel, type GatedLineFilterOptions } from '../../src/ai/lineGate.js';
import {
  SIGNATURE_DB,
  hintsForLine,
  insertTextFor,
  lookupApi,
  type ApiSignature,
} from '../../src/ai/signatureDb.js';

/** 构造 gate 选项：默认长度上限 80，光标在后行尾 */
function opts(patch: Partial<GatedLineFilterOptions> = {}): GatedLineFilterOptions {
  return { maxChars: 80, anchorLine: '', followingLine: '', langSlug: 'python3', ...patch };
}

function reasonOf(text: string, patch: Partial<GatedLineFilterOptions> = {}): string {
  const verdict = checkLineCompletion(text, opts(patch));
  expect(verdict.ok, `期望被拒绝：${JSON.stringify(text)}`).toBe(false);
  return verdict.reason ?? '';
}

function okText(text: string, patch: Partial<GatedLineFilterOptions> = {}): void {
  const verdict = checkLineCompletion(text, opts(patch));
  expect(verdict.ok, `期望放行：${JSON.stringify(text)}（${verdict.reason}）`).toBe(true);
}

describe('checkLineCompletion：8 条硬规则', () => {
  it('规则 1：空串、纯空白、含换行一律拒绝', () => {
    reasonOf('');
    reasonOf('   ');
    reasonOf('\n');
    // 多行 = 整段解法，绝对不许过
    expect(reasonOf('x = 1\ny = 2')).toContain('换行');
    expect(reasonOf('for (int i = 0; i < n; ++i) {\n}')).toContain('换行');
  });

  it('规则 2：超过 maxChars 拒绝，恰好等于上限放行', () => {
    const long = 'f('.padEnd(30, 'x') + ')';
    expect(reasonOf(long, { maxChars: 20 })).toContain('上限');
    const exact = 'a'.repeat(10);
    okText(exact, { maxChars: 10, langSlug: 'javascript' });
    okText(exact, { maxChars: 11, langSlug: 'javascript' });
  });

  it('规则 3：括号配平为负或结尾未闭合都拒绝', () => {
    expect(reasonOf(')))')).toContain('配平');
    expect(reasonOf(']')).toContain('配平');
    expect(reasonOf('foo(bar')).toContain('未闭合');
    expect(reasonOf('x = [1, 2')).toContain('未闭合');
    expect(reasonOf('if (x > 0) {', { langSlug: 'javascript' })).toContain('未闭合');
    // 字符串里的括号不影响配平
    okText("s = ')' + '('", { langSlug: 'python3' });
  });

  it('规则 4：以 : / { / do / then 结尾（块开头）拒绝', () => {
    expect(reasonOf('if x > 0:', { langSlug: 'python3' })).toContain(': / {');
    expect(reasonOf('for (int x : nums) {', { langSlug: 'cpp' }).length).toBeGreaterThan(0);
    // then / do 结尾（不在结尾就不拦）
    expect(reasonOf('if a then', { langSlug: 'kotlin' })).toContain('do / then');
    expect(reasonOf('repeat do', { langSlug: 'ruby' })).toContain('do / then');
    // ':' 出现在中间（range-for / 字典字面量）不算块开头
    okText('for (int x : nums) total += x', { langSlug: 'cpp' });
    okText('x = a if b else c', { langSlug: 'python3' });
  });

  it('规则 5：控制流关键字出现 2 个及以上拒绝', () => {
    expect(reasonOf('for (const x of a) if (x > 0)', { langSlug: 'javascript' })).toContain('控制流');
    expect(reasonOf('while (i < n) if (a[i])', { langSlug: 'cpp' })).toContain('控制流');
    // 只有 1 个控制流关键字时允许（阈值为 2）
    okText('if (x > 0) return x', { langSlug: 'javascript' });
    // 括号里的推导式/内联表达式不是「开块」，不计数
    okText('return i if found else -1', { langSlug: 'python3' });
    okText('squares = [x * x for x in nums if x > 0]', { langSlug: 'python3' });
    okText('nums = list(filter(lambda x: x > 0, arr))', { langSlug: 'python3' });
  });

  it('规则 6：定义语句（class/def/function/public/fn）拒绝', () => {
    expect(reasonOf('class Solution', { langSlug: 'python3' })).toContain('定义');
    expect(reasonOf('def twoSum(self, nums, t)', { langSlug: 'python3' })).toContain('定义');
    expect(reasonOf('function solve(nums)', { langSlug: 'javascript' })).toContain('定义');
    expect(reasonOf('public int f(int x)', { langSlug: 'java' })).toContain('定义');
    expect(reasonOf('fn solve(v: &Vec<i32>)', { langSlug: 'rust' })).toContain('定义');
  });

  it('规则 7：与光标后已有内容重复拒绝', () => {
    expect(reasonOf('nums[i]', { followingLine: 'nums[i]', anchorLine: 'x = ' })).toContain('重复');
    expect(reasonOf('get(k)', { followingLine: 'map.get(k)' })).toContain('光标之后');
    // 与光标前已写内容重复也不行
    expect(reasonOf('heappush(h, x)', { anchorLine: 'heapq.heappush(h, x)' })).toContain('重复');
    // 不同内容照常放行
    okText('heappush(h, x)', { anchorLine: 'heapq.', followingLine: '' });
  });

  it('规则 8：只允许补单条语句', () => {
    expect(reasonOf('a = 1; b = 2')).toContain('语句');
    expect(reasonOf('dp[i] = 1; dp[i + 1] = 2;', { langSlug: 'cpp' })).toContain('语句');
    expect(reasonOf('x++; y++;', { langSlug: 'javascript' })).toContain('语句');
    // 单条语句（带分号/多参数）放行
    okText('x = f(a, b);', { langSlug: 'cpp' });
    okText('map.put(k, map.getOrDefault(k, 0) + 1)', { langSlug: 'java' });
    okText('dp[i] = Math.min(dp[i - 1], dp[i - 2]) + cost[i]', { langSlug: 'javascript' });
  });

  it('真实场景的签名片段应当放行', () => {
    okText('bisect_left(a, x)', { langSlug: 'python3' });
    okText('heapq.heappush(h, -x)', { langSlug: 'python3' });
    okText('arr.sort((a, b) => a - b)', { langSlug: 'javascript' });
    okText('*map.entry(x).or_insert(0) += 1', { langSlug: 'rust' });
    okText('sort.Slice(a, func(i, j int) bool { return a[i] < a[j] })', { langSlug: 'golang' });
    okText('Collections.sort(list)', { langSlug: 'java' });
  });
});

describe('isHintLevel', () => {
  it('只认三档', () => {
    expect(isHintLevel('off')).toBe(true);
    expect(isHintLevel('signature')).toBe(true);
    expect(isHintLevel('line')).toBe(true);
    expect(isHintLevel('all')).toBe(false);
    expect(isHintLevel(undefined)).toBe(false);
  });
});

describe('SIGNATURE_DB 完整性', () => {
  const REQUIRED = ['python3', 'javascript', 'cpp', 'java', 'golang', 'rust'] as const;

  it('6 个语言 key 都存在，且每个语言 30-60 条', () => {
    for (const lang of REQUIRED) {
      const list = SIGNATURE_DB[lang];
      expect(Array.isArray(list), `${lang} 缺失`).toBe(true);
      expect(list.length, `${lang} 条数过少`).toBeGreaterThanOrEqual(30);
      expect(list.length, `${lang} 条数过多`).toBeLessThanOrEqual(60);
    }
    expect(Object.keys(SIGNATURE_DB).sort()).toEqual([...REQUIRED].sort());
  });

  it('每条都有 name/signature/doc，且同一语言内 name 不重复', () => {
    for (const lang of REQUIRED) {
      const seen = new Set<string>();
      for (const entry of SIGNATURE_DB[lang]) {
        expect(typeof entry.name).toBe('string');
        expect(entry.name.trim().length, `${lang} 有空 name`).toBeGreaterThan(0);
        expect(entry.signature.trim().length, `${lang}/${entry.name} 缺 signature`).toBeGreaterThan(0);
        expect(entry.doc.trim().length, `${lang}/${entry.name} 缺 doc`).toBeGreaterThan(0);
        // doc 必须是中文说明，不是英文原文
        expect(/[\u4e00-\u9fa5]/.test(entry.doc), `${lang}/${entry.name} 的 doc 不是中文`).toBe(true);
        expect(seen.has(entry.name), `${lang} 里 name 重复：${entry.name}`).toBe(false);
        seen.add(entry.name);
      }
    }
  });

  it('signature 里包含自己的 name（保证能推导出可插入文本）', () => {
    const offenders: string[] = [];
    for (const lang of REQUIRED) {
      for (const entry of SIGNATURE_DB[lang]) {
        if (!entry.signature.toLowerCase().includes(entry.name.toLowerCase())) {
          offenders.push(`${lang}/${entry.name} → ${entry.signature}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('插入文本是「名字 + 参数」，常量类只给名字', () => {
    const find = (lang: string, name: string): ApiSignature => {
      const entry = SIGNATURE_DB[lang].find((e) => e.name === name);
      expect(entry, `${lang}/${name} 不存在`).toBeTruthy();
      return entry as ApiSignature;
    };
    expect(insertTextFor(find('python3', 'bisect_left'))).toBe('bisect_left(a, x)');
    expect(insertTextFor(find('python3', 'float'))).toBe("float('inf')");
    expect(insertTextFor(find('javascript', 'sort'))).toBe('sort((a, b) => a - b)');
    expect(insertTextFor(find('javascript', 'Math.floor'))).toBe('Math.floor(x)');
    expect(insertTextFor(find('javascript', 'Number.MAX_SAFE_INTEGER'))).toBe('Number.MAX_SAFE_INTEGER');
    expect(insertTextFor(find('cpp', 'INT_MAX'))).toBe('INT_MAX');
    expect(insertTextFor(find('java', 'getOrDefault'))).toBe('getOrDefault(key, defaultValue)');
    expect(insertTextFor(find('rust', 'or_insert'))).toBe('or_insert(default)');
  });
});

describe('lookupApi / hintsForLine', () => {
  it('前缀查询命中，别名归一化后也能查', () => {
    expect(lookupApi('python3', 'bisect')[0]?.name).toBe('bisect_left');
    expect(lookupApi('python', 'bisect')[0]?.name).toBe('bisect_left');
    expect(lookupApi('javascript', 'Math.f').map((e) => e.name)).toContain('Math.floor');
    expect(lookupApi('typescript', 'sor').map((e) => e.name)).toContain('sort');
    expect(lookupApi('go', 'sort.Ints').length).toBeGreaterThan(0);
    expect(lookupApi('java', 'zzz')).toEqual([]);
    expect(lookupApi('cobol', 'sort')).toEqual([]);
  });

  it('limit 生效', () => {
    expect(lookupApi('javascript', '', 3).length).toBe(3);
    expect(lookupApi('python3', 'bisect', 1).length).toBe(1);
  });

  it('输入 `bisect.` 只给 bisect 下的 API', () => {
    const hints = hintsForLine('python3', 'x = bisect.', '');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.every((h) => h.owner === 'bisect')).toBe(true);
    expect(hints[0].name).toBe('bisect_left');
  });

  it('输入 `heapq.` 只给 heapq 下的 API', () => {
    const hints = hintsForLine('python3', 'heapq.', '');
    expect(hints.map((h) => h.owner === 'heapq')).toContain(true);
    expect(hints.map((h) => h.name)).toContain('heappush');
  });

  it('按名字前缀给提示，且最多 5 条', () => {
    const hints = hintsForLine('python3', 'x = sort', 'sort');
    expect(hints[0].name.startsWith('sort')).toBe(true);
    expect(hintsForLine('javascript', 'arr.ma', 'ma').length).toBeLessThanOrEqual(5);
    expect(hintsForLine('python3', 'x = ', '').length).toBe(0);
    expect(hintsForLine('cobol', 'bisect.', '').length).toBe(0);
  });
});
