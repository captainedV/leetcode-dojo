/**
 * Java 本地测试脚手架。
 *
 * 做法：
 *  - 生成 `Main.java`（`public class Main`，内含 ListNode / TreeNode / Node 定义）；
 *  - LeetCode 的 Java 题面是 `class Solution { public int[] twoSum(int[] nums, int target) {} }`（无 package），
 *    所以 `Main` 用**反射**（`Class.forName("Solution")`）调用：不需要在生成期知道参数类型，
 *    也不必让 Main.java 依赖用户类；`javac` 允许非 public 类名与文件名不同，但 public 类必须匹配，
 *    因此当用户文件名与类名不一致时把用户代码**复制**到 genDir 下的 `<ClassName>.java` 再编译
 *    （原文件不动）；
 *  - 编译：`javac -encoding UTF-8 -d <genDir> <用户文件> <genDir>/Main.java`；
 *  - 运行：`java -cp <genDir> Main`，每个用例单独 try/catch，输出 __LC_RESULT__ 协议行。
 */
import type {
  HarnessArtifact,
  HarnessFile,
  HarnessInput,
  HarnessSupport,
  LanguageHarness,
  TypeKind,
} from './types.js';
import { CASES_FILE, classifyType, serializeCases } from './types.js';

/** 生成的 Java 入口文件名（javac 要求 public 类名与文件名一致） */
const MAIN_FILE = 'Main.java';
/** 生成的 Java 主类名 */
const MAIN_CLASS = 'Main';

const JAVA_IMPORTS = `import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;`;

/**
 * LeetCode Java 环境自带的节点类（同一文件内 package-private 类）。
 * 用户代码里通常不再自己声明，直接使用这些类型。
 */
const JAVA_NODE_CLASSES = `/*
 * LeetCode 评测机提供的节点类（默认包内可见）。若你的题解里自己声明了同名类，
 * 请删掉本地那份，否则同一个 package 下会出现重复类定义。
 */
class ListNode {
    int val;
    ListNode next;

    ListNode() {}

    ListNode(int val) {
        this.val = val;
    }

    ListNode(int val, ListNode next) {
        this.val = val;
        this.next = next;
    }
}

class TreeNode {
    int val;
    TreeNode left;
    TreeNode right;

    TreeNode() {}

    TreeNode(int val) {
        this.val = val;
    }

    TreeNode(int val, TreeNode left, TreeNode right) {
        this.val = val;
        this.left = left;
        this.right = right;
    }
}

/** N 叉树的 Node / 克隆图的 Node 都叫 Node，这里合成为一个类。 */
class Node {
    int val;
    List<Node> children;
    List<Node> neighbors;
    Node next;
    Node left;
    Node right;
    Node random;

    Node() {
        this.children = new ArrayList<Node>();
        this.neighbors = new ArrayList<Node>();
    }

    Node(int val) {
        this();
        this.val = val;
    }

    Node(int val, List<Node> children) {
        this(val);
        if (children != null) {
            this.children = children;
            this.neighbors = children;
        }
    }
}`;

/**
 * Main.java 主体。注意：本模板只允许出现下面这些 `${...}` 插值，
 * 其余地方不要出现模板字符串语法（生成物是纯 Java 源码）。
 */
function buildMainJava(opts: {
  className: string;
  methodName: string;
  argKinds: TypeKind[];
  returnKind: TypeKind;
}): string {
  const kindsLiteral = 'new String[] { ' + opts.argKinds.map((k) => JSON.stringify(k)).join(', ') + ' }';
  return String.raw`/* LeetCode 本地测试脚手架 —— Java 入口（自动生成，请勿手工修改）
 *
 * 编译：javac -encoding UTF-8 -d . <用户文件> Main.java
 * 运行：java -cp . Main
 */
${JAVA_IMPORTS}

${JAVA_NODE_CLASSES}

public class Main {
    static final String RESULT_PREFIX = "__LC_RESULT__ ";
    static final String ERROR_PREFIX = "__LC_ERROR__ ";
    static final String DONE_PREFIX = "__LC_DONE__ ";
    static final String CASES_FILE = ${JSON.stringify(CASES_FILE)};

    /** 生成时注入的本题信息 */
    static final String CLASS_NAME = ${JSON.stringify(opts.className)};
    static final String METHOD_NAME = ${JSON.stringify(opts.methodName)};
    static final String[] ARG_KINDS = ${kindsLiteral};
    static final String RETURN_KIND = ${JSON.stringify(opts.returnKind)};

    /** JSON 里解析失败时的哨兵值（区别于解析出来的 null） */
    static final Object FAILED = new Object();

    // ================= 入口 =================

    public static void main(String[] args) {
        int code;
        try {
            code = run();
        } catch (Throwable t) {
            printError("scaffold_broken", describe(t));
            code = 2;
        }
        System.out.flush();
        System.exit(code);
    }

    static int run() {
        Map<String, Object> payload;
        try {
            String text = readFile(resolveCasesFile());
            payload = asMap(Json.parse(text));
        } catch (Throwable t) {
            printError("cases_missing", "无法读取 " + CASES_FILE + "：" + describe(t));
            return 2;
        }
        List<Object> cases = asList(payload.get("cases"));

        Class<?> cls;
        try {
            cls = Class.forName(CLASS_NAME);
        } catch (Throwable t) {
            printError("entry_not_found", "找不到类 " + CLASS_NAME + "（请确认题解里的类名与 metaData 一致）：" + describe(t));
            return 3;
        }
        Method[] candidates = candidateMethods(cls, METHOD_NAME);
        if (candidates.length == 0) {
            printError("entry_not_found", "找不到方法 " + CLASS_NAME + "." + METHOD_NAME);
            return 3;
        }

        PrintStream originalOut = System.out;
        long started = System.nanoTime();

        for (int index = 0; index < cases.size(); index++) {
            Map<String, Object> item = asMap(cases.get(index));
            int caseIndex = toInt(item.get("i"), String.valueOf(index));
            String[] rawArgs = rawArgsOf(item);

            long t0 = System.nanoTime();
            String actual = "";
            String error = null;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            try {
                System.setOut(new PrintStream(buffer, true));
                Object[] outcome = invokeOnce(cls, candidates, rawArgs);
                Object returned = outcome[0];
                Object[] usedArgs = (Object[]) outcome[1];
                if ("void".equals(RETURN_KIND)) {
                    // 原地修改类题目：答案取第一个参数
                    actual = usedArgs.length > 0 ? serialize(usedArgs[0], argKind(0)) : "null";
                } else {
                    actual = serialize(returned, RETURN_KIND);
                }
            } catch (Throwable t) {
                error = describe(t);
            } finally {
                System.out.flush();
                System.setOut(originalOut);
            }
            long durationMs = (System.nanoTime() - t0) / 1000000L;
            String logs = new String(buffer.toByteArray(), StandardCharsets.UTF_8);

            StringBuilder line = new StringBuilder();
            line.append(RESULT_PREFIX);
            line.append("{\"i\":").append(caseIndex);
            line.append(",\"actual\":\"").append(escapeJson(actual)).append("\"");
            line.append(",\"error\":");
            if (error == null) {
                line.append("null");
            } else {
                line.append("\"").append(escapeJson(error)).append("\"");
            }
            line.append(",\"durationMs\":").append(durationMs);
            if (logs != null && logs.trim().length() > 0) {
                String trimmed = logs.length() > 4000 ? logs.substring(logs.length() - 4000) : logs;
                line.append(",\"logs\":\"").append(escapeJson(trimmed)).append("\"");
            }
            line.append("}");
            originalOut.println(line.toString());
        }

        long elapsedMs = (System.nanoTime() - started) / 1000000L;
        originalOut.println(DONE_PREFIX + "{\"elapsedMs\":" + elapsedMs + "}");
        return 0;
    }

    // ================= 调用用户代码 =================

    static String argKind(int index) {
        if (ARG_KINDS != null && index >= 0 && index < ARG_KINDS.length) return ARG_KINDS[index];
        return "json";
    }

    static Method[] candidateMethods(Class<?> cls, String name) {
        List<Method> found = new ArrayList<Method>();
        Method[] declared = cls.getDeclaredMethods();
        for (int i = 0; i < declared.length; i++) {
            if (declared[i].getName().equals(name)) found.add(declared[i]);
        }
        if (found.isEmpty()) {
            Method[] pub = cls.getMethods();
            for (int i = 0; i < pub.length; i++) {
                if (pub[i].getName().equals(name)) found.add(pub[i]);
            }
        }
        return found.toArray(new Method[found.size()]);
    }

    /**
     * 依次尝试同名的重载方法：把参数按该方法的形参类型做转换，转换/调用失败就换下一个。
     * 返回 { 返回值, 实际传入的参数数组 }。
     */
    static Object[] invokeOnce(Class<?> cls, Method[] candidates, String[] rawArgs) throws Throwable {
        Throwable lastError = null;
        for (int i = 0; i < candidates.length; i++) {
            Method method = candidates[i];
            if (method.getParameterCount() != rawArgs.length) continue;
            Object[] actualArgs;
            try {
                actualArgs = buildArgs(rawArgs, method.getParameterTypes());
            } catch (Throwable t) {
                lastError = t;
                continue;
            }
            try {
                Object target = null;
                if (!Modifier.isStatic(method.getModifiers())) target = instantiate(cls);
                method.setAccessible(true);
                Object returned = method.invoke(target, actualArgs);
                return new Object[] { returned, actualArgs };
            } catch (InvocationTargetException e) {
                throw e.getTargetException();
            } catch (IllegalArgumentException e) {
                lastError = e;
            }
        }
        if (lastError != null) throw lastError;
        throw new NoSuchMethodException("无法匹配 " + METHOD_NAME + " 的参数类型（" + rawArgs.length + " 个参数）");
    }

    static Object instantiate(Class<?> cls) throws Exception {
        java.lang.reflect.Constructor<?> ctor = cls.getDeclaredConstructor(new Class<?>[0]);
        ctor.setAccessible(true);
        return ctor.newInstance(new Object[0]);
    }

    static Object[] buildArgs(String[] rawArgs, Class<?>[] paramTypes) {
        Object[] out = new Object[rawArgs.length];
        for (int i = 0; i < rawArgs.length; i++) {
            Object canonical = parseArgRaw(rawArgs[i], argKind(i));
            Class<?> target = (paramTypes != null && i < paramTypes.length) ? paramTypes[i] : null;
            out[i] = coerce(canonical, target);
        }
        return out;
    }

    // ================= 参数解析（LeetCode 类型 → Java 值） =================

    static Object parseArgRaw(String raw, String kind) {
        Object json = parseJsonOrRaw(raw);
        boolean isJson = json != FAILED;
        Object value = isJson ? json : null;

        if ("int".equals(kind)) return Integer.valueOf(toInt(value, raw));
        if ("long".equals(kind)) return Long.valueOf(toLong(value, raw));
        if ("double".equals(kind)) return Double.valueOf(toDouble(value, raw));
        if ("bool".equals(kind)) return Boolean.valueOf(toBool(value, raw));
        if ("string".equals(kind)) return toText(value, raw);
        if ("char".equals(kind)) return toText(value, raw);
        if ("int[]".equals(kind)) return toIntArray(value);
        if ("long[]".equals(kind)) return toLongArray(value);
        if ("double[]".equals(kind)) return toDoubleArray(value);
        if ("bool[]".equals(kind)) return toBoolArray(value);
        if ("string[]".equals(kind)) return toStringArray(value);
        if ("char[]".equals(kind)) return toCharArray(value);
        if ("int[][]".equals(kind)) return toIntMatrix(value);
        if ("char[][]".equals(kind)) return toCharMatrix(value);
        if ("string[][]".equals(kind)) return toStringMatrix(value);
        if ("listnode".equals(kind)) return makeList(value);
        if ("listnode[]".equals(kind)) return makeListArray(value);
        if ("treenode".equals(kind)) return makeTree(value);
        if ("treenode[]".equals(kind)) return makeTreeArray(value);
        if ("node".equals(kind)) return makeNodeValue(value);
        if ("graph".equals(kind)) return makeGraph(value);
        return value;
    }

    static Object parseJsonOrRaw(String raw) {
        if (raw == null) return FAILED;
        String text = raw.trim();
        if (text.length() == 0) return FAILED;
        try {
            return Json.parse(text);
        } catch (RuntimeException e) {
            return FAILED;
        }
    }

    static List<Object> asList(Object value) {
        List<Object> out = new ArrayList<Object>();
        if (value instanceof List) {
            List<?> src = (List<?>) value;
            for (int i = 0; i < src.size(); i++) out.add(src.get(i));
        }
        return out;
    }

    static Map<String, Object> asMap(Object value) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        if (value instanceof Map) {
            Map<?, ?> src = (Map<?, ?>) value;
            for (Map.Entry<?, ?> entry : src.entrySet()) {
                out.put(String.valueOf(entry.getKey()), entry.getValue());
            }
        }
        return out;
    }

    static int toInt(Object json, String raw) {
        if (json instanceof Number) return ((Number) json).intValue();
        if (json instanceof Boolean) return ((Boolean) json).booleanValue() ? 1 : 0;
        String text = raw == null ? "" : raw.trim();
        try {
            return Integer.parseInt(text);
        } catch (NumberFormatException e) {
            // 继续尝试浮点写法
        }
        try {
            return (int) Double.parseDouble(text);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    static long toLong(Object json, String raw) {
        if (json instanceof Number) return ((Number) json).longValue();
        if (json instanceof Boolean) return ((Boolean) json).booleanValue() ? 1L : 0L;
        String text = raw == null ? "" : raw.trim();
        try {
            return Long.parseLong(text);
        } catch (NumberFormatException e) {
            // 继续尝试浮点写法
        }
        try {
            return (long) Double.parseDouble(text);
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    static double toDouble(Object json, String raw) {
        if (json instanceof Number) return ((Number) json).doubleValue();
        if (json instanceof Boolean) return ((Boolean) json).booleanValue() ? 1.0 : 0.0;
        String text = raw == null ? "" : raw.trim();
        try {
            return Double.parseDouble(text);
        } catch (NumberFormatException e) {
            return 0.0;
        }
    }

    static boolean toBool(Object json, String raw) {
        if (json instanceof Boolean) return ((Boolean) json).booleanValue();
        String text = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        return "true".equals(text) || "1".equals(text);
    }

    /** 字符串 / 字符参数：优先用 JSON 解析结果，否则退回原文（去掉包裹引号）。 */
    static String toText(Object json, String raw) {
        if (json instanceof String) return (String) json;
        if (json instanceof Character) return String.valueOf(((Character) json).charValue());
        if (json instanceof Number) return numberText((Number) json);
        if (json instanceof Boolean) return ((Boolean) json).booleanValue() ? "true" : "false";
        String text = raw == null ? "" : raw.trim();
        if (text.length() >= 2) {
            char first = text.charAt(0);
            char last = text.charAt(text.length() - 1);
            if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
                return text.substring(1, text.length() - 1);
            }
        }
        return text;
    }

    static int[] toIntArray(Object json) {
        List<Object> items = asList(json);
        int[] out = new int[items.size()];
        for (int i = 0; i < out.length; i++) {
            Object item = items.get(i);
            out[i] = toInt(item, item == null ? "" : String.valueOf(item));
        }
        return out;
    }

    static long[] toLongArray(Object json) {
        List<Object> items = asList(json);
        long[] out = new long[items.size()];
        for (int i = 0; i < out.length; i++) {
            Object item = items.get(i);
            out[i] = toLong(item, item == null ? "" : String.valueOf(item));
        }
        return out;
    }

    static double[] toDoubleArray(Object json) {
        List<Object> items = asList(json);
        double[] out = new double[items.size()];
        for (int i = 0; i < out.length; i++) {
            Object item = items.get(i);
            out[i] = toDouble(item, item == null ? "" : String.valueOf(item));
        }
        return out;
    }

    static boolean[] toBoolArray(Object json) {
        List<Object> items = asList(json);
        boolean[] out = new boolean[items.size()];
        for (int i = 0; i < out.length; i++) {
            Object item = items.get(i);
            out[i] = toBool(item, item == null ? "" : String.valueOf(item));
        }
        return out;
    }

    static String[] toStringArray(Object json) {
        List<Object> items = asList(json);
        String[] out = new String[items.size()];
        for (int i = 0; i < out.length; i++) {
            Object item = items.get(i);
            out[i] = item == null ? null : toText(item, String.valueOf(item));
        }
        return out;
    }

    static char[] toCharArray(Object json) {
        if (json instanceof String) return ((String) json).toCharArray();
        List<Object> items = asList(json);
        char[] out = new char[items.size()];
        for (int i = 0; i < out.length; i++) {
            Object item = items.get(i);
            String cell = item == null ? "" : toText(item, String.valueOf(item));
            out[i] = cell.length() > 0 ? cell.charAt(0) : ' ';
        }
        return out;
    }

    static int[][] toIntMatrix(Object json) {
        List<Object> rows = asList(json);
        int[][] out = new int[rows.size()][];
        for (int i = 0; i < out.length; i++) out[i] = toIntArray(rows.get(i));
        return out;
    }

    static char[][] toCharMatrix(Object json) {
        List<Object> rows = asList(json);
        char[][] out = new char[rows.size()][];
        for (int i = 0; i < out.length; i++) out[i] = toCharArray(rows.get(i));
        return out;
    }

    static String[][] toStringMatrix(Object json) {
        List<Object> rows = asList(json);
        String[][] out = new String[rows.size()][];
        for (int i = 0; i < out.length; i++) out[i] = toStringArray(rows.get(i));
        return out;
    }

    // ---- 节点构造 ----------------------------------------------------------

    static ListNode makeList(Object json) {
        if (!(json instanceof List)) return null;
        List<Object> items = asList(json);
        ListNode head = null;
        ListNode tail = null;
        for (int i = 0; i < items.size(); i++) {
            Object item = items.get(i);
            ListNode node = new ListNode(toInt(item, item == null ? "" : String.valueOf(item)));
            if (head == null) {
                head = node;
                tail = node;
            } else {
                tail.next = node;
                tail = node;
            }
        }
        return head;
    }

    static ListNode[] makeListArray(Object json) {
        List<Object> items = asList(json);
        ListNode[] out = new ListNode[items.size()];
        for (int i = 0; i < out.length; i++) out[i] = makeList(items.get(i));
        return out;
    }

    static TreeNode makeTree(Object json) {
        if (!(json instanceof List)) return null;
        List<Object> items = asList(json);
        if (items.isEmpty() || items.get(0) == null) return null;
        Object rootValue = items.get(0);
        TreeNode root = new TreeNode(toInt(rootValue, String.valueOf(rootValue)));
        List<TreeNode> queue = new ArrayList<TreeNode>();
        queue.add(root);
        int cursor = 0;
        int i = 1;
        while (cursor < queue.size() && i < items.size()) {
            TreeNode node = queue.get(cursor);
            cursor++;
            Object left = items.get(i);
            i++;
            if (left != null) {
                node.left = new TreeNode(toInt(left, String.valueOf(left)));
                queue.add(node.left);
            }
            if (i < items.size()) {
                Object right = items.get(i);
                i++;
                if (right != null) {
                    node.right = new TreeNode(toInt(right, String.valueOf(right)));
                    queue.add(node.right);
                }
            }
        }
        return root;
    }

    static TreeNode[] makeTreeArray(Object json) {
        List<Object> items = asList(json);
        TreeNode[] out = new TreeNode[items.size()];
        for (int i = 0; i < out.length; i++) out[i] = makeTree(items.get(i));
        return out;
    }

    /** Node 类型：数组的数组按邻接表（克隆图）处理，否则按 N 叉树层序处理。 */
    static Node makeNodeValue(Object json) {
        if (!(json instanceof List)) return null;
        List<Object> items = asList(json);
        if (items.isEmpty()) return null;
        if (items.get(0) instanceof List) return makeGraph(json);
        return makeChildrenTree(items);
    }

    static Node makeChildrenTree(List<Object> items) {
        if (items.isEmpty() || items.get(0) == null) return null;
        Object rootValue = items.get(0);
        Node root = new Node(toInt(rootValue, String.valueOf(rootValue)));
        List<Node> parents = new ArrayList<Node>();
        parents.add(root);
        int i = 1;
        while (!parents.isEmpty() && i < items.size()) {
            while (i < items.size() && items.get(i) == null) i++;
            if (i >= items.size()) break;
            Node parent = parents.remove(0);
            List<Node> kids = new ArrayList<Node>();
            while (i < items.size() && items.get(i) != null) {
                Object childValue = items.get(i);
                i++;
                Node child = new Node(toInt(childValue, String.valueOf(childValue)));
                kids.add(child);
                parents.add(child);
            }
            parent.children = kids;
            if (i < items.size() && items.get(i) == null) i++;
        }
        return root;
    }

    static Node makeGraph(Object json) {
        List<Object> adj = asList(json);
        if (adj.isEmpty()) return null;
        List<Node> nodes = new ArrayList<Node>();
        for (int i = 0; i < adj.size(); i++) nodes.add(new Node(i + 1));
        for (int i = 0; i < adj.size(); i++) {
            List<Object> raw = asList(adj.get(i));
            List<Node> neighbors = new ArrayList<Node>();
            for (int k = 0; k < raw.size(); k++) {
                Object rawIndex = raw.get(k);
                int index = toInt(rawIndex, String.valueOf(rawIndex)) - 1;
                if (index >= 0 && index < nodes.size()) neighbors.add(nodes.get(index));
            }
            nodes.get(i).neighbors = neighbors;
        }
        return nodes.get(0);
    }

    // ================= 结果序列化（LeetCode 风格字符串） =================

    static String serialize(Object value, String kind) {
        if (kind == null) return dumpTop(value);
        if ("int".equals(kind)) return numberText((Number) value);
        if ("long".equals(kind)) return numberText((Number) value);
        if ("double".equals(kind)) return numberText((Number) value);
        if ("bool".equals(kind)) return value instanceof Boolean ? (((Boolean) value).booleanValue() ? "true" : "false") : dumpTop(value);
        if ("string".equals(kind)) return dumpTop(value);
        if ("char".equals(kind)) {
            if (value instanceof Character) return String.valueOf(((Character) value).charValue());
            return dumpTop(value);
        }
        if ("int[]".equals(kind) || "long[]".equals(kind) || "double[]".equals(kind) || "bool[]".equals(kind)
                || "string[]".equals(kind) || "char[]".equals(kind) || "int[][]".equals(kind)
                || "char[][]".equals(kind) || "string[][]".equals(kind)) {
            return dumpJson(value);
        }
        if ("listnode".equals(kind)) return dumpList(castListNode(value));
        if ("listnode[]".equals(kind)) return dumpJson(value);
        if ("treenode".equals(kind)) return dumpTree(castTreeNode(value));
        if ("treenode[]".equals(kind)) return dumpJson(value);
        if ("node".equals(kind)) {
            if (value instanceof Node) return dumpNodeValue((Node) value);
            return dumpJson(value);
        }
        if ("graph".equals(kind)) return dumpGraph(castNode(value));
        return dumpTop(value);
    }

    static ListNode castListNode(Object value) {
        return value instanceof ListNode ? (ListNode) value : null;
    }

    static TreeNode castTreeNode(Object value) {
        return value instanceof TreeNode ? (TreeNode) value : null;
    }

    static Node castNode(Object value) {
        return value instanceof Node ? (Node) value : null;
    }

    /** 顶层字符串原样输出（LeetCode 习惯），其余走 JSON 风格。 */
    static String dumpTop(Object value) {
        if (value == null) return "null";
        if (value instanceof String) return (String) value;
        if (value instanceof Character) return String.valueOf(((Character) value).charValue());
        return dumpJson(value);
    }

    static String dumpJson(Object value) {
        if (value == null) return "null";
        if (value instanceof Boolean) return ((Boolean) value).booleanValue() ? "true" : "false";
        if (value instanceof Character) return quote(String.valueOf(((Character) value).charValue()));
        if (value instanceof Number) return numberText((Number) value);
        if (value instanceof String) return quote((String) value);
        if (value instanceof ListNode) return dumpList((ListNode) value);
        if (value instanceof TreeNode) return dumpTree((TreeNode) value);
        if (value instanceof Node) return dumpNodeValue((Node) value);
        if (value.getClass().isArray()) return dumpArray(value);
        if (value instanceof List) return dumpListOf((List<?>) value);
        if (value instanceof Map) return dumpMapOf(value);
        return quote(String.valueOf(value));
    }

    static String dumpArray(Object array) {
        int length = java.lang.reflect.Array.getLength(array);
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < length; i++) {
            if (i > 0) sb.append(',');
            sb.append(dumpJson(java.lang.reflect.Array.get(array, i)));
        }
        sb.append(']');
        return sb.toString();
    }

    static String dumpListOf(List<?> items) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(dumpJson(items.get(i)));
        }
        sb.append(']');
        return sb.toString();
    }

    static String dumpMapOf(Object value) {
        Map<?, ?> map = (Map<?, ?>) value;
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append(quote(String.valueOf(entry.getKey())));
            sb.append(':');
            sb.append(dumpJson(entry.getValue()));
        }
        sb.append('}');
        return sb.toString();
    }

    static String dumpList(ListNode head) {
        StringBuilder sb = new StringBuilder("[");
        ListNode node = head;
        int guard = 0;
        while (node != null && guard < 100000) {
            if (guard > 0) sb.append(',');
            sb.append(node.val);
            node = node.next;
            guard++;
        }
        sb.append(']');
        return sb.toString();
    }

    static String dumpTree(TreeNode root) {
        if (root == null) return "[]";
        List<Object> values = new ArrayList<Object>();
        List<TreeNode> queue = new ArrayList<TreeNode>();
        queue.add(root);
        int cursor = 0;
        while (cursor < queue.size()) {
            TreeNode node = queue.get(cursor);
            cursor++;
            if (node == null) {
                values.add(null);
                continue;
            }
            values.add(Integer.valueOf(node.val));
            queue.add(node.left);
            queue.add(node.right);
        }
        int end = values.size();
        while (end > 0 && values.get(end - 1) == null) end--;
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < end; i++) {
            if (i > 0) sb.append(',');
            Object value = values.get(i);
            sb.append(value == null ? "null" : String.valueOf(((Integer) value).intValue()));
        }
        sb.append(']');
        return sb.toString();
    }

    static String dumpNodeValue(Node root) {
        if (root == null) return "[]";
        boolean hasChildren = root.children != null && !root.children.isEmpty();
        boolean hasNeighbors = root.neighbors != null && !root.neighbors.isEmpty();
        if (!hasChildren && hasNeighbors) return dumpGraph(root);
        return dumpChildren(root);
    }

    static String dumpChildren(Node root) {
        if (root == null) return "[]";
        List<Object> values = new ArrayList<Object>();
        values.add(Integer.valueOf(root.val));
        values.add(null);
        List<Node> queue = new ArrayList<Node>();
        queue.add(root);
        int cursor = 0;
        while (cursor < queue.size()) {
            Node node = queue.get(cursor);
            cursor++;
            List<Node> kids = node.children == null ? new ArrayList<Node>() : node.children;
            for (int i = 0; i < kids.size(); i++) {
                Node child = kids.get(i);
                queue.add(child);
                values.add(child == null ? null : Integer.valueOf(child.val));
            }
            values.add(null);
        }
        int end = values.size();
        while (end > 0 && values.get(end - 1) == null) end--;
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < end; i++) {
            if (i > 0) sb.append(',');
            Object value = values.get(i);
            sb.append(value == null ? "null" : String.valueOf(((Integer) value).intValue()));
        }
        sb.append(']');
        return sb.toString();
    }

    static String dumpGraph(Node start) {
        if (start == null) return "[]";
        Map<Integer, Node> seen = new HashMap<Integer, Node>();
        List<Node> order = new ArrayList<Node>();
        List<Node> stack = new ArrayList<Node>();
        stack.add(start);
        while (!stack.isEmpty()) {
            Node node = stack.remove(stack.size() - 1);
            if (node == null) continue;
            Integer key = Integer.valueOf(node.val);
            if (seen.containsKey(key)) continue;
            seen.put(key, node);
            order.add(node);
            List<Node> neighbors = node.neighbors == null ? new ArrayList<Node>() : node.neighbors;
            for (int i = 0; i < neighbors.size(); i++) {
                Node nb = neighbors.get(i);
                if (nb != null && !seen.containsKey(Integer.valueOf(nb.val))) stack.add(nb);
            }
        }
        // 按 val 升序（节点编号就是 val - 1），插入排序避免额外依赖
        for (int i = 1; i < order.size(); i++) {
            Node current = order.get(i);
            int j = i - 1;
            while (j >= 0 && order.get(j).val > current.val) {
                order.set(j + 1, order.get(j));
                j--;
            }
            order.set(j + 1, current);
        }
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < order.size(); i++) {
            if (i > 0) sb.append(',');
            List<Node> neighbors = order.get(i).neighbors == null ? new ArrayList<Node>() : order.get(i).neighbors;
            sb.append('[');
            for (int k = 0; k < neighbors.size(); k++) {
                if (k > 0) sb.append(',');
                Node nb = neighbors.get(k);
                sb.append(nb == null ? "null" : String.valueOf(nb.val));
            }
            sb.append(']');
        }
        sb.append(']');
        return sb.toString();
    }

    static String numberText(Number number) {
        if (number == null) return "null";
        if (number instanceof Double || number instanceof Float) {
            double d = number.doubleValue();
            if (Double.isNaN(d)) return "NaN";
            if (Double.isInfinite(d)) return d > 0 ? "Infinity" : "-Infinity";
            if (Math.abs(d) >= 1e12) return Double.toString(d);
            if (d == Math.floor(d)) return String.format(Locale.ROOT, "%.5f", Double.valueOf(d));
            return Double.toString(d);
        }
        return String.valueOf(number.longValue());
    }

    // ================= 参数类型转换 =================

    static Object coerce(Object value, Class<?> target) {
        if (target == null || target == Object.class) return value;
        if (target == int.class || target == Integer.class) return Integer.valueOf(toInt(value, ""));
        if (target == long.class || target == Long.class) return Long.valueOf(toLong(value, ""));
        if (target == double.class || target == Double.class) return Double.valueOf(toDouble(value, ""));
        if (target == float.class || target == Float.class) return Float.valueOf((float) toDouble(value, ""));
        if (target == boolean.class || target == Boolean.class) return Boolean.valueOf(toBool(value, ""));
        if (target == char.class || target == Character.class) {
            String text = toText(value, "");
            return Character.valueOf(text.length() > 0 ? text.charAt(0) : ' ');
        }
        if (target == String.class) return toText(value, "");
        if (value == null) return null;
        if (target.isArray()) return coerceArray(value, target);
        if (target.isInstance(value)) return value;
        if (List.class.isAssignableFrom(target)) {
            List<Object> items = value instanceof List ? asList(value) : new ArrayList<Object>();
            if (!(value instanceof List) && value.getClass().isArray()) {
                int length = java.lang.reflect.Array.getLength(value);
                for (int i = 0; i < length; i++) items.add(java.lang.reflect.Array.get(value, i));
            }
            return items;
        }
        return value;
    }

    static Object coerceArray(Object value, Class<?> target) {
        Class<?> component = target.getComponentType();
        List<Object> source;
        if (value.getClass().isArray()) {
            int length = java.lang.reflect.Array.getLength(value);
            source = new ArrayList<Object>();
            for (int i = 0; i < length; i++) source.add(java.lang.reflect.Array.get(value, i));
        } else {
            source = asList(value);
        }
        Object out = java.lang.reflect.Array.newInstance(component, source.size());
        for (int i = 0; i < source.size(); i++) {
            java.lang.reflect.Array.set(out, i, coerce(source.get(i), component));
        }
        return out;
    }

    // ================= 杂项 =================

    static String rawArgsOf(Map<String, Object> item) {
        List<Object> raw = asList(item.get("args"));
        String[] out = new String[raw.size()];
        for (int i = 0; i < out.length; i++) {
            Object value = raw.get(i);
            out[i] = value == null ? "" : String.valueOf(value);
        }
        return out;
    }

    static String resolveCasesFile() {
        java.nio.file.Path direct = java.nio.file.Paths.get(CASES_FILE);
        if (java.nio.file.Files.exists(direct)) return direct.toString();
        try {
            java.net.URL url = Main.class.getProtectionDomain().getCodeSource().getLocation();
            java.nio.file.Path dir = java.nio.file.Paths.get(url.toURI());
            java.nio.file.Path candidate = dir.resolve(CASES_FILE);
            if (java.nio.file.Files.exists(candidate)) return candidate.toString();
        } catch (Throwable ignored) {
            // 退回到相对路径
        }
        return direct.toString();
    }

    static String readFile(String path) throws Exception {
        byte[] bytes = java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(path));
        return new String(bytes, StandardCharsets.UTF_8);
    }

    static void printError(String fatal, String message) {
        StringBuilder sb = new StringBuilder();
        sb.append(ERROR_PREFIX);
        sb.append("{\"fatal\":\"").append(escapeJson(fatal)).append("\"");
        if (message != null && message.length() > 0) {
            String trimmed = message.length() > 1500 ? message.substring(0, 1500) : message;
            sb.append(",\"message\":\"").append(escapeJson(trimmed)).append("\"");
        }
        sb.append("}");
        System.out.println(sb.toString());
    }

    static String describe(Throwable t) {
        if (t == null) return "unknown error";
        StringBuilder sb = new StringBuilder();
        sb.append(t.getClass().getName());
        if (t.getMessage() != null) sb.append(": ").append(t.getMessage());
        StackTraceElement[] frames = t.getStackTrace();
        int limit = frames == null ? 0 : Math.min(frames.length, 6);
        for (int i = 0; i < limit; i++) {
            sb.append("\n    at ").append(frames[i].toString());
        }
        return sb.toString();
    }

    static String quote(String text) {
        return "\"" + escapeJson(text) + "\"";
    }

    static String escapeJson(String text) {
        if (text == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '"') {
                sb.append("\\\"");
            } else if (c == '\\') {
                sb.append("\\\\");
            } else if (c == '\n') {
                sb.append("\\n");
            } else if (c == '\r') {
                sb.append("\\r");
            } else if (c == '\t') {
                sb.append("\\t");
            } else if (c == '\b') {
                sb.append("\\b");
            } else if (c == '\f') {
                sb.append("\\f");
            } else if (c < 0x20) {
                sb.append(String.format(Locale.ROOT, "\\u%04x", Integer.valueOf(c)));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    // ================= 极简 JSON 解析（只处理 _lc_cases.json 这类数据） =================

    static final class Json {
        private final String src;
        private int pos;

        private Json(String src) {
            this.src = src;
            this.pos = 0;
        }

        static Object parse(String text) {
            Json parser = new Json(text);
            parser.skipWhitespace();
            Object value = parser.parseValue();
            parser.skipWhitespace();
            return value;
        }

        private void skipWhitespace() {
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    pos++;
                } else {
                    break;
                }
            }
        }

        private Object parseValue() {
            if (pos >= src.length()) throw new IllegalArgumentException("JSON 意外结束");
            char c = src.charAt(pos);
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == '"') return parseString();
            if (c == 't') {
                expectWord("true");
                return Boolean.TRUE;
            }
            if (c == 'f') {
                expectWord("false");
                return Boolean.FALSE;
            }
            if (c == 'n') {
                expectWord("null");
                return null;
            }
            return parseNumber();
        }

        private void expectWord(String word) {
            if (src.length() - pos < word.length() || !src.startsWith(word, pos)) {
                throw new IllegalArgumentException("JSON 期望 " + word);
            }
            pos += word.length();
        }

        private Map<String, Object> parseObject() {
            Map<String, Object> map = new LinkedHashMap<String, Object>();
            pos++;
            skipWhitespace();
            if (pos < src.length() && src.charAt(pos) == '}') {
                pos++;
                return map;
            }
            while (true) {
                skipWhitespace();
                String key = parseString();
                skipWhitespace();
                if (pos >= src.length() || src.charAt(pos) != ':') {
                    throw new IllegalArgumentException("JSON 期望 ':'");
                }
                pos++;
                skipWhitespace();
                map.put(key, parseValue());
                skipWhitespace();
                if (pos >= src.length()) throw new IllegalArgumentException("JSON 对象未结束");
                char c = src.charAt(pos);
                pos++;
                if (c == '}') return map;
                if (c != ',') throw new IllegalArgumentException("JSON 期望 ',' 或 '}'");
            }
        }

        private List<Object> parseArray() {
            List<Object> list = new ArrayList<Object>();
            pos++;
            skipWhitespace();
            if (pos < src.length() && src.charAt(pos) == ']') {
                pos++;
                return list;
            }
            while (true) {
                skipWhitespace();
                list.add(parseValue());
                skipWhitespace();
                if (pos >= src.length()) throw new IllegalArgumentException("JSON 数组未结束");
                char c = src.charAt(pos);
                pos++;
                if (c == ']') return list;
                if (c != ',') throw new IllegalArgumentException("JSON 期望 ',' 或 ']'");
            }
        }

        private String parseString() {
            if (pos >= src.length() || src.charAt(pos) != '"') {
                throw new IllegalArgumentException("JSON 期望字符串");
            }
            pos++;
            StringBuilder sb = new StringBuilder();
            while (pos < src.length()) {
                char c = src.charAt(pos);
                pos++;
                if (c == '"') return sb.toString();
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                if (pos >= src.length()) break;
                char esc = src.charAt(pos);
                pos++;
                if (esc == '"') {
                    sb.append('"');
                } else if (esc == '\\') {
                    sb.append('\\');
                } else if (esc == '/') {
                    sb.append('/');
                } else if (esc == 'b') {
                    sb.append('\b');
                } else if (esc == 'f') {
                    sb.append('\f');
                } else if (esc == 'n') {
                    sb.append('\n');
                } else if (esc == 'r') {
                    sb.append('\r');
                } else if (esc == 't') {
                    sb.append('\t');
                } else if (esc == 'u') {
                    if (pos + 4 > src.length()) throw new IllegalArgumentException("JSON \\u 转义不完整");
                    String hex = src.substring(pos, pos + 4);
                    pos += 4;
                    sb.append((char) Integer.parseInt(hex, 16));
                } else {
                    throw new IllegalArgumentException("JSON 非法转义 \\" + esc);
                }
            }
            throw new IllegalArgumentException("JSON 字符串未结束");
        }

        private Number parseNumber() {
            int start = pos;
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') {
                    pos++;
                } else {
                    break;
                }
            }
            if (start == pos) throw new IllegalArgumentException("JSON 无法识别的值");
            String text = src.substring(start, pos);
            try {
                return Double.valueOf(text);
            } catch (NumberFormatException e) {
                throw new IllegalArgumentException("JSON 数字非法：" + text);
            }
        }
    }
}
`;
}

/** Java 类名规范化（LeetCode 的 metaData.classname 一般是 Solution / MedianFinder 这类标识符）。 */
function javaClassName(input: HarnessInput): string {
  const raw = (input.meta.classname || '').trim();
  const cleaned = raw.replace(/[^A-Za-z0-9_$]/g, '');
  if (!cleaned || /^[0-9]/.test(cleaned)) return 'Solution';
  return cleaned;
}

/** 去掉目录与 `.java` 后缀的文件基名。 */
function baseNameWithoutExt(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.java$/i, '');
}

function javaSupports(meta: HarnessInput['meta']): HarnessSupport {
  if (meta.construct) {
    return { ok: false, reason: '设计类题目（多步操作）暂不支持本地脚手架' };
  }
  const types = [...meta.params.map((p) => p.type), meta.return.type];
  const unknown = types.find((t) => classifyType(t) === 'unknown');
  if (unknown) return { ok: false, reason: `暂不支持的类型：${unknown}` };
  return { ok: true };
}

export const JavaHarness: LanguageHarness = {
  slug: 'java',
  installHint: '需要本地安装 JDK（命令行可用 `javac -version` / `java -version` 验证，macOS 可 `brew install openjdk`）。',
  supports: javaSupports,
  generate(input: HarnessInput): HarnessArtifact {
    const className = javaClassName(input);
    const argKinds: TypeKind[] = input.meta.params.map((p) => classifyType(p.type));
    const returnKind: TypeKind = classifyType(input.meta.return.type);

    const files: HarnessFile[] = [
      { name: CASES_FILE, content: serializeCases(input) },
      {
        name: MAIN_FILE,
        content: buildMainJava({
          className,
          methodName: input.meta.name,
          argKinds,
          returnKind,
        }),
      },
    ];

    // javac 只要求「public 类」的文件名与类名一致；用户文件一般是 solution.java + `class Solution`。
    // 为了不修改用户文件，类名与文件名不一致时把代码复制成 <ClassName>.java 放进 genDir。
    const baseName = baseNameWithoutExt(input.sourceFile);
    const userJavaPath =
      baseName === className ? input.sourceAbsPath : joinGenDir(input.genDir, `${className}.java`);
    if (baseName !== className) {
      files.push({ name: `${className}.java`, content: input.sourceCode });
    }

    return {
      files,
      steps: [
        {
          label: 'compile',
          cmd: 'javac',
          args: ['-encoding', 'UTF-8', '-d', input.genDir, userJavaPath, joinGenDir(input.genDir, MAIN_FILE)],
          fatal: true,
        },
        {
          label: 'run',
          cmd: 'java',
          args: ['-cp', input.genDir, MAIN_CLASS],
          fatal: false,
        },
      ],
      debugEntry: MAIN_FILE,
      debugType: 'java',
      notes: [
        '生成的 Main.java 用反射调用 ' + className + '.' + input.meta.name + '，用户代码不会被修改。',
        baseName === className
          ? '类名与文件名一致，直接编译原文件（调试时断点会落在你的文件上）。'
          : `类名（${className}）与文件名（${input.sourceFile}）不一致，已把代码复制为 ${className}.java 后编译（原文件不动）。`,
        'ListNode / TreeNode / Node 由 Main.java 提供；若你的题解里也声明了同名类，请删掉本地那份，否则会重复定义导致编译失败。',
        '需要本地 JDK：`javac -version` / `java -version` 能正常运行。',
      ],
    };
  },
};

/** genDir 是绝对路径，这里只做字符串拼接（generate 保持纯函数，不落盘）。 */
function joinGenDir(genDir: string, name: string): string {
  const normalized = genDir.replace(/[\\/]+$/, '');
  const sep = /[\\/]/.test(normalized) ? (normalized.includes('\\') ? '\\' : '/') : '/';
  return normalized + sep + name;
}
