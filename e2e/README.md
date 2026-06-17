# E2E 테스트 (확장 본체와 분리)

실제 확장을 **Playwright 번들 Chromium(Chrome for Testing)** 에 로드해 background 서비스워커
오케스트레이션까지 검증한다. 시스템 Chrome 137+는 `--load-extension`을 제거했으므로
번들 Chromium을 사용한다(Chromium/CfT에는 플래그가 남아있음).

## 실행

```bash
cd e2e
npm install            # playwright
npx playwright install chromium   # 풀 Chromium 1회 다운로드 (헤드리스-shell 아님)
node run.js            # 헤디드로 확장 로드 후 검증
```

> 네트워크 필요(quotes.toscrape.com 접속). `node run.js`는 시작 시 `.user-data`를 정리한다.

## 검증 항목 (18 PASS)

- 확장 서비스워커 등록(SW 시작, 로드 오류 없음)
- content script 격리월드 주입(`__ucContentLoaded`/`__ucExtract`)
- `content onMessage → extractPage`(background→content cross-context), 10행 추출, 필드 채움
- **안전장치**: consent 없으면 `startCollect` 거부 / `max_pages 9999·delay 0` → 20·2000 재클램프
- **오케스트레이션**: 3페이지 수집 완료, 리로드 넘어 재개(pull 핸드셰이크), 누적 30행, dedupe 30/30, 페이지 간 2초+ 지연
- popup 6개 섹션 렌더 + 런타임 오류 없음

CSV RFC4180/BOM 직렬화·robots 파서 등 순수 로직은 별도 node 단위테스트로 검증한다
(실 다운로드는 `saveAs` 다이얼로그라 e2e에서 생략).
