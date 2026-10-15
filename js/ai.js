// AI 层：**全应用唯一允许 fetch 的地方**。
//
// 对应电脑版的 ask_ai() / extract_json()（app.py:689-734）。
// 电脑版是服务端去调 DeepSeek；手机版改成浏览器直接调 —— 这条路已经实测过：
// DeepSeek 的 CORS 预检返回了 access-control-allow-origin，允许 POST + authorization 头。
//
// 密钥只从 store 里读，**只发往 api.deepseek.com**，不去任何别的地方。

export const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
export const MODEL = "deepseek-chat";

// 系统提示词。**逐字照抄 app.py** —— 这些字是他这套判分标准的全部依据，
// 改一个字就是改标准，不能顺手润色。
export const COACH = "你是一位严格但公平的学习教练。你不说客套话，不鼓励，只指出事实。";

/** 教练对话的系统提示词。**关键：回复里没有 min 字段** ——
 *  最低限度永远是后端从任务里抄的，AI 一个字都不许自己编。
 *  不然"求情"就变成了"把标准说服到任意低"，比没有这个功能更糟。 */
export const COACH_CHAT =
  "你是一位严格但公平的学习教练，正在和学生对话。必须做到：\n" +
  "1. 你唯一的权力：把**他清单里某一项**今天降到那一项**自己写着的「最低限度」**" +
  "—— 意思是今天做到那一版就算数。你**不能自己编一个新的最低限度**，" +
  "不能改截止日、不能删任务、不能加任务、不能改任务名。\n" +
  "2. **没有次数上限，你按情况判断。** 理由成立（生病、必须去的急事、家里的事）就放；" +
  "理由含糊、只是情绪、只是想拖、这项今天本来就要交 —— 就直说不行，让他今天照原样做。\n" +
  "3. **先看他这个月的放行记录再判断**，那是给你的一部分输入。看到" +
  "「这项上周刚放过」「同一个理由说过两遍」「这周已经第三次了」，**直接点破**，别当没看见。\n" +
  "4. 三条硬规矩，没有例外：**一次只能放行一项**；" +
  "**同一项一天只能放行一次**；**同一项不能连着两天放行**" +
  "（连着两天说明不是急事、是这项的计划本身不现实，让他去重排，不是你继续放行）。\n" +
  "5. 不安慰、不喊口号，禁止'加油''你已经很棒了'。中文，2-4 句，直接。\n" +
  "6. 睡眠、刷手机的数字只能用来**描述**，不能拿来当'所以给你降标准'的理由，" +
  "也永远不给它们打分。**只有原始记录里明确给出的对应关系才能说，没给就不许说。**\n" +
  "7. 清单里没有的任务、没有的数字，**一个字都不许编**。\n" +
  "只返回 JSON：{\"say\":\"你对他说的话\"," +
  "\"ask\":null 或 {\"task_id\":数字,\"reason\":\"他给的理由，一句话\"}}";

/** 写点评用的系统提示词（app.py:77-87 逐字照抄）。
 *  ★ 第 2 条那半句"只有原始记录里明确给出了对应关系才能说，没给就闭嘴"是**配合
 *   reviewDigest 里那段【交叉核对】用的** —— 把对应关系先算好喂进去，模型就没得编。 */
export const REVIEW_SYS =
  "你是一位严格但公平的学习教练，同时是这个学生的作息管家。" +
  "你根据他这段时间的原始记录写一段点评。必须做到：\n" +
  "1. 先点名他做得好的**具体**的事（说任务名），不要笼统；\n" +
  "2. 再说没做到的，并指出它和睡眠/刷手机的关系" +
  "——**只有原始记录里明确给出了对应关系才能说，没给就闭嘴**；\n" +
  "3. 结尾给一条明天（或下周）立刻能做的具体动作；\n" +
  "4. 不安慰、不喊口号，禁止出现'加油''你已经很棒了'这类话；\n" +
  "5. 120-200 字。\n" +
  "只返回 JSON：{\"text\":\"...\"}";

export const REFLECT_SYS =
  COACH + "你在看学生每天写的自我反思，只做一件事：判断这段反思值多少附加分。" +
  "标准：写空话、喊口号、'明天一定努力' → 0-1 分；只是复述今天做了什么 → 1-2 分；" +
  "说到了具体卡在哪、下次具体怎么改 → 3-5 分。不安慰、不鼓励。" +
  "只返回 JSON：{\"bonus\":0-5,\"word\":\"一句话说清为什么给这个分，40 字以内\"}";

/** 从 AI 的回复里抠出 JSON（防止它多嘴）。逐字对应 app.py:689-698。 */
export function extractJson(text) {
  const t = String(text == null ? "" : text);
  for (const [s, e] of [["{", "}"], ["[", "]"]]) {
    const i = t.indexOf(s), j = t.lastIndexOf(e);
    if (i !== -1 && j !== -1 && j > i) {
      try { return JSON.parse(t.slice(i, j + 1)); } catch (err) { /* 换下一对括号试 */ }
    }
  }
  return null;
}

export function makeAi({ store }) {
  return {
    // 提示词挂在这儿，接口层就不用再 import 一次（app.py 里它们也是模块级常量）
    COACH, COACH_CHAT, REFLECT_SYS, REVIEW_SYS,

    /** 调 AI，强制回 JSON。对应 ask_ai()。
     *
     *  temperature / maxTokens 只有对话那边会传 —— **千万别全局设 maxTokens**：
     *  出的计划题案要一次吐 8 项任务带步骤，会被截断。 */
    async askAi(messages, { temperature = 0.7, maxTokens = null } = {}) {
      const key = await store.getKey();
      if (!key) {
        throw new Error("还没配置 AI：请把 DeepSeek 的密钥填进来（点上面那条提示）。");
      }
      const payload = {
        model: MODEL,
        messages,
        temperature,
        response_format: { type: "json_object" },
      };
      if (maxTokens) payload.max_tokens = maxTokens;

      let resp;
      try {
        resp = await fetch(DEEPSEEK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        throw new Error("连不上 AI：" + (e && e.message ? e.message : e));
      }
      if (!resp.ok) {
        let detail = "";
        try { detail = (await resp.text()).slice(0, 200); } catch (e) { /* 拿不到就算了 */ }
        throw new Error("AI 调用失败（" + resp.status + "）：" + detail);
      }
      let data;
      try {
        data = await resp.json();
      } catch (e) {
        throw new Error("AI 的回复不是 JSON，可能是网络被拦了");
      }
      const text = data && data.choices && data.choices[0]
        && data.choices[0].message && data.choices[0].message.content;
      const obj = extractJson(text);
      if (obj === null) throw new Error("AI 回复看不懂：" + String(text || "").slice(0, 150));
      return obj;
    },
  };
}
