//! Tauri 桌面外壳：启动内置的 Node 服务，再用真正的窗口加载它。
//!
//! 设计要点（都是踩过的坑）：
//!   - 资源目录在 NSIS / MSI / 开发模式下的位置不一样，所以按候选目录逐个找；
//!   - 端口被占时自动往下试（3210、3211…），不再让用户改命令行；
//!   - 失败时的错误窗口直接把"找到了哪些目录、node 日志最后几行"打出来，方便定位；
//!   - 关窗口就结束 node 子进程，不留后台孤儿。

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct ServerProcess(Mutex<Option<Child>>);

/// 资源候选根目录（安装后 / 开发时 / MSI 与 NSIS 的布局差异）
fn candidate_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        for p in [res.join("resources"), res] {
            if !roots.contains(&p) {
                roots.push(p);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for p in [dir.join("resources"), dir.to_path_buf()] {
                if !roots.contains(&p) {
                    roots.push(p);
                }
            }
        }
    }
    // 开发模式：cargo tauri dev 时资源在 src-tauri/bundle-assets
    if let Ok(cwd) = std::env::current_dir() {
        for p in [cwd.join("bundle-assets"), cwd.join("src-tauri").join("bundle-assets")] {
            if !roots.contains(&p) {
                roots.push(p);
            }
        }
    }
    roots
}

/// 去掉 Windows 的扩展长度前缀（`\\?\`）。
/// Tauri 的 resource_dir() 在 Windows 上返回的是 `\\?\C:\...`，
/// 这种路径交给 Node 会炸（它会 realpath 到 `C:` 然后 EISDIR），所以统一清洗一遍。
fn clean_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// 在候选目录里找 bundle-assets 下的文件
fn find_asset(app: &AppHandle, rel: &str) -> Option<PathBuf> {
    for root in candidate_roots(app) {
        for prefix in ["", "bundle-assets"] {
            let p = if prefix.is_empty() {
                root.join(rel)
            } else {
                root.join(prefix).join(rel)
            };
            if p.exists() {
                return Some(clean_path(&p));
            }
        }
    }
    None
}

/// 把候选目录里都有什么列出来（限深度 2，避免刷屏），用于错误提示
fn list_dir_into(out: &mut String, dir: &Path, depth: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_dir() {
                format!("{name}/")
            } else {
                name
            }
        })
        .collect();
    names.sort();
    for name in names.into_iter().take(30) {
        out.push_str("    ");
        out.push_str(&"  ".repeat(depth));
        out.push_str(&name);
        out.push('\n');
    }
}

fn describe_roots(app: &AppHandle) -> String {
    let mut out = String::new();
    for root in candidate_roots(app) {
        out.push_str(&format!("· {}  ", root.display()));
        if !root.exists() {
            out.push_str("(不存在)\n");
            continue;
        }
        out.push('\n');
        list_dir_into(&mut out, &root, 0);
        // 再看一层（bundle-assets/ 之类）
        for sub in ["bundle-assets", "resources"] {
            let p = root.join(sub);
            if p.is_dir() {
                out.push_str(&format!("    {sub}/\n"));
                list_dir_into(&mut out, &p, 1);
            }
        }
    }
    out
}

fn port_open(p: u16) -> bool {
    TcpStream::connect(("127.0.0.1", p)).is_ok()
}

/// 端口被占用时自动往后找：3210 → 3240
fn pick_port() -> u16 {
    if let Ok(v) = std::env::var("BOMB_PORT") {
        if let Ok(p) = v.parse::<u16>() {
            return p;
        }
    }
    (3210..=3240).find(|p| !port_open(*p)).unwrap_or(3210)
}

fn log_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("BombGame"));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("server.log")
}

fn log_tail(path: &Path, lines: usize) -> String {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let all: Vec<&str> = text.lines().collect();
            let start = all.len().saturating_sub(lines);
            all[start..].join("\n")
        }
        Err(_) => "(没有日志)".to_string(),
    }
}

fn spawn_server(app: &AppHandle, port: u16) -> Result<Child, String> {
    let node = find_asset(app, "node.exe").ok_or_else(|| {
        format!(
            "安装包里找不到 node.exe。\n\n找过的目录：\n{}\n如果你是自己 git clone 的，先跑：\nnpm run tauri:assets",
            describe_roots(app)
        )
    })?;
    let entry = find_asset(app, "server/server.js").ok_or_else(|| {
        format!(
            "安装包里找不到 server/server.js。\n\n找过的目录：\n{}",
            describe_roots(app)
        )
    })?;

    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(app))
        .ok();
    let (out, err) = match log_file.as_ref() {
        Some(f) => (
            Stdio::from(f.try_clone().map_err(|e| e.to_string())?),
            Stdio::from(f.try_clone().map_err(|e| e.to_string())?),
        ),
        None => (Stdio::null(), Stdio::null()),
    };

    let work_dir = entry
        .parent()
        .and_then(|p| p.parent())
        .map(|p| clean_path(p))
        .unwrap_or_else(|| entry.clone());

    // 把要执行的命令记进日志，下次出问题能直接看到
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(app))
    {
        use std::io::Write;
        let _ = writeln!(
            f,
            "--- spawn: {} {} {} (cwd {})",
            node.display(),
            entry.display(),
            port,
            work_dir.display()
        );
    }

    Command::new(&node)
        .arg(&entry)
        .arg(port.to_string())
        .current_dir(work_dir)
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|e| {
            format!(
                "启动 node 失败：{e}\n\nnode.exe：{}\nserver.js：{}\n\n如果杀毒软件弹过拦截，请允许它运行。\n日志：{}",
                node.display(),
                entry.display(),
                log_path(app).display()
            )
        })
}

fn show_error(app: &AppHandle, message: &str) {
    let handle = app.clone();
    let text = message.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(splash) = handle.get_webview_window("splash") {
            let _ = splash.close();
        }
        if let Ok(win) =
            WebviewWindowBuilder::new(&handle, "error", WebviewUrl::App("error.html".into()))
                .title("BombGame 启动失败")
                .inner_size(760.0, 560.0)
                .center()
                .build()
        {
            if let Ok(json) = serde_json::to_string(&text) {
                let _ = win.eval(&format!("document.getElementById('msg').textContent = {json};"));
            }
        }
    });
}

/// 桌面端：起内置 node，再把窗口指向它
#[cfg(not(target_os = "android"))]
fn setup_platform(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

            // 让用户"看得见"：先出一个启动中的窗口
            let _ = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("loading.html".into()))
                .title("BombGame 正在启动")
                .inner_size(520.0, 300.0)
                .resizable(false)
                .center()
                .build();

            std::thread::spawn(move || {
                // 已经有一份在跑（比如之前没关干净）就直接用它
                let existing = (3210..=3240).find(|p| port_open(*p));
                let port = match existing {
                    Some(p) => p,
                    None => pick_port(),
                };
                if existing.is_none() {
                    match spawn_server(&handle, port) {
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
                while started.elapsed() < Duration::from_secs(30) && !port_open(port) {
                    sleep(Duration::from_millis(150));
                }

                if !port_open(port) {
                    let log = log_path(&handle);
                    let tail = log_tail(&log, 25);
                    show_error(
                        &handle,
                        &format!(
                            "端口 {port} 在 30 秒内没有起来。\n\n\
                             ── node 输出的最后几行 ──\n{tail}\n\n\
                             ── 安装目录里的资源 ──\n{}\n\
                             ── 日志文件 ──\n{}",
                            describe_roots(&handle),
                            log.display()
                        ),
                    );
                    return;
                }

                let url = match format!("http://127.0.0.1:{port}/").parse() {
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
}

/// 手机端：安卓上跑不了 node.exe，所以这里只做一个"填房主地址"的壳，
/// 填完直接跳过去（游戏本体还是房主电脑 / 云端在提供）。
#[cfg(target_os = "android")]
fn setup_platform(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("mobile.html".into()))
        .title("BombGame")
        .inner_size(420.0, 780.0)
        .center()
        .build();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| setup_platform(app))
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
