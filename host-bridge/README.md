# OneTHU 宿主桥：douyu_send_danmu / douyu_self_check（方案二施工包）

背景：OneTHU 的 WKWebView（tauri:// custom scheme 页面）里所有 WebSocket 都秒拒
（连 `wss://www.baidu.com:443/` 都死），而 HTTPS（fetch/img）全通。诊断结论：
wry/tauri 在 macOS 26.5 上的 WebSocket 初始化问题，cargo update 已无补丁可吃。
因此把「发送弹幕短事务」整体搬进宿主 Rust 层——插件 v0.3.0+ 会**优先调用本命令，
失败自动回落原有 WebView 路径**，叠加零破坏。

## 改动清单（共 3 处，全部增量）

1. **Cargo.toml** 追加依赖：见 `Cargo.append.toml`（4 行）。
2. **src/lib.rs** 文件末尾整段追加：见 `lib.rs.append.rs`（自包含，不改任何现有函数）。
3. 注册命令：在 `tauri::Builder` 的 `.invoke_handler(tauri::generate_handler![</br> ... ])` 列表末尾加一项：

   ```rust
   douyu_send_danmu,
   douyu_self_check,
   ```

4. **可选**：reqwest 的 `rustls-tls` 换 `native-tls`（与 curl/浏览器同指纹；仅影响宿主 HTTP
   指纹问题，不影响桥内通道，桥走 tokio-tungstenite 的 native-tls）。

## 验证

`cargo build` → 启动 OneTHU → 插件页：
- 🩺 链路自检 → 应输出「宿主桥 ✅（850x）· JWT 派生 · 未发送弹幕」；
- 🎲 发射 → 「✅ 已上墙 / ⚠️ 未回显大概率等级墙」。

失败 auto-fallback：若桥未上线（命令不存在），插件自动回落老 WebView 通道，不会白屏报错。

## 设计文件
- `Cargo.append.toml` —— 依赖追加
- `lib.rs.append.rs` —— 桥实现（自包含追加块）
