import { describe, expect, it } from 'vitest';
import {
  AI_HARNESS_DIR,
  allowedExtensions,
  generateHarnessWithAI,
  normalizeAiHarnessPlan,
} from '../../src/ai/aiHarness.js';
import type { AiHarnessSpec } from '../../src/ai/aiHarness.js';
import type { AssistantClient } from '../../src/ai/provider.js';

function validRaw(): Record<string, unknown> {
  return {
    files: [
      { name: '_lc_cases.json', content: '{"cases":[]}' },
      { name: '_lc_runner.py', content: 'print("__LC_DONE__ {}")' },
    ],
    steps: [
      { label: 'run', cmd: 'python3', args: ['_lc_runner.py', 'solution.py'], fatal: false },
    ],
    note: '按题面示例逐条调用。',
  };
}

function rawWith(mutate: (raw: Record<string, unknown>) => void): Record<string, unknown> {
  const raw = validRaw();
  mutate(raw);
  return raw;
}

describe('normalizeAiHarnessPlan：合法输出', () => {
  it('接受合法计划并原样保留字段', () => {
    const plan = normalizeAiHarnessPlan(validRaw(), 'python3');
    expect(plan.files.map((f) => f.name)).toEqual(['_lc_cases.json', '_lc_runner.py']);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ label: 'run', cmd: 'python3', args: ['_lc_runner.py', 'solution.py'], fatal: false });
    expect(plan.note).toBe('按题面示例逐条调用。');
    expect(AI_HARNESS_DIR).toBe('ai');
  });

  it('允许子目录、编译步骤 ./ 命令与可选 note', () => {
    const plan = normalizeAiHarnessPlan(
      {
        files: [
          { name: 'lib/helper.hpp', content: '' },
          { name: '_lc_cases.json', content: '{}' },
        ],
        steps: [
          { label: 'compile', cmd: 'g++', args: ['-O2', '-o', 'run', 'main.cpp'] },
          { label: 'run', cmd: './run', args: [] },
        ],
      },
      'cpp',
    );
    expect(plan.files[0].name).toBe('lib/helper.hpp');
    expect(plan.steps.map((s) => s.cmd)).toEqual(['g++', './run']);
    expect(plan.note).toBeUndefined();
  });

  it('未知语言时按宽泛安全集合校验', () => {
    expect(() => normalizeAiHarnessPlan(validRaw())).not.toThrow();
    expect(allowedExtensions('python3')).toContain('.py');
    expect(allowedExtensions('python3')).toContain('.json');
    expect(allowedExtensions('python3')).not.toContain('.sh');
  });
});

describe('normalizeAiHarnessPlan：非法输出全部拒绝', () => {
  it('拒绝绝对路径', () => {
    const raw = rawWith((r) => {
      (r.files as unknown[])[0] = { name: '/tmp/evil.py', content: 'x' };
    });
    expect(() => normalizeAiHarnessPlan(raw, 'python3')).toThrow(/绝对路径/);
  });

  it('拒绝 `..` 路径穿越', () => {
    const raw = rawWith((r) => {
      (r.files as unknown[])[0] = { name: '../evil.py', content: 'x' };
    });
    expect(() => normalizeAiHarnessPlan(raw, 'python3')).toThrow(/\.\./);
  });

  it('拒绝白名单外的命令', () => {
    const raw = rawWith((r) => {
      (r.steps as unknown[])[0] = { label: 'run', cmd: 'bash', args: ['-c', 'ls'] };
    });
    expect(() => normalizeAiHarnessPlan(raw, 'python3')).toThrow(/白名单/);
  });

  it('拒绝含分号的命令', () => {
    const raw = rawWith((r) => {
      (r.steps as unknown[])[0] = { label: 'run', cmd: 'python3; rm -rf /', args: [] };
    });
    expect(() => normalizeAiHarnessPlan(raw, 'python3')).toThrow();
    const raw2 = rawWith((r) => {
      (r.steps as unknown[])[0] = { label: 'run', cmd: 'python3', args: ['_lc_runner.py; rm -rf /'] };
    });
    expect(() => normalizeAiHarnessPlan(raw2, 'python3')).toThrow(/shell 元字符/);
  });

  it('拒绝与语言不匹配的扩展名', () => {
    const raw = rawWith((r) => {
      (r.files as unknown[])[1] = { name: '_lc_runner.sh', content: 'echo hi' };
    });
    expect(() => normalizeAiHarnessPlan(raw, 'python3')).toThrow(/扩展名/);
  });

  it('拒绝隐藏文件、空 files / steps 与重复文件', () => {
    expect(() =>
      normalizeAiHarnessPlan(rawWith((r) => { (r.files as unknown[])[0] = { name: '.env', content: 'x' }; }), 'python3'),
    ).toThrow(/隐藏/);
    expect(() => normalizeAiHarnessPlan(rawWith((r) => { r.files = []; }), 'python3')).toThrow(/files/);
    expect(() => normalizeAiHarnessPlan(rawWith((r) => { r.steps = []; }), 'python3')).toThrow(/steps/);
    expect(() =>
      normalizeAiHarnessPlan(
        rawWith((r) => { r.files = [{ name: 'a.py', content: '' }, { name: 'A.py', content: '' }]; }),
        'python3',
      ),
    ).toThrow(/重复/);
  });

  it('拒绝非对象 / 缺字段', () => {
    expect(() => normalizeAiHarnessPlan(null)).toThrow(/JSON 对象|files/);
    expect(() => normalizeAiHarnessPlan([])).toThrow();
    expect(() => normalizeAiHarnessPlan({ files: [{ name: 'x.py', content: '' }] }, 'python3')).toThrow(/steps/);
  });
});

const SPEC: AiHarnessSpec = {
  langSlug: 'python3',
  title: '146. LRU Cache',
  contentMd: '请你设计一个 LRU 缓存。',
  meta: {
    name: 'LRUCache',
    params: [{ name: 'capacity', type: 'integer' }],
    return: { type: 'void' },
    classname: 'LRUCache',
    construct: true,
  },
  cases: [{ index: 0, args: ['2'], expected: null, source: 'leet' }],
  sourceCode: 'class LRUCache:\n    pass\n',
  sourceFileName: 'solution.py',
  sourceAbsPath: '/tmp/prob/solution.py',
};

function fakeClient(replies: Array<() => Promise<unknown>>, available = true): { client: AssistantClient; calls: () => number } {
  let calls = 0;
  const fake = {
    available,
    chat: async () => '',
    chatJson: async () => {
      const reply = replies[Math.min(calls, replies.length - 1)];
      calls += 1;
      return reply();
    },
  };
  return { client: fake as unknown as AssistantClient, calls: () => calls };
}

describe('generateHarnessWithAI', () => {
  it('第一次就成功', async () => {
    const { client, calls } = fakeClient([async () => validRaw()]);
    const plan = await generateHarnessWithAI(client, SPEC);
    expect(plan.steps[0].cmd).toBe('python3');
    expect(calls()).toBe(1);
  });

  it('第一次不合法时带提示重试一次', async () => {
    const bad = rawWith((r) => {
      (r.steps as unknown[])[0] = { label: 'run', cmd: 'rm', args: [] };
    });
    const { client, calls } = fakeClient([async () => bad, async () => validRaw()]);
    const plan = await generateHarnessWithAI(client, SPEC);
    expect(plan.files).toHaveLength(2);
    expect(calls()).toBe(2);
  });

  it('两次都失败则抛错', async () => {
    const bad = rawWith((r) => {
      (r.files as unknown[])[0] = { name: '../x.py', content: '' };
    });
    const { client } = fakeClient([async () => bad, async () => bad]);
    await expect(generateHarnessWithAI(client, SPEC)).rejects.toThrow(/已重试 1 次/);
  });

  it('AI 未启用时直接拒绝', async () => {
    const { client } = fakeClient([async () => validRaw()], false);
    await expect(generateHarnessWithAI(client, SPEC)).rejects.toThrow(/未启用/);
  });
});
