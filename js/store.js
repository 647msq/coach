// 存储层：IndexedDB。
//
// 电脑版把数据放在 data.json + 照片/ 两个地方；这里对应成四个"抽屉"：
//   state    —— 整个应用数据，**就一条记录**（键固定是 "data"）。形状严格对齐 data.json。
//   photos   —— 照片的 blob（不是 base64！base64 塞进 state 会让它胀 33% 且没法增量读）
//   meta     —— 密钥之类的小设置。**故意跟 state 分开**：导出备份时只导 state，
//               密钥就天然不会跟着流出去。
//   backups  —— 打开应用时存的滚动快照，对应电脑版的 备份/ 文件夹。
//
// ★ 两个版本号别搞混 ★
//   DB_VERSION  是 IndexedDB 自己的结构版本，只有"抽屉/索引"变了才动它。
//   state 里那个 schema 是**数据形状**的版本，由 js/migrate.js 管。
//
// 另外：这里**不许调 fetch**，也不许碰 DOM —— 保持纯存储，好让 node 里的
// 假 store（tools/fake_store.mjs）能一一对应地替换掉。

import { blankData } from "./logic.js";
import { migrate } from "./migrate.js";

const DB_NAME = "coach";
const DB_VERSION = 1;

let _dbPromise = null;

function ensureStores(db) {
  // 加新抽屉是**安全**的（IndexedDB 的升级是叠加式的），改已有抽屉才危险。
  if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
  if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
  if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "name" });
  if (!db.objectStoreNames.contains("backups")) db.createObjectStore("backups", { keyPath: "at" });
}

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((ok, no) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => ensureStores(req.result);
    req.onsuccess = () => {
      const db = req.result;
      // 万一这个库是被**别处**先建出来的空库（sw.js 读照片时会 open 一下同名库），
      // 版本号就已经是 1 了：再 open(1) 不会触发 onupgradeneeded，
      // 抽屉永远建不出来，之后每一处读写都会炸。所以这里主动补一次：
      // 关掉，用更高版本重开，让 upgrade 再跑一遍。
      if (db.objectStoreNames.contains("state")) { ok(db); return; }
      const again = indexedDB.open(DB_NAME, db.version + 1);
      db.close();
      again.onupgradeneeded = () => ensureStores(again.result);
      again.onsuccess = () => ok(again.result);
      again.onerror = () => no(again.error || new Error("打不开本机数据库"));
    };
    req.onerror = () => no(req.error || new Error("打不开本机数据库"));
  });
  return _dbPromise;
}

function tx(storeName, mode, fn) {
  return openDB().then((db) => new Promise((ok, no) => {
    const t = db.transaction(storeName, mode);
    const s = t.objectStore(storeName);
    let out;
    try { out = fn(s); } catch (e) { no(e); return; }
    t.oncomplete = () => ok(out && out.result !== undefined ? out.result : out);
    t.onerror = () => no(t.error || new Error("本机数据库读写失败"));
    t.onabort = () => no(t.error || new Error("本机数据库事务被中断"));
  }));
}

const req = (r) => new Promise((ok, no) => {
  r.onsuccess = () => ok(r.result);
  r.onerror = () => no(r.error);
});

export const store = {
  // ---------- state ----------
  async loadState() {
    const db = await openDB();
    const s = db.transaction("state", "readonly").objectStore("state");
    const d = await req(s.get("data"));
    return d || null;
  },

  async saveState(d) {
    const db = await openDB();
    const s = db.transaction("state", "readwrite").objectStore("state");
    await req(s.put(d, "data"));
    return d;
  },

  /** 读进来到处都用它：没有就建空的；有的话顺手把老形状补齐（只增不改）。
   *
   *  这一段对应电脑版的 load_data()：读的时候补，**补过才落盘，而且落盘之前先存一份
   *  备份** —— 备份里留的是**改之前**那份，补错了还能捞回来。 */
  async loadOrInit() {
    const d = await this.loadState();
    if (!d) {
      const blank = blankData();
      await this.saveState(blank);
      return blank;
    }
    const 改之前 = JSON.parse(JSON.stringify(d));
    if (migrate(d)) {
      await this.snapshot(改之前);
      await this.saveState(d);
    }
    return d;
  },

  // ---------- meta（密钥等）----------
  async getMeta(k) {
    const db = await openDB();
    const s = db.transaction("meta", "readonly").objectStore("meta");
    return (await req(s.get(k))) ?? null;
  },
  async setMeta(k, v) {
    const db = await openDB();
    const s = db.transaction("meta", "readwrite").objectStore("meta");
    await req(s.put(v, k));
  },
  async delMeta(k) {
    const db = await openDB();
    const s = db.transaction("meta", "readwrite").objectStore("meta");
    await req(s.delete(k));
  },
  getKey() { return this.getMeta("deepseek_key"); },
  setKey(k) { return this.setMeta("deepseek_key", k); },
  clearKey() { return this.delMeta("deepseek_key"); },

  // ---------- photos ----------
  async putPhoto(name, blob) {
    const db = await openDB();
    const s = db.transaction("photos", "readwrite").objectStore("photos");
    await req(s.put({ name, blob, type: blob.type || "image/jpeg", at: new Date().toISOString() }));
  },
  async getPhoto(name) {
    const db = await openDB();
    const s = db.transaction("photos", "readonly").objectStore("photos");
    const r = await req(s.get(name));
    return r ? r.blob : null;
  },
  async allPhotos() {
    const db = await openDB();
    const s = db.transaction("photos", "readonly").objectStore("photos");
    return await req(s.getAll());
  },
  /** 导入备份时清掉旧照片用（只有备份里明确带了照片才会调它）。 */
  async deletePhoto(name) {
    const db = await openDB();
    const s = db.transaction("photos", "readwrite").objectStore("photos");
    await req(s.delete(name));
  },

  // ---------- backups（对应电脑版的 备份/ 文件夹）----------
  /** 存一份快照。时间戳是**键**，所以同一毫秒的两份会互相盖掉 —— 正常用不会碰上，
   *  但自测里要一口气造十几份，那种时候把 at 传进来就行。 */
  async snapshot(d, at = new Date().toISOString()) {
    const db = await openDB();
    const s = db.transaction("backups", "readwrite").objectStore("backups");
    await req(s.put({ at, data: JSON.parse(JSON.stringify(d)) }));
    // 只留最近 10 份，跟电脑版 backup_data() 的保留策略一致
    const all = await req(s.getAllKeys());
    for (const k of all.sort().slice(0, Math.max(0, all.length - 10))) await req(s.delete(k));
  },
  async listBackups() {
    const db = await openDB();
    const s = db.transaction("backups", "readonly").objectStore("backups");
    const all = await req(s.getAll());
    return all.sort((a, b) => (a.at < b.at ? 1 : -1));
  },

  // ---------- 用量（给他看，让他知道离满还有多远）----------
  async estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try { return await navigator.storage.estimate(); } catch (e) { return null; }
  },
};
