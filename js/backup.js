// 备份 / 恢复：纯手机版自己加的东西（电脑版是靠「备份/」文件夹 + 数据在同一个硬盘上）。
//
// 为什么这块**不能省**：手机版的数据只在这台手机上。换个手机、删掉图标、
// iOS 存储吃紧的时候清一次 —— 记录就没了。而且它跟电脑版**各存各的**，
// 想搬过去也只能靠一个文件。所以导出、导入必须是第一等公民。
//
// 三条规矩：
//   · **密钥绝不进备份**：它在 meta 抽屉里，备份只导 state + photos。
//   · 导入是**替换**，不是合并 —— 悄悄合出来的状态没人能预料，比丢了还难查。
//   · 动线上数据**之前**先验：候选数据跑一遍 migrate()，跑不过就原样退回，一个字不改。
//
// 这个文件不碰 DOM 渲染（那是 js/settings.js 的事），只做"数据进 / 数据出"。

import { SCHEMA } from "./logic.js";
import { migrate } from "./migrate.js";

const APP_TAG = "coach";

const pad2 = (n) => (n < 10 ? "0" : "") + n;

/** 文件名用**本地时间** —— 他认的是手机上的日期，不是 UTC。 */
export function backupName(at = new Date()) {
  return "打卡备份-" + at.getFullYear() + pad2(at.getMonth() + 1) + pad2(at.getDate())
    + "-" + pad2(at.getHours()) + pad2(at.getMinutes()) + pad2(at.getSeconds()) + ".json";
}

/** 是不是一条像样的 state（migrate 跑完之后再看一眼"该是数组的是不是数组"）。 */
function looksLikeState(d) {
  return !!d && typeof d === "object" && !Array.isArray(d)
    && Array.isArray(d.tasks) && Array.isArray(d.habits);
}

/**
 * 把一份 state 打包成备份对象。
 * photos 是 { 文件名: dataURL } —— 不传就只导数据（base64 会把体积撑大 33%）。
 */
export function buildBackup(state, photos = null, at = new Date()) {
  const d = JSON.parse(JSON.stringify(state));
  const out = {
    app: APP_TAG,
    version: SCHEMA,
    exported_at: at.toISOString(),
    // 给人看的一句话，万一以后他打开文件不知道这是啥
    note: "学习教练（手机版）的备份。导入会替换手机上的全部数据。",
    data: d,
  };
  if (photos) out.photos = photos;
  return out;
}

/** 备份对象 → 能存/能分享的 File。 */
export function backupFile(obj, at = new Date()) {
  return new File([JSON.stringify(obj)], backupName(at), { type: "application/json" });
}

/** 文本形状的备份（"复制文本"那条退路用）。 */
export function backupText(obj) {
  return JSON.stringify(obj);
}

// ================= 导出 =================

/**
 * 把文件交给他。三级退路，**逐级降**：
 *   ① navigator.share({files}) —— iOS 上最靠得住的一条（存到「文件」、隔空投送、发微信）
 *   ② <a download> —— 桌面浏览器和安卓上直接下载
 *   ③ 返回 "manual" —— 两条都不行就由界面给一个能长按复制的文本框
 * 返回 "share" / "download" / "manual" / "cancel"。
 */
export async function saveBackupFile(obj, at = new Date()) {
  const file = backupFile(obj, at);
  // node 里（tools/ 下的自测）没有 navigator / document —— 那两条退路直接跳过，
  // 落回 "manual"，自测就能在命令行里验这套降级逻辑了。
  const 有分享 = typeof navigator !== "undefined" && navigator.canShare;
  if (有分享 && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return "share";
    } catch (e) {
      if (e && e.name === "AbortError") return "cancel";
      // 分享失败（有些环境 canShare 说行、真调又不行）→ 往下走退路
    }
  }
  if (typeof document === "undefined") return "manual";
  try {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return "download";
  } catch (e) { /* 继续降级 */ }
  return "manual";
}

// ================= 导入 =================

/**
 * 解析一个备份文件（**只解析和校验，绝不碰线上数据**）。
 * 认两种东西：
 *   · 手机版导出的备份：{app:"coach", data:{...}, photos:{...}}
 *   · 电脑版的 data.json：整份就是数据（没有外壳）
 * 返回 {data, photos, kind, photoCount}；看不懂就抛一句人话。
 *
 * ★ 校验就是**在候选数据上跑一遍 migrate()** —— 过了才说明它是我们能吃的形状。
 *   跟电脑版那句「先备份再迁移」是一个思路：动真数据之前，先证明这份数据是活的。
 */
export function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(String(text || ""));
  } catch (e) {
    throw new Error("这个文件不是 JSON —— 是不是选错了？（要选「打卡备份-….json」）");
  }
  let data = null, photos = null, kind = "";
  if (obj && typeof obj === "object" && obj.app === APP_TAG && obj.data) {
    data = obj.data;
    photos = obj.photos && typeof obj.photos === "object" ? obj.photos : null;
    kind = "backup";
  } else if (obj && typeof obj === "object" && !Array.isArray(obj)
             && (obj.tasks || obj.habits || obj.schema)) {
    data = obj;                       // 电脑版的 data.json：整份就是数据
    kind = "pc_data";
  } else {
    throw new Error("这个文件里没有能认出来的数据（既不是手机版备份，也不是电脑版的 data.json）");
  }

  // 认出来之后先看一眼"该有的两张表在不在"。缺了的那份不可能是这个 App 的数据 ——
  // 放进去就是把习惯整片抹掉（migrate 补出来的空表和"他真的没有习惯"根本分不清）。
  if (!("tasks" in data) || !("habits" in data)) {
    throw new Error("这份数据里没有任务和习惯那两张表，看着不像是这个 App 的数据。");
  }

  const d = JSON.parse(JSON.stringify(data));
  try {
    migrate(d);
  } catch (e) {
    throw new Error("这份数据看不懂（" + e.message + "），我没有动你现在的数据。");
  }
  if (!looksLikeState(d)) {
    throw new Error("这份数据里没有任务和习惯那两张表，看着不像是这个 App 的数据。");
  }

  // 照片：只收 data URL，别的一律当没有（坏数据不能带进来）
  const keep = {};
  if (photos) {
    for (const [name, val] of Object.entries(photos)) {
      if (typeof val === "string" && val.startsWith("data:image/")) keep[name] = val;
    }
  }
  return { data: d, photos: keep, kind, photoCount: Object.keys(keep).length };
}

function dataUrlToBlob(url) {
  const m = /^data:([^;,]*)[^,]*,(.*)$/.exec(url);
  if (!m) return null;
  const type = m[1] || "image/jpeg";
  const bin = atob(m[2]);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type });
}

export function blobToDataUrl(blob) {
  // node 里（tools/ 下的自测）没有 FileReader —— 那条路只有浏览器有。
  // 自己拼一个出来，好让"导出的照片能原样读回来"这件事在命令行里也验得了。
  if (typeof FileReader === "undefined") {
    return blob.arrayBuffer().then((ab) => {
      const u8 = new Uint8Array(ab);
      let s = "";
      const CHUNK = 0x8000;               // 一次转这么多字节，别把调用栈撑爆
      for (let i = 0; i < u8.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      return "data:" + (blob.type || "image/jpeg") + ";base64," + btoa(s);
    });
  }
  return new Promise((ok, no) => {
    const r = new FileReader();
    r.onerror = () => no(new Error("读照片失败"));
    r.onload = () => ok(r.result);
    r.readAsDataURL(blob);
  });
}

/**
 * 真的把候选数据写进去。**替换语义**：先写 state，再写照片。
 *
 * 两道自保：
 *   ① 写之前把**现在这份**存进滚动备份 —— 导错了还能「恢复上一份备份」捞回来。
 *   ② 只有备份里**明确带了照片**时才清空照片抽屉（否则那等于把还认得出的图删了）。
 *      （电脑版的 data.json 里没有照片，那几张图就是显示不出来的孤儿，界面上会说明。）
 */
export async function applyImport(store, parsed) {
  const 旧的 = await store.loadState();
  if (旧的) await store.snapshot(旧的);

  await store.saveState(JSON.parse(JSON.stringify(parsed.data)));

  let wrote = 0, failed = 0;
  if (parsed.kind === "backup") {
    const 老图 = await store.allPhotos();
    for (const p of 老图) await store.deletePhoto(p.name);
    for (const [name, url] of Object.entries(parsed.photos || {})) {
      const blob = dataUrlToBlob(url);
      if (!blob) { failed++; continue; }
      try { await store.putPhoto(name, blob); wrote++; } catch (e) { failed++; }
    }
  }
  return { wrote, failed, kind: parsed.kind, kept_old_backup: !!旧的 };
}

/** 恢复某一份滚动备份（只回 state —— 照片本来就没进备份）。 */
export async function restoreSnapshot(store, at) {
  const all = await store.listBackups();
  const hit = all.find((b) => b.at === at);
  if (!hit) throw new Error("找不到这份备份了（可能已经被更近的挤掉了）");
  const 现在 = await store.loadState();
  if (现在) await store.snapshot(现在);        // 恢复之前也存一份，手滑了还能回来
  await store.saveState(JSON.parse(JSON.stringify(hit.data)));
  return { at: hit.at, restored_at: new Date().toISOString() };
}

/** 存储用量：state / 照片 / 备份各占多少（照片是能看出来的那一大块）。 */
export async function storageReport(store) {
  const est = await store.estimate();
  const photos = await store.allPhotos();
  let photoBytes = 0;
  for (const p of photos) photoBytes += (p.blob && p.blob.size) || 0;
  const backups = await store.listBackups();
  const state = await store.loadState();
  return {
    usage: est ? est.usage : null,
    quota: est ? est.quota : null,
    photos: photos.length,
    photoBytes,
    backups: backups.length,
    stateBytes: state ? JSON.stringify(state).length : 0,
  };
}

/** 字节数 → "1.2 MB"。 */
export function humanBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
