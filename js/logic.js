// 纯计算层：从 app.py 移植过来的确定性逻辑。
//
// ★ 这个文件**不许碰 DOM、不许碰 IndexedDB、不许 fetch**。★
//   原因：tools/diff_test.mjs 要在 node 里直接 import 它，跟电脑版的 Python 函数逐条对拍。
//   一旦这里掺进浏览器专有的东西，对拍就跑不起来了，而判分逻辑正是最需要被验证的部分。
//
// 移植规矩（踩过的坑都写在这儿）：
//   · Python 的 round() 是「四舍六入五取偶」，JS 的 Math.round 是「五入」。
//     round(2.5) 在那边是 2，这边是 3。所以一律用下面的 pyRound()，别直接用 Math.round。
//   · Python 的 int() 是**向零截断**（int(-1.5) == -1），对应 Math.trunc，不是 Math.floor。
//   · Python 的 // 是**向下取整**（-1 // 2 == -1），对应 Math.floor。
//   · Python 的空列表求平均返回 None，不是 0 也不是 NaN —— JS 这边一律用 null 表示 None。

export const SCHEMA = 3;              // 数据结构版本。老文件（没有 schema）= 1，读进来会自动补齐
export const SLEEP_HABIT = "睡眠";
export const SCREEN_HABIT = "碎片化娱乐";

export const DAY_START_HOUR = 4;      // 一天从凌晨 4 点算起

export const WORK_MAX = 50;
export const MIN_RATIO = 0.7;
export const WORK_FLOOR = Math.trunc(WORK_MAX * MIN_RATIO);   // 35 —— 做到最低限度
export const W_MAIN = 0.70, W_SLEEP = 0.075, W_SCREEN = 0.075, W_SIDE = 0.15;


// ================= 数值小工具 =================

/** 把 IEEE-754 double 还原成**精确**的分数 num/den（都是 BigInt，den > 0，num >= 0）。
 *
 *  为什么要这么较真：double 存不下 0.1，所以 2.675 在内存里其实是 2.6749999999999998…。
 *  想复刻 Python 的取整，就必须拿到这个精确值，而不是"大概"。 */
function exactRatio(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (exp === 0) {
    // 非规格化数：值 = frac × 2^-1074
    return { num: frac, den: 1n << 1074n };
  }
  const m = (1n << 52n) | frac;        // 补上省略的那个隐含的 1
  const e = exp - 1075;                // 值 = m × 2^e
  if (e >= 0) return { num: m << BigInt(e), den: 1n };
  return { num: m, den: 1n << BigInt(-e) };
}

/** 复刻 Python 的 round(x, nd)：四舍六入五取偶（banker's rounding）。
 *
 *  JS 的 toFixed / Math.round 都是「五入」：round(2.5) 那边是 2、这边是 3。
 *  当天的总分就是 Python 的 round(x, 1) 算出来的，不照抄这一条，手机版会时不时差 0.1 分。
 *
 *  做法：把 x 写成精确分数 → 在**整数**上做"乘 10^nd、看余数"，只有余数**正好**是
 *  分母的一半时才走取偶分支。全程没有浮点误差，所以 2.675 → 2.67 这种也能对上。 */
export function pyRound(x, nd = 0) {
  if (x === null || x === undefined) return null;
  if (typeof x !== "number" || !isFinite(x)) return x;
  if (x === 0) return 0;
  const neg = x < 0;
  const { num, den } = exactRatio(Math.abs(x));
  const p10 = 10n ** BigInt(nd);
  const scaledNum = num * p10;         // = |x| × 10^nd，精确
  let q = scaledNum / den;             // 向零截断（都是正数，等于向下）
  const r = scaledNum - q * den;       // 余数
  const twice = r * 2n;
  if (twice > den) q += 1n;
  else if (twice === den && q % 2n === 1n) q += 1n;   // 正好一半 → 进位到偶数
  const out = Number(q) / Number(p10);
  return neg ? -out : out;
}

/** 复刻 Python 的 isinstance(x, int)。
 *
 *  ★ 坑：在 Python 里 **bool 是 int 的子类**，isinstance(True, int) 是 True。
 *  目标是 `true`（某个旧数据里把 bed_by 塞成了布尔）时，两边的判断会不一样：
 *  Python 认它、继续拿它当 1 用，JS 若用 Number.isInteger(true) 就会认为"目标坏了"
 *  而把它重置掉 —— 表现就是"训练目标莫名其妙被改回默认值"。
 *  同理 `isinstance("300", int)` 是 False（字符串不算），所以这里也不能退化成 Number()。 */
export function isPyInt(v) {
  return (typeof v === "number" && Number.isInteger(v)) || typeof v === "boolean";
}

/** 复刻 Python 的 int()：向零截断。**不是 Math.floor**（负数上两者不同）。 */
export function pyInt(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  if (!isFinite(n)) return null;
  return Math.trunc(n);
}

/** 列表求平均；空列表返回 null（对齐 Python 的 _avg 返回 None）。 */
export function avg(list) {
  if (!list || list.length === 0) return null;
  let s = 0;
  for (const v of list) s += v;
  return s / list.length;
}


// ================= 日期 =================

function pad2(n) { return String(n).padStart(2, "0"); }

/** Date → 'YYYY-MM-DD'，**按本地时区**取年月日（Python 的 .date().isoformat() 也是本地）。 */
export function isoDate(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/** 今天（带偏移）是哪一天，返回 'YYYY-MM-DD'。**一天从凌晨 4 点算起。**
 *
 *  为什么不是 00:00：晚上十一点开始背书、背到凌晨一点，那还是"今天"的事。
 *  按自然日算的话，一过午夜你的"今天"就翻页了，那段努力会被记到明天头上，
 *  而"今天还没交"和"今天已经交过"会瞬间互相矛盾。
 *
 *  now 参数是为了让测试能冻结时钟（Python 那边是靠 monkeypatch 换掉 datetime.datetime）。 */
export function dayShift(n = 0, now = new Date()) {
  // 完全照抄 Python：先减 4 小时，再加 n 个整天，最后取日期部分。
  const t = now.getTime() - DAY_START_HOUR * 3600 * 1000 + n * 86400 * 1000;
  return isoDate(new Date(t));
}

export function today(now = new Date()) { return dayShift(0, now); }

/** 'YYYY-MM-DD' → 本地零点的 Date（不做时区换算，纯粹当"日历上那一天"）。 */
export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** ISO 年 + 周数。**年用 ISO 年，不是日历年** ——
 *  2027-01-01 的 isocalendar() 是 (2026, 53, 5)，它属于 2026 年第 53 周。
 *  用 d.getFullYear() 拼出来的 key 是错的。 */
export function isoWeek(d) {
  // 标准算法：挪到本周的周四，那个周四所在的年就是 ISO 年
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (t.getDay() + 6) % 7;                 // 周一 = 0
  t.setDate(t.getDate() - dow + 3);                 // 本周周四
  const isoYear = t.getFullYear();
  // 该 ISO 年的第 1 周：1 月 4 日所在那一周的周一
  const jan4 = new Date(isoYear, 0, 4);
  const jan4dow = (jan4.getDay() + 6) % 7;
  const week1Mon = addDays(jan4, -jan4dow);
  const week = Math.round((t.getTime() - week1Mon.getTime()) / (7 * 86400 * 1000)) + 1;
  return { isoYear, week };
}

export function periodKey(period, day) {
  const d = day || new Date();
  const dt = typeof d === "string" ? parseDay(d) : d;
  if (period === "day") return isoDate(dt);
  if (period === "week") {
    const { isoYear, week } = isoWeek(dt);
    return isoYear + "-W" + String(week).padStart(2, "0");   // 补零：W53 要活下来
  }
  if (period === "month") return String(dt.getFullYear()).padStart(4, "0") + "-" + pad2(dt.getMonth() + 1);
  return String(dt.getFullYear());
}

/** key → 闭区间 [start, end]，返回两个 'YYYY-MM-DD' 字符串。 */
export function periodRange(period, key) {
  // ★ 看不懂的 key 一律**抛异常** —— 跟 Python 那边 date.fromisoformat() 抛 ValueError 一个意思。
  //   这不是洁癖：H.review 就是靠这个 try/catch 把"这个时间段看不懂：xxx"报出来的。
  //   不抛的话会走到"这一段时间里一条记录都没有"那句 —— 同样是报错，但说的是另一回事，
  //   而且对 period="month"/"year" 偏偏只有这一条路能走到（那边不抛的是 Invalid Date）。
  const bad = () => new TypeError("看不懂的时间段：" + key);
  if (period === "day") {
    const d0 = parseDay(key);
    if (!d0) throw bad();
    return [isoDate(d0), isoDate(d0)];
  }
  if (period === "week") {
    const m = /^(\d+)-W(\d+)$/.exec(String(key));
    if (!m) throw bad();
    const y = Number(m[1]), w = Number(m[2]);
    const jan4 = new Date(y, 0, 4);
    const jan4dow = (jan4.getDay() + 6) % 7;
    const mon = addDays(jan4, -jan4dow + (w - 1) * 7);        // ISO 周一
    return [isoDate(mon), isoDate(addDays(mon, 6))];
  }
  if (period === "month") {
    const [ys, ms] = String(key).split("-");
    const y = Number(ys), m = Number(ms);
    if (!Number.isFinite(y) || !Number.isFinite(m)) throw bad();
    const first = new Date(y, m - 1, 1);
    // 月末 = 下月 1 号 - 1 天。写成 new Date(y, m-1, 31) 碰到 2 月就滚到下个月去了。
    const nxt = new Date(y, m, 1);
    return [isoDate(first), isoDate(addDays(nxt, -1))];
  }
  const y = Number(key);
  if (!Number.isFinite(y)) throw bad();
  return [isoDate(new Date(y, 0, 1)), isoDate(new Date(y, 11, 31))];
}

/** 字符串比较即可 —— ISO 日期是定长的，字典序就是时间序。 */
export function inRange(day, rng) {
  const s = String(day || "");
  return !!s && rng[0] <= s && s <= rng[1];
}


// ================= 空数据 =================

/** 全新的空数据（第一次用的时候）。形状跟 app.py 的 blank_data() 一模一样。 */
export function blankData() {
  return {
    schema: SCHEMA,
    goal: "",
    tasks: [],
    habits: [
      { id: 1, name: SLEEP_HABIT, kind: "sleep", group: "生活", logs: [], goal: null },
      { id: 2, name: SCREEN_HABIT, kind: "screen", group: "坏习惯", unit: "分钟", logs: [], goal: null },
    ],
    events: [],
    reviews: {},
    // 跟教练的对话。他说的每句话都存下来 —— 不能因为 AI 掉线就没了。
    chat: [],
    // 每一次"求情"：pending/applied/declined/expired。**同时就是账本**，
    // 「本月放行了几次」永远是数出来的，不存计数器（存计数器双击就会双计）。
    asks: [],
    floor_limit: 0,        // 0 = 不设上限，教练按情况判断
    // 每天的自我反思：{ "2026-10-11": {"text": "...", "bonus": 0-5, "at": "..."} }
    reflections: {},
    next_id: 1,
    next_habit_id: 3,
    next_event_id: 1,
    next_chat_id: 1,
    next_ask_id: 1,
    created: today(),
  };
}

// ================= 习惯分组 =================

export function habitGroup(kind) {
  // **按 kind 分，不按"其它"兜底** —— 免得用户自己加的 custom 习惯被误标成坏习惯。
  return ({ sleep: "生活", screen: "坏习惯" })[kind] || "生活";
}

/** 自然日（**没有**凌晨 4 点那个偏移）。
 *
 *  ★ 移植时最容易栽的地方：Python 那边有**两个**"今天" ——
 *    模块自己的 today() 带 4 点偏移，而 datetime.date.today() 是自然日。
 *    streak / habit_streak / sleep_summary / screen_summary / calibrate_* 用的是**自然日**；
 *    day_score / public_task / calendar_days / butler_line 用的是**带偏移的那个**。
 *    一个都不能想当然，混了就出"每天都差一天"的怪事。 */
export function natToday(now = new Date()) { return isoDate(now); }


// ================= 睡眠 / 坏习惯：共用的换算 =================
// 时间一律换算成"距晚上 18:00 多少分钟"，这样 00:30（跨过午夜）才能正确地排在
// 23:00 后面 —— 直接比大小会得出"00:30 比 23:00 早"这种荒唐结论。

export const BED_BASE = 18 * 60;                        // 18:00
export const BED_EARLIEST = 22 * 60 + 30 - BED_BASE;    // 目标最早不早于 22:30
export const GREEN_BEFORE = 23 * 60 - BED_BASE;         // 23:00 之前 = 绿
export const AMBER_BEFORE = 24 * 60 + 30 - BED_BASE;    // 00:30 之前 = 黄

export const SCREEN_FLOOR = 60;       // 目标最低不低于 60 分钟（别算出个没人做得到的数）
export const SCREEN_BAR_MAX = 360;    // 柱状图的固定分母。**必须固定** —— 跟随目标走的话，
                                      // 目标每周往前挪，柱子会自己跳，"趋势"就没法看了。

/** 复刻 Python 的 str()：None → "None"，True → "True"。**只用在确实要拼字的地方**。 */
export function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** 复刻 Python 的 int(字符串)：**只认整数写法**。int("3.7") 在那边是 ValueError，
 *  所以这里不能退化成 Number() —— 那会把 "3.7" 悄悄变成 3，跟原版对不上。 */
export function pyIntStr(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return isFinite(v) ? Math.trunc(v) : null;
  const t = String(v).trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  return isFinite(n) ? n : null;
}

/** 复刻 Python 的 float()：看不懂就返回 null（那边是抛异常，调用点一律是 continue/兜底）。 */
export function pyFloat(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;          // 对象/数组：Python 会抛 TypeError
  const t = v.trim();
  if (t === "") return null;                       // float("") 是 ValueError
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return isFinite(n) ? n : null;
}

/** Python 的取模：结果**永远非负**（-30 % 60 = 30，JS 的 % 会给出 -30）。 */
function posMod(a, b) { return ((a % b) + b) % b; }

/** '23:30' → 1410。看不懂就返回 null。 */
export function hhmmToMin(s) {
  if (typeof s !== "string" || s.indexOf(":") === -1) return null;
  const parts = s.trim().split(":");
  const h = pyIntStr(parts[0]), m = pyIntStr(parts[1]);
  if (h === null || m === null) return null;
  if (0 <= h && h <= 23 && 0 <= m && m <= 59) return h * 60 + m;
  return null;
}

/** 入睡时间 → 距 18:00 的分钟。23:00→300，00:30→390，01:20→440。 */
export function bedScale(s) {
  let m = hhmmToMin(s);
  if (m === null) return null;
  if (m < BED_BASE) m += 24 * 60;
  return m - BED_BASE;
}

/** 反过来：距 18:00 的分钟 → 'HH:MM'。注意 Python 用的是 int()（**向零截断**，不是四舍五入）。 */
export function scaleToHhmm(v) {
  const total = posMod(pyInt(v) + BED_BASE, 24 * 60);
  return pad2(Math.floor(total / 60)) + ":" + pad2(total % 60);
}

/** 睡了几个小时。跨午夜自动处理（01:20 睡、08:40 起 = 7.33 小时）。 */
export function sleepHours(bed, wake) {
  const b = hhmmToMin(bed);
  let w = hhmmToMin(wake);
  if (b === null || w === null) return null;
  if (w <= b) w += 24 * 60;
  return pyRound((w - b) / 60.0, 2);
}

/** 绿 / 黄 / 红。看的是**入睡时间**，不是时长。 */
export function sleepStatus(bed) {
  const v = bedScale(bed);
  if (v === null) return "none";
  if (v < GREEN_BEFORE) return "ok";
  if (v < AMBER_BEFORE) return "mid";
  return "bad";
}

/** 中位数。**注意返回的是"浮点数"** —— 偶数个数时取中间两个的平均。空 → null。 */
export function median(xs) {
  const a = (xs || []).filter((x) => x !== null && x !== undefined).sort((p, q) => p - q);
  if (!a.length) return null;
  const n = a.length, mid = Math.floor(n / 2);
  return n % 2 ? Number(a[mid]) : (a[mid - 1] + a[mid]) / 2.0;
}

export function sleepHabit(d) {
  for (const h of (d && d.habits) || []) if (h && h.kind === "sleep") return h;
  return null;
}

export function screenHabit(d) {
  for (const h of (d && d.habits) || []) if (h && h.kind === "screen") return h;
  return null;
}

export function findHabit(d, hid) {
  for (const h of (d && d.habits) || []) if (h && h.id === hid) return h;
  throw new Error("找不到这个习惯");
}

/** 连续记了几天睡眠。**这是习惯自己的连续天数，跟学习的连续天数分开算** ——
 *  免得光记睡眠就把学习的 🔥 假装点亮了。 */
export function habitStreak(d, h, now = new Date()) {
  h = h || sleepHabit(d);
  if (!h) return 0;
  const days = new Set(((h.logs || [])).filter((l) => l && l.date).map((l) => l.date));
  let n = 0;
  let cur = parseDay(natToday(now));
  if (!days.has(isoDate(cur))) cur = addDays(cur, -1);   // 今天还没记，就从昨天往回数
  while (days.has(isoDate(cur))) { n++; cur = addDays(cur, -1); }
  return n;
}

/** 每周结算一次渐进目标。做到了 → 目标再往前挪 15 分钟；没做到 → 原地不动（**不惩罚**）。
 *  返回 true 表示动过。 */
export function calibrateSleep(d, now = new Date()) {
  const h = sleepHabit(d);
  if (!h) return false;
  const logs = ((h.logs || [])).filter((l) => l && l.bed)
    .sort((a, b) => ((a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0));
  if (logs.length < 5) return false;                       // 数据太少，先老实记
  const med = median(logs.slice(-7).map((l) => bedScale(l.bed)));
  if (med === null) return false;
  const goal = h.goal;
  if (!goal || typeof goal !== "object" || !isPyInt(goal.bed_by)) {
    h.goal = { set_on: today(now), bed_by: Math.max(BED_EARLIEST, pyInt(med) - 15) };
    return true;
  }
  let due;
  try {
    const s = parseDay(goal.set_on);
    if (!s) throw new Error("日期读不出来");
    due = addDays(s, 7);
  } catch (e) {
    due = parseDay(natToday(now));
  }
  if (parseDay(natToday(now)) < due) return false;          // 还没到一周，不动
  if (med <= goal.bed_by) {                                // 他做到了 → 继续往前挪
    h.goal = { set_on: today(now), bed_by: Math.max(BED_EARLIEST, pyInt(med) - 15) };
  } else {
    goal.set_on = today(now);                              // 没做到 → 不动，下个周期再看
  }
  return true;
}

/** 同上，方向相反：睡眠"越大越好"（越早），这个"越小越好"。 */
export function calibrateScreen(h, now = new Date()) {
  const logs = ((h && h.logs) || []).filter((l) => l && l.min !== null && l.min !== undefined)
    .sort((a, b) => ((a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0));
  if (logs.length < 5) return false;
  const med = median(logs.slice(-7).map((l) => l.min));
  if (med === null) return false;
  const goal = h.goal;
  if (!goal || typeof goal !== "object" || !isPyInt(goal.max_min)) {
    h.goal = { set_on: today(now), max_min: Math.max(SCREEN_FLOOR, pyInt(med) - 15) };
    return true;
  }
  let due;
  try {
    const s = parseDay(goal.set_on);
    if (!s) throw new Error("日期读不出来");
    due = addDays(s, 7);
  } catch (e) {
    due = parseDay(natToday(now));
  }
  if (parseDay(natToday(now)) < due) return false;
  if (med <= goal.max_min) {
    h.goal = { set_on: today(now), max_min: Math.max(SCREEN_FLOOR, pyInt(med) - 15) };
  } else {
    goal.set_on = today(now);
  }
  return true;
}

/** 绿 / 黄 / 红。**这只是"跟目标比一比"，不是判过不过** ——
 *  他这一项本来就没有"最低限度"那一说，比目标差就是黄/红。 */
export function screenStatus(mins, goalMin) {
  if (mins === null || mins === undefined) return "none";
  if (goalMin === null || goalMin === undefined) goalMin = 180;   // 还没算出目标时，先用 3 小时当参照
  if (mins <= goalMin) return "ok";
  if (mins <= goalMin * 1.5) return "mid";
  return "bad";
}

/** 给界面用的睡眠汇总：14 天色块 + 平均时长 + 比上周早/晚了多少 */
export function sleepSummary(h, days = 14, now = new Date()) {
  const logs = ((h && h.logs) || []).filter((l) => l && l.date)
    .sort((a, b) => ((a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0));
  const byDate = {};
  for (const l of logs) byDate[l.date] = l;

  const cur = parseDay(natToday(now));
  const chart = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = isoDate(addDays(cur, -i));
    const l = byDate[day];
    if (l && l.bed) {
      chart.push({ date: day, level: sleepStatus(l.bed), hours: l.hours ?? null,
                   bed: l.bed, wake: l.wake ?? null });
    } else {
      chart.push({ date: day, level: "none", hours: null, bed: null, wake: null });
    }
  }

  const haveH = logs.filter((l) => l.hours !== null && l.hours !== undefined);
  const last7 = haveH.slice(-7), prev7 = haveH.slice(-14, -7);
  const avg7 = last7.length
    ? pyRound(last7.reduce((s, l) => s + l.hours, 0) / last7.length, 1) : null;
  const bed7 = median(last7.filter((l) => l.bed).map((l) => bedScale(l.bed)));
  const bedp = median(prev7.filter((l) => l.bed).map((l) => bedScale(l.bed)));
  const shift = (bed7 !== null && bedp !== null) ? pyInt(pyRound(bedp - bed7)) : null;

  const goal = h.goal || {};
  return {
    chart: chart,
    avg_hours: avg7,
    avg_bed: bed7 !== null ? scaleToHhmm(bed7) : null,
    shift_min: shift,                       // 正数 = 比上一周早睡了这么多分钟
    goal_bed: isPyInt(goal.bed_by) ? scaleToHhmm(goal.bed_by) : null,
    ok_days: chart.filter((c) => c.level === "ok").length,
    logged_days: chart.filter((c) => c.level !== "none").length,
    total_days: days,
  };
}

/** 给界面用的娱乐时间汇总：14 天柱 + 平均 + 比上周少了多少分钟 */
export function screenSummary(h, days = 14, now = new Date()) {
  const logs = ((h && h.logs) || []).filter((l) => l && l.date)
    .sort((a, b) => ((a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0));
  const byDate = {};
  for (const l of logs) byDate[l.date] = l;
  const goal = (h && h.goal) || {};
  const goalMin = isPyInt(goal.max_min) ? goal.max_min : null;

  const cur = parseDay(natToday(now));
  const chart = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = isoDate(addDays(cur, -i));
    const l = byDate[day];
    const v = (l && typeof l === "object" && l.min !== undefined) ? l.min : null;
    if (v === null || v === undefined) {
      chart.push({ date: day, level: "none", min: null });
    } else {
      chart.push({ date: day, level: screenStatus(v, goalMin), min: v });
    }
  }

  const have = logs.filter((l) => l.min !== null && l.min !== undefined);
  const last7 = have.slice(-7), prev7 = have.slice(-14, -7);
  const avg7 = last7.length ? pyInt(pyRound(last7.reduce((s, l) => s + l.min, 0) / last7.length)) : null;
  const mNow = median(last7.map((l) => l.min));
  const mPrev = median(prev7.map((l) => l.min));
  // 正数 = 比上一周**少刷了**这么多分钟（跟睡眠那边符号方向一致：正数 = 变好）
  const shift = (mNow !== null && mPrev !== null) ? pyInt(pyRound(mPrev - mNow)) : null;

  return {
    chart: chart,
    avg_min: avg7,
    shift_min: shift,
    goal_min: goalMin,
    bar_max: SCREEN_BAR_MAX,
    ok_days: chart.filter((c) => c.level === "ok").length,
    logged_days: chart.filter((c) => c.level !== "none").length,
    total_days: days,
  };
}

export function publicHabit(h, days = 14, now = new Date()) {
  const logs = ((h && h.logs) || []).filter((l) => l && l.date)
    .sort((a, b) => ((a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0));
  const t = today(now);
  const todaylog = logs.find((l) => l.date === t) || null;
  const kind = h.kind === undefined ? "custom" : h.kind;    // ← 同 publicTask：只有"没有这个键"才兜底
  const out = {
    id: h.id ?? null,
    name: h.name ?? "",
    kind: kind,
    group: h.group || habitGroup(kind),
    line: "习惯",                            // 让界面能统一处理
    unit: h.unit ?? "",
    target: h.target ?? "",
    today: todaylog,
    last: logs.length ? logs[logs.length - 1] : null,
    log: logs.slice(-30),
    streak: habitStreak(null, h, now),
  };
  if (kind === "sleep") out.sleep = sleepSummary(h, days, now);
  else if (kind === "screen") {
    // 注意：screen 的**目标在 goal 里**，不是 target 字段。界面别去读 target。
    out.screen = screenSummary(h, days, now);
  }
  return out;
}


// ================= 打分 =================

export const TEST_MAX = 50;
export const TEST_FLOOR = Math.trunc(TEST_MAX * MIN_RATIO);   // 35 —— 正好也是"不标黄不标红"那条线
export const OVER_MAX = 10;        // 超额附加分，在总分**上面**另加，不是从 100 里匀
export const REFLECT_MAX = 5;      // 自我反思最多加几分
export const GRADE_RED = 0.4;      // 测试得分率低于四成 → 红
export const GRADE_AMBER = MIN_RATIO;   // 低于七成 → 黄
export const REFLECT_INPUT_MAX = 2000;

/** 掌握标记：'' / 'amber' / 'red'。看的是**测试那半边**。
 *
 *  这跟"打勾"（这一项今天做完了）是**两件事** —— 做完了照样打勾，
 *  没掌握只是标出来，后面几天的表里带上它复习。 */
export function gradeOf(test) {
  if (test === null || test === undefined) return "";
  const r = test / TEST_MAX;
  if (r < GRADE_RED) return "red";
  if (r < GRADE_AMBER) return "amber";
  return "";
}

/** 习惯分：绿 100 / 黄 50 / 红 0。看不出来就返回 null（**不计入，不是 0 分**）。
 *
 *  红为什么要给 0：这 15 分**全部**就是"作息那块"的分。熬到凌晨三点那一格归零，
 *  它才真的能让"事事都刚好做到最低限度"的那一天掉到 60 以下。 */
export function habitScore(status) {
  const m = { ok: 100, mid: 50, bad: 0 };
  return (status in m) ? m[status] : null;
}

/** 那一天的记录（没有就 null）。 */
export function logOn(habit, day) {
  for (const l of ((habit && habit.logs) || [])) {
    if (l && typeof l === "object" && l.date === day) return l;
  }
  return null;
}

/** 当天总评分。**纯本地算，一分钱不花。**
 *
 *  主线 70% + 睡眠 7.5% + 屏幕 7.5% + 支线 15%，
 *  缺哪一块就把哪一块的权重去掉、按剩下的重新换算成百分制
 *  （**忘了记睡眠不能等于没做好** —— 那惩罚的是健忘，不是拖延）。
 *  自我反思另外加，最多 5 分。 */
export function dayScore(d, day, now = new Date()) {
  day = day || today(now);
  const groups = { main: [], side: [] };

  for (const t of ((d && d.tasks) || [])) {
    const todaySubs = ((t && t.submissions) || [])
      .filter((s) => s && typeof s === "object" && s.date === day);
    if (!todaySubs.length) continue;
    const s = todaySubs[todaySubs.length - 1];        // 同一天交了好几次，算最后一次
    let total = s.total;
    if (total === null || total === undefined) {      // 兼容：没有 total 就用零件加起来
      total = (s.work || 0) + (s.test || 0) + (s.over || 0);
    }
    const num = pyFloat(total);
    if (num === null) continue;                       // Python 那边是 except → continue
    groups[t.line === "支线" ? "side" : "main"].push(num);
  }

  const parts = [];
  const m = avg(groups.main);
  if (m !== null) parts.push({ key: "主线", w: W_MAIN, v: m });
  const sd = avg(groups.side);
  if (sd !== null) parts.push({ key: "支线", w: W_SIDE, v: sd });

  const sh = sleepHabit(d);
  const lg = sh ? logOn(sh, day) : null;
  if (lg && lg.bed) {
    const v = habitScore(sleepStatus(lg.bed));
    if (v !== null) parts.push({ key: "睡眠", w: W_SLEEP, v: v });
  }

  const ch = screenHabit(d);
  const lg2 = ch ? logOn(ch, day) : null;
  if (lg2 && lg2.min !== null && lg2.min !== undefined) {
    const v = habitScore(screenStatus(lg2.min, ((ch.goal || {}).max_min)));
    if (v !== null) parts.push({ key: "屏幕", w: W_SCREEN, v: v });
  }

  if (!parts.length) return null;

  const wsum = parts.reduce((s, p) => s + p.w, 0);
  const base = parts.reduce((s, p) => s + p.w * p.v, 0) / wsum;

  const refl = (((d && d.reflections) || {})[day]) || {};
  let bonus = 0;
  const rawBonus = refl.bonus || 0;
  const b = pyIntStr(rawBonus);
  if (b !== null) bonus = Math.max(0, Math.min(REFLECT_MAX, b));

  return {
    day: day,
    total: pyRound(base + bonus, 1),
    base: pyRound(base, 1),
    bonus: bonus,
    parts: parts.map((p) => ({ key: p.key, v: pyRound(p.v, 1),
                               w: pyRound(p.w / wsum * 100, 1) })),
  };
}

/** 那天的干巴巴事实，拼成一段字 —— 喂给 AI 判断反思用（本地拼，不额外花钱）。 */
export function dayBrief(d, day, now = new Date()) {
  day = day || today(now);
  const L = [];
  for (const t of ((d && d.tasks) || [])) {
    for (const s of ((t && t.submissions) || [])) {
      if (s && typeof s === "object" && s.date === day) {
        L.push("- " + pyStr(t.title || "") + "：总分 " + pyStr(s.total)
          + "（完成 " + pyStr(s.work) + "/" + WORK_MAX
          + "，测试 " + pyStr(s.test) + "/" + TEST_MAX + "）"
          + ({ red: "，没掌握", amber: "，一般" }[s.grade || ""] || ""));
        break;
      }
    }
  }
  if (!L.length) L.push("- 今天一项都没交。");
  const sc = dayScore(d, day, now);
  if (sc) L.push("当天总评分：" + pyStr(sc.total));
  return L.join("\n");
}

/** 那天有哪些项标了红/黄。日历上要显示的就是它。 */
export function dayMarks(d, day, now = new Date()) {
  day = day || today(now);
  const out = [];
  for (const t of ((d && d.tasks) || [])) {
    for (const s of ((t && t.submissions) || [])) {
      if (s && typeof s === "object" && s.date === day && s.grade) {
        out.push({ title: t.title || "", grade: s.grade });
        break;
      }
    }
  }
  return out;
}

export function allPassDays(d) {
  const days = new Set();
  for (const t of ((d && d.tasks) || [])) {
    for (const s of ((t && t.submissions) || [])) {
      if (s && s.pass) days.add(s.date);
    }
  }
  return days;
}

/** 连续完成天数。**注意用的是自然日**（Python 那边是 datetime.date.today()）。 */
export function streak(d, now = new Date()) {
  const days = allPassDays(d);
  let n = 0;
  let cur = parseDay(natToday(now));
  while (days.has(isoDate(cur))) { n++; cur = addDays(cur, -1); }
  return n;
}


// ================= 任务 =================

export function publicTask(t, now = new Date()) {
  const subs = t.submissions || [];
  const last = subs.length ? subs[subs.length - 1] : null;
  const due = t.due ?? null;
  const tStr = today(now);
  // ★ 这些 `??` 不能写成 `||`：Python 的 .get(key, 默认值) **只在键不存在时**才用默认值，
  //   显式的 null 会原样透出去。写成 `||` 的话 null 会被悄悄换成默认值，
  //   对拍时这种差别是最难找的一类。
  return {
    id: t.id,
    line: t.line || "主线",
    title: t.title ?? "",
    min: t.min ?? "",
    why: t.why ?? "",
    cat: t.cat || "未分类",
    due: due,
    overdue: !!(due && !t.pass && due < tStr),
    steps: t.steps || [],
    source: t.source ?? "教练",
    pass: !!t.pass,
    passed_date: t.passed_date ?? null,
    // 教练今天放行了这一项（== 今天做到最低限度就算数）。
    // **注意它只管今天**：floor_on 是昨天的话，这里就是 false，明早自动恢复。
    floor_today: t.floor_on === tStr,
    tries: subs.length,
    last: last,
    subs: subs.slice(-20),
  };
}

export function findTask(d, tid) {
  for (const t of ((d && d.tasks) || [])) if (t && t.id === tid) return t;
  throw new Error("找不到这项任务");
}

/** 不花 AI 的一句话：直接从数据里挑一件最该现在说的事。 */
export function butlerLine(d, now = new Date()) {
  const tasks = (d && d.tasks) || [];
  if (!tasks.length) return "还没定任务。跟我说说你要干什么，我给你列。";

  const tStr = today(now);
  const soon = dayShift(1, now);
  const sides = tasks.filter((x) => x.line === "支线" && !x.pass);
  const urgent = sides.filter((x) => x.due && x.due <= soon)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  if (urgent.length) {
    const t0 = urgent[0];
    const when = t0.due === tStr ? "今天" : "明天";
    return "「" + t0.title + "」" + when + "就要交。先动这个，别的都往后放。";
  }

  const stuck = tasks.filter((t) => (t.submissions || []).length && !t.pass);
  if (stuck.length) {
    // 交得次数最多的排最前（Python 是按 -len 排序，稳定排序 = 同数保原序）
    const sorted = stuck.slice().sort((a, b) => (b.submissions || []).length - (a.submissions || []).length);
    const t0 = sorted[0];
    return "「" + t0.title + "」你已经交了 " + (t0.submissions || []).length + " 次还没过。别换项目躲，就磨它。";
  }

  const h = sleepHabit(d);
  if (h && (h.logs || []).length >= 3) {
    const s = sleepSummary(h, 14, now);
    const bad = s.chart.filter((c) => c.level === "bad").length;
    if (bad >= 3) {
      return "最近 " + s.total_days + " 天你有 " + bad + " 天是 00:30 之后才睡的。先把这个改掉，白天才有得谈。";
    }
    if (s.avg_hours && s.avg_hours < 6.5) {
      return "最近平均只睡 " + s.avg_hours + " 小时。你缺的不是时间是觉。";
    }
  }

  const ch = screenHabit(d);
  if (ch && (ch.logs || []).length >= 3) {
    const ss = screenSummary(ch, 14, now);
    if (ss.avg_min && ss.avg_min > 180) {
      return "最近你平均每天刷 " + minsText(ss.avg_min) + " 手机。不用你今天就戒，先记着 —— "
        + "记满一周我给你定个够得着的数。";
    }
  }

  const undone = tasks.filter((t) => !t.pass);
  if (undone.length === tasks.length) {
    const light = undone.slice().sort((a, b) =>
      ((a.title || "").length - (b.title || "").length))[0];   // Python min()：并列取第一个
    return "一项都还没交。从最轻的「" + light.title + "」开始，别挑大的。";
  }

  return "主线 " + tasks.length + " 项，过了 "
    + tasks.filter((t) => t.pass).length + " 项。接着来。";
}

/** 注意 Python 那边 min(undone, key=len(title)) 在**并列时取第一个**。
 *  所以上面的排序必须是稳定的 —— V8 的 Array.sort 是稳定的，同长度保原序，
 *  而这个 sort 的映射恰好保留了原顺序，于是 [0] 就是 Python 会给的那一项。 */

export function progress(d) {
  const tasks = (d && d.tasks) || [];
  const main = tasks.filter((t) => (t.line || "主线") === "主线");
  return {
    done: tasks.filter((t) => t.pass).length,
    total: tasks.length,
    main_done: main.filter((t) => t.pass).length,
    main_total: main.length,
    side_total: tasks.length - main.length,
  };
}

export function recent(d, limit = 30) {
  const rows = [];
  for (const t of ((d && d.tasks) || [])) {
    for (const s of ((t && t.submissions) || [])) {
      rows.push(Object.assign({}, s, { title: t.title || "", id: t.id }));
    }
  }
  // Python 的 sort 是稳定的：同一天的多条保持"任务顺序 + 提交顺序"。
  // JS 的 Array.sort 也是稳定的，所以这里能对齐。
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows.slice(0, limit);
}

export function minsText(v) {
  if (v === null || v === undefined) return "没记";
  return Math.floor(v / 60) + " 小时 " + pad2(posMod(v, 60)) + " 分";
}


// ================= 日历 =================

/** 给日历用的按天摘要。**只回过去、只回真正有内容的那几天**（稀疏字典）。
 *
 *  未来的事（支线截止、考试日）**不塞进来** —— 前端直接从 tasks[].due 和
 *  events 现算。否则"只往回看 400 天"永远装不下未来的标记。 */
export function calendarDays(d, back = 400, now = new Date()) {
  const out = {};
  const tStr = today(now);

  const slot = (day) => (out[day] !== undefined ? out[day]
    : (out[day] = { n: 0, p: 0, f: 0, bed: null, sl: null, sc: null }));

  for (const t of ((d && d.tasks) || [])) {
    for (const s of ((t && t.submissions) || [])) {
      const day = s && s.date;
      if (!day || String(day) > tStr) continue;
      const e = slot(day);
      e.n += 1;
      if (s.pass) e.p += 1;
      else e.f += 1;               // 没过的次数 —— 日历绿底要靠它
    }
  }
  const sh = sleepHabit(d);
  if (sh) {
    for (const l of (sh.logs || [])) {
      if (l && l.date) {
        const e = slot(l.date);
        e.bed = l.bed ?? null;
        e.sl = sleepStatus(l.bed);
      }
    }
  }
  const ch = screenHabit(d);
  if (ch) {
    for (const l of (ch.logs || [])) {
      if (l && l.date) slot(l.date).sc = l.min ?? null;
    }
  }

  for (const day of Object.keys((d && d.reflections) || {})) {
    if (day <= tStr) slot(day);      // 只写了反思的那天也算"有内容"
  }

  const keep = {};
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v.n || v.bed || v.sc !== null) keep[k] = v;
  }
  // 每天的总评分 + 那天的红黄标（日历点开那天要看的）
  for (const day of Object.keys(keep)) {
    const v = keep[day];
    const sc = dayScore(d, day, now);
    v.score = sc ? sc.total : null;
    v.marks = dayMarks(d, day, now);
  }
  return keep;
}


// ================= 规范化小工具 =================

/** 把 steps 统一成 [{t: 文字, done: 假}]。允许传字符串列表。最多留 8 条。 */
export function normSteps(raw) {
  let src = raw;
  if (typeof src === "string") src = src.split("\n");
  const out = [];
  for (const s of (src || [])) {
    let txt, done;
    if (s && typeof s === "object" && !Array.isArray(s)) {
      txt = String(pyStr(s.t || s.text || "")).trim();
      done = !!s.done;
    } else {
      txt = pyStr(s).trim();     // ★ Python 是 str(s).strip()：null 会变成字面量 "None"
      done = false;
    }
    if (txt) out.push({ t: txt, done: done });
  }
  return out.slice(0, 8);
}

export function normLine(v, due) {
  v = String(v ?? "").trim();
  if (v === "支线" || v === "支" || v === "side") return "支线";
  if (v === "主线" || v === "主" || v === "main") return "主线";
  return due ? "支线" : "主线";       // 没写就按有没有截止日猜
}

/** 'YYYY-MM-DD' 或它开头的一段 → 规范化的日期串；看不懂返回 null。
 *  **要真的检查这个日期存在** —— 2026-02-30 在 Python 那边会抛异常，
 *  而 JS 的 Date 会悄悄滚到 3 月 2 日，不检查就静默对不上了。 */
export function normDue(v) {
  const s = String(v ?? "").trim();
  if (!s || ["null", "none", "无"].includes(s.toLowerCase())) return null;
  const head = s.slice(0, 10);
  // ★ Python 3.11 起 date.fromisoformat() 连 "20261014" 这种紧凑写法也认
  //   （v[:10] 截出来正好 8 位）。不认它的话，用户手打 20261014 两边结果就不一样了。
  let cand = head;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) {
    if (!compact) return null;
    cand = compact[1] + "-" + compact[2] + "-" + compact[3];
  }
  const d = parseDay(cand);
  if (!d || isoDate(d) !== cand) return null;     // 2026-02-30 这种要挡掉：JS 的 Date 会自己滚到 3 月
  return cand;
}

/** 日程的种类只有三种，写别的就归"其他"。 */
export function normEventKind(v) {
  const s = String(v ?? "").trim();
  return ["考试", "截止", "其他"].includes(s) ? s : "其他";
}

/** 把界面传来的 {h, m} 或 {minutes} 统一成分钟。看不懂返回 null。 */
export function minutesFrom(p) {
  if (p.minutes !== null && p.minutes !== undefined) {
    const v = pyIntStr(p.minutes);
    if (v === null) return null;
    // 超出一天就直接判"看不懂"，别悄悄给他改成 1440
    return (0 <= v && v <= 1440) ? v : null;
  }
  const hh = pyIntStr(p.h || 0);
  const mm = pyIntStr(p.m || 0);
  if (hh === null || mm === null) return null;
  if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
  return Math.max(0, Math.min(1440, hh * 60 + mm));
}

/** 同一天只留一条：有就覆盖，没有就追加。
 *  **覆盖时把旧条目的 shot 继承过来** —— 否则用户只是改一下时间、没重传图，
 *  截图就从索引里消失了（文件还在，但再也找不回来）。 */
export function putLog(h, entry) {
  const logs = (h.logs = h.logs || []);
  let hit = false;
  for (let i = 0; i < logs.length; i++) {
    const l = logs[i];
    if (l && typeof l === "object" && l.date === entry.date) {
      if (!entry.shot && l.shot) entry.shot = l.shot;
      logs[i] = entry;
      hit = true;
      break;
    }
  }
  if (!hit) logs.push(entry);
  logs.sort((a, b) => ((a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0));
  return logs;
}


// ================= 杂项 =================

/** 复刻 Python 的 "{:.1f}".format(x)。
 *
 *  ★ 不能直接用 toFixed：Python 的格式化是**四舍六入五取偶**，JS 的 toFixed 是五入。
 *    16.25 在那边印成 "16.2"、这边印成 "16.3"。先用 pyRound 修成同一个数，再印。 */
export function fmt1(x) {
  const r = pyRound(x, 1);
  return (r === null ? 0 : r).toFixed(1);
}

/** 现在几点几分几秒，写成 '2026-10-14T12:00:00'（**本地时间**，跟 Python 的
 *  datetime.now().isoformat(timespec="seconds") 一个格式）。
 *  ★ 别用 toISOString()：那是 UTC，会带个 Z，还会差 8 小时。 */
export function nowStamp(now = new Date()) {
  return isoDate(now) + "T" + pad2(now.getHours()) + ":" + pad2(now.getMinutes())
    + ":" + pad2(now.getSeconds());
}

/** 放行账本。**从 asks 现算，绝不存计数器** ——
 *  存计数器的话双击两下就会双计（两次请求都读到旧值再各写一次）。
 *  现算是幂等的，所以压根没有"次数"这个东西可以被写坏。 */
export function floorStat(d, now = new Date()) {
  const month = periodKey("month", natToday(now));
  const asks = ((d && d.asks) || []).filter((a) => a && typeof a === "object");
  const applied = asks.filter((a) => a.status === "applied");
  const thisMonth = applied.filter((a) => String(a.decided_at ?? "").slice(0, 7) === month);
  const stamps = applied.map((a) => String(a.decided_at ?? ""));
  const last = stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : "";
  return {
    used: thisMonth.length,
    last: last.slice(0, 10) || null,
    limit: pyIntStr(d && d.floor_limit) ?? 0,        // 0 = 不设上限
    recent: thisMonth.map((a) => ({
      date: String(a.decided_at ?? "").slice(0, 10),
      title: a.title ?? "",
      reason: a.reason ?? "",
      task_id: a.task_id ?? null,
    })).slice(-10),
  };
}

// ================= 教练对话（第三轮）=================
//
// 这一段的原文在 app.py:2026-2260。三个纯函数 + 一个筛子，都不碰 DOM / IndexedDB。

export const CHAT_KEEP = 200;        // 对话最多留多少条（超了从头砍，但被 asks 指着的消息不砍）
export const CHAT_SEND = 6;          // 每次发给 AI 的最近几条（别把整本聊天记录都发过去，费钱）
export const CHAT_INPUT_MAX = 1000;  // 他一条最多打多少字
export const CHAT_DAILY = 30;        // 一天最多聊几句 —— 纯粹是省钱的闸，不是惩罚
// 注：app.py 里还有个 ASK_KEEP_DAYS = 400，但那边**从头到尾没被用过**，
//     所以这里故意不搬 —— 搬过来也是死代码，还容易让人以为有什么保留策略在跑。

/** 是不是"字典"（对应 Python 的 isinstance(x, dict)）。
 *  ★ 不能只写 `typeof x === "object"` —— JS 里数组也是 object，而 Python 里不是 dict。
 *    这个差别在 asks / chat 这种"里面装的应该是对象"的数组上会被放大。 */
function isDict(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

/** 复刻 Python 的 `d.get(key, default)`：**只有键不存在时**才给默认值。
 *  显式写了个 null 的话要原样返回 null，所以绝对不能用 ||。 */
export function getOr(obj, key, dflt) {
  const v = obj ? obj[key] : undefined;
  return v === undefined ? dflt : v;
}

/** 超 7 天还没决定的求情自动作废 —— 免得一个月前的提议被默默按下。
 *  ★ 用的是**自然日**（Python 那边是 datetime.date.today()）。 */
export function expireAsks(d, now = new Date()) {
  const cutoff = isoDate(addDays(parseDay(natToday(now)), -7));
  for (const a of ((d && d.asks) || [])) {
    if (isDict(a) && a.status === "pending" && String(a.at ?? "").slice(0, 10) < cutoff) {
      a.status = "expired";
    }
  }
}

/** 对话只留最近 CHAT_KEEP 条。**被 asks 指着的消息永远不砍** ——
 *  砍了以后界面上的放行卡片就找不到它属于哪句话了。 */
export function chatTrim(d) {
  const chat = (d && d.chat) || [];
  if (chat.length <= CHAT_KEEP) return;
  const keep = new Set(((d && d.asks) || []).filter(isDict).map((a) => a.msg_id));
  const head = chat.slice(0, chat.length - CHAT_KEEP);
  const tail = chat.slice(chat.length - CHAT_KEEP);
  d.chat = head.filter((m) => keep.has(m && m.id)).concat(tail);
}

/** 拼给教练看的上下文。**省着点** —— 只给白名单、账本、最近几句。
 *
 *  刻意**不喂** submissions / logs：那是点评的活，喂了既贵，又会招来
 *  "编出来的相关性"（他会直接问"我是不是因为刷手机才学不进去"，模型就会顺着答应）。
 *  这里所有的数字都是本地算好、摆在那儿的。 */
export function chatContext(d, now = new Date()) {
  const L = [];
  if (d && d.goal) L.push("他的长期目标：" + pyStr(d.goal));
  L.push("今天：" + today(now));

  // 可放行的任务 = **白名单**。最低限度是空的不能进 —— 放行了也什么都没变，
  // 他点一下发现没用，这个按钮就废了。**id 只在这里出现一次**，模型只能从这儿挑。
  const day = today(now);
  const cand = ((d && d.tasks) || []).filter(
    (t) => isDict(t) && !t.pass && String(t.min || "").trim());
  // Python 的 sort 是稳定的，key 是 `(rank, due or "9999", id)` 三元组。
  // JS 这边用"逐字段比较"复刻同一个顺序；稳不稳定无所谓 —— 三元组里 id 是唯一的，
  // 本来就不会出现"两条完全并列"的情况。
  const rank = (t) => (t.due && String(t.due) <= day ? 0 : (t.due ? 1 : 2));
  const cmpStr = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  cand.sort((a, b) =>
    (rank(a) - rank(b))
    || cmpStr(String(a.due || "9999"), String(b.due || "9999"))
    || (getOr(a, "id", 0) - getOr(b, "id", 0)));
  L.push("");
  L.push("他还没做完、而且写了最低限度的任务（**只能从这里挑，id 必须照抄**）：");
  if (cand.length) {
    for (const t of cand.slice(0, 15)) {
      const bits = ["id=" + pyStr(t.id), pyStr(getOr(t, "title", ""))];
      bits.push(t.line || "主线");
      if (t.due) bits.push("截止 " + pyStr(t.due));
      L.push("  - " + bits.join(" | ") + " | 最低限度：" + pyStr(t.min).trim());
    }
  } else {
    L.push("  （一项都没有）");
  }
  const ids = new Set(cand.map((c) => c.id));
  const others = ((d && d.tasks) || []).filter(
    (t) => isDict(t) && !t.pass && !ids.has(t.id));
  if (others.length) {
    L.push("（另外这些他也没做完，但**没写最低限度、放行不了**）："
      + others.slice(0, 15).map((t) => pyStr(getOr(t, "title", ""))).join("、"));
  }

  L.push("");
  L.push("目前最要紧的：" + butlerLine(d, now));

  const st = floorStat(d, now);
  L.push("");
  L.push("【这个月的放行记录】已经放过 " + st.used + " 次。");
  if (st.recent.length) {
    for (const r of st.recent) {
      L.push("  " + r.date + " | " + r.title + " | 理由：" + (r.reason || "（他没写）"));
    }
  } else {
    L.push("  （这个月一次都没放过）");
  }
  L.push("看到同一项最近刚放过、或者同一个理由说过两遍，**直接点破**，别当没看见。");

  L.push("");
  L.push("【最近的对话】");
  for (const m of ((d && d.chat) || []).slice(-CHAT_SEND)) {
    const who = m && m.role === "user" ? "他" : "你";
    L.push("  " + who + "：" + pyStr(getOr(m, "text", "")).slice(0, 400));
  }
  return L.join("\n");
}

/** 把模型给的 ask 过一遍筛子。**任何一条不过就丢掉** —— 静默丢掉，
 *  保留它说的话，绝不让整轮对话因为它报了个坏 id 就 500。
 *
 *  这是整个设计的命门：**最低限度是从任务里抄的，不是模型给的字。**
 *  让模型自己写新标准，就等于给他一个"把标准说服到任意低"的按钮。 */
export function cleanAsk(d, raw, msgId, now = new Date()) {
  let r = raw;
  if (Array.isArray(r)) r = r.length ? r[0] : null;   // 万一它耍懒给了个数组，取第一条
  if (!isDict(r)) return null;
  const tid = pyIntStr(r.task_id);                     // 模型有时给字符串 "3"，find_task 对不上
  if (tid === null) return null;
  let t = null;
  for (const x of ((d && d.tasks) || [])) {
    if (isDict(x) && x.id === tid) { t = x; break; }
  }
  if (t === null || t.pass) return null;
  const m = String(t.min || "").trim();
  if (!m) return null;
  return {
    msg_id: msgId,
    task_id: tid,
    title: getOr(t, "title", ""),
    min: m,                       // 从任务里抄的，不是模型编的
    seen_min: m,                  // 提出时的快照，用来查"这项后来改过没有"
    reason: pyStr(r.reason || "").trim().slice(0, 200),
    at: nowStamp(now),
    status: "pending",            // pending | applied | declined | expired
    decided_at: null,
  };
}


// ================= 点评的底稿 =================

/** 把一段时间压成一段给 AI 看的纯文本。**这条区间里什么记录都没有就返回空字符串**，
 *  调用方（handle_review）靠它决定"值不值得花这次 AI 的钱"。
 *
 *  最重要的一段是最后的【交叉核对】：把"晚睡那几天交了几次"这种对应关系
 *  **先算好再喂给 AI**。指望提示词管住模型不去编相关性是没用的，得把表给它。
 *
 *  ★ 两个"今天"在这一个函数里都出现了，别弄混（app.py:1831 / 1845）：
 *    打印出来的是带 4 点偏移的 today()，而**判断"这一段还没过完"用的是自然日**。
 *    电脑版原样如此 —— 凌晨 3 点时这两者差一天，改了就两端不一样了。
 *
 *  ★ 容错上的分歧：电脑版里 `t["date"]`、`l["date"]` 这种直接下标取值，
 *    遇到脏数据会 KeyError / TypeError 直接 500。这里一律"跳过这条脏记录"，
 *    跟 cleanAsk 那边一个态度：宁可少说一句，也别整页白屏。 */
export function reviewDigest(d, period, key, now = new Date()) {
  const [start, end] = periodRange(period, key);
  const rng = [start, end];

  // 提交按天归拢：{ "2026-10-14": [[任务, 提交], ...] }。顺序 = 任务顺序 × 提交顺序
  const subsByDay = {};
  for (const t of ((d && d.tasks) || [])) {
    if (!isDict(t)) continue;
    for (const s of ((t.submissions) || [])) {
      if (!isDict(s) || !inRange(s.date, rng)) continue;
      const k = String(s.date);
      if (!subsByDay[k]) subsByDay[k] = [];
      subsByDay[k].push([t, s]);
    }
  }

  const sh = sleepHabit(d);
  const sleepRows = ((sh && sh.logs) || [])
    .filter((l) => isDict(l) && inRange(l.date, rng) && !!l.bed);
  const cmpStr = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  sleepRows.sort((a, b) => cmpStr(String(a.date), String(b.date)));   // Python 的 sort 是稳定的

  const ch = screenHabit(d);
  const screenRows = ((ch && ch.logs) || [])
    .filter((l) => isDict(l) && inRange(l.date, rng) && l.min !== undefined && l.min !== null);
  screenRows.sort((a, b) => cmpStr(String(a.date), String(b.date)));

  if (!Object.keys(subsByDay).length && !sleepRows.length && !screenRows.length) return "";

  const L = ["统计区间：" + start + " 到 " + end];
  if (start <= natToday(now) && natToday(now) <= end) {
    L.push("（这一段还没过完，只统计到今天 " + today(now) + "）");
  }
  L.push("");

  // ---- 任务 ----
  L.push("【任务】");
  if (Object.keys(subsByDay).length) {
    for (const day of Object.keys(subsByDay).sort()) {
      for (const [t, s] of subsByDay[day]) {
        const sc = s.total;
        const mark = { red: "，没掌握", amber: "，一般" }[s.grade || ""] || "";
        // 用 pyStr 而不是 String：Python 的 "{}".format(None) 印的是 "None"。
        // （下面这几处凡是往字符串里塞值的，都是这个道理，不再逐条注释。）
        L.push("  " + day + " " + pyStr(getOr(t, "title", "")) + " —— "
          + (sc !== undefined && sc !== null ? "总分 " + pyStr(sc) : "交了")
          + "，" + (s.pass ? "打勾了" : "没打勾") + mark);
      }
    }
  } else {
    L.push("  这期间一次都没交。");
  }
  const undone = ((d && d.tasks) || [])
    .filter((t) => isDict(t) && t.line === "主线" && !t.pass)
    .map((t) => getOr(t, "title", ""));
  if (undone.length) L.push("  还没过的主线：" + undone.join("、"));
  L.push("");

  // ---- 作息 ----
  L.push("【睡眠】记了 " + sleepRows.length + " 天");
  for (const l of sleepRows) {
    const lbl = { ok: "算早", mid: "偏晚", bad: "很晚" }[sleepStatus(l.bed)] || "";
    L.push("  " + pyStr(l.date) + " " + pyStr(l.bed) + " 睡 / " + pyStr(l.wake) + " 起，"
      + pyStr(l.hours) + " 小时（" + lbl + "）");
  }
  if (sleepRows.length) {
    const beds = median(sleepRows.filter((l) => l.bed).map((l) => bedScale(l.bed)));
    const hs = sleepRows.filter((l) => l.hours !== undefined && l.hours !== null)
      .map((l) => l.hours);
    if (hs.length) {
      // fmt1 = 先 pyRound(x,1) 再补足一位小数，正好等于 Python 的 "{:.1f}"
      L.push("  平均 " + fmt1(hs.reduce((a, b) => a + b, 0) / hs.length) + " 小时");
    }
    if (beds !== null) L.push("  平均入睡 " + scaleToHhmm(beds));
  }
  L.push("");

  L.push("【碎片化娱乐】记了 " + screenRows.length + " 天");
  for (const l of screenRows) L.push("  " + pyStr(l.date) + " " + minsText(l.min));
  if (screenRows.length) {
    const ms = screenRows.map((l) => l.min);
    const avgMin = pyInt(ms.reduce((a, b) => a + b, 0) / ms.length);   // Python 的 int()：向零截断
    L.push("  平均 " + minsText(avgMin) + "、最多 " + minsText(Math.max.apply(null, ms)));
  }
  L.push("");

  // ---- 交叉核对（防 AI 编故事的关键）----
  L.push("【交叉核对】下面是已经算好的对应关系，**直接引用**：");
  if (sleepRows.length) {
    const late = sleepRows.filter(
      (l) => bedScale(l.bed) !== null && bedScale(l.bed) >= AMBER_BEFORE);
    const early = sleepRows.filter(
      (l) => bedScale(l.bed) !== null && bedScale(l.bed) < GREEN_BEFORE);
    const cnt = (rows) => rows.reduce(
      (n, l) => n + ((subsByDay[String(l.date)] || []).length), 0);
    L.push("  晚睡（00:30 后）" + late.length + " 天：提交 " + cnt(late) + " 次");
    L.push("  早睡（23:00 前）" + early.length + " 天：提交 " + cnt(early) + " 次");
  }
  if (screenRows.length) {
    const med = median(screenRows.map((l) => l.min));
    const many = med === null ? [] : screenRows.filter((l) => l.min > med);
    const few = med === null ? [] : screenRows.filter((l) => l.min <= med);
    const cnt = (rows) => rows.reduce(
      (n, l) => n + ((subsByDay[String(l.date)] || []).length), 0);
    L.push("  刷得多（超过中位数 " + (med === null ? "?" : minsText(pyInt(med))) + "）"
      + many.length + " 天：提交 " + cnt(many) + " 次");
    L.push("  刷得少 " + few.length + " 天：提交 " + cnt(few) + " 次");
  }
  L.push("  （某一边不足 2 天时，**不要**拿它下结论。）");

  // ---- 下层的点评（只当参考，数字以上面为准）----
  // ★ 遍历顺序：Python 的 dict 是按**插入顺序**迭代的，JS 对象的字符串键也是插入顺序。
  //   唯一的例外是"看起来像整数"的键（比如年份键 "2026"）会被 JS 提到最前面 ——
  //   但那些键只在 period="year"（finer="month"）时出现，而那几档恰好会被下面的
  //   `r.period !== finer` 过滤掉，所以活下来的键的相对顺序仍然一致。
  const finer = { week: "day", month: "week", year: "month" }[period];
  if (finer) {
    L.push("");
    L.push("【下层的点评】以下是 AI 之前写的，**仅供参考，事实以上面的数字为准**：");
    let got = false;
    for (const k of Object.keys((d && d.reviews) || {})) {
      const r = d.reviews[k];
      if (!isDict(r) || r.period !== finer) continue;
      let f0, f1;
      try { [f0, f1] = periodRange(finer, k); } catch (e) { continue; }   // 坏的 key 跳过
      if (f1 < start || f0 > end) continue;                              // 跟这一段不相干
      got = true;
      L.push("  [" + k + "]（" + pyStr(getOr(r, "at", "")).slice(0, 16) + "生成）"
        + pyStr(getOr(r, "text", "")));
    }
    if (!got) L.push("  （这一段的下层点评一条都还没生成，只有上面的原始数字。）");
  }

  return L.join("\n");
}
