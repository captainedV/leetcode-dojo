/**
 * Ruby 本地测试脚手架。
 *
 * LeetCode 的 Ruby 题面有两种形态：
 *   1. 顶层方法：      def two_sum(nums, target)\n\nend
 *   2. 类方法：        class Solution\n  def two_sum(nums, target)\n  end\nend
 *
 * 做法：
 *  - 生成 genDir/_lc_main.rb：先定义 ListNode / TreeNode（题面注释里的约定结构），
 *    然后 `load` 用户的源文件（**只读**，不改动），再用 TOPLEVEL_BINDING.receiver.method(:two_sum)
 *    或 Solution.new.two_sum 取到方法；
 *  - 读 `_lc_cases.json`，按 meta 类型把参数原文转成 Ruby 值，逐用例调用、序列化、打印协议行；
 *  - 每个用例单独 begin/rescue（能 catch 的都 catch），某个用例炸掉不会影响其它用例；
 *  - 只用标准库（json / stringio），不引入任何 gem。
 */
import type { LcMetaData } from '../../core/types.js';
import type { HarnessArtifact, HarnessFile, HarnessInput, HarnessSupport, LanguageHarness } from './types.js';
import { CASES_FILE, classifyType, serializeCases } from './types.js';
import type { TypeKind } from './types.js';

const SUPPORTED_KINDS: TypeKind[] = [
  'int',
  'long',
  'double',
  'bool',
  'string',
  'char',
  'int[]',
  'long[]',
  'double[]',
  'bool[]',
  'string[]',
  'char[]',
  'char[][]',
  'int[][]',
  'string[][]',
  'listnode',
  'listnode[]',
  'treenode',
  'treenode[]',
  'json',
  'void',
];

function checkSupports(meta: LcMetaData): HarnessSupport {
  if (meta.construct) {
    return { ok: false, reason: '设计类题目（多步操作）暂不支持本地脚手架' };
  }
  const types = [...(meta.params ?? []).map((p) => p.type), meta.return?.type ?? ''];
  for (const t of types) {
    const kind = classifyType(t);
    if (!SUPPORTED_KINDS.includes(kind)) {
      return { ok: false, reason: `暂不支持的类型：${t}` };
    }
  }
  return { ok: true };
}

/** LeetCode 的 camelCase 方法名 → Ruby 风格 snake_case（题面用的是 two_sum）。 */
function snakeCase(name: string): string {
  return (name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

const RUBY_RUNTIME = String.raw`
CASES_PATH = File.join(File.dirname(File.expand_path(__FILE__)), '_lc_cases.json')

# LeetCode Ruby 题面里链表 / 二叉树的约定结构（用户自己定义了也只是被重新打开，不冲突）
class ListNode
  attr_accessor :val, :next

  def initialize(val = 0, _next = nil)
    @val = val
    @next = _next
  end
end

class TreeNode
  attr_accessor :val, :left, :right

  def initialize(val = 0, left = nil, right = nil)
    @val = val
    @left = left
    @right = right
  end
end

module LcHarness
  TYPE_MAP = {
    'integer' => 'int', 'int' => 'int',
    'long' => 'long', 'bigint' => 'long',
    'double' => 'double', 'float' => 'double',
    'boolean' => 'bool', 'bool' => 'bool',
    'string' => 'string', 'str' => 'string',
    'character' => 'char', 'char' => 'char',
    'void' => 'void',
    'integer[]' => 'int[]', 'int[]' => 'int[]', 'list[integer]' => 'int[]',
    'long[]' => 'long[]',
    'double[]' => 'double[]', 'float[]' => 'double[]',
    'boolean[]' => 'bool[]', 'bool[]' => 'bool[]',
    'string[]' => 'string[]', 'list[string]' => 'string[]',
    'character[]' => 'char[]', 'char[]' => 'char[]',
    'character[][]' => 'char[][]', 'char[][]' => 'char[][]',
    'integer[][]' => 'int[][]', 'int[][]' => 'int[][]', 'list[list[integer]]' => 'int[][]',
    'string[][]' => 'string[][]',
    'listnode' => 'listnode',
    'listnode[]' => 'listnode[]', 'list[listnode]' => 'listnode[]',
    'treenode' => 'treenode',
    'treenode[]' => 'treenode[]', 'list[treenode]' => 'treenode[]',
    'json' => 'json', 'array' => 'json', 'object' => 'json', 'nestedinteger' => 'json',
    'node' => 'json', 'graph' => 'json'
  }.freeze

  module_function

  def classify(lc_type)
    TYPE_MAP.fetch(lc_type.to_s.strip.downcase, 'json')
  end

  # ---- 参数原文（LeetCode 的 exampleTestcases 行）→ Ruby 值 ----

  def json_or_raw(raw)
    return nil if raw.nil?

    text = raw.to_s.strip
    return nil if text.empty? || text == 'null'

    begin
      JSON.parse(text)
    rescue StandardError
      text
    end
  end

  def arr(value)
    value.is_a?(Array) ? value : []
  end

  def to_int(value)
    case value
    when Integer then value
    when Float then value.to_i
    when true then 1
    when false, nil then 0
    when String then value.strip.to_i
    else
      begin
        value.to_i
      rescue StandardError
        0
      end
    end
  end

  def to_float(value)
    case value
    when Integer, Float then value.to_f
    when true then 1.0
    when false, nil then 0.0
    when String then value.strip.to_f
    else
      begin
        value.to_f
      rescue StandardError
        0.0
      end
    end
  end

  def to_bool(value)
    return true if value == true
    return false if value == false || value.nil?
    return value != 0 if value.is_a?(Numeric)

    %w[true 1 yes].include?(value.to_s.strip.downcase)
  end

  def to_text(value)
    return '' if value.nil?
    return value if value.is_a?(String)

    value.to_s
  end

  def to_char(value)
    s = to_text(value)
    s.empty? ? ' ' : s[0]
  end

  def chars_of(value)
    return value.chars if value.is_a?(String)

    arr(value).map { |x| to_char(x) }
  end

  def mk_list(values)
    vals = arr(values)
    return nil if vals.empty?

    head = nil
    tail = nil
    vals.each do |v|
      node = ListNode.new(to_int(v))
      if head.nil?
        head = node
        tail = node
      else
        tail.next = node
        tail = node
      end
    end
    head
  end

  def mk_tree(values)
    vals = arr(values)
    return nil if vals.empty? || vals[0].nil?

    root = TreeNode.new(to_int(vals[0]))
    queue = [root]
    i = 1
    until queue.empty? || i >= vals.size
      node = queue.shift
      if i < vals.size
        unless vals[i].nil?
          node.left = TreeNode.new(to_int(vals[i]))
          queue << node.left
        end
        i += 1
      end
      if i < vals.size
        unless vals[i].nil?
          node.right = TreeNode.new(to_int(vals[i]))
          queue << node.right
        end
        i += 1
      end
    end
    root
  end

  def parse_arg(raw, kind)
    case kind
    when 'int', 'long' then to_int(json_or_raw(raw))
    when 'double' then to_float(json_or_raw(raw))
    when 'bool' then to_bool(json_or_raw(raw))
    when 'string' then to_text(json_or_raw(raw))
    when 'char' then to_char(json_or_raw(raw))
    when 'int[]', 'long[]' then arr(json_or_raw(raw)).map { |x| to_int(x) }
    when 'double[]' then arr(json_or_raw(raw)).map { |x| to_float(x) }
    when 'bool[]' then arr(json_or_raw(raw)).map { |x| to_bool(x) }
    when 'string[]' then arr(json_or_raw(raw)).map { |x| to_text(x) }
    when 'char[]' then chars_of(json_or_raw(raw))
    when 'int[][]' then arr(json_or_raw(raw)).map { |r| arr(r).map { |x| to_int(x) } }
    when 'char[][]' then arr(json_or_raw(raw)).map { |r| chars_of(r) }
    when 'string[][]' then arr(json_or_raw(raw)).map { |r| arr(r).map { |x| to_text(x) } }
    when 'listnode' then mk_list(json_or_raw(raw))
    when 'listnode[]' then arr(json_or_raw(raw)).map { |x| mk_list(x) }
    when 'treenode' then mk_tree(json_or_raw(raw))
    when 'treenode[]' then arr(json_or_raw(raw)).map { |x| mk_tree(x) }
    else json_or_raw(raw)
    end
  end

  # ---- Ruby 值 → 字符串（LeetCode 习惯）----

  def fmt_double(value)
    f = to_float(value)
    return '0' if f.zero?

    if f == f.to_i && f.abs < 1e16
      format('%.5f', f)
    else
      f.to_s
    end
  end

  def dump_list(node)
    return [] if node.nil?
    return arr(node).map { |x| to_int(x) } if node.is_a?(Array)
    return [] unless node.respond_to?(:val)

    out = []
    cur = node
    count = 0
    while cur
      out << to_int(cur.val)
      cur = cur.respond_to?(:next) ? cur.next : nil
      count += 1
      break if count > 100_000
    end
    out
  end

  def dump_tree(root)
    return [] if root.nil?
    return arr(root) if root.is_a?(Array)
    return [] unless root.respond_to?(:val)

    out = []
    queue = [root]
    until queue.empty?
      node = queue.shift
      if node.nil?
        out << nil
        next
      end
      out << to_int(node.val)
      queue << (node.respond_to?(:left) ? node.left : nil)
      queue << (node.respond_to?(:right) ? node.right : nil)
      break if out.size > 1_000_000
    end
    out.pop while !out.empty? && out.last.nil?
    out
  end

  def plain(value)
    if value.is_a?(Array)
      value.map { |v| plain(v) }
    elsif value.nil? || value.is_a?(Numeric) || value.is_a?(String) || value == true || value == false
      value
    elsif value.respond_to?(:val) && value.respond_to?(:next)
      dump_list(value)
    elsif value.respond_to?(:val) && value.respond_to?(:left)
      dump_tree(value)
    elsif value.respond_to?(:to_h)
      value.to_h
    else
      value.to_s
    end
  end

  def dump_plain(value)
    p = plain(value)
    return p if p.is_a?(String)

    JSON.generate(p)
  end

  def ser(value, kind)
    case kind
    when 'int', 'long' then to_int(value).to_s
    when 'double' then fmt_double(value)
    when 'bool' then to_bool(value) ? 'true' : 'false'
    when 'string', 'char' then to_text(value)
    when 'int[]', 'long[]' then JSON.generate(arr(value).map { |x| to_int(x) })
    when 'double[]' then JSON.generate(arr(value).map { |x| to_float(x) })
    when 'bool[]' then JSON.generate(arr(value).map { |x| to_bool(x) })
    when 'string[]' then JSON.generate(arr(value).map { |x| to_text(x) })
    when 'char[]' then JSON.generate(chars_of(value))
    when 'int[][]' then JSON.generate(arr(value).map { |r| arr(r).map { |x| to_int(x) } })
    when 'char[][]' then JSON.generate(arr(value).map { |r| chars_of(r) })
    when 'string[][]' then JSON.generate(arr(value).map { |r| arr(r).map { |x| to_text(x) } })
    when 'listnode' then JSON.generate(dump_list(value))
    when 'listnode[]' then JSON.generate(arr(value).map { |n| dump_list(n) })
    when 'treenode' then JSON.generate(dump_tree(value))
    when 'treenode[]' then JSON.generate(arr(value).map { |n| dump_tree(n) })
    else dump_plain(value)
    end
  end
end

# 题面方法名候选：Ruby 惯例是 snake_case
LC_ENTRY_NAMES = __LC_ENTRY_NAMES__.freeze

def lc_find_entry(names)
  if defined?(Solution) && Solution.is_a?(Class)
    begin
      inst = Solution.new
      names.each do |m|
        return inst.method(m) if inst.respond_to?(m, true)
      end
    rescue StandardError
      nil
    end
  end
  recv = TOPLEVEL_BINDING.receiver
  names.each do |m|
    begin
      return recv.method(m)
    rescue NameError
      next
    end
  end
  nil
end

def lc_main
  started = Time.now
  source = ARGV[0]
  if source.nil? || source.empty?
    STDOUT.puts("__LC_ERROR__ #{JSON.generate('fatal' => 'source_missing')}")
    return 2
  end

  begin
    load File.expand_path(source)
  rescue Exception => e # rubocop:disable Lint/RescueException
    warn("#{e.class}: #{e.message}")
    STDOUT.puts("__LC_ERROR__ #{JSON.generate('fatal' => 'load_error')}")
    return 2
  end

  payload = JSON.parse(File.read(CASES_PATH))
  meta = payload['meta'] || {}
  cases = payload['cases'] || []
  arg_kinds = (meta['params'] || []).map { |p| LcHarness.classify(p['type']) }
  return_kind = LcHarness.classify((meta['return'] || {})['type'])

  entry = lc_find_entry(LC_ENTRY_NAMES)
  if entry.nil?
    STDOUT.puts("__LC_ERROR__ #{JSON.generate('fatal' => 'entry_not_found')}")
    return 3
  end

  cases.each do |c|
    t0 = Time.now
    actual = ''
    err = nil
    buf = StringIO.new
    saved = $stdout
    begin
      $stdout = buf
      args = []
      (c['args'] || []).each_with_index do |raw, i|
        args << LcHarness.parse_arg(raw, arg_kinds[i] || 'json')
      end
      ret = entry.call(*args)
      actual = if return_kind == 'void'
                 args.empty? ? 'null' : LcHarness.ser(args[0], arg_kinds[0])
               else
                 LcHarness.ser(ret, return_kind)
               end
    rescue Exception => e # rubocop:disable Lint/RescueException
      err = "#{e.class}: #{e.message}"
      bt = e.backtrace || []
      err += "\n#{bt.first(6).join("\n")}" unless bt.empty?
    ensure
      $stdout = saved
    end
    rec = {
      'i' => c['i'],
      'actual' => actual,
      'error' => err,
      'durationMs' => ((Time.now - t0) * 1000).to_i
    }
    logs = buf.string
    rec['logs'] = logs[-4000, 4000] || logs unless logs.empty?
    STDOUT.puts("__LC_RESULT__ #{JSON.generate(rec)}")
  end

  STDOUT.puts("__LC_DONE__ #{JSON.generate('elapsedMs' => ((Time.now - started) * 1000).to_i)}")
  0
end

exit(lc_main)
`;

function buildEntryNames(input: HarnessInput): string {
  const names = [...new Set([snakeCase(input.meta.name), input.meta.name])].filter(Boolean);
  return `[${names.map((n) => `'${n}'`).join(', ')}]`;
}

function buildMainFile(input: HarnessInput): string {
  const head = [
    '# ===== leetcode-local-ide：自动生成的本地测试脚手架，不修改你的源文件 =====',
    "require 'json'",
    "require 'stringio'",
    '',
  ].join('\n');
  return head + RUBY_RUNTIME.replace('__LC_ENTRY_NAMES__', buildEntryNames(input));
}

export const RubyHarness: LanguageHarness = {
  slug: 'ruby',
  installHint: '需要本地安装 ruby（命令行可用 `ruby --version` 验证）。',
  supports(meta: LcMetaData): HarnessSupport {
    return checkSupports(meta);
  },
  generate(input: HarnessInput): HarnessArtifact {
    const files: HarnessFile[] = [
      { name: CASES_FILE, content: serializeCases(input) },
      { name: '_lc_main.rb', content: buildMainFile(input) },
    ];
    const names = [...new Set([snakeCase(input.meta.name), input.meta.name])].filter(Boolean);
    return {
      files,
      steps: [
        { label: 'run', cmd: 'ruby', args: ['_lc_main.rb', input.sourceAbsPath], fatal: false },
      ],
      debugEntry: '_lc_main.rb',
      debugType: 'rdbg',
      notes: [
        '入口文件会 `load` 你的源文件，源文件不会被改动。',
        `方法名同时匹配 ${names.map((n) => `\`${n}\``).join(' / ')}（顶层方法或 Solution 类方法都可以）。`,
        'ListNode / TreeNode 按 LeetCode 题面的约定结构定义（val / next / left / right）。',
      ],
    };
  },
};
