/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * background.js — 수집 잡 오케스트레이터 (MV3 서비스 워커)
 *
 * 원칙(검증 하버니스 반영):
 *  - 모든 잡 진행은 이벤트 구동 + storage(uc_job)가 단일 진실 공급원.
 *    background는 능동 장시간 대기를 하지 않는다(SW ~30초 idle 종료).
 *  - 재개는 content→background 'contentReady' 단일 pull. background는 navigation만 트리거.
 *  - 안전장치(delay>=2000, maxPages<=20, consent)는 background에서 무조건 재강제.
 */
importScripts('lib/robots.js', 'lib/serialize.js');

var R = self.__ucRobots;
var S = self.__ucSerialize;
var JOB_KEY = 'uc_job';
var CONSENT_KEY = 'uc_consent';
var READY_TIMEOUT_MS = 15000;
var MIN_DELAY_MS = 2000;
var MAX_PAGES_CAP = 20;

// 재시작을 넘는 타이머는 storage로 관리하되, 짧은 가드 타이머는 메모리에 둔다.
var readyGuards = {}; // tabId -> timeoutId

// ---------- storage 헬퍼 ----------
function getJob() {
  return new Promise(function (res) {
    chrome.storage.local.get(JOB_KEY, function (d) { res(d[JOB_KEY] || null); });
  });
}
function setJob(job) {
  return new Promise(function (res) {
    chrome.storage.local.set({ uc_job: job }, function () { res(); });
  });
}
function getConsent(origin) {
  return new Promise(function (res) {
    chrome.storage.local.get(CONSENT_KEY, function (d) {
      var map = d[CONSENT_KEY] || {};
      res(map[origin] || null);
    });
  });
}

// ---------- sanitize / 검증 ----------
var ATTR_OK = /^(text|text_all|href|src|class|classToken:\d+|[a-zA-Z_][\w-]*)$/;
var TRANSFORM_OK = { to_number: 1, word_to_number: 1, trim: 1, none: 1 };
var PAGI_OK = { next_button: 1, url_pattern: 1, infinite_scroll: 1 };

function sanitizeProfile(p) {
  p = p || {};
  var out = {
    version: p.version || 1,
    site: typeof p.site === 'string' ? p.site : '',
    url_sample: typeof p.url_sample === 'string' ? p.url_sample : '',
    row_selector: typeof p.row_selector === 'string' ? p.row_selector : '',
    fields: [],
    pagination: { type: 'next_button', selector: '', pattern: '' },
    delay_ms: clampDelay(p.delay_ms),
    max_pages: clampPages(p.max_pages),
    dedupe_key: typeof p.dedupe_key === 'string' ? p.dedupe_key : '',
  };
  if (Array.isArray(p.fields)) {
    out.fields = p.fields.filter(function (f) {
      return f && typeof f.name === 'string' && typeof f.selector === 'string';
    }).map(function (f) {
      var attr = (typeof f.attr === 'string' && ATTR_OK.test(f.attr)) ? f.attr : 'text';
      var transform = (typeof f.transform === 'string' && TRANSFORM_OK[f.transform]) ? f.transform : 'none';
      return { name: f.name, selector: f.selector, attr: attr, transform: transform };
    });
  }
  var pg = p.pagination || {};
  var type = PAGI_OK[pg.type] ? pg.type : 'next_button';
  out.pagination = {
    type: type,
    selector: typeof pg.selector === 'string' ? pg.selector : '',
    pattern: typeof pg.pattern === 'string' ? pg.pattern : '',
  };
  return out;
}
function clampDelay(v) { return S.clampDelay(v); }
function clampPages(v) { return S.clampPages(v); }

// ---------- 메시지 송신 헬퍼 ----------
function sendToTab(tabId, msg) {
  return new Promise(function (res) {
    try {
      chrome.tabs.sendMessage(tabId, msg, function (resp) {
        if (chrome.runtime.lastError) { res({ ok: false, error: chrome.runtime.lastError.message }); return; }
        res(resp || { ok: false });
      });
    } catch (e) {
      res({ ok: false, error: String(e) });
    }
  });
}

function originOf(url) {
  try { return new URL(url).origin; } catch (e) { return null; }
}
function pathOf(url) {
  try { var u = new URL(url); return u.pathname + u.search; } catch (e) { return '/'; }
}

// ---------- dedupe ----------
function rowKey(row, profile) {
  if (profile.dedupe_key && row[profile.dedupe_key] != null) {
    var v = String(row[profile.dedupe_key]).trim();
    if (!v) return null; // 빈 키 → dedupe 제외
    // URL은 정규화
    if (profile.dedupe_key === 'url' || /^https?:\/\//.test(v)) {
      try { return new URL(v).href; } catch (e) { return v; }
    }
    return v;
  }
  if (profile.dedupe_key) return null; // 지정했는데 값 없음 → 항상 추가
  // 키 미지정: 모든 필드값 정렬 join
  var names = profile.fields.map(function (f) { return f.name; }).sort();
  return names.map(function (n) { return n + '=' + (row[n] == null ? '' : row[n]); }).join('||');
}

// 새 행만 추려 누적. 반환: 추가된 개수
function mergeRows(job, newRows) {
  var seen = new Set(job.seenKeys || []);
  var added = 0;
  newRows.forEach(function (row) {
    var key = rowKey(row, job.profile);
    if (key === null) {
      job.rows.push(row); added++; return; // dedupe 제외 행은 항상 추가
    }
    if (!seen.has(key)) {
      seen.add(key);
      job.rows.push(row);
      added++;
    }
  });
  job.seenKeys = Array.from(seen);
  return added;
}

// ---------- 잡 종료 ----------
function finishJob(job, status, error) {
  job.active = false;
  job.status = status;
  job.phase = 'idle';
  job.endedAt = Date.now();
  if (error) job.lastError = String(error);
  clearGuard(job.tabId);
  return setJob(job);
}

function clearGuard(tabId) {
  if (readyGuards[tabId]) { clearTimeout(readyGuards[tabId]); delete readyGuards[tabId]; }
}

// ---------- 핵심 진행 로직 ----------

// 현재 탭에서 1페이지 추출 요청 → 누적 → 다음 결정
async function requestExtractAndAccumulate(job) {
  job.phase = 'awaiting_extract';
  await setJob(job);

  var resp;
  if (job.paginationType === 'infinite_scroll' && job.currentPage > 1) {
    resp = await sendToTab(job.tabId, { type: 'scrollAndExtract', profile: job.profile });
    if (resp && resp.ok && resp.grew === false) {
      // 신규 요소 없음 → 종료
      await finishJob(job, 'done');
      return;
    }
  } else {
    resp = await sendToTab(job.tabId, { type: 'extractPage', profile: job.profile });
  }

  if (!resp || !resp.ok) {
    await finishJob(job, 'failed', (resp && resp.error) || 'extract failed');
    return;
  }

  var added = mergeRows(job, resp.rows || []);
  job.lastPageCompletedAt = Date.now();
  await setJob(job);

  // 종료 조건: maxPages 도달 / (2페이지 이후) 신규 0
  if (job.currentPage >= job.maxPages) { await finishJob(job, 'done'); return; }
  if (job.currentPage > 1 && added === 0) { await finishJob(job, 'done'); return; }

  await scheduleNext(job);
}

// 다음 페이지로 전환(지연 + 네비게이션/스크롤)
async function scheduleNext(job) {
  // 다음 후보 조회(content)
  var nextResp = await sendToTab(job.tabId, { type: 'getNext', profile: job.profile, currentPage: job.currentPage });
  var next = nextResp && nextResp.ok ? nextResp.next : null;
  if (!next || !next.hasNext) { await finishJob(job, 'done'); return; }

  // 2000ms 하한: 직전 페이지 완료 후 경과시간 보충
  var elapsed = Date.now() - (job.lastPageCompletedAt || 0);
  var wait = Math.max(0, job.delayMs - elapsed);

  setTimeout(function () { proceedTransition(job, next).catch(function (e) {
    finishJob(job, 'failed', e);
  }); }, wait);
}

async function proceedTransition(job, next) {
  job.currentPage += 1;

  if (job.paginationType === 'infinite_scroll') {
    // 리로드 없음 — 같은 content가 스크롤+추출
    job.phase = 'awaiting_extract';
    await setJob(job);
    await requestExtractAndAccumulate(job);
    return;
  }

  // 리로드형: 대상 URL 결정
  var targetUrl = next.href || null;

  if (targetUrl) {
    // 페이지네이션 경로별 robots 재검증
    var allowed = await recheckRobots(job, targetUrl);
    if (!allowed.ok) { await finishJob(job, 'stopped', allowed.reason); return; }

    job.phase = 'awaiting_ready';
    await setJob(job); // navigation 전에 phase 커밋(새 content가 읽음)
    armReadyGuard(job);
    try {
      await new Promise(function (res) { chrome.tabs.update(job.tabId, { url: targetUrl }, function () { void chrome.runtime.lastError; res(); }); });
    } catch (e) { await finishJob(job, 'failed', e); }
    // 이후 진행은 content의 contentReady가 트리거
  } else if (next.jsButton) {
    // 순수 JS 버튼: content click 폴백. 응답 신뢰하지 말 것.
    job.phase = 'awaiting_ready';
    await setJob(job);
    armReadyGuard(job);
    sendToTab(job.tabId, { type: 'clickJsNext', profile: job.profile });
  } else {
    await finishJob(job, 'done');
  }
}

// robots 재검증(같은 origin 가정, 다르면 안전 중단)
async function recheckRobots(job, targetUrl) {
  var origin = originOf(targetUrl);
  if (origin !== job.origin) return { ok: false, reason: 'cross-origin navigation blocked' };
  var consent = await getConsent(job.origin);
  if (!consent) return { ok: false, reason: 'consent missing' };
  if (!consent.robotsText || !R.looksLikeRobots(consent.robotsText)) return { ok: true }; // 규칙 없음
  var parsed = R.parseRobots(consent.robotsText);
  var verdict = R.isAllowed(parsed, pathOf(targetUrl));
  if (!verdict.allowed) return { ok: false, reason: 'robots Disallow: ' + verdict.matchedBy };
  return { ok: true };
}

// ready 타임아웃 가드: 일정 시간 내 contentReady 미수신 시 폴백 주입, 그래도 없으면 실패
function armReadyGuard(job) {
  clearGuard(job.tabId);
  var expectPage = job.currentPage;
  readyGuards[job.tabId] = setTimeout(async function () {
    var cur = await getJob();
    if (!cur || !cur.active || cur.phase !== 'awaiting_ready' || cur.currentPage !== expectPage) return;
    // 폴백: content 재주입
    try {
      await new Promise(function (res) {
        chrome.scripting.executeScript({
          target: { tabId: job.tabId },
          files: ['lib/finder.js', 'content/selector-infer.js', 'content/extractor.js', 'content/paginator.js', 'content/content.js'],
        }, function () { void chrome.runtime.lastError; res(); });
      });
    } catch (e) { /* ignore */ }
    // 재주입 후 다시 한 번 대기, 그래도 안 오면 실패
    readyGuards[job.tabId] = setTimeout(async function () {
      var c2 = await getJob();
      if (c2 && c2.active && c2.phase === 'awaiting_ready' && c2.currentPage === expectPage) {
        await finishJob(c2, 'failed', 'page ready timeout');
      }
    }, READY_TIMEOUT_MS);
  }, READY_TIMEOUT_MS);
}

// ---------- contentReady 수신(pull 트리거) ----------
async function onContentReady(sender, msg) {
  var job = await getJob();
  if (!job || !job.active) return;
  var tabId = sender && sender.tab && sender.tab.id;
  if (tabId !== job.tabId) return;
  if (job.phase !== 'awaiting_ready') return;
  if (msg.currentPage != null && msg.currentPage !== job.currentPage) return; // 멱등/순서 가드
  clearGuard(job.tabId);
  job.phase = 'awaiting_extract';
  await setJob(job);
  await requestExtractAndAccumulate(job);
}

// ---------- startCollect ----------
async function startCollect(rawProfile, tabId, tabUrl) {
  var profile = sanitizeProfile(rawProfile);
  var origin = originOf(tabUrl);
  if (!origin) return { ok: false, error: 'invalid tab url' };

  var consent = await getConsent(origin);
  if (!consent || !consent.tos || !consent.robotsAck) {
    return { ok: false, error: 'consent required (ToS/robots 미확인)' };
  }

  var job = {
    active: true,
    status: 'running',
    phase: 'awaiting_extract',
    tabId: tabId,
    origin: origin,
    profile: profile,
    currentPage: 1,
    maxPages: profile.max_pages,
    delayMs: profile.delay_ms,
    paginationType: profile.pagination.type,
    lastPageCompletedAt: 0,
    rows: [],
    seenKeys: [],
    endedAt: null,
    lastError: null,
  };
  await setJob(job);
  // 첫 페이지는 현재 로드된 content에서 바로 추출
  requestExtractAndAccumulate(job).catch(function (e) { finishJob(job, 'failed', e); });
  return { ok: true };
}

// 단일 페이지 추출(수집 잡 아님): 즉시 추출 + 결과를 uc_job 스냅샷으로 저장해 export 가능하게.
async function extractOnce(profile, tabId) {
  var clean = sanitizeProfile(profile);
  var resp = await sendToTab(tabId, { type: 'extractPage', profile: clean });
  if (resp && resp.ok) {
    await setJob({
      active: false, status: 'done', phase: 'idle',
      tabId: tabId, origin: null, profile: clean,
      currentPage: 1, maxPages: clean.max_pages, delayMs: clean.delay_ms,
      paginationType: clean.pagination.type, lastPageCompletedAt: Date.now(),
      rows: resp.rows || [], seenKeys: [], endedAt: Date.now(), lastError: null,
      source: 'extractOnce',
    });
  }
  return resp;
}

// ---------- 다운로드 ----------
function buildCsv(rows, fields) { return S.buildCsv(rows, fields); }

// 다운로드 폴더(Downloads 하위 상대경로만 허용)·파일명 정리
function sanitizeFilename(dir, base) {
  base = String(base || 'extract').replace(/[^\w.-]/g, '_');
  var folder = String(dir || '').replace(/\\/g, '/').replace(/^\/+|\.\.+/g, '').replace(/[^\w./-]/g, '_').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return folder ? folder + '/' + base : base;
}

function downloadData(payload, mime, filename, saveAs) {
  var dataUrl = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(payload);
  return new Promise(function (res) {
    chrome.downloads.download({ url: dataUrl, filename: filename, saveAs: !!saveAs }, function (id) {
      if (chrome.runtime.lastError) { res({ ok: false, error: chrome.runtime.lastError.message }); return; }
      res({ ok: true, id: id });
    });
  });
}

// opts: { dir, saveAs }
async function exportJob(format, opts) {
  opts = opts || {};
  var job = await getJob();
  if (!job || !job.rows || !job.rows.length) return { ok: false, error: 'no data (먼저 추출/수집을 실행하세요)' };
  var site = (job.profile.site || 'extract').replace(/[^\w.-]/g, '_');
  if (format === 'json') {
    return downloadData(JSON.stringify(job.rows, null, 2), 'application/json', sanitizeFilename(opts.dir, site + '.json'), opts.saveAs);
  }
  var csv = buildCsv(job.rows, job.profile.fields);
  return downloadData(csv, 'text/csv', sanitizeFilename(opts.dir, site + '.csv'), opts.saveAs);
}

// ---------- 부트스트랩(SW 재기동 시) ----------
async function bootstrap() {
  var job = await getJob();
  if (!job || !job.active) return;
  // awaiting_ready였다면 content의 contentReady를 기다린다(가드 재무장).
  if (job.phase === 'awaiting_ready') {
    armReadyGuard(job);
  } else if (job.phase === 'awaiting_extract') {
    // 추출 대기 중 SW가 죽었던 경우: 안전하게 재요청
    requestExtractAndAccumulate(job).catch(function (e) { finishJob(job, 'failed', e); });
  }
  // 'navigating'은 곧 onUpdated/contentReady가 깨우므로 별도 처리 불필요
}
bootstrap();

// ---------- 사이드 패널: 액션 클릭 시 열기(선택 내내 떠 있음) ----------
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
} catch (e) { /* sidePanel 미지원 환경 무시 */ }

// ---------- onUpdated: ready 가드 보조 ----------
chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info.status !== 'complete') return;
  getJob().then(function (job) {
    if (!job || !job.active || job.tabId !== tabId) return;
    if (job.phase !== 'awaiting_ready') return;
    // content가 contentReady를 보낼 것이므로 여기선 아무것도 강제하지 않음(멱등).
    // 단, content 정적 주입이 비활성/실패한 페이지 대비 가드는 armReadyGuard가 처리.
  });
});

// ---------- 메시지 라우팅 ----------
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'contentReady':
      onContentReady(sender, msg).catch(function () {});
      // 응답 불필요
      return;
    case 'startCollect':
      (async function () {
        var resp = await startCollect(msg.profile, msg.tabId, msg.tabUrl);
        sendResponse(resp);
      })();
      return true;
    case 'extractOnce':
      (async function () {
        var resp = await extractOnce(msg.profile, msg.tabId);
        sendResponse(resp);
      })();
      return true;
    case 'stopCollect':
      (async function () {
        var job = await getJob();
        if (job && job.active) await finishJob(job, 'stopped');
        sendResponse({ ok: true });
      })();
      return true;
    case 'exportCsv':
      (async function () { sendResponse(await exportJob('csv', { dir: msg.dir, saveAs: msg.saveAs })); })();
      return true;
    case 'exportJson':
      (async function () { sendResponse(await exportJob('json', { dir: msg.dir, saveAs: msg.saveAs })); })();
      return true;
    case 'getJob':
      (async function () { sendResponse({ ok: true, job: await getJob() }); })();
      return true;
    default:
      return;
  }
});
