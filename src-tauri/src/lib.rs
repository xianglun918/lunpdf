//! LunPDF 后端：只做本地文件读取，其余逻辑都在前端（pdf.js）。
use std::path::Path;

use tauri::ipc::Response;

/// 读取 PDF 原始字节。走 IPC raw payload，避免大文件被序列化成 JSON 数组。
#[tauri::command]
fn read_pdf_file(path: String) -> Result<Response, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("无法读取文件信息：{e}"))?;
    if meta.len() > 512 * 1024 * 1024 {
        return Err("文件超过 512MB，暂不支持".into());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("读取失败：{e}"))?;
    Ok(Response::new(bytes))
}

/// 判断路径是否仍然存在（用于恢复「最近打开」和上次阅读位置）。
#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_pdf_file, file_exists])
        .run(tauri::generate_context!())
        .expect("error while running LunPDF");
}
