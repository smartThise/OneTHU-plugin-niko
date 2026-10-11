// =========================================================================
// niko 弹幕桥（douyu_send_danmu / douyu_self_check）—— 自包含追加块 v1
// 背景：OneTHU 的 WKWebView（tauri:// custom scheme 页面）里 WebSocket 全灭
//      （实测 baidu:443 的 WS 也一样死），HTTPS 正常。故此短事务在 Rust 层完成。
// 协议已实测闭环：直连 danmuproxy.douyu.com:8501~8503 登录进房，chatmessage 从
//      同一 socket 发出，10s 内收本 uid 的 chatmsg 回显判「已上墙」。
// 登录：JWT 时代字段全部并入 acf_jwt_token payload（uid/ltkid/stk/biz），
//      biz 必须用 jwt 的（旧代码写死 biz=1 会被网关拒），devid=dy_did 做 vk。
// =========================================================================

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use md5::Digest;
use serde::Deserialize;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const VK_SECRET: &str = "r5*^5;}2#${XF[h+;'./.Q'1;,-]f'p[";
const MSG_TYPE_SEND: u16 = 689; // 0x02B1

fn stt_escape(s: &str) -> String {
    s.replace('@', "@A").replace('/', "@S")
}

fn stt_unescape(s: &str) -> String {
    s.replace("@S", "/").replace("@A", "@")
}

fn frame_pairs(pairs: &[(String, String)]) -> Vec<u8> {
    let mut stt = String::from("type@=");
    stt.push_str(&stt_escape(&pairs[0].1));
    stt.push('/');
    for (k, v) in &pairs[1..] {
        stt.push_str(&stt_escape(k));
        stt.push_str("@=");
        stt.push_str(&stt_escape(v));
        stt.push('/');
    }
    stt.push('\0');
    let body = stt.as_bytes();
    let len = (body.len() + 8) as i32;
    let mut out = Vec::with_capacity(12 + body.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&MSG_TYPE_SEND.to_le_bytes());
    out.push(0u8);
    out.push(0u8);
    out.extend_from_slice(body);
    out
}

// 一条 WS Message 里的 douyu 帧解析（容忍一帧多包）
fn decode_douyu_frame(u8s: &[u8]) -> Vec<String> {
    let mut stts = Vec::new();
    let mut off = 0usize;
    while off + 12 <= u8s.len() {
        let len = i32::from_le_bytes(u8s[off..off + 4].try_into().unwrap());
        if len < 9 || off as i32 + 4 + len > u8s.len() as i32 {
            break;
        }
        let s = String::from_utf8_lossy(&u8s[off + 12..off as usize + 4 + len as usize - 1]).to_string();
        stts.push(s);
        off += (4 + len) as usize;
    }
    stts
}

fn kv_of(stt: &str) -> std::collections::HashMap<String, String> {
    stt.split('/')
        .filter_map(|seg| {
            let i = seg.find("@=")?;
            let key = stt_unescape(&seg[..i]);
            let val = stt_unescape(&seg[i + 2..]);
            if key.is_empty() { None } else { Some((key, val)) }
        })
        .collect()
}

fn parse_cookie(s: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in s.split('\n') {
        if line.contains('\t') {
            let mut it = line.split('\t').map(|t| t.trim());
            if let (Some(k), Some(v)) = (it.next(), it.next()) {
                if !k.is_empty() && !v.is_empty() {
                    map.insert(k.to_string(), v.to_string());
                }
            }
            continue;
        }
        for seg in line.split(';') {
            if let Some(i) = seg.find('=') {
                let k = seg[..i].trim();
                if !k.is_empty() {
                    map.insert(k.to_string(), seg[i + 1..].trim().to_string());
                }
            }
        }
    }
    map
}

// 从 acf_jwt_token（或 acf_dmjwt_token）派生 {uid, ltkid, stk, biz}；旧版 acf_* 也兼容
fn derive_fields(cm: &std::collections::HashMap<String, String>) -> Result<(String, String, String, String, String), String> {
    if let (Some(uid), Some(ltk), Some(stk)) = (cm.get("acf_uid"), cm.get("acf_ltkid"), cm.get("acf_stk")) {
        let biz = cm.get("acf_biz").cloned().unwrap_or_else(|| "1".into());
        return Ok((uid.clone(), ltk.clone(), stk.clone(), biz, "旧版 Cookie".into()));
    }
    let jwt = cm
        .get("acf_jwt_token")
        .or_else(|| cm.get("acf_dmjwt_token"))
        .ok_or("没有可用登录凭据：需要 acf_jwt_token（现版）或 acf_uid/acf_stk/acf_ltkid（旧版）")?;
    let payload = jwt.split('.').nth(1).ok_or("JWT 结构异常")?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|e| format!("JWT payload 解码失败: {e}"))?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("JWT payload 解析失败: {e}"))?;
    let uid = v["uid"].as_i64().map(|n| n.to_string()).ok_or("JWT 缺 uid")?;
    let ltk = v["ltkid"].as_i64().map(|n| n.to_string()).ok_or("JWT 缺 ltkid")?;
    let stk = v["stk"].as_str().ok_or("JWT 缺 stk")?.to_string();
    let biz = v["biz"].as_i64().map(|n| n.to_string()).unwrap_or_else(|| "93".into());
    Ok((uid, ltk, stk, biz, "JWT 派生".into()))
}

fn extract_room_id(html: &str) -> Option<String> {
    for pat in ["$ROOM.room_id", "window.room_id"] {
        if let Some(idx) = html.find(pat) {
            let tail = &html[idx + pat.len()..];
            let digits: String = tail
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !digits.is_empty() {
                return Some(digits);
            }
        }
    }
    None
}

fn md5_hex(parts: &[&[u8]]) -> String {
    let mut h = md5::Md5::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DanmuSendArgs {
    pub cookie: String,
    #[serde(alias = "roomId")]
    pub room_id: u64,
    #[serde(default)]
    pub content: String,
    /// true = 自检（不发送 chatmessage）
    #[serde(default)]
    pub check_only: bool,
}

struct Chain {
    real_rid: String,
    level: Option<u64>,
    echoed: bool,
    via: String,
}

async fn douyu_send_chain(a: &DanmuSendArgs) -> Result<Chain, String> {
    if a.cookie.trim().is_empty() {
        return Err("未配置：请先在插件设置粘贴斗鱼 Cookie".into());
    }
    let cm = parse_cookie(&a.cookie);
    let did = cm
        .get("dy_did")
        .cloned()
        .ok_or("缺少 dy_did（设备指纹）")?;
    if a.content.trim().is_empty() && !a.check_only {
        return Err("弹幕内容为空".into());
    }
    let (uid, ltkid, stk, biz, src) = derive_fields(&cm).map_err(|e| format!("登录凭据：{e}"))?;

    // ① 真实房间号（宿主 HTTP 层走 douyu.com:443 —— rustls 已验证可用）
    let client = reqwest::Client::builder()
        .no_proxy()
        .user_agent("Mozilla/5.0 (Macintosh) OneTHU-niko")
        .build()
        .map_err(|e| format!("reqwest:{e}"))?;
    let html = client
        .get(format!("https://www.douyu.com/{}", a.room_id))
        .send()
        .await
        .map_err(|e| format!("真实房间号：{e}"))?
        .text()
        .await
        .map_err(|e| format!("真实房间号：{e}"))?;
    let real_rid = extract_room_id(&html).ok_or("真实房间号：房间页无 room_id（房间不存在或已封禁）")?;

    // ② 迭代 8501~8503
    let rt = chrono_now_secs();
    let vk = md5_hex(&[rt.as_bytes(), VK_SECRET.as_bytes(), did.as_bytes()]);
    let mut last_err = String::new();
    for port in [8501u16, 8502, 8503] {
        let url = format!("wss://danmuproxy.douyu.com:{port}/");
        let (mut ws, _) = match tokio_tungstenite::connect_async(url.as_str()).await {
            Ok(v) => v,
            Err(e) => {
                last_err = format!("{port}: {e}");
                continue;
            }
        };

        // loginreq（旧式 + JWT 派生字段 + biz）
        let login = vec![
            ("type".to_string(), "loginreq".to_string()),
            ("roomid".to_string(), real_rid.clone()),
            ("dfl".to_string(), "sn@A=105@Sss@A=1".to_string()),
            ("username".to_string(), uid.clone()),
            ("password".to_string(), String::new()),
            ("ltkid".to_string(), ltkid.clone()),
            ("biz".to_string(), biz.clone()),
            ("stk".to_string(), stk.clone()),
            ("devid".to_string(), did.clone()),
            ("ct".to_string(), "0".into()),
            ("pt".to_string(), "2".into()),
            ("cvr".to_string(), "0".into()),
            ("tvr".to_string(), "7".into()),
            ("apd".to_string(), String::new()),
            ("rt".to_string(), String::new()), // 占位，稍后再填时间戳
            ("vk".to_string(), vk.clone()),
            ("ver".to_string(), "20220825".into()),
            ("aver".to_string(), "218101901".into()),
            ("dmbt".to_string(), "chrome".into()),
            ("dmbv".to_string(), "116".into()),
        ];
        let login = fix_rt(login, &rt);
        if let Err(e) = ws.send(Message::Binary(frame_pairs(&login).into())).await {
            last_err = format!("{port}: send loginreq {e}");
            continue;
        }

        // 等 loginres / memberinfores
        let mut level: Option<u64> = None;
        let mut logged = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if std::time::Instant::now() > deadline {
                break;
            }
            let msg = match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
                Ok(Some(Ok(m))) => m,
                _ => break,
            };
            if let Message::Binary(b) = &msg {
                for stt in decode_douyu_frame(b) {
                    let m = kv_of(&stt);
                    match m.get("type").map(|s| s.as_str()).unwrap_or("") {
                        "loginres" => logged = true,
                        "memberinfores" => level = m.get("level").and_then(|s| s.parse().ok()),
                        "error" | "emrr" => return Err(format!("斗鱼网关错误：{}", m.get("content").cloned().unwrap_or_default())),
                        _ => {}
                    }
                }
            }
            if logged {
                break;
            }
        }
        if !logged {
            last_err = format!("{port}: 登录未确认（10s 无 loginres）");
            let _ = ws.close(None).await;
            continue;
        }

        // joingroup + mrkl +（发送前发放下）
        let _ = ws
            .send(Message::Binary(
                frame_pairs(&[
                    ("type".to_string(), "joingroup".into()),
                    ("rid".to_string(), real_rid.clone()),
                    ("gid".to_string(), "1".into()),
                ])
                .into(),
            ))
            .await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = ws.send(Message::Binary(frame_pairs(&[("type".to_string(), "mrkl".into())]).into())).await;
        let _ = ws
            .send(Message::Binary(
                frame_pairs(&[
                    ("type".to_string(), "sub".into()),
                    ("mt".to_string(), "dayrk".into()),
                ])
                .into(),
            ))
            .await;

        // ③ 发送 + 回显检测
        let mut echoed = false;
        if !a.check_only {
            let tts = chrono_now_secs().parse::<u64>().unwrap_or(0);
            let cst = (tts * 1000) + 9000;
            let cmmsg = vec![
                ("type".to_string(), "chatmessage".into()),
                ("pe".to_string(), "0".into()),
                ("content".to_string(), a.content.trim().to_string()),
                ("col".to_string(), "0".into()),
                ("dy".to_string(), did.clone()),
                ("sender".to_string(), uid.clone()),
                ("ifs".to_string(), "0".into()),
                ("nc".to_string(), "0".into()),
                ("dat".to_string(), "0".into()),
                ("rev".to_string(), "0".into()),
                ("tts".to_string(), tts.to_string()),
                ("admzq".to_string(), "0".into()),
                ("cst".to_string(), cst.to_string()),
            ];
            ws.send(Message::Binary(frame_pairs(&cmmsg).into()))
                .await
                .map_err(|e| format!("chatmessage 发送失败:{e}"))?;
            let deadline2 = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                if std::time::Instant::now() > deadline2 {
                    break;
                }
                let msg = match tokio::time::timeout(Duration::from_millis(300), ws.next()).await {
                    Ok(Some(Ok(m))) => m,
                    _ => break,
                };
                if let Message::Binary(b) = &msg {
                    for stt in decode_douyu_frame(b) {
                        let m = kv_of(&stt);
                        if m.get("type").map(|s| s.as_str()) == Some("chatmsg") && m.get("uid").map(String::as_str) == Some(uid.as_str()) {
                            let got = stt_unescape(m.get("txt").cloned().unwrap_or_default());
                            if got.trim() == a.content.trim() || got.contains(a.content.trim().chars().take(8).collect::<String>().as_str()) {
                                echoed = true;
                                break;
                            }
                        }
                    }
                }
                if echoed {
                    break;
                }
            }
        }
        let _ = ws.close(None).await;
        return Ok(Chain { real_rid, level, echoed, via: format!("宿主桥（{port}）· {src}") });
    }
    Err(format!("弹幕服务器 8501~8503 全部连不上（{last_err}）。若 HTTP 正常而 WS 全灭，大概率是本机代理对偶发端口的分流限制，可再试或换网络"))
}

fn fix_rt(mut v: Vec<(String, String)>, rt: &str) -> Vec<(String, String)> {
    for p in v.iter_mut() {
        if p.0 == "rt" {
            p.1 = rt.to_string();
        }
    }
    v
}

fn chrono_now_secs() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

#[tauri::command]
pub async fn douyu_send_danmu(args: DanmuSendArgs) -> Result<serde_json::Value, String> {
    let c = douyu_send_chain(&args).await?;
    Ok(serde_json::json!({
        "echoed": c.echoed,
        "realRid": c.real_rid,
        "level": c.level,
        "via": c.via,
        "check": !args.check_only,
    }))
}

#[tauri::command]
pub async fn douyu_self_check(args: DanmuSendArgs) -> Result<serde_json::Value, String> {
    let a = DanmuSendArgs {
        cookie: args.cookie,
        room_id: args.room_id,
        content: String::new(),
        check_only: true,
    };
    let c = douyu_send_chain(&a).await?;
    Ok(serde_json::json!({
        "ok": true,
        "realRid": c.real_rid,
        "level": c.level,
        "via": c.via,
    }))
}
