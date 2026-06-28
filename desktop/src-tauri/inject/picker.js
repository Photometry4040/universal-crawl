/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * picker.js — 데스크탑 임베디드 WebView용 시각적 셀렉터 집기.
 * 대상 페이지(원격 URL) 컨텍스트에 finder.js → selector-infer.js 다음에 주입된다.
 * 의존: window.__ucFinder, window.__ucInfer (앞서 주입된 모듈).
 *
 * 동작:
 *  - hover → 요소 외곽선 하이라이트
 *  - click → snapToRepeatingContainer로 반복 카드 보정 → __ucInfer로 공통 셀렉터 추론
 *           → 매칭 요소 미리보기 하이라이트 + 개수 → 페이지 내 배지 표시(Layer1)
 *           → Tauri IPC로 우측 컨트롤 패널에 결과 전달 시도(Layer2)
 *  - ESC → 선택 모드 종료/오버레이 제거
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

  // ---------- 오버레이 스타일 (대상 페이지 CSS와 충돌 없게 인라인) ----------
  var style = document.createElement('style');
  style.textContent =
    '.uc-hover-highlight{outline:2px solid #2d7ff9 !important;outline-offset:-1px;cursor:crosshair !important;}' +
    '.uc-preview-highlight{outline:2px dashed #f9a72d !important;outline-offset:-1px;background:rgba(249,167,45,.08) !important;}' +
    '.uc-sample-highlight{outline:3px solid #16a34a !important;outline-offset:-1px;}' +
    '#uc-badge{position:fixed;top:10px;left:10px;z-index:2147483647;max-width:60vw;' +
    'background:#111827;color:#e5e7eb;font:12px/1.5 ui-monospace,Menlo,monospace;' +
    'padding:8px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none;' +
    'white-space:pre-wrap;word-break:break-all;}' +
    '#uc-badge b{color:#fbbf24;}';
  document.documentElement.appendChild(style);

  var badge = document.createElement('div');
  badge.id = 'uc-badge';
  badge.textContent = '셀렉터 집기 모드 · 요소를 클릭하세요 (ESC 종료)';
  document.documentElement.appendChild(badge);

  function clearClass(cls) {
    Array.prototype.forEach.call(document.querySelectorAll('.' + cls), function (el) {
      el.classList.remove(cls);
    });
  }

  // ---------- Tauri IPC 브리지 (Layer2, 없어도 Layer1은 동작) ----------
  function bridge(payload) {
    try {
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke('on_pick', { pick: payload });
      }
    } catch (e) { /* IPC 미허용 시 무시 — 페이지 내 배지로 충분 */ }
  }

  function onMove(e) {
    if (!active) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === hovered) return;
    if (el.id === 'uc-badge') return;
    if (hovered) hovered.classList.remove('uc-hover-highlight');
    hovered = el;
    hovered.classList.add('uc-hover-highlight');
  }

  // 필드 attr 추정: 링크→href, 이미지→src, 그 외→text.
  function guessAttr(el) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'a' && el.getAttribute('href')) return 'href';
    if (tag === 'img' && el.getAttribute('src')) return 'src';
    return 'text';
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

    try {
      if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('on_field_pick', {
          pick: { fieldIndex: fieldPickIndex, selector: rel, attr: attr, sampleText: sampleText },
        });
      }
    } catch (e) { /* IPC 미허용 시 배지로 확인 */ }

    // 1회 집기 후 행 모드로 복귀
    mode = 'row';
    fieldPickIndex = null;
  }

  function onClickRow(raw) {
    // 빽빽한 카드형 목록에서 깊은 셀 클릭 시 반복 카드로 스냅
    var row = INFER.snapToRepeatingContainer(raw);
    if (samples.indexOf(row) === -1) samples.push(row);

    row.classList.add('uc-sample-highlight');

    var result = INFER.inferFromSamples(samples);
    var selector = result.selector;
    var count = result.count;
    rowSelector = selector; // 필드 모드가 참조

    clearClass('uc-preview-highlight');
    if (selector) {
      try {
        Array.prototype.forEach.call(document.querySelectorAll(selector), function (el) {
          if (!el.classList.contains('uc-sample-highlight')) {
            el.classList.add('uc-preview-highlight');
          }
        });
      } catch (e2) { /* 잘못된 셀렉터 무시 */ }
    }

    var sampleText = (row.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    badge.innerHTML =
      '<b>셀렉터</b>  ' + escapeHtml(selector) + '\n' +
      '<b>매칭</b>    ' + count + '개   (샘플 ' + samples.length + ')\n' +
      '<b>예시</b>    ' + escapeHtml(sampleText);

    bridge({ selector: selector, count: count, sampleCount: samples.length, sampleText: sampleText });
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

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  // 컨트롤 패널 → 대상 webview 제어용(선택 초기화)
  window.__ucResetPick = function () {
    samples = [];
    mode = 'row';
    fieldPickIndex = null;
    clearClass('uc-preview-highlight');
    clearClass('uc-sample-highlight');
    active = true;
    badge.innerHTML = '셀렉터 집기 모드 · 요소를 클릭하세요 (ESC 종료)';
  };

  // 컨트롤 패널 → start_field_pick가 eval로 호출. 다음 클릭을 필드 집기로 처리.
  window.__ucStartFieldPick = function (idx) {
    mode = 'field';
    fieldPickIndex = idx;
    active = true;
    if (badge && !badge.parentNode) document.documentElement.appendChild(badge);
    badge.innerHTML = '<b>필드 집기 #' + idx + '</b>\n행 안의 추출할 요소를 클릭하세요';
  };

  // 컨트롤 패널 → request_extract가 대상 webview에서 eval로 호출.
  // __ucExtract.extractPage(profile) 실행 결과를 collect_rows로 백엔드에 반환.
  window.__ucRunExtract = function (profile) {
    var rows = [];
    try {
      if (window.__ucExtract && window.__ucExtract.extractPage) {
        rows = window.__ucExtract.extractPage(profile) || [];
      }
    } catch (e) { rows = []; }
    try {
      if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('collect_rows', {
          rows: rows,
          fields: (profile && profile.fields) || [],
        });
      }
    } catch (e) { /* IPC 미허용 시 무시 */ }
    return rows.length;
  };
})();
