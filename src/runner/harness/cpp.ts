/**
 * C++ 本地测试脚手架（g++ / clang++，C++17）。
 *
 * 做法与 LeetCode 官方评测机一致：
 *  - 生成物只写 `input.genDir`（`_lc_cases.json` / `_lc_prelude.hpp` / `_lc_nodes.hpp` /
 *    `_lc_main.cpp`），**绝不改动用户代码文件**；
 *  - 入口文件用 `#include "<用户文件绝对路径>"` 引用用户代码，因此 genDir 与用户目录
 *    可以不同；用户文件里若自带 `main`，临时用宏改名，避免与脚手架 `main` 冲突；
 *  - 输出统一协议行（`__LC_RESULT__` / `__LC_ERROR__` / `__LC_DONE__`），actual 一律是
 *    按 LeetCode 习惯序列化后的字符串；
 *  - 本机 Apple clang 没有 `bits/stdc++.h`：检测到用户代码用到它时，在 genDir 里生成
 *    一个兼容头，并用 `-I<genDir>` 让编译器优先命中。
 */
import { join } from 'node:path';
import type { LcMetaData } from '../../core/types.js';
import type {
  HarnessArtifact,
  HarnessFile,
  HarnessInput,
  HarnessSupport,
  LanguageHarness,
} from './types.js';
import type { TypeKind } from './types.js';
import { CASES_FILE, classifyType, inPlaceAnswerParam, serializeCases } from './types.js';

/** 顺序稳定、覆盖 LeetCode 常用标准库的头文件清单（也用于 bits/stdc++.h 兼容头）。 */
const COMMON_HEADERS = [
  'algorithm',
  'array',
  'bitset',
  'cassert',
  'cctype',
  'cfloat',
  'chrono',
  'climits',
  'cmath',
  'cstddef',
  'cstdint',
  'cstdio',
  'cstdlib',
  'cstring',
  'ctime',
  'deque',
  'fstream',
  'functional',
  'iomanip',
  'iostream',
  'istream',
  'iterator',
  'limits',
  'list',
  'map',
  'memory',
  'numeric',
  'optional',
  'ostream',
  'queue',
  'random',
  'set',
  'sstream',
  'stack',
  'stdexcept',
  'string',
  'tuple',
  'type_traits',
  'unordered_map',
  'unordered_set',
  'utility',
  'variant',
  'vector',
];

function commonIncludes(): string {
  return COMMON_HEADERS.map((h) => `#include <${h}>`).join('\n');
}

/** 一个参数在 C++ 侧的声明类型 + 「Json → C++ 值」的转换函数。 */
interface CppArgSpec {
  cpp: string;
  conv: string;
}

/** 必支持类型 → C++ 参数描述。`json` 由用例内容推断，单独处理。 */
const CPP_ARG_SPECS: Partial<Record<TypeKind, CppArgSpec>> = {
  int: { cpp: 'int', conv: 'lc::to_int' },
  long: { cpp: 'long long', conv: 'lc::to_ll' },
  double: { cpp: 'double', conv: 'lc::to_double' },
  bool: { cpp: 'bool', conv: 'lc::to_bool' },
  string: { cpp: 'std::string', conv: 'lc::to_text' },
  char: { cpp: 'char', conv: 'lc::to_char' },
  'int[]': { cpp: 'std::vector<int>', conv: 'lc::to_int_vec' },
  'long[]': { cpp: 'std::vector<long long>', conv: 'lc::to_ll_vec' },
  'double[]': { cpp: 'std::vector<double>', conv: 'lc::to_double_vec' },
  'bool[]': { cpp: 'std::vector<bool>', conv: 'lc::to_bool_vec' },
  'string[]': { cpp: 'std::vector<std::string>', conv: 'lc::to_str_vec' },
  'char[]': { cpp: 'std::vector<char>', conv: 'lc::to_char_vec' },
  'int[][]': { cpp: 'std::vector<std::vector<int>>', conv: 'lc::to_int_mat' },
  'char[][]': { cpp: 'std::vector<std::vector<char>>', conv: 'lc::to_char_mat' },
  'string[][]': { cpp: 'std::vector<std::vector<std::string>>', conv: 'lc::to_str_mat' },
  listnode: { cpp: 'ListNode*', conv: 'lc::make_list' },
  'listnode[]': { cpp: 'std::vector<ListNode*>', conv: 'lc::make_list_vec' },
  treenode: { cpp: 'TreeNode*', conv: 'lc::make_tree' },
  'treenode[]': { cpp: 'std::vector<TreeNode*>', conv: 'lc::make_tree_vec' },
};

/* ------------------------------------------------------------------ *
 * json 类型的参数：按用例原文推断最贴切的 C++ 类型
 * ------------------------------------------------------------------ */

type JShape = 'null' | 'bool' | 'int' | 'double' | 'string' | { arr: JShape };

function isNumShape(s: JShape): boolean {
  return s === 'int' || s === 'double';
}

function shapeOfValue(value: unknown): JShape | null {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    let inner: JShape | null = null;
    for (const item of value) {
      const s = shapeOfValue(item);
      if (s === null) return null;
      inner = inner === null ? s : mergeShape(inner, s);
      if (inner === null) return null;
    }
    // 空数组按 int[] 处理
    return { arr: inner ?? 'int' };
  }
  // 对象等复杂结构无法映射成静态 C++ 类型
  return null;
}

function mergeShape(a: JShape, b: JShape): JShape | null {
  if (a === b) return a;
  if (isNumShape(a) && isNumShape(b)) return 'double';
  if (a === 'null') return b;
  if (b === 'null') return a;
  if (typeof a === 'object' && typeof b === 'object') {
    const inner = mergeShape(a.arr, b.arr);
    return inner === null ? null : { arr: inner };
  }
  return null;
}

const SHAPE_SPECS: Record<string, CppArgSpec> = {
  int: { cpp: 'int', conv: 'lc::to_int' },
  double: { cpp: 'double', conv: 'lc::to_double' },
  bool: { cpp: 'bool', conv: 'lc::to_bool' },
  string: { cpp: 'std::string', conv: 'lc::to_text' },
};

function specForShape(shape: JShape): CppArgSpec | null {
  if (typeof shape === 'string') return SHAPE_SPECS[shape] ?? null;
  const inner = specForShape(shape.arr);
  if (!inner) return null;
  // 多维数组统一落到 int / double / string 三种，够覆盖 LeetCode 的 array 题型
  if (inner.cpp === 'int') return { cpp: 'std::vector<int>', conv: 'lc::to_int_vec' };
  if (inner.cpp === 'double') return { cpp: 'std::vector<double>', conv: 'lc::to_double_vec' };
  if (inner.cpp === 'bool') return { cpp: 'std::vector<bool>', conv: 'lc::to_bool_vec' };
  if (inner.cpp === 'std::string') return { cpp: 'std::vector<std::string>', conv: 'lc::to_str_vec' };
  if (inner.cpp === 'std::vector<int>') {
    return { cpp: 'std::vector<std::vector<int>>', conv: 'lc::to_int_mat' };
  }
  if (inner.cpp === 'std::vector<double>') {
    return { cpp: 'std::vector<std::vector<double>>', conv: 'lc::to_double_mat' };
  }
  if (inner.cpp === 'std::vector<bool>') {
    return { cpp: 'std::vector<std::vector<bool>>', conv: 'lc::to_bool_mat' };
  }
  if (inner.cpp === 'std::vector<std::string>') {
    return { cpp: 'std::vector<std::vector<std::string>>', conv: 'lc::to_str_mat' };
  }
  return null;
}

/** 读用例原文并推断 json 参数的 C++ 类型；推断不出来就退回「原始 JSON 文本」。 */
function jsonSpecFor(input: HarnessInput, paramIndex: number, notes: string[]): CppArgSpec | null {
  let shape: JShape | null = null;
  for (const c of input.testCases) {
    const raw = c.args[paramIndex];
    if (raw === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    const s = shapeOfValue(value);
    if (s === null) return null;
    shape = shape === null ? s : mergeShape(shape, s);
    if (shape === null) return null;
  }
  if (shape === null) return null;
  const spec = specForShape(shape);
  if (!spec) {
    notes.push('json 参数无法推断静态类型，已按「原始 JSON 文本（std::string）」传入。');
    return { cpp: 'std::string', conv: 'lc::to_raw' };
  }
  return spec;
}

/* ------------------------------------------------------------------ *
 * C++ 公共头（JSON 解析 + 序列化 + 协议输出）
 * ------------------------------------------------------------------ */

const CXX_PRELUDE = String.raw`// 自动生成：LeetCode 本地测试脚手架公共头（请勿手改）
#ifndef LC_PRELUDE_HPP_
#define LC_PRELUDE_HPP_

#include <algorithm>
#include <array>
#include <bitset>
#include <cassert>
#include <cctype>
#include <cfloat>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <istream>
#include <iterator>
#include <limits>
#include <list>
#include <map>
#include <memory>
#include <numeric>
#include <optional>
#include <ostream>
#include <queue>
#include <random>
#include <set>
#include <sstream>
#include <stack>
#include <stdexcept>
#include <string>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>

/* 节点结构体只做前置声明，完整定义在 _lc_nodes.hpp（便于兼容用户自己的定义） */
struct ListNode;
struct TreeNode;

namespace lc {

/* ===================== 极简 JSON（只处理数组/数字/字符串/bool/null/对象） ===================== */

struct Json {
  enum Kind { NUL = 0, BOO, NUM, STR, ARR, OBJ };
  Kind kind = NUL;
  bool b = false;
  double num = 0;
  std::string str;  // STR 的值；NUM 时存原始数字文本，便于整数精确转换
  std::vector<Json> arr;
  std::vector<std::pair<std::string, Json>> obj;

  const Json* find(const std::string& key) const {
    if (kind != OBJ) return nullptr;
    for (size_t i = 0; i < obj.size(); ++i) {
      if (obj[i].first == key) return &obj[i].second;
    }
    return nullptr;
  }
};

inline const Json& null_json() {
  static const Json kNull;
  return kNull;
}

/** 安全取数组元素（越界返回 null Json，避免未定义行为） */
inline const Json& at(const Json& container, size_t index) {
  if (container.kind != Json::ARR || index >= container.arr.size()) return null_json();
  return container.arr[index];
}

class Parser {
 public:
  explicit Parser(const std::string& text) : s_(text), i_(0) {}

  bool parse(Json& out) {
    skip_ws();
    if (!value(out)) return false;
    skip_ws();
    return true;
  }

 private:
  const std::string& s_;
  size_t i_;

  char peek() const { return i_ < s_.size() ? s_[i_] : '\0'; }

  void skip_ws() {
    while (i_ < s_.size()) {
      char c = s_[i_];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
        ++i_;
        continue;
      }
      break;
    }
  }

  bool literal(const char* text) {
    size_t n = std::strlen(text);
    if (s_.compare(i_, n, text) != 0) return false;
    i_ += n;
    return true;
  }

  static void append_utf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
      out.push_back((char)cp);
    } else if (cp < 0x800) {
      out.push_back((char)(0xC0 | (cp >> 6)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back((char)(0xE0 | (cp >> 12)));
      out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    } else {
      out.push_back((char)(0xF0 | (cp >> 18)));
      out.push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    }
  }

  bool hex4(unsigned& out) {
    if (i_ + 4 > s_.size()) return false;
    unsigned v = 0;
    for (int k = 0; k < 4; ++k) {
      char c = s_[i_ + (size_t)k];
      unsigned d = 0;
      if (c >= '0' && c <= '9') {
        d = (unsigned)(c - '0');
      } else if (c >= 'a' && c <= 'f') {
        d = (unsigned)(c - 'a' + 10);
      } else if (c >= 'A' && c <= 'F') {
        d = (unsigned)(c - 'A' + 10);
      } else {
        return false;
      }
      v = v * 16 + d;
    }
    i_ += 4;
    out = v;
    return true;
  }

  bool str_value(std::string& out) {
    if (peek() != '"') return false;
    ++i_;
    out.clear();
    while (i_ < s_.size()) {
      char c = s_[i_++];
      if (c == '"') return true;
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (i_ >= s_.size()) return false;
      char e = s_[i_++];
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          unsigned cp = 0;
          if (!hex4(cp)) return false;
          append_utf8(out, cp);
          break;
        }
        default:
          return false;
      }
    }
    return false;
  }

  bool num_value(Json& out) {
    size_t start = i_;
    if (peek() == '-' || peek() == '+') ++i_;
    bool seen = false;
    while (i_ < s_.size()) {
      char c = s_[i_];
      if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
        ++i_;
        seen = true;
        continue;
      }
      break;
    }
    if (!seen) return false;
    std::string text = s_.substr(start, i_ - start);
    char* end = nullptr;
    double v = std::strtod(text.c_str(), &end);
    if (end == text.c_str()) return false;
    out = Json();
    out.kind = Json::NUM;
    out.num = v;
    out.str = text;
    return true;
  }

  bool arr_value(Json& out) {
    if (peek() != '[') return false;
    ++i_;
    out = Json();
    out.kind = Json::ARR;
    skip_ws();
    if (peek() == ']') {
      ++i_;
      return true;
    }
    while (true) {
      Json item;
      if (!value(item)) return false;
      out.arr.push_back(item);
      skip_ws();
      char c = peek();
      if (c == ',') {
        ++i_;
        skip_ws();
        continue;
      }
      if (c == ']') {
        ++i_;
        return true;
      }
      return false;
    }
  }

  bool obj_value(Json& out) {
    if (peek() != '{') return false;
    ++i_;
    out = Json();
    out.kind = Json::OBJ;
    skip_ws();
    if (peek() == '}') {
      ++i_;
      return true;
    }
    while (true) {
      std::string key;
      if (!str_value(key)) return false;
      skip_ws();
      if (peek() != ':') return false;
      ++i_;
      Json item;
      if (!value(item)) return false;
      out.obj.push_back(std::make_pair(key, item));
      skip_ws();
      char c = peek();
      if (c == ',') {
        ++i_;
        skip_ws();
        continue;
      }
      if (c == '}') {
        ++i_;
        return true;
      }
      return false;
    }
  }

  bool value(Json& out) {
    skip_ws();
    char c = peek();
    if (c == '{') return obj_value(out);
    if (c == '[') return arr_value(out);
    if (c == '"') {
      out = Json();
      out.kind = Json::STR;
      return str_value(out.str);
    }
    if (c == 't') {
      if (!literal("true")) return false;
      out = Json();
      out.kind = Json::BOO;
      out.b = true;
      return true;
    }
    if (c == 'f') {
      if (!literal("false")) return false;
      out = Json();
      out.kind = Json::BOO;
      out.b = false;
      return true;
    }
    if (c == 'n') {
      if (!literal("null")) return false;
      out = Json();
      out.kind = Json::NUL;
      return true;
    }
    return num_value(out);
  }
};

inline bool parse_json(const std::string& text, Json& out) {
  Parser p(text);
  return p.parse(out);
}

/** 解析失败时退化成「整段文本就是一个字符串」，兼容题面里未加引号的字符串参数。 */
inline Json parse_json(const std::string& text) {
  Json out;
  if (!parse_json(text, out)) {
    out = Json();
    out.kind = Json::STR;
    out.str = text;
  }
  return out;
}

/** 用例 args 里存的是「每个参数一行原文」：字符串元素再解析一层得到真实值。 */
inline Json from_arg(const Json& raw) {
  if (raw.kind == Json::STR) {
    Json inner;
    if (parse_json(raw.str, inner)) return inner;
  }
  return raw;
}

/* ===================== 序列化（LeetCode 习惯） ===================== */

inline std::string json_quote(const std::string& s) {
  std::string out = "\"";
  for (size_t i = 0; i < s.size(); ++i) {
    unsigned char c = (unsigned char)s[i];
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", (unsigned)c);
          out += buf;
        } else {
          out += (char)c;
        }
    }
  }
  out += "\"";
  return out;
}

/** double 输出：保证精度（12 位有效数字），整数值不带多余小数位（比较器会归一化）。 */
inline std::string dump_double(double v) {
  if (std::isnan(v)) return "NaN";
  if (std::isinf(v)) return v > 0 ? "Infinity" : "-Infinity";
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.12g", v);
  return std::string(buf);
}

/* 数组元素序列化（字符串/字符带引号） */
template <class T>
std::string el(const T& v);
inline std::string el(const std::string& s) { return json_quote(s); }
inline std::string el(const char* s) { return json_quote(s ? std::string(s) : std::string()); }
inline std::string el(char c) { return json_quote(std::string(1, c)); }
/* 节点类型的元素序列化（定义在 _lc_nodes.hpp） */
std::string el(ListNode* node);
std::string el(TreeNode* node);

/* 顶层序列化：字符串/字符按原文输出；节点类型在 _lc_nodes.hpp 里定义 */
inline std::string val(const std::string& s) { return s; }
inline std::string val(const char* s) { return s ? std::string(s) : std::string(); }
inline std::string val(char c) { return std::string(1, c); }
inline std::string val(bool b) { return b ? "true" : "false"; }
inline std::string val(int v) { return std::to_string(v); }
inline std::string val(long v) { return std::to_string(v); }
inline std::string val(long long v) { return std::to_string(v); }
inline std::string val(unsigned v) { return std::to_string(v); }
inline std::string val(unsigned long v) { return std::to_string(v); }
inline std::string val(unsigned long long v) { return std::to_string(v); }
inline std::string val(double v) { return dump_double(v); }
inline std::string val(float v) { return dump_double((double)v); }
std::string val(ListNode* node);
std::string val(TreeNode* node);

template <class T>
std::string val(const std::vector<T>& v) {
  std::string out = "[";
  for (size_t i = 0; i < v.size(); ++i) {
    if (i) out += ',';
    out += el(v[i]);
  }
  out += "]";
  return out;
}

inline std::string val(const std::vector<bool>& v) {
  std::string out = "[";
  for (size_t i = 0; i < v.size(); ++i) {
    if (i) out += ',';
    out += v[i] ? "true" : "false";
  }
  out += "]";
  return out;
}

/* 其它类型（例如 pair / 自定义结构）退化成 ostream 输出 */
template <class T>
std::string val(const T& v) {
  std::ostringstream os;
  os << v;
  return os.str();
}

template <class T>
std::string el(const T& v) { return val(v); }

/** JSON → C++ 值 */
inline long long to_ll(const Json& j) {
  if (j.kind == Json::NUM) {
    if (!j.str.empty() && j.str.find('.') == std::string::npos &&
        j.str.find('e') == std::string::npos && j.str.find('E') == std::string::npos) {
      return (long long)std::strtoll(j.str.c_str(), nullptr, 10);
    }
    return (long long)std::llround(j.num);
  }
  if (j.kind == Json::BOO) return j.b ? 1 : 0;
  if (j.kind == Json::STR) return (long long)std::strtoll(j.str.c_str(), nullptr, 10);
  return 0;
}

inline int to_int(const Json& j) { return (int)to_ll(j); }

inline double to_double(const Json& j) {
  if (j.kind == Json::NUM) return j.num;
  if (j.kind == Json::BOO) return j.b ? 1.0 : 0.0;
  if (j.kind == Json::STR) return std::strtod(j.str.c_str(), nullptr);
  return 0.0;
}

inline bool to_bool(const Json& j) {
  if (j.kind == Json::BOO) return j.b;
  if (j.kind == Json::NUM) return j.num != 0;
  if (j.kind == Json::STR) return j.str == "true" || j.str == "1";
  return false;
}

inline void dump_json_into(const Json& j, std::string& out);

inline std::string to_text(const Json& j) {
  if (j.kind == Json::STR) return j.str;
  if (j.kind == Json::NUM) return j.str.empty() ? dump_double(j.num) : j.str;
  if (j.kind == Json::BOO) return j.b ? "true" : "false";
  if (j.kind == Json::NUL) return "";
  std::string out;
  dump_json_into(j, out);
  return out;
}

/** json 兜底：直接把值还原成 JSON 文本 */
inline std::string to_raw(const Json& j) { return to_text(j); }

inline char to_char(const Json& j) {
  std::string t = to_text(j);
  return t.empty() ? '\0' : t[0];
}

inline std::vector<int> to_int_vec(const Json& j) {
  std::vector<int> out;
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(to_int(j.arr[i]));
  return out;
}

inline std::vector<long long> to_ll_vec(const Json& j) {
  std::vector<long long> out;
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(to_ll(j.arr[i]));
  return out;
}

inline std::vector<double> to_double_vec(const Json& j) {
  std::vector<double> out;
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(to_double(j.arr[i]));
  return out;
}

inline std::vector<bool> to_bool_vec(const Json& j) {
  std::vector<bool> out;
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(to_bool(j.arr[i]));
  return out;
}

inline std::vector<std::string> to_str_vec(const Json& j) {
  std::vector<std::string> out;
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(to_text(j.arr[i]));
  return out;
}

inline std::vector<char> to_char_vec(const Json& j) {
  std::vector<char> out;
  if (j.kind == Json::STR) {
    out.assign(j.str.begin(), j.str.end());
    return out;
  }
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(to_char(j.arr[i]));
  return out;
}

inline std::vector<std::vector<int>> to_int_mat(const Json& j) {
  std::vector<std::vector<int>> out;
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(to_int_vec(j.arr[i]));
  return out;
}

inline std::vector<std::vector<double>> to_double_mat(const Json& j) {
  std::vector<std::vector<double>> out;
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(to_double_vec(j.arr[i]));
  return out;
}

inline std::vector<std::vector<bool>> to_bool_mat(const Json& j) {
  std::vector<std::vector<bool>> out;
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(to_bool_vec(j.arr[i]));
  return out;
}

inline std::vector<std::vector<char>> to_char_mat(const Json& j) {
  std::vector<std::vector<char>> out;
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) {
    const Json& row = j.arr[i];
    if (row.kind == Json::STR) {
      out.push_back(std::vector<char>(row.str.begin(), row.str.end()));
    } else {
      out.push_back(to_char_vec(row));
    }
  }
  return out;
}

inline std::vector<std::vector<std::string>> to_str_mat(const Json& j) {
  std::vector<std::vector<std::string>> out;
  if (j.kind != Json::ARR) return out;
  out.reserve(j.arr.size());
  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(to_str_vec(j.arr[i]));
  return out;
}

inline void dump_json_into(const Json& j, std::string& out) {
  switch (j.kind) {
    case Json::NUL:
      out += "null";
      break;
    case Json::BOO:
      out += j.b ? "true" : "false";
      break;
    case Json::NUM:
      out += j.str.empty() ? dump_double(j.num) : j.str;
      break;
    case Json::STR:
      out += json_quote(j.str);
      break;
    case Json::ARR:
      out += '[';
      for (size_t i = 0; i < j.arr.size(); ++i) {
        if (i) out += ',';
        dump_json_into(j.arr[i], out);
      }
      out += ']';
      break;
    case Json::OBJ:
      out += '{';
      for (size_t i = 0; i < j.obj.size(); ++i) {
        if (i) out += ',';
        out += json_quote(j.obj[i].first);
        out += ':';
        dump_json_into(j.obj[i].second, out);
      }
      out += '}';
      break;
  }
}

/* ===================== 输出协议 ===================== */

inline long long now_ms() {
  return (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

inline bool read_file(const std::string& path, std::string& out) {
  std::ifstream in(path.c_str(), std::ios::in | std::ios::binary);
  if (!in) return false;
  std::ostringstream ss;
  ss << in.rdbuf();
  out = ss.str();
  return true;
}

/** 捕获用户代码写到 std::cout 的调试输出，避免串到协议行里 */
struct CoutCapture {
  std::ostringstream buffer;
  std::streambuf* previous = nullptr;
  void start() {
    previous = std::cout.rdbuf(buffer.rdbuf());
  }
  std::string stop() {
    std::cout.rdbuf(previous);
    std::cout.flush();
    return buffer.str();
  }
};

/** 协议行前统一补一个换行，防止用户输出没有行尾导致协议行被污染 */
inline void emit_result(long long index, const std::string& actual, const std::string& error,
                        long long duration_ms, const std::string& logs) {
  std::cout << "\n__LC_RESULT__ {\"i\":" << index << ",\"actual\":" << json_quote(actual)
            << ",\"error\":";
  if (error.empty()) {
    std::cout << "null";
  } else {
    std::cout << json_quote(error);
  }
  std::cout << ",\"durationMs\":" << duration_ms;
  if (!logs.empty()) std::cout << ",\"logs\":" << json_quote(logs);
  std::cout << "}" << std::endl;
}

inline void emit_fatal(const std::string& code) {
  std::cout << "\n__LC_ERROR__ {\"fatal\":" << json_quote(code) << "}" << std::endl;
}

inline void emit_done(long long elapsed_ms) {
  std::cout << "\n__LC_DONE__ {\"elapsedMs\":" << elapsed_ms << "}" << std::endl;
}

}  // namespace lc

#endif  // LC_PRELUDE_HPP_
`;

/**
 * 节点结构体定义。必须在用户代码之前 include：用户写的 `head->val` 这类成员访问
 * 需要完整类型（LeetCode 判题机也是这么提供的）。用户自己定义了同名结构体时跳过。
 */
function cxxNodesTypesHeader(input: HarnessInput): string {
  const src = input.sourceCode;
  // 只认「定义」（带花括号），`ListNode* head` / `struct ListNode* head` 这种声明不算
  const userHasListNode = /\b(?:struct|class)\s+ListNode\b\s*(?::[^{;]*)?\{/.test(src);
  const userHasTreeNode = /\b(?:struct|class)\s+TreeNode\b\s*(?::[^{;]*)?\{/.test(src);
  const lines: string[] = [];
  lines.push('// 自动生成：LeetCode 本地测试脚手架的节点类型（请勿手改）');
  lines.push('#ifndef LC_NODES_HPP_');
  lines.push('#define LC_NODES_HPP_');
  lines.push('');
  lines.push('#include "_lc_prelude.hpp"');
  lines.push('');
  if (userHasListNode) {
    lines.push('/* 用户代码里已经定义了 ListNode，这里不再重复定义 */');
  } else {
    lines.push('struct ListNode {');
    lines.push('  int val;');
    lines.push('  ListNode* next;');
    lines.push('  ListNode() : val(0), next(nullptr) {}');
    lines.push('  ListNode(int x) : val(x), next(nullptr) {}');
    lines.push('  ListNode(int x, ListNode* nextNode) : val(x), next(nextNode) {}');
    lines.push('};');
  }
  lines.push('');
  if (userHasTreeNode) {
    lines.push('/* 用户代码里已经定义了 TreeNode，这里不再重复定义 */');
  } else {
    lines.push('struct TreeNode {');
    lines.push('  int val;');
    lines.push('  TreeNode* left;');
    lines.push('  TreeNode* right;');
    lines.push('  TreeNode() : val(0), left(nullptr), right(nullptr) {}');
    lines.push('  TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}');
    lines.push('  TreeNode(int x, TreeNode* l, TreeNode* r) : val(x), left(l), right(r) {}');
    lines.push('};');
  }
  lines.push('');
  lines.push('#endif  // LC_NODES_HPP_');
  lines.push('');
  return lines.join('\n');
}

/** 节点构造 + 序列化实现（放在用户代码之后 include：那时类型一定已经完整） */
function cxxNodesImplHeader(): string {
  const lines: string[] = [];
  lines.push('// 自动生成：节点构造与序列化实现（请勿手改）');
  lines.push('#ifndef LC_NODES_IMPL_HPP_');
  lines.push('#define LC_NODES_IMPL_HPP_');
  lines.push('');
  lines.push('#include "_lc_nodes.hpp"');
  lines.push('');
  lines.push('namespace lc {');
  lines.push('');
  lines.push('/* 兼容两种结构体写法：LeetCode 官方的 ListNode(int) / 用户自己写的聚合体 */');
  lines.push('template <class T, class = void>');
  lines.push('struct has_int_ctor : std::false_type {};');
  lines.push('');
  lines.push('template <class T>');
  lines.push('struct has_int_ctor<T, std::void_t<decltype(T(0))>> : std::true_type {};');
  lines.push('');
  lines.push('template <class T>');
  lines.push('inline T* alloc_node(int value) {');
  lines.push('  T* node = nullptr;');
  lines.push('  if constexpr (has_int_ctor<T>::value) {');
  lines.push('    node = new T(value);');
  lines.push('  } else {');
  lines.push('    node = new T();');
  lines.push('  }');
  lines.push('  node->val = value;');
  lines.push('  return node;');
  lines.push('}');
  lines.push('');
  lines.push('inline ListNode* make_list(const Json& j) {');
  lines.push('  if (j.kind != Json::ARR) return nullptr;');
  lines.push('  ListNode* head = nullptr;');
  lines.push('  ListNode** tail = &head;');
  lines.push('  for (size_t i = 0; i < j.arr.size(); ++i) {');
  lines.push('    ListNode* node = alloc_node<ListNode>(to_int(j.arr[i]));');
  lines.push('    node->next = nullptr;');
  lines.push('    *tail = node;');
  lines.push('    tail = &node->next;');
  lines.push('  }');
  lines.push('  return head;');
  lines.push('}');
  lines.push('');
  lines.push('inline std::vector<ListNode*> make_list_vec(const Json& j) {');
  lines.push('  std::vector<ListNode*> out;');
  lines.push('  if (j.kind != Json::ARR) return out;');
  lines.push('  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(make_list(j.arr[i]));');
  lines.push('  return out;');
  lines.push('}');
  lines.push('');
  lines.push('inline TreeNode* make_tree(const Json& j) {');
  lines.push('  if (j.kind != Json::ARR || j.arr.empty() || j.arr[0].kind == Json::NUL) return nullptr;');
  lines.push('  TreeNode* root = alloc_node<TreeNode>(to_int(j.arr[0]));');
  lines.push('  root->left = nullptr;');
  lines.push('  root->right = nullptr;');
  lines.push('  std::deque<TreeNode*> q;');
  lines.push('  q.push_back(root);');
  lines.push('  size_t k = 1;');
  lines.push('  while (!q.empty() && k < j.arr.size()) {');
  lines.push('    TreeNode* node = q.front();');
  lines.push('    q.pop_front();');
  lines.push('    if (k < j.arr.size()) {');
  lines.push('      if (j.arr[k].kind != Json::NUL) {');
  lines.push('        TreeNode* child = alloc_node<TreeNode>(to_int(j.arr[k]));');
  lines.push('        child->left = nullptr;');
  lines.push('        child->right = nullptr;');
  lines.push('        node->left = child;');
  lines.push('        q.push_back(child);');
  lines.push('      }');
  lines.push('      ++k;');
  lines.push('    }');
  lines.push('    if (k < j.arr.size()) {');
  lines.push('      if (j.arr[k].kind != Json::NUL) {');
  lines.push('        TreeNode* child = alloc_node<TreeNode>(to_int(j.arr[k]));');
  lines.push('        child->left = nullptr;');
  lines.push('        child->right = nullptr;');
  lines.push('        node->right = child;');
  lines.push('        q.push_back(child);');
  lines.push('      }');
  lines.push('      ++k;');
  lines.push('    }');
  lines.push('  }');
  lines.push('  return root;');
  lines.push('}');
  lines.push('');
  lines.push('inline std::vector<TreeNode*> make_tree_vec(const Json& j) {');
  lines.push('  std::vector<TreeNode*> out;');
  lines.push('  if (j.kind != Json::ARR) return out;');
  lines.push('  for (size_t i = 0; i < j.arr.size(); ++i) out.push_back(make_tree(j.arr[i]));');
  lines.push('  return out;');
  lines.push('}');
  lines.push('');
  lines.push('inline std::string val(ListNode* node) {');
  lines.push('  std::string out = "[";');
  lines.push('  bool first = true;');
  lines.push('  int guard = 0;');
  lines.push('  while (node != nullptr && guard++ < 200000) {');
  lines.push('    if (!first) out += \',\';');
  lines.push('    first = false;');
  lines.push('    out += std::to_string(node->val);');
  lines.push('    node = node->next;');
  lines.push('  }');
  lines.push('  out += "]";');
  lines.push('  return out;');
  lines.push('}');
  lines.push('');
  lines.push('inline std::string el(ListNode* node) { return val(node); }');
  lines.push('');
  lines.push('inline std::string val(TreeNode* tree) {');
  lines.push('  std::vector<std::string> items;');
  lines.push('  if (tree != nullptr) {');
  lines.push('    std::deque<TreeNode*> q;');
  lines.push('    q.push_back(tree);');
  lines.push('    while (!q.empty()) {');
  lines.push('      TreeNode* cur = q.front();');
  lines.push('      q.pop_front();');
  lines.push('      if (cur == nullptr) {');
  lines.push('        items.push_back("null");');
  lines.push('        continue;');
  lines.push('      }');
  lines.push('      items.push_back(std::to_string(cur->val));');
  lines.push('      q.push_back(cur->left);');
  lines.push('      q.push_back(cur->right);');
  lines.push('    }');
  lines.push('  }');
  lines.push('  while (!items.empty() && items.back() == "null") items.pop_back();');
  lines.push('  std::string out = "[";');
  lines.push('  for (size_t i = 0; i < items.size(); ++i) {');
  lines.push('    if (i) out += \',\';');
  lines.push('    out += items[i];');
  lines.push('  }');
  lines.push('  out += "]";');
  lines.push('  return out;');
  lines.push('}');
  lines.push('');
  lines.push('inline std::string el(TreeNode* tree) { return val(tree); }');
  lines.push('');
  lines.push('}  // namespace lc');
  lines.push('');
  lines.push('#endif  // LC_NODES_IMPL_HPP_');
  lines.push('');
  return lines.join('\n');
}

/** Apple clang 没有 bits/stdc++.h，这里造一个兼容头（内容只含常用标准头）。 */
function cxxBitsCompatHeader(): string {
  return [
    '// 自动生成：本机编译器没有 bits/stdc++.h，这是兼容头（只含常用标准库头）。',
    '#ifndef LC_BITS_STDCPP_COMPAT_H_',
    '#define LC_BITS_STDCPP_COMPAT_H_',
    '',
    commonIncludes(),
    '',
    '#endif  // LC_BITS_STDCPP_COMPAT_H_',
    '',
  ].join('\n');
}

/** C 字符串字面量（JSON.stringify 的转义对 C/C++ 字符串同样成立） */
function cString(text: string): string {
  return JSON.stringify(text);
}

function buildCppEntry(input: HarnessInput, notes: string[]): string {
  const entryName = (input.meta.name ?? '').trim();
  const className = (input.meta.classname ?? '').trim() || 'Solution';
  const returnKind = classifyType(input.meta.return.type);
  const inPlaceIndex = inPlaceAnswerParam(input.meta);
  const casesPath = join(input.genDir, CASES_FILE);

  const lines: string[] = [];
  lines.push('// 自动生成：LeetCode 本地测试入口（请勿手改，重建脚手架会覆盖）');
  lines.push(commonIncludes());
  lines.push('');
  lines.push('#include "_lc_prelude.hpp"');
  lines.push('#include "_lc_nodes.hpp"');
  lines.push('');
  lines.push('/* 用绝对路径 include 用户代码：genDir 与用户目录不同也能编译；');
  lines.push('   用户文件里若自带 main，临时改名以免与脚手架 main 冲突。 */');
  lines.push('#define main _lc_user_main_disabled');
  lines.push(`#include ${cString(input.sourceAbsPath)}`);
  lines.push('#undef main');
  lines.push('');
  lines.push('/* 节点相关实现放在用户代码之后：此时 ListNode / TreeNode 一定是完整类型 */');
  lines.push('#include "_lc_nodes_impl.hpp"');
  lines.push('');
  lines.push('int main() {');
  lines.push('  std::string payload_text;');
  lines.push(`  if (!lc::read_file(${cString(casesPath)}, payload_text)) {`);
  lines.push('    lc::emit_fatal("cases_not_found");');
  lines.push('    return 1;');
  lines.push('  }');
  lines.push('  lc::Json payload = lc::parse_json(payload_text);');
  lines.push('  const lc::Json* cases = payload.find("cases");');
  lines.push('  if (cases == nullptr || cases->kind != lc::Json::ARR) {');
  lines.push('    lc::emit_fatal("cases_malformed");');
  lines.push('    return 2;');
  lines.push('  }');

  if (entryName === '') {
    // 没有函数名就无法生成调用，直接按协议报 entry_not_found
    lines.push('  lc::emit_fatal("entry_not_found");');
    lines.push('  return 3;');
    lines.push('}');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('  long long started = lc::now_ms();');
  lines.push('  for (size_t case_idx = 0; case_idx < cases->arr.size(); ++case_idx) {');
  lines.push('    const lc::Json& cur = cases->arr[case_idx];');
  lines.push('    const lc::Json* index_json = cur.find("i");');
  lines.push('    long long case_no = index_json != nullptr ? lc::to_ll(*index_json) : (long long)case_idx;');
  lines.push('    const lc::Json* args_json = cur.find("args");');
  lines.push('    const lc::Json& args = args_json != nullptr ? *args_json : lc::null_json();');
  lines.push('    std::string actual;');
  lines.push('    std::string error;');
  lines.push('    std::string logs;');
  lines.push('    long long case_started = lc::now_ms();');
  lines.push('    {');
  lines.push('      lc::CoutCapture capture;');
  lines.push('      capture.start();');
  lines.push('      try {');

  // 逐个参数解析
  input.meta.params.forEach((param, i) => {
    const kind = classifyType(param.type);
    let spec = CPP_ARG_SPECS[kind];
    if (!spec) {
      if (kind === 'json') {
        spec = jsonSpecFor(input, i, notes) ?? { cpp: 'std::string', conv: 'lc::to_raw' };
      } else {
        spec = { cpp: 'std::string', conv: 'lc::to_raw' };
      }
    }
    lines.push(`        lc::Json json_${i} = lc::from_arg(lc::at(args, ${i}));`);
    lines.push(`        ${spec.cpp} a${i} = ${spec.conv}(json_${i});`);
  });

  lines.push(`        ${className} solution;`);
  const callArgs = input.meta.params.map((_, i) => `a${i}`).join(', ');
  if (returnKind === 'void') {
    lines.push(`        solution.${entryName}(${callArgs});`);
    if (inPlaceIndex >= 0) {
      lines.push(`        actual = lc::val(a${inPlaceIndex});`);
    } else {
      lines.push('        actual = "null";');
    }
  } else {
    lines.push(`        auto result = solution.${entryName}(${callArgs});`);
    lines.push('        actual = lc::val(result);');
  }
  lines.push('      } catch (const std::exception& e) {');
  lines.push('        error = std::string("运行时异常：") + e.what();');
  lines.push('      } catch (...) {');
  lines.push('        error = "运行时异常：未知错误";');
  lines.push('      }');
  lines.push('      logs = capture.stop();');
  lines.push('    }');
  lines.push('    lc::emit_result(case_no, actual, error, lc::now_ms() - case_started, logs);');
  lines.push('  }');
  lines.push('  lc::emit_done(lc::now_ms() - started);');
  lines.push('  return 0;');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/** 该类型能否被 C++ 脚手架承接 */
function cppKindOk(kind: TypeKind): boolean {
  if (kind === 'json' || kind === 'void') return true;
  return CPP_ARG_SPECS[kind] !== undefined;
}

export const CppHarness: LanguageHarness = {
  slug: 'cpp',
  installHint:
    '需要本地 C++ 编译器 g++ 或 clang++（macOS：`xcode-select --install`；Ubuntu：`apt install build-essential`）。',
  supports(meta: LcMetaData): HarnessSupport {
    if (meta.construct) {
      return { ok: false, reason: '设计类题目（多步操作）暂不支持本地脚手架' };
    }
    const allTypes = [...meta.params.map((p) => p.type), meta.return.type];
    for (const type of allTypes) {
      if (!cppKindOk(classifyType(type))) {
        return { ok: false, reason: `暂不支持的类型：${type}` };
      }
    }
    return { ok: true };
  },
  generate(input: HarnessInput): HarnessArtifact {
    const notes: string[] = [
      '用 C++17 编译（g++/clang++），入口文件通过绝对路径 include 你的代码，不会修改你的源文件。',
    ];
    const files: HarnessFile[] = [];
    files.push({ name: CASES_FILE, content: serializeCases(input) });
    files.push({ name: '_lc_prelude.hpp', content: CXX_PRELUDE });
    files.push({ name: '_lc_nodes.hpp', content: cxxNodesTypesHeader(input) });
    files.push({ name: '_lc_nodes_impl.hpp', content: cxxNodesImplHeader() });
    files.push({ name: '_lc_main.cpp', content: buildCppEntry(input, notes) });

    const needsBitsCompat = input.sourceCode.includes('bits/stdc++.h');
    if (needsBitsCompat) {
      files.push({ name: 'bits/stdc++.h', content: cxxBitsCompatHeader() });
      notes.push('检测到 #include <bits/stdc++.h>，已在 genDir 生成兼容头并用 -I 指向它。');
    }

    const binPath = join(input.genDir, '_lc_bin');
    return {
      files,
      steps: [
        {
          label: 'compile',
          cmd: 'g++',
          args: [
            '-std=c++17',
            '-O2',
            '-w',
            `-I${input.genDir}`,
            '-o',
            binPath,
            join(input.genDir, '_lc_main.cpp'),
          ],
          fatal: true,
        },
        { label: 'run', cmd: binPath, args: [], fatal: false },
      ],
      debugEntry: '_lc_main.cpp',
      debugType: 'cppdbg',
      notes,
    };
  },
};
