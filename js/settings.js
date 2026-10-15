// 「设置」页整页 —— **纯手机版才有的东西**，电脑版没有这一页（那台电脑上数据就在硬盘里，
// 导不导出无所谓）。所以这个文件是手写的，不在 split_ui.py 的搬运范围里。
//
// 为什么它是必需品，不是锦上添花：
//   · 数据只在这台手机上（换手机、删图标、iOS 清存储 → 全没）
//   · 跟电脑版各存各的，想搬只能靠一个文件
//   · 照片是这块存储里最大的一块，攒久了得看得见用了多少
//
// 它只干三件事：把这页画出来、把按钮接上、把结果**原样**说给他听。
// 真正搬数据的活在 js/backup.js 里。

import { store } from "./store.js";
import { dispatch } from "./api.js";
import {
  buildBackup, saveBackupFile, parseBackup, applyImport, restoreSnapshot,
  storageReport, humanBytes, blobToDataUrl,
} from "./backup.js";

const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

/** 上一次导出的结果说的那句话。**存在模块里** —— 页面一重画就没了的话，
 *  「浏览器不让存文件，你长按复制这段」那条退路就白铺了。 */
let 导出留言 = "";
/** 「存文件」和「分享」两条路都不通时，把全文摆在这儿让他长按复制。 */
let 手抄的文本 = "";

const pad2 = (n) => (n < 10 ? "0" : "") + n;
function 本地时间(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || "");
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
    + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// ================= 导出 =================
async function 导出(withPhotos, msg, btn) {
  const 原话 = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = withPhotos ? "在打包照片…" : "在打包…";
  手抄的文本 = "";
  try {
    const d = await store.loadState();
    if (!d) throw new Error("这里还没有任何数据，没什么可导的。");
    let photos = null;
    if (withPhotos) {
      photos = {};
      for (const p of await store.allPhotos()) {
        try { photos[p.name] = await blobToDataUrl(p.blob); } catch (e) { /* 单张读不出来就跳过 */ }
      }
    }
    const 结果 = await saveBackupFile(buildBackup(d, photos));
    if (结果 === "cancel") 导出留言 = "取消了，没关系。";
    else if (结果 === "share") 导出留言 = "已交给系统的分享面板 —— 存到「文件」、隔空投送、或者发给自己都行。";
    else if (结果 === "download") 导出留言 = "存到「下载」里了，文件名是「打卡备份-….json」。";
    else {
      // 分享和下载都不通（有些浏览器在主屏幕模式下就这样）→ 给一个能长按复制的框
      手抄的文本 = JSON.stringify(buildBackup(d, photos));
      导出留言 = "这台浏览器不让直接存文件。下面那张卡片里是备份的全文："
        + "**点一下选中 → 复制**，粘到微信的「文件传输助手」或者备忘录里存着，一样能备份。";
    }
    msg.textContent = 导出留言.replace(/\*\*/g, "");
    if (手抄的文本) renderSettings();          // 那句"长按复制"的卡片要画出来
  } catch (e) {
    导出留言 = e.message || String(e);
    msg.textContent = 导出留言;
  } finally {
    btn.disabled = false;
    btn.innerHTML = 原话;
  }
}

// ================= 导入 =================
async function 导入(file, msg) {
  const 说 = (t) => { msg.textContent = t; };
  try {
    说("在看这份文件…");
    const p = parseBackup(await file.text());
    const 现在 = await store.loadState();
    const 现在任务 = 现在 ? (现在.tasks || []).length : 0;
    const 线 = [];
    线.push("这份备份里有：");
    线.push("  · 任务 " + (p.data.tasks || []).length + " 项（来自 "
      + (p.kind === "backup" ? "手机版备份" : "电脑版的 data.json") + "）");
    线.push("  · 习惯记录 " + (p.data.habits || []).reduce((n, h) => n + ((h.logs || []).length), 0) + " 条");
    线.push("  · 照片 " + p.photoCount + " 张"
      + (p.kind === "pc_data" ? "（电脑版的 data.json 里没有照片，交作业时拍的图会显示不出来）" : ""));
    线.push("");
    线.push("导入会用上面这一份替换这台手机上的全部数据（现在这 " + 现在任务 + " 项任务会被换掉）。");
    线.push("现在这份我会先自动存成一份备份，导错了还能在下面「恢复」里捞回来。");
    if (!confirm(线.join("\n") + "\n\n确定要替换吗？")) { 说("取消了，什么都没动。"); return; }

    const r = await applyImport(store, p);
    说("导入好了（照片写进去 " + r.wrote + " 张"
      + (r.failed ? "，有 " + r.failed + " 张读不出来被跳过了" : "") + "）。正在重新打开…");
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    说(e.message || String(e));
  }
}

// ================= 密钥 =================
// 电脑版那个密钥框只在「还没接上 AI」时露出来，接上之后就再也改不了了。
// 手机上这不行 —— 手机丢了要换密钥、想改用另一个限额密钥，都得有地方点。
function 密钥卡(aiReady) {
  const c = el("div", "card");
  c.appendChild(el("h2", null, "AI 密钥"));
  c.appendChild(el("div", "mini",
    "密钥只存在这台手机上，而且**只发给 api.deepseek.com**，别的地方一律不去。"
    + "但它在这台手机上是明文的 —— 拿到你解锁的手机、又懂点技术的人，是看得见的。"
    + "所以建议专门建一个<b>设了消费上限</b>的密钥；手机丢了就把它作废、换一个。"));
  if (!aiReady) c.appendChild(el("div", "mini", "现在还没配密钥，AI 那几步（判分、出题、点评、读图）用不了。"));

  const row = el("div", "pickrow");
  const input = el("input");
  input.type = "password";
  input.placeholder = "sk-........................";
  input.autocomplete = "off";
  const save = el("button", "btn btn-primary", aiReady ? "换一个" : "存进去");
  row.appendChild(input); row.appendChild(save);
  c.appendChild(row);

  const msg = el("div", "readnote", "");
  c.appendChild(msg);

  save.onclick = async () => {
    const k = input.value.trim();
    if (!k) { input.focus(); return; }
    save.disabled = true;
    try {
      await dispatch("/api/key", { key: k });
      input.value = "";
      msg.textContent = "✅ 换好了，正在重新打开…";
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      msg.textContent = e.message || String(e);
      save.disabled = false;
    }
  };
  input.onkeydown = (e) => { if (e.key === "Enter") save.click(); };

  if (aiReady) {
    const 清 = el("button", "btn btn-ghost", "清除密钥");
    清.style.marginTop = "12px";
    清.onclick = async () => {
      if (!confirm("清掉之后 AI 那几步就用不了了（记录本身不受影响）。确定吗？")) return;
      清.disabled = true;
      try { await store.clearKey(); msg.textContent = "清掉了。正在重新打开…"; setTimeout(() => location.reload(), 900); }
      catch (e) { msg.textContent = String(e.message || e); 清.disabled = false; }
    };
    c.appendChild(清);
  }
  return c;
}

// ================= 安装说明 =================
function 安装卡() {
  const c = el("div", "card");
  c.appendChild(el("h2", null, "装到手机主屏幕（只用做一次）"));
  c.appendChild(el("div", "mini",
    "<b>iPhone</b>：用 Safari 打开这个网址 → 底下中间的「分享」→「添加到主屏幕」→"
    + "之后<b>从主屏幕的图标进</b>（别再从 Safari 的书签进）。<br>"
    + "<b>安卓</b>：用 Chrome 打开 → 右上角三个点 →「安装应用」／「添加到主屏幕」。"));
  c.appendChild(el("div", "mini",
    "两条要紧的：<br>"
    + "① <b>数据要在装完之后再录。</b>Safari 标签页里的存储不会跟着进主屏应用。"
    + "（已经在标签页里录过的话：先在那儿导出一份备份，装好图标再导进来。）<br>"
    + "② 装好之后 <b>日常使用完全离线</b>，不碰任何服务器。那个网址只在"
    + "「装的那一次」和「以后更新时」需要。"));
  c.appendChild(el("div", "mini",
    "为什么老强调导出：苹果在存储吃紧的时候<b>仍然</b>可能清掉某个 App 的数据。"
    + "那不是你的错，也没法彻底防住 —— 防它的办法就是把备份放到手机外面。"));
  return c;
}

// ================= 用量 =================
function 用量卡(use) {
  const c = el("div", "card");
  c.appendChild(el("h2", null, "存储用量"));
  const 行 = [];
  if (use.usage != null && use.quota) {
    行.push("这个站一共用了 <b>" + humanBytes(use.usage) + "</b>，浏览器给的额度约 "
      + humanBytes(use.quota));
  } else {
    // Safari 不给这个数 —— 别让它看起来像坏了，直说
    行.push("这台浏览器不给「用量」这个数（Safari 不支持）。下面几行还是准的：");
  }
  行.push("照片 " + use.photos + " 张，约 " + humanBytes(use.photoBytes)
    + " —— 占地方的主要就是它");
  行.push("自动备份 " + use.backups + " 份（最多留 10 份）");
  行.push("记录本身约 " + humanBytes(use.stateBytes));
  if (use.photoBytes > 200 * 1024 * 1024) {
    行.push("<b>照片攒得有点多了。</b>先导一份含照片的备份出去，再从「交作业」那几项里"
      + "把早年的老记录删掉 —— 删了也不影响已经算出来的分。");
  }
  c.appendChild(el("div", "mini", 行.join("<br>")));
  return c;
}

// ================= 自动备份 =================
async function 备份卡() {
  const c = el("div", "card");
  c.appendChild(el("h2", null, "自动备份（这台手机上）"));
  const list = await store.listBackups();
  if (!list.length) {
    c.appendChild(el("div", "mini", "还没有。每次打开 App（隔 6 小时以上）会自动存一份，最多留 10 份。"));
    return c;
  }
  c.appendChild(el("div", "mini",
    "最近 " + list.length + " 份。<b>这是手机内部的备份</b> —— 手机丢了、系统清数据了，"
    + "它跟着一起没。它只能救「点错了、导错了」这类事，救不了丢手机。"
    + "所以还是要往手机外面导。"));
  list.forEach((b, i) => {
    const d = b.data || {};
    const 任务 = (d.tasks || []).length;
    const 条数 = (d.habits || []).reduce((n, h) => n + ((h.logs || []).length), 0);
    const row = el("div", "pickrow");
    row.style.marginTop = "10px";
    row.appendChild(el("span", "mini",
      本地时间(b.at) + "　任务 " + 任务 + " 项 · 记录 " + 条数 + " 条"));
    const btn = el("button", "btn btn-ghost", "恢复");
    btn.onclick = async () => {
      if (!confirm("用 " + 本地时间(b.at) + " 那一份替换现在的数据？（现在这份会先自动存一份）")) return;
      btn.disabled = true;
      try {
        await restoreSnapshot(store, b.at);
        btn.textContent = "好了，正在重新打开…";
        setTimeout(() => location.reload(), 900);
      } catch (e) { alert(e.message || String(e)); btn.disabled = false; }
    };
    row.appendChild(btn);
    c.appendChild(row);
  });
  return c;
}

// ================= 这一页的入口（ui.js 的 render() 会调它）=================
export function renderSettings() {
  const box = $("#view-settings");
  if (!box) return;                       // 外壳里没有这一页（老版本缓存）→ 安静退出，别把整页拖垮
  box.innerHTML = "";

  const 头 = el("div", "card");
  头.appendChild(el("h2", null, "设置"));
  头.appendChild(el("div", "mini",
    "这个 App 的 <b>数据只存在这台手机里</b>，不往任何服务器传"
    + "（除了你让它问 AI 的那几句）。好处是不用电脑、断网也能记；"
    + "代价是换个手机、删掉图标、系统清一次 —— 记录就没了。所以「导出备份」这块不是可选项。"));
  box.appendChild(头);

  // ---- 导出 ----
  const 出 = el("div", "card");
  出.appendChild(el("h2", null, "导出备份"));
  const 出提示 = el("div", "mini", "在数…");
  出.appendChild(出提示);
  const row = el("div", "pickrow");
  const b1 = el("button", "btn btn-primary", "导出备份");
  const b2 = el("button", "btn btn-ghost", "只导数据（小）");
  row.appendChild(b1); row.appendChild(b2);
  出.appendChild(row);
  const 出记 = el("div", "readnote", 导出留言.replace(/\*\*/g, ""));
  出.appendChild(出记);
  出.appendChild(el("div", "mini",
    "「导出备份」把照片一起带走，导到新手机上照片还在，但文件会大很多；"
    + "「只导数据」只有记录（任务、分、睡眠、反思），几百 KB，但<b>照片不会跟着回来</b>。"
    + "两个都隔一段时间导一份最稳。"));
  b1.onclick = () => 导出(true, 出记, b1);
  b2.onclick = () => 导出(false, 出记, b2);
  box.appendChild(出);

  // ---- 导入 ----
  const 入 = el("div", "card");
  入.appendChild(el("h2", null, "导入备份"));
  const 选 = el("input");
  选.type = "file";
  选.accept = "application/json,.json";
  入.appendChild(选);
  const 入记 = el("div", "readnote", "");
  入.appendChild(入记);
  入.appendChild(el("div", "mini",
    "能吃两种文件：手机版导出的「打卡备份-….json」，和电脑版那个 <b>data.json</b>"
    + "（要把电脑上的历史搬过来就走这条）。<br>"
    + "<b>留意：导入是替换，不是合并</b> —— 会把现在这台手机上的数据整个换掉。"
    + "所以动手之前它会先问你一次，而且会先把现在这份存成一份自动备份。"));
  选.onchange = async () => {
    const f = 选.files && 选.files[0];
    if (!f) return;
    await 导入(f, 入记);
    选.value = "";
  };
  box.appendChild(入);

  // ---- 下面三块要读库，先摆占位，数字到了再整块换掉 ----
  const 备 = el("div", "card");
  备.appendChild(el("h2", null, "自动备份（这台手机上）"));
  备.appendChild(el("div", "mini", "在数…"));
  box.appendChild(备);

  const 量 = el("div", "card");
  量.appendChild(el("h2", null, "存储用量"));
  量.appendChild(el("div", "mini", "在数…"));
  box.appendChild(量);

  box.appendChild(安装卡());

  const 钥 = el("div", "card");
  钥.appendChild(el("h2", null, "AI 密钥"));
  钥.appendChild(el("div", "mini", "在数…"));
  box.appendChild(钥);

  // 手抄那条退路：浏览器不给存文件时，内容摆在这儿让他长按复制
  if (手抄的文本) {
    const c = el("div", "card");
    c.appendChild(el("h2", null, "长按下面这段，全选复制"));
    const ta = el("textarea");
    ta.value = 手抄的文本;
    ta.rows = 6;
    ta.onclick = () => ta.select();
    c.appendChild(ta);
    box.appendChild(c);
  }

  (async () => {
    try {
      const use = await storageReport(store);
      量.replaceWith(用量卡(use));
      出提示.innerHTML = "现在有照片 " + use.photos + " 张（约 " + humanBytes(use.photoBytes)
        + "）→ 含照片的备份大约 "
        + humanBytes(Math.round(use.photoBytes * 1.34) + use.stateBytes)
        + "，只导数据大约 " + humanBytes(use.stateBytes) + "。";
    } catch (e) { 量.lastChild.textContent = "数不出来：" + (e.message || e); }

    try {
      const s = await dispatch("/api/state", null);
      钥.replaceWith(密钥卡(!!s.ai_ready));
    } catch (e) { 钥.lastChild.textContent = "读不出来：" + (e.message || e); }

    try {
      备.replaceWith(await 备份卡());
    } catch (e) { 备.lastChild.textContent = "数不出来：" + (e.message || e); }
  })();
}
