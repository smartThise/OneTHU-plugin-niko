# 一键发送 niko 烂梗（OneTHU 插件）

> author: **smartThis** · 个人娱乐插件 · **与 OneTHU 官方无关，勿上市场**
> v0.5.0 · 仅供娱乐，请勿刷屏

从 [sb6657.cn（玩机器烂梗收集）](https://sb6657.cn/) 捞一条烂梗，用你的斗鱼登录态，
经宿主 WebSocket 桥直发进直播间（默认玩机器的 6657 房间）。
v0.3 起走宿主 Rust 通道（绕开 WebView 的 WS 限制），v0.5 支持**标签筛选**与 **OH 接线**。

## 安装

OneTHU → 设置 → 插件 → 安装插件 → GitHub 仓库直装 `smartThise/OneTHU-plugin-niko`。
（粘贴安装也行：`plugin.js` 全文粘进去。）

> v0.4+ 依赖 OneTHU 的通用 WS 桥（`ws:external` 权限）。若宿主较旧，会自动回落老通道，一般不用管。

## 配置

| 设置项 | 说明 |
|---|---|
| 斗鱼 Cookie | **发送必需**。含 `dy_did` + `acf_jwt_token`（老账号的 `acf_uid/acf_stk/acf_ltkid` 亦可） |
| 目标房间号 | 默认 `6657`（玩机器） |
| 最小发送间隔 | 默认 30s，防手滑刷屏 |
| 默认标签 | 🆕 「随机烂梗一键发送」按此标签捞（NiKo / 喷玩机器 / QUQU / Donk / Zywoo / s1mple…） |

**粘贴 Cookie**：推荐整块复制 DevTools → Application → Cookie 表格（TSV，插件认得）；
或网络面板任意请求的整串 `Cookie:` 头。斗鱼已切 JWT，插件自动解 `uid/ltkid/stk/biz`。失效重贴。

## 命令一览

| 命令 | 干嘛 |
|---|---|
| 🎲 随机烂梗一键发送 | 按默认标签捞一条 → 确认后发射。**输入框直接填内容**(或标签词、或 `标签 内容`) 也可 |
| 🔥 24h 热门烂梗榜 | 今日热门榜（只读） |
| 🔥 热门烂梗挑一条发 | Top10 选一条发射 |
| 🩺 链路自检（不发送） | 全链路体检，**零发射** |
| 📋 随机捞梗（复制） | 复制烂梗，自己手动弹 |
| 🎲 发烂梗（OH 入口） | 🆕 对话面板里说句话让 OH 帮发（见下） |

## 标签用法（v0.5 新增）

- 设置中的「默认标签」控制随机捞的范围：NiKo=07 / 喷玩机器=00 / 喷选手=01 / 加一=02 / QUQU=03 /
  ropz=08 / Donk=10 / Zywoo=12 / m0NESY=13 / S1mple=21 / 京介=23 / frozen=29 等（全量以 sb6657 字典为准）；
- 「🎲 随机」输入框也支持直接打标签名（大小写无所谓：`niko`、`donk`、`ququ` 均可）；
- 「🔥 热门挑一条发」会按所选标签过滤热门榜（若某标签暂无热门会如实说明）。

## 让 OH 帮你发（v0.5 新增）

在任意 OneTHU 对话窗口（默认对 OH 说），受控语句即可命中本插件：

- 「**帮我发条 NiKo 烂梗**」→ OH 命中 `oh` 命令 → 弌条 NiKo 标签弹幕，弹确认后发出；
- 「**用 niko 插件发条 Donk 烂梗**」→ 同上，标签随选；
- 「**随机捞一条然后自己手动发**」→ 走「复制」命令。

安全机制：任何经由 OH 的发射都会**弹应用内确认弹窗**（显示最终内容与目标房间），不点不发；
插件内部自带 30s 冷却，OH 手抖连按也刷不了屏。

## 「发不出去」的真阵营

1. **没登录**：发言必须登录态（`dy_did` + 可解 JWT 缺一不可，插件会点名缺哪个）；
2. **等级墙**：6657 有斗鱼等级门槛（常见 ≥L10），低等级号弹幕被**静默吞**。
   插件不吹「发送成功」——发射后监听 10 秒**本账号回显**：
   - ✅ 回显命中 = 真上墙；
   - ⚠️ 无回显 = 大概率被等级墙 / 风控拦截，照实告知；
3. **屏蔽词**：发出前用 sb6657 屏蔽词库预检，命中在结果里标注；
4. **is_illegal=1**：则账号受限，直接报出。

## 技术备忘（简）

- 烂梗接口：`api.hguofichp.cn`（`getRandOne` / `hotBarrageOf24H` / `Page?tags=` / `dictList` / `getShieldWordDict`）；
- 通用 WS 桥：`ctx.onethu.ws.*`（OneTHU ≥支持 ws:external 的版本；宿主 Rust 短事务，WebView 内 WebSocket 会被上游直接拒）；
- 斗鱼协议：直连 `danmuproxy.douyu.com:8501~3`，`loginreq`(JWT 字段+`biz=jwt.biz`) → `loginres` → `joingroup` → `chatmessage`，10s 内看本 uid 的 `chatmsg` 回显定「上墙」。编解码与 [ordinaryroad-live-chat-client](https://github.com/zhziyu/ordinaryroad-live-chat-client) 同源；
- Cookie 只存插件私有设置，仅用于斗鱼登录握手，不回传第三方（说明书级细说明见主 README）。

## 免责声明

- 本插件为 smartThis 个人欣赏之作，不通过 OneTHU 官方渠道分发、不申请市场收录；
- 玩归玩，刷屏可能被斗鱼封号；由你掌握手感；
- 一切使用后果自负。玩机器看了都摇头，但那就是 raff 烂梗营的节奏。

## 版本记录

| 版本 | 变更 |
|---|---|
| v0.5.1 | OH 命中改进：命令标题全部改成你嘴里的原话（「帮我发送 niko 烂梗」等），OH 检索即中 |
| v0.5.0 | 标签筛选（sb6657 dictList 30 类标签，NiKo=07；默认标签设置 + 随机/热门按标签过滤）；`oh` 命令让 OH 代发（含确认与冷却）；README 重写 |
| v0.4.0 | 发送链三级回落：通用 WS 桥（ctx.onethu.ws）→ douyu_send_danmu 专用命令 → WebView 通道 |
| v0.3.0 | 宿主桥优先 + 静默回落；host-bridge 施工包 |
| v0.2.x | 斗鱼 JWT 登录兼容、DevTools 表格粘贴、宿主桥首发 |
