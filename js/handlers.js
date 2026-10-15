// 接口实现层：对应电脑版 app.py 里那一批 handle_* 函数。
//
// 约定（跟 Python 那边完全一致）：
//   · 收一个对象 p，返回一个对象。
//   · 出错就 throw new Error("中文说明")。调用点现有的 catch 会把 message 显示出来，
//     所以**不要**返回 {error: ...} —— 那会被当成正常结果。
//
// ★ 依赖注入 ★ makeHandlers({store, ai, clock}) 是为了让 tools/ 里的测试能塞进
//   内存版 store、假的 AI 和冻结的时钟，在 node 里把接口逻辑也跑起来对拍。
//
// ★ 每条接口的规矩：load() 拿一份**新拷贝**，改完 save()。绝不拿着旧快照在手里
//   跨过 await 再写回去 —— 那样中途别人写的东西会被悄悄盖掉（reflect 那边尤其要命）。

import {
  publicTask, publicHabit, progress, streak, habitStreak, butlerLine, recent,
  calendarDays, periodKey, today, natToday, dayScore, dayBrief,
  floorStat, nowStamp, fmt1,
  findTask, findHabit, normSteps, normLine, normDue, normEventKind, minutesFrom,
  putLog, hhmmToMin, sleepHours, calibrateSleep, calibrateScreen,
  gradeOf, WORK_MAX, TEST_MAX, OVER_MAX, WORK_FLOOR, REFLECT_MAX,
  REFLECT_INPUT_MAX, pyIntStr, pyStr, getOr, periodRange, reviewDigest,
  dayShift, expireAsks, chatTrim, chatContext, cleanAsk,
  CHAT_INPUT_MAX, CHAT_DAILY,
} from "./logic.js";

/** 把 `_now_iso()` 那种 "2026-10-14T12:00:00" 按**本地时间**解析成 Date。
 *  看不懂就返回 null（Python 那边 fromisoformat 会抛，调用点一律兜成 999 秒）。
 *  ★ 别图省事写 `new Date(s)` 了事：这里要的是"只认这一种格式，其余算看不懂"。 */
function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?/.exec(String(s || ""));
  if (!m) return null;
  const ms = m[7] ? Math.floor(Number("0." + m[7]) * 1000) : 0;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, ms);
  return isNaN(d.getTime()) ? null : d;
}

export function makeHandlers({ store, ai, clock = () => new Date() }) {
  const now = () => clock();
  const H = {};

  /** 拿一份新拷贝（Python 那边 load_data() 每次也是重新读文件）。 */
  async function load() { return await store.loadOrInit(); }
  async function save(d) { await store.saveState(d); }

  /** 拼提示词用：Python 的 (p.get(k) or "").strip()。 */
  const str = (v) => String(v ?? "").trim();

  // ================= 照片 =================
  /** 逐字对应 save_data_url（app.py:363-377）。
   *
   *  **存不了就返回 null，绝不抛异常** —— 记录本身不能因为存图失败就整条丢掉。
   *  扩展名还是照老规矩：不认 png 的一律当 jpg。 */
  async function saveDataUrl(dataUrl, stem) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
    try {
      const at = dataUrl.indexOf(",");
      if (at === -1) return null;
      const head = dataUrl.slice(0, at);
      const b64 = dataUrl.slice(at + 1);
      const ext = head.includes("png") ? ".png" : ".jpg";
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mime = (head.match(/^data:([^;,]+)/) || [])[1] || "image/jpeg";
      const name = stem + ext;
      await store.putPhoto(name, new Blob([bytes], { type: mime }));
      return name;
    } catch (e) {
      return null;
    }
  }

  /** 打分/时长这类"给个范围夹一下"的整数解析。看不懂返回 null（Python 那边是 except → None）。 */
  function clampInt(v, lo, hi) {
    const n = pyIntStr(v);
    if (n === null) return null;
    return Math.max(lo, Math.min(hi, n));
  }

  // ================= /api/state =================
  // 电脑版 app.py:2360-2392 的逐字对应。
  H.state = async () => {
    const d = await load();
    const key = await store.getKey();
    const asks = ((d.asks || [])).filter((a) => a && typeof a === "object");
    return {
      goal: d.goal ?? "",
      need_setup: !(d.tasks && d.tasks.length),
      tasks: (d.tasks || []).map((t) => publicTask(t, now())),
      habits: (d.habits || []).map((h) => publicHabit(h, 14, now())),
      progress: progress(d),
      streak: streak(d, now()),
      habit_streak: habitStreak(d, null, now()),
      butler: butlerLine(d, now()),
      recent: recent(d),
      events: d.events || [],
      days: calendarDays(d, 400, now()),      // 只回过去、只回有内容的那几天
      reviews: d.reviews || {},
      // 各粒度的当前 key 由「后端」算好给界面 —— ISO 周那套算术只写一遍，
      // 绝不让界面自己再推一次（2027-01-01 属于 2026-W53，最容易写错）。
      //
      // ★ 注意 periods 用的是**自然日**（Python 那边 period_key 的默认值是
      //   datetime.date.today()），而上面那个 "today" 用的是带 4 点偏移的 today()。
      //   凌晨 3 点打开时这两个会差一天 —— 电脑版原样如此，别顺手"修"掉，
      //   否则两端同一天算出来的东西就不一样了。
      periods: {
        day: periodKey("day", natToday(now())), week: periodKey("week", natToday(now())),
        month: periodKey("month", natToday(now())), year: periodKey("year", natToday(now())),
      },
      // 教练对话只回最近 50 条（再多界面也不需要）。
      // asks 要**全部 pending**（哪怕它很老）+ 最近 10 条已决 ——
      // 只按条数截的话，会出现"看得见但点不动"或者"点得动但看不见"。
      chat: (d.chat || []).slice(-50),
      asks: asks.filter((a) => a.status === "pending")
        .concat(asks.filter((a) => a.status !== "pending").slice(-10)),
      floor: floorStat(d, now()),
      day_score: dayScore(d, null, now()),
      reflection: ((d.reflections || {})[today(now())]) || { text: "", bonus: 0 },
      ai_ready: !!key,
      today: today(now()),
    };
  };

  // ================= /api/key =================
  // 逐字对应 handle_set_key（app.py:772-785），连报错文案都照抄 ——
  // 这样界面上现成的密钥表单和「AI 没配好」横幅一个字都不用改。
  H.setKey = async (p) => {
    const raw = (p && p.key) || "";
    const key = String(raw).trim().replace(/^["']+|["']+$/g, "");
    if (!key) throw new Error("还没填东西");
    if (key.includes(" ") || key.includes("\t")) {
      throw new Error("里面好像有空格，检查一下是不是只复制了那一串");
    }
    if (!key.startsWith("sk-")) {
      throw new Error("这看起来不像 DeepSeek 的密钥（应该以 sk- 开头）");
    }
    await store.setKey(key);
    return { ok: true, ai_ready: !!(await store.getKey()) };
  };

  // ================= /api/plan =================
  // 逐字对应 handle_plan（app.py:786-828）。**不落盘**，先给他看。
  H.plan = async (p) => {
    const goal = str(p.goal), situation = str(p.situation), timePerDay = str(p.time);
    if (!goal) throw new Error("先说说你的目标");
    const prompt =
      "学生的情况：\n" +
      "目标：" + goal + "\n" +
      "现状：" + (situation || "（没说）") + "\n" +
      "每天能投入的时间：" + (timePerDay || "（没说）") + "\n\n" +
      "请给他列一张任务清单，5-8 项，按重要性从高到低排。\n" +
      "硬性要求：\n" +
      "1. 每一项必须是具体、可检验的动作，不能是'努力学习''认真复习'这种空话\n" +
      "2. 每一项都要给出'最低限度'——他状态最差的那天也能勉强完成的那一版\n" +
      "3. 只列直接服务于目标的，砍掉一切锦上添花的东西\n" +
      "4. 从第一步开始，不要一上来就宏大\n" +
      "5. 给每一项标一个'类别'。类别必须少而统一：一共 2-4 个类别，" +
      "所有任务共用这同一套类别，不许每项一个新类别。" +
      "类别名要短（2-6 个字），比如「心理学基础」「专业课」「英语」「科研」。\n" +
      "6. 每一项必须给 steps：2-4 条可以照着动手的步骤。\n" +
      "   **第一条必须是 15 分钟之内就能开始的**，不许写'先准备资料''先制定计划'" +
      "这种听起来对但今天动不了手的话。\n" +
      "   反例（不许这样写）：'通读教材第一遍'。\n" +
      "   正例：'翻到目录，把完全没听过的概念圈出来（10 分钟）'。\n" +
      "7. 每一项给一个 line：'主线' 或 '支线'。\n" +
      "   主线 = 直接服务长期目标、要持续做下去的（大部分应该是主线）。\n" +
      "   支线 = 有明确截止日期的一次性任务。给支线时**必须**同时给 due（YYYY-MM-DD）。\n" +
      "只返回 JSON：\n" +
      "{\"goal\":\"用一句话把他的目标说清楚\",\"tasks\":[" +
      "{\"title\":\"任务名\",\"min\":\"最低限度\",\"why\":\"一句话，为什么这项对他重要\"," +
      "\"cat\":\"类别名\",\"line\":\"主线或支线\",\"due\":\"YYYY-MM-DD或null\"," +
      "\"steps\":[\"第一步\",\"第二步\"]}]}";
    const obj = await ai.askAi([
      { role: "system", content: ai.COACH },
      { role: "user", content: prompt },
    ]);
    const tasks = (obj && obj.tasks) || [];
    if (!tasks.length) throw new Error("AI 没给出任务清单");
    return { goal: obj.goal ?? goal, tasks: tasks };
  };

  // ================= /api/plan/save =================
  H.planSave = async (p) => {
    const d = await load();
    const goal = str(p.goal);
    const tasks = p.tasks || [];
    if (!tasks.length) throw new Error("清单是空的");
    // 重排计划时，旧任务的提交记录按标题尽量保留（**只认标题完全一样的**）
    const keep = {};
    for (const t of (d.tasks || [])) {
      if (t && t.submissions && t.submissions.length) {
        const k = t.title ?? "";
        if (!(k in keep)) keep[k] = t;
      }
    }
    let nid = pyIntStr(d.next_id) ?? 1;
    const usedIds = new Set();
    const out = [];
    for (const t of tasks) {
      const title = str(t.title);
      if (!title) continue;
      const due = normDue(t.due);
      const old = keep[title];
      const row = {
        line: normLine(t.line, due),
        title: title,
        min: str(t.min),
        why: str(t.why),
        cat: str(t.cat) || "未分类",
        due: due,
        steps: normSteps(t.steps),
        source: (str(t.source) || "教练"),
        pass: false,
        passed_date: null,
        submissions: [],
      };
      if (old && !usedIds.has(old.id)) {
        // 标题没变 → 把他以前的记录接上，别凭空清空
        row.id = old.id;
        row.pass = old.pass ?? false;
        row.passed_date = old.passed_date ?? null;
        row.submissions = old.submissions ?? [];
        if (old.steps) {
          for (let i = 0; i < old.steps.length; i++) {
            if (i < row.steps.length) row.steps[i].done = old.steps[i].done ?? false;
          }
        }
      } else {
        row.id = nid;
        nid += 1;
      }
      usedIds.add(row.id);
      out.push(row);
    }
    d.goal = goal;
    d.tasks = out;
    d.next_id = nid;
    if (!d.created) d.created = today(now());     // 只在第一次设，别把老用户的历史起点冲掉
    await save(d);
    return { ok: true };
  };

  // ================= /api/task/add =================
  H.taskAdd = async (p) => {
    const d = await load();
    const title = str(p.title);
    if (!title) throw new Error("任务名不能空");
    const due = normDue(p.due);
    const nid = pyIntStr(d.next_id) ?? 1;
    if (!d.tasks) d.tasks = [];
    d.tasks.push({
      id: nid,
      line: normLine(p.line, due),
      title: title,
      min: str(p.min),
      why: str(p.why),
      cat: str(p.cat) || (due ? "作业" : "未分类"),
      due: due,
      steps: normSteps(p.steps),
      source: (str(p.source) || "我自己"),
      pass: false, passed_date: null, submissions: [],
    });
    d.next_id = nid + 1;
    await save(d);
    return { ok: true, id: nid };      // 界面拿到 id 才能接着问教练"怎么塞进去"
  };

  // ================= /api/task/update =================
  H.taskUpdate = async (p) => {
    const d = await load();
    const t = findTask(d, p.id);
    for (const key of ["title", "min", "why", "cat", "source"]) {
      if (key in p) t[key] = str(p[key]);
    }
    if ("due" in p) t.due = normDue(p.due);
    if ("line" in p) t.line = normLine(p.line, t.due);
    if ("steps" in p) {
      const old = {};
      for (const s of (t.steps || [])) old[s.t] = s.done ?? false;
      t.steps = normSteps(p.steps);
      for (const s of t.steps) {          // 文字没变的步骤，勾保留
        if (s.t in old) s.done = old[s.t];
      }
    }
    if (!t.title) throw new Error("任务名不能空");
    await save(d);
    return { ok: true };
  };

  // ================= /api/step/toggle =================
  H.stepToggle = async (p) => {
    const d = await load();
    const t = findTask(d, p.id);
    const i = pyIntStr(p.index);
    if (i === null) throw new Error("步骤序号不对");
    const steps = t.steps || [];
    if (!(i >= 0 && i < steps.length)) throw new Error("没有这一步");
    steps[i].done = !!(p.done);
    await save(d);
    return { ok: true, steps: steps };
  };

  // ================= /api/task/steps =================
  H.planSteps = async (p) => {
    const d = await load();
    const t = findTask(d, p.id);
    const prompt =
      "学生这一项任务是：" + (t.title ?? "") + "\n" +
      "这项的最低限度是：" + (t.min || "（没写）") + "\n" +
      "他给自己定的目标：" + ((d.goal ?? "") || "（没写）") + "\n\n" +
      "请把这一项拆成 2-4 条**可以照着动手**的步骤。\n" +
      "硬性要求：\n" +
      "- 第一条必须是 15 分钟之内就能开始的，" +
      "不许写'先准备资料''先制定计划'这种听起来对但今天动不了手的话\n" +
      "- 反例（不许这样写）：'通读教材第一遍'\n" +
      "- 正例：'翻到目录，把完全没听过的概念圈出来（10 分钟）'\n" +
      "- 每一步都要小到不用下决心就能开始\n" +
      "只返回 JSON：{\"steps\":[\"第一步\",\"第二步\"]}";
    const obj = await ai.askAi([
      { role: "system", content: ai.COACH },
      { role: "user", content: prompt },
    ]);
    const steps = normSteps(obj && obj.steps);
    if (!steps.length) throw new Error("教练没给出步骤，再试一次");
    t.steps = steps;
    await save(d);
    return { ok: true, steps: steps };
  };

  // ================= /api/task/delete =================
  H.taskDelete = async (p) => {
    const d = await load();
    d.tasks = (d.tasks || []).filter((t) => t.id !== p.id);
    await save(d);
    return { ok: true };
  };

  // ================= /api/habit/log =================
  /** 记一次习惯。同一天重复记 = 覆盖，不会变成两条。 */
  H.habitLog = async (p) => {
    const d = await load();
    const h = findHabit(d, p.id);
    const kind = h.kind;
    const ts = today(now());
    const stem = ts + "_习惯" + h.id;

    // ---- 睡眠：记睡点/醒点，顺带可以交一张手表截图 ----
    if (kind === "sleep") {
      const bed = str(p.bed), wake = str(p.wake);
      if (hhmmToMin(bed) === null || hhmmToMin(wake) === null) {
        throw new Error("睡觉时间和起床时间都得填上");
      }
      const hours = sleepHours(bed, wake);
      if (hours === null || hours <= 0 || hours > 16) {
        throw new Error("这个时间看着不对（算出来睡了 " + fmt1(hours || 0) + " 小时），检查一下");
      }
      const entry = { date: ts, bed: bed, wake: wake, hours: hours, note: str(p.note) };
      if (p.photo) entry.shot = await saveDataUrl(p.photo, stem);
      putLog(h, entry);
      calibrateSleep(d, now());
      await save(d);
      return { ok: true, habit: publicHabit(h, 14, now()), habit_streak: habitStreak(d, null, now()) };
    }

    // ---- 坏习惯（碎片化娱乐）：记今天刷了多少分钟 ----
    // **这个分支必须写在下面那个兜底前面**，否则会被兜底当成"今天做了没有"，
    // 分钟数整条丢掉（而且是静默丢，最难查）。
    if (kind === "screen") {
      const mins = minutesFrom(p);
      if (mins === null) throw new Error("填一下今天刷了多久（小时 + 分钟，可以是 0）");
      const entry = { date: ts, min: mins, note: str(p.note) };
      if (p.photo) entry.shot = await saveDataUrl(p.photo, stem);
      putLog(h, entry);
      calibrateScreen(h, now());
      await save(d);
      return { ok: true, habit: publicHabit(h, 14, now()), habit_streak: habitStreak(d, null, now()) };
    }

    // ---- 兜底：只记"今天做了没有" ----
    putLog(h, { date: ts, done: p.done === undefined ? true : !!(p.done) });
    await save(d);
    return { ok: true, habit: publicHabit(h, 14, now()), habit_streak: habitStreak(d, null, now()) };
  };

  // ================= /api/habit/add | update | delete =================
  H.habitAdd = async (p) => {
    const d = await load();
    const name = str(p.name);
    if (!name) throw new Error("习惯名不能空");
    const nid = pyIntStr(d.next_habit_id) ?? 1;
    if (!d.habits) d.habits = [];
    d.habits.push({
      id: nid, name: name,
      kind: str(p.kind) || "custom",
      unit: str(p.unit),
      target: str(p.target),
      logs: [], goal: null,
    });
    d.next_habit_id = nid + 1;
    await save(d);
    return { ok: true };
  };

  H.habitUpdate = async (p) => {
    const d = await load();
    const h = findHabit(d, p.id);
    for (const k of ["name", "target", "unit"]) {
      if (k in p) h[k] = str(p[k]);
    }
    if (!h.name) throw new Error("习惯名不能空");
    await save(d);
    return { ok: true };
  };

  H.habitDelete = async (p) => {
    const d = await load();
    const h = findHabit(d, p.id);
    if (h.kind === "sleep" && !p.force) {
      throw new Error("睡眠是最主要的那一个，不给删。");
    }
    d.habits = (d.habits || []).filter((x) => x.id !== p.id);
    await save(d);
    return { ok: true };
  };

  // ================= /api/event/add | delete =================
  H.eventAdd = async (p) => {
    const d = await load();
    const date = normDue(p.date);
    const title = str(p.title);
    if (!date) throw new Error("先选个日期");
    if (!title) throw new Error("写一下这天是什么事");
    const nid = pyIntStr(d.next_event_id) ?? 1;
    if (!d.events) d.events = [];
    d.events.push({
      id: nid, date: date, title: title,
      kind: normEventKind(p.kind),
    });
    d.next_event_id = nid + 1;
    await save(d);
    return { ok: true, id: nid };
  };

  H.eventDelete = async (p) => {
    const d = await load();
    d.events = (d.events || []).filter((e) => e.id !== p.id);
    await save(d);
    return { ok: true };
  };

  // ================= /api/quiz =================
  /** 给这一项出一份考核：检验题 + 让他讲讲理解。题量由 AI 视情况定。 */
  H.quiz = async (p) => {
    const title = str(p.title), minimum = str(p.min), done = str(p.done);
    if (!done) throw new Error("先说说你具体做了什么");
    const prompt =
      "学生这一项任务是：" + title + "\n" +
      "这项的最低限度是：" + (minimum || "（没写）") + "\n" +
      "他声称他做了：" + done + "\n\n" +
      "请给他出一份考核，检验他是不是真的做了、真的懂了。\n" +
      "题量你自己判断：他说的内容少就出 2 道，内容多、分量重可以出到 5 道。" +
      "不要凑数，也不要放水。\n" +
      "每道题标明类型：\n" +
      "- \"ask\"：有明确答案的检验题，用来区分'真读了'和'糊弄'\n" +
      "- \"talk\"：让他用自己的话讲理解的开放题，" +
      "例如'用你自己的话说说 X 是怎么回事''你觉得作者为什么要强调 Y''这个地方你怎么看'\n" +
      "至少要有一道 \"talk\"。只考他声称完成的那部分，不要超纲。\n" +
      "只返回 JSON：\n" +
      "{\"items\":[{\"kind\":\"ask\",\"text\":\"题目\"}," +
      "{\"kind\":\"talk\",\"text\":\"题目\"}}]}";
    const obj = await ai.askAi([
      { role: "system", content: ai.COACH },
      { role: "user", content: prompt },
    ]);
    const items = [];
    for (const it of ((obj && obj.items) || [])) {
      if (typeof it === "string") {              // 兜底：万一它返回字符串
        items.push({ kind: "ask", text: it });
      } else if (it && it.text) {
        const kind = String(it.kind ?? "").toLowerCase() === "talk" ? "talk" : "ask";
        items.push({ kind: kind, text: it.text });
      }
    }
    if (!items.length) throw new Error("AI 没给出考核内容");
    return { items: items };
  };

  // ================= /api/grade =================
  /** 判分：两半边各 50 分 + 超额附加，并给一段像人说的话。
   *
   *  **打勾看的是 work（完成），跟 test 好坏无关。** 测试不好只是标红/标黄，
   *  后面几天的表里带上它复习 —— 这是他自己定的：做完是一件，学会是另一件。 */
  H.grade = async (p) => {
    const title = str(p.title), minimum = str(p.min), done = str(p.done);
    const qa = p.qa || [];
    const lines = qa.map((item, idx) => {
      const kind = (item && item.kind === "talk") ? "讲讲理解" : "检验题";
      return "第" + (idx + 1) + "题（" + kind + "）：" + ((item && item.q) ?? "") +
        "\n他的回答：" + (str(item && item.a) || "（空着没答）");
    });
    const prompt =
      "这一项任务：" + title + "\n" +
      "最低限度：" + (minimum || "（没写）") + "\n" +
      "他声称做了：" + done + "\n\n" +
      "考核和他的回答：\n" + lines.join("\n\n") + "\n\n" +
      "请给两个 0-50 的整数，再加一个 0-10 的附加分：\n\n" +
      "1. work —— 【拍照 + 完成】他真的做了这件事吗？做了多少？\n" +
      "   敷衍、编造、明显没做 → 0-20\n" +
      "   做了，但没到最低限度 → 21-34\n" +
      "   **正好做到他写的那个最低限度 → 35**\n" +
      "   超出最低限度 → 35-50，按超出去多少给\n\n" +
      "2. test —— 【测试】他的回答说明他真的理解了吗？\n" +
      "   空洞、含糊、答非所问、只背名词讲不出意思、空着没答 → 0-19\n" +
      "   一知半解 → 20-34\n" +
      "   **达到最低限度要求的理解 → 35**\n" +
      "   答得好、讲得清楚 → 35-50\n\n" +
      "3. over —— 【超额附加】在总分上面另加，最多 10。\n" +
      "   **只有在真的超过最低限度时才有**（比如最低限度是每天 30 个，他做了 50 个）→ " +
      "按超出的程度给 5-10。没超出 → 0。这不是凑高分的零头。\n\n" +
      "另外写两段话：\n" +
      "- reason：一句话，说清这一项做得怎么样。\n" +
      "- coach：一段像人说的话，2-4 句，直接冲着他写的回答说——" +
      "他哪里是真懂了，哪里含糊、哪里说错了，下次要注意什么。" +
      "要具体，引用他说的原话。不讲客套，不鼓励，不说'加油'。\n\n" +
      "只返回 JSON：\n" +
      "{\"work\":0-50,\"test\":0-50,\"over\":0-10," +
      "\"reason\":\"...\",\"coach\":\"...\"}";
    const obj = await ai.askAi([
      { role: "system", content: ai.COACH + "你不被糊弄，但也不刁难：做到最低限度就算做到。" },
      { role: "user", content: prompt },
    ]);

    const work = clampInt(obj && obj.work, 0, WORK_MAX);
    const test = clampInt(obj && obj.test, 0, TEST_MAX);
    let over = clampInt(obj && obj.over, 0, OVER_MAX);
    if (work === null || test === null) throw new Error("教练这次没给出分来，再交一次");
    over = over || 0;                       // 附加分读不出来就当没有
    const total = work + test + over;

    // **打勾由后端算，不听模型的**：做到最低限度就算完成。
    const passed = work >= WORK_FLOOR;
    return {
      pass: passed,
      work: work, test: test, over: over, total: total,
      grade: gradeOf(test),                 // '' / 'amber' / 'red'
      reason: (obj && obj.reason) ?? "",
      coach: (obj && obj.coach) ?? "",
    };
  };

  // ================= /api/submit =================
  /** 记录这次提交，通过就把这一项打勾。 */
  H.submit = async (p) => {
    const d = await load();
    const t = findTask(d, p.id);
    const ts = today(now());

    const photo = p.photo;
    if (!(photo && photo.startsWith("data:"))) {
      throw new Error("没交照片 —— 这一项必须拍照才算");
    }
    // 「必须拍照」这条规矩只属于交作业，别跟着 saveDataUrl 一起抽走
    const photoName = await saveDataUrl(photo, ts + "_任务" + t.id);

    const work = clampInt(p.work, 0, WORK_MAX);
    const test = clampInt(p.test, 0, TEST_MAX);
    if (work === null || test === null) throw new Error("这一项还没判分，先让教练考一遍再交");
    const over = clampInt(p.over, 0, OVER_MAX) || 0;
    const total = work + test + over;

    // **打勾由后端算** —— 做到最低限度就算完成。不听客户端，也不听模型的 pass。
    const passed = work >= WORK_FLOOR;

    if (!t.submissions) t.submissions = [];
    t.submissions.push({
      date: ts,
      done: p.done ?? "",
      pass: passed,
      work: work,                           // 拍照 + 完成，0-50
      test: test,                           // 测试，0-50
      over: over,                           // 超额附加，0-10
      total: total,                         // 总分，0-110
      grade: gradeOf(test),                 // 掌握标记：'' / 'amber' / 'red'
      reason: p.reason ?? "",
      coach: p.coach ?? "",
      photo: photoName,
    });
    if (passed && !t.pass) {
      t.pass = true;
      t.passed_date = ts;
    }
    await save(d);
    return { ok: true, pass: passed, streak: streak(d, now()), progress: progress(d) };
  };

  // ================= /api/reflect =================
  /** 存今天的自我反思，并让教练给 0-5 的附加分。
   *
   *  ★ 两段写（跟教练对话一个规矩）★
   *  先把他的话落盘，中间**不持任何快照**，调完 AI 重新 load 再写分。
   *  AI 掉线了，他写的这段话也不能丢 —— 这是这个 App 最不能违的一条。 */
  H.reflect = async (p) => {
    const d1 = await load();
    const text = str(p.text);
    if (text.length > REFLECT_INPUT_MAX) {
      throw new Error("反思太长了，" + REFLECT_INPUT_MAX + " 字以内");
    }

    const day = today(now());
    if (!d1.reflections) d1.reflections = {};
    d1.reflections[day] = { text: text, bonus: 0, at: nowStamp(now()) };
    await save(d1);                                   // ① 先落盘

    if (!text) return { ok: true, bonus: 0, word: "" };   // 清空 = 今天不写，附加分归零

    const brief = dayBrief(d1, day, now());
    const obj = await ai.askAi([                       // ② 这时候才去调 AI（可能抛）
      { role: "system", content: ai.REFLECT_SYS },
      { role: "user", content: "今天的情况：\n" + brief + "\n\n他写的自我反思：\n" + text },
    ]);
    const b = pyIntStr(obj && obj.bonus);
    const bonus = (b === null) ? 0 : Math.max(0, Math.min(REFLECT_MAX, b));

    const d2 = await load();                           // ③ 重新读，不用旧快照盖回去
    if (!d2.reflections) d2.reflections = {};
    const slot = d2.reflections[day] || (d2.reflections[day] = {});
    slot.text = text;
    slot.bonus = bonus;
    await save(d2);
    return { ok: true, bonus: bonus, word: (obj && obj.word) ?? "" };
  };

  // ================= /api/chat/say =================
  // 逐字对应 handle_chat_say（app.py:2166-2236）。**两段写，中间必须放手。**
  //
  // 跟 /api/reflect 的"先 AI 再落盘"**顺序正好相反**：他说的那句话要**先落盘**，
  // 因为不能因为 AI 掉线就把它弄丢。而 AI 思考的那几十秒里我们**不持有任何快照**，
  // 所以照样不会盖掉别人的写入（这也是为什么第 2 段开头要重新 load 一次）。
  H.chatSay = async (p) => {
    const text = str(p && p.text);
    if (!text) throw new Error("说点什么");
    if (text.length > CHAT_INPUT_MAX) {
      throw new Error("太长了（最多 " + CHAT_INPUT_MAX + " 字），说重点");
    }

    // ---------- 第 1 段：快，不花钱 ----------
    // 注：电脑版这里还有一道 `if _CORRUPT` 的闸（data.json 读坏了就先别花钱调 AI）。
    //     手机版没有"文件读坏"这回事 —— IndexedDB 要么读得出来、要么直接抛，
    //     所以那道闸在这儿没有对应的东西，不用搬。
    const d1 = await load();
    const chat = d1.chat || (d1.chat = []);

    // 同一条还没被回复时不许连着发（也顺手挡住双击）
    const tail = chat.length ? chat[chat.length - 1] : null;
    if (tail && tail.role === "user" && !tail.failed) {
      const at = parseStamp(tail.at);
      const gap = at === null ? 999 : (now().getTime() - at.getTime()) / 1000;
      if (gap < 180) throw new Error("教练还在想你上一条，等它回完再说");
    }
    const day = today(now());
    const nToday = chat.filter(
      (m) => m && m.role === "user" && String(m.at ?? "").slice(0, 10) === day).length;
    if (nToday >= CHAT_DAILY) {
      throw new Error("今天先聊到这（一天最多 " + CHAT_DAILY + " 句，主要是不想烧你的余额）");
    }

    expireAsks(d1, now());
    const nid = pyIntStr(d1.next_chat_id) ?? 1;
    chat.push({ id: nid, role: "user", text: text, at: nowStamp(now()), failed: false });
    d1.next_chat_id = nid + 1;
    chatTrim(d1);
    await save(d1);
    const ctx = chatContext(d1, now());       // 拿刚存下的这份拼上下文

    // ---------- 第 2 段：慢。这一段**不持有上面那个 d1** ----------
    const markFailed = async (why) => {
      const d2 = await load();
      for (const m of (d2.chat || [])) {
        if (m && m.id === nid) m.failed = true;   // 锁会忽略 failed 的消息，所以他可以重发
      }
      await save(d2);
      throw new Error(why);
    };

    let obj = null;
    try {
      obj = await ai.askAi(
        [{ role: "system", content: ai.COACH_CHAT },
         { role: "user", content: ctx + "\n\n他刚说：" + text }],
        { temperature: 0.4, maxTokens: 900 });
    } catch (e) {
      let msg = String((e && e.message) || e);
      if (msg.includes("看不懂")) msg = "教练这次没接上话，再发一次试试";
      await markFailed(msg);
    }

    if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};
    const say = String(obj.say || "").trim();
    if (!say) await markFailed("教练这次没说出话，再发一次试试");

    const d2 = await load();                   // 重新读：他刚那句话之后可能有人写了盘
    const cid = pyIntStr(d2.next_chat_id) ?? 1;
    if (!d2.chat) d2.chat = [];
    d2.chat.push({ id: cid, role: "coach", text: say.slice(0, 1500), at: nowStamp(now()) });
    d2.next_chat_id = cid + 1;

    const ask = cleanAsk(d2, obj.ask, cid, now());
    if (ask) {                                 // **一次最多一条** —— 数组也只取第一条
      const aid = pyIntStr(d2.next_ask_id) ?? 1;
      ask.id = aid;
      d2.next_ask_id = aid + 1;
      if (!d2.asks) d2.asks = [];
      d2.asks.push(ask);
    }
    chatTrim(d2);
    await save(d2);
    return { ok: true, ask: ask, floor: floorStat(d2, now()) };
  };

  // ================= /api/chat/apply =================
  /** 他按了「行」。**不花钱** —— 这里绝不调 AI（放行是纯规则，防作弊的地基）。 */
  H.chatApply = async (p) => {
    const d = await load();
    const aid = pyIntStr(p && p.ask_id);
    if (aid === null) throw new Error("这条求情对不上号");
    const asks = d.asks || (d.asks = []);
    const ask = asks.find((a) => a && typeof a === "object" && a.id === aid) || null;
    if (ask === null) throw new Error("找不到这条了，可能已经作废");
    // 双击 / 重复提交必须无害，不是报错
    if (ask.status !== "pending") {
      return { ok: true, already: true, floor: floorStat(d, now()) };
    }

    // 这条不成立 —— 记一笔 declined，然后告诉他为什么
    const drop = async (msg) => {
      ask.status = "declined";
      ask.decided_at = nowStamp(now());
      await save(d);
      throw new Error(msg);
    };

    const t = (d.tasks || []).find(
      (x) => x && typeof x === "object" && x.id === ask.task_id) || null;
    if (t === null) await drop("这一项已经不在了");
    if (t.pass) await drop("这一项你已经过了，不用放行了");
    if (!String(t.min || "").trim()) await drop("这一项没有最低限度，放行不了");
    if (String(t.min || "").trim() !== ask.seen_min) {
      await drop("这一项的最低限度刚被改过，重新问一次教练吧");
    }
    if (t.floor_on === today(now())) await drop("这一项今天已经放行过了");

    const y = dayShift(-1, now());
    if (asks.some((a) => a && typeof a === "object" && a.status === "applied"
        && a.task_id === ask.task_id
        && String(a.decided_at ?? "").slice(0, 10) === y)) {
      await drop("这一项昨天刚放行过。连着两天那就不是急事了 —— 该动的是这一项的计划"
        + "（去清单里把它的最低限度或者步骤重排一下），不是天天放行它。");
    }
    const st = floorStat(d, now());
    if (st.limit && st.used >= st.limit) {
      await drop("这个月已经放行了 " + st.used + " 次，上限是 " + st.limit);
    }

    ask.status = "applied";
    ask.decided_at = nowStamp(now());
    t.floor_on = today(now());     // **只写这一个** —— 绝不写进 t.min，否则明天回不来
    await save(d);
    return { ok: true, task_id: t.id, title: t.title ?? "", floor: floorStat(d, now()) };
  };

  // ================= /api/chat/decline =================
  /** 他按了「今天不用」—— 只是把账记上，什么都不改。 */
  H.chatDecline = async (p) => {
    const d = await load();
    const aid = pyIntStr(p && p.ask_id);
    if (aid === null) throw new Error("这条求情对不上号");
    for (const a of (d.asks || [])) {
      if (a && typeof a === "object" && a.id === aid) {
        if (a.status === "pending") {
          a.status = "declined";
          a.decided_at = nowStamp(now());
          await save(d);
        }
        return { ok: true };
      }
    }
    throw new Error("找不到这条了");
  };

  // ================= 读图（多模态）=================
  /** 把一张截图交给 AI 把数字读出来。读不出来返回 {}。
   *  逐字对应 read_shot（app.py:1493-1512）。
   *
   *  这是"交截图"真正的价值：他不用手打时间，图片自己会说。
   *  **注意 user 的 content 是一个数组**（文字 + 图片），不是字符串 —— 这是
   *  DeepSeek 多模态的写法，别顺手拼成一个字符串，那样图就丢了。 */
  async function readShot(kind, dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      throw new Error("没收到图片");
    }
    const ask = kind === "screen"
      ? ("这是一张手机「屏幕使用时间」的截图。请读出**娱乐类**（抖音、小红书、"
        + "B站、游戏、视频这些）加起来总共多少分钟。"
        + "如果分不出娱乐类，就把总屏幕使用时间读出来，并在 note 里说明你读的是哪一项。"
        + "只返回 JSON：{\"minutes\":整数,\"note\":\"一句话\"}")
      : ("这是一张睡眠记录（手表或手机 App）的截图。请读出**入睡时间**和"
        + "**起床时间**，以及睡了几个小时。时间用 24 小时制的 HH:MM。"
        + "如果图里只有总时长、没有具体钟点，就把 bed 和 wake 留空字符串。"
        + "只返回 JSON：{\"bed\":\"HH:MM\",\"wake\":\"HH:MM\","
        + "\"hours\":数字,\"note\":\"\"}");
    const obj = await ai.askAi([
      { role: "system", content: ai.COACH },
      { role: "user", content: [
        { type: "text", text: ask },
        { type: "image_url", image_url: { url: dataUrl } },
      ] },
    ]);
    // Python 那句 isinstance(obj, dict)：数组不算 —— 模型偶尔会返一个列表。
    return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
  }

  // ================= /api/habit/read =================
  /** 交一张截图，让 AI 把时间/时长读出来。**只读，不落盘** ——
   *  读出来的值填回输入框，他看一眼、确认了，再点保存。 */
  H.habitRead = async (p) => {
    const d = await load();
    const h = findHabit(d, p && p.id);
    const obj = await readShot(h && h.kind, p && p.photo);
    const out = { ok: true, note: str(obj.note) };

    if (h && h.kind === "screen") {
      // ★ 用 pyIntStr 而不是 Number()：Python 那边 int("90分钟") 是 ValueError（→ 让他手填），
      //   Number("90分钟") 会给 NaN、Number("") 会给 0，都跟原版不是一回事。
      const v = pyIntStr(obj.minutes);
      if (v === null) throw new Error("这张图我没读出娱乐时间，你直接填吧");
      const clamped = Math.max(0, Math.min(1440, v));
      out.minutes = clamped;
      out.h = Math.floor(clamped / 60);
      out.m = clamped % 60;
      return out;
    }

    const bed = str(obj.bed), wake = str(obj.wake);
    if (hhmmToMin(bed) !== null && hhmmToMin(wake) !== null) {
      out.bed = bed;
      out.wake = wake;
      return out;
    }
    throw new Error("这张图我没读出具体的入睡和起床时间，你直接填吧");
  };

  // ================= /api/task/read =================
  /** 交作业的那张照片，让 AI 读出来"他具体做了什么"，填回「你具体做了什么」。
   *  逐字对应 handle_task_read（app.py:1548-1588）。
   *
   *  **只读，不落盘** —— 跟 habitRead 一个规矩：读出来的话填回输入框，
   *  他看一眼、能改，确认了再点「交作业，接受考核」。
   *  这样他就不用又发截图又手打一遍了。 */
  H.taskRead = async (p) => {
    const d = await load();
    const t = findTask(d, p && p.id);
    const photo = p && p.photo;
    if (typeof photo !== "string" || !photo.startsWith("data:")) {
      throw new Error("没收到图片");
    }
    const ask =
      "这是学生发来的一张截图，用来证明他做了这一项：\n" +
      "任务：" + pyStr(getOr(t, "title", "")) + "\n" +
      "这一项的最低限度：" + (str(t.min) || "（没写）") + "\n\n" +
      "请用**他自己的口气**写一句话，说清这张图能看出他具体做了什么 —— " +
      "就是他自己会往「你具体做了什么」那个框里填的那种话" +
      "（读了几页、写到哪、列了什么、做了几道题）。\n" +
      "硬性要求：\n" +
      "- 只写图里**真能看出来**的。看不出来的，一个字都不许编。\n" +
      "- 不评价、不夸、不替他拔高（不许写「看起来做得不错」这种）。\n" +
      "- 一句话，40 字以内。\n" +
      "- 要是这张图跟这一项看不出关系，done 就写空字符串。\n" +
      "只返回 JSON：{\"done\":\"一句话\"}";
    const obj = await ai.askAi([
      { role: "system", content: ai.COACH },
      { role: "user", content: [
        { type: "text", text: ask },
        { type: "image_url", image_url: { url: photo } },
      ] },
    ]);
    const o = (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
    const done = pyStr(o.done || "").trim();
    if (!done) throw new Error("这张图我没看出跟这一项有关的内容，你自己写一句吧");
    return { ok: true, done: done.slice(0, 300) };
  };

  // ================= /api/task/fit =================
  /** 刚加了一件事，让教练说一句怎么把它塞进去。
   *  **只给建议，一个字都不改数据** —— 改不改由他自己按「改」按钮决定。 */
  H.taskFit = async (p) => {
    const d = await load();
    const nw = findTask(d, p && p.id);
    const rest = [];
    for (const t of (d.tasks || [])) {
      if (t.id === nw.id || t.pass) continue;
      const bits = [pyStr(getOr(t, "title", ""))];
      if (t.due) bits.push("截止 " + pyStr(t.due));
      if (t.line === "主线") bits.push("主线，没有截止日");
      rest.push("  - " + bits.join("；"));
    }
    const prompt =
      "他刚往清单里加了一件事：\n" +
      "  标题：" + pyStr(getOr(nw, "title", "")) + "\n" +
      "  截止：" + (getOr(nw, "due", "") || "（没写）") + "\n" +
      "  谁布置的：" + (getOr(nw, "source", "") || "（没写）") + "\n" +
      "  他估计要花：" + (str(p && p.cost) || "（没写）") + "\n\n" +
      "他手上还没做完的事：\n" + (rest.join("\n") || "  （没有别的事了）") + "\n\n" +
      "请说一到两句话，讲清**怎么把新加这件事塞进去**：" +
      "为了给它腾地方，哪一项该往后挪、或者哪一项今天就得先动。" +
      "要是确实排得开，就直说排得开。\n" +
      "**只给建议。不要说你已经改动了他的任何安排。**" +
      "直接、不客套。只返回 JSON：{\"say\":\"...\"}";
    const obj = await ai.askAi([
      { role: "system", content: ai.COACH },
      { role: "user", content: prompt },
    ]);
    const say = str(obj && obj.say);
    if (!say) throw new Error("教练这次没说出什么，再点一次试试");
    return { ok: true, say: say, title: getOr(nw, "title", "") };
  };

  // ================= /api/review =================
  /** 写一段点评并存下来。逐字对应 handle_review（app.py:1948-1984）。
   *
   *  ★ 顺序很要紧：**先调 AI，再重新 load 写盘。** 反过来的话，AI 思考的这
   *  几十上百秒里，用户交的任何东西都会被手里那份旧快照盖掉。 */
  H.review = async (p) => {
    // ★ `(p.get("period") or "day").strip()` —— or 在 strip **之前**，
    //   所以 "  " 这种会被 strip 成空串、然后报"时间粒度不对"，不是兜回 "day"。
    const period = String((p && p.period) || "day").trim();
    if (!["day", "week", "month", "year"].includes(period)) {
      throw new Error("时间粒度不对");
    }
    const key = str(p && p.key) || periodKey(period, natToday(now()));
    try {
      periodRange(period, key);              // 先验一下 key 合不合法
    } catch (e) {
      throw new Error("这个时间段看不懂：" + key);
    }

    const digest = reviewDigest(await load(), period, key, now());
    if (!digest) {
      throw new Error("这一段时间里一条记录都没有，没什么可点评的（也省你一次 AI 调用）");
    }

    const obj = await ai.askAi([
      { role: "system", content: ai.REVIEW_SYS },
      { role: "user", content: digest },
    ]);
    const text = str(obj && obj.text);
    if (!text) throw new Error("AI 这次没写出东西，再点一次试试");

    const d = await load();                  // 重新读：刚才这段时间里可能有人写了盘
    if (!d.reviews) d.reviews = {};
    d.reviews[key] = {
      period: period, text: text, at: nowStamp(now()),
    };
    await save(d);
    return { ok: true, key: key, period: period, text: text, at: d.reviews[key].at };
  };

  return H;
}
