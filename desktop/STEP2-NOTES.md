<!-- 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. -->
# STEP2 NOTES — 데스크탑 Rust 커맨드 설계

2단계에서 이식한 JS 자산(`src-tauri/inject/`)을 Tauri 백엔드와 묶기 위한 커맨드 설계.
원칙: **안전장치는 백엔드에서 무조건 재검증**(UI/프로필 import로 우회 불가). 외부 전송 0.

## 이식된 JS 자산 (WebView/주입 컨텍스트에서 동작)
| 파일 | 전역 | 용도 |
|------|------|------|
| `finder.js` | `__ucFinder` | 셀렉터 빌더 |
| `selector-infer.js` | `__ucInfer` | 공통 셀렉터 추론 |
| `extractor.js` | `__ucExtract` | `extractPage(profile)` → `[{name:value}]` |
| `picker.js` | `__ucPicker*` | 시각적 집기 |
| `robots.js` | `__ucRobots` | `parseRobots`/`isAllowed`/`looksLikeRobots` |
| `serialize.js` | `__ucSerialize` | `clampDelay`/`clampPages`/`csvEscape`/`buildCsv` |

## 제안 Rust 커맨드 시그니처

```rust
// 1) 추출: 대상 webview에서 __ucExtract.extractPage 실행 결과를 받아 누적.
//    (JS 측에서 invoke('collect_rows', { rows }) 호출, 또는 eval 결과 회수)
#[tauri::command]
fn collect_rows(app: AppHandle, rows: Vec<serde_json::Value>) -> Result<usize, String>;

// 2) 내보내기: rows + fields → CSV/JSON 문자열 생성 후 파일 저장(다이얼로그).
//    CSV는 serialize.js의 규칙과 동일(UTF-8 BOM + RFC4180 + CRLF)을 Rust에서 재구현하거나,
//    WebView에서 __ucSerialize.buildCsv로 만든 문자열을 받아 그대로 저장.
#[tauri::command]
async fn export_csv(app: AppHandle, csv: String, suggested_name: String) -> Result<String, String>;
#[tauri::command]
async fn export_json(app: AppHandle, rows: Vec<serde_json::Value>, suggested_name: String) -> Result<String, String>;
//   → tauri-plugin-dialog(save) + tauri-plugin-fs(write)로 로컬 저장.
//     크롬 확장의 data URL 다운로드와 달리 데스크탑은 네이티브 파일 저장이 가능(대용량 안전).

// 3) 안전장치 백엔드 재검증 — 모든 수집 시작/페이지 전환 직전 무조건 클램프.
fn clamp_delay(ms: i64) -> i64 { ms.max(2000) }            // serialize.js MIN_DELAY_MS
fn clamp_pages(n: i64) -> i64 { n.clamp(1, 20) }           // serialize.js MAX_PAGES_CAP
#[tauri::command]
fn start_collect(app: AppHandle, profile: Profile) -> Result<(), String>;
//   profile.delay_ms = clamp_delay(...), profile.max_pages = clamp_pages(...)를 강제 후 진행.
//   → UI(main.js)의 입력 보정과 합쳐 이중 검증(현 확장 구조 계승).

// 4) consent — origin별 ToS 확인. tauri-plugin-store 또는 자체 JSON 파일.
//    { [origin]: { tos: bool, robots_ack: bool, ts: i64 } }. 프로필 export엔 직렬화하지 않음(import 후 재확인).
#[tauri::command]
fn set_consent(app: AppHandle, origin: String, tos: bool, robots_ack: bool) -> Result<(), String>;
#[tauri::command]
fn get_consent(app: AppHandle, origin: String) -> Result<Consent, String>;
//   start_collect는 origin consent(tos && robots_ack) 없으면 거부.
```

## robots.txt fetch 위치 권고
- **컨트롤 패널(메인 webview)의 JS `fetch(origin + '/robots.txt')`** 권장(AbortController 5s).
  - 근거: 기존 확장 popup 로직(`__ucRobots.parseRobots`/`isAllowed`/`looksLikeRobots`)을 그대로 재사용.
  - 상태 분기: 200+텍스트만 파싱 / 4xx(429 제외)=규칙없음 🟢 / 5xx·실패·타임아웃=🟠 보수적 차단.
  - soft-404 방어: `looksLikeRobots(text)`가 false면 규칙 없음 처리.
- 단, 메인 webview는 로컬 origin(tauri://)이라 cross-origin fetch가 CSP/CORS에 막힐 수 있음 →
  **대안**: Rust에서 `reqwest`로 fetch 후 텍스트를 JS로 전달(`fetch_robots(origin) -> String`).
  데스크탑에선 이 Rust 경로가 더 안정적(원격 CORS 영향 없음). 권장: **Rust fetch + JS 파싱**.

## 다음 단계
- 위 커맨드를 `lib.rs`에 배선(대장 Claude Code가 통합).
- 페이지네이션 오케스트레이션: 임베디드 webview는 리로드돼도 앱 프로세스가 살아있어
  크롬 확장처럼 SW 종료/재개 핸드셰이크가 불필요 → Rust 상태로 단순화 가능(설계 이점).
- 의존 플러그인 추가 필요: `tauri-plugin-dialog`, `tauri-plugin-fs`, (선택)`tauri-plugin-store`, `reqwest`.
