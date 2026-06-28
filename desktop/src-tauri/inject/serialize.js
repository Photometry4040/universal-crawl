/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * inject/serialize.js — 직렬화/안전장치 클램프 순수 로직 (외부 의존 0)
 * Tauri WebView inject 컨텍스트에서 사용. Rust 커맨드가 클램프 값을 재검증한다.
 *  - clampDelay(v): 최소 2000ms 강제
 *  - clampPages(v): 1~20 강제
 *  - csvEscape(v): RFC4180 이스케이프
 *  - buildCsv(rows, fields): UTF-8 BOM + CRLF + RFC4180
 */
(function () {
  'use strict';

  var MIN_DELAY_MS = 2000;
  var MAX_PAGES_CAP = 20;

  function clampDelay(v) {
    var n = Number(v);
    if (!isFinite(n)) n = MIN_DELAY_MS;
    return Math.max(MIN_DELAY_MS, Math.floor(n));
  }
  function clampPages(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 1;
    return Math.min(MAX_PAGES_CAP, Math.max(1, Math.floor(n)));
  }

  function csvEscape(v) {
    if (v == null) return '';
    var s = String(v);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // rows: [{name: value}], fields: [{name}]
  function buildCsv(rows, fields) {
    var headers = fields.map(function (f) { return f.name; });
    var lines = [headers.map(csvEscape).join(',')];
    rows.forEach(function (row) {
      lines.push(headers.map(function (h) { return csvEscape(row[h]); }).join(','));
    });
    return '﻿' + lines.join('\r\n'); // BOM + CRLF
  }

  var api = {
    MIN_DELAY_MS: MIN_DELAY_MS,
    MAX_PAGES_CAP: MAX_PAGES_CAP,
    clampDelay: clampDelay,
    clampPages: clampPages,
    csvEscape: csvEscape,
    buildCsv: buildCsv,
  };

  if (typeof window !== 'undefined') window.__ucSerialize = api;
  if (typeof self !== 'undefined') self.__ucSerialize = api;
})();
