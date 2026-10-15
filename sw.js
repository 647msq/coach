// Service Worker —— "装完之后彻底离线可用"就靠它。
//
// 三个分支，顺序不能乱：
//   ① /照片/xxx   → 从 IndexedDB 的 photos 抽屉里取出 blob 吐回去。
//                   这样 js/ui.js 里那三处 "照片/" + name 一个字都不用改。
//   ② 同源 GET    → 先看缓存（cache-first）。外壳、js、图标全从这儿来。
//   ③ 其他一切    → 直接放行，**绝不拦截**。
//                   跨域请求（特别是 https://api.deepseek.com）必须走这条 —— 拦了 AI 就废了。
//
// ★ 更新流程：改了任何静态文件，就把 CACHE 名里的版本号 +1。
//   下次联网打开时新 SW 会装好、旧的缓存会被删掉。

const CACHE = "coach-shell-v7";   // ★ 改过任何静态文件就把这个号 +1（v7：第 4 步收尾 —— 设置页/备份/迁移补齐）

// 要预缓存的文件。**不用 addAll**：只要有一个文件 404，整个安装都会失败、
// 结果就是一个 SW 都装不上。所以改成一个个加，缺哪个就跳过哪个、只打条日志。
// ★ 这一串是"离线时还能不能开起来"的全部依据：漏了哪个文件，
//   装完之后断网打开就会在那个文件上白屏。加了新 js 一定要补一行。
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./js/boot.js",
  "./js/ui.js",
  "./js/api.js",
  "./js/handlers.js",
  "./js/logic.js",
  "./js/store.js",
  "./js/ai.js",
  "./js/migrate.js",     // 老 data.json / 老形状数据补齐（导入、开机都要用）
  "./js/backup.js",      // 导出 / 导入 / 滚动备份 / 用量
  "./js/settings.js",    // 「设置」页（ui.js 的 render() 会调它）
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map((u) =>
      c.add(new Request(u, { cache: "reload" }))
        .catch((err) => console.warn("[sw] 没缓存上（先跳过）：", u, err))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// ---- ① 照片：从 IndexedDB 取 -----------------------------------------
// 这里不用 import（classic worker），所以直接把 DB 名字再写一遍。
// ★ 必须跟 js/store.js 里的 DB_NAME 一致，改了那边也要改这里。
const DB_NAME = "coach";

function idbGetPhoto(name) {
  return new Promise((ok) => {
    // 不带版本号打开：**只读**，绝不去触发升级、更不去建库。
    // （万一库还不存在，读到 null 走 404 就好；建库这件事交给应用自己。）
    let open;
    try { open = indexedDB.open(DB_NAME); } catch (e) { ok(null); return; }
    open.onerror = () => ok(null);
    open.onblocked = () => ok(null);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("photos")) { db.close(); ok(null); return; }
      let r;
      try {
        r = db.transaction("photos", "readonly").objectStore("photos").get(name);
      } catch (e) { db.close(); ok(null); return; }
      r.onsuccess = () => {
        const v = r.result;
        db.close();
        // photos 抽屉是 keyPath:"name"，存的是 {name, blob, type, at}
        ok(v ? (v.blob || null) : null);
      };
      r.onerror = () => { db.close(); ok(null); };
    };
  });
}

async function photoResponse(name) {
  try {
    const blob = await idbGetPhoto(name);
    if (blob) {
      return new Response(blob, {
        headers: {
          "Content-Type": blob.type || "image/jpeg",
          "Cache-Control": "no-store",
        },
      });
    }
  } catch (e) { /* 往下走 404 */ }
  return new Response("这张照片不在这台手机上（换手机或重装后，照片不会跟着数据一起回来）", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// ---- ② 外壳：先缓存 ---------------------------------------------------
async function fromCacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const resp = await fetch(req);
    // 只缓存自己站上的正常响应；跨域的、206 的、opaque 的一律不碰
    if (resp && resp.ok && resp.type === "basic") c.put(req, resp.clone());
    return resp;
  } catch (err) {
    return new Response("离线了，这个还没缓存过", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function shellResponse(req) {
  // 先当普通请求走一遍：'/' 和 'index.html' 本来就在缓存里，所以离线也开得起来。
  const resp = await fromCacheFirst(req);
  if (resp && resp.status !== 503) return resp;
  // 真连不上（离线）才拿外壳兜底。
  // ★ 不能一上来就对**所有**导航都回 index.html —— 那样这个站里的任何别的
  //   页面（比如开发用的 _selftest.html）都会被悄悄换成首页。
  const c = await caches.open(CACHE);
  const shell = (await c.match("./index.html", { ignoreSearch: true }))
    || (await c.match("./", { ignoreSearch: true }));
  return shell || resp;
}

// ---- 派发 -------------------------------------------------------------
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                       // POST 一律放行

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;        // 跨域（含 DeepSeek）一律放行
  if (url.pathname.endsWith("/sw.js")) return;            // 别把 SW 自己缓存住

  const m = /\/照片\/([^/]+)$/.exec(decodeURIComponent(url.pathname));
  if (m) { e.respondWith(photoResponse(m[1])); return; }

  if (req.mode === "navigate") { e.respondWith(shellResponse(req)); return; }
  e.respondWith(fromCacheFirst(req));
});
