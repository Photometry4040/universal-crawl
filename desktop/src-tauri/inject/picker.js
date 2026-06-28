/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * picker.js — 데스크탑 임베디드 WebView용 시각적 셀렉터 집기.
 * 대상 페이지(원격 URL) 컨텍스트에 finder.js → selector-infer.js → extractor.js 다음에 주입된다.
 * 의존: window.__ucFinder, window.__ucInfer, window.__ucExtract (앞서 주입된 모듈).
 *
 * Rust↔대상 webview 통신은 모두 'Tauri 이벤트'로 한다(eval은 원격에서 불안정 → 미사용):
 *  - 대상→백엔드: window.__TAURI__.core.invoke('on_pick'/'on_field_pick'/'collect_rows', ...)
 *  - 백엔드→대상: window.__TAURI__.event.listen('uc-cmd', ...) 로 field_pick/extract 지시 수신
 * 진단: 좌상단 배지 + 하단 #uc-diag 에 IPC 연결/전송 상태를 노출(silent 실패 방지).
 */
(function () {
  'use strict';
  if (window.__ucPickerLoaded) return;
  window.__ucPickerLoaded = true;

  var INFER = window.__ucInfer;
  var hovered = null;
  var samples = [];
  var active = true;
  var mode = 'row';          // 'row' | 'field'
  var rowSelector = '';      // 행 모드에서 확정된 행 셀렉터(필드 모드가 참조)
  var fieldPickIndex = null; // 필드 모드 대상 필드 행 인덱스

  // ---------- 오버레이 스타일 ----------
  var style = document.createElement('style');
  style.textContent =
    '.uc-hover-highlight{outline:2px solid #2d7ff9 !important;outline-offset:-1px;cursor:crosshair !important;}' +
    '.uc-preview-highlight{outline:2px dashed #f9a72d !important;outline-offset:-1px;background:rgba(249,167,45,.08) !important;}' +
    '.uc-sample-highlight{outline:3px solid #16a34a !important;outline-offset:-1px;}' +
    '#uc-badge,#uc-diag{position:fixed;left:10px;z-index:2147483647;max-width:60vw;' +
    'background:#111827;color:#e5e7eb;font:12px/1.5 ui-monospace,Menlo,monospace;' +
    'padding:8px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none;' +
    'white-space:pre-wrap;word-break:break-all;}' +
    '#uc-badge{top:10px;}#uc-diag{bottom:10px;background:#0b3b2e;color:#bbf7d0;max-width:70vw;}' +
    '#uc-badge b{color:#fbbf24;}';
  document.documentElement.appendChild(style);

  var badge = document.createElement('div');
  badge.id = 'uc-badge';
  badge.textContent = '셀렉터 집기 모드 · 요소를 클릭하세요 (ESC 종료)';
  document.documentElement.appendChild(badge);

  var diagEl = document.createElement('div');
  diagEl.id = 'uc-diag';
  diagEl.textContent = 'IPC: 초기화…';
  document.documentElement.appendChild(diagEl);

  function diag(msg) {
    if (diagEl) diagEl.textContent = 'IPC: ' + msg;
  }

  function clearClass(cls) {
    Array.prototype.forEach.call(document.querySelectorAll('.' + cls), function (el) {
      el.classList.remove(cls);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- Tauri IPC (진단 포함, silent 실패 금지) ----------
  function hasInvoke() {
    return !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  }
  function safeInvoke(cmd, args) {
    if (!hasInvoke()) { diag('invoke 불가 — window.__TAURI__.core 없음'); return; }
    try {
      var p = window.__TAURI__.core.invoke(cmd, args);
      if (p && p.then) {
        p.then(function () { diag('✔ ' + cmd + ' 전송됨'); })
         .catch(function (e) { diag('✘ ' + cmd + ' 실패: ' + e); });
      } else {
        diag('✔ ' + cmd + ' 전송(동기)');
      }
    } catch (e) { diag('✘ ' + cmd + ' 예외: ' + e); }
  }

  function guessAttr(el) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'a' && el.getAttribute('href')) return 'href';
    if (tag === 'img' && el.getAttribute('src')) return 'src';
    return 'text';
  }

  // ---------- 클릭 처리 ----------
  function onMove(e) {
    if (!active) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === hovered) return;
    if (el.id === 'uc-badge' || el.id === 'uc-diag') return;
    if (hovered) hovered.classList.remove('uc-hover-highlight');
    hovered = el;
    hovered.classList.add('uc-hover-highlight');
  }

  function onClickField(raw) {
    if (!rowSelector) {
      badge.innerHTML = '<b>먼저 행을 집으세요</b>\n(② 집은 셀렉터가 비어 있음)';
      return;
    }
    var row = raw.closest ? raw.closest(rowSelector) : null;
    if (!row) {
      badge.innerHTML = '<b>행 안쪽을 클릭하세요</b>\n행 셀렉터: ' + escapeHtml(rowSelector);
      return;
    }
    var rel = INFER.inferRelative(row, raw);
    var attr = guessAttr(raw);
    var sampleText = (raw.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);

    clearClass('uc-preview-highlight');
    raw.classList.add('uc-preview-highlight');

    badge.innerHTML =
      '<b>필드</b>    #' + fieldPickIndex + '\n' +
      '<b>셀렉터</b>  ' + escapeHtml(rel) + '\n' +
      '<b>속성</b>    ' + attr + '\n' +
      '<b>예시</b>    ' + escapeHtml(sampleText);

    safeInvoke('on_field_pick', {
      pick: { fieldIndex: fieldPickIndex, selector: rel, attr: attr, sampleText: sampleText },
    });

    mode = 'row';
    fieldPickIndex = null;
  }

  function onClickRow(raw) {
    var row = INFER.snapToRepeatingContainer(raw);
    if (samples.indexOf(row) === -1) samples.push(row);
    row.classList.add('uc-sample-highlight');

    var result = INFER.inferFromSamples(samples);
    var selector = result.selector;
    var count = result.count;
    rowSelector = selector;

    clearClass('uc-preview-highlight');
    if (selector) {
      try {
        Array.prototype.forEach.call(document.querySelectorAll(selector), function (el) {
          if (!el.classList.contains('uc-sample-highlight')) el.classList.add('uc-preview-highlight');
        });
      } catch (e2) { /* 잘못된 셀렉터 무시 */ }
    }

    var sampleText = (row.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    badge.innerHTML =
      '<b>셀렉터</b>  ' + escapeHtml(selector) + '\n' +
      '<b>매칭</b>    ' + count + '개   (샘플 ' + samples.length + ')\n' +
      '<b>예시</b>    ' + escapeHtml(sampleText);

    safeInvoke('on_pick', { pick: { selector: selector, count: count, sampleCount: samples.length, sampleText: sampleText } });
  }

  function onClick(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    var raw = e.target;
    if (!raw || raw.nodeType !== 1) return;
    if (mode === 'field') onClickField(raw);
    else onClickRow(raw);
    return false;
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      active = false;
      clearClass('uc-hover-highlight');
      clearClass('uc-preview-highlight');
      clearClass('uc-sample-highlight');
      badge.textContent = '선택 모드 종료됨';
      setTimeout(function () { if (badge.parentNode) badge.parentNode.removeChild(badge); }, 1200);
    }
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  // ---------- 백엔드 지시 핸들러(이벤트 기반, eval 대체) ----------
  function startFieldPick(idx) {
    mode = 'field';
    fieldPickIndex = idx;
    active = true;
    if (badge && !badge.parentNode) document.documentElement.appendChild(badge);
    badge.innerHTML = '<b>필드 집기 #' + idx + '</b>\n행 안의 추출할 요소를 클릭하세요';
  }

  function runExtract(profile) {
    var rows = [];
    try {
      if (window.__ucExtract && window.__ucExtract.extractPage) {
        rows = window.__ucExtract.extractPage(profile) || [];
      }
    } catch (e) { rows = []; }
    safeInvoke('collect_rows', { rows: rows, fields: (profile && profile.fields) || [] });
    return rows.length;
  }

  function resetPick() {
    samples = [];
    mode = 'row';
    fieldPickIndex = null;
    clearClass('uc-preview-highlight');
    clearClass('uc-sample-highlight');
    active = true;
    badge.innerHTML = '셀렉터 집기 모드 · 요소를 클릭하세요 (ESC 종료)';
  }

  // 전역(테스트/직접호출용) — 이벤트 핸들러와 동일 로직 공유
  window.__ucStartFieldPick = startFieldPick;
  window.__ucRunExtract = runExtract;
  window.__ucResetPick = resetPick;

  // 백엔드 → 대상: 'uc-cmd' 이벤트 수신(eval 대신). __TAURI__.event 준비될 때까지 폴링.
  function handleCmd(payload) {
    var p = payload || {};
    diag('uc-cmd 수신: ' + (p.action || '?'));
    if (p.action === 'field_pick') startFieldPick(p.fieldIndex);
    else if (p.action === 'extract') runExtract(p.profile);
    else if (p.action === 'reset') resetPick();
  }
  function registerCmdListener(tries) {
    if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
      try {
        window.__TAURI__.event.listen('uc-cmd', function (ev) { handleCmd(ev && ev.payload); });
        diag('연결됨 · uc-cmd 대기 (invoke=' + (hasInvoke() ? 'OK' : '없음') + ')');
      } catch (e) { diag('listen 등록 예외: ' + e); }
    } else if (tries > 0) {
      setTimeout(function () { registerCmdListener(tries - 1); }, 200);
    } else {
      diag('미연결 — window.__TAURI__.event 없음(원격 IPC 비활성?)');
    }
  }
  registerCmdListener(30);
})();
