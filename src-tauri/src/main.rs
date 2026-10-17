#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Tauri 桌面外壳：启动内置的 Node 服务，再用一个真正的窗口加载 http://127.0.0.1:3210。
//!
//! 为什么要有这个壳：
//!   - 单文件 exe 是"无窗口"的，用户看不到任何反馈，也没法好好关掉；
//!   - 这里给出启动中的窗口、失败原因的窗口、以及关闭窗口即退出（同时结束 Node 子进程）。

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// 内置 Node 子进程，退出时要一起结束，否则会留下看不见的进程。
struct ServerProcess(Mutex<Option<Child>>);

fn port() -> u16 {
    std::env::var("BOMB_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(3210)
}

fn port_open(p: u16) -> bool {
    TcpStream::connect(("127.0.0.1", p)).is_ok()
}

/// 资源目录里找 server.js / node.exe。
/// 兼容两种布局：资源平铺（resources 映射成目标名）或保留 bundle-assets/ 前缀。
fn resource_file(app: &AppHandle, rel: &str) -> Option<PathBuf> {
    let root = app.path().resource_dir().ok()?;
    let cands = [
        root.join(rel),
        root.join("bundle-assets").join(rel),
        root.join("_up_").join(rel),
    ];
    cands.into_iter().find(|p: &PathBuf| p.exists())
}

fn spawn_server(app: &AppHandle) -> Result<Child, String> {
    let node = resource_file(app, "node.exe")
        .ok_or_else(|| "安装包里找不到 node.exe".to_string())?;
    let entry = resource_file(app, "server/server.js")
        .ok_or_else(|| "安装包里找不到 server/server.js".to_string())?;

    let log_dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("BombGame"));
    let _ = std::fs::create_dir_all(&log_dir);
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("server.log"))
        .ok();
    let (out, err) = match (log.as_ref(), log.as_ref()) {
        (Some(a), Some(b)) => (
            Stdio::from(a.try_clone().map_err(|e| e.to_string())?),
            Stdio::from(b.try_clone().map_err(|e| e.to_string())?),
        ),
        _ => (Stdio::null(), Stdio::null()),
    };

    let server_dir = entry
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| entry.clone());

    Command::new(node)
        .arg(&entry)
        .arg(port().to_string())
        .current_dir(server_dir)
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|e| format!("启动内置 node 失败：{e}"))
}

fn show_error(app: &AppHandle, message: &str) {
    let handle = app.clone();
    let text = message.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(splash) = handle.get_webview_window("splash") {
            let _ = splash.close();
        }
        if let Ok(win) = WebviewWindowBuilder::new(&handle, "error", WebviewUrl::App("error.html".into()))
            .title("BombGame 启动失败")
            .inner_size(680.0, 420.0)
            .center()
            .build()
        {
            if let Ok(json) = serde_json::to_string(&text) {
                let _ = win.eval(&format!("document.getElementById('msg').textContent = {json};"));
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            // 先把"正在启动"的窗口显示出来：用户马上知道程序确实在跑
            let _ = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("loading.html".into()))
                .title("BombGame 正在启动")
                .inner_size(520.0, 300.0)
                .resizable(false)
                .center()
                .build();

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let p = port();
                // 端口已经有服务（比如之前没关干净的实例）就直接用它
                if !port_open(p) {
                    match spawn_server(&handle) {
                        Ok(child) => {
                            *handle.state::<ServerProcess>().0.lock().unwrap() = Some(child);
                        }
                        Err(msg) => {
                            show_error(&handle, &msg);
                            return;
                        }
                    }
                }

                let started = Instant::now();
                while started.elapsed() < Duration::from_secs(25) && !port_open(p) {
                    sleep(Duration::from_millis(150));
                }
                if !port_open(p) {
                    show_error(
                        &handle,
                        &format!(
                            "等待端口 {p} 超时（25 秒）。\n\n可能原因：\n1. 端口被别的程序占用\n2. 杀毒软件拦截了内置的 node.exe\n\n日志：{:?}",
                            handle.path().app_log_dir()
                        ),
                    );
                    return;
                }

                let url = match format!("http://127.0.0.1:{p}/").parse() {
                    Ok(u) => u,
                    Err(e) => {
                        show_error(&handle, &format!("地址不合法：{e}"));
                        return;
                    }
                };

                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let built = WebviewWindowBuilder::new(&h, "main", WebviewUrl::External(url))
                        .title("保持沟通就没人爆炸")
                        .inner_size(1200.0, 860.0)
                        .min_inner_size(900.0, 620.0)
                        .center()
                        .build();
                    if built.is_ok() {
                        if let Some(splash) = h.get_webview_window("splash") {
                            let _ = splash.close();
                        }
                    }
                });
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app: &AppHandle, event: RunEvent| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(mut child) = app.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
