<!-- 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. -->
# UniCrawl Desktop (PoC)

회사 보안 정책상 크롬 확장 프로그램을 쓸 수 없는 환경을 위해, 기존
universal-crawl(시각적 셀렉터 기반 데이터 추출 크롬 익스텐션)을 **데스크탑 앱**으로
옮기는 PoC. 외부 브라우저를 자동제어하지 않고 **앱 내장 WebView**에서 자기완결적으로
동작한다(보안 심사 단순화·"원격 자동화" 위협 분류 회피).

> 3-에이전트(codex×2 + claude) 합의로 **Tauri + 임베디드 WebView** 채택.
> 근거: 앱 크기 최소(시스템 WebView 사용)·무관리자 포터블 배포·낮은 백신 탐지 면적.

## 이 PoC가 증명하는 것

1. **임베디드 WebView**에 검증된 셀렉터 추론 로직(`finder.js`+`selector-infer.js`)을
   그대로 주입 → 크롬 확장의 content script 자산 재사용 가능.
2. **클릭 → 공통 셀렉터 역추론 → 유사 요소 하이라이트 + 매칭 개수**라는 핵심 UX를
   브라우저 확장 없이 재현.
3. 집은 셀렉터를 **Tauri IPC로 컨트롤 패널에 전달**(Layer2 브리지).

## 구조

```
desktop/
├── src/                     # 컨트롤 패널(메인 윈도) — 바닐라 JS
│   ├── index.html           #   ① 대상 열기  ② 집은 셀렉터 표시
│   ├── main.js              #   open_target 호출 + 'uc-pick' 이벤트 수신
│   └── styles.css
└── src-tauri/
    ├── src/lib.rs           # open_target(주입) / on_pick(패널로 emit)
    ├── inject/              # 대상 페이지에 주입되는 스크립트(주입 순서 중요)
    │   ├── finder.js        #   ← lib/finder.js 재사용(vendored copy)
    │   ├── selector-infer.js#   ← content/selector-infer.js 재사용(vendored copy)
    │   └── picker.js        #   hover/클릭 집기 + 페이지 내 배지 + IPC 브리지
    ├── capabilities/
    │   ├── default.json     # 메인 윈도 권한
    │   └── target.json      # 대상 윈도: 연습 사이트 원격 IPC 허용
    └── tauri.conf.json
```

### 2-레이어 설계(리스크 분리)
- **Layer 1 (IPC 불필요, 항상 동작)**: picker.js가 대상 페이지 안에서 직접
  하이라이트하고 추론 결과를 **페이지 내 배지**로 표시.
- **Layer 2 (IPC 브리지)**: 동일 결과를 `invoke('on_pick')`으로 컨트롤 패널에 전달.
  원격(http) 페이지의 Tauri IPC는 `capabilities/target.json`의 `remote.urls`로 허용.

## 실행

```bash
cd desktop
npm install
npm run tauri dev      # 첫 빌드는 Rust 크레이트 컴파일로 수 분 소요
```

1. 메인 창에서 `quotes`/`books`/`scrapethissite` 칩 클릭 또는 URL 입력 → **대상 열기**
2. 새로 열린 **대상 창**에서 항목(예: quotes의 한 인용구 카드)을 **클릭**
3. 유사 요소가 점선으로 하이라이트되고, 좌측 상단 배지 + 메인 패널에
   `셀렉터 / 매칭 개수 / 예시 텍스트` 표시. `ESC`로 선택 종료.

## 안전장치(기존 도구에서 계승, PoC 범위)

- **연습 전용 사이트만 허용**: `open_target`이 `toscrape.com`/`scrapethissite.com`
  외 URL을 거부(백엔드 강제). 회피·무단 대량수집 비목표 유지.
- 외부 전송 없음: 네트워크는 대상 페이지 로드뿐. 수집/설정은 향후 로컬 전용.

## 알려진 제약 / 다음 단계(step 2에서 검증·구현)

- **원격 페이지 IPC**: `withGlobalTauri` + `remote.urls` 조합으로 주입 스크립트가
  `window.__TAURI__`에 접근. macOS WKWebView·일부 SPA에서 주입 타이밍/네트워크
  인터셉트 동작을 추가 검증 필요(Tauri 고유 통합 리스크).
- 아직 구현 안 됨(기존 확장에는 있음): 필드 매핑, 페이지네이션(next/url/scroll),
  다중 페이지 누적 오케스트레이션, robots.txt 배너, ToS 게이트, CSV/JSON 내보내기.
  → 검증된 `extractor.js`/`paginator.js`/`robots.js`/`serialize.js`를 이식 예정.
- 배포: 코드서명(Win signtool / mac Developer ID + notarization), 무관리자
  포터블 ZIP, 백신 화이트리스트는 별도 단계.
