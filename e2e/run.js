/*
 * e2e/run.js — 실제 확장을 로드해 background 서비스워커 오케스트레이션까지 검증.
 * Playwright 번들 Chromium(Chrome for Testing) 사용 → 시스템 Chrome 149의 --load-extension 제거 우회.
 * 확장 본체와 분리된 검증 전용 코드.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..'); // 확장 루트(= 프로젝트 루트)
const TARGET = 'https://quotes.toscrape.com/';
const ORIGIN = 'https://quotes.toscrape.com';

const QUOTES_PROFILE = {
  version: 1, site: 'quotes.toscrape.com', url_sample: TARGET,
  row_selector: '.quote',
  fields: [
    { name: 'text', selector: '.text', attr: 'text', transform: 'trim' },
    { name: 'author', selector: '.author', attr: 'text', transform: 'trim' },
    { name: 'tags', selector: '.tag', attr: 'text_all', transform: 'none' },
  ],
  pagination: { type: 'next_button', selector: 'li.next a', pattern: '' },
  delay_ms: 2500, max_pages: 3, dedupe_key: 'text',
};

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  — ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  — ' + extra : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const userDataDir = path.join(__dirname, '.user-data');
  // 이전 실행의 잠긴 프로필이 launch를 멈추게 하므로 매번 정리
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run', '--no-default-browser-check',
    ],
  });

  try {
    // --- 1. 확장 SW 등록 ---
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;
    check('확장 서비스워커 등록(SW 시작, 로드 오류 없음)', !!extId, 'id=' + extId + ' url=' + sw.url().split('/').pop());

    // SW에서 페이지로 메시지 주입(executeScript) 후 storage로 응답 회수
    async function sendFromPage(tabId, message) {
      await sw.evaluate(async ({ tid, msg }) => {
        await new Promise(res => chrome.scripting.executeScript({
          target: { tabId: tid },
          func: (m) => chrome.runtime.sendMessage(m, (resp) => chrome.storage.local.set({ uc_test_resp: resp === undefined ? { ok: false, _u: true } : resp })),
          args: [msg],
        }, res));
      }, { tid: tabId, msg: message });
      for (let i = 0; i < 50; i++) {
        const r = await sw.evaluate(async () => {
          const d = await chrome.storage.local.get('uc_test_resp');
          return d.uc_test_resp;
        });
        if (r !== undefined && r !== null) {
          await sw.evaluate(async () => chrome.storage.local.remove('uc_test_resp'));
          return r;
        }
        await sleep(200);
      }
      return null;
    }
    // background→content 메시지(올바른 cross-context 경로: SW가 content로 보냄)
    async function sendFromBackground(tabId, message) {
      return sw.evaluate(async ({ tid, msg }) => new Promise(res => {
        chrome.tabs.sendMessage(tid, msg, (resp) => { void chrome.runtime.lastError; res(resp || null); });
      }), { tid: tabId, msg: message });
    }
    const getJob = () => sw.evaluate(async () => (await chrome.storage.local.get('uc_job')).uc_job || null);
    const setConsent = (origin) => sw.evaluate(async (o) => {
      const map = {}; map[o] = { tos: true, robotsAck: true, robotsStatus: 'ok', robotsText: '', ts: Date.now() };
      await chrome.storage.local.set({ uc_consent: map });
    }, origin);

    // --- 2. 대상 페이지 + content script 주입 확인 ---
    const page = await ctx.newPage();
    let online = true;
    try { await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 25000 }); }
    catch (e) { online = false; }
    check('연습 사이트 접속', online, online ? TARGET : '오프라인');

    const tabId = await sw.evaluate(async (origin) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => x.url && x.url.indexOf(origin) === 0);
      return t ? t.id : null;
    }, ORIGIN);
    check('대상 탭 식별', tabId != null, 'tabId=' + tabId);

    if (online && tabId != null) {
      await sleep(900); // document_idle 주입 여유

      // 격리월드(content script)에 __ucExtract 존재 확인 = content 정적 주입 입증
      const injected = await sw.evaluate(async (tid) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tid },
          func: () => ({ content: !!window.__ucContentLoaded, extract: typeof window.__ucExtract, infer: typeof window.__ucInfer }),
        });
        return r.result;
      }, tabId);
      check('content script 격리월드 주입(__ucContentLoaded/__ucExtract)', injected && injected.content === true && injected.extract === 'object', JSON.stringify(injected));

      // --- 3. content 메시지 라우팅 + extractPage (background→content cross-context) ---
      const exResp = await sendFromBackground(tabId, { type: 'extractPage', profile: QUOTES_PROFILE });
      const rows = (exResp && exResp.rows) || [];
      check('content onMessage→extractPage 응답(background→content)', !!(exResp && exResp.ok), exResp ? '' : 'no resp');
      check('1페이지 행 추출(10)', rows.length === 10, rows.length + '행');
      check('필드 text/author/tags 채워짐', !!(rows[0] && rows[0].text && rows[0].author && rows[0].tags), JSON.stringify(rows[0] || {}).slice(0, 70));

      // --- 4. 안전장치: consent 없으면 startCollect 거부 ---
      await sw.evaluate(async () => chrome.storage.local.remove(['uc_consent', 'uc_job']));
      const noConsent = await sendFromPage(tabId, { type: 'startCollect', profile: QUOTES_PROFILE, tabId, tabUrl: TARGET });
      check('consent 없으면 startCollect 거부', !!(noConsent && noConsent.ok === false), noConsent ? (noConsent.error || '') : 'no resp');

      // --- 5. 안전장치: import 우회 클램프(max_pages 9999/delay 0 → 20/2000) ---
      await setConsent(ORIGIN);
      const evil = Object.assign({}, QUOTES_PROFILE, { max_pages: 9999, delay_ms: 0 });
      await sendFromPage(tabId, { type: 'startCollect', profile: evil, tabId, tabUrl: TARGET });
      await sleep(600);
      let j = await getJob();
      check('max_pages 20으로 재클램프', !!(j && j.maxPages === 20), j ? 'maxPages=' + j.maxPages : 'no job');
      check('delay_ms 2000으로 재클램프', !!(j && j.delayMs === 2000), j ? 'delayMs=' + j.delayMs : 'no job');
      await sendFromPage(tabId, { type: 'stopCollect' });
      await sleep(400);

      // --- 6. 정상 다중 페이지 수집(3페이지) — 오케스트레이션 전체 ---
      await sw.evaluate(async () => chrome.storage.local.remove('uc_job'));
      await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await sleep(900);
      const t0 = Date.now();
      await sendFromPage(tabId, { type: 'startCollect', profile: QUOTES_PROFILE, tabId, tabUrl: TARGET });

      let job = null;
      for (let i = 0; i < 120; i++) { // 최대 ~60s
        job = await getJob();
        if (job && !job.active) break;
        await sleep(500);
      }
      const elapsed = Date.now() - t0;
      check('수집 완료(active=false)', !!(job && !job.active), job ? 'status=' + job.status : 'no job');
      check('3페이지 도달(리로드 넘어 재개)', !!(job && job.currentPage === 3), job ? 'currentPage=' + job.currentPage : '');
      check('누적 약 30행(10×3, dedupe)', !!(job && job.rows && job.rows.length >= 25 && job.rows.length <= 31), job ? job.rows.length + '행' : '');
      check('페이지 간 2초+ 지연(경과시간)', elapsed >= 4000, '경과 ' + Math.round(elapsed / 1000) + 's');
      if (job && job.rows) {
        const texts = job.rows.map(r => r.text), uniq = new Set(texts);
        check('dedupe(중복 없음)', uniq.size === texts.length, uniq.size + '/' + texts.length);
      }

      // --- 7. 수집 행이 export 가능한 형태인지(실 다운로드는 saveAs 다이얼로그라 생략; CSV 직렬화는 단위테스트로 검증) ---
      const serializable = !!(job && job.rows && job.rows.every(r => typeof r.text === 'string'));
      check('수집 행 CSV/JSON 직렬화 가능 형태', serializable, '(CSV RFC4180/BOM은 unit.js 27/27로 검증)');
    }

    // --- 8. popup 페이지 로드(렌더/스크립트 오류 없음) ---
    const popup = await ctx.newPage();
    const popupErrors = [];
    popup.on('pageerror', e => popupErrors.push(String(e)));
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(500);
    const secCount = await popup.evaluate(() => document.querySelectorAll('section').length).catch(() => 0);
    check('popup 6개 섹션 렌더', secCount === 6, secCount + '개 섹션');
    check('popup 스크립트 런타임 오류 없음', popupErrors.length === 0, popupErrors.join('; ').slice(0, 100));

    console.log('\n==== E2E 결과: ' + pass + ' PASS / ' + fail + ' FAIL ====');
  } catch (e) {
    console.log('\nHARNESS ERROR: ' + (e && e.stack || e)); fail++;
  } finally {
    await ctx.close();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
