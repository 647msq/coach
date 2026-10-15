// 启动杂活：注册 Service Worker、争取"别自动清我的数据"、开一份滚动备份。
//
// 它必须排在 ui.js **前面**（两个都是 <script type="module">，按文档顺序执行，
// 而模块是延迟执行的，所以这里不会拖慢首屏文字出现）。
//
// 这里做的都是"顺手而为"的事：任何一步失败都只打日志，绝不让界面起不来。

import { store } from "./store.js";

// ---------- 1. Service Worker：离线可用的前提 ----------
// 浏览器只允许 HTTPS（或 localhost）上注册 SW。所以在电脑上直接双击 index.html
// 打开是注册不上的 —— 那样测离线没用，得用 http 服务器跑。
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  const okScheme = location.protocol === "https:"
    || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!okScheme) {
    console.info("[boot] 现在不是 HTTPS，Service Worker 用不了；装到主屏幕后就没这个问题了。");
    return;
  }
  try {
    await navigator.serviceWorker.register("sw.js", { scope: "./" });
  } catch (e) {
    console.warn("[boot] Service Worker 注册失败（离线可用会打折扣）：", e);
  }
}

// ---------- 2. 申请持久化 ----------
// Safari **不支持** navigator.storage.persist()，所以这里纯属"有就更好"，
// 绝不能依赖它 —— 数据能不能留住，靠的是 manifest 里的 display:standalone。
async function askPersist() {
  const s = navigator.storage;
  if (!s || typeof s.persist !== "function") return;
  try {
    if (typeof s.persisted === "function" && await s.persisted()) return;
    const granted = await s.persist();
    console.info("[boot] 浏览器是否答应长期保留数据：", granted);
  } catch (e) { /* 不支持就算了 */ }
}

// ---------- 3. 滚动备份（对应电脑版的 备份/ 文件夹）----------
// 只在"已经有数据"时备份、且 6 小时内只备一次 —— 不然每次切回前台都写一遍。
const BACKUP_GAP = 6 * 3600 * 1000;

async function autoBackup() {
  try {
    const d = await store.loadState();
    if (!d) return;                                  // 还什么都没有，别造空备份
    const newest = (await store.listBackups())[0];
    if (newest && Date.now() - Date.parse(newest.at) < BACKUP_GAP) return;
    await store.snapshot(d);
  } catch (e) {
    console.warn("[boot] 自动备份没做成（不影响使用）：", e);
  }
}

// 三个都发出去、不 await —— 谁慢都不影响界面
registerSW();
askPersist();
autoBackup();

// 有的浏览器要求"用户碰一下"才肯给持久化，所以第一次点屏幕时再试一次
window.addEventListener("pointerdown", () => askPersist(), { once: true });

// 老数据形状怎么补：**不在这儿**。全部走 store.loadOrInit() —— 它读进来就顺手
// migrate() 一遍，补过才落盘，而且落盘之前先存一份"改之前"的滚动备份。
// 这样"新装的"和"导进来一份老 data.json 的"走的是同一条路，不会有两套逻辑。
// （第 4 步已经做完：导入老文件的入口在「设置」页 → 导入备份。）

export {};
