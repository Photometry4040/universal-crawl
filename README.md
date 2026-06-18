<!-- 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. -->
# Universal Selector Extractor (교육·테스트용)

웹페이지에서 **샘플 요소를 클릭**하면 공통 CSS 셀렉터를 역추론하여 유사 요소를 일괄 추출하고,
테이블로 구조화한 뒤 페이지를 넘기며 누적 수집해 **CSV/JSON**으로 내보내는 Chrome 확장(Manifest V3)입니다.

> ⚠️ **이 도구는 교육/테스트 목적입니다.** 대상 사이트의 `robots.txt`와 이용약관(ToS)을 **반드시 준수**하는
> 범위에서만 사용하세요. 아래 **연습 전용 공개 사이트**로 학습하고, 실제 상업 사이트(아마존·요도바시·楽天 등)는
> 테스트 대상으로 사용하지 마세요.

---

## 책임 있는 추출 — 내장 안전장치

이 확장은 다음을 **기능으로 강제**합니다(옵션이 아님):

1. **robots.txt 확인 배너** — 추출 전 현재 도메인의 `/robots.txt`를 가져와 현재 경로가 `Disallow`면 🔴 빨간 경고를
   표시하고, 사용자가 "이해했고 계속한다"를 눌러야만 진행됩니다. (RFC 9309 기준: User-agent `*` 그룹, 최장 패턴 우선,
   동률 시 Allow 우선, `*`/`$` 와일드카드 지원.) 확인 불가(서버 오류/네트워크 실패)는 🟠로 **보수적 차단**됩니다.
2. **지연 하한 2000ms** — 페이지 간 지연은 최소 2000ms. 더 낮게 입력하면 2000으로 보정되고, background에서
   타임스탬프 비교로 재검증합니다.
3. **페이지 수 상한 20** — 한 번의 수집은 최대 20페이지. 초과 입력은 20으로 보정됩니다.
4. **ToS 체크 게이트** — 첫 추출 전 "ToS에서 자동 수집 허용 여부를 확인했습니까?" 체크를 통과해야 추출 버튼이 활성화됩니다.
5. 위 한도·게이트는 popup 입력 보정과 **background 재검증** 양쪽에서 강제되어, 프로필 import로도 우회할 수 없습니다.

이 도구에는 **봇 차단 우회·프록시·User-Agent 위조·CAPTCHA/로그인 자동화 기능이 없습니다.**

---

## 설치 / 로드

1. Chrome 주소창에 `chrome://extensions` 입력.
2. 우측 상단 **개발자 모드** 켜기.
3. **압축해제된 확장 프로그램 로드** 클릭 → 이 폴더(`universal-crawl`) 선택.
4. 툴바에 보라색 아이콘이 생기면 클릭 → **오른쪽에 사이드 패널이 열립니다**. 사이드 패널은 페이지에서 요소를 클릭하며 선택하는 동안에도 **닫히지 않습니다**(요소 선택이 편함).

코드 수정 후에는 확장 카드의 새로고침(↻) 버튼을 누르고, content script 변경 시 대상 페이지도 새로고침하세요.

> **자동 검증**: `e2e/`에 Playwright 기반 end-to-end 테스트가 있습니다(실제 확장 로드 → 서비스워커
> 오케스트레이션·안전장치·3페이지 수집까지 18개 항목, `e2e/README.md` 참고). 핵심 순수 로직(robots 파서,
> CSV RFC4180/BOM, 클램프, transform)은 별도 node 단위테스트로 검증됩니다.

---

## 사용법 (단계별)

1. **대상 페이지**를 엽니다(예: `https://quotes.toscrape.com`). 아이콘을 눌러 사이드 패널을 엽니다.
2. **섹션 1 대상 확인**: robots.txt 상태(🟢/🔴/🟠)를 확인하고, ToS 체크박스를 선택합니다. 🔴/🟠면 경고 배너의
   "이해했고 계속한다"를 눌러야 진행됩니다. (다른 탭으로 전환하면 패널이 그 탭 기준으로 자동 갱신됩니다.)
3. **섹션 2 행 선택**: "행 선택 모드 시작"을 누르면 패널은 그대로 둔 채 페이지에서 선택 모드가 켜집니다.
   수집할 항목(예: 인용구 카드)을 **2개 클릭**하면 공통 셀렉터가 추론되고 매칭 요소가 주황색으로 미리보기됩니다.
   빽빽하게 중첩된 카드(스펙 표 등)에서는 깊은 하위 요소를 클릭해도 **반복되는 카드 컨테이너로 자동 스냅**됩니다.
   `ESC`로 종료하면 패널의 `row_selector`와 매칭 개수가 실시간으로 채워집니다.
4. **섹션 3 필드 매핑**: "필드 선택 모드"를 누르고 행 **안쪽**의 값(제목·가격 등)을 클릭하면 컬럼으로 추가됩니다.
   이름/셀렉터/attr/transform을 편집할 수 있습니다.
   - `attr`: `text`(기본) · `href` · `src` · `text_all`(여러 요소를 `; `로 합침) · `class` · `classToken:N`(N번째 클래스) · 임의 속성명
   - `transform`: `none` · `trim` · `to_number`(숫자만) · `word_to_number`(One→1)
5. **섹션 4 페이지네이션**: 모드(next_button/url_pattern/infinite_scroll)와 셀렉터/패턴, delay, max_pages를 설정합니다.
6. **섹션 5 실행**: "현재 페이지 추출"로 단건 확인 후, "N페이지 수집"으로 자동 누적합니다. 진행률이 표시됩니다.
7. **섹션 6 결과**: 상위 10행 미리보기 후 CSV/JSON 다운로드.
   - "현재 페이지 추출"만 해도 그 결과로 바로 다운로드됩니다(수집을 돌릴 필요 없음).
   - **저장 폴더**(선택)에 폴더명을 적으면 다운로드 폴더 하위에 저장됩니다(예: `universal-crawl` → `~/Downloads/universal-crawl/`). 비우면 다운로드 폴더로 바로 저장됩니다.
   - "다운로드할 때마다 저장 위치 묻기"를 켜면 매번 저장 위치를 선택할 수 있습니다.
   - 현재 설정은 "프로필 export"로 저장하고 다른 세션에서 import할 수 있습니다.

---

## 샘플 프로필 (import만으로 시연)

`profiles/`의 JSON을 섹션 6 **프로필 import**로 불러오면 즉시 동작합니다(ToS/robots는 보안상 매번 재확인 필요).

| 프로필 | 사이트 | 페이지네이션 | 검증 포인트 |
|---|---|---|---|
| `books-toscrape.json` | books.toscrape.com | next_button | 가격(to_number)·평점(classToken+word_to_number) |
| `quotes-toscrape.json` | quotes.toscrape.com | next_button | 다중 태그(text_all) |
| `scrapethissite-forms.json` | scrapethissite.com | url_pattern (`?page_num={N}`) | URL 패턴 경로 |

---

## 테스트 시나리오 (연습 사이트)

- `https://books.toscrape.com` — 도서 목록 + 페이지네이션
- `https://quotes.toscrape.com` — 인용구 + next 버튼 / `quotes.toscrape.com/scroll` — 무한 스크롤 데모
- `https://www.scrapethissite.com/pages/forms/` — 테이블 + `?page_num=` URL 페이지네이션

1. 압축해제 로드 → 아이콘 클릭 → 팝업 표시.
2. quotes에서 `.quote` 1~2개 클릭 → 유사 요소 하이라이트 + 매칭 개수.
3. 필드 2개+ 매핑 → "현재 페이지 추출" → 미리보기 테이블에 다수 행.
4. books `books-toscrape.json` import → "3페이지 수집" → **각 페이지 사이 2초+ 지연**, 진행률 갱신, 누적.
5. scrapethissite forms `scrapethissite-forms.json` import → url_pattern 3페이지 수집.
6. `quotes.toscrape.com/scroll`에서 pagination을 infinite_scroll로 설정 → 폴링/타임아웃 종료 확인.
7. CSV 다운로드 → 한글/따옴표/쉼표/개행 포함 셀이 Excel에서 깨짐·열밀림 없이 열림(UTF-8 BOM + RFC4180).
8. robots Disallow 경로 → 🔴 경고, 미확인 시 추출 차단. (books `/catalogue`는 Allow 우선순위로 거짓 차단되지 않음.)
9. `max_pages: 9999`, `delay_ms: 0` 으로 수정한 프로필 import → background가 20·2000으로 재클램프.
10. 프로필 export → import 시 추출 설정 복원(ToS/robots 확인 상태는 미복원).

> 서비스 워커 라이프사이클 검증: 수집 중 `chrome://serviceworker-internals`에서 SW를 강제 종료해도
> 잡이 이벤트(페이지 로드)로 재개되는지 확인하세요.

---

## 아키텍처 요약

- **content/** (대상 페이지 주입): 시각 선택 UI(`content.js`), 셀렉터 추론(`selector-infer.js` + `lib/finder.js`),
  추출(`extractor.js`, `:scope` 강제), 페이지네이션(`paginator.js`). 모듈 간 통신은 `window.__uc*` 전역.
- **background.js** (서비스 워커): 수집 잡 상태머신(`uc_job`, storage가 단일 진실 공급원). 모든 진행은 이벤트 구동이며,
  리로드 후 재개는 **content→background `ready` 단일 pull**로 처리(SW가 ~30초 idle 시 종료되어도 안전).
- **popup/**: 6개 섹션 컨트롤. robots.txt 판정과 안전장치 입력 보정. 진행률/선택 결과는 `chrome.storage.onChanged`로 동기화.
- **lib/robots.js**: RFC 9309 robots.txt 파서(외부 의존 0).

---

## 한계 / 주의

- **다운로드는 data URL 방식**입니다. 연습 사이트 규모(수백~천 행)에서 안전하지만, 매우 큰 수집은 data URL 길이 한계에
  걸릴 수 있습니다. (향후 확장: `chrome.offscreen` BLOBS로 Blob URL 폴백.)
- content script가 `<all_urls>`에 정적 주입되어 모든 탭에서 로드됩니다(상시 주입 비용). MVP 단순성을 위한 선택입니다.
- 페이지네이션 셀렉터/패턴은 **수기 입력**(또는 샘플 프로필)으로 지정합니다. 클릭 추론은 향후 확장 대상입니다.
- AJAX 로더 대기(버튼 클릭 후 부분 갱신)·로그인·CAPTCHA는 비목표입니다.

---

## 향후 확장 (미구현 메모)

- Electron 데스크톱 앱 이식(백그라운드 자동화 + SQLite 적재).
- 공식 API 커넥터(楽天·Yahoo!쇼핑) — 합법 경로 우선 워크플로우.
- 셀렉터 자동 복원(사이트 리뉴얼 시 유사도 기반 재매칭).
- `chrome.offscreen` 기반 대용량 다운로드.
