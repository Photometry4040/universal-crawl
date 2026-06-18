# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

교육/테스트 전용 **시각적 셀렉터 기반 데이터 추출 크롬 익스텐션 (Manifest V3)**. 사용자가 페이지에서 샘플 요소를 클릭하면 공통 CSS 셀렉터를 역추론하여 유사 요소를 일괄 추출하고, 페이지를 넘기며 누적 수집해 CSV/JSON으로 내보낸다.

**구현 상태**: 초기 단계. 현재 `manifest.json`만 존재. 전체 설계 계획은 `~/.claude/plans/keen-orbiting-harp.md`에 있으며 이것이 아키텍처의 권위 있는 출처다.

## 핵심 제약 (반드시 준수)

- **빌드 스텝 없음** — 바닐라 JS, 외부 CDN/npm 의존 0. `chrome://extensions` → "압축해제된 확장 프로그램 로드"로 즉시 동작해야 한다. 번들러/트랜스파일 도입 금지.
- **책임 있는 추출 안전장치는 기능 요구사항** (옵션 아님): robots.txt 경고 배너, 페이지 간 지연 하한 2000ms, 페이지 수 상한 20, 첫 추출 전 ToS 확인 체크박스 게이트. 이 안전장치를 약화시키지 말 것.
- **회피 기능 일절 금지** — 프록시, User-Agent 위조, CAPTCHA 처리, 로그인 자동화는 명시적 비목표.
- 모든 소스 파일 상단에 신원 표시 주석: `/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */`
- 테스트는 연습 전용 사이트만 사용: `books.toscrape.com`, `quotes.toscrape.com`, `scrapethissite.com`. 실제 상업 사이트(아마존 등) 사용 금지.

## 개발 워크플로우

확장 빌드 스텝은 없다. 변경 후:
1. `chrome://extensions` → 개발자 모드 ON → "압축해제된 확장 프로그램 로드" → 이 디렉터리 선택.
2. 코드 수정 후 확장 카드의 새로고침(↻) 버튼 클릭. content script 변경은 대상 페이지도 새로고침 필요.
3. 디버깅: 팝업은 우클릭 → "검사", service worker는 확장 카드의 "service worker" 링크, content script는 페이지 DevTools 콘솔.

**자동 테스트(`e2e/`, 확장 본체와 분리·node_modules는 gitignore):**
- `cd e2e && node unit.js` — 순수 로직 27종(robots/clamp/csv/transform). 실제 모듈을 node로 로드, 브라우저 불필요.
- `cd e2e && npm install && npx playwright install chromium && node run.js` — **실제 확장을 Playwright 번들 Chromium에 로드**해 SW 오케스트레이션·안전장치·3페이지 수집까지 18종 e2e. 시스템 Chrome 137+는 `--load-extension`을 제거했으므로 번들 Chromium(Chrome for Testing) 필수.

테스트는 연습 전용 사이트만 사용한다.

## 아키텍처

세 실행 컨텍스트가 메시지로 통신한다. 컨텍스트 경계와 그 제약이 이 코드베이스의 핵심이다.

### 컨텍스트 구성
- **popup/** — 컨트롤 패널 UI (6개 섹션: 대상확인/행선택/필드매핑/페이지네이션/실행/결과). DOM 보유. robots.txt fetch와 안전장치 입력 보정(delay≥2000, max_pages≤20)을 여기서 수행. **`chrome.sidePanel`로 동작**(manifest `side_panel.default_path`, 액션 클릭 시 `setPanelBehavior({openPanelOnActionClick:true})`로 열림) — 페이지 요소를 클릭하며 선택하는 동안에도 닫히지 않고, `chrome.tabs.query({active})`가 실제 웹 탭을 가리킨다(탭 전환 시 `tabs.onActivated`로 대상 갱신). 상태 동기화는 `chrome.storage.onChanged`. 같은 `popup/popup.html`이 사이드 패널 페이지로 쓰인다.
- **content/** — 대상 페이지에 정적 주입(`content_scripts`, `<all_urls>`, `document_idle`). 주입 순서가 중요: `lib/finder.js` → `selector-infer.js` → `extractor.js` → `paginator.js` → `content.js`. 각 모듈은 `window.__ucFinder` / `__ucInfer` / `__ucExtract` / `__ucPaginate` 전역으로 서로를 호출한다 (ES module 아님 — 전역 네임스페이스 규약).
- **background.js** — 서비스 워커. 다중 페이지 수집 잡(job)의 오케스트레이터. DOM/Blob URL 없음 → 다운로드는 반드시 data URL(`encodeURIComponent(BOM+payload)`)로 생성.

### 가장 중요한 설계 결정: 리로드를 넘는 수집 오케스트레이션
`next_button`/`url_pattern` 페이지네이션은 전체 페이지 리로드를 유발해 content script 상태가 초기화된다. 따라서 **다중 페이지 누적은 background가 주도하고 `chrome.storage.local["uc_job"]`에 잡 상태를 영속화**한다:
- 잡 상태: `{ active, tabId, profile, currentPage, maxPages, delayMs, rows[], seenKeys[], paginationType }`.
- 흐름: background가 content에 추출 요청 → 결과 dedupe 후 `rows` 누적 → delay(≥2000ms 강제) 후 페이지 전환 → 리로드형은 `tabs.onUpdated`의 `status==='complete'`를 대기하고 재주입된 content script의 `ready` 핸드셰이크로 재추출, infinite_scroll은 리로드 없이 content에 스크롤+추출 지시.
- content script는 로드 시 `uc_job.active && tabId===현재탭`이면 background에 `ready`를 통지해 잡을 재개한다.
- 새 content/background 코드를 짤 때 이 핸드셰이크를 깨지 않도록 주의. 단일 페이지 추출조차 이 메시지 경로를 공유한다.

### 셀렉터 추론
`lib/finder.js`는 `@medv/finder`(MIT) 알고리즘을 외부 의존 없이 재구현한 vendored 단일 파일. `selector-infer.js`가 그 위에서 일반화 휴리스틱을 얹는다: 샘플 1개는 finder 셀렉터를 완화(`:nth-child`·id 제거)해 형제 유사 요소를 포함, 2개+는 클래스 교집합·공통 조상 구조로 최소 공통 셀렉터를 도출. 필드는 행(row) 기준 **상대 경로**로 추론한다(`inferRelative(rowEl, fieldEl)`).

### 데이터 모델 — 프로필(Profile)
사이트 설정의 단일 진실 공급원. export/import(파일)와 잡 상태 모두 이 스키마를 공유한다:
```json
{
  "row_selector": ".product-card",
  "fields": [{ "name": "...", "selector": "...", "attr": "text|href|src|<속성명>", "transform": "to_number|trim|none" }],
  "pagination": { "type": "next_button|url_pattern|infinite_scroll", "selector": "...", "pattern": "...?page={N}" },
  "delay_ms": 3000, "max_pages": 10, "dedupe_key": "url"
}
```
`profiles/`의 샘플 JSON은 import만으로 동작 시연이 가능해야 한다.

## 규약

- content script 모듈 간 통신은 ES import가 아니라 `window.__uc*` 전역. 새 모듈도 이 패턴을 따르고 manifest의 주입 순서 배열을 업데이트한다.
- CSV는 UTF-8 BOM(`﻿`) + RFC4180 이스케이프로 한글/일본어 엑셀 호환을 보장.
- 안전장치 상한/하한은 popup 입력 보정과 background 재검증 **양쪽**에서 강제 (UI 우회 방지).
