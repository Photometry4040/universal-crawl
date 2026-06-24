# E2E 테스트 (확장 본체와 분리)

실제 확장을 **Playwright 번들 Chromium(Chrome for Testing)** 에 로드해 background 서비스워커
오케스트레이션까지 검증한다. 시스템 Chrome 137+는 `--load-extension`을 제거했으므로
번들 Chromium을 사용한다(Chromium/CfT에는 플래그가 남아있음).

## 실행

```bash
cd e2e
npm install                       # playwright
npx playwright install chromium   # 풀 Chromium 1회 다운로드 (헤드리스-shell 아님)

npm run test:unit   # 순수 로직 30종 (브라우저 불필요)
npm run test:e2e    # 오케스트레이션 18종 (헤디드)
npm run test:ux     # UX 상호작용 21종 (헤디드)
npm test            # 위 셋 순차 실행
```

> 네트워크 필요(quotes.toscrape.com 접속). 각 스크립트는 시작 시 user-data를 정리한다.

## 검증 항목

### `unit.js` — 순수 로직 30 PASS (실제 모듈 로드, 드리프트 없음)
robots 파서(RFC 9309) / clamp(delay≥2000·pages≤20) / CSV(RFC4180·BOM·CRLF) /
finder 클래스 안정성(오버레이·난수 클래스 제외) / extractor transform.

### `run.js` — 오케스트레이션 18 PASS (실제 확장 로드, 헤디드)
- 확장 SW 등록 / content script 격리월드 주입
- `content onMessage → extractPage`(background→content cross-context), 행 추출/필드
- **안전장치**: consent 없으면 `startCollect` 거부 / `max_pages 9999·delay 0` → 20·2000 재클램프
- **오케스트레이션**: 3페이지 수집, 리로드 넘어 재개(pull 핸드셰이크), 누적 30행, dedupe 30/30, 2초+ 지연
- popup 6개 섹션 렌더 + 런타임 오류 없음

### `ux.js` — UX 상호작용 21 PASS (헤디드)
- **시각적 행 선택**: 모드 배지 표시 → 실제 클릭 2회 → 셀렉터 추론·10개 매칭·미리보기 하이라이트 → ESC 종료
- **시각적 필드 선택**: 확정 행 하이라이트 → 행 내부 클릭 → 상대 셀렉터(`.author`)
- **반복 컨테이너 스냅**: 빽빽한 중첩 카드(스펙 셀 18개)에서 깊은 셀 클릭 → `.card`로 스냅 → 추론이 카드 6개 매칭(셀 18 아님)
- **실제 다운로드**: 1페이지 수집 → `exportCsv` → 저장 파일에 UTF-8 BOM·CSV 헤더·10행 확인
- **현재 페이지 추출 후 다운로드**: `extractOnce`가 `uc_job`에 결과 저장 → 이후 `exportCsv` 성공(무데이터 버그 회귀 방지)

> `ux.js`는 finder가 자체 오버레이 클래스(`uc-sample-highlight` 등)를 셀렉터 추론에 포함시키던
> 버그를 잡아냈고, 수정 후 회귀 방지를 `unit.js`에 고정했다.
