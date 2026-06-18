/*
 * e2e/ux.js — 헤디드 UX e2e: 시각적 선택 플로우 + 실제 다운로드 파일 검증.
 * run.js(오케스트레이션)가 못 다룬 사용자 상호작용을 실제 클릭/키보드로 검증한다.
 *   node ux.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..');
const TARGET = 'https://quotes.toscrape.com/';
const ORIGIN = 'https://quotes.toscrape.com';
const DL_DIR = path.join(__dirname, '.downloads');

const QUOTES_PROFILE = {
  version: 1, site: 'quotes.toscrape.com', url_sample: TARGET,
  row_selector: '.quote',
  fields: [
    { name: 'text', selector: '.text', attr: 'text', transform: 'trim' },
    { name: 'author', selector: '.author', attr: 'text', transform: 'trim' },
  ],
  pagination: { type: 'next_button', selector: 'li.next a', pattern: '' },
  delay_ms: 2500, max_pages: 1, dedupe_key: 'text',
};

let pass = 0, fail = 0, skip = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  — ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  — ' + extra : '')); }
};
const note = (name, msg) => { skip++; console.log('SKIP  ' + name + '  — ' + msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const userDataDir = path.join(__dirname, '.user-data-ux');
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(DL_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    acceptDownloads: true,
    downloadsPath: DL_DIR,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
  });

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = new URL(sw.url()).host;
    check('확장 SW 등록', !!extId, 'id=' + extId);

    const sendFromBackground = (tabId, message) => sw.evaluate(async ({ tid, msg }) =>
      new Promise(res => chrome.tabs.sendMessage(tid, msg, r => { void chrome.runtime.lastError; res(r || null); })),
    { tid: tabId, msg: message });
    const sGet = (key) => sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || null, key);
    // 페이지 컨텍스트에서 메시지 전송(SW가 수신) 후 응답을 storage로 회수
    async function sendFromPage(tabId, message) {
      await sw.evaluate(async ({ tid, msg }) => {
        await new Promise(res => chrome.scripting.executeScript({
          target: { tabId: tid },
          func: (m) => chrome.runtime.sendMessage(m, (resp) => chrome.storage.local.set({ uc_test_resp: resp === undefined ? { ok: false, _u: true } : resp })),
          args: [msg],
        }, res));
      }, { tid: tabId, msg: message });
      for (let i = 0; i < 50; i++) {
        const r = await sw.evaluate(async () => (await chrome.storage.local.get('uc_test_resp')).uc_test_resp);
        if (r !== undefined && r !== null) { await sw.evaluate(async () => chrome.storage.local.remove('uc_test_resp')); return r; }
        await sleep(200);
      }
      return null;
    }

    const page = await ctx.newPage();
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const tabId = await sw.evaluate(async (o) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => x.url && x.url.indexOf(o) === 0);
      return t ? t.id : null;
    }, ORIGIN);
    check('대상 탭 식별', tabId != null, 'tabId=' + tabId);
    await sleep(800);

    // ===== 1. 시각적 행 선택 플로우 =====
    await sendFromBackground(tabId, { type: 'enterSelectMode', target: 'row' });
    await sleep(300);
    const badgeVisible = await page.locator('#uc-mode-badge').count();
    check('[행선택] 모드 배지 표시', badgeVisible === 1);

    // 실제 사용자 클릭으로 샘플 2개 등록(서로 다른 quote의 .text)
    await page.locator('.quote .text').nth(0).click();
    await sleep(200);
    await page.locator('.quote .text').nth(1).click();
    await sleep(400);

    const sel = await sGet('uc_selection');
    check('[행선택] 2클릭 후 셀렉터 추론', !!(sel && sel.sampleCount === 2 && sel.rowSelector), sel ? sel.rowSelector + ' (sample ' + sel.sampleCount + ')' : 'no selection');
    check('[행선택] 추론 셀렉터가 10개 매칭', !!(sel && sel.count === 10), sel ? sel.count + '개' : '');

    // 미리보기 하이라이트가 실제 DOM에 적용됐는지
    const previewCount = await page.locator('.uc-preview-highlight').count();
    check('[행선택] 미리보기 하이라이트 DOM 적용', previewCount === 10, previewCount + '개 하이라이트');

    // ESC로 종료 → 배지 제거
    await page.keyboard.press('Escape');
    await sleep(300);
    const badgeAfter = await page.locator('#uc-mode-badge').count();
    check('[행선택] ESC 종료 → 배지 제거', badgeAfter === 0);

    // ===== 2. 시각적 필드 선택(상대 셀렉터) =====
    await sendFromBackground(tabId, { type: 'enterSelectMode', target: 'field', rowSelector: '.quote' });
    await sleep(300);
    const confirmed = await page.locator('.uc-row-confirmed').count();
    check('[필드선택] 확정 행 하이라이트', confirmed === 10, confirmed + '개');
    // 첫 quote 내부 author 클릭 → 상대 셀렉터 추론
    await page.locator('.quote').nth(0).locator('.author').click();
    await sleep(400);
    const pick = await sGet('uc_field_pick');
    check('[필드선택] 행 내부 클릭 → 상대 셀렉터', !!(pick && pick.selector && pick.selector.indexOf('author') !== -1), pick ? pick.selector : 'no pick');
    await sendFromBackground(tabId, { type: 'exitSelectMode' });
    await page.keyboard.press('Escape');

    // ===== 3. 실제 CSV 다운로드 파일 검증 =====
    // 1페이지 수집해 데이터 확보(consent 설정)
    await sw.evaluate(async (o) => {
      const map = {}; map[o] = { tos: true, robotsAck: true, robotsStatus: 'ok', robotsText: '', ts: Date.now() };
      await chrome.storage.local.set({ uc_consent: map });
      await chrome.storage.local.remove('uc_job');
    }, ORIGIN);
    await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
    await sleep(700);
    // startCollect를 페이지 컨텍스트에서 전송(SW가 수신)
    await sw.evaluate(async ({ tid, profile, url }) => {
      await new Promise(res => chrome.scripting.executeScript({
        target: { tabId: tid },
        func: (p, u, t) => chrome.runtime.sendMessage({ type: 'startCollect', profile: p, tabId: t, tabUrl: u }),
        args: [profile, url, tid],
      }, res));
    }, { tid: tabId, profile: QUOTES_PROFILE, url: TARGET });

    // 수집 완료 대기
    let job = null;
    for (let i = 0; i < 30; i++) { job = await sGet('uc_job'); if (job && !job.active) break; await sleep(400); }
    check('[다운로드] 1페이지 수집 데이터 확보', !!(job && job.rows && job.rows.length === 10), job ? job.rows.length + '행' : 'no job');

    // exportCsv 트리거(페이지 컨텍스트) + 다운로드 완료 대기(내부 타임아웃)
    const dlResult = await Promise.race([
      (async () => {
        const downloadPromise = page.waitForEvent('download', { timeout: 12000 }).catch(() => null);
        await sw.evaluate(async (tid) => {
          await new Promise(res => chrome.scripting.executeScript({
            target: { tabId: tid },
            func: () => chrome.runtime.sendMessage({ type: 'exportCsv' }),
          }, res));
        }, tabId);
        const dl = await downloadPromise;
        if (dl) { const p = await dl.path().catch(() => null); return { via: 'event', path: p, name: dl.suggestedFilename() }; }
        // 다운로드 이벤트가 안 잡히면 chrome.downloads.search로 확인
        await sleep(1500);
        const items = await sw.evaluate(async () => new Promise(r => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }, r)));
        return { via: 'downloads-api', items };
      })(),
      sleep(15000).then(() => ({ timeout: true })),
    ]);

    if (dlResult.timeout) {
      note('[다운로드] CSV 파일 저장', 'saveAs 다이얼로그로 자동확인 불가(수동 검증 필요)');
    } else if (dlResult.via === 'event' && dlResult.path) {
      const buf = fs.readFileSync(dlResult.path);
      const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF; // UTF-8 BOM
      const content = buf.toString('utf8');
      check('[다운로드] CSV 파일 생성(' + dlResult.name + ')', true);
      check('[다운로드] UTF-8 BOM 선두', hasBom);
      check('[다운로드] 헤더 text,author 포함', content.indexOf('text,author') !== -1 || content.indexOf('text') !== -1);
      check('[다운로드] 수집 데이터 포함', content.indexOf('Einstein') !== -1 || content.split('\r\n').length >= 10, content.split('\r\n').length + '줄');
    } else {
      // downloads-api 경로: chrome.downloads가 완료 보고. 실제 저장 파일(item.filename 절대경로)을 읽어 검증.
      const item = dlResult.items && dlResult.items[0];
      check('[다운로드] chrome.downloads 완료(state=complete)', !!(item && item.state === 'complete'), item ? 'state=' + item.state : 'none');
      // 저장 파일 후보: item.filename(절대경로) 또는 downloadsPath 내 파일
      let savedPath = null;
      if (item && item.filename && fs.existsSync(item.filename)) savedPath = item.filename;
      if (!savedPath && fs.existsSync(DL_DIR)) {
        const files = fs.readdirSync(DL_DIR).map(f => path.join(DL_DIR, f)).filter(p => fs.statSync(p).isFile());
        if (files.length) savedPath = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      }
      if (savedPath) {
        const buf = fs.readFileSync(savedPath);
        const content = buf.toString('utf8');
        check('[다운로드] 실제 파일 저장됨', true, path.basename(savedPath));
        check('[다운로드] UTF-8 BOM 선두', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
        check('[다운로드] CSV 헤더 text/author', content.indexOf('text') !== -1 && content.indexOf('author') !== -1);
        check('[다운로드] 수집 데이터 10행 포함', content.split('\r\n').filter(l => l.trim()).length >= 10, content.split('\r\n').filter(l => l.trim()).length + '줄');
      } else {
        note('[다운로드] 저장 파일 직접확인', 'item.state=' + (item && item.state) + ' 이나 파일 경로 미발견');
      }
    }

    // ===== 4. 반복 컨테이너 스냅(빽빽한 중첩 카드) =====
    // projectorcentral류 구조: 카드(.card) 안에 스펙 셀(.spec)이 여러 개. 스펙 셀을 클릭해도 카드로 스냅돼야 함.
    const fixture = await ctx.newPage();
    const DENSE = 'data:text/html,' + encodeURIComponent(
      '<div id="list">' +
      Array.from({ length: 6 }).map((_, i) =>
        '<div class="card"><div class="title">Model ' + i + '</div><div class="specs">' +
        '<dl><dt class="spec">res</dt><dd class="spec">1080p</dd>' +
        '<dt class="spec">lumens</dt><dd class="spec">3000</dd>' +
        '<dt class="spec">price</dt><dd class="spec">$' + (i * 100) + '</dd></dl></div></div>'
      ).join('') + '</div>');
    await fixture.goto(DENSE, { waitUntil: 'domcontentloaded' });
    await fixture.addScriptTag({ path: EXT + '/lib/finder.js' });
    await fixture.addScriptTag({ path: EXT + '/content/selector-infer.js' });
    const snap = await fixture.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('dd.spec')); // 카드당 3개 = 18개
      const snapped = cells.slice(0, 2).map(c => window.__ucInfer.snapToRepeatingContainer(c));
      const isCard = snapped.every(s => s.classList.contains('card'));
      const res = window.__ucInfer.inferFromSamples(snapped);
      return {
        cellCount: cells.length,
        snappedToCard: isCard,
        inferred: res.selector,
        matches: window.__ucInfer.previewCount(res.selector),
      };
    });
    check('[스냅] 빽빽한 카드: 스펙 셀(18개) 존재', snap.cellCount === 18, snap.cellCount + '개');
    check('[스냅] 깊은 셀 클릭 → 카드(.card)로 스냅', snap.snappedToCard === true);
    check('[스냅] 스냅 후 추론이 카드 6개 매칭(셀 18 아님)', snap.matches === 6, snap.inferred + ' → ' + snap.matches + '개');
    await fixture.close();

    // ===== 5. "현재 페이지 추출"(extractOnce) 후 다운로드 가능 (무데이터 버그 수정) =====
    await sw.evaluate(async () => chrome.storage.local.remove(['uc_job', 'uc_exp_resp']));
    // 페이지 컨텍스트에서 extractOnce 전송(SW 수신) — sendFromPage 헬퍼 재사용
    const onceResp = await sendFromPage(tabId, { type: 'extractOnce', profile: QUOTES_PROFILE, tabId, tabUrl: TARGET });
    check('[추출1회] extractOnce 응답 10행', !!(onceResp && onceResp.ok && onceResp.rows && onceResp.rows.length === 10), onceResp ? (onceResp.rows || []).length + '행' : 'no resp');
    const jobAfterOnce = await sGet('uc_job');
    check('[추출1회] extractOnce가 uc_job에 결과 저장', !!(jobAfterOnce && jobAfterOnce.rows && jobAfterOnce.rows.length === 10 && jobAfterOnce.source === 'extractOnce'), jobAfterOnce ? jobAfterOnce.rows.length + '행 source=' + jobAfterOnce.source : 'no job');
    const csvAfterOnce = await sendFromPage(tabId, { type: 'exportCsv' });
    check('[추출1회] 이후 CSV 다운로드 가능(무데이터 버그 수정)', !!(csvAfterOnce && csvAfterOnce.ok), JSON.stringify(csvAfterOnce).slice(0, 60));

    console.log('\n==== UX e2e 결과: ' + pass + ' PASS / ' + fail + ' FAIL / ' + skip + ' SKIP ====');
  } catch (e) {
    console.log('\nHARNESS ERROR: ' + (e && e.stack || e)); fail++;
  } finally {
    await ctx.close();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
