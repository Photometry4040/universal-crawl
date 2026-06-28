<!-- 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. -->
# UniCrawl Desktop

회사 보안 정책상 크롬 확장 프로그램을 쓸 수 없는 환경을 위한 **시각적 데이터 추출
데스크탑 앱**. 외부 브라우저를 자동제어하지 않고 **앱 내장 WebView(Tauri)** 에서
자기완결적으로 동작한다("원격 자동화" 위협 분류 회피, 시스템 WebView라 앱 크기 최소).

> 스택: **Tauri v2 + 임베디드 시스템 WebView**. 크롬 확장(universal-crawl)의 검증된
> 셀렉터 로직(`finder.js`/`selector-infer.js`/`extractor.js`/`paginator.js`/`robots.js`)을
> 그대로 주입해 재사용한다.

## 핵심 사용 흐름 (초보자: 클릭 몇 번이면 끝)

1. **대상 열기** — `quotes`/`books`/`scrapethissite` 칩 클릭(연습 전용 사이트).
2. **① ToS 확인** — robots.txt 배너(🟢/🔴/🟠)를 보고 ToS 체크박스에 체크.
   체크 전에는 추출 버튼이 비활성(섹션이 노랗게 강조).
3. **② 목록 항목 하나 클릭** — 비슷한 항목을 자동 감지하고, 그 안의 정보
   (제목·가격·링크 등)를 **컬럼으로 자동 분리**해 ③에 채운다. 페이지의 "다음" 링크도
   자동 감지해 ④에 채운다("다음 페이지 자동 감지됨 ✓").
4. **③ 항목 다듬기** — 필요 없는 컬럼은 ✕로 삭제, 이름만 변경. 셀렉터/속성/변환은
   "고급"에 숨겨져 있음(직접 편집 가능).
5. **⑤ 실행** — `전체 수집(여러 페이지 자동)` → 여러 페이지를 넘기며 누적 →
   `CSV 저장`/`JSON 저장`(다운로드 폴더).

## 기능

- **자동 추출(Auto-detect)**: 항목 1회 클릭 → 반복 행 감지 + 컬럼 자동 발견
  (coverage<30%·전행 동일값 보일러플레이트 제외, 클래스/aria 기반 자동 명명).
- **필드 매핑**: 컬럼별 상대 셀렉터/속성(text·href·src·text_all·임의속성)/변환
  (to_number·trim·word_to_number). 행 안쪽 요소를 클릭해 집기(`집기`).
- **페이지네이션**: `next_button`(빈 입력 시 다음 링크 자동 탐색)·`url_pattern`
  (`{page}`/`{N}` 치환)·`infinite_scroll`. 다중 페이지 누적 + dedupe.
- **내보내기**: CSV(UTF-8 BOM + RFC4180 + CRLF, 한글 엑셀 호환) / JSON, 다운로드 폴더 저장.
- **진단**: 패널 진행률 줄 + 대상 창 좌하단 박스에 IPC/페이지네이션 단계 로깅
  (silent 실패 방지).

## 안전장치(우회 불가, 백엔드 재검증)

- **연습 전용 사이트만**: `open_target`이 `toscrape.com`/`scrapethissite.com` 외 거부.
- **robots.txt 준수**: 대상 origin의 robots.txt를 same-origin fetch → `robots.js`(RFC 9309)
  판정. 🔴 Disallow/🟠 확인불가는 "이해했고 계속" 명시 확인 필요.
- **ToS 게이트**: origin 스코프 consent(ToS+robots 확인) 없으면 `request_extract`/
  `start_collect`를 백엔드가 거부(UI 우회 불가).
- **지연 하한 2000ms / 페이지 상한 20**: UI 보정 + Rust 무조건 재클램프.
- 회피 기능(프록시·UA 위조·CAPTCHA·로그인 자동화) 일절 없음. 외부 전송 없음(로컬 전용).

## 실행

```bash
# 사전: Rust 툴체인 필요 (없으면) — curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cd desktop
npm install
npm run tauri dev      # 첫 빌드는 Rust 크레이트 컴파일로 수 분 소요
```

## 테스트

```bash
cd desktop/src-tauri && cargo test     # Rust 8종: 클램프·dedupe·CSV(BOM/RFC4180)·URL 허용목록
cd desktop/e2e && npm install && npm test  # jsdom 31종: 셀렉터 전달·필드집기·추출·페이지네이션·autoFields
```

> GUI 전체 흐름은 macOS WKWebView가 WebDriver 자동화를 막아 헤드리스 자동 구동이 불가 →
> 위 단위/로직 테스트로 핵심을 덮고, 런타임은 화면 진단 로그로 추적한다.

## 구조

```
desktop/
├── src/                      # 컨트롤 패널(메인 윈도, 바닐라 JS)
│   ├── index.html            #   ①대상확인 ②항목클릭 ③필드 ④페이지네이션 ⑤실행·결과
│   ├── main.js               #   open_target/start_collect/export 호출 + uc-* 이벤트 수신
│   └── styles.css
├── e2e/picker.test.js        # jsdom 로직 e2e
└── src-tauri/
    ├── src/lib.rs            # 잡 상태머신·커맨드·CSV직렬화·안전장치 + cargo test
    ├── inject/               # 대상 페이지 주입(순서: finder→infer→extractor→robots→
    │                         #   serialize→paginator→picker). 확장 자산 vendored copy.
    ├── build.rs              # AppManifest로 app command ACL 권한 생성
    ├── capabilities/         # default.json(로컬 main) / target.json(원격 대상, remote.urls)
    └── tauri.conf.json
```

### 아키텍처 핵심
- **통신은 Tauri 이벤트**: 대상→백엔드 `invoke('on_pick'/'collect_rows'/…)`,
  백엔드→대상 `emit_to('uc-cmd', …)`(원격 webview에서 `eval`은 불안정 → 미사용).
- **Tauri v2 ACL**: 원격 origin webview가 app command를 호출하려면 `build.rs`의
  `AppManifest::commands([...])`로 `allow-<command>` 권한을 생성하고 capability에 추가해야
  한다(`remote.urls`만으론 부족). 매니페스트를 켜면 로컬 윈도 커맨드도 ACL 대상이 됨.
- **다중 페이지 오케스트레이션**: Rust가 잡 상태를 들고 `navigate`→재주입 picker의
  `page_ready`(pull 핸드셰이크)→재추출. 데스크탑은 프로세스 영속이라 확장의 SW idle-종료
  문제가 없어 단순.

## 배포(미구현, 향후)
release 빌드 + 코드서명(Win signtool / mac Developer ID + notarization) + 무관리자
포터블 ZIP + 백신 화이트리스트.
