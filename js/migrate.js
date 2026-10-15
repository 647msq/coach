// 老数据补齐。逐字对应电脑版的 migrate()（app.py:207-316）。
//
// 什么时候用得上：
//   ① 打开应用时读到的 state 是老的形状（从电脑版导进来、或者以后我改了结构）
//   ② 导入备份之前，先在**候选数据**上跑一遍 —— 跑不过就别动线上数据
//
// 两条硬规矩，跟电脑版一样：
//   · **只增不改**：已有的字段一个都不动，只补缺的。返回 true 表示"动过、该落盘了"。
//   · 「碎片化娱乐」**只在真正升级那一次**（老 schema < 3）种下去。
//     之后他自己删了就是删了 —— 下次读进来不许给他复活。
//
// ★ 这个文件属于 logic.js 那一层：**不许碰 DOM / IndexedDB / fetch**，好让 node 里
//   拿电脑版的 migrate() 逐字段对拍（tools/fixtures.py 的 migrate 那一段）。

import { SCHEMA, SLEEP_HABIT, SCREEN_HABIT, habitGroup, pyStr, pyIntStr, getOr } from "./logic.js";

/** Python 的 isinstance(x, dict)：数组不是字典（JS 里 typeof [] 也是 "object"）。 */
function isDict(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** 一串记录里最大的那个 id。对应 Python 的 max([x.get("id", 0) for x in 表 if isinstance(x, dict)] or [0])：
 *  **非字典的整条跳过**，缺 id 的当 0，一条都没有时是 0。 */
function maxId(list) {
  const ids = (list || []).filter(isDict).map((x) => getOr(x, "id", 0));
  return ids.length ? Math.max(...ids) : 0;
}

/** `int(d.get(k) or 0)` —— Python 那边碰到读不懂的值会直接抛，这里也抛，
 *  只不过抛的是一句人话（导入备份失败时要显示给他看）。 */
function intOrZero(v, fieldName) {
  if (!v) return 0;                       // Python 的 `or 0`：0/""/None/[] 一律当 0
  const n = pyIntStr(v);
  if (n === null) throw new Error("这个字段看不懂：" + fieldName + " = " + JSON.stringify(v));
  return n;
}

/**
 * 把老数据补齐成新结构（**原地改** d）。返回 true 表示动过。
 * 逐行对应 app.py 的 migrate()，注释里的编号也跟那边一致。
 */
export function migrate(d) {
  if (!isDict(d)) throw new Error("这份数据不是一个对象，读不了");
  let changed = false;
  const oldSchema = getOr(d, "schema", 1);      // 先记下来：种内置习惯只认这个

  // 1) 顶层缺的补上
  if (d.schema !== SCHEMA) { d.schema = SCHEMA; changed = true; }
  for (const [k, v] of [["habits", []], ["tasks", []], ["events", []], ["reviews", {}],
                        ["chat", []], ["asks", []]]) {
    // ★ "缺这个键"才算缺：值是 null 的话 Python 的 `k in d` 是 True，不许动手
    if (!Object.prototype.hasOwnProperty.call(d, k)) { d[k] = v; changed = true; }
  }
  if (!Array.isArray(d.events)) { d.events = []; changed = true; }
  if (!isDict(d.reviews)) { d.reviews = {}; changed = true; }
  // 手改过的文件里可能是别的类型，一并兜住（不然下面的 push 会炸）
  if (!Array.isArray(d.chat)) { d.chat = []; changed = true; }
  if (!Array.isArray(d.asks)) { d.asks = []; changed = true; }
  if (!Object.prototype.hasOwnProperty.call(d, "floor_limit")) { d.floor_limit = 0; changed = true; }
  if (!isDict(d.reflections)) { d.reflections = {}; changed = true; }

  // 2) 每项任务补齐新字段。老任务一律算"主线" —— 它们本来就是奔着长期目标去的
  for (const t of getOr(d, "tasks", [])) {
    for (const [k, v] of [["line", "主线"], ["due", null], ["steps", []], ["source", "教练"]]) {
      if (!Object.prototype.hasOwnProperty.call(t, k)) { t[k] = v; changed = true; }
    }
    // steps 允许是 ["一句话", ...] 的老写法，统一成 [{"t":..,"done":..}]
    const fixed = [];
    for (const s of (t.steps || [])) {
      if (typeof s === "string") { fixed.push({ t: s, done: false }); changed = true; }
      else if (isDict(s)) {
        if (!("t" in s)) { s.t = pyStr(getOr(s, "text", "")); changed = true; }
        if (!("done" in s)) { s.done = false; changed = true; }
        fixed.push(s);
      }
      // 既不是字符串也不是字典的（比如一个数字）—— 跟电脑版一样，**丢掉**
    }
    t.steps = fixed;
  }

  // 3) 每个习惯补 group（**按 kind 分**，别一律塞进坏习惯）
  for (const h of getOr(d, "habits", [])) {
    if (!isDict(h)) continue;
    if (!("logs" in h)) { h.logs = []; changed = true; }
    if (!("goal" in h)) { h.goal = null; changed = true; }
    if (!("group" in h)) { h.group = habitGroup(h.kind); changed = true; }
  }

  /** 下一个没人用过的习惯 id。**必须比现有 id 都大**，否则插入会撞车。 */
  const nextHid = () => 1 + maxId(d.habits);

  // 4) 内置习惯得在。睡眠永远要有；「碎片化娱乐」只在真正升级这一次（schema < 3）种下去
  if (!d.habits.some((h) => isDict(h) && h.kind === "sleep")) {
    d.habits.unshift({
      id: nextHid(), name: SLEEP_HABIT, kind: "sleep",
      group: "生活", logs: [], goal: null,
    });
    changed = true;
  }
  if (oldSchema < 3 && !d.habits.some((h) => isDict(h) && h.kind === "screen")) {
    d.habits.push({
      id: nextHid(), name: SCREEN_HABIT, kind: "screen",
      group: "坏习惯", unit: "分钟", logs: [], goal: null,
    });
    changed = true;
  }

  // 5) 计数器顶到比现有 id 都大（老文件里这个值可能是偏小的）
  const mx = maxId(d.habits);
  if (intOrZero(getOr(d, "next_habit_id", 0), "next_habit_id") <= mx) {
    d.next_habit_id = mx + 1;
    changed = true;
  }

  if (!("next_event_id" in d)) { d.next_event_id = 1 + maxId(d.events); changed = true; }

  // 6) 对话/求情那两张表的计数器。**必须顶到比现有 id 都大** ——
  //    直接给 1 的话，撞了 id 就会改错任务。
  for (const [key, seq] of [["next_chat_id", "chat"], ["next_ask_id", "asks"]]) {
    const mx2 = maxId(d[seq]);
    if (intOrZero(getOr(d, key, 0), key) <= mx2) { d[key] = mx2 + 1; changed = true; }
  }

  return changed;
}
