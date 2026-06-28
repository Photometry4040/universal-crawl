/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
//! UniCrawl Desktop — PoC 백엔드.
//! 임베디드 WebView(target 윈도)에 시각적 셀렉터 집기·추출 스크립트를 주입하고,
//! 집은 셀렉터/추출 행을 메인 컨트롤 패널로 전달하며, 결과를 로컬 파일로 내보낸다.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, EventTarget, Manager, WebviewUrl, WebviewWindowBuilder};

/// 대상 페이지에 주입되는 모듈(컴파일 타임 임베드). 주입 순서가 중요:
/// finder → selector-infer → extractor → robots → serialize → picker.
const FINDER_JS: &str = include_str!("../inject/finder.js");
const INFER_JS: &str = include_str!("../inject/selector-infer.js");
const EXTRACTOR_JS: &str = include_str!("../inject/extractor.js");
const ROBOTS_JS: &str = include_str!("../inject/robots.js");
const SERIALIZE_JS: &str = include_str!("../inject/serialize.js");
const PAGINATOR_JS: &str = include_str!("../inject/paginator.js");
const PICKER_JS: &str = include_str!("../inject/picker.js");

/// 누적 수집 상태(단일 진실 공급원). 단일 추출과 다중 페이지 잡 양쪽을 보관.
#[derive(Default)]
struct AppState {
    rows: Mutex<Vec<Value>>,
    headers: Mutex<Vec<String>>,
    job: Mutex<Job>,
    /// origin → (tos 동의, robots 확인). 안전장치 백엔드 재검증용(origin 스코프).
    consent: Mutex<HashMap<String, (bool, bool)>>,
}

/// 다중 페이지 수집 잡 상태. background(Rust)가 주도하고 storage 대신 메모리에 보관
/// (데스크탑은 프로세스 영속이라 확장의 SW idle-종료 문제가 없음).
#[derive(Default)]
struct Job {
    active: bool,
    profile: Value,
    current_page: i64,
    max_pages: i64,
    delay_ms: u64,
    awaiting_reload: bool, // navigate 후 page_ready를 기다리는 중
    seen: HashSet<String>,
}

// ---------- 안전장치: 백엔드 무조건 재검증(UI/프로필 우회 불가) ----------
fn clamp_delay(ms: i64) -> u64 {
    ms.max(2000) as u64 // 지연 하한 2000ms
}
fn clamp_pages(n: i64) -> i64 {
    n.clamp(1, 20) // 페이지 상한 20
}

fn json_i64(v: &Value, key: &str, default: i64) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(default)
}

/// 행 dedupe 키: dedupe_key 필드값(있으면), 없으면 전체 필드값 join.
/// 키가 비면 None → 항상 추가(중복 제외 안 함).
fn row_key(row: &Value, dedupe_key: Option<&str>, headers: &[String]) -> Option<String> {
    if let Some(k) = dedupe_key {
        let s = cell(row.get(k).unwrap_or(&Value::Null));
        return if s.is_empty() { None } else { Some(s) };
    }
    let joined: Vec<String> = headers
        .iter()
        .map(|h| cell(row.get(h).unwrap_or(&Value::Null)))
        .collect();
    let s = joined.join("\u{1f}");
    if s.chars().all(|c| c == '\u{1f}') {
        None
    } else {
        Some(s)
    }
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
        .initialization_script(PAGINATOR_JS)
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

/// 백엔드 → 대상 webview로 지시 이벤트('uc-cmd') 전송. eval 대신 이벤트 사용
/// (원격 webview에서 eval은 불안정; 이벤트는 target의 core:event 권한으로 수신).
fn send_to_target(app: &tauri::AppHandle, payload: Value) -> Result<(), String> {
    if app.get_webview_window("target").is_none() {
        return Err("대상 창이 열려 있지 않습니다. 먼저 '대상 열기'를 누르세요.".into());
    }
    app.emit_to(EventTarget::webview_window("target"), "uc-cmd", payload)
        .map_err(|e| e.to_string())
}

/// 패널 → 대상 webview를 필드 집기 모드로 전환. 다음 클릭이 상대 셀렉터로 집힌다.
#[tauri::command]
fn start_field_pick(app: tauri::AppHandle, field_index: i64) -> Result<(), String> {
    send_to_target(&app, serde_json::json!({ "action": "field_pick", "fieldIndex": field_index }))
}

/// 대상 webview가 필드 집기 결과를 되돌려 보냄 → 패널로 전파(해당 필드 행 채우기).
#[tauri::command]
fn on_field_pick(app: tauri::AppHandle, pick: Value) -> Result<(), String> {
    app.emit("uc-field-pick", &pick).map_err(|e| e.to_string())?;
    Ok(())
}

/// 현재 대상 webview의 origin(scheme://host[:port]) 추출.
fn target_origin(app: &tauri::AppHandle) -> Option<String> {
    let win = app.get_webview_window("target")?;
    let url = win.url().ok()?;
    let host = url.host_str()?;
    match url.port() {
        Some(p) => Some(format!("{}://{}:{}", url.scheme(), host, p)),
        None => Some(format!("{}://{}", url.scheme(), host)),
    }
}

/// 안전장치(ToS·robots) 백엔드 재검증. consent(tos && robots_ack) 없으면 거부.
fn require_consent(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    let origin = target_origin(app).ok_or("대상 origin을 확인할 수 없습니다.")?;
    let consent = state.consent.lock().map_err(|e| e.to_string())?;
    match consent.get(&origin) {
        Some((tos, ack)) if *tos && *ack => Ok(()),
        _ => Err("추출 전 ToS 확인과 robots 상태 확인이 필요합니다(① 대상 확인).".into()),
    }
}

/// 대상 webview가 robots.txt 판정 결과를 보고 → 패널로 전파(배너 표시).
#[tauri::command]
fn robots_status(app: tauri::AppHandle, origin: String, path: String, status: String, matched: Option<String>) -> Result<(), String> {
    app.emit(
        "uc-robots",
        serde_json::json!({ "origin": origin, "path": path, "status": status, "matched": matched }),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 패널 → origin별 consent 저장(ToS 동의 + robots 확인). 프로필엔 직렬화하지 않음.
#[tauri::command]
fn set_consent(state: tauri::State<AppState>, origin: String, tos: bool, robots_ack: bool) -> Result<(), String> {
    state
        .consent
        .lock()
        .map_err(|e| e.to_string())?
        .insert(origin, (tos, robots_ack));
    Ok(())
}

/// 패널 → 대상 webview에 추출 지시('uc-cmd' extract). 결과는 대상이 collect_rows로 되돌려 보낸다.
#[tauri::command]
fn request_extract(app: tauri::AppHandle, state: tauri::State<AppState>, profile: Value) -> Result<(), String> {
    require_consent(&app, &state)?;
    send_to_target(&app, serde_json::json!({ "action": "extract", "profile": profile }))
}

/// 패널 → 다중 페이지 수집 잡 시작. 안전장치(지연·페이지 상한)를 백엔드에서 재클램프.
#[tauri::command]
fn start_collect(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    profile: Value,
) -> Result<(), String> {
    if app.get_webview_window("target").is_none() {
        return Err("대상 창이 열려 있지 않습니다. 먼저 '대상 열기'를 누르세요.".into());
    }
    require_consent(&app, &state)?;
    let delay = clamp_delay(json_i64(&profile, "delay_ms", 2000));
    let maxp = clamp_pages(json_i64(&profile, "max_pages", 1));
    let headers: Vec<String> = profile
        .get("fields")
        .and_then(|f| f.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|f| f.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    {
        let mut job = state.job.lock().map_err(|e| e.to_string())?;
        job.active = true;
        job.profile = profile.clone();
        job.current_page = 1;
        job.max_pages = maxp;
        job.delay_ms = delay;
        job.awaiting_reload = false;
        job.seen.clear();
    }
    *state.rows.lock().map_err(|e| e.to_string())? = Vec::new();
    *state.headers.lock().map_err(|e| e.to_string())? = headers;

    send_to_target(&app, serde_json::json!({ "action": "extract", "profile": profile }))
}

/// 대상 webview가 추출 결과를 되돌려 보냄. 잡 활성 시 누적·dedupe 후 다음 페이지 지시,
/// 비활성 시 단일 페이지 결과로 교체.
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
    *state.headers.lock().map_err(|e| e.to_string())? = headers.clone();

    let mut job = state.job.lock().map_err(|e| e.to_string())?;
    if job.active {
        let dedupe_key = job
            .profile
            .get("dedupe_key")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty()) // 빈 dedupe_key는 '키 없음'(전체 필드 join) 처리
            .map(String::from);
        let (total, preview) = {
            let mut acc = state.rows.lock().map_err(|e| e.to_string())?;
            for row in &rows {
                match row_key(row, dedupe_key.as_deref(), &headers) {
                    Some(k) => {
                        if job.seen.insert(k) {
                            acc.push(row.clone());
                        }
                    }
                    None => acc.push(row.clone()),
                }
            }
            let preview: Vec<Value> = acc.iter().take(10).cloned().collect();
            (acc.len(), preview)
        };
        let page = job.current_page;
        let maxp = job.max_pages;
        let more = page < maxp;
        let profile = job.profile.clone();
        if !more {
            job.active = false;
        }
        drop(job);

        app.emit(
            "uc-rows",
            serde_json::json!({ "count": total, "headers": headers, "preview": preview,
                "page": page, "max": maxp, "job": true, "done": !more }),
        )
        .map_err(|e| e.to_string())?;

        if more {
            send_to_target(
                &app,
                serde_json::json!({ "action": "paginate", "profile": profile, "currentPage": page }),
            )?;
        }
        Ok(total)
    } else {
        drop(job);
        let count = rows.len();
        let preview: Vec<&Value> = rows.iter().take(10).collect();
        *state.rows.lock().map_err(|e| e.to_string())? = rows.clone();
        app.emit(
            "uc-rows",
            serde_json::json!({ "count": count, "headers": headers, "preview": preview, "job": false }),
        )
        .map_err(|e| e.to_string())?;
        Ok(count)
    }
}

/// 대상 webview가 다음 페이지 행동을 보고 → 지연(≥2000ms) 후 navigate/scroll 지시.
#[tauri::command]
fn paginate_result(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    has_next: bool,
    href: Option<String>,
    scrolled: Option<bool>,
) -> Result<(), String> {
    let (delay, profile, scrolled_b, nav_href) = {
        let mut job = state.job.lock().map_err(|e| e.to_string())?;
        if !job.active {
            return Ok(());
        }
        if !has_next || job.current_page >= job.max_pages {
            job.active = false;
            let _ = app.emit("uc-rows", serde_json::json!({ "done": true, "job": true }));
            return Ok(());
        }
        job.current_page += 1;
        let s = scrolled.unwrap_or(false);
        job.awaiting_reload = !s; // reload형은 page_ready를 기다림
        (job.delay_ms, job.profile.clone(), s, if s { None } else { href })
    };

    // 지연(안전장치) 후 같은 페이지 재추출(infinite_scroll) 또는 navigate(reload형).
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay));
        if scrolled_b {
            let _ = app2.emit_to(
                EventTarget::webview_window("target"),
                "uc-cmd",
                serde_json::json!({ "action": "extract", "profile": profile }),
            );
        } else if let Some(h) = nav_href {
            if is_allowed_practice_url(&h) {
                if let (Some(win), Ok(u)) =
                    (app2.get_webview_window("target"), url::Url::parse(&h))
                {
                    let _ = win.navigate(u);
                }
            }
        }
        // jsButton click형은 이미 navigate 진행 중 → page_ready가 재추출 트리거.
    });
    Ok(())
}

/// 대상 webview 로드 완료 통지(재주입된 picker가 호출). 잡 진행 중 reload 대기였으면 재추출.
#[tauri::command]
fn page_ready(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    url: Option<String>,
) -> Result<(), String> {
    let _ = url;
    let (do_extract, profile) = {
        let mut job = state.job.lock().map_err(|e| e.to_string())?;
        if job.active && job.awaiting_reload {
            job.awaiting_reload = false;
            (true, job.profile.clone())
        } else {
            (false, Value::Null)
        }
    };
    if do_extract {
        send_to_target(&app, serde_json::json!({ "action": "extract", "profile": profile }))?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clamp_delay_enforces_min_2000() {
        assert_eq!(clamp_delay(0), 2000);
        assert_eq!(clamp_delay(500), 2000);
        assert_eq!(clamp_delay(-100), 2000);
        assert_eq!(clamp_delay(2000), 2000);
        assert_eq!(clamp_delay(5000), 5000);
    }

    #[test]
    fn clamp_pages_enforces_1_to_20() {
        assert_eq!(clamp_pages(0), 1);
        assert_eq!(clamp_pages(-5), 1);
        assert_eq!(clamp_pages(25), 20);
        assert_eq!(clamp_pages(9999), 20);
        assert_eq!(clamp_pages(7), 7);
    }

    #[test]
    fn practice_url_allowlist() {
        assert!(is_allowed_practice_url("https://quotes.toscrape.com/"));
        assert!(is_allowed_practice_url("https://books.toscrape.com/catalogue/page-2.html"));
        assert!(is_allowed_practice_url("https://www.scrapethissite.com/pages/forms/"));
        assert!(!is_allowed_practice_url("https://amazon.com/"));
        assert!(!is_allowed_practice_url("https://evil-toscrape.com.attacker.net/"));
        assert!(!is_allowed_practice_url("ftp://quotes.toscrape.com/"));
        assert!(!is_allowed_practice_url("not a url"));
    }

    #[test]
    fn row_key_uses_dedupe_field_when_present() {
        let row = json!({ "url": "https://x/1", "title": "A" });
        let headers = vec!["url".to_string(), "title".to_string()];
        assert_eq!(
            row_key(&row, Some("url"), &headers),
            Some("https://x/1".to_string())
        );
    }

    #[test]
    fn row_key_joins_all_fields_when_no_key() {
        let row = json!({ "title": "A", "price": 10 });
        let headers = vec!["title".to_string(), "price".to_string()];
        let k = row_key(&row, None, &headers).unwrap();
        assert!(k.contains('A') && k.contains("10"));
    }

    #[test]
    fn row_key_empty_returns_none() {
        let row = json!({ "url": "" });
        let headers = vec!["url".to_string()];
        assert_eq!(row_key(&row, Some("url"), &headers), None);
        let empty = json!({ "a": null, "b": "" });
        let h = vec!["a".to_string(), "b".to_string()];
        assert_eq!(row_key(&empty, None, &h), None);
    }

    #[test]
    fn csv_escape_rfc4180() {
        assert_eq!(csv_escape("plain"), "plain");
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("a\"b"), "\"a\"\"b\"");
        assert_eq!(csv_escape("a\nb"), "\"a\nb\"");
    }

    #[test]
    fn build_csv_has_bom_crlf_and_rows() {
        let rows = vec![json!({ "t": "Q,1", "a": "Kim" }), json!({ "t": "Q2", "a": null })];
        let headers = vec!["t".to_string(), "a".to_string()];
        let csv = build_csv(&rows, &headers);
        assert!(csv.starts_with('\u{feff}'), "BOM 선두");
        assert!(csv.contains("\r\n"), "CRLF");
        assert!(csv.contains("\"Q,1\""), "쉼표 셀 이스케이프");
        assert!(csv.contains("t,a"), "헤더");
        // null 셀은 빈칸
        assert!(csv.trim_end().ends_with("Q2,"));
    }
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
            start_collect,
            collect_rows,
            paginate_result,
            page_ready,
            robots_status,
            set_consent,
            export_csv,
            export_json
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
