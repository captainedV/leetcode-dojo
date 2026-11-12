/**
 * 刷题常用 API 签名库（纯数据 + 纯查询，**不依赖 vscode**，可直接单测）。
 *
 * 设计目标：刷题时真正卡壳的从来不是算法思路，而是「这个 API 叫什么、参数顺序是什么、
 * 有什么坑」。所以这里只收录**函数签名 / 用法要点**，绝不包含任何算法逻辑，
 * 保证「提示 API」与「给出题解」之间有一条清晰的界线。
 *
 * key 使用 LeetCode 的 langSlug：python3 / javascript / cpp / java / golang / rust。
 * 别名（python、typescript、go、js…）在查询时归一化，不重复存数据。
 */

export interface ApiSignature {
  /** 可插入的标识符（可能带限定名，例如 `Math.floor`、`new Map`） */
  name: string;
  /** 展示用的完整调用形式，包含参数名，例如 `bisect.bisect_left(a, x)` */
  signature: string;
  /** 中文一句话：用法 / 坑 */
  doc: string;
  /** 返回类型（可选） */
  returns?: string;
  /** 归属：模块 / 类型 / 容器，用来支持「输入 `bisect.` 时只提示 bisect 下的 API」 */
  owner?: string;
  /** 最小示例（可选） */
  example?: string;
}

const python3: ApiSignature[] = [
  // ---- bisect：有序数组二分 ----
  {
    name: 'bisect_left',
    signature: 'bisect.bisect_left(a, x)',
    doc: '在升序列表 a 中返回第一个 >= x 的下标（插入点）；a 必须已排序，返回 [0, len(a)] 之间的位置。',
    returns: 'int',
    owner: 'bisect',
    example: 'bisect.bisect_left([1, 3, 5], 3) -> 1',
  },
  {
    name: 'bisect_right',
    signature: 'bisect.bisect_right(a, x)',
    doc: '返回第一个 > x 的下标；与 bisect_left 的差别只在重复元素上（左/右插入点）。',
    returns: 'int',
    owner: 'bisect',
    example: 'bisect.bisect_right([1, 3, 3, 5], 3) -> 3',
  },
  // ---- heapq：只有小顶堆，大顶堆存负值 ----
  {
    name: 'heappush',
    signature: 'heapq.heappush(h, item)',
    doc: '把 item 压入小顶堆 h，O(log n)；Python 没有大顶堆，要最大值就存 -x。',
    returns: 'None',
    owner: 'heapq',
  },
  {
    name: 'heappop',
    signature: 'heapq.heappop(h)',
    doc: '弹出并返回最小元素，O(log n)；堆空时抛 IndexError。',
    owner: 'heapq',
  },
  {
    name: 'heapify',
    signature: 'heapq.heapify(h)',
    doc: '原地把列表堆化成小顶堆，O(n)；比逐个 heappush 快，堆里存元组时默认按元组字典序比较。',
    returns: 'None',
    owner: 'heapq',
  },
  {
    name: 'heappushpop',
    signature: 'heapq.heappushpop(h, item)',
    doc: '先 push 再 pop 并返回最小值（堆会被修改），比分开两次调用少一次调整。',
    owner: 'heapq',
  },
  {
    name: 'heapreplace',
    signature: 'heapq.heapreplace(h, item)',
    doc: '先 pop 再 push（堆不能为空），适合维护「固定大小的堆」替换堆顶。',
    owner: 'heapq',
  },
  {
    name: 'nlargest',
    signature: 'heapq.nlargest(k, it)',
    doc: '返回前 k 个最大元素组成的列表（按降序）；k 远小于 n 时比整体排序快。',
    returns: 'list',
    owner: 'heapq',
  },
  {
    name: 'nsmallest',
    signature: 'heapq.nsmallest(k, it)',
    doc: '返回前 k 个最小元素组成的列表（按升序）。',
    returns: 'list',
    owner: 'heapq',
  },
  // ---- collections ----
  {
    name: 'Counter',
    signature: 'collections.Counter(s)',
    doc: '统计可哈希元素出现次数，c[x] 缺失时返回 0；取高频用 c.most_common(k)。',
    returns: 'Counter',
    owner: 'collections',
    example: 'Counter("aab").most_common(1) -> [("a", 2)]',
  },
  {
    name: 'defaultdict',
    signature: 'collections.defaultdict(list)',
    doc: '缺键时自动调用 list()/int() 建值，省掉「先判断再初始化」；注意读不存在的键会**写入**新键。',
    returns: 'defaultdict',
    owner: 'collections',
  },
  {
    name: 'deque',
    signature: 'collections.deque(it)',
    doc: '双端队列，两端 O(1) 进出（appendleft/popleft），列表当队列 pop(0) 是 O(n)。',
    returns: 'deque',
    owner: 'collections',
  },
  {
    name: 'appendleft',
    signature: 'q.appendleft(x)',
    doc: 'deque 左端插入，O(1)；deque 满了（maxlen）会挤掉右端元素。',
    returns: 'None',
    owner: 'deque',
  },
  {
    name: 'popleft',
    signature: 'q.popleft()',
    doc: 'deque 左端弹出，O(1)；空 deque 上调用抛 IndexError。',
    owner: 'deque',
  },
  // ---- str ----
  {
    name: 'isalnum',
    signature: 's.isalnum()',
    doc: '非空且所有字符都是字母或数字才为 True（空格、标点返回 False）。',
    returns: 'bool',
    owner: 'str',
  },
  {
    name: 'isdigit',
    signature: 's.isdigit()',
    doc: '非空且全为十进制数字才为 True；负号、小数点、空格都会让它返回 False。',
    returns: 'bool',
    owner: 'str',
  },
  {
    name: 'isalpha',
    signature: 's.isalpha()',
    doc: '非空且全为字母才为 True。',
    returns: 'bool',
    owner: 'str',
  },
  {
    name: 'lower',
    signature: 's.lower()',
    doc: '返回小写副本（字符串不可变，原串不变），常与 upper() 配套做忽略大小写比较。',
    returns: 'str',
    owner: 'str',
  },
  {
    name: 'upper',
    signature: 's.upper()',
    doc: '返回大写副本。',
    returns: 'str',
    owner: 'str',
  },
  {
    name: 'split',
    signature: 's.split(sep)',
    doc: '不传参数按任意空白切分并丢掉空串；传 sep 则严格按分隔符切分且保留空段。',
    returns: 'list[str]',
    owner: 'str',
    example: '"a  b".split() -> ["a", "b"]',
  },
  {
    name: 'join',
    signature: "sep.join(parts)",
    doc: '用 sep 连接字符串序列，必须是 str（数字要先 map(str, ...)）；sep 是分隔符，空串表示直接相连。',
    returns: 'str',
    owner: 'str',
  },
  {
    name: 'strip',
    signature: 's.strip(chars)',
    doc: '去掉首尾空白；传 chars 时去掉的是「字符集合」中的任意字符，不是子串。',
    returns: 'str',
    owner: 'str',
  },
  {
    name: 'startswith',
    signature: 's.startswith(prefix)',
    doc: '前缀判断，可传 tuple 一次判断多个前缀；大小写敏感。',
    returns: 'bool',
    owner: 'str',
  },
  {
    name: 'find',
    signature: 's.find(sub)',
    doc: '返回子串首次出现的下标，找不到返回 -1（不抛异常，区别于 s.index）。',
    returns: 'int',
    owner: 'str',
  },
  {
    name: 'replace',
    signature: 's.replace(old, new)',
    doc: '返回替换后的新字符串（必须接收返回值），第三个参数限制替换次数。',
    returns: 'str',
    owner: 'str',
  },
  {
    name: 'zfill',
    signature: 's.zfill(width)',
    doc: '左侧补 0 到指定宽度，符号位处理正确（"-7".zfill(3) -> "-07"）。',
    returns: 'str',
    owner: 'str',
  },
  {
    name: 'count',
    signature: 's.count(sub)',
    doc: '统计不重叠出现次数，空串会返回 len+1；列表/元组的 count 用法相同。',
    returns: 'int',
    owner: 'str',
  },
  // ---- dict / list ----
  {
    name: 'get',
    signature: 'd.get(key, default)',
    doc: '取键，缺失返回 default（省略则为 None），不会抛 KeyError。',
    owner: 'dict',
  },
  {
    name: 'setdefault',
    signature: 'd.setdefault(key, default)',
    doc: '键不存在先插入 default 再返回它；键存在则原样返回旧值（不覆盖）。',
    owner: 'dict',
  },
  {
    name: 'items',
    signature: 'd.items()',
    doc: '遍历 (键, 值) 对；遍历中增删键会 RuntimeError，需要改就先 list(d.items())。',
    owner: 'dict',
  },
  {
    name: 'sort',
    signature: 'a.sort(key=..., reverse=...)',
    doc: '原地排序并返回 None（写成 a = a.sort() 就变成 None 了）；key 传函数，如 key=lambda x: x[1]。',
    returns: 'None',
    owner: 'list',
  },
  {
    name: 'sorted',
    signature: 'sorted(it, key=..., reverse=...)',
    doc: '返回新的排序列表，可用于任意可迭代对象（字典键、字符串、生成器）。',
    returns: 'list',
    owner: 'builtins',
  },
  {
    name: 'append',
    signature: 'a.append(x)',
    doc: '尾部追加**单个**元素，O(1)；append 一个列表会得到嵌套列表，要合并用 extend。',
    returns: 'None',
    owner: 'list',
  },
  {
    name: 'extend',
    signature: 'a.extend(it)',
    doc: '批量追加可迭代对象的所有元素，等价于 a += list(it)。',
    returns: 'None',
    owner: 'list',
  },
  {
    name: 'pop',
    signature: 'a.pop(i)',
    doc: '弹出指定下标（默认末尾）的元素；list.pop(0) 是 O(n)，当队列用请换 deque。',
    owner: 'list',
  },
  {
    name: 'enumerate',
    signature: 'enumerate(it, start=0)',
    doc: '同时产出 (下标, 元素)，比 range(len(x)) 更简洁。',
    returns: 'iterator',
    owner: 'builtins',
  },
  {
    name: 'zip',
    signature: 'zip(a, b)',
    doc: '按位置配对成元组，长度取最短的那个；长度不等又不想丢数据用 itertools.zip_longest。',
    returns: 'iterator',
    owner: 'builtins',
  },
  {
    name: 'range',
    signature: 'range(start, stop, step)',
    doc: '左闭右开，不含 stop；倒序用 range(n - 1, -1, -1)，步长不能为 0。',
    returns: 'range',
    owner: 'builtins',
  },
  {
    name: 'sum',
    signature: 'sum(it, start=0)',
    doc: '求和；True/False 可当 1/0 直接数个数；求前缀和请用 itertools.accumulate。',
    owner: 'builtins',
  },
  {
    name: 'abs',
    signature: 'abs(x)',
    doc: '取绝对值，支持 int/float；复数返回模长。',
    owner: 'builtins',
  },
  {
    name: 'max',
    signature: 'max(it, key=..., default=...)',
    doc: '可传 key 和 default；空序列且不给 default 会抛 ValueError。',
    owner: 'builtins',
  },
  {
    name: 'min',
    signature: 'min(it, key=..., default=...)',
    doc: '同 max；比较浮点/None 混合类型会报 TypeError。',
    owner: 'builtins',
  },
  {
    name: 'ord',
    signature: 'ord(ch)',
    doc: '单字符转码点：ord("a") == 97；必须正好一个字符。',
    returns: 'int',
    owner: 'builtins',
  },
  {
    name: 'chr',
    signature: 'chr(code)',
    doc: '码点转字符：chr(97) == "a"；与 ord 互逆，常用于字母表位移。',
    returns: 'str',
    owner: 'builtins',
  },
  {
    name: 'float',
    signature: "float('inf')",
    doc: "无穷大用 float('inf')（负无穷 -float('inf')）；也可直接用 math.inf。",
    returns: 'float',
    owner: 'builtins',
  },
  {
    name: 'math.inf',
    signature: 'math.inf',
    doc: '正无穷浮点常量，比 float("inf") 更省字符。',
    returns: 'float',
    owner: 'math',
  },
  {
    name: 'int',
    signature: 'int(x, base=10)',
    doc: '转整数（浮点直接截断，不是四舍五入）；int("101", 2) 可按进制解析字符串。',
    owner: 'builtins',
  },
  // ---- itertools / functools / math ----
  {
    name: 'accumulate',
    signature: 'itertools.accumulate(it)',
    doc: '前缀和迭代器，list(...) 之后得到累积和数组；传 func 可改成前缀积等。',
    returns: 'iterator',
    owner: 'itertools',
  },
  {
    name: 'permutations',
    signature: 'itertools.permutations(it, r)',
    doc: '全排列迭代器（元素元组，顺序敏感）；n 大时数量爆炸，别在数据规模大时用。',
    returns: 'iterator',
    owner: 'itertools',
  },
  {
    name: 'combinations',
    signature: 'itertools.combinations(it, r)',
    doc: '组合迭代器（顺序无关，元素升序下标选取）；要可重复选取用 combinations_with_replacement。',
    returns: 'iterator',
    owner: 'itertools',
  },
  {
    name: 'product',
    signature: 'itertools.product(a, b)',
    doc: '笛卡尔积，等价于双层 for；repeat=n 表示同一个序列连乘。',
    returns: 'iterator',
    owner: 'itertools',
  },
  {
    name: 'groupby',
    signature: 'itertools.groupby(it, key)',
    doc: '只合并**相邻**相同键的元素，要全局分组必须先 sorted。',
    returns: 'iterator',
    owner: 'itertools',
  },
  {
    name: 'lru_cache',
    signature: 'functools.lru_cache(maxsize=None)',
    doc: '记忆化装饰器，参数必须可哈希（列表不行，改传 tuple）；Python 3.9+ 可用 @cache。',
    owner: 'functools',
  },
  {
    name: 'reduce',
    signature: 'functools.reduce(func, it, init)',
    doc: '累积折叠成单值（区间合并、乘积常用）；Python 3 里它不是内置函数，要 import。',
    owner: 'functools',
  },
  {
    name: 'gcd',
    signature: 'math.gcd(a, b)',
    doc: '最大公约数，支持多参数；lcm 从 Python 3.9 起在 math.lcm。',
    returns: 'int',
    owner: 'math',
  },
  {
    name: 'isqrt',
    signature: 'math.isqrt(n)',
    doc: '整数平方根向下取整，避免 math.sqrt 的浮点误差。',
    returns: 'int',
    owner: 'math',
  },
];

const javascript: ApiSignature[] = [
  // ---- Array ----
  {
    name: 'sort',
    signature: 'arr.sort((a, b) => a - b)',
    doc: '默认按**字符串字典序**排序（[10, 9] 会排成 [9, 10]！），数字排序必须传比较函数；原地修改并返回同一数组。',
    returns: 'Array',
    owner: 'Array',
    example: '[10, 9].sort() -> [10, 9]  // 字符串比较的坑',
  },
  {
    name: 'slice',
    signature: 'arr.slice(start, end)',
    doc: '左闭右开截取，返回新数组不改原数组；负数下标从末尾算，省略 end 取到结尾。',
    returns: 'Array',
    owner: 'Array',
  },
  {
    name: 'splice',
    signature: 'arr.splice(start, deleteCount, ...items)',
    doc: '原地删除/插入，返回被删除元素组成的新数组（最容易误以为它返回原数组的地方）。',
    returns: 'Array',
    owner: 'Array',
  },
  {
    name: 'map',
    signature: 'arr.map((x) => x)',
    doc: '返回等长新数组；只是遍历不要结果用 forEach，过滤用 filter。',
    returns: 'Array',
    owner: 'Array',
  },
  {
    name: 'filter',
    signature: 'arr.filter((x) => x > 0)',
    doc: '返回满足条件的元素组成的新数组，回调返回真值才保留。',
    returns: 'Array',
    owner: 'Array',
  },
  {
    name: 'reduce',
    signature: 'arr.reduce((acc, x) => acc + x, 0)',
    doc: '折叠成单值；**初始值建议显式给**，否则空数组会抛 TypeError。',
    owner: 'Array',
  },
  {
    name: 'forEach',
    signature: 'arr.forEach((x, i) => {})',
    doc: '遍历但没有返回值，回调里 return 只是 continue；需要 break 就用 for / for...of。',
    returns: 'undefined',
    owner: 'Array',
  },
  {
    name: 'includes',
    signature: 'arr.includes(x)',
    doc: '是否包含某元素，O(n)；按 SameValueZero 比较，所以 NaN 也能找到。',
    returns: 'boolean',
    owner: 'Array',
  },
  {
    name: 'indexOf',
    signature: 'arr.indexOf(x)',
    doc: '返回第一个下标，找不到返回 -1（不是 undefined，也不是 null）。',
    returns: 'number',
    owner: 'Array',
  },
  {
    name: 'lastIndexOf',
    signature: 'arr.lastIndexOf(x)',
    doc: '从右往左找，返回下标，找不到返回 -1。',
    returns: 'number',
    owner: 'Array',
  },
  {
    name: 'concat',
    signature: 'arr.concat(other)',
    doc: '拼接返回新数组，只展开一层；深层扁平化用 flat(Infinity)。',
    returns: 'Array',
    owner: 'Array',
  },
  {
    name: 'flat',
    signature: 'arr.flat(depth)',
    doc: '按深度扁平化，默认 1 层；flat(Infinity) 完全展开。',
    returns: 'Array',
    owner: 'Array',
  },
  {
    name: 'fill',
    signature: 'new Array(n).fill(0)',
    doc: '生成定长初值数组；**fill 传对象时所有位置是同一个引用**，二维矩阵要 Array.from 或 map 生成。',
    returns: 'Array',
    owner: 'Array',
    example: 'new Array(3).fill([])  // 三行是同一个数组！',
  },
  {
    name: 'Array.from',
    signature: 'Array.from({ length: n }, (_, i) => i)',
    doc: '从类数组/可迭代/带 length 的对象生成新数组，常用来自造 0..n-1 或二维矩阵。',
    returns: 'Array',
    owner: 'Array',
  },
  {
    name: 'Array.isArray',
    signature: 'Array.isArray(x)',
    doc: '判断是否数组；typeof [] 返回 "object"，不能用来判数组。',
    returns: 'boolean',
    owner: 'Array',
  },
  {
    name: 'at',
    signature: 'arr.at(-1)',
    doc: '支持负下标取值（ES2022），-1 是最后一个；越界返回 undefined。',
    owner: 'Array',
  },
  {
    name: 'join',
    signature: "arr.join(',')",
    doc: '用分隔符拼成字符串；null/undefined 元素会变成空串。',
    returns: 'string',
    owner: 'Array',
  },
  {
    name: 'push',
    signature: 'arr.push(x)',
    doc: '尾部追加，返回新长度（不是数组本身，不能链式）；push(...arr) 可批量展开追加。',
    returns: 'number',
    owner: 'Array',
  },
  {
    name: 'pop',
    signature: 'arr.pop()',
    doc: '弹出并返回末尾元素，空数组返回 undefined。',
    owner: 'Array',
  },
  {
    name: 'shift',
    signature: 'arr.shift()',
    doc: '弹出队首元素并返回，O(n)（会移动所有元素）；大量出队用双指针下标代替。',
    owner: 'Array',
  },
  // ---- Math / Number ----
  {
    name: 'Math.floor',
    signature: 'Math.floor(x)',
    doc: '向下取整；负数要注意方向：Math.floor(-0.5) === -1。',
    returns: 'number',
    owner: 'Math',
  },
  {
    name: 'Math.ceil',
    signature: 'Math.ceil(x)',
    doc: '向上取整；Math.ceil(-0.5) === -0。',
    returns: 'number',
    owner: 'Math',
  },
  {
    name: 'Math.round',
    signature: 'Math.round(x)',
    doc: '四舍五入到最近整数，正好 .5 时向 +∞ 取整（Math.round(-0.5) 是 -0）。',
    returns: 'number',
    owner: 'Math',
  },
  {
    name: 'Math.trunc',
    signature: 'Math.trunc(x)',
    doc: '直接丢弃小数部分（朝 0 取整），和按位或 0 的效果相同。',
    returns: 'number',
    owner: 'Math',
  },
  {
    name: 'Math.max',
    signature: 'Math.max(...arr)',
    doc: '可变参数求最大；**大数组别用展开**（10 万+ 元素会 RangeError: too many arguments）。',
    returns: 'number',
    owner: 'Math',
  },
  {
    name: 'Math.min',
    signature: 'Math.min(...arr)',
    doc: '可变参数求最小；没有参数时返回 Infinity，注意空数组也别直接展开。',
    returns: 'number',
    owner: 'Math',
  },
  {
    name: 'Math.abs',
    signature: 'Math.abs(x)',
    doc: '取绝对值；Math.abs(-0) 是 0。',
    returns: 'number',
    owner: 'Math',
  },
  {
    name: 'Math.sqrt',
    signature: 'Math.sqrt(x)',
    doc: '浮点开方；判断完全平方数用 Number.isInteger(Math.sqrt(x)) 或整数二分。',
    returns: 'number',
    owner: 'Math',
  },
  {
    name: 'Math.pow',
    signature: 'Math.pow(base, exp)',
    doc: '幂运算，等价于 base ** exp；分数指数用于开方，大整数会丢精度。',
    returns: 'number',
    owner: 'Math',
  },
  {
    name: 'Infinity',
    signature: 'Infinity',
    doc: '正无穷（-Infinity 为负无穷），可直接参与比较；JSON 里会变成 null。',
    returns: 'number',
    owner: 'Number',
  },
  {
    name: 'Number.MAX_SAFE_INTEGER',
    signature: 'Number.MAX_SAFE_INTEGER',
    doc: '2^53 - 1；超过它（大数相加/乘积）整数会丢精度，需要 BigInt。',
    returns: 'number',
    owner: 'Number',
  },
  {
    name: 'BigInt',
    signature: 'BigInt(x)',
    doc: '任意精度整数；不能与 Number 混算（要显式转换），字面量写 10n，除法会截断。',
    returns: 'bigint',
    owner: 'Number',
  },
  {
    name: 'parseInt',
    signature: 'parseInt(s, 10)',
    doc: '按进制解析开头数字；解析失败返回 NaN（不抛错），末尾多余字符会被忽略。',
    returns: 'number',
    owner: 'Number',
  },
  {
    name: 'Number.isInteger',
    signature: 'Number.isInteger(x)',
    doc: '判断是否为整数（比 x % 1 === 0 更安全，NaN/Infinity 返回 false）。',
    returns: 'boolean',
    owner: 'Number',
  },
  // ---- Map / Set ----
  {
    name: 'new Map',
    signature: 'new Map()',
    doc: '键可以是任意类型且保持插入顺序；用 map.get/set/has 操作，不要用 obj[k]。',
    returns: 'Map',
    owner: 'Map',
  },
  {
    name: 'Map.get',
    signature: 'map.get(k)',
    doc: '取值，缺失返回 undefined（不像 Python 抛 KeyError）；判断存在请用 has。',
    owner: 'Map',
  },
  {
    name: 'Map.set',
    signature: 'map.set(k, v)',
    doc: '写入并返回 map 本身（可链式）；更新已有键不改变其插入顺序。',
    returns: 'Map',
    owner: 'Map',
  },
  {
    name: 'Map.has',
    signature: 'map.has(k)',
    doc: '判断键存在；NaN 作键也能正确命中，而 {} 作键每次都是新对象。',
    returns: 'boolean',
    owner: 'Map',
  },
  {
    name: 'new Set',
    signature: 'new Set(arr)',
    doc: '去重容器；size 是**属性**不是方法（set.size 而不是 set.size()）。',
    returns: 'Set',
    owner: 'Set',
  },
  {
    name: 'Set.add',
    signature: 'set.add(x)',
    doc: '加入元素并返回 set 本身；重复元素不会重复插入。',
    returns: 'Set',
    owner: 'Set',
  },
  {
    name: 'Set.has',
    signature: 'set.has(x)',
    doc: '判断元素存在，O(1)（数组 includes 是 O(n)）。',
    returns: 'boolean',
    owner: 'Set',
  },
  // ---- String ----
  {
    name: 'charCodeAt',
    signature: 's.charCodeAt(i)',
    doc: '返回 UTF-16 码元：s.charCodeAt(0) - 97 得到字母序号；越界返回 NaN。',
    returns: 'number',
    owner: 'String',
  },
  {
    name: 'String.fromCharCode',
    signature: 'String.fromCharCode(code)',
    doc: '码点转字符（可传多个参数一次转多个）：String.fromCharCode(97) === "a"。',
    returns: 'string',
    owner: 'String',
  },
  {
    name: 'padStart',
    signature: "s.padStart(len, '0')",
    doc: '左侧补字符到指定长度（补零/补空格），已够长则原样返回。',
    returns: 'string',
    owner: 'String',
  },
  {
    name: 'repeat',
    signature: 's.repeat(n)',
    doc: '重复 n 次，n 必须是非负整数（1.5 会被截断）。',
    returns: 'string',
    owner: 'String',
  },
  {
    name: 'split',
    signature: "s.split(sep)",
    doc: "按分隔符切分；s.split('') 按字符切，不传参数则按整个字符串；split 的结果是数组。",
    returns: 'Array',
    owner: 'String',
  },
  {
    name: 'toLowerCase',
    signature: 's.toLowerCase()',
    doc: '返回小写副本（字符串不可变），忽略大小写比较前先两边都转。',
    returns: 'string',
    owner: 'String',
  },
  {
    name: 'trim',
    signature: 's.trim()',
    doc: '去掉首尾空白（含换行/制表符），不处理中间空白。',
    returns: 'string',
    owner: 'String',
  },
  {
    name: 'substring',
    signature: 's.substring(start, end)',
    doc: '左闭右开截取；传反了会自动交换，负数按 0 处理——所以一般优先用 slice。',
    returns: 'string',
    owner: 'String',
  },
  {
    name: 'startsWith',
    signature: 's.startsWith(prefix)',
    doc: '前缀判断，可再传起始位置；大小写敏感。',
    returns: 'boolean',
    owner: 'String',
  },
];

const cpp: ApiSignature[] = [
  {
    name: 'sort',
    signature: 'sort(v.begin(), v.end())',
    doc: '区间排序（升序），左闭右开区间；配 greater<int>() 得到降序，自定义比较函数返回 bool。',
    owner: 'std',
    example: 'sort(v.begin(), v.end(), greater<int>());',
  },
  {
    name: 'stable_sort',
    signature: 'stable_sort(v.begin(), v.end())',
    doc: '稳定排序（相等元素保持原相对顺序），较慢；需要「按第一个字段排但保留原顺序」时用。',
    owner: 'std',
  },
  {
    name: 'lower_bound',
    signature: 'lower_bound(v.begin(), v.end(), x)',
    doc: '在**已排序**区间返回第一个 >= x 的迭代器；要下标就减去 begin()，不存在时等于 end()。',
    returns: 'iterator',
    owner: 'std',
  },
  {
    name: 'upper_bound',
    signature: 'upper_bound(v.begin(), v.end(), x)',
    doc: '返回第一个 > x 的迭代器；x 的出现次数 = upper_bound - lower_bound。',
    returns: 'iterator',
    owner: 'std',
  },
  {
    name: 'binary_search',
    signature: 'binary_search(v.begin(), v.end(), x)',
    doc: '只返回是否存在（bool），要位置必须用 lower_bound。',
    returns: 'bool',
    owner: 'std',
  },
  {
    name: 'accumulate',
    signature: 'accumulate(v.begin(), v.end(), 0)',
    doc: '求和，第三个参数是初值（也是类型）：求 long long 和要写 0LL，否则可能溢出。',
    owner: 'numeric',
  },
  {
    name: 'unordered_map',
    signature: 'unordered_map<int, int> m;',
    doc: '哈希表，平均 O(1)，但 m[k] 会**默认插入** k（用 m.count(k) / m.find(k) 判存在）。',
    owner: 'std',
  },
  {
    name: 'unordered_set',
    signature: 'unordered_set<int> s;',
    doc: '哈希集合，O(1) 查重；可设 s.reserve(n) 减少 rehash（会被卡常数时有用）。',
    owner: 'std',
  },
  {
    name: 'set',
    signature: 'set<int> s;',
    doc: '有序去重集合，O(log n)；可以用 s.lower_bound(x) 找 >= x 的元素，迭代器递增即有序遍历。',
    owner: 'std',
  },
  {
    name: 'multiset',
    signature: 'multiset<int> s;',
    doc: '有序可重复集合；s.erase(x) 会删掉**所有**等于 x 的元素，只删一个要 erase(s.find(x))。',
    owner: 'std',
  },
  {
    name: 'priority_queue',
    signature: 'priority_queue<int> pq;',
    doc: '默认大顶堆（top 是最大值），push/pop 都是 O(log n)。小顶堆要写全三个模板参数：priority_queue<int, vector<int>, greater<int>>；存 pair 时先比 first 再比 second。',
    owner: 'std',
  },
  {
    name: 'substr',
    signature: 's.substr(pos, len)',
    doc: '取子串：从 pos 开始最多 len 个字符；pos 越界会抛 out_of_range，别和 Java 的 substring 混。',
    returns: 'string',
    owner: 'string',
  },
  {
    name: 'find',
    signature: 's.find(t)',
    doc: '子串首次出现位置，找不到返回 string::npos（用 if (pos != string::npos) 判断，不要和 -1 比）。',
    returns: 'size_t',
    owner: 'string',
  },
  {
    name: 'stoi',
    signature: 'stoi(s)',
    doc: '字符串转 int（可带第二个参数取已解析长度）；非法输入抛异常，刷题里通常保证合法。',
    returns: 'int',
    owner: 'string',
  },
  {
    name: 'stoll',
    signature: 'stoll(s)',
    doc: '字符串转 long long；溢出会抛 out_of_range。',
    returns: 'long long',
    owner: 'string',
  },
  {
    name: 'to_string',
    signature: 'to_string(x)',
    doc: '数字转 string（浮点数默认 6 位小数，刷题多用整数）。',
    returns: 'string',
    owner: 'string',
  },
  {
    name: 'getline',
    signature: 'getline(cin, s)',
    doc: '读一整行（含空格、不含换行）；混用 cin >> 之前记得 cin.ignore()。',
    owner: 'iostream',
  },
  {
    name: 'resize',
    signature: 'v.resize(n, val)',
    doc: '调整大小：变大用 val 填充（默认 0），变小截断；二维数组常写 v.assign(n, vector<int>(m, 0))。',
    owner: 'vector',
  },
  {
    name: 'push_back',
    signature: 'v.push_back(x)',
    doc: '尾部追加（可能触发扩容）；大量插入前先 v.reserve(n) 更稳。',
    owner: 'vector',
  },
  {
    name: 'emplace_back',
    signature: 'v.emplace_back(args...)',
    doc: '原地构造元素，省一次拷贝；对 pair/结构体比 push_back 更高效。',
    owner: 'vector',
  },
  {
    name: 'pop_back',
    signature: 'v.pop_back()',
    doc: '删除末尾元素（不返回值，要值先 v.back()）；空容器上调用是未定义行为。',
    owner: 'vector',
  },
  {
    name: 'reserve',
    signature: 'v.reserve(n)',
    doc: '预分配容量（不改变 size），避免反复扩容；之后仍要 push_back 才会真正变长。',
    owner: 'vector',
  },
  {
    name: 'queue',
    signature: 'queue<int> q;',
    doc: 'FIFO 队列：q.push / q.front / q.pop（pop 不返回值）；BFS 必备。',
    owner: 'std',
  },
  {
    name: 'stack',
    signature: 'stack<int> st;',
    doc: 'LIFO 栈：st.push / st.top / st.pop（pop 不返回值）。',
    owner: 'std',
  },
  {
    name: 'deque',
    signature: 'deque<int> dq;',
    doc: '双端队列，两端 O(1) 插入删除（push_front/pop_front），支持下标访问。',
    owner: 'std',
  },
  {
    name: '__builtin_popcount',
    signature: '__builtin_popcount(x)',
    doc: '无符号 32 位整数的 1 的个数；64 位用 __builtin_popcountll，C++20 可用 popcount。',
    returns: 'int',
    owner: 'builtin',
  },
  {
    name: '__builtin_clz',
    signature: '__builtin_clz(x)',
    doc: '前导 0 的个数（x 必须非 0，否则未定义）；x 为 0 时可用 31 或 63 兜底。',
    returns: 'int',
    owner: 'builtin',
  },
  {
    name: 'INT_MAX',
    signature: 'INT_MAX',
    doc: 'int 最大值 2147483647；求距离/和时注意 INT_MAX + 1 会溢出，换成 LLONG_MAX。',
    returns: 'int',
    owner: 'limits',
  },
  {
    name: 'INT_MIN',
    signature: 'INT_MIN',
    doc: 'int 最小值 -2147483648；-INT_MIN 会溢出，取绝对值前先转 long long。',
    returns: 'int',
    owner: 'limits',
  },
  {
    name: 'LLONG_MAX',
    signature: 'LLONG_MAX',
    doc: 'long long 最大值；最短路/求和的大初值用它，或写 long long 的 0x3f3f3f3f3f3f3f3fLL。',
    returns: 'long long',
    owner: 'limits',
  },
  {
    name: 'LLONG_MIN',
    signature: 'LLONG_MIN',
    doc: 'long long 最小值；比较初始答案时常用 -LLONG_MAX 以免取负溢出。',
    returns: 'long long',
    owner: 'limits',
  },
  {
    name: 'reverse',
    signature: 'reverse(v.begin(), v.end())',
    doc: '原地反转区间；字符串反转也用它：reverse(s.begin(), s.end())。',
    owner: 'std',
  },
  {
    name: 'unique',
    signature: 'unique(v.begin(), v.end())',
    doc: '只去掉**相邻**重复，必须先 sort；返回新的逻辑末尾，配 v.erase(it, v.end()) 才真正删除。',
    returns: 'iterator',
    owner: 'std',
  },
  {
    name: 'max_element',
    signature: 'max_element(v.begin(), v.end())',
    doc: '返回最大元素迭代器（要值就解引用 *it，要下标就 -v.begin()）；空区间返回 end()。',
    returns: 'iterator',
    owner: 'std',
  },
  {
    name: 'min_element',
    signature: 'min_element(v.begin(), v.end())',
    doc: '返回最小元素迭代器；要下标同样减去 begin()。',
    returns: 'iterator',
    owner: 'std',
  },
  {
    name: 'make_pair',
    signature: 'make_pair(a, b)',
    doc: '构造 pair，比较时先比 first 再比 second（放堆里就是先按 first 排序的关键）。',
    returns: 'pair',
    owner: 'std',
  },
  {
    name: 'next_permutation',
    signature: 'next_permutation(v.begin(), v.end())',
    doc: '原地生成下一个字典序排列，返回是否还有下一个；要全部排列先从升序开始循环。',
    returns: 'bool',
    owner: 'std',
  },
  {
    name: 'memset',
    signature: 'memset(a, 0, sizeof(a))',
    doc: '按字节填充，只能安全填 0 或 -1（填 0x3f3f3f3f 也可以，因为每字节相同）；别用来填 1。',
    owner: 'cstring',
  },
  {
    name: 'abs',
    signature: 'abs(x)',
    doc: '整数绝对值；对 INT_MIN 取绝对值会溢出，需要 long long。',
    owner: 'cmath',
  },
  {
    name: 'sqrt',
    signature: 'sqrt(x)',
    doc: '浮点开方；判断完全平方数时用 long long r = sqrt(x); 再检查 r*r == x 修正精度。',
    returns: 'double',
    owner: 'cmath',
  },
  {
    name: 'std::gcd',
    signature: 'std::gcd(a, b)',
    doc: '最大公约数（C++17，#include <numeric>）；lcm 同头文件。',
    returns: 'int',
    owner: 'numeric',
  },
  {
    name: 'swap',
    signature: 'swap(a, b)',
    doc: '交换两个值；也可以 swap(v[i], v[j]) 交换容器元素。',
    owner: 'std',
  },
  {
    name: 'istringstream',
    signature: 'istringstream iss(s)',
    doc: '把字符串当输入流按空白切分：while (iss >> w) {...}，比手写 split 省事。',
    owner: 'sstream',
  },
  {
    name: 'clear',
    signature: 'v.clear()',
    doc: '清空元素（size 变 0，capacity 不变）；想把 vector 彻底释放用 v.clear(); v.shrink_to_fit()。',
    owner: 'vector',
  },
];

const java: ApiSignature[] = [
  {
    name: 'new ArrayList<>',
    signature: 'new ArrayList<>()',
    doc: '动态数组；get/set 是 O(1)，中间插入删除是 O(n)，判空用 isEmpty()。',
    returns: 'ArrayList',
    owner: 'ArrayList',
  },
  {
    name: 'list.add',
    signature: 'list.add(x)',
    doc: '尾部追加，返回 boolean（不是 list）；在指定下标插入用 list.add(i, x)。',
    returns: 'boolean',
    owner: 'ArrayList',
  },
  {
    name: 'list.get',
    signature: 'list.get(i)',
    doc: '按下标取值，越界抛 IndexOutOfBoundsException；List 接口里没有 [] 语法。',
    owner: 'ArrayList',
  },
  {
    name: 'list.set',
    signature: 'list.set(i, x)',
    doc: '覆盖指定下标并返回旧值；注意和 add(i, x)（插入）区分。',
    owner: 'ArrayList',
  },
  {
    name: 'list.size',
    signature: 'list.size()',
    doc: '元素个数，是**方法**（不是属性）；数组才用 arr.length。',
    returns: 'int',
    owner: 'ArrayList',
  },
  {
    name: 'list.remove',
    signature: 'list.remove(i)',
    doc: '按下标删除（list.remove(Integer.valueOf(x)) 才是按值删除，容易踩坑）。',
    owner: 'ArrayList',
  },
  {
    name: 'new HashMap<>',
    signature: 'new HashMap<>()',
    doc: '哈希表，O(1) 平均查找；遍历用 entrySet()，keySet() 只拿键。',
    returns: 'HashMap',
    owner: 'HashMap',
  },
  {
    name: 'getOrDefault',
    signature: 'map.getOrDefault(key, defaultValue)',
    doc: '取键，不存在时返回默认值（不会插入）；计数写法 map.put(k, map.getOrDefault(k, 0) + 1)。',
    owner: 'HashMap',
  },
  {
    name: 'putIfAbsent',
    signature: 'map.putIfAbsent(key, value)',
    doc: '键不存在才写入（已存在时返回旧值，不覆盖）。',
    owner: 'HashMap',
  },
  {
    name: 'computeIfAbsent',
    signature: 'map.computeIfAbsent(key, k -> new ArrayList<>())',
    doc: '键缺失时用 lambda 建值再返回，是「一键多值」最顺的写法。',
    owner: 'HashMap',
  },
  {
    name: 'containsKey',
    signature: 'map.containsKey(key)',
    doc: '判断键存在；注意 map.get(k) == null 不能区分「没有」和「值是 null」。',
    returns: 'boolean',
    owner: 'HashMap',
  },
  {
    name: 'entrySet',
    signature: 'map.entrySet()',
    doc: '返回键值对集合，遍历写法 for (var e : map.entrySet())，e.getKey()/e.getValue()。',
    owner: 'HashMap',
  },
  {
    name: 'new HashSet<>',
    signature: 'new HashSet<>()',
    doc: '去重集合，add 返回 boolean 表示是否真的新增（可用来判重）。',
    returns: 'HashSet',
    owner: 'HashSet',
  },
  {
    name: 'set.add',
    signature: 'set.add(x)',
    doc: '加入元素，返回是否新增；自定义对象要正确重写 hashCode/equals。',
    returns: 'boolean',
    owner: 'HashSet',
  },
  {
    name: 'sb.append',
    signature: 'sb.append(x)',
    doc: '字符串拼接请用它（String 用 + 在循环里是 O(n^2)）；最后 sb.toString()。',
    owner: 'StringBuilder',
  },
  {
    name: 'sb.reverse',
    signature: 'sb.reverse()',
    doc: '原地反转字符序列并返回自身（会修改 sb，不是返回新串）。',
    owner: 'StringBuilder',
  },
  {
    name: 'String.valueOf',
    signature: 'String.valueOf(x)',
    doc: '任意类型转字符串；char + char 是整数加法，想拼字符必须用 String.valueOf 或 sb。',
    returns: 'String',
    owner: 'String',
  },
  {
    name: 'toCharArray',
    signature: 's.toCharArray()',
    doc: '字符串转 char 数组（可原地修改）；char 数组转回来用 new String(chars)。',
    returns: 'char[]',
    owner: 'String',
  },
  {
    name: 'charAt',
    signature: 's.charAt(i)',
    doc: '取第 i 个字符，越界抛异常；两个字符相减得到码点差（"c" - "a" == 2）。',
    returns: 'char',
    owner: 'String',
  },
  {
    name: 's.substring',
    signature: 's.substring(begin, end)',
    doc: '左闭右开截取；Java 的 substring 与 C++ substr(起始, 长度) 参数含义不同。',
    returns: 'String',
    owner: 'String',
  },
  {
    name: 's.split',
    signature: 's.split(regex)',
    doc: '参数是**正则**（切 "." 要写 split("\\\\.")）；末尾空串会被丢弃。',
    returns: 'String[]',
    owner: 'String',
  },
  {
    name: 's.equals',
    signature: 's.equals(t)',
    doc: '比较内容（== 比的是引用！）；忽略大小写用 equalsIgnoreCase。',
    returns: 'boolean',
    owner: 'String',
  },
  {
    name: 'Arrays.sort',
    signature: 'Arrays.sort(arr)',
    doc: '原地升序排序（基本类型只能升序）；降序需对 Integer[] 传 Comparator.reverseOrder()。',
    owner: 'Arrays',
  },
  {
    name: 'Arrays.fill',
    signature: 'Arrays.fill(arr, val)',
    doc: '把数组填满同一个值；二维数组要逐行 fill（Arrays.fill 传 int[] 是同一引用）。',
    owner: 'Arrays',
  },
  {
    name: 'Arrays.copyOfRange',
    signature: 'Arrays.copyOfRange(arr, from, to)',
    doc: '左闭右开复制区间的数组，越界部分补 0；复制整个数组用 Arrays.copyOf。',
    returns: 'int[]',
    owner: 'Arrays',
  },
  {
    name: 'Arrays.asList',
    signature: 'Arrays.asList(1, 2, 3)',
    doc: '快速建 List，但返回的是**定长**视图，add/remove 会抛 UnsupportedOperationException。',
    returns: 'List',
    owner: 'Arrays',
  },
  {
    name: 'Arrays.toString',
    signature: 'Arrays.toString(arr)',
    doc: '把数组打印成 [1, 2, 3]；直接打印数组是地址，二维数组要用 deepToString。',
    returns: 'String',
    owner: 'Arrays',
  },
  {
    name: 'Collections.sort',
    signature: 'Collections.sort(list)',
    doc: '对 List 原地排序（基本类型数组用 Arrays.sort）；可传 Comparator。',
    owner: 'Collections',
  },
  {
    name: 'Collections.reverse',
    signature: 'Collections.reverse(list)',
    doc: '原地反转 List（不能用于数组）；也可对 List 用 Collections.swap 做双指针交换。',
    owner: 'Collections',
  },
  {
    name: 'new PriorityQueue<>',
    signature: 'new PriorityQueue<>()',
    doc: '默认**小顶堆**（和 C++ 相反！）；大顶堆要传 Comparator.reverseOrder()。',
    returns: 'PriorityQueue',
    owner: 'PriorityQueue',
  },
  {
    name: 'Comparator.comparingInt',
    signature: 'Comparator.comparingInt(x -> x[0])',
    doc: '自定义比较器：它把比较结果取反用 .reversed()；手写 (a, b) -> a[0] - b[0] 表示升序（小顶堆）。',
    owner: 'Comparator',
  },
  {
    name: 'pq.peek',
    signature: 'pq.peek()',
    doc: '查看堆顶但不弹出（空时返回 null）；poll() 才是弹出（空时返回 null），remove() 空时抛异常。',
    owner: 'PriorityQueue',
  },
  {
    name: 'Integer.MAX_VALUE',
    signature: 'Integer.MAX_VALUE',
    doc: 'int 最大值 2147483647；用它当距离初值时要防 +1 溢出，大数用 Long.MAX_VALUE。',
    returns: 'int',
    owner: 'Integer',
  },
  {
    name: 'Integer.MIN_VALUE',
    signature: 'Integer.MIN_VALUE',
    doc: 'int 最小值；Math.abs(Integer.MIN_VALUE) 仍是负数，是经典溢出坑。',
    returns: 'int',
    owner: 'Integer',
  },
  {
    name: 'Math.abs',
    signature: 'Math.abs(x)',
    doc: '取绝对值；Math.abs(long) 才有 long 版本，int 入参可能溢出。',
    owner: 'Math',
  },
  {
    name: 'Math.floorDiv',
    signature: 'Math.floorDiv(a, b)',
    doc: '向下取整的整除（-3/2 得 -1，而 floorDiv 得 -2）；取模配套 Math.floorMod。',
    returns: 'int',
    owner: 'Math',
  },
  {
    name: 'ArrayDeque',
    signature: 'ArrayDeque<Integer> dq = new ArrayDeque<>()',
    doc: '推荐的双端队列实现（比 LinkedList 快）：offerFirst/offerLast/pollFirst/pollLast。',
    returns: 'ArrayDeque',
    owner: 'ArrayDeque',
  },
  {
    name: 'new int[n]',
    signature: 'new int[n]',
    doc: '定长数组默认填 0；二维写 new int[n][m]（行不能省略）。',
    returns: 'int[]',
    owner: 'array',
  },
];

const golang: ApiSignature[] = [
  {
    name: 'sort.Ints',
    signature: 'sort.Ints(a)',
    doc: '原地升序排序 []int；降序用 sort.Sort(sort.Reverse(sort.IntSlice(a))) 或 slices.SortFunc。',
    owner: 'sort',
  },
  {
    name: 'sort.Strings',
    signature: 'sort.Strings(a)',
    doc: '原地升序排序 []string（按字节字典序）。',
    owner: 'sort',
  },
  {
    name: 'sort.Float64s',
    signature: 'sort.Float64s(a)',
    doc: '原地升序排序 []float64；NaN 会排在最前。',
    owner: 'sort',
  },
  {
    name: 'sort.Slice',
    signature: 'sort.Slice(a, func(i, j int) bool { ... })',
    doc: '用 less 函数排序任意切片（返回 true 表示 a[i] 应排在 a[j] 前面）；不保证稳定。',
    owner: 'sort',
    example: 'sort.Slice(a, func(i, j int) bool { return a[i] < a[j] })',
  },
  {
    name: 'sort.SliceStable',
    signature: 'sort.SliceStable(a, func(i, j int) bool { ... })',
    doc: '稳定版 sort.Slice：相等元素保持原顺序（多关键字排序的第二层很有用）。',
    owner: 'sort',
  },
  {
    name: 'sort.Search',
    signature: 'sort.Search(n, func(i int) bool { ... })',
    doc: '在 [0, n) 上二分找**第一个**使函数为 true 的下标；找不到返回 n，需要自己判断。',
    returns: 'int',
    owner: 'sort',
  },
  {
    name: 'sort.SearchInts',
    signature: 'sort.SearchInts(a, x)',
    doc: '在升序 []int 中返回第一个 >= x 的下标（等价 lower_bound），返回值可能等于 len(a)。',
    returns: 'int',
    owner: 'sort',
  },
  {
    name: 'slices.Sort',
    signature: 'slices.Sort(a)',
    doc: 'Go 1.21+ 的泛型排序（比 sort.Ints 更通用），降序用 slices.SortFunc(a, cmp.Compare 反向)。',
    owner: 'slices',
  },
  {
    name: 'slices.BinarySearch',
    signature: 'slices.BinarySearch(a, x)',
    doc: '泛型二分：返回 (下标, 是否存在)，找不到时下标是插入点。',
    owner: 'slices',
  },
  {
    name: 'strings.Split',
    signature: 'strings.Split(s, sep)',
    doc: '按分隔符切分，结果含空串；按空白切分用 strings.Fields（会丢掉空串）。',
    returns: '[]string',
    owner: 'strings',
  },
  {
    name: 'strings.Fields',
    signature: 'strings.Fields(s)',
    doc: '按任意空白切分并丢弃空串，处理多空格输入最省事。',
    returns: '[]string',
    owner: 'strings',
  },
  {
    name: 'strings.Join',
    signature: 'strings.Join(parts, sep)',
    doc: '用 sep 连接字符串切片；切片的元素必须是 string（数字要先 strconv.Itoa）。',
    returns: 'string',
    owner: 'strings',
  },
  {
    name: 'strings.Builder',
    signature: 'var sb strings.Builder',
    doc: '高效拼字符串：sb.WriteString(x)，最后 sb.String()；比循环里 += 快得多。',
    owner: 'strings',
  },
  {
    name: 'strings.Repeat',
    signature: 'strings.Repeat(s, n)',
    doc: '重复 n 次；n 为负会 panic。',
    returns: 'string',
    owner: 'strings',
  },
  {
    name: 'strings.Contains',
    signature: 'strings.Contains(s, substr)',
    doc: '是否包含子串（单字符可用 strings.IndexByte 更快）。',
    returns: 'bool',
    owner: 'strings',
  },
  {
    name: 'strings.Index',
    signature: 'strings.Index(s, substr)',
    doc: '子串首次出现位置，找不到返回 -1（Go 的惯例就是 -1，不是 error）。',
    returns: 'int',
    owner: 'strings',
  },
  {
    name: 'strings.ToLower',
    signature: 'strings.ToLower(s)',
    doc: '返回小写副本（字符串不可变）；单个 byte 大小写转换用 s[i]+32 更快但只对 ASCII 安全。',
    returns: 'string',
    owner: 'strings',
  },
  {
    name: 'strings.TrimSpace',
    signature: 'strings.TrimSpace(s)',
    doc: '去掉首尾空白；按字符集裁剪用 strings.Trim(s, cutset)。',
    returns: 'string',
    owner: 'strings',
  },
  {
    name: 'strings.HasPrefix',
    signature: 'strings.HasPrefix(s, prefix)',
    doc: '前缀判断；后缀用 strings.HasSuffix。',
    returns: 'bool',
    owner: 'strings',
  },
  {
    name: 'strconv.Atoi',
    signature: 'strconv.Atoi(s)',
    doc: '字符串转 int，返回 (值, err)，err != nil 表示解析失败（不会像 C 那样静默返回 0）。',
    returns: 'int',
    owner: 'strconv',
  },
  {
    name: 'strconv.Itoa',
    signature: 'strconv.Itoa(n)',
    doc: 'int 转字符串；其他类型用 fmt.Sprintf 或 strconv.FormatInt。',
    returns: 'string',
    owner: 'strconv',
  },
  {
    name: 'strconv.ParseInt',
    signature: 'strconv.ParseInt(s, 10, 64)',
    doc: '按进制解析到 int64（返回 int64，要不要转 int 看平台）；strconv.ParseFloat 用法类似。',
    returns: 'int64',
    owner: 'strconv',
  },
  {
    name: 'make',
    signature: 'make(map[int]int)',
    doc: 'map 必须用 make 初始化才能写入（var m map[int]int 是 nil，赋值会 panic）。',
    owner: 'builtin',
  },
  {
    name: 'm[k]',
    signature: 'v, ok := m[k]',
    doc: '取值同时判断存在：ok 为 false 表示键不在；只写 v := m[k] 会拿到零值无法区分。',
    owner: 'builtin',
  },
  {
    name: 'append',
    signature: 'a = append(a, x)',
    doc: '返回**新的**切片，必须赋回（可能扩容）；批量追加写 append(a, b...)。',
    owner: 'builtin',
  },
  {
    name: 'copy',
    signature: 'copy(dst, src)',
    doc: '复制两者中较短的 min(len) 个元素，返回个数；整片拷贝要 make 后 copy，不能直接赋值。',
    returns: 'int',
    owner: 'builtin',
  },
  {
    name: 'delete',
    signature: 'delete(m, key)',
    doc: '删除 map 键（键不存在也不报错）；删除切片元素要用 append(a[:i], a[i+1:]...)。',
    owner: 'builtin',
  },
  {
    name: 'math.MaxInt32',
    signature: 'math.MaxInt32',
    doc: 'int32 最大值 2147483647，常用作距离/答案初值；更通用的是 1<<62 附近的哨兵。',
    returns: 'int32',
    owner: 'math',
  },
  {
    name: 'math.MinInt32',
    signature: 'math.MinInt32',
    doc: 'int32 最小值；常写 ans := math.MinInt32 找最大值。',
    returns: 'int32',
    owner: 'math',
  },
  {
    name: 'math.MaxInt64',
    signature: 'math.MaxInt64',
    doc: 'int64 最大值；加之前记得防溢出（可以用 math.MaxInt64/2）。',
    returns: 'int64',
    owner: 'math',
  },
  {
    name: 'math.MaxFloat64',
    signature: 'math.MaxFloat64',
    doc: 'float64 最大值；表示「无穷大」也可用 math.Inf(1)。',
    returns: 'float64',
    owner: 'math',
  },
  {
    name: 'int(^uint(0) >> 1)',
    signature: 'int(^uint(0) >> 1)',
    doc: '本机 int 的最大值（Go 没有 int 的 MAX 常量），常写成 const maxInt = int(^uint(0) >> 1)。',
    returns: 'int',
    owner: 'builtin',
  },
  {
    name: 'fmt.Sprintf',
    signature: 'fmt.Sprintf("%v", x)',
    doc: '按格式生成字符串（%d/%s/%v）；拼切片用 %v 打印 [1 2 3]（注意空格分隔）。',
    returns: 'string',
    owner: 'fmt',
  },
  {
    name: 'rune',
    signature: "rune('a')",
    doc: 'rune 是 int32（Unicode 码点），byte 是 uint8；遍历字符串取字符要 for _, r := range s。',
    returns: 'rune',
    owner: 'builtin',
  },
  {
    name: 'math.Abs',
    signature: 'math.Abs(x)',
    doc: 'float64 取绝对值；int 要自己写（math.Abs 只接受 float64），或用 if x < 0 { x = -x }。',
    returns: 'float64',
    owner: 'math',
  },
  {
    name: 'sort.Sort',
    signature: 'sort.Sort(sort.Reverse(sort.IntSlice(a)))',
    doc: '降序排序 []int 的经典写法（sort.Ints 只会升序）。',
    owner: 'sort',
  },
];

const rust: ApiSignature[] = [
  {
    name: 'push',
    signature: 'v.push(x)',
    doc: 'Vec 尾部追加（会移动所有权）；长度用 v.len()，判空用 v.is_empty()。',
    owner: 'Vec',
  },
  {
    name: 'pop',
    signature: 'v.pop()',
    doc: '弹出末尾元素，返回 Option<T>（空时 None），需要 .unwrap() 或 if let。',
    returns: 'Option<T>',
    owner: 'Vec',
  },
  {
    name: 'last',
    signature: 'v.last()',
    doc: '取最后一个元素的引用，返回 Option<&T>；first() 同理。',
    returns: 'Option<&T>',
    owner: 'Vec',
  },
  {
    name: 'get',
    signature: 'v.get(i)',
    doc: '安全下标访问，返回 Option<&T>；v[i] 越界会 panic。',
    returns: 'Option<&T>',
    owner: 'Vec',
  },
  {
    name: 'iter',
    signature: 'v.iter()',
    doc: '借用地遍历：元素是 &T；需要所有权用 into_iter()，需要可变用 iter_mut()。',
    owner: 'Vec',
  },
  {
    name: 'into_iter',
    signature: 'v.into_iter()',
    doc: '消费式遍历（元素是 T，Vec 会被 move）；用 &v 写 for x in &v 更省事。',
    owner: 'Vec',
  },
  {
    name: 'collect',
    signature: 'iter.collect::<Vec<_>>()',
    doc: '把迭代器收成集合，类型常省略为 collect::<Vec<i32>>() 或靠左侧标注；String 则 collect::<String>()。',
    owner: 'Iterator',
  },
  {
    name: 'len',
    signature: 'v.len()',
    doc: '元素个数，返回 usize；下标运算全程用 usize，i32 要 as usize 转换。',
    returns: 'usize',
    owner: 'Vec',
  },
  {
    name: 'sort',
    signature: 'v.sort()',
    doc: '稳定升序排序，要求元素实现 Ord；降序用 v.sort_by(|a, b| b.cmp(a))。',
    owner: 'Vec',
  },
  {
    name: 'sort_unstable',
    signature: 'v.sort_unstable()',
    doc: '不稳定排序，更快且不额外分配；刷题默认用它，需要保持相等元素顺序时才用 sort。',
    owner: 'Vec',
  },
  {
    name: 'sort_by',
    signature: 'v.sort_by(|a, b| a.cmp(b))',
    doc: '自定义比较器（返回 Ordering）；按第二个字段排 a.1.cmp(&b.1)，浮点用 partial_cmp().unwrap()。',
    owner: 'Vec',
  },
  {
    name: 'sort_by_key',
    signature: 'v.sort_by_key(|x| x.0)',
    doc: '按 key 排序（key 必须是可复制的有序值）；降序写 |x| std::cmp::Reverse(x.0)。',
    owner: 'Vec',
  },
  {
    name: 'dedup',
    signature: 'v.dedup()',
    doc: '去掉**相邻**重复（要先 sort）；vec 专属方法，迭代器上没有。',
    owner: 'Vec',
  },
  {
    name: 'extend',
    signature: 'v.extend(other)',
    doc: '把可迭代对象的元素全部追加进来，等价于 v.append(&mut other)（后者会清空 other）。',
    owner: 'Vec',
  },
  {
    name: 'retain',
    signature: 'v.retain(|x| *x > 0)',
    doc: '原地过滤保留满足条件的元素（参数是 &T）；比 filter().collect() 省一次分配。',
    owner: 'Vec',
  },
  {
    name: 'drain',
    signature: 'v.drain(..)',
    doc: '移除并产出一个区间内的元素迭代器（会收缩 Vec）；drain(..) 等价于清空。',
    owner: 'Vec',
  },
  {
    name: 'binary_search',
    signature: 'v.binary_search(&x)',
    doc: '在**已排序**切片上二分，返回 Result<usize, usize>：Ok 是下标，Err 是插入点。',
    returns: 'Result<usize, usize>',
    owner: 'slice',
  },
  {
    name: 'windows',
    signature: 'v.windows(k)',
    doc: '产出长度为 k 的连续子切片（借用），k 为 0 会 panic；定长滑窗用 chunks 则是不重叠的。',
    owner: 'slice',
  },
  {
    name: 'chunks',
    signature: 'v.chunks(k)',
    doc: '按 k 个一段**不重叠**切分（最后一段可能更短）；需要重叠滑窗用 windows。',
    owner: 'slice',
  },
  {
    name: 'contains',
    signature: 'v.contains(&x)',
    doc: '是否包含某元素（参数是引用 &T），O(n)；有序时用 binary_search 更快。',
    returns: 'bool',
    owner: 'slice',
  },
  {
    name: 'reverse',
    signature: 'v.reverse()',
    doc: '原地反转；翻转字符串写 s.chars().rev().collect::<String>()。',
    owner: 'slice',
  },
  {
    name: 'VecDeque',
    signature: 'VecDeque::new()',
    doc: '双端队列（use std::collections::VecDeque）：push_front/pop_back 都是 O(1)，比 Vec 当队列高效。',
    owner: 'VecDeque',
  },
  {
    name: 'BinaryHeap',
    signature: 'BinaryHeap::new()',
    doc: '默认**大顶堆**（和 Python/Java 相反！）；小顶堆存 std::cmp::Reverse(x) 或 -x。',
    owner: 'BinaryHeap',
  },
  {
    name: 'HashMap',
    signature: 'HashMap::new()',
    doc: '哈希表（use std::collections::HashMap）；频繁计数先 HashMap::with_capacity(n) 减少扩容。',
    owner: 'HashMap',
  },
  {
    name: 'entry',
    signature: 'map.entry(key)',
    doc: '返回 Entry，配合 or_insert/or_insert_with 一次哈希完成「读或初始化」。',
    returns: 'Entry',
    owner: 'HashMap',
  },
  {
    name: 'or_insert',
    signature: '.or_insert(default)',
    doc: '键不存在时插入 default 并返回 &mut V；计数经典写法 *map.entry(k).or_insert(0) += 1。',
    owner: 'Entry',
  },
  {
    name: 'or_insert_with',
    signature: '.or_insert_with(|| vec![])',
    doc: '只在需要时才调用闭包建值（贵一点的初始化用它，避免无谓构造）。',
    owner: 'Entry',
  },
  {
    name: 'values',
    signature: 'map.values()',
    doc: '遍历值；map.keys() 遍历键，直接 for (k, v) in &map 解构更方便。',
    owner: 'HashMap',
  },
  {
    name: 'chars',
    signature: 's.chars()',
    doc: '按 Unicode 字符（char）遍历，得到的是迭代器不是索引；按下标取字符要 s.chars().nth(i)。',
    owner: 'str',
  },
  {
    name: 'bytes',
    signature: 's.bytes()',
    doc: '按字节（u8）遍历，ASCII 场景比 chars 快；s.as_bytes() 可直接索引 s.as_bytes()[i]。',
    owner: 'str',
  },
  {
    name: 'char_indices',
    signature: 's.char_indices()',
    doc: '遍历 (字节下标, 字符)，需要下标时用它；注意下标是字节偏移不是字符序号。',
    owner: 'str',
  },
  {
    name: 'split_whitespace',
    signature: 's.split_whitespace()',
    doc: '按任意空白切分并丢弃空串，等价于 Python 的无参 split()；split 则保留空段。',
    owner: 'str',
  },
  {
    name: 'trim',
    signature: 's.trim()',
    doc: '去掉首尾空白，返回 &str 借用的切片。',
    returns: '&str',
    owner: 'str',
  },
  {
    name: 'to_lowercase',
    signature: 's.to_lowercase()',
    doc: '返回小写 String（不是原地修改，也不返回 &str）；ASCII 可用 to_ascii_lowercase。',
    returns: 'String',
    owner: 'str',
  },
  {
    name: 'repeat',
    signature: 's.repeat(n)',
    doc: '重复字符串 n 次返回新 String；Vec 重复用 v.repeat(n)。',
    returns: 'String',
    owner: 'str',
  },
  {
    name: 'parse',
    signature: 's.parse::<i32>()',
    doc: '字符串解析成数字，返回 Result（要用 .unwrap() 或 match）；"12".parse::<i32>().unwrap()。',
    returns: 'Result<T, _>',
    owner: 'str',
  },
  {
    name: 'to_string',
    signature: 'x.to_string()',
    doc: '转成 String（ToString trait）；格式化拼串用 format!("{}{}", a, b)。',
    returns: 'String',
    owner: 'str',
  },
  {
    name: 'i32::MAX',
    signature: 'i32::MAX',
    doc: 'i32 最大值（等价 std::i32::MAX 旧写法）；大数初值也可用 i64::MAX 或 i32::MAX / 2 防溢出。',
    returns: 'i32',
    owner: 'primitives',
  },
  {
    name: 'i32::MIN',
    signature: 'i32::MIN',
    doc: 'i32 最小值；i32::MIN.abs() 会 panic（溢出），要 i32::checked_abs()。',
    returns: 'i32',
    owner: 'primitives',
  },
  {
    name: 'i64::MAX',
    signature: 'i64::MAX',
    doc: 'i64 最大值；刷题里和/距离常用 i64 避免溢出，LeetCode 签名是 i32 时记得 as i64。',
    returns: 'i64',
    owner: 'primitives',
  },
  {
    name: 'u32::MAX',
    signature: 'u32::MAX',
    doc: 'u32 最大值 4294967295；无符号数相减下溢会 panic（debug 模式），用 saturating_sub。',
    returns: 'u32',
    owner: 'primitives',
  },
  {
    name: 'usize::MAX',
    signature: 'usize::MAX',
    doc: 'usize 最大值，可直接当 BFS 距离初值；usize 是索引类型（len() 的返回值类型）。',
    returns: 'usize',
    owner: 'primitives',
  },
  {
    name: 'abs',
    signature: 'a.abs()',
    doc: '数值绝对值的**方法**形式（不是自由函数）；(a - b).abs() 是最常见写法，注意 i32::MIN 会 panic。',
    owner: 'primitives',
  },
  {
    name: 'min',
    signature: 'a.min(b)',
    doc: '比较取小（方法形式）；切片整体最小要 iter().min().unwrap() 或 *v.iter().min().unwrap()。',
    owner: 'Ord',
  },
  {
    name: 'max',
    signature: 'a.max(b)',
    doc: '比较取大（方法形式）；累加最值时用 ans = ans.max(x) 比 if 判断短。',
    owner: 'Ord',
  },
  {
    name: 'unwrap_or',
    signature: '.unwrap_or(default)',
    doc: 'Option/Result 取默认值：None/Err 时返回 default，不 panic；unwrap_or_else 传闭包。',
    owner: 'Option',
  },
  {
    name: 'unwrap_or_default',
    signature: '.unwrap_or_default()',
    doc: '取不到时返回类型默认值（0、空 String、空 Vec）。',
    owner: 'Option',
  },
  {
    name: 'map',
    signature: '.map(|x| x)',
    doc: 'Option/Result 上的变换（只处理 Some/Ok）；Iterator 上是逐元素映射，两者别混。',
    owner: 'Option',
  },
  {
    name: 'filter',
    signature: '.filter(|x| *x > 0)',
    doc: 'Iterator 的过滤（闭包参数是 &T）返回迭代器；Option 上的 filter 判的是 Some 内部的值。',
    owner: 'Iterator',
  },
  {
    name: 'sum',
    signature: '.sum::<i32>()',
    doc: '迭代器求和，元素类型要能推断（可能需 turbofish 标注）；乘积用 .product()。',
    owner: 'Iterator',
  },
];

export const SIGNATURE_DB: Record<string, ApiSignature[]> = {
  python3,
  javascript,
  cpp,
  java,
  golang,
  rust,
};

/** LeetCode langSlug 别名 → SIGNATURE_DB 的 key（尽量按需归一，别复制数据）。 */
const DB_ALIAS: Record<string, string> = {
  python: 'python3',
  py: 'python3',
  python3_: 'python3',
  typescript: 'javascript',
  ts: 'javascript',
  js: 'javascript',
  cpp17: 'cpp',
  cpp20: 'cpp',
  'c++': 'cpp',
  go: 'golang',
  rs: 'rust',
};

/** 单行最多给几条提示（够用且不打扰） */
const MAX_HINTS = 5;

export function dbFor(langSlug: string): ApiSignature[] {
  const key = (langSlug || '').trim().toLowerCase();
  return SIGNATURE_DB[key] ?? SIGNATURE_DB[DB_ALIAS[key] ?? ''] ?? [];
}

/** 取 `name` 末段（`Math.floor` → `floor`、`new Map` → `Map`） */
function tailOf(name: string): string {
  const parts = name.split(/[.:>/()<>\[\]\s]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : name;
}

/**
 * 前缀查询：用于「用户正在输入一个 API 名字」时的候选列表。
 * 排序：完全相等 > 名字前缀 > 末段前缀 > 其它（同级保持库内顺序，保证高频项靠前）。
 */
export function lookupApi(langSlug: string, prefix: string, limit = 8): ApiSignature[] {
  const db = dbFor(langSlug);
  const p = (prefix || '').trim().toLowerCase();
  const scored: Array<{ entry: ApiSignature; score: number; index: number }> = [];
  db.forEach((entry, index) => {
    const name = entry.name.toLowerCase();
    let score = -1;
    if (!p) score = 2;
    else if (name === p) score = 0;
    else if (name.startsWith(p)) score = 1;
    else if (tailOf(name).startsWith(p)) score = 3;
    if (score >= 0) scored.push({ entry, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : scored.length;
  return scored.slice(0, max).map((s) => s.entry);
}

/** 光标前是否刚刚出现 `xxx.` / `xxx::` / `xxx->`，返回那个 xxx。 */
function receiverBefore(text: string): string | undefined {
  const m = /([A-Za-z_$][\w$]*)\s*(?:\.|::|->)\s*$/.exec(text);
  return m ? m[1] : undefined;
}

function receiverMatches(entry: ApiSignature, receiver: string): boolean {
  const r = receiver.toLowerCase();
  const owner = (entry.owner ?? '').toLowerCase();
  if (owner && (owner === r || tailOf(owner).toLowerCase() === r)) return true;
  const sig = entry.signature.toLowerCase();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 签名就以 `接收者.` 开头（如 `v.push(x)` 且用户刚敲 `v.`）→ 认定是同一个对象上的方法
  if (new RegExp(`^${escape(r)}(?:\\.|::|->)`).test(sig)) return true;
  // 出现在签名中间的接收者只认「像对象名」的（长度 >= 2）且要求词边界，避免 hashmap:: 命中 map
  if (r.length < 2) return false;
  return new RegExp(`(?:^|[^\\w$])${escape(r)}(?:\\.|::|->)`).test(sig);
}

/**
 * 行内提示：结合「光标前已写的文本」判断用户正在用哪个对象/模块，
 * 只给出与之相关的 API 签名。返回最多 5 条，绝不返回算法逻辑。
 */
export function hintsForLine(langSlug: string, lineText: string, wordPrefix: string): ApiSignature[] {
  const db = dbFor(langSlug);
  if (!db.length) return [];
  const line = lineText ?? '';
  const prefix = (wordPrefix ?? '').trim();
  const lowerPrefix = prefix.toLowerCase();
  const before = prefix && line.endsWith(wordPrefix) ? line.slice(0, line.length - wordPrefix.length) : line;
  const receiver = receiverBefore(before);
  const out: ApiSignature[] = [];
  const seen = new Set<string>();
  const add = (entry: ApiSignature) => {
    if (seen.has(entry.name) || out.length >= MAX_HINTS) return;
    seen.add(entry.name);
    out.push(entry);
  };
  const byPrefix = (entry: ApiSignature) => !lowerPrefix || entry.name.toLowerCase().startsWith(lowerPrefix);

  if (receiver) {
    for (const entry of db) if (byPrefix(entry) && receiverMatches(entry, receiver)) add(entry);
  }
  // 没有接收者（或者库里的签名没覆盖到）时，退回按名字前缀匹配；空前缀不猜，避免刷屏
  if (lowerPrefix && out.length < MAX_HINTS) {
    for (const entry of lookupApi(langSlug, lowerPrefix, MAX_HINTS * 3)) add(entry);
  }
  return out;
}

/**
 * 把签名转成「可插入文本」：`name` + 紧跟其后的参数部分。
 * 例：`bisect.bisect_left(a, x)` + name `bisect_left` → `bisect_left(a, x)`。
 * 没有参数部分（常量、属性）时只返回名字。
 */
export function insertTextFor(entry: ApiSignature): string {
  const sig = entry.signature.trim();
  const at = sig.toLowerCase().indexOf(entry.name.toLowerCase());
  if (at < 0) return entry.name;
  const rest = sig.slice(at + entry.name.length);
  const m = /^\s*(\([^()]*(?:\([^()]*\)[^()]*)*\))/.exec(rest);
  return m ? `${entry.name}${m[1]}` : entry.name;
}
