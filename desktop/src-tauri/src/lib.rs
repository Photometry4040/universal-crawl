/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
//! UniCrawl Desktop — PoC 백엔드.
//! 임베디드 WebView(target 윈도)에 시각적 셀렉터 집기·추출 스크립트를 주입하고,
//! 집은 셀렉터/추출 행을 메인 컨트롤 패널로 전달하며, 결과를 로컬 파일로 내보낸다.

use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 대상 페이지에 주입되는 모듈(컴파일 타임 임베드). 주입 순서가 중요:
/// finder → selector-infer → extractor → robots → serialize → picker.
const FINDER_JS: &str = include_str!("../inject/finder.js");
const INFER_JS: &str = include_str!("../inject/selector-infer.js");
const EXTRACTOR_JS: &str = include_str!("../inject/extractor.js");
const ROBOTS_JS: &str = include_str!("../inject/robots.js");
const SERIALIZE_JS: &str = include_str!("../inject/serialize.js");
const PICKER_JS: &str = include_str!("../inject/picker.js");

/// 누적 수집 상태(단일 진실 공급원). 현재 PoC는 단일 페이지 추출을 보관.
#[derive(Default)]
struct AppState {
    rows: Mutex<Vec<Value>>,
    headers: Mutex<Vec<String>>,
}

/// picker.js가 invoke('on_pick', { pick })로 보내는 집기 결과.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pick {
    selector: String,
    count: u32,
    #[serde(rename = "sampleCount")]
    sample_count: u32,
    #[serde(rename = "sampleText")]
    sample_text: String,
}

/// 연습 전용 사이트만 허용(회피·무단수집 방지). PoC 안전장치.
fn is_allowed_practice_url(url: &str) -> bool {
    const ALLOW: [&str; 2] = ["toscrape.com", "scrapethissite.com"];
    if let Ok(parsed) = url::Url::parse(url) {
        if parsed.scheme() != "https" && parsed.scheme() != "http" {
            return false;
        }
        if let Some(host) = parsed.host_str() {
            return ALLOW
                .iter()
                .any(|d| host == *d || host.ends_with(&format!(".{}", d)));
        }
    }
    false
}

/// 대상 URL을 임베디드 WebView로 열고 집기 스크립트를 주입한다.
#[tauri::command]
async fn open_target(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !is_allowed_practice_url(&url) {
        return Err("연습 전용 사이트(toscrape.com / scrapethissite.com)만 허용됩니다.".into());
    }
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;

    // 이미 열려 있으면 닫고 새로 연다(PoC 단순화).
    if let Some(existing) = app.get_webview_window("target") {
        let _ = existing.close();
    }

    WebviewWindowBuilder::new(&app, "target", WebviewUrl::External(parsed))
        .title("대상 페이지 — 셀렉터 집기")
        .inner_size(1100.0, 800.0)
        .initialization_script(FINDER_JS)
        .initialization_script(INFER_JS)
        .initialization_script(EXTRACTOR_JS)
        .initialization_script(ROBOTS_JS)
        .initialization_script(SERIALIZE_JS)
        .initialization_script(PICKER_JS)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 주입된 picker.js가 셀렉터를 집을 때마다 호출 → 메인 패널로 이벤트 전파.
#[tauri::command]
fn on_pick(app: tauri::AppHandle, pick: Pick) -> Result<(), String> {
    app.emit("uc-pick", &pick).map_err(|e| e.to_string())?;
    Ok(())
}

/// 패널 → 대상 webview를 필드 집기 모드로 전환. 다음 클릭이 상대 셀렉터로 집힌다.
#[tauri::command]
fn start_field_pick(app: tauri::AppHandle, field_index: i64) -> Result<(), String> {
    let win = app
        .get_webview_window("target")
        .ok_or("대상 창이 열려 있지 않습니다.")?;
    win.eval(&format!("window.__ucStartFieldPick({})", field_index))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 대상 webview가 필드 집기 결과를 되돌려 보냄 → 패널로 전파(해당 필드 행 채우기).
#[tauri::command]
fn on_field_pick(app: tauri::AppHandle, pick: Value) -> Result<(), String> {
    app.emit("uc-field-pick", &pick).map_err(|e| e.to_string())?;
    Ok(())
}

/// 패널 → 대상 webview에서 __ucRunExtract(profile) 실행 지시(eval).
/// 결과는 대상이 collect_rows로 되돌려 보낸다(fire-and-forget eval).
#[tauri::command]
fn request_extract(app: tauri::AppHandle, profile: Value) -> Result<(), String> {
    let win = app
        .get_webview_window("target")
        .ok_or("대상 창이 열려 있지 않습니다. 먼저 '대상 열기'를 누르세요.")?;
    let json = serde_json::to_string(&profile).map_err(|e| e.to_string())?;
    win.eval(&format!("window.__ucRunExtract({})", json))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 대상 webview가 추출 결과를 되돌려 보냄 → 누적 후 미리보기 이벤트 발행.
#[tauri::command]
fn collect_rows(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    rows: Vec<Value>,
    fields: Vec<Value>,
) -> Result<usize, String> {
    let headers: Vec<String> = fields
        .iter()
        .filter_map(|f| f.get("name").and_then(|n| n.as_str()).map(String::from))
        .collect();
    let count = rows.len();

    *state.rows.lock().map_err(|e| e.to_string())? = rows.clone();
    *state.headers.lock().map_err(|e| e.to_string())? = headers.clone();

    let preview: Vec<&Value> = rows.iter().take(10).collect();
    let payload = serde_json::json!({ "count": count, "headers": headers, "preview": preview });
    app.emit("uc-rows", payload).map_err(|e| e.to_string())?;
    Ok(count)
}

// ---------- CSV 직렬화(serialize.js 규칙과 동일: BOM + RFC4180 + CRLF) ----------
fn csv_escape(s: &str) -> String {
    if s.contains(|c| c == ',' || c == '"' || c == '\r' || c == '\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn build_csv(rows: &[Value], headers: &[String]) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(rows.len() + 1);
    lines.push(headers.iter().map(|h| csv_escape(h)).collect::<Vec<_>>().join(","));
    for row in rows {
        let line = headers
            .iter()
            .map(|h| csv_escape(&cell(row.get(h).unwrap_or(&Value::Null))))
            .collect::<Vec<_>>()
            .join(",");
        lines.push(line);
    }
    format!("\u{feff}{}", lines.join("\r\n")) // BOM + CRLF
}

fn save_to_downloads(app: &tauri::AppHandle, name: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let path = dir.join(name);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 누적 행을 CSV로 Downloads에 저장. 저장 경로 반환.
#[tauri::command]
fn export_csv(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<String, String> {
    let rows = state.rows.lock().map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Err("내보낼 데이터가 없습니다. 먼저 '현재 페이지 추출'을 실행하세요.".into());
    }
    let headers = state.headers.lock().map_err(|e| e.to_string())?;
    let csv = build_csv(&rows, &headers);
    save_to_downloads(&app, "unicrawl-export.csv", csv.as_bytes())
}

/// 누적 행을 JSON으로 Downloads에 저장. 저장 경로 반환.
#[tauri::command]
fn export_json(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<String, String> {
    let rows = state.rows.lock().map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Err("내보낼 데이터가 없습니다. 먼저 '현재 페이지 추출'을 실행하세요.".into());
    }
    let json = serde_json::to_string_pretty(&*rows).map_err(|e| e.to_string())?;
    save_to_downloads(&app, "unicrawl-export.json", json.as_bytes())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_target,
            on_pick,
            start_field_pick,
            on_field_pick,
            request_extract,
            collect_rows,
            export_csv,
            export_json
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
