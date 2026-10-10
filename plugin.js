// ============================================================
// OneTHU 插件 · 一键发送 niko 烂梗
// author: smartThis · 个人娱乐插件（非官方，勿上市场）
//
// 烂梗来源：sb6657.cn（玩机器烂梗收集）公开接口
// 发送通道：斗鱼弹幕 WebSocket 协议（登录 Cookie）
// 仅供娱乐，请勿刷屏。使用后果自负。
// ============================================================

export const manifest = {
  id: "onethu.niko",
  kind: "js",
  name: "一键发送 niko 烂梗",
  version: "0.1.0",
  author: "smartThis",
  description: "从 sb6657.cn（玩机器烂梗收集）随手捞一条烂梗，用你的斗鱼登录态经弹幕协议发进直播间（默认玩机器 6657，有等级墙）。纯搞笑，慎发。",
  permissions: ["net:external", "ui"],
  settings: [
    { key: "cookie", label: "斗鱼 Cookie（须含 dy_did/acf_uid/acf_stk/acf_ltkid）", type: "textarea", default: "", placeholder: "登录 douyu.com 后，DevTools → 网络 → 任意请求头 Cookie 整串复制粘到这里" },
    { key: "roomId", label: "目标房间号", type: "text", default: "6657", placeholder: "6657" },
    { key: "minInterval", label: "两次发送最小间隔（秒）", type: "text", default: "30", placeholder: "30" },
  ],
};

// ---------------- 常量 ----------------
const SB7 = "https://api.hguofichp.cn";
const SB7_RAND = SB7 + "/machine/getRandOne";
const SB7_HOT = SB7 + "/machine/hotBarrageOf24H";
const SB7_SHIELD = SB7 + "/machine/getShieldWordDict";

const WSPROXY_URL = "wss://wsproxy.douyu.com:6673/";
const VK_SECRET = "r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p[";
const VER = "20220825";
const AVER = "218101901";
const MSG_TYPE_SEND = 689;

let ctxref = null; // activate 时注入
let lastSendAt = 0; // 冷却用

class StepError extends Error {
  constructor(step, detail) { super(step + "：" + detail); this.step = step; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const closeQuiet = (ws) => { try { ws && ws.close(); } catch { /* noop */ } };

// ---------------- 斗鱼 STT 编解码（与 ordinaryroad-live-chat-client 同源实测） ----------------
const esc = (s) => String(s ?? "").replaceAll("@", "@A").replaceAll("/", "@S");
const unesc = (s) => String(s ?? "").replaceAll("@S", "/").replaceAll("@A", "@");

function frame(msg) {
  const parts = [];
  for (const [k, v] of Object.entries(msg)) parts.push(esc(k) + "@=" + esc(v));
  const body = new TextEncoder().encode(parts.join("/") + "/" + "\0");
  const len = body.length + 8;
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, len, true);
  dv.setInt32(4, len, true);
  dv.setUint16(8, MSG_TYPE_SEND, true); // 0x02B1
  out.set(body, 12);
  return out;
}

function decodeFrame(u8) {
  const msgs = [];
  let off = 0;
  while (off + 12 <= u8.length) {
    const len = new DataView(u8.buffer, u8.byteOffset + off, 4).getInt32(0, true);
    if (len < 9 || off + 4 + len > u8.length) break;
    msgs.push(new TextDecoder().decode(u8.subarray(off + 12, off + 4 + len - 1)));
    off += 4 + len;
  }
  return msgs;
}

function kv(stt) {
  const map = {};
  for (const seg of stt.split("/")) {
    const i = seg.indexOf("@=");
    if (i < 1) continue;
    map[unesc(seg.slice(0, i))] = unesc(seg.slice(i + 2));
  }
  return map;
}

function sttType(stt) {
  const m = /(?:^|\/)type@[AS]*=?([a-zA-Z0-9_]+)/.exec(stt);
  return unesc(m ? m[1] : "");
}

// ---------------- MD5（斗鱼 vk 用；webview 无原生 MD5，自实现标准算法） ----------------
function md5(str) {
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const add = (a, b) => (a + b) & 0xffffffff;
  const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) & 0xffffffff;

  const bytes = new TextEncoder().encode(str);
  const len = bytes.length;
  const pad = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  pad.set(bytes);
  pad[len] = 0x80;
  const dv = new DataView(pad.buffer);
  dv.setUint32(pad.length - 8, (len * 8) >>> 0, true);
  dv.setUint32(pad.length - 4, Math.floor((len * 8) / 4294967296), true);

  let a = 0x67452301 | 0, b = 0xefcdab89 | 0, c = 0x98badcfe | 0, d = 0x10325476 | 0;
  const m = new Int32Array(16);
  for (let off = 0; off < pad.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getInt32(off + i * 4, true);
    const A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const t = add(add(add(f, m[g]), K[i]), a);
      const newB = add(b, rotl(t, S[(i >> 4) * 4 + (i % 4)]));
      a = d; d = c; c = b; b = newB;
    }
    a = add(a, A); b = add(b, B); c = add(c, C); d = add(d, D);
  }
  const out = new DataView(new ArrayBuffer(16));
  out.setInt32(0, a, true); out.setInt32(4, b, true); out.setInt32(8, c, true); out.setInt32(12, d, true);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += (out.getUint8(i) < 16 ? "0" : "") + out.getUint8(i).toString(16);
  return hex;
}

// ---------------- Cookie ----------------
function parseCookie(str) {
  const map = {};
  for (const raw of String(str ?? "").split(/[;\n]/)) {
    const i = raw.indexOf("=");
    if (i < 1) continue;
    map[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
  }
  return map;
}

// ---------------- 网络 ----------------
async function netFetch(url) {
  const res = await ctxref.onethu.net.fetch(url);
  if (!res.ok) throw new StepError("外部请求", "HTTP " + res.status + " " + url);
  return res;
}
async function sb7Json(url) {
  const data = (await (await netFetch(url)).json());
  if (data.code !== 200) throw new StepError("烂梗站接口", data.msg || "未知错误");
  return data.data;
}
async function fetchRandMeme() {
  const d = await sb7Json(SB7_RAND);
  return { text: d.barrage, id: d.id, cnt: d.cnt };
}
async function fetchHotMemes() {
  return ((await sb7Json(SB7_HOT)) || []).map((x) => ({ text: x.barrage, id: x.barrageId, cnt: x.cnt }));
}
async function fetchShieldWords() {
  try { return (await sb7Json(SB7_SHIELD)) || []; } catch { return []; } // 预检失败不阻断
}
async function resolveRealRoom(roomId) {
  const html = await (await netFetch("https://www.douyu.com/" + roomId)).text();
  const m = html.match(/\$ROOM\.room_id\D+(\d+)/) || html.match(/window\.room_id\s*=\s*(\d+)/);
  if (!m) throw new StepError("解析真实房间号", "房间页面无 room_id（房间不存在或已封禁）");
  return m[1];
}

// ---------------- WebSocket 泵 ----------------
function openWs(url, label, ms) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; closeQuiet(ws); reject(new StepError(label, "连接超时（" + url + "）")); }
    }, ms);
    try { ws = new WebSocket(url); } catch (e) { clearTimeout(timer); reject(new StepError(label, "无法创建 WebSocket：" + e.message)); return; }
    ws.onopen = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(ws); } };
    ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new StepError(label, "连接失败（" + url + "）")); } };
    ws.binaryType = "arraybuffer";
  });
}

function pump(ws, handler) {
  const onData = (ev) => {
    let u8;
    if (ev.data instanceof ArrayBuffer) u8 = new Uint8Array(ev.data);
    else if (typeof ev.data === "string") u8 = new TextEncoder().encode(ev.data);
    else if (ev.data && typeof ev.data.arrayBuffer === "function") { ev.data.arrayBuffer().then((ab) => handle(new Uint8Array(ab))); return; }
    else return;
    handle(u8);
  };
  const handle = (u8) => {
    for (const stt of decodeFrame(u8)) {
      let m;
      try { m = kv(stt); } catch { m = {}; }
      try { handler(m.type || sttType(stt), m, stt); } catch { /* 单条解析失败不影响收帧 */ }
    }
  };
  ws.addEventListener("message", onData);
  return { stop: () => ws.removeEventListener("message", onData) };
}

// 登录链路：wsproxy(登录态) → proxylist → 弹幕服务器 → loginres/joingroup
async function douyuLogin(roomIdInput, cookieMap, log) {
  const need = ["dy_did", "acf_uid", "acf_stk", "acf_ltkid"];
  const missing = need.filter((k) => !cookieMap[k]);
  if (missing.length) throw new StepError("Cookie 检查", "缺少字段 " + missing.join("/") + "，请粘贴登录斗鱼后的完整 Cookie");

  const realRid = await resolveRealRoom(roomIdInput);
  log("真实房间号 " + realRid);

  // ① wsproxy
  const wws = await openWs(WSPROXY_URL, "斗鱼网关", 8000);
  let level = null, illegal = null, netErr = null;
  let resolveLogin, resolveProxy;
  const wsLoginres = new Promise((r) => { resolveLogin = r; });
  const proxyList = new Promise((r) => { resolveProxy = r; });
  const pw = pump(wws, (type, m) => {
    if (type === "loginres") {
      resolveLogin(true);
      wws.send(frame({ type: "keeplive", tick: String(Math.floor(Date.now() / 1000)), cnd: "hs-h5" }));
    } else if (type === "msgrepeaterproxylist") {
      const list = [];
      for (const seg of unesc(m.list || "").split("/")) {
        const s = kv(seg);
        if (s.ip && s.port) list.push({ ip: s.ip, port: s.port });
      }
      resolveProxy(list);
    } else if (type === "memberinfores") {
      level = m.level ?? null; illegal = m.is_illegal ?? null;
    }
  });
  const rt = Math.floor(Date.now() / 1000);
  wws.send(frame({
    type: "loginreq",
    roomid: String(realRid),
    dfl: "sn@A=105@Sss@A=1",
    username: cookieMap.acf_uid,
    password: "",
    ltkid: cookieMap.acf_ltkid,
    biz: "1",
    stk: cookieMap.acf_stk,
    devid: cookieMap.dy_did,
    ct: "0", pt: "2", cvr: "0", tvr: "7", apd: "",
    rt: String(rt),
    vk: md5(rt + VK_SECRET + cookieMap.dy_did),
    ver: VER, aver: AVER, dmbt: "chrome", dmbv: "116",
  }));
  let okLogin;
  try {
    okLogin = await Promise.race([
      wsLoginres.then(() => true),
      sleep(12000).then(() => false),
    ]);
  } catch (e) { netErr = e; }
  if (!okLogin) { pw.stop(); closeQuiet(wws); throw new StepError("wsproxy 登录", "12 秒无 loginres：Cookie 失效 / 被风控 / 网关变更" + (netErr ? "，另有错误 " + netErr.message : "")); }
  const plist = await Promise.race([
    proxyList,
    sleep(9000).then(() => null),
  ]);
  if (!plist || !plist.length) { pw.stop(); closeQuiet(wws); throw new StepError("弹幕服务器列表", "登录成功但未推送服务器列表"); }

  // ② 弹幕服务器（取前3个，逐个试）
  let dws = null, lastErr = null;
  for (const p of plist.slice(0, 3)) {
    try { dws = await openWs("wss://" + p.ip + ":" + p.port + "/", "弹幕服务器", 8000); break; }
    catch (e) { lastErr = e; log("弹幕服务器 " + p.port + " 连接失败，换下一个"); }
  }
  if (!dws) { pw.stop(); closeQuiet(wws); throw new StepError("弹幕服务器", "逐一尝试均失败：" + (lastErr && lastErr.message)); }

  let resolveDLogin;
  const dLoginP = new Promise((r) => { resolveDLogin = r; });
  const pd = pump(dws, (type) => { if (type === "loginres") resolveDLogin(true); });
  dws.send(frame({
    type: "loginreq",
    roomid: String(realRid),
    dfl: "sn@A=105@Sss@A=1",
    username: cookieMap.acf_uid,
    uid: cookieMap.acf_uid,
    ver: VER, aver: AVER, ct: "0",
  }));
  const okD = await Promise.race([dLoginP.then(() => true), sleep(9000).then(() => false)]);
  if (!okD) { pw.stop(); pd.stop(); closeQuiet(dws); closeQuiet(wws); throw new StepError("弹幕服务器登录", "未收到 loginres（服务器拒绝或 Cookie 无效）"); }
  dws.send(frame({ type: "joingroup", rid: String(realRid), gid: "1" }));
  await sleep(300);
  dws.send(frame({ type: "mrkl" }));
  pw.stop(); // 保留 pd 接弹幕回显（调用方管理）
  if (String(illegal) === "1") log("警告：memberinfores 显示 is_illegal=1，发言可能受限");

  return { wws, dws, pd, realRid, level, illegal };
}

// ---------------- 发送（含回显检测） ----------------
async function sendOnce({ text, roomId, cookieStr, onLog }) {
  const log = (m) => onLog && onLog(m);
  const cookieMap = parseCookie(cookieStr);
  const uid = cookieMap.acf_uid;
  const did = cookieMap.dy_did;

  const st = await douyuLogin(roomId, cookieMap, log);
  try {
    // 屏蔽词预检（sb6657 收录的斗鱼屏蔽词库）
    let shield = null;
    const words = await fetchShieldWords();
    const t = String(text);
    for (const w of words) { if (w && t.toLowerCase().includes(String(w).toLowerCase())) { shield = String(w); break; } }
    if (shield) log("烂梗含屏蔽词「" + shield + "」，发出去大概率被吞");
    log("已连入房间（斗鱼等级 " + (st.level == null ? "未知" : "L" + st.level) + "），发送中…");

    const tts = Math.floor(Date.now() / 1000);
    st.dws.send(frame({
      type: "chatmessage",
      pe: "0", content: t, col: "0",
      dy: did, sender: uid,
      ifs: "0", nc: "0", dat: "0", rev: "0",
      tts: String(tts), admzq: "0", cst: String(tts * 1000 + 8000 + Math.floor(Math.random() * 2000)),
    }));

    // 回显检测：本 uid 的 chatmsg 出现才算上墙
    let echoed = false;
    st.pd.stop();
    const pe = pump(st.dws, (type, m) => {
      if (type === "chatmsg" && String(m.uid) === String(uid)) {
        const got = unesc(m.txt || "").trim();
        if (got === t.trim() || (t && got.includes(t.slice(0, Math.min(8, t.length))))) echoed = true;
      }
    });
    const deadline = Date.now() + 10000;
    while (!echoed && Date.now() < deadline) await sleep(200);
    pe.stop();
    lastSendAt = Date.now();
    return { echoed, roomUrl: "https://www.douyu.com/" + st.realRid, level: st.level, shield };
  } finally {
    closeQuiet(st.dws);
    closeQuiet(st.wws);
  }
}

// ---------------- 激活 ----------------
export default function activate(ctx) {
  ctxref = ctx;

  const load = async () => {
    const s = await ctx.onethu.settings.get();
    return {
      cookie: String(s.cookie || "").trim(),
      roomId: String(s.roomId || "").trim() || "6657",
      minInterval: Math.max(0, Number(s.minInterval) || 30),
    };
  };

  const precheck = async (s) => {
    if (!s.cookie) throw new StepError("未配置", "请到 设置 → 插件 → 一键发送 niko 烂梗 → 设置 粘贴斗鱼 Cookie");
  };
  const cooldownCheck = (s) => {
    const wait = s.minInterval - (Date.now() - lastSendAt) / 1000;
    if (wait > 0) throw new StepError("冷却中", "两发至少间隔 " + s.minInterval + "s，还差 " + Math.ceil(wait) + "s（防手滑刷屏）");
  };
  const mkLogger = (logs) => (m) => { logs.push(m); ctx.log("[onethu.niko] " + m); };

  const fmtSend = (text, res, logs) => {
    const kvArr = [
      { k: "烂梗", v: text },
      { k: "房间", v: res ? res.roomUrl : "" },
      { k: "斗鱼等级", v: res && res.level != null ? "L" + res.level : "未知" },
    ];
    if (res && res.shield) kvArr.push({ k: "含屏蔽词", v: "「" + res.shield + "」（sb6657 收录，可能被吞）" });
    const head = res && res.echoed
      ? "✅ 已上墙（收到本账号弹幕回显，板上钉钉）"
      : "⚠️ 已发出，但 10 秒内未见本账号回显：大概率被等级墙/风控静默拦截。本房间需要斗鱼等级门槛，低等级号常被吞。";
    return { text: head, kv: kvArr, markdown: logs && logs.length ? logs.map((l) => "- " + l).join("\n") : undefined };
  };

  // ① 随机烂梗一键发送（input 可直接给内容）
  ctx.registerCommand({ id: "send", title: "🎲 随机烂梗一键发送", inputLabel: "（可选）直接填弹幕内容", inputPlaceholder: "留空 = 随机捞一条" }, async (input) => {
    const s = await load();
    await precheck(s);
    const text = (String(input ?? "").trim()) || (await fetchRandMeme()).text;
    const ok = await ctx.onethu.ui.confirm(
      "目标房间 " + s.roomId + "，内容：\n" + text + "\n\n确认发射？（发出即公开弹幕，人人可见）",
      { title: "一键发送 niko 烂梗", confirmText: "发射" },
    );
    if (!ok) return "已取消";
    cooldownCheck(s);
    const logs = [];
    try {
      const res = await sendOnce({ text, roomId: s.roomId, cookieStr: s.cookie, onLog: mkLogger(logs) });
      return fmtSend(text, res, logs);
    } catch (e) {
      return { text: "❌ " + (e.step ? e.message : "发送失败：" + e.message), markdown: logs.map((l) => "- " + l).join("\n") };
    }
  });

  // ② 24h 热门榜单（只读）
  ctx.registerCommand({ id: "hot", title: "🔥 24h 热门烂梗榜" }, async () => {
    const hot = await fetchHotMemes();
    return {
      text: "共 " + hot.length + " 条玩机器房 24h 热门烂梗（次数≠你发得出去）",
      items: hot.slice(0, 15).map((h) => ({ title: h.text, meta: "×" + h.cnt })),
    };
  });

  // ③ 从热门里挑一条发
  ctx.registerCommand({ id: "send_hot", title: "🔥 热门烂梗挑一条发" }, async () => {
    const s = await load();
    await precheck(s);
    const hot = await fetchHotMemes();
    if (!hot.length) return "❌ 烂梗站今日热门拉取失败";
    const ten = hot.slice(0, 10);
    const pick = await ctx.onethu.ui.form("今日热门 Top" + ten.length, [
      { key: "i", label: "烂梗", kind: "select", required: true, options: ten.map((h, i) => ({ value: String(i), label: "×" + h.cnt + " " + h.text.slice(0, 44) })) },
    ]);
    if (!pick) return "已取消";
    const text = ten[Number(pick.i)].text;
    const ok = await ctx.onethu.ui.confirm("目标房间 " + s.roomId + "，内容：\n" + text, { title: "热门烂梗发射", confirmText: "发射" });
    if (!ok) return "已取消";
    cooldownCheck(s);
    const logs = [];
    try {
      const res = await sendOnce({ text, roomId: s.roomId, cookieStr: s.cookie, onLog: mkLogger(logs) });
      return fmtSend(text, res, logs);
    } catch (e) {
      return { text: "❌ " + (e.step ? e.message : "发送失败：" + e.message), markdown: logs.map((l) => "- " + l).join("\n") };
    }
  });

  // ④ 连接自检（全链路但不发送）
  ctx.registerCommand({ id: "check", title: "🩺 链路自检（不发送）" }, async () => {
    const s = await load();
    const logs = [];
    const log = mkLogger(logs);
    try {
      await precheck(s);
      const cookieMap = parseCookie(s.cookie);
      const st = await douyuLogin(s.roomId, cookieMap, log);
      closeQuiet(st.dws); closeQuiet(st.wws); st.pd.stop();
      const kvArr = [
        { k: "真实房间号", v: st.realRid },
        { k: "wsproxy 登录", v: "✅" },
        { k: "弹幕服务器登录", v: "✅" },
        { k: "斗鱼等级", v: st.level == null ? "未知" : "L" + st.level },
      ];
      if (String(st.illegal) === "1") kvArr.push({ k: "账号状态", v: "⛔ is_illegal=1，发言被限制" });
      kvArr.push({ k: "结论", v: "链路完整，随时可发；能否上墙取决于等级墙/风控" });
      return { text: "🩺 全链路自检通过（未发送任何弹幕）", kv: kvArr };
    } catch (e) {
      return {
        text: "🩺 自检未通过：" + (e.step ? e.message : e.message),
        kv: [{ k: "走过步骤", v: logs.join(" → ") || "（首步即失败）" }],
      };
    }
  });

  // ⑤ 保底：只捞梗复制，不碰斗鱼
  ctx.registerCommand({ id: "copy", title: "📋 随机捞梗（复制）" }, async () => {
    const m = await fetchRandMeme();
    await ctx.onethu.ui.clipboard.write(m.text);
    return { text: "已复制烂梗 #" + m.id + "（已被玩 " + m.cnt + " 次），自己手弹也行", kv: [{ k: "烂梗", v: m.text }] };
  });

  return {
    dispose() { ctxref = null; },
  };
}

// 内部测试钩子（不影响发布形态）
export const _internals = { md5, frame, decodeFrame, kv, parseCookie, esc, unesc };
