/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * content/content.js — 인페이지 선택 UI + 추출 진입점 + 잡 재개(pull)
 *
 * 통신:
 *  - popup → content: enterSelectMode / exitSelectMode / extractPage / previewSelector / clearSelection
 *  - background → content: extractPage(job) / scrollAndExtract(job)
 *  - content → background: contentReady (잡 재개 pull 핸드셰이크; background가 sender.tab.id 사용)
 *
 * 팝업은 페이지 클릭 시 닫히므로, 선택 결과는 chrome.storage.local에 기록해
 * 팝업 재오픈 시 복원한다(uc_selection / uc_field_pick).
 */
(function () {
  'use strict';
  if (window.__ucContentLoaded) return; // 중복 주입 가드
  window.__ucContentLoaded = true;

  var Infer = window.__ucInfer;
  var Extract = window.__ucExtract;
  var Paginate = window.__ucPaginate;

  var state = {
    mode: 'idle', // idle | row_select | field_select
    samples: [],
    rowSelector: '',
    refRow: null,
    hoverEl: null,
  };

  // ---------- 하이라이트 유틸 ----------
  function clearClass(cls) {
    Array.prototype.forEach.call(document.querySelectorAll('.' + cls), function (el) {
      el.classList.remove(cls);
    });
  }
  function clearAllHighlights() {
    clearClass('uc-hover-highlight');
    clearClass('uc-sample-highlight');
    clearClass('uc-preview-highlight');
    clearClass('uc-row-confirmed');
  }
  function previewSelector(selector) {
    clearClass('uc-preview-highlight');
    if (!selector) return 0;
    var nodes;
    try { nodes = document.querySelectorAll(selector); } catch (e) { return 0; }
    Array.prototype.forEach.call(nodes, function (el) { el.classList.add('uc-preview-highlight'); });
    return nodes.length;
  }

  // ---------- 모드 배지 ----------
  function ensureBadge() {
    var badge = document.getElementById('uc-mode-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'uc-mode-badge';
      badge.innerHTML = '<div class="uc-badge-inner">' +
        '<span class="uc-badge-state"></span>' +
        '<span class="uc-badge-text"></span>' +
        '<span class="uc-badge-count"></span>' +
        '<span class="uc-badge-hint">ESC로 종료</span>' +
        '</div>';
      document.documentElement.appendChild(badge);
    }
    return badge;
  }
  function updateBadge(stateLabel, text, count) {
    var badge = ensureBadge();
    badge.querySelector('.uc-badge-state').textContent = stateLabel;
    badge.querySelector('.uc-badge-text').textContent = text || '';
    badge.querySelector('.uc-badge-count').textContent = (count != null) ? (count + '개 매칭') : '';
  }
  function removeBadge() {
    var badge = document.getElementById('uc-mode-badge');
    if (badge) badge.remove();
  }

  function isOurUi(el) {
    return el && (el.id === 'uc-mode-badge' || (el.closest && el.closest('#uc-mode-badge')));
  }

  // ---------- 이벤트 핸들러 ----------
  function onHover(e) {
    if (state.mode === 'idle') return;
    var el = e.target;
    if (isOurUi(el)) return;
    if (state.hoverEl && state.hoverEl !== el) state.hoverEl.classList.remove('uc-hover-highlight');
    state.hoverEl = el;
    el.classList.add('uc-hover-highlight');
  }

  function onClick(e) {
    if (state.mode === 'idle') return;
    var el = e.target;
    if (isOurUi(el)) return;
    e.preventDefault();
    e.stopPropagation();

    if (state.mode === 'row_select') {
      if (state.samples.indexOf(el) === -1) {
        state.samples.push(el);
        el.classList.add('uc-sample-highlight');
      }
      var result = Infer.inferFromSamples(state.samples);
      state.rowSelector = result.selector;
      var count = previewSelector(result.selector);
      updateBadge('행 선택', '샘플 ' + state.samples.length + '개 → 행 추론', count);
      saveSelection({ mode: 'row_select', rowSelector: result.selector, count: count, sampleCount: state.samples.length });
    } else if (state.mode === 'field_select') {
      // 클릭된 필드가 속한 행 찾기
      var row = el.closest(state.rowSelector);
      if (!row) {
        updateBadge('필드 선택', '행 안쪽을 클릭하세요', null);
        return;
      }
      var rel = Infer.inferRelative(row, el);
      var sample = (el.textContent || '').trim().slice(0, 40);
      saveFieldPick({ selector: rel, sampleText: sample, tag: el.tagName.toLowerCase(), href: el.getAttribute && el.getAttribute('href') || null });
      // 같은 상대 셀렉터로 모든 행의 해당 필드를 미리보기
      var previewCount = 0;
      try {
        document.querySelectorAll(state.rowSelector).forEach(function (r) {
          var f = r.querySelector(':scope ' + rel);
          if (f) { f.classList.add('uc-preview-highlight'); previewCount++; }
        });
      } catch (e2) { /* ignore */ }
      updateBadge('필드 선택', '필드: ' + (rel || '(행 자신)'), previewCount);
    }
    return false;
  }

  function onKey(e) {
    if (e.key === 'Escape' && state.mode !== 'idle') {
      exitSelectMode();
    }
  }

  // ---------- 선택 모드 제어 ----------
  function enterSelectMode(opts) {
    opts = opts || {};
    exitSelectMode(true); // 리스너 정리 후 재설정
    state.mode = opts.target === 'field' ? 'field_select' : 'row_select';
    state.samples = [];

    if (state.mode === 'field_select') {
      state.rowSelector = opts.rowSelector || '';
      try { state.refRow = document.querySelector(state.rowSelector); } catch (e) { state.refRow = null; }
      // 확정된 행들 표시
      try {
        document.querySelectorAll(state.rowSelector).forEach(function (r) { r.classList.add('uc-row-confirmed'); });
      } catch (e) { /* ignore */ }
      updateBadge('필드 선택', '행 안쪽 요소를 클릭', null);
    } else {
      updateBadge('행 선택', '수집할 항목을 클릭(2개 권장)', null);
    }

    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function exitSelectMode(keepBadge) {
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (state.hoverEl) state.hoverEl.classList.remove('uc-hover-highlight');
    clearClass('uc-hover-highlight');
    clearClass('uc-sample-highlight');
    state.mode = 'idle';
    state.samples = [];
    state.hoverEl = null;
    if (!keepBadge) {
      removeBadge();
      saveSelection({ mode: 'idle' });
    }
  }

  // ---------- storage 기록(팝업 동기화) ----------
  function saveSelection(obj) {
    try { chrome.storage.local.set({ uc_selection: obj }); } catch (e) { /* ignore */ }
  }
  function saveFieldPick(obj) {
    try { chrome.storage.local.set({ uc_field_pick: Object.assign({ ts: Date.now() }, obj) }); } catch (e) { /* ignore */ }
  }

  // ---------- 추출 (단일 페이지 / 잡 라운드) ----------
  function doExtract(profile) {
    return Extract.extractPage(profile);
  }

  // infinite_scroll 라운드: 스크롤 → 신규 행 대기 → 추출.
  function doScrollAndExtract(profile) {
    return Paginate.scrollAndWait(profile).then(function (r) {
      return { grew: r.grew, rows: doExtract(profile) };
    });
  }

  // next 후보 정보(페이지 전환 결정용)
  function getNext(profile, currentPage) {
    return Paginate.getNext(profile, currentPage);
  }

  // ---------- 메시지 라우팅 ----------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'enterSelectMode':
        enterSelectMode(msg);
        sendResponse({ ok: true });
        return; // 동기 응답
      case 'exitSelectMode':
        exitSelectMode();
        sendResponse({ ok: true });
        return;
      case 'previewSelector':
        sendResponse({ ok: true, count: previewSelector(msg.selector) });
        return;
      case 'getNext':
        sendResponse({ ok: true, next: getNext(msg.profile, msg.currentPage) });
        return;
      case 'clickJsNext':
        // 즉시 unload 가능 — 응답 신뢰하지 말 것(background는 타임아웃 가드 사용)
        try { Paginate.clickJsNext(msg.profile); } catch (e) { /* ignore */ }
        sendResponse({ ok: true });
        return;
      case 'extractPage':
        (function () {
          try {
            sendResponse({ ok: true, rows: doExtract(msg.profile) });
          } catch (e) {
            sendResponse({ ok: false, error: String(e) });
          }
        })();
        return; // 동기 추출
      case 'scrollAndExtract':
        doScrollAndExtract(msg.profile).then(function (r) {
          sendResponse({ ok: true, grew: r.grew, rows: r.rows });
        }).catch(function (e) {
          sendResponse({ ok: false, error: String(e) });
        });
        return true; // 비동기 응답
      case 'clearHighlights':
        clearAllHighlights();
        sendResponse({ ok: true });
        return;
      default:
        return;
    }
  });

  // ---------- 잡 재개 pull 핸드셰이크 ----------
  // content 로드 시 활성 잡이 이 탭을 기다리면(ready 단계) background에 ready를 push.
  (function maybeResume() {
    try {
      chrome.storage.local.get('uc_job', function (data) {
        var job = data && data.uc_job;
        if (job && job.active && job.phase === 'awaiting_ready') {
          chrome.runtime.sendMessage({
            type: 'contentReady',
            url: location.href,
            currentPage: job.currentPage,
          }, function () { void chrome.runtime.lastError; });
        }
      });
    } catch (e) { /* ignore */ }
  })();
})();
