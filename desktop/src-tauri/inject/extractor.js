/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * content/extractor.js — row_selector + fields 기반 데이터 추출
 * 전역 window.__ucExtract 노출.
 *
 * 핵심: 행 내부 필드는 row.querySelector(':scope ' + sel)로 추출(:scope 강제).
 * :scope 없이는 조상 토큰이 문서 전역 매칭되어 모든 행이 1행 값으로 오염됨.
 */
(function () {
  'use strict';

  function absUrl(value) {
    if (value == null) return null;
    try {
      return new URL(value, document.baseURI).href;
    } catch (e) {
      return value;
    }
  }

  function toNumber(text) {
    if (text == null) return null;
    // 통화기호/천단위 구분 등 제거, 첫 숫자(소수점 포함) 추출
    var m = String(text).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  var WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, zero: 0 };
  function wordToNumber(text) {
    if (text == null) return null;
    var key = String(text).trim().toLowerCase();
    if (key in WORD_NUM) return WORD_NUM[key];
    return toNumber(text);
  }

  function applyTransform(value, transform) {
    switch (transform) {
      case 'to_number': return toNumber(value);
      case 'word_to_number': return wordToNumber(value);
      case 'trim': return value == null ? null : String(value).trim();
      case 'none':
      case undefined:
      case null:
      default:
        return value;
    }
  }

  // 단일 노드에서 attr 값 추출.
  function readAttr(node, attr) {
    if (!node) return null;
    if (attr === 'text' || attr === undefined || attr === null || attr === '') {
      var t = node.textContent;
      return t == null ? null : t.trim();
    }
    if (attr === 'href' || attr === 'src') {
      var raw = node.getAttribute(attr);
      return raw == null ? null : absUrl(raw);
    }
    if (attr === 'class') {
      return node.getAttribute('class');
    }
    if (attr.indexOf('classToken:') === 0) {
      var idx = parseInt(attr.split(':')[1], 10) || 0;
      var cls = (node.getAttribute('class') || '').trim().split(/\s+/);
      return cls[idx] != null ? cls[idx] : null;
    }
    // 임의 속성명
    var v = node.getAttribute(attr);
    return v;
  }

  function scopedQuery(row, selector) {
    if (!selector) return row; // 셀렉터 비면 row 자신
    try {
      return row.querySelector(':scope ' + selector);
    } catch (e) {
      return null;
    }
  }

  function scopedQueryAll(row, selector) {
    if (!selector) return [row];
    try {
      return Array.from(row.querySelectorAll(':scope ' + selector));
    } catch (e) {
      return [];
    }
  }

  function extractField(row, field) {
    var attr = field.attr || 'text';
    var transform = field.transform || 'none';

    if (attr === 'text_all') {
      var nodes = scopedQueryAll(row, field.selector);
      if (!nodes.length) return null;
      var vals = nodes.map(function (n) {
        var t = n.textContent;
        return t == null ? '' : t.trim();
      }).filter(function (s) { return s.length; });
      var joined = vals.join('; ');
      return applyTransform(joined, transform);
    }

    var node = scopedQuery(row, field.selector);
    if (!node) return null;
    var raw = readAttr(node, attr);
    return applyTransform(raw, transform);
  }

  // profile: { row_selector, fields: [{name, selector, attr, transform}] }
  function extractPage(profile) {
    if (!profile || !profile.row_selector) return [];
    var rows;
    try {
      rows = Array.from(document.querySelectorAll(profile.row_selector));
    } catch (e) {
      return [];
    }
    var fields = profile.fields || [];
    return rows.map(function (row) {
      var obj = {};
      fields.forEach(function (f) {
        obj[f.name] = extractField(row, f);
      });
      return obj;
    });
  }

  window.__ucExtract = {
    extractPage: extractPage,
    extractField: extractField,
    applyTransform: applyTransform,
    readAttr: readAttr,
  };
})();
