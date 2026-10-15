// 这个文件是从 web/index.html 里第 517-2301 行整块搬过来的，**不要手改**。
// 改渲染逻辑请改电脑版的 web/index.html，然后重跑 tools/split_ui.py。
// 唯一允许的分叉就是下面这几行 import + api() 委派 + 「设置」页的接线。
import { dispatch } from "./api.js";
import { renderSettings } from "./settings.js";

const $ = s => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const esc = s => (s == null ? "" : String(s)).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let STATE = {};
let curId = null;      // 正在看的任务
let quiz = null;       // {id, questions, done, file}
let verdict = null;    // {id, pass, reason, score}
let planDraft = null;
// 自我反思正在打的字。**必须存在模块里** —— 每次 load() 都会重建 innerHTML，
// 不存在外面的话，他打字打到一半被自己的一次点击抹掉。
let reflectDraft = null;

// 纯手机版：不再发 HTTP 请求，所有接口在本机跑（见 js/api.js）。
// 调用点一个都不用改 —— 它们本来就只认「返回一个对象 / 抛一个 Error」。
async function api(path, body){
  return await dispatch(path, body);
}

function busy(btn, text, doing){
  if (doing){ btn.dataset.html = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' + text; }
  else { btn.disabled = false; btn.innerHTML = btn.dataset.html || btn.innerHTML; }
}

// 手机拍一张照片动辄 5–10 MB，手机截图也常有 2–4 MB。原样传上去有三个坏处：
// 传得慢、费流量、而且 AI 那边很可能吃不下去（以前只在电脑上传截图，图小，
// 一直没暴露这个问题；一旦从手机相册交，这就是第一个会炸的地方）。
// 所以**在浏览器里先压一道再传**：最长边缩到 1600 像素，一律转 JPEG。
// 一般 6 MB → 300 KB 上下，够 AI 看清楚。
// 压缩失败 / 不是图片 / 本来就很小 → **原样返回**（宁可大一点，也不能把图弄丢）。
const PHOTO_MAX_SIDE = 1600;         // 最长边缩到这个像素
const PHOTO_QUALITY  = 0.85;         // 照片的 JPEG 质量
const PHOTO_TEXT_QUALITY = 0.92;     // 截图的 JPEG 质量（满屏小字，压狠了会糊）
const PHOTO_SMALL_ENOUGH = 400000;   // 短于这个长度（约 300KB）就直接用，不折腾

function toDataURL(f){
  return new Promise((ok, no) => {
    const r = new FileReader();
    r.onerror = no;
    r.onload = () => {
      const url = r.result || "";
      if (!/^data:image\//.test(url)) return ok(url);        // 不是图片，别碰
      if (url.length < PHOTO_SMALL_ENOUGH) return ok(url);   // 本来就小
      const img = new Image();
      img.onerror = () => ok(url);                           // 解不开就原样传上去
      img.onload = () => {
        try{
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) return ok(url);
          const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(w, h));
          const c = document.createElement("canvas");
          c.width  = Math.max(1, Math.round(w * scale));
          c.height = Math.max(1, Math.round(h * scale));
          const ctx = c.getContext("2d");
          // 先铺一层白底：PNG 可能有透明的地方，JPEG 没有透明，
          // 不铺白底的话那些地方会变成黑的。
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          // **一律转 JPEG。** 早先的版本是"PNG 保持 PNG"，结果手机截图（PNG）
          // 压完反而更大，就退回原图了 —— 等于没压，白做。截图改用高一点的
          // 质量 0.92，满屏小字照样看得清。
          const isPng = /^data:image\/png/.test(url);
          const out = c.toDataURL("image/jpeg",
                                  isPng ? PHOTO_TEXT_QUALITY : PHOTO_QUALITY);
          ok(out.length < url.length ? out : url);           // 压完反而更大就用原来的
        }catch(e){ ok(url); }
      };
      img.src = url;
    };
    r.readAsDataURL(f);
  });
}

// 自己做的选照片按钮（浏览器自带的太丑）
// fp.onpick = f => {...}：选好照片之后回调一次 ——
// 交作业那张图靠它"自动让教练读一遍"，他就不用又发截图又手打了。
function filePicker(label){
  const LBL = label || "加一张照片";
  const wrap = el("div", "filepick");
  const input = el("input"); input.type = "file"; input.accept = "image/*";
  input.style.display = "none";
  const btn = el("button", "btn pickbtn", '<span class="ico">📷</span>' + LBL);
  btn.type = "button";
  const thumb = el("img", "thumb"); thumb.style.display = "none";
  const name = el("span", "filename", "");
  let objUrl = null;
  let chosen = null;          // ★ 选中的文件存在这儿，不再从 input.files 读 ——
                              //   因为"粘贴进来"的那张图**放不进 input.files**（只读）。
  const warn = el("span", "warn", "");

  // 真正"收下一张图"的地方：按钮选的、和 Ctrl+V 粘的，都走这里
  function show(f){
    if (objUrl){ URL.revokeObjectURL(objUrl); objUrl = null; }
    chosen = f || null;
    if (!f){
      name.textContent = ""; thumb.style.display = "none"; thumb.removeAttribute("src");
      btn.innerHTML = '<span class="ico">📷</span>' + LBL;
      if (fp.onpick) fp.onpick(null);
      return;
    }
    warn.textContent = "";
    name.textContent = f.name || "粘贴的图片";
    btn.innerHTML = '<span class="ico">🔄</span>换一张';
    if (/^image\//.test(f.type)){
      objUrl = URL.createObjectURL(f);       // 同步，立刻能显示
      thumb.src = objUrl;
      thumb.style.display = "block";
    }
    if (fp.onpick) fp.onpick(f);
  }

  const fp = {
    node: wrap,
    file: () => chosen,
    onpick: null,             // 调用方可以后设（它要拿到 ta / go 才能干活）
    setFile: show,            // 给"粘贴"用
    // 没选照片时点提交 → 按钮抖一下 + 红字提醒
    missing: (msg) => {
      warn.textContent = msg || "必须先拍照";
      btn.classList.add("shake");
      setTimeout(() => btn.classList.remove("shake"), 420);
      wrap.scrollIntoView({behavior:"smooth", block:"center"});
    }
  };
  btn.onclick = () => input.click();
  input.onchange = () => show(input.files[0] || null);
  wrap._fp = fp;              // 给下面的「粘贴」处理器认出这个框
  wrap.appendChild(input); wrap.appendChild(btn); wrap.appendChild(thumb); wrap.appendChild(name); wrap.appendChild(warn);
  return fp;
}

// 电脑上：从微信 / QQ 收到图 → 右键「复制」→ 在这个页面按 Ctrl+V，图直接进来，
// 不用先"另存为"再翻文件夹找它。（手机上用不着这个，有相册就够。）
// 只喂给**当前页面上看得见的第一个**选照片的框；一个都没有、或者剪贴板里不是图，就什么都不做。
document.addEventListener("paste", (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let f = null;
  for (let i = 0; i < items.length; i++){
    if (items[i].kind === "file" && /^image\//.test(items[i].type)){ f = items[i].getAsFile(); break; }
  }
  if (!f) return;
  const wraps = document.querySelectorAll(".filepick");
  for (let i = 0; i < wraps.length; i++){
    if (wraps[i].offsetParent !== null && wraps[i]._fp){
      e.preventDefault();
      wraps[i]._fp.setFile(f);
      return;
    }
  }
});

// 交作业：照片一选好就自动让教练读一遍，把它读到的填进「你具体做了什么」。
// **只填进输入框，不落盘** —— 他还能改，确认了再点「交作业，接受考核」。
function wirePhotoRead(t, ta, fp, note, go){
  fp.onpick = async (f) => {
    if (!f) return;
    note.textContent = "教练在读这张图…";
    busy(go, "教练在读这张图…", true);
    let done;
    try{
      done = (await api("/api/task/read",
                        {id: t.id, photo: await toDataURL(f)})).done;
    }catch(e){
      busy(go, "", false);
      note.textContent = e.message || "这张图没读出来，你自己写一句吧";
      return;
    }
    busy(go, "", false);
    if (!ta.value.trim()){
      ta.value = done;
      note.textContent = "（教练从这张图里读出来的，你可以改。）";
      return;
    }
    // 他自己已经写过了 —— 不覆盖他打的东西，只给一个替换的入口
    note.textContent = "图里读到的是：「" + done + "」 ";
    const rep = el("button", "btn btn-ghost", "用这句替换");
    rep.style.marginLeft = "6px";
    rep.onclick = () => { ta.value = done; note.textContent = "（已替换，你可以改。）"; };
    note.appendChild(rep);
  };
}

// ================= 加载 / 路由 =================
async function load(){
  STATE = await api("/api/state");
  render();
}

// 地址栏带 #task/3 就直接进那一项（浏览器后退键也能用）
function applyHash(){
  const m = /^#task\/(\d+)$/.exec(location.hash);
  const id = m ? parseInt(m[1], 10) : null;
  if (id !== curId){ curId = id; quiz = null; verdict = null; }
  render();
}

const VIEWS = {"": "today", "#today": "today", "#coach": "coach",
               "#calendar": "calendar", "#list": "list", "#summary": "summary",
               "#settings": "settings"};

function render(){
  $("#aiwarn").classList.toggle("hidden", STATE.ai_ready);
  $("#goal").textContent = STATE.goal ? "目标：" + STATE.goal : "";
  $("#streak").textContent = STATE.streak;

  const which = STATE.need_setup ? "setup"
              : (curId != null ? "task" : (VIEWS[location.hash] || "today"));
  // 任务详情是从清单里点进来的，所以那一页也让「清单」亮着
  const tab = which === "task" ? "list" : which;

  ["setup", "view-today", "view-list", "view-calendar", "view-summary",
   "view-coach", "view-task", "view-settings"]
    .forEach(id => $("#" + id).classList.add("hidden"));
  // 注意 #setup 的 id 不叫 "view-setup"，上面那串 hidden 里点名的是 "setup"。
  // **别写成 `if (which !== "setup")`** —— 那样写 #setup 会被上面加完 hidden 后
  // 永远没人来取消，整个页面一片空白（真踩过：任务清空后第一屏全白）。
  $("#" + (which === "setup" ? "setup" : "view-" + which)).classList.remove("hidden");

  $("#streakbox").classList.toggle("hidden", which === "setup");
  $("#seg").classList.toggle("hidden", which === "setup");
  [...$("#seg").children].forEach(a => a.classList.toggle("on", a.dataset.v === tab));

  // 一页画坏了不能把整个 App 拖死，更不能把报错吞掉。
  // （踩过：renderCoach 有一行读 STATE.chat.length，后台是旧版本时它是 undefined，
  //   一抛就把 doSend 里那句 alert 也一起吃掉 —— 表现成"点了发送没有用"。）
  const PAGES = {today: renderToday, coach: renderCoach, calendar: renderCalendar,
                 list: renderList, summary: renderSummary, task: renderTask,
                 settings: renderSettings};
  if (PAGES[which]){
    try{ PAGES[which](); }
    catch(err){
      console.error(err);
      const box = el("div", "card");
      box.appendChild(el("h2", null, "这一页画不出来"));
      box.appendChild(el("div", "mini", esc(err.message || String(err))));
      $("#view-" + which).appendChild(box);
    }
  }
}

// 换页只改 hash，剩下的交给 hashchange → applyHash → render。
// 已经在这一页时 hash 不变、事件不触发，所以手动 render 一下。
function goHash(h){
  if (location.hash === h) render(); else location.hash = h;
  window.scrollTo(0, 0);
}
function goTask(id){ goHash("#task/" + id); }
function goList(){ goHash("#list"); }
function goToday(){ goHash("#today"); }
function goCoach(){ coachScroll = true; goHash("#coach"); }
function goCalendar(){ goHash("#calendar"); }
function goSummary(){ goHash("#summary"); }

// ---------- 日期小工具 ----------
const pad2 = n => (n < 10 ? "0" : "") + n;
const ymd = d => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
// 别用 new Date("2026-10-10")：那是按 UTC 解析的，在东八区会差一天
function parseDay(s){
  const p = String(s || "").split("-").map(Number);
  return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
}
function minsText(v){                       // 200 -> "3 小时 20 分"
  if (v == null) return "—";
  const h = Math.floor(v / 60), m = v % 60;
  if (!h) return m + " 分";
  return h + " 小时" + (m ? " " + m + " 分" : "");
}
function fmtAt(s){ return String(s || "").replace("T", " ").slice(5, 16); }

// 日历上的标记：支线截止（蓝）+ 我自己标的重要日期（红）
function markMaps(){
  const due = {}, ev = {};
  (STATE.tasks || []).forEach(t => { if (t.due) (due[t.due] = due[t.due] || []).push(t.title); });
  (STATE.events || []).forEach(e => { if (e.date) (ev[e.date] = ev[e.date] || []).push(e.title); });
  return {due, ev};
}
function dotsFor(date, mm){
  const d = el("div", "dots");
  const du = mm.due[date] || [], e = mm.ev[date] || [];
  if (du.length) d.appendChild(el("i", "due"));
  if (e.length) d.appendChild(el("i", "ev"));
  // 那天有测试标了红/黄 —— 他明确要求"就在日历上显示出来"
  const mk = ((STATE.days || {})[date] || {}).marks || [];
  const red = mk.some(m => m.grade === "red"), amb = mk.some(m => m.grade === "amber");
  if (red) d.appendChild(el("i", "red"));
  else if (amb) d.appendChild(el("i", "amber"));
  const tip = [];
  if (du.length) tip.push("要交：" + du.join("、"));
  if (e.length) tip.push(e.join("、"));
  if (red) tip.push("没掌握：" + mk.filter(m => m.grade === "red").map(m => m.title).join("、"));
  if (amb) tip.push("一般：" + mk.filter(m => m.grade === "amber").map(m => m.title).join("、"));
  if (tip.length) d.title = tip.join("　");
  return d;
}

// 点评只在这一处发出去：先 busy，再请求，最后整页重载
async function runReview(btn, period, doing){
  busy(btn, doing, true);
  try{ await api("/api/review", {period}); }
  catch(e){ alert(e.message); busy(btn, "", false); return; }
  await load();
}

// ================= 今天（首页） =================
function byDue(a, b){
  if (!a.due && !b.due) return 0;
  if (!a.due) return 1;
  if (!b.due) return -1;
  return a.due < b.due ? -1 : 1;
}

let reflectWord = "";   // 教练对这份反思的一句话（只活在这一次会话里）

// ---- 今天的实时评分（后端算好的，不花 AI 的钱） ----
// **显示"已经拿到多少"，不显示"还差多少"** —— 一天的分数是往上长的，
// 早上摆在最上面一个"还差 48 分"只会让他把页面关掉。
function scoreCard(){
  const c = el("div", "card");
  const head = el("div", "cardhead");
  head.appendChild(el("h2", null, "今天的分数"));
  c.appendChild(head);

  const s = STATE.day_score;
  if (!s){
    c.appendChild(el("div", "mini",
      "今天还没有能算分的东西。交一项作业、或者记一下睡眠，这里就开始涨。"));
  } else {
    const line = el("div", "daynum");
    line.appendChild(el("span", "num", esc(s.total)));
    line.appendChild(el("span", "unit", "分"));
    if (s.bonus) line.appendChild(el("span", "plus", "（含反思 +" + esc(s.bonus) + "）"));
    c.appendChild(line);

    const bar = el("div", "bar");
    const fill = el("i");
    fill.style.width = Math.max(0, Math.min(100, s.total)) + "%";
    bar.appendChild(fill);
    c.appendChild(bar);

    c.appendChild(el("div", "dayparts", (s.parts || []).map(p =>
      esc(p.key) + " <b>" + esc(p.v) + "</b> 分（占 " + esc(p.w) + "%）").join("　·　")));
    c.appendChild(el("div", "mini",
      "这是<b>随时重算</b>的：还没交的项都没算进去，交一项涨一次。睡觉前看着它，还能补。"));
  }

  // ---- 自我反思（可写可不写） ----
  c.appendChild(el("div", "field-label", "今天的自我反思（可写可不写）"));
  const ta = el("textarea");
  ta.placeholder = "今天卡在哪、明天具体怎么改。别写口号 —— 写空话教练给 0 分。";
  if (reflectDraft == null) reflectDraft = (STATE.reflection || {}).text || "";
  ta.value = reflectDraft;
  ta.oninput = () => { reflectDraft = ta.value; };
  c.appendChild(ta);

  const has = ((STATE.reflection || {}).bonus || 0) > 0;
  const row = el("div", "btn-row");
  const go = el("button", "btn btn-pill", has ? "重写一遍，再让教练看" : "让教练看看");
  row.appendChild(go);
  c.appendChild(row);

  const note = el("div", "reflnote", "");
  function paintNote(){
    const b = (STATE.reflection || {}).bonus || 0;
    if (!b && !reflectWord){ note.innerHTML = ""; return; }
    note.innerHTML = (b ? "这份反思加了 <b>+" + esc(b) + "</b> 分。" : "")
      + (reflectWord ? " " + esc(reflectWord) : "");
  }
  paintNote();
  c.appendChild(note);

  if (!STATE.ai_ready){
    go.disabled = true;
    go.classList.add("dis");
    c.appendChild(el("div", "mini", "反思要教练看，得先把 AI 配上。"));
  } else {
    go.onclick = async () => {
      const text = ta.value.trim();
      busy(go, text ? "教练在看…" : "正在存…", true);
      let res;
      try{ res = await api("/api/reflect", {text}); }
      catch(e){ busy(go, "", false); alert(e.message); return; }
      busy(go, "", false);
      reflectDraft = text;
      reflectWord = res.word || "";
      await load();
      window.scrollTo({top: 0, behavior: "smooth"});
    };
  }
  return c;
}

function renderToday(){
  const host = $("#view-today");
  host.innerHTML = "";

  // 管家说（本地算的，不花 AI 的钱）
  const bc = el("div", "card butler");
  const bh = el("div", "cardhead");
  bh.appendChild(el("h2", null, "管家说"));
  const talk = el("button", "btn btn-pill", "跟教练说句话 ›");
  talk.onclick = goCoach;      // 两条路都能到教练页：页签，或者这儿
  bh.appendChild(talk);
  bc.appendChild(bh);
  bc.appendChild(el("div", "coach", esc(STATE.butler || "先去干活，我盯着。")));
  host.appendChild(bc);

  // 今天的实时评分 + 自我反思。**摆在最上面** —— 他要的是"随时能看见"，
  // 塞到列表底下就得滚到底才看得到，那不叫随时。
  host.appendChild(scoreCard());

  // 本周 + 迷你日历
  host.appendChild(weekCard());

  // 习惯：按「生活 / 坏习惯」分节。**三路分派** ——
  // screen 掉进 habitCard 的话，那个按钮 POST 的是 {done:true}，分钟数会被静默丢掉。
  const H = STATE.habits || [];
  const gMap = {}, gOrder = [];
  H.forEach(h => {
    const g = h.group || "生活";
    if (!gMap[g]){ gMap[g] = []; gOrder.push(g); }
    gMap[g].push(h);
  });
  const order = ["生活", "坏习惯"].filter(g => gMap[g]);
  gOrder.forEach(g => { if (order.indexOf(g) < 0) order.push(g); });
  order.forEach(g => {
    host.appendChild(el("div", "sechead", esc(g)));
    gMap[g].forEach(h => host.appendChild(
      h.kind === "sleep" ? sleepCard(h)
      : h.kind === "screen" ? screenCard(h)
      : habitCard(h)));
  });

  // 主线还没过的
  const undone = STATE.tasks.filter(t => t.line !== "支线" && !t.pass);
  if (undone.length){
    const c = el("div", "card");
    c.appendChild(el("h2", null, "主线 · 还没打勾 " + undone.length + " 项"));
    undone.slice(0, 6).forEach((t, i) => c.appendChild(taskRow(t, i + 1)));
    if (undone.length > 6)
      c.appendChild(el("div", "mini", "还有 " + (undone.length - 6) + " 项，点下面「全部清单」看。"));
    host.appendChild(c);
  }

  // 支线：快到期的在前
  const sides = STATE.tasks.filter(t => t.line === "支线" && !t.pass).sort(byDue);
  if (sides.length){
    const c = el("div", "card");
    c.appendChild(el("h2", null, "支线 · 要交的"));
    sides.forEach((t, i) => c.appendChild(taskRow(t, i + 1)));
    host.appendChild(c);
  }

  if (!undone.length && !sides.length){
    const c = el("div", "card");
    c.appendChild(el("div", "empty", "任务都打勾了。加新的，或者去「全部清单」看看记录。"));
    host.appendChild(c);
  }

  host.appendChild(todayCard());

  const fc = el("div", "card");
  const go = el("button", "btn btn-ghost", "全部清单和记录");
  go.onclick = goList;
  fc.appendChild(go);
  host.appendChild(fc);
}

// ---- 本周迷你日历条 ----
function weekCard(){
  const mm = markMaps();
  const c = el("div", "card");
  const head = el("div", "cardhead");
  head.appendChild(el("h2", null, "本周"));
  const more = el("button", "btn btn-pill", "看日历");
  more.onclick = goCalendar;
  head.appendChild(more);
  c.appendChild(head);

  const tStr = STATE.today;
  const t = parseDay(tStr);
  const mon = new Date(t.getFullYear(), t.getMonth(), t.getDate() - ((t.getDay() + 6) % 7));
  const WD = ["一", "二", "三", "四", "五", "六", "日"];
  const row = el("div", "week");
  for (let i = 0; i < 7; i++){
    const dd = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
    const key = ymd(dd);
    const cell = el("div", "wk" + (key === tStr ? " today" : ""));
    cell.appendChild(el("div", "wd", WD[i]));
    cell.appendChild(el("div", "wn", String(dd.getDate())));
    cell.appendChild(dotsFor(key, mm));
    const tips = (mm.due[key] || []).concat(mm.ev[key] || []);
    cell.title = key + (tips.length ? "　" + tips.join("、") : "");
    cell.onclick = goCalendar;
    row.appendChild(cell);
  }
  c.appendChild(row);
  return c;
}

// ---- 今天这一天的总评（手动点，才花 AI 的钱） ----
function todayCard(){
  const c = el("div", "card");
  const head = el("div", "cardhead");
  head.appendChild(el("h2", null, "今天的总评"));
  c.appendChild(head);

  const p = STATE.progress || {done: 0, total: 0};
  c.appendChild(el("div", "pnum", "<b>" + p.done + "</b> / " + p.total + " 项已完成"));

  const rev = (STATE.reviews || {})[(STATE.periods || {}).day];
  const row = el("div", "btn-row");
  const b = el("button", "btn " + (rev ? "btn-ghost" : "btn-primary"),
               rev ? "让教练重新点评今天" : "让教练点评今天");
  row.appendChild(b);
  c.appendChild(row);

  if (rev && rev.text){
    c.appendChild(el("div", "sumtext", esc(rev.text)));
    if (rev.at) c.appendChild(el("div", "sumwhen", "生成于 " + esc(fmtAt(rev.at))));
  } else {
    c.appendChild(el("div", "mini",
      "点一下，教练会把今天交了什么、哪几项没动、昨晚几点睡串起来说一段。"));
  }
  b.onclick = () => runReview(b, "day", "教练在看今天…");
  return c;
}

// ---- 睡眠卡（这是这一版的主角） ----
function sleepCard(h){
  const sum = h.sleep || {};
  const c = el("div", "card");
  const head = el("div", "habit-head");
  head.appendChild(el("h2", null, "睡眠"));
  if (sum.goal_bed) head.appendChild(el("span", "habit-target", "目标 " + esc(sum.goal_bed) + " 前睡"));
  c.appendChild(head);

  const base = h.today || h.last || {};
  const form = el("div", "sleepform");
  const bi = el("input"); bi.type = "time"; bi.value = base.bed || "23:30";
  const wi = el("input"); wi.type = "time"; wi.value = base.wake || "07:00";
  // 回车/点确认时原生 onChange 会触发，这里补上 input 事件，手机上也能实时看到
  form.appendChild(el("span", "til", "昨晚睡"));
  form.appendChild(bi);
  form.appendChild(el("span", "til", "早上起"));
  form.appendChild(wi);
  const save = el("button", "btn btn-primary", h.today ? "改一下" : "记下今天");
  form.appendChild(save);
  c.appendChild(form);

  const hint = el("div", "sleephint", "");
  const calc = () => {
    const b = bi.value, w = wi.value;
    if (!b || !w){ hint.textContent = ""; hint.className = "sleephint"; return; }
    const bm = (+b.slice(0, 2)) * 60 + (+b.slice(3));
    const wm = (+w.slice(0, 2)) * 60 + (+w.slice(3));
    const mins = (wm <= bm ? wm + 1440 : wm) - bm;
    const lvl = bm < 23 * 60 ? "ok" : (bm < 24 * 60 + 30 ? "mid" : "bad");
    hint.className = "sleephint " + lvl;
    hint.textContent = "睡了 " + (Math.round(mins / 6) / 10) + " 小时"
      + (lvl === "ok" ? "　这个点睡挺好" : lvl === "mid" ? "　有点晚" : "　太晚了");
  };
  ["input", "change"].forEach(ev => { bi.addEventListener(ev, calc); wi.addEventListener(ev, calc); });
  calc();
  c.appendChild(hint);

  // ---- 交截图：手表截图丢给 AI，它把入睡/起床读出来填进上面的框 ----
  const fp = shotRow(h, r => {
    if (r.bed) bi.value = r.bed;
    if (r.wake) wi.value = r.wake;
    calc();
    hint.className = "sleephint ok";
    hint.textContent = (r.note ? r.note + "　" : "") + "读出来了 —— 看一眼对不对，再点「记下今天」。";
  });
  c.appendChild(fp.node);
  c.appendChild(shotThumb(h.today));

  save.onclick = async () => {
    const f = fp.file();                       // 截图可选；没选新的就别管，后端会把旧那张继承下来
    busy(save, "记下…", true);
    try{
      await api("/api/habit/log", {id: h.id, bed: bi.value, wake: wi.value,
                                   photo: f ? await toDataURL(f) : null});
    }
    catch(e){ alert(e.message); busy(save, "", false); return; }
    busy(save, "", false);
    await load();
  };

  // ---- 14 天趋势：颜色看几点睡，高矮看睡多久 ----
  const chart = el("div", "sleepchart");
  const bars = el("div", "sleepbars");
  (sum.chart || []).forEach(d => {
    const col = el("div", "sbcol");
    const b = el("div", "sb " + (d.level || "none"));
    if (d.hours){
      b.style.height = Math.round(Math.max(.22, Math.min(1, (d.hours - 3) / 7)) * 100) + "%";
      b.title = d.date + "　" + d.bed + "–" + d.wake + "　睡了 " + d.hours + " 小时";
    } else {
      b.style.height = "8%";
      b.title = d.date + "　没记";
    }
    col.appendChild(b);
    bars.appendChild(col);
  });
  chart.appendChild(bars);

  const lg = el("div", "legend");
  [["ok", "23:00 前"], ["mid", "23:00–00:30"], ["bad", "00:30 后"], ["none", "没记"]]
    .forEach(p => lg.appendChild(el("span", null, '<i class="' + p[0] + '"></i>' + p[1])));
  chart.appendChild(lg);

  const facts = [];
  if (sum.avg_hours != null) facts.push("平均睡 " + sum.avg_hours + " 小时");
  if (sum.shift_min) facts.push(sum.shift_min > 0
    ? ("比上周早睡 " + sum.shift_min + " 分钟") : ("比上周晚睡 " + (-sum.shift_min) + " 分钟"));
  facts.push("近 " + (sum.total_days || 14) + " 天记了 " + (sum.logged_days || 0) + " 天");
  if (h.streak) facts.push("连着记 " + h.streak + " 天");
  chart.appendChild(el("div", "stat", esc(facts.join("　·　"))));

  if (!sum.goal_bed)
    chart.appendChild(el("div", "mini",
      "先老实记满 5 天，我就算出你的平均入睡时间，把目标定在比它早 15 分钟 —— 一次挪一点，不逼你。"));
  c.appendChild(chart);
  return c;
}

// ---- 别的习惯（比如运动）：只记做没做，不打分 ----
function habitCard(h){
  const c = el("div", "card");
  const head = el("div", "habit-head");
  head.appendChild(el("h2", null, esc(h.name)));
  if (h.streak) head.appendChild(el("span", "habit-target", "连着 " + h.streak + " 天"));
  c.appendChild(head);
  const bar = el("div", "habitbar");
  const done = !!(h.today && h.today.done);
  const btn = el("button", "btn " + (done ? "btn-ghost" : "btn-primary"),
                 done ? "今天记过了 ✓" : "今天也做了");
  btn.onclick = async () => {
    busy(btn, "记下…", true);
    try{ await api("/api/habit/log", {id: h.id, done: true}); }
    catch(e){ alert(e.message); busy(btn, "", false); return; }
    await load();
  };
  bar.appendChild(btn);
  if (h.target) bar.appendChild(el("span", "mini", esc(h.target)));
  c.appendChild(bar);
  return c;
}

// ---- 交截图这一行：睡眠和坏习惯共用 ----
function shotRow(h, onRead){
  const fp = filePicker(h.kind === "screen" ? "交屏幕使用时间截图" : "交手表截图");
  const read = el("button", "btn btn-pill", "让教练读这张图");
  read.type = "button";
  if (!STATE.ai_ready){
    read.disabled = true;
    read.textContent = "读图要先配 AI";
  }
  fp.node.appendChild(read);
  read.onclick = async () => {
    const f = fp.file();
    if (!f){ fp.missing("先选一张截图"); return; }
    busy(read, "教练在读这张图…", true);
    let r;
    try{ r = await api("/api/habit/read", {id: h.id, photo: await toDataURL(f)}); }
    catch(e){ alert(e.message); busy(read, "", false); return; }
    busy(read, "", false);
    onRead(r);
  };
  return fp;
}

// 今天已经交过的那张截图（点开看大图）
function shotThumb(log){
  const box = el("div", "filepick");
  box.style.marginTop = "12px";
  if (!(log && log.shot)){ box.classList.add("hidden"); return box; }
  const img = el("img", "thumb");
  img.src = "照片/" + encodeURIComponent(log.shot);
  img.onclick = () => window.open(img.src, "_blank");
  box.appendChild(img);
  box.appendChild(el("span", "filename", "今天交的截图（点开看大图）"));
  return box;
}

// ---- 坏习惯卡（碎片化娱乐）。跟睡眠卡同构，四处不同：数字框、矮=好、固定分母、自己的图例 ----
function screenCard(h){
  const sum = h.screen || {};
  const goal = sum.goal_min == null ? null : sum.goal_min;
  const c = el("div", "card");
  const head = el("div", "habit-head");
  head.appendChild(el("h2", null, esc(h.name)));
  if (goal != null) head.appendChild(el("span", "habit-target", "目标 " + minsText(goal) + "以内"));
  c.appendChild(head);

  const cur = (h.today && h.today.min != null) ? h.today.min : null;
  const form = el("div", "sleepform");
  const hi = el("input"); hi.type = "number"; hi.min = "0"; hi.max = "24"; hi.inputMode = "numeric";
  hi.value = cur == null ? "" : String(Math.floor(cur / 60));
  hi.placeholder = "0";
  const mi = el("input"); mi.type = "number"; mi.min = "0"; mi.max = "59"; mi.inputMode = "numeric";
  mi.value = cur == null ? "" : String(cur % 60);
  mi.placeholder = "0";
  form.appendChild(el("span", "til", "今天刷了"));
  form.appendChild(hi);
  form.appendChild(el("span", "til", "小时"));
  form.appendChild(mi);
  form.appendChild(el("span", "til", "分"));
  const save = el("button", "btn btn-primary", cur == null ? "记下今天" : "改一下");
  form.appendChild(save);
  c.appendChild(form);

  // 空着 = 没填；填了但看不懂 = -1
  const readMins = () => {
    const a = hi.value.trim(), b = mi.value.trim();
    if (a === "" && b === "") return null;
    const hh = a === "" ? 0 : parseInt(a, 10), qq = b === "" ? 0 : parseInt(b, 10);
    if (isNaN(hh) || isNaN(qq) || hh < 0 || qq < 0 || hh > 24 || qq > 59) return -1;
    return Math.min(1440, hh * 60 + qq);
  };

  const hint = el("div", "sleephint", "");
  const calc = () => {
    const v = readMins();
    if (v == null || v < 0){ hint.className = "sleephint"; hint.textContent = ""; return; }
    // 颜色只是"跟目标比一比"，**不是判过不过** —— 措辞里不许出现"失败/没过"
    let lvl = "";
    if (goal != null) lvl = v <= goal ? "ok" : (v <= goal * 1.5 ? "mid" : "bad");
    hint.className = "sleephint " + lvl;
    let tail;
    if (goal == null) tail = "　先记满一周，我按中位数给你定个够得着的数";
    else if (v < goal) tail = "　比目标少 " + minsText(goal - v);
    else if (v === goal) tail = "　正好卡在目标线上";
    else tail = "　比目标多了 " + minsText(v - goal);
    hint.textContent = "今天刷了 " + minsText(v) + tail;
  };
  ["input", "change"].forEach(ev => { hi.addEventListener(ev, calc); mi.addEventListener(ev, calc); });
  calc();
  c.appendChild(hint);

  const fp = shotRow(h, r => {
    if (r.h != null) hi.value = String(r.h);
    if (r.m != null) mi.value = String(r.m);
    calc();
    hint.className = "sleephint ok";
    hint.textContent = (r.note ? r.note + "　" : "") + "读出来了 —— 看一眼对不对，再点「记下今天」。";
  });
  c.appendChild(fp.node);
  c.appendChild(shotThumb(h.today));

  save.onclick = async () => {
    const v = readMins();
    if (v == null || v < 0){ hi.focus(); return; }
    const f = fp.file();
    busy(save, "记下…", true);
    try{
      await api("/api/habit/log", {id: h.id, minutes: v,
                                   photo: f ? await toDataURL(f) : null});
    }
    catch(e){ alert(e.message); busy(save, "", false); return; }
    busy(save, "", false);
    await load();
  };

  // ---- 14 天：**矮 = 好**。分母固定，不然目标一挪柱子就自己跳，趋势没法看 ----
  const barMax = sum.bar_max || 360;
  const chart = el("div", "sleepchart");
  const bars = el("div", "sleepbars");
  (sum.chart || []).forEach(d => {
    const col = el("div", "sbcol");
    const b = el("div", "sb " + (d.level || "none"));
    if (d.min == null){
      // **只有"没记"才是灰的。记了 0 分钟是最好的结果，得给一根看得见的绿柱**
      b.style.height = "8%";
      b.title = d.date + "　没记";
    } else {
      b.style.height = Math.round(Math.max(.07, Math.min(1, d.min / barMax)) * 100) + "%";
      b.title = d.date + "　刷了 " + minsText(d.min);
    }
    col.appendChild(b);
    bars.appendChild(col);
  });
  chart.appendChild(bars);

  const lg = el("div", "legend");
  [["ok", "达标"], ["mid", "多了一点"], ["bad", "多不少"], ["none", "没记"]]
    .forEach(p => lg.appendChild(el("span", null, '<i class="' + p[0] + '"></i>' + p[1])));
  chart.appendChild(lg);

  const facts = [];
  if (sum.avg_min != null) facts.push("最近 7 天平均 " + minsText(sum.avg_min));
  if (sum.shift_min != null) facts.push(
    sum.shift_min > 0 ? ("比上一周少刷 " + minsText(sum.shift_min))
    : sum.shift_min < 0 ? ("比上一周多刷 " + minsText(-sum.shift_min))
    : "跟上一周持平");
  facts.push("近 " + (sum.total_days || 14) + " 天记了 " + (sum.logged_days || 0) + " 天");
  if (h.streak) facts.push("连着记 " + h.streak + " 天");
  chart.appendChild(el("div", "stat", esc(facts.join("　·　"))));

  chart.appendChild(el("div", "mini", goal == null
    ? "只填<b>娱乐类</b> App（抖音、小红书、B站、游戏）的合计，别填全部屏幕时间 —— 数字虚高，目标就没意义了。"
    : "记满一周，我按中位数把目标往下挪 15 分钟。做到了就再挪，做不到就原地不动，不罚你。"));
  c.appendChild(chart);
  return c;
}

// ================= 清单页 =================
function renderList(){
  $("#pdone").textContent = STATE.progress.done;
  $("#ptotal").textContent = STATE.progress.total;
  $("#pbar").style.width = (STATE.progress.total ? STATE.progress.done / STATE.progress.total * 100 : 0) + "%";

  const box = $("#groups");
  box.innerHTML = "";

  // ---- 加一件事（老师布置的作业从这儿进来） ----
  box.appendChild(addTaskCard());

  // ---- 主线：按类别分组，类别顺序 = 第一次出现的顺序 ----
  const main = STATE.tasks.filter(t => t.line !== "支线");
  const order = [], byCat = {};
  main.forEach(t => {
    const c = t.cat || "未分类";
    if (!byCat[c]){ byCat[c] = []; order.push(c); }
    byCat[c].push(t);
  });
  order.forEach(cat => {
    const card = el("div", "card");
    const done = byCat[cat].filter(t => t.pass).length;
    card.appendChild(el("h2", null, "主线 · " + esc(cat) + " · " + done + "/" + byCat[cat].length));
    byCat[cat].forEach((t, i) => card.appendChild(taskRow(t, i + 1)));
    box.appendChild(card);
  });

  // ---- 支线 ----
  const sides = STATE.tasks.filter(t => t.line === "支线").sort(byDue);
  if (sides.length){
    const card = el("div", "card");
    const done = sides.filter(t => t.pass).length;
    card.appendChild(el("h2", null, "支线 · " + done + "/" + sides.length));
    sides.forEach((t, i) => card.appendChild(taskRow(t, i + 1)));
    box.appendChild(card);
  }

  // ---- 习惯（不打分，只管记） ----
  if ((STATE.habits || []).length){
    const card = el("div", "card");
    card.appendChild(el("h2", null, "习惯 · 不打分，只管记"));
    let lastG = null, firstG = true;
    STATE.habits.forEach(h => {
      const g = h.group || "生活";
      if (g !== lastG){
        const eb = el("div", "eyebrow", esc(g));
        if (!firstG) eb.style.marginTop = "16px";
        card.appendChild(eb);
        lastG = g; firstG = false;
      }
      const t = h.today || null, dn = !!t;
      const r = el("div", "task");
      // **坏习惯不给 ✓**：对勾看着就是"过关了"，而习惯本来就不判过不过。
      // 给个填色的圆点，只表示"今天记过了"。
      r.appendChild(el("div", "tick" + (dn ? " on" : ""),
                       (dn && h.kind !== "screen") ? "✓" : ""));
      const info = el("div", "ti");
      info.appendChild(el("div", "ti-title", esc(h.name)));
      let sub = "今天还没记";
      if (dn && h.kind === "sleep")
        sub = "昨晚 " + esc(t.bed) + "–" + esc(t.wake) + "　睡了 " + t.hours + " 小时";
      else if (dn && h.kind === "screen"){
        const gm = h.screen && h.screen.goal_min != null ? h.screen.goal_min : null;
        sub = "今天刷了 " + minsText(t.min) + (gm != null ? "（目标 " + minsText(gm) + "以内）" : "（目标还没定）");
      } else if (dn) sub = "今天记过了";
      info.appendChild(el("div", "ti-min", sub));
      r.appendChild(info);
      r.appendChild(el("span", "chev-r", "›"));
      r.onclick = goToday;
      card.appendChild(r);
    });
    box.appendChild(card);
  }

  if (!STATE.tasks.length && !(STATE.habits || []).length)
    box.appendChild(el("div", "card", '<div class="empty">清单是空的。</div>'));

  renderRecs();
}

// 刚加完一件事，教练那句「怎么塞进去」。放在模块级，这样重渲染之后还在。
let lastFit = null;

// ---- ＋ 加一件事。老师布置的作业、突然冒出来的事，都从这儿进 ----
function addTaskCard(){
  const c = el("div", "card");
  const head = el("div", "cardhead");
  head.appendChild(el("h2", null, "加一件事"));
  const toggle = el("button", "btn btn-pill", "＋ 加一件事");
  head.appendChild(toggle);
  c.appendChild(head);

  if (lastFit){
    const say = el("div", "coach");
    say.innerHTML = "<b>" + esc(lastFit.title) + "　教练说怎么塞进去：</b><br>" + esc(lastFit.say);
    c.appendChild(say);
  }

  const box = el("div", "hidden");
  const note = el("div", "mini", "老师布置的作业、突然冒出来的事，都从这儿进。有截止日的会排到「支线」。");
  note.style.marginTop = "0";
  c.appendChild(box);
  c.appendChild(note);
  toggle.onclick = () => {
    const open = box.classList.contains("hidden");
    box.classList.toggle("hidden", !open);
    note.classList.toggle("hidden", open);
    toggle.textContent = open ? "收起" : "＋ 加一件事";
    if (open) lastFit = null;
  };

  const ti = el("input"); ti.type = "text";
  ti.placeholder = "例如：社会心理学第 3 章读书笔记";
  const due = el("input"); due.type = "date";
  const row = el("div", "pickrow");
  const src = el("select");
  [["老师", "老师布置的"], ["我自己", "我自己想做的"]].forEach(p => {
    const o = el("option"); o.value = p[0]; o.textContent = p[1]; src.appendChild(o);
  });
  const cost = el("input"); cost.type = "text"; cost.placeholder = "大概要多久，例如 2 小时";
  row.appendChild(src); row.appendChild(cost);

  box.appendChild(el("div", "field-label", "什么事"));
  box.appendChild(ti);
  box.appendChild(el("div", "field-label", "什么时候交（没截止日就空着）"));
  box.appendChild(due);
  box.appendChild(el("div", "field-label", "谁布置的 / 大概要多久"));
  box.appendChild(row);

  const btns = el("div", "btn-row");
  const save = el("button", "btn btn-primary", "加进清单");
  btns.appendChild(save);
  box.appendChild(btns);

  save.onclick = async () => {
    const title = ti.value.trim();
    if (!title){ ti.focus(); return; }
    lastFit = null;
    busy(save, "加进去…", true);
    let r;
    try{
      r = await api("/api/task/add", {title, due: due.value,
                                      line: due.value ? "支线" : "主线", source: src.value});
    }
    catch(e){ alert(e.message); busy(save, "", false); return; }

    if (STATE.ai_ready){
      // 只问一句建议。**它一个字段都不改** —— 改不改由他自己按「改」决定。
      busy(save, "教练在看怎么排…", true);
      try{
        const fit = await api("/api/task/fit", {id: r.id, cost: cost.value.trim()});
        lastFit = {title: fit.title || title, say: fit.say};
      }catch(e){ /* 只是建议，拿不到就算了，别挡着他 */ }
    }
    await load();
  };
  return c;
}

function taskRow(t, num){
  const row = el("div", "task" + (t.pass ? " done" : ""));
  row.appendChild(el("div", "tick", "✓"));
  const info = el("div", "ti");
  info.appendChild(el("div", "ti-title", num + ". " + esc(t.title)));
  info.appendChild(el("div", "ti-min", t.floor_today
    ? "最低限度（<b>今天教练放行了</b>）：" + (esc(t.min) || "—")
    : "最低限度：" + (esc(t.min) || "—")));
  const next = (t.steps || []).find(s => !s.done);      // 把"下一步"直接摆出来
  if (next) info.appendChild(el("div", "ti-step", "→ " + esc(next.t)));
  row.appendChild(info);
  if (t.line === "支线" && t.due)
    row.appendChild(el("span", "due" + (t.overdue ? " overdue" : ""), esc(t.due.slice(5))));
  // 掌握标记：**做完了照样是"已完成"**，没掌握是另一件事，两个标并排挂
  const lg = t.last || null;
  const g = (lg && (lg.grade === "red" || lg.grade === "amber")) ? lg.grade : "";
  if (g) row.appendChild(el("span", "badge " + g, g === "red" ? "没掌握" : "一般"));
  if (t.pass) row.appendChild(el("span", "badge ok", "已完成"));
  else if (t.tries && lg && !lg.pass) row.appendChild(el("span", "badge no", "没过"));
  row.appendChild(el("span", "chev-r", "›"));
  row.onclick = () => goTask(t.id);
  return row;
}

// ================= 日历页 =================
let calMonth = null;    // {y, m} —— 正在看的月份
let calSel = null;      // 选中的那一天

function renderCalendar(){
  const host = $("#view-calendar");
  host.innerHTML = "";
  const mm = markMaps();
  const tStr = STATE.today;
  if (!calMonth){ const t = parseDay(tStr); calMonth = {y: t.getFullYear(), m: t.getMonth()}; }
  if (!calSel) calSel = tStr;

  const card = el("div", "card");
  const head = el("div", "calhead");
  const prev = el("button", "iconbtn", "‹");
  const next = el("button", "iconbtn", "›");
  prev.onclick = () => { calMonth.m--; if (calMonth.m < 0){ calMonth.m = 11; calMonth.y--; } renderCalendar(); };
  next.onclick = () => { calMonth.m++; if (calMonth.m > 11){ calMonth.m = 0; calMonth.y++; } renderCalendar(); };
  head.appendChild(prev);
  head.appendChild(el("div", "m", calMonth.y + " 年 " + (calMonth.m + 1) + " 月"));
  head.appendChild(next);
  card.appendChild(head);

  const grid = el("div", "cal");
  ["一", "二", "三", "四", "五", "六", "日"].forEach(w => grid.appendChild(el("div", "ch", w)));

  const lead = (new Date(calMonth.y, calMonth.m, 1).getDay() + 6) % 7;
  const total = new Date(calMonth.y, calMonth.m + 1, 0).getDate();
  for (let i = 0; i < lead; i++) grid.appendChild(el("div", "cell blank"));
  for (let d = 1; d <= total; d++){
    const key = ymd(new Date(calMonth.y, calMonth.m, d));
    const info = (STATE.days || {})[key];
    const cls = ["cell"];
    // 绿底 = 这天交过、而且**一项都没挂**。
    // 注意：这不是 all_pass_days()（那个的语义是"至少过了一项"，一碰就亮）。
    if (info && info.n > 0 && !info.f) cls.push("good");
    if (key === tStr) cls.push("today");
    if (key === calSel) cls.push("sel");
    const cell = el("div", cls.join(" "), String(d));
    cell.appendChild(dotsFor(key, mm));
    cell.onclick = () => { calSel = key; renderCalendar(); };
    grid.appendChild(cell);
  }
  card.appendChild(grid);

  const lg = el("div", "callegend");
  lg.appendChild(el("span", null,
    '<i style="background:rgba(52,199,89,.22);box-shadow:inset 0 0 0 1px rgba(52,199,89,.45)"></i>这天一项都没挂'));
  lg.appendChild(el("span", null, '<i class="due"></i>要交'));
  lg.appendChild(el("span", null, '<i class="ev"></i>我自己标的'));
  lg.appendChild(el("span", null,
    '<i style="background:var(--red);width:6px;height:6px"></i>测试没掌握'));
  card.appendChild(lg);
  host.appendChild(card);

  host.appendChild(dayDetail(calSel));
  host.appendChild(eventCard());
}

// 点开的那一天：交了什么、睡几点、刷多久
function dayDetail(key){
  const c = el("div", "card");
  c.appendChild(el("h2", null, key + " · 这天"));
  const info = (STATE.days || {})[key];
  const rows = [];

  (STATE.events || []).filter(e => e.date === key)
    .forEach(e => rows.push(["🔴", esc(e.title) + "（" + esc(e.kind) + "）"]));
  (STATE.tasks || []).filter(t => t.due === key)
    .forEach(t => rows.push(["🔵", esc(t.title) + " 要交" + (t.pass ? "（已交）" : "")]));

  (STATE.tasks || []).forEach(t => (t.subs || []).forEach(s => {
    if (s.date === key) rows.push([s.pass ? "✅" : "❌",
      esc(t.title) + (s.pass ? "　打勾" : "　没打勾") +
      (s.total != null && s.total !== "" ? "　" + esc(s.total) + " 分" : "")]);
  }));

  if (info){
    if (info.bed) rows.push(["🌙", "睡点 " + esc(info.bed) +
      (info.sl ? "　" + ({ok: "算早", mid: "有点晚", bad: "太晚"}[info.sl] || "") : "")]);
    if (info.sc != null) rows.push(["📱", "碎片化娱乐 " + minsText(info.sc)]);
    (info.marks || []).forEach(m => rows.push([m.grade === "red" ? "🔴" : "🟡",
      esc(m.title) + (m.grade === "red" ? "　没掌握，要回来重看" : "　一般，抽空再复习一遍")]));
    if (info.score != null) rows.push(["📊", "这天总评分 " + esc(info.score) + " 分"]);
  }

  if (!rows.length){
    c.appendChild(el("div", "empty", "这天什么都没记。"));
    return c;
  }
  rows.forEach(r => {
    const d = el("div", "rec");
    d.appendChild(el("span", "t", r[0] + "　" + r[1]));
    c.appendChild(d);
  });
  return c;
}

// 标一个重要日期
function eventCard(){
  const c = el("div", "card");
  c.appendChild(el("h2", null, "重要日期"));

  const evs = (STATE.events || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!evs.length){
    c.appendChild(el("div", "empty", "还没标过。考试、报名截止、答辩，标在这儿，日历上会亮起来。"));
  } else {
    evs.forEach(e => {
      const r = el("div", "task");
      r.style.cursor = "default";
      r.appendChild(el("span", "dot " + (e.date < STATE.today ? "gray" : "no")));
      const info = el("div", "ti");
      info.appendChild(el("div", "ti-title", esc(e.title)));
      info.appendChild(el("div", "ti-min", esc(e.date) + "　" + esc(e.kind)));
      r.appendChild(info);
      const del = el("button", "btn btn-ghost", "删掉");
      del.style.padding = "8px 15px";
      del.style.fontSize = "13px";
      del.onclick = async () => {
        busy(del, "", true);
        try{ await api("/api/event/delete", {id: e.id}); }
        catch(err){ alert(err.message); busy(del, "", false); return; }
        await load();
      };
      r.appendChild(del);
      c.appendChild(r);
    });
  }

  const form = el("div", "pickrow");
  const di = el("input"); di.type = "date"; di.value = calSel || STATE.today;
  const ti = el("input"); ti.type = "text"; ti.placeholder = "什么事，例如：专业课期末";
  const ks = el("select");
  ["考试", "截止", "其他"].forEach(v => { const o = el("option"); o.value = v; o.textContent = v; ks.appendChild(o); });
  const add = el("button", "btn btn-primary", "标上");
  form.appendChild(di); form.appendChild(ti); form.appendChild(ks); form.appendChild(add);
  c.appendChild(form);

  add.onclick = async () => {
    const title = ti.value.trim();
    if (!di.value){ alert("先选个日期"); return; }
    if (!title){ ti.focus(); return; }
    busy(add, "记上…", true);
    try{ await api("/api/event/add", {date: di.value, title, kind: ks.value}); }
    catch(e){ alert(e.message); busy(add, "", false); return; }
    await load();
  };
  return c;
}

// ================= 总结页 =================
function renderSummary(){
  const host = $("#view-summary");
  host.innerHTML = "";
  host.appendChild(summaryCard("day", "今天", false, "教练在看今天…"));
  host.appendChild(summaryCard("week", "本周", false, "教练在看这一周…"));
  host.appendChild(summaryCard("month", "本月", true, ""));
  host.appendChild(summaryCard("year", "今年", true, ""));
}

function summaryCard(period, label, locked, doing){
  const c = el("div", "card");
  const head = el("div", "cardhead");
  head.appendChild(el("h2", null, label));
  const b = el("button", "btn " + (locked ? "btn-ghost" : "btn-pill"), locked ? "先不用" : "生成");
  b.disabled = !!locked;
  head.appendChild(b);
  c.appendChild(head);

  const rev = locked ? null : (STATE.reviews || {})[(STATE.periods || {})[period]];

  if (locked){
    c.appendChild(el("div", "sumtext empty",
      "等数据攒够再开。现在生成，教练只能对着一堆空格说话，白花钱。"));
  } else if (rev && rev.text){
    c.appendChild(el("div", "sumtext", esc(rev.text)));
    if (rev.at) c.appendChild(el("div", "sumwhen", "生成于 " + esc(fmtAt(rev.at))));
    b.textContent = "重新生成";
  } else {
    c.appendChild(el("div", "sumtext empty", "还没生成。"));
  }

  b.onclick = () => runReview(b, period, doing);
  return c;
}

// ================= 教练页（跟教练说话的地方）=================
let chatDraft = "";              // 他正在打的字。render() 每次都重建 innerHTML，
                                 // 不存住的话，任何一个 background 的 load() 都会把它抹掉。
let coachScroll = false;         // 该不该在渲染后滚到底（刚进来 / 刚发完）

function askNode(a){
  const box = el("div", "ask");
  const t = (STATE.tasks || []).find(x => x.id === a.task_id);
  const title = a.title || (t ? t.title : "");
  const minv = a.min || (t ? t.min : "");
  if (a.status === "applied"){
    const d = el("div", "askdone");
    d.appendChild(el("span", null, "✅"));
    d.appendChild(el("span", null, "已放行 · 今天「" + esc(title) + "」做到最低限度就算数"));
    box.appendChild(d);
    return box;
  }
  if (a.status === "declined" || a.status === "expired"){
    box.appendChild(el("div", "askgone",
      esc(title) + " · " + (a.status === "expired" ? "过期了（超过一周没处理）" : "这次没放行")));
    return box;
  }
  // pending —— 还没处理
  box.appendChild(el("div", "lbl", "教练放行了这一项"));
  box.appendChild(el("div", "fl", esc(title) + (minv ? "\n最低限度：" + esc(minv) : "")));
  box.appendChild(el("div", "note",
    "这是你自己当初给这一项定的最低限度，不是教练现编的。"
    + "按了之后，今天这一项做到这一版就算数 —— 明天自动恢复原样。"));
  const row = el("div", "btn-row");
  const yes = el("button", "btn btn-primary", "行");
  const no = el("button", "btn btn-ghost", "今天不用");
  row.appendChild(yes); row.appendChild(no);
  yes.onclick = async () => {
    busy(yes, "改着…", true);
    try{ await api("/api/chat/apply", {ask_id: a.id}); busy(yes, "", false); }
    catch(e){ busy(yes, "", false); alert(e.message); return; }
    await load();
  };
  no.onclick = async () => {
    busy(no, "记着…", true);
    try{ await api("/api/chat/decline", {ask_id: a.id}); busy(no, "", false); }
    catch(e){ busy(no, "", false); alert(e.message); return; }
    await load();
  };
  box.appendChild(row);
  return box;
}

function renderCoach(){
  const host = $("#view-coach");
  const live = document.getElementById("saybox");
  if (live) chatDraft = live.value;        // 先把他正在打的字救下来
  host.innerHTML = "";

  const c = el("div", "card");
  const head = el("div", "cardhead");
  head.appendChild(el("h2", null, "教练"));
  const st = STATE.floor || {used: 0, last: null, limit: 0};
  let led = "本月放行 " + st.used + " 次";
  if (st.limit) led = "本月放行 " + st.used + "/" + st.limit + " 次";
  if (st.last) led += " · 最近 " + st.last.slice(5);
  head.appendChild(el("span", "ledger", led));
  c.appendChild(head);

  const thread = el("div", "thread");

  // 放行卡片挂在它对应的那条教练消息下面。**落在窗口外的 pending 必须补渲染** ——
  // 只按对话条数画的话，会出现"看得见但点不动"，或者"看不见却还能按"。
  const asks = STATE.asks || [];
  const byMsg = {};
  asks.forEach(a => {
    if (a && a.msg_id != null) (byMsg[a.msg_id] = byMsg[a.msg_id] || []).push(a);
  });
  const placed = {};

  (STATE.chat || []).forEach(m => {
    const isMe = m.role === "user";
    const w = el("div", "msg " + (isMe ? "me" : "coach"));
    const b = el("div", "bub" + (isMe && m.failed ? " failed" : ""), esc(m.text));
    b.title = fmtAt(m.at) + (isMe && m.failed ? "（这句没送到教练）" : "");
    w.appendChild(b);
    thread.appendChild(w);
    if (!isMe){
      (byMsg[m.id] || []).forEach(a => { placed[a.id] = 1; thread.appendChild(askNode(a)); });
    }
  });
  asks.filter(a => a.status === "pending" && !placed[a.id])
      .forEach(a => { placed[a.id] = 1; thread.appendChild(askNode(a)); });

  if (!thread.children.length){
    const note = el("div", "coachnote",
      "这里是你跟教练说话的地方。\n\n"
      + "有急事、今天状态烂、某一项想少做点 —— 都在这儿说。\n\n"
      + "教练只有一把扳手：允许你某一项今天做到最低限度就算数。"
      + "最低限度是你当初自己写的，不是它现编的。它改不了截止日，也删不了任务。\n\n"
      + "它可以拒绝你。");
    thread.appendChild(note);
  }
  c.appendChild(thread);

  // ---- 输入区 ----
  const say = el("div", "saybox");
  if (STATE.ai_ready){
    const row = el("div", "sayrow");
    const ta = el("textarea");
    ta.id = "saybox"; ta.rows = 1;
    ta.placeholder = "说说今天怎么回事…（Enter 发送，Shift+Enter 换行）";
    ta.value = chatDraft;
    ta.maxLength = 1000;
    const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 132) + "px"; };
    ta.oninput = () => { chatDraft = ta.value; fit(); };
    const send = el("button", "btn btn-primary", "发送");

    const doSend = async () => {
      const v = ta.value.trim();
      if (!v || send.disabled) { if (!v) ta.focus(); return; }
      chatDraft = "";
      // 立刻回显 + 「教练在想…」：AI 要 10-30 秒，不给反馈他会以为卡死了
      const w = el("div", "msg me");
      w.appendChild(el("div", "bub", esc(v)));
      thread.appendChild(w);
      const th = el("div", "thinking");
      th.appendChild(el("span", "spinner"));
      th.appendChild(el("span", null, "教练在想…"));
      thread.appendChild(th);
      th.scrollIntoView({block: "end"});
      ta.value = ""; fit();
      busy(send, "发送中…", true);
      try{
        await api("/api/chat/say", {text: v});
        busy(send, "", false);
        coachScroll = true;
        await load();
      }catch(e){
        busy(send, "", false);
        // **先报错，再刷新** —— 反过来的话，只要 load() 自己出了任何岔子，
        // 这句 alert 就永远执行不到，他就只看到"点了发送没有用"。
        alert(e.message);       // 他这句话已经存住了，只是教练没回上
        coachScroll = true;
        await load();
      }
    };

    ta.onkeydown = ev => {
      if (ev.key === "Enter" && !ev.shiftKey){ ev.preventDefault(); doSend(); }
    };
    send.onclick = doSend;
    row.appendChild(ta); row.appendChild(send);
    say.appendChild(row);
  } else {
    say.appendChild(el("div", "coachnote", "跟教练说话要先配 AI —— 上面那个密钥框填一下。"));
  }
  c.appendChild(say);
  host.appendChild(c);

  const tael = document.getElementById("saybox");
  if (tael && !(STATE.chat || []).length) tael.focus();
  if (coachScroll){ coachScroll = false; window.scrollTo(0, document.body.scrollHeight); }
}

// ================= 任务详情页 =================
function renderTask(){
  const t = STATE.tasks.find(x => x.id === curId);
  const host = $("#view-task");
  host.innerHTML = "";
  if (!t){ curId = null; render(); return; }

  const back = el("button", "back", '<span class="chev">‹</span> 任务清单');
  back.onclick = goList;
  host.appendChild(back);

  if (verdict && verdict.id === t.id) host.appendChild(verdictCard(verdict));

  // ---- 这一项是什么 ----
  const head = el("div", "card");
  head.appendChild(el("span", "tag", esc(t.cat || "未分类")));
  head.appendChild(el("div", "dtitle", esc(t.title)));
  if (t.min) head.appendChild(el("div", "mini", t.floor_today
    ? "最低限度（<b>今天教练放行了</b>）：" + esc(t.min)
    : "最低限度：" + esc(t.min)));
  if (t.why) head.appendChild(el("div", "mini", "教练说：" + esc(t.why)));
  const st = el("div", "status-line");
  st.appendChild(el("span", "dot " + (t.pass ? "ok" : "gray")));
  const stxt = el("span", "mini", t.pass
    ? ("已完成 · 打勾了" + (t.passed_date ? " · " + t.passed_date : ""))
    : (t.tries ? "还没打勾 · 已交 " + t.tries + " 次" : "还没开始"));
  stxt.style.marginTop = "0";
  st.appendChild(stxt);
  head.appendChild(st);
  const gl = grademark(t.last && t.last.grade);
  if (gl) head.appendChild(el("div", "mini", gl === "red"
    ? "🔴 上次测试没掌握 —— 这一项要回来重新理解一遍。"
    : "🟡 上次测试一般 —— 抽空再复习一遍。"));
  if (t.line === "支线" && t.due)
    head.appendChild(el("div", "mini", "截止：" + esc(t.due) + (t.overdue ? "　（已经过期了）" : "")));
  host.appendChild(head);

  // ---- 这一项怎么做（可执行的步骤） ----
  if ((t.steps || []).length){
    const sc = el("div", "card");
    sc.appendChild(el("h2", null, "这一项怎么做"));
    t.steps.forEach((s, i) => {
      const row = el("div", "step" + (i === 0 ? " first" : "") + (s.done ? " done" : ""));
      const box = el("span", "stepbox", s.done ? "✓" : "");
      row.appendChild(box);
      row.appendChild(el("div", "steptext", esc(s.t)));
      row.onclick = async () => {
        const want = !s.done;
        try{ await api("/api/step/toggle", {id: t.id, index: i, done: want}); }
        catch(e){ return; }
        s.done = want;
        row.classList.toggle("done", want);
        box.textContent = want ? "✓" : "";
      };
      sc.appendChild(row);
    });
    sc.appendChild(el("div", "mini", "点一下就打个勾。第一步是让你今天就能动手的那一步 —— 先做它，别往下看。"));
    host.appendChild(sc);
  } else if (STATE.ai_ready){
    const sc = el("div", "card");
    sc.appendChild(el("h2", null, "这一项怎么做"));
    sc.appendChild(el("div", "mini", "这一项还没有拆开，只知道要做，不知道今天先干什么。让教练拆一下。"));
    const b = el("button", "btn btn-pill", "让教练拆成能上手的步骤");
    b.style.marginTop = "12px";
    b.onclick = async () => {
      busy(b, "教练在拆…", true);
      try{ await api("/api/task/steps", {id: t.id}); }
      catch(e){ alert(e.message); busy(b, "", false); return; }
      await load();
    };
    sc.appendChild(b);
    host.appendChild(sc);
  }

  // ---- 考核中 ----
  if (quiz && quiz.id === t.id){
    const qc = el("div", "card");
    qc.appendChild(el("h2", null, "教练考核"));
    quiz.items.forEach((it, i) => {
      const d = el("div", "q");
      const head = el("div", "qhead");
      head.appendChild(el("span", "kind " + (it.kind === "talk" ? "talk" : "ask"),
                          it.kind === "talk" ? "聊聊" : "检验"));
      head.appendChild(el("span", "qt", (i + 1) + ". " + esc(it.text)));
      d.appendChild(head);
      const a = el("textarea");
      a.dataset.q = it.text; a.dataset.kind = it.kind;
      a.placeholder = it.kind === "talk" ? "用你自己的话说说……说错也没关系，别说套话" : "你的回答…";
      d.appendChild(a);
      qc.appendChild(d);
    });
    const row = el("div", "btn-row");
    const sub = el("button", "btn btn-primary", "提交作答");
    const cancel = el("button", "btn btn-ghost", "退出考核");
    row.appendChild(sub); row.appendChild(cancel);
    qc.appendChild(row);
    host.appendChild(qc);

    cancel.onclick = () => { quiz = null; render(); };

    sub.onclick = async () => {
      const qa = [...qc.querySelectorAll(".q")].map(q => ({
        q: q.querySelector("textarea").dataset.q,
        kind: q.querySelector("textarea").dataset.kind,
        a: q.querySelector("textarea").value.trim()
      }));
      busy(sub, "教练在看…", true);
      let res;
      try{ res = await api("/api/grade", {title: t.title, min: t.min, done: quiz.done, qa}); }
      catch(e){ alert(e.message); busy(sub, "", false); return; }

      let photo = null;
      if (quiz.file) photo = await toDataURL(quiz.file);
      try{ await api("/api/submit", {
        id: t.id, done: quiz.done, pass: res.pass, reason: res.reason,
        work: res.work, test: res.test, over: res.over, total: res.total,
        grade: res.grade, coach: res.coach, photo
      }); }
      catch(e){ alert(e.message); }

      quiz = null;
      verdict = {id: t.id, pass: res.pass, reason: res.reason, coach: res.coach,
                 work: res.work, test: res.test, over: res.over, total: res.total,
                 grade: res.grade};
      await load();
      window.scrollTo(0, 0);
    };
    return;
  }

  // ---- 交作业 ----
  if (!t.pass){
    const sc = el("div", "card");
    sc.appendChild(el("h2", null, "交作业"));
    sc.appendChild(el("div", "field-label", "你具体做了什么？（写了什么、做了几页、看懂了什么）"));
    const ta = el("textarea");
    ta.placeholder = "例如：读了第 1 章，讲了心理学为什么不是常识，还讲了可证伪性……";
    sc.appendChild(ta);
    sc.appendChild(el("div", "field-label", "拍张照（必须）"));
    const fp = filePicker();
    sc.appendChild(fp.node);
    const note = el("div", "mini readnote", "");
    sc.appendChild(note);

    const row = el("div", "btn-row");
    const go = el("button", "btn btn-primary", "交作业，接受考核");
    row.appendChild(go);
    sc.appendChild(row);
    sc.appendChild(el("div", "mini", "照片选好之后教练会先读一遍，把「你具体做了什么」帮你填上（你还能改）。然后它考这一项——几道检验题，再加几道让你用自己的话讲讲理解，题量看内容多少定。做到最低限度这项就打勾；测试答得不好不会不给你打勾，但会标出来让你回头重看。"));
    wirePhotoRead(t, ta, fp, note, go);
    go.onclick = () => startQuiz(t, ta, fp, go);
    host.appendChild(sc);
  } else {
    const dc = el("div", "card");
    dc.appendChild(el("div", "mini", grademark(t.last && t.last.grade) === "red"
      ? "这一项打勾了，但上次测试没掌握 —— 回头把这块重新理解一遍，理解了再交一次就行。"
      : (grademark(t.last && t.last.grade) === "amber"
        ? "这一项打勾了，上次测试一般 —— 抽空再复习一遍。"
        : "这一项已经打勾了。")));
    const again = el("button", "btn btn-ghost", "这一项还想再交一次");
    again.style.marginTop = "14px";
    again.onclick = () => { const c = again.closest(".card"); c.replaceWith(buildSubmitCard(t)); };
    dc.appendChild(again);
    host.appendChild(dc);
  }

  // ---- 这一项的记录 ----
  const hc = el("div", "card");
  hc.appendChild(el("h2", null, "这一项的记录"));
  if (!t.subs || !t.subs.length) hc.appendChild(el("div", "empty", "还没有记录。"));
  else [...t.subs].reverse().forEach((s, i) => hc.appendChild(subRow(s, i === 0)));
  host.appendChild(hc);
}

function buildSubmitCard(t){
  const sc = el("div", "card");
  sc.appendChild(el("h2", null, "交作业"));
  sc.appendChild(el("div", "field-label", "你具体做了什么？"));
  const ta = el("textarea");
  sc.appendChild(ta);
  sc.appendChild(el("div", "field-label", "拍张照（必须）"));
  const fp = filePicker();
  sc.appendChild(fp.node);
  const note = el("div", "mini readnote", "");
  sc.appendChild(note);
  const row = el("div", "btn-row");
  const go = el("button", "btn btn-primary", "交作业，接受考核");
  row.appendChild(go);
  sc.appendChild(row);
  wirePhotoRead(t, ta, fp, note, go);
  go.onclick = () => startQuiz(t, ta, fp, go);
  return sc;
}

async function startQuiz(t, ta, fp, btn){
  const done = ta.value.trim();
  if (!done){ ta.focus(); return; }
  if (!fp.file()){ fp.missing(); return; }
  busy(btn, "教练出题中…", true);
  let items;
  try{ items = (await api("/api/quiz", {title: t.title, min: t.min, done})).items; }
  catch(e){ alert(e.message); busy(btn, "", false); return; }
  if (!items || !items.length){ alert("教练没出题，再试一次"); busy(btn, "", false); return; }
  quiz = {id: t.id, items, done, file: fp.file()};
  verdict = null;
  render();
  window.scrollTo(0, 0);
}

// 判卷结果：总分 + 两半边 + 掌握标记 + 教练的话
function grademark(g){
  return g === "red" ? "red" : g === "amber" ? "amber" : "";
}

function verdictCard(v){
  const c = el("div", "verdict " + (v.pass ? "ok" : "no"));
  c.appendChild(el("div", "big", v.pass ? "✅ 这一项打勾了" : "❌ 这一项还没打勾"));

  if (v.total != null && v.total !== ""){
    const line = el("div", "scoreline");
    line.appendChild(el("span", "num", esc(v.total)));
    line.appendChild(el("span", "unit", "分" + (v.over ? "（含超额 +" + esc(v.over) + "）" : "")));
    c.appendChild(line);
  }
  const parts = [];
  if (v.work != null) parts.push("拍照 + 完成 " + esc(v.work) + " / 50");
  if (v.test != null) parts.push("测试 " + esc(v.test) + " / 50");
  if (parts.length) c.appendChild(el("div", "parts", parts.join("　·　")));

  const g = grademark(v.grade);
  if (g) c.appendChild(el("div", "mini", g === "red"
    ? "🔴 这一项没掌握 —— 后面几天的表里会带上它，回头重看一遍。"
    : "🟡 这一项一般 —— 回头复习一遍。"));

  if (v.reason) c.appendChild(el("div", "mini", "为什么：" + esc(v.reason)));
  if (v.coach) c.appendChild(el("div", "coach", esc(v.coach)));
  return c;
}

function subRow(s, isLatest){
  const d = el("div", "rec");
  d.appendChild(el("span", "dot " + (s.pass ? "ok" : "no")));
  const mid = el("div"); mid.style.flex = "1"; mid.style.minWidth = "0";
  const line = el("div");
  line.appendChild(el("span", "d", esc(s.date) + "　"));
  line.appendChild(el("span", "t", (s.pass ? "打勾" : "没打勾")
    + (s.total != null && s.total !== "" ? " · " + esc(s.total) + " 分" : "")));
  const gg = grademark(s.grade);
  if (gg) line.appendChild(el("span", "badge " + gg, gg === "red" ? "没掌握" : "一般"));
  mid.appendChild(line);
  const bits = [];
  if (s.work != null) bits.push("完成 " + s.work + "/50");
  if (s.test != null) bits.push("测试 " + s.test + "/50");
  if (s.over) bits.push("超额 +" + s.over);
  if (s.reason) bits.push(s.reason);
  if (bits.length) mid.appendChild(el("div", "note", esc(bits.join("　·　"))));
  if (isLatest && s.coach){ mid.appendChild(el("div", "coach", esc(s.coach))); d.classList.add("tall"); }
  d.appendChild(mid);
  const right = el("div", "recright");
  if (s.photo){
    const img = el("img"); img.src = "照片/" + encodeURIComponent(s.photo);
    img.onclick = () => window.open(img.src, "_blank");
    right.appendChild(img);
  }
  if (right.children.length) d.appendChild(right);
  return d;
}

// ================= 全部记录 =================
function renderRecs(){
  const box = $("#recs");
  box.innerHTML = "";
  if (!STATE.recent.length){ box.appendChild(el("div", "empty", "还没有记录。今天，从第一项开始。")); return; }
  const seen = {};
  STATE.recent.forEach(r => { seen[r.id] = true; });
  STATE.recent.slice(0, 25).forEach(r => {
    const d = el("div", "rec");
    d.appendChild(el("span", "dot " + (r.pass ? "ok" : "no")));
    d.appendChild(el("span", "d", esc(r.date)));
    d.appendChild(el("span", "t", esc(r.title)));
    if (r.photo){
      const img = el("img"); img.src = "照片/" + encodeURIComponent(r.photo);
      img.onclick = () => window.open(img.src, "_blank");
      d.appendChild(img);
    }
    d.style.cursor = "pointer";
    d.onclick = () => goTask(r.id);
    box.appendChild(d);
  });
}

// ================= 在界面里配钥匙 =================
$("#keysave").onclick = async () => {
  const key = $("#keyinput").value.trim();
  const msg = $("#keymsg"), btn = $("#keysave");
  msg.className = "keymsg"; msg.textContent = "";
  if (!key){ $("#keyinput").focus(); msg.className = "keymsg bad"; msg.textContent = "先粘贴密钥"; return; }
  busy(btn, "保存中…", true);
  try{
    const r = await api("/api/key", {key});
    if (r.ai_ready){
      msg.className = "keymsg ok";
      msg.textContent = "✅ 配好了。现在可以用了。";
      $("#keyinput").value = "";
      setTimeout(() => { $("#aiwarn").classList.add("hidden"); }, 900);
      await load();
    } else {
      msg.className = "keymsg bad";
      msg.textContent = "没保存成功，再试一次";
    }
  }catch(e){
    msg.className = "keymsg bad";
    msg.textContent = "❌ " + e.message;
  }
  busy(btn, "", false);
};
$("#keyinput").onkeydown = e => { if (e.key === "Enter") $("#keysave").click(); };

$("#back-today").onclick = goToday;

// ================= 定制流程 =================
$("#btn-manual").onclick = () => {
  planDraft = { goal: $("#s-goal").value.trim(),
                tasks: [{title:"",min:"",why:"",cat:"",line:"主线",due:"",steps:[]},
                        {title:"",min:"",why:"",cat:"",line:"主线",due:"",steps:[]}] };
  renderPreview();
};

$("#btn-plan").onclick = async () => {
  const goal = $("#s-goal").value.trim();
  if (!goal){ $("#s-goal").focus(); return; }
  const btn = $("#btn-plan");
  busy(btn, "教练在定任务…", true);
  let res;
  try{ res = await api("/api/plan", {goal, situation: $("#s-situation").value.trim(), time: $("#s-time").value.trim()}); }
  catch(e){ alert(e.message); busy(btn, "", false); return; }
  busy(btn, "", false);
  planDraft = res;
  renderPreview();
};

function renderPreview(){
  const box = $("#plan-preview");
  box.innerHTML = "";
  const card = el("div", "card");
  card.appendChild(el("h2", null, "教练定的清单 · 不满意就改"));

  card.appendChild(el("div", "field-label", "目标（一句话）"));
  const gi = el("input"); gi.type = "text"; gi.value = planDraft.goal || "";
  gi.oninput = () => planDraft.goal = gi.value;
  card.appendChild(gi);

  const list = el("div"); list.style.marginTop = "18px";
  card.appendChild(list);

  const draw = () => {
    list.innerHTML = "";
    planDraft.tasks.forEach((t, i) => {
      const d = el("div", "q");
      d.appendChild(el("div", "qt", "第 " + (i + 1) + " 项"));
      const ti = el("input"); ti.type = "text"; ti.value = t.title || ""; ti.placeholder = "任务名";
      ti.oninput = () => t.title = ti.value;
      d.appendChild(ti);
      const mi = el("input"); mi.type = "text"; mi.value = t.min || ""; mi.placeholder = "最低限度";
      mi.style.marginTop = "9px"; mi.oninput = () => t.min = mi.value;
      d.appendChild(mi);
      const ci = el("input"); ci.type = "text"; ci.value = t.cat || ""; ci.placeholder = "类别（同类别的会分到一组）";
      ci.style.marginTop = "9px"; ci.oninput = () => t.cat = ci.value;
      d.appendChild(ci);

      // 主线 / 支线（支线要填截止日）
      const lw = el("div", "sleepform");
      lw.style.marginTop = "9px";
      const ls = el("select");
      ["主线", "支线"].forEach(v => {
        const o = el("option"); o.value = v; o.textContent = v; ls.appendChild(o);
      });
      ls.value = t.line === "支线" ? "支线" : "主线";
      ls.onchange = () => { t.line = ls.value; draw(); };
      lw.appendChild(ls);
      if (ls.value === "支线"){
        lw.appendChild(el("span", "til", "截止"));
        const du = el("input"); du.type = "date"; du.value = t.due || "";
        du.onchange = () => t.due = du.value;
        lw.appendChild(du);
      }
      d.appendChild(lw);

      // 步骤：一行一步。第一行就是"今天先干什么"
      d.appendChild(el("div", "field-label", "步骤（一行一步，第一步要今天就能动手）"));
      const st = el("textarea");
      st.className = "stepsbox";
      st.value = (t.steps || []).map(s => (typeof s === "string" ? s : (s.t || ""))).join("\n");
      st.placeholder = "翻到目录，把没听过的概念圈出来（10 分钟）\n只读这几个概念所在的页\n合上书，在纸上用自己的话写一遍";
      st.oninput = () => t.steps = st.value.split("\n").map(x => x.trim()).filter(Boolean);
      d.appendChild(st);

      if (t.why) d.appendChild(el("div", "mini", t.why));
      const del = el("button", "btn btn-ghost", "删掉这项");
      del.style.marginTop = "11px";
      del.onclick = () => { planDraft.tasks.splice(i, 1); draw(); };
      d.appendChild(del);
      list.appendChild(d);
    });
  };
  draw();

  const add = el("button", "btn btn-pill", "＋ 我自己加一项");
  add.onclick = () => { planDraft.tasks.push({title:"",min:"",why:"",cat:"",line:"主线",due:"",steps:[]}); draw(); };

  const row = el("div", "btn-row");
  const save = el("button", "btn btn-primary", "就按这个来");
  const redo = el("button", "btn btn-ghost", "重新让教练定");
  row.appendChild(save); row.appendChild(redo); row.appendChild(add);
  card.appendChild(row);

  save.onclick = async () => {
    const clean = planDraft.tasks.filter(t => (t.title || "").trim());
    if (!clean.length){ alert("清单是空的"); return; }
    busy(save, "保存中…", true);
    try{ await api("/api/plan/save", {goal: planDraft.goal, tasks: clean}); }
    catch(e){ alert(e.message); busy(save, "", false); return; }
    planDraft = null;
    box.innerHTML = "";
    await load();
  };
  redo.onclick = () => { planDraft = null; box.innerHTML = ""; $("#btn-plan").click(); };

  box.appendChild(card);
  card.scrollIntoView({behavior: "smooth", block: "nearest"});
}

window.addEventListener("hashchange", () => { if (STATE.tasks !== undefined) applyHash(); });

(async () => {
  try{
    STATE = await api("/api/state");
    applyHash();
  }catch(e){ alert(e.message); }
})();
