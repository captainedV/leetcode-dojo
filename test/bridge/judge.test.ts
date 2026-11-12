import { describe, expect, it } from 'vitest';
import {
  CHECK_RE,
  detectJudgeResult,
  detectSubmissionId,
  fixSelfProtocol,
  classifyLink,
  formatJudgeResult,
  matchJudgeRequest,
  rewriteJudgeBody,
} from '../../src/bridge/judge.js';

describe('matchJudgeRequest', () => {
  it('识别运行请求', () => {
    const m = matchJudgeRequest('https://leetcode.cn/problems/two-sum/interpret_solution/');
    expect(m?.kind).toBe('run');
    expect(m?.slug).toBe('two-sum');
  });

  it('识别提交请求', () => {
    const m = matchJudgeRequest('/problems/median-of-two-sorted-arrays/submit/');
    expect(m?.kind).toBe('submit');
    expect(m?.slug).toBe('median-of-two-sorted-arrays');
  });

  it('识别 GraphQL 形式的判题请求（靠 body 特征）', () => {
    const m = matchJudgeRequest('/graphql/', JSON.stringify({ variables: { typed_code: 'x' } }));
    expect(m?.kind).toBe('submit');
    const run = matchJudgeRequest('/graphql/', JSON.stringify({ typed_code: 'x', data_input: '1' }));
    expect(run?.kind).toBe('run');
  });

  it('普通请求不匹配', () => {
    expect(matchJudgeRequest('/problems/two-sum/description/')).toBeNull();
    expect(matchJudgeRequest('/graphql/', JSON.stringify({ query: '{ me { id } }' }))).toBeNull();
  });

  it('CHECK_RE 匹配 v1/v2 轮询', () => {
    expect(CHECK_RE.test('/submissions/detail/123456/check/')).toBe(true);
    expect(CHECK_RE.test('/submissions/detail/123456/v2/check/')).toBe(true);
    expect(CHECK_RE.test('/submissions/detail/123456/')).toBe(false);
  });
});

describe('rewriteJudgeBody', () => {
  const match = matchJudgeRequest('/problems/two-sum/submit/')!;

  it('把本地代码与语言替换进请求体', () => {
    const body = JSON.stringify({ lang: 'python3', question_id: '1', typed_code: 'old code', study_plan_slug: null });
    const out = rewriteJudgeBody(match, body, { lang: 'cpp', code: 'int main(){}' });
    expect(out.changed).toBe(true);
    const parsed = JSON.parse(out.body!) as Record<string, unknown>;
    expect(parsed.typed_code).toBe('int main(){}');
    expect(parsed.lang).toBe('cpp');
    // 其它字段必须原样保留
    expect(parsed.question_id).toBe('1');
    expect(parsed.study_plan_slug).toBeNull();
  });

  it('支持 GraphQL 嵌套 variables', () => {
    const body = JSON.stringify({ query: 'mutation x', variables: { typed_code: 'old', lang: 'java' } });
    const out = rewriteJudgeBody(match, body, { lang: 'golang', code: 'func f(){}' });
    const parsed = JSON.parse(out.body!) as { variables: Record<string, unknown> };
    expect(parsed.variables.typed_code).toBe('func f(){}');
    expect(parsed.variables.lang).toBe('golang');
  });

  it('可以覆盖 data_input（用本地用例跑官方判题）', () => {
    const body = JSON.stringify({ lang: 'python3', typed_code: 'x', data_input: 'old' });
    const out = rewriteJudgeBody(match, body, { code: 'x', lang: 'python3', dataInput: '[1,2]\n3' });
    expect(out.useLocalInput).toBe(true);
    expect(JSON.parse(out.body!).data_input).toBe('[1,2]\n3');
  });

  it('没有变化时 changed=false 且不破坏原文', () => {
    const body = JSON.stringify({ lang: 'python3', typed_code: 'same' });
    const out = rewriteJudgeBody(match, body, { lang: 'python3', code: 'same' });
    expect(out.changed).toBe(false);
    expect(out.body).toBe(body);
  });

  it('非 JSON 请求体原样放过', () => {
    const out = rewriteJudgeBody(match, 'not-json', { code: 'x' });
    expect(out.changed).toBe(false);
  });
});

describe('判题结果解析', () => {
  it('识别提交 id', () => {
    expect(detectSubmissionId({ submission_id: '42' })).toBe('42');
    expect(detectSubmissionId({ interpret_id: 'abc' })).toBe('abc');
    expect(detectSubmissionId({})).toBeUndefined();
  });

  it('PENDING 状态不算结果', () => {
    expect(detectJudgeResult({ state: 'PENDING' })).toBeUndefined();
    expect(detectJudgeResult({ state: 'STARTED' })).toBeUndefined();
  });

  it('解析运行结果（含 compare_result）', () => {
    const r = detectJudgeResult({
      state: 'SUCCESS',
      status_msg: 'Finished',
      run_success: true,
      code_answer: ['[0,1]', '[1,2]'],
      compare_result: '11',
      total_correct: 2,
      total_testcases: 2,
      std_output: [''],
    });
    expect(r?.compareResult).toBe('11');
    expect(r?.codeAnswer).toEqual(['[0,1]', '[1,2]']);
    const lines = formatJudgeResult('run', r!);
    expect(lines.join('\n')).toContain('2/2');
  });

  it('解析提交结果（Accepted）', () => {
    const r = detectJudgeResult({
      state: 'SUCCESS',
      status_msg: 'Accepted',
      total_correct: 12,
      total_testcases: 12,
      runtime_percentile: 82.5,
      memory_percentile: 40.1,
    });
    expect(r?.statusMsg).toBe('Accepted');
    const text = formatJudgeResult('submit', r!).join('\n');
    expect(text).toContain('Accepted');
    expect(text).toContain('12/12');
    expect(text).toContain('82.50%');
  });

  it('解析编译错误', () => {
    const r = detectJudgeResult({
      state: 'SUCCESS',
      status_msg: 'Compile Error',
      compile_error: 'Line 3: expected ;',
    });
    expect(r?.compileError).toContain('expected ;');
    expect(formatJudgeResult('submit', r!).join('\n')).toContain('编译错误');
  });
});

describe('fixSelfProtocol', () => {
  it('把指向自身的 https 地址纠正回代理 http 源', () => {
    const origin = 'http://127.0.0.1:1234';
    expect(fixSelfProtocol('https://127.0.0.1:1234/monaco-tm/themes/light_vs.json', '127.0.0.1:1234', origin)).toBe(
      'http://127.0.0.1:1234/monaco-tm/themes/light_vs.json',
    );
  });

  it('外部域名与已是 http 的地址不动', () => {
    const origin = 'http://127.0.0.1:1234';
    expect(fixSelfProtocol('https://static.leetcode.cn/a.js', '127.0.0.1:1234', origin)).toBe(
      'https://static.leetcode.cn/a.js',
    );
    expect(fixSelfProtocol('/graphql/', '127.0.0.1:1234', origin)).toBe('/graphql/');
  });
});


describe('链接路由（学习计划里的题目行用 window.open，webview 里会被拦）', () => {
  const page = 'http://127.0.0.1:5555/studyplan/top-interview-150/';

  it('同站题目链接 → 在面板内跳转', () => {
    const r = classifyLink('/problems/merge-sorted-array/?envType=study-plan-v2', page);
    expect(r.kind).toBe('self');
    expect(r.kind === 'self' && r.href).toBe('http://127.0.0.1:5555/problems/merge-sorted-array/?envType=study-plan-v2');
  });

  it('绝对的同站地址（真实域名）也应该走面板内', () => {
    // 注意：桥接运行在代理源上，这里模拟页面返回的绝对地址已被改写
    const r = classifyLink('http://127.0.0.1:5555/problems/two-sum/', page);
    expect(r.kind).toBe('self');
  });

  it('站外链接 → 交给系统浏览器', () => {
    const r = classifyLink('https://www.bing.com/search?q=1', page);
    expect(r.kind).toBe('external');
    expect(r.kind === 'external' && r.href).toContain('bing.com');
  });

  it('javascript: / 空链接不接管', () => {
    expect(classifyLink('javascript:void(0)', page).kind).toBe('ignore');
    expect(classifyLink(null, page).kind).toBe('ignore');
    expect(classifyLink('', page).kind).toBe('ignore');
  });

  it('下载类链接不接管（保持浏览器行为）', () => {
    expect(classifyLink('/static/foo.zip', page, 'anchor').kind).toBe('ignore');
    expect(classifyLink('/static/foo.zip', page, 'popup').kind).toBe('self');
  });
});
