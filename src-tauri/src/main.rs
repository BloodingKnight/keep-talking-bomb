#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]
//! 桌面入口：真正的逻辑在 lib.rs 的 run() 里（安卓要 lib，桌面要 bin）。

fn main() {
    bombgame_lib::run()
}
