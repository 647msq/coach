// ★ 唯一那道缝 ★
//
// ui.js 里那 1800 行渲染代码，全部后端交互都只经过一个函数 api(path, body)。
// 这里把它的实现从「发 HTTP 请求」换成「查表、在本机调用」。
//
// 路由表逐条对应电脑版 app.py:2415-2440 的那张 route 字典 —— 路径字符串必须一模一样，
// 否则界面点某个按钮会撞上"没有这个接口"。

import { makeHandlers } from "./handlers.js";
import { store } from "./store.js";
import { makeAi } from "./ai.js";

const ai = makeAi({ store });
const H = makeHandlers({ store, ai });

// 导出是为了让 tools/ 里的检查能直接对着它断言（浏览器里没人 import 这个名字）。
//
// AI 也导出去，是为了**探针能把教练换成桩** —— handlers 里是 `ai.askAi(...)` 这种
// 属性查找，所以把这个对象上的方法换掉，整条路就换成假的了（不然探针要联网 + 真花钱）。
export const AI = ai;
export const ROUTES = {
  "/api/plan": H.plan,
  "/api/key": H.setKey,
  "/api/plan/save": H.planSave,
  "/api/task/add": H.taskAdd,
  "/api/task/update": H.taskUpdate,
  "/api/task/delete": H.taskDelete,
  "/api/step/toggle": H.stepToggle,
  "/api/task/steps": H.planSteps,
  "/api/habit/log": H.habitLog,
  "/api/habit/read": H.habitRead,
  "/api/habit/add": H.habitAdd,
  "/api/habit/update": H.habitUpdate,
  "/api/habit/delete": H.habitDelete,
  "/api/event/add": H.eventAdd,
  "/api/event/delete": H.eventDelete,
  "/api/review": H.review,
  "/api/task/fit": H.taskFit,
  "/api/task/read": H.taskRead,
  "/api/chat/say": H.chatSay,
  "/api/chat/apply": H.chatApply,
  "/api/chat/decline": H.chatDecline,
  "/api/quiz": H.quiz,
  "/api/grade": H.grade,
  "/api/submit": H.submit,
  "/api/reflect": H.reflect,
};

/** 给 tools/check_routes.py 和 tools/test_handlers.mjs 用的：路清单本身也要能被检查。 */
export const ROUTE_PATHS = Object.keys(ROUTES);

export async function dispatch(path, body) {
  // /api/state 是唯一不带 body 的调用（原版是 GET）
  if (path === "/api/state") return await H.state({});

  const fn = ROUTES[path];
  if (!fn) throw new Error("手机版没有这个接口：" + path);
  return await fn(body || {});
}

export { store, ai, H as handlers };
