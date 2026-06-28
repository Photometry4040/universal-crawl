/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * content/selector-infer.js — 공통 셀렉터 추론 + 일반화 휴리스틱
 * 전역 window.__ucInfer 노출. lib/finder.js(window.__ucFinder)에 의존.
 *
 * - inferFromSamples(els): 1개=일반화 완화, 2개+=최소 공통 셀렉터
 * - generalize(sel): id제거→nth-child제거 단계적 완화 + 과매칭 롤백 가드
 * - previewCount(sel): 매칭 개수
 * - inferRelative(rowEl, fieldEl): row 기준 하위 경로만(조상/자신 토큰 불포함)
 */
(function () {
  'use strict';

  var F = window.__ucFinder;
  var tagName = F.tagName;
  var esc = F.esc;
  var stableClasses = F.stableClasses;

  function previewCount(selector) {
    if (!selector) return 0;
    try {
      return document.querySelectorAll(selector).length;
    } catch (e) {
      return 0;
    }
  }

  function safeMatchCount(selector) {
    return previewCount(selector);
  }

  // selector 문자열에서 마지막 컴파운드(공백/'>'로 분리된 마지막 조각)를 일반화.
  // 위치 토큰(:nth-of-type, :nth-child) 제거 → 더 많은 형제 포함.
  function stripPositional(selector) {
    return selector.replace(/:nth-(of-type|child)\([^)]*\)/g, '');
  }

  function stripIds(selector) {
    // #id 토큰 제거 (단 다른 토큰이 남아야 의미 있음)
    return selector.replace(/#[^\s>.:\[]+/g, '');
  }

  // 단계적 완화: 각 단계마다 매칭 수가 직전 대비 10배 초과로 급증하면 롤백.
  function generalize(selector) {
    if (!selector) return selector;
    var best = selector;
    var bestCount = safeMatchCount(selector) || 1;

    var stages = [
      stripIds(selector),
      stripPositional(stripIds(selector)),
    ];

    for (var i = 0; i < stages.length; i++) {
      var candidate = stages[i].replace(/\s{2,}/g, ' ').replace(/\s*>\s*/g, ' > ').trim();
      if (!candidate || candidate === best) continue;
      var count = safeMatchCount(candidate);
      if (count === 0) continue; // 완화했는데 0개면 무의미
      // 과도 완화(직전 대비 10배 초과 급증) → 롤백(이전 best 유지)
      if (count > bestCount * 10 && bestCount > 0) break;
      best = candidate;
      bestCount = count;
    }
    return best;
  }

  // 단일 샘플: finder 셀렉터 → 일반화하여 형제 유사 요소 포함.
  function inferSingle(el) {
    var raw = F(el);
    var generalized = generalize(raw);
    return { selector: generalized, raw: raw, count: previewCount(generalized) };
  }

  // 두 요소의 "공통 조상 기준 상대 셀렉터" 후보를 만든다.
  // 핵심 아이디어: 각 요소의 안정 class 교집합 + 동일 태그를 우선 사용.
  function commonSelector(els) {
    // 1) 클래스 교집합 (가장 흔하고 안정적인 패턴: 같은 컴포넌트 카드)
    var classSets = els.map(function (el) {
      return new Set(stableClasses(el));
    });
    var inter = null;
    classSets.forEach(function (s) {
      if (inter === null) {
        inter = new Set(s);
      } else {
        inter = new Set([].filter.call(Array.from(inter), function (c) { return s.has(c); }));
      }
    });
    var commonCls = inter ? Array.from(inter) : [];

    // 모든 요소 태그가 같은가
    var tags = els.map(tagName);
    var sameTag = tags.every(function (t) { return t === tags[0]; });
    var tag = sameTag ? tags[0] : '';

    var candidates = [];
    if (commonCls.length) {
      candidates.push(tag + '.' + commonCls.map(esc).join('.'));
      candidates.push('.' + commonCls.map(esc).join('.'));
      // 단일 공통 클래스도 후보로
      if (commonCls.length > 1) {
        candidates.push(tag + '.' + esc(commonCls[0]));
      }
    }
    if (sameTag) candidates.push(tag);

    // 후보 중: 모든 샘플을 포함하면서 매칭 수가 가장 적절한(샘플 수 이상, 과하지 않은) 것 선택.
    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var sel = candidates[i];
      if (!sel) continue;
      var matched;
      try {
        matched = Array.from(document.querySelectorAll(sel));
      } catch (e) {
        continue;
      }
      var coversAll = els.every(function (el) { return matched.indexOf(el) !== -1; });
      if (coversAll && matched.length >= els.length) {
        best = { selector: sel, count: matched.length };
        break; // candidates는 구체→일반 순이라 첫 매칭이 가장 타이트
      }
    }
    if (best) return best;
    // 폴백: 첫 요소 단일 추론
    return inferSingle(els[0]);
  }

  function inferFromSamples(els) {
    els = (els || []).filter(Boolean);
    if (els.length === 0) return { selector: '', count: 0 };
    if (els.length === 1) return inferSingle(els[0]);
    return commonSelector(els);
  }

  // row 내부 fieldEl을 가리키는 상대 셀렉터(조상/자신 토큰 불포함).
  // rowEl로부터 fieldEl까지의 경로를 자식 방향으로 구성.
  function inferRelative(rowEl, fieldEl) {
    if (!rowEl || !fieldEl || rowEl === fieldEl) return '';
    if (!rowEl.contains(fieldEl)) return '';

    // 1) field의 안정 class가 row 내부에서 고유하면 그것만 사용
    var cls = stableClasses(fieldEl);
    for (var i = 0; i < cls.length; i++) {
      var sel = '.' + esc(cls[i]);
      try {
        var hits = rowEl.querySelectorAll(':scope ' + sel);
        if (hits.length >= 1 && hits[0] === fieldEl && hits.length === 1) return sel;
      } catch (e) { /* ignore */ }
    }
    // tag.class 조합
    for (var j = 0; j < cls.length; j++) {
      var sel2 = tagName(fieldEl) + '.' + esc(cls[j]);
      try {
        var hits2 = rowEl.querySelectorAll(':scope ' + sel2);
        if (hits2.length === 1 && hits2[0] === fieldEl) return sel2;
      } catch (e) { /* ignore */ }
    }

    // 2) 경로 누적: fieldEl → ... → rowEl(제외) 까지 자식 토큰 체인
    var parts = [];
    var cur = fieldEl;
    var depth = 0;
    while (cur && cur !== rowEl && depth < 6) {
      var c2 = stableClasses(cur);
      var token = c2.length ? (tagName(cur) + '.' + esc(c2[0])) : tagName(cur);
      var nth = F.nthOfType(cur);
      if (!c2.length && nth) token = tagName(cur) + ':nth-of-type(' + nth + ')';
      parts.unshift(token);
      cur = cur.parentElement;
      depth++;
      var candidate = parts.join(' > ');
      try {
        var h = rowEl.querySelectorAll(':scope ' + candidate);
        if (h.length === 1 && h[0] === fieldEl) return candidate;
      } catch (e) { /* ignore */ }
    }
    return parts.join(' > ');
  }

  // ---------- 반복 컨테이너 스냅 ----------
  // 클릭한 요소가 카드 내부 깊숙한 하위 요소(스펙 셀 등)일 때, 형제 유사도로
  // "반복되는 카드 컨테이너"를 찾아 올라간다. 빽빽한 카드형 목록에서 행 선택을 안정화.
  function classKey(el) {
    var c = stableClasses(el);
    return tagName(el) + (c.length ? '.' + esc(c[0]) : '');
  }
  function siblingMatchCount(el) {
    var p = el.parentElement;
    if (!p) return 0;
    var key = classKey(el);
    var n = 0;
    Array.prototype.forEach.call(p.children, function (sib) {
      if (classKey(sib) === key) n++;
    });
    return n;
  }
  // el에서 위로 올라가며 "같은 형제가 가장 많은" 조상을 반복 카드로 선택(>=3).
  function snapToRepeatingContainer(el) {
    if (!el || el.nodeType !== 1) return el;
    var best = el, bestScore = siblingMatchCount(el);
    var cur = el, depth = 0;
    while (cur && cur.parentElement && depth < 8) {
      var tag = tagName(cur);
      if (tag === 'body' || tag === 'main' || tag === 'html') break;
      var score = siblingMatchCount(cur);
      // 더 바깥에서 같은-형제 수가 같거나 많으면 그쪽을 카드로(외곽 우선)
      if (score >= 3 && score >= bestScore) { best = cur; bestScore = score; }
      cur = cur.parentElement; depth++;
    }
    return bestScore >= 3 ? best : el;
  }

  // ---------- 자동 컬럼 발견 (Auto-detect) ----------
  // 행 하나만 클릭하면 그 안의 의미있는 세부 항목(텍스트/이미지)을 자동으로 컬럼화한다.
  // 초보자가 항목마다 집지 않아도 표가 바로 나오게 함. 재사용: inferRelative.

  // el의 '자기 텍스트'(자식 요소 텍스트 제외) — 텍스트 leaf 판별용.
  function ownText(el) {
    var t = '';
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 3) t += kids[i].nodeValue;
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  function readVal(node, attr) {
    if (!node) return null;
    if (attr === 'src' || attr === 'href') {
      var raw = node.getAttribute(attr);
      try { return raw == null ? null : new URL(raw, document.baseURI).href; } catch (e) { return raw; }
    }
    var t = node.textContent;
    return t == null ? null : t.replace(/\s+/g, ' ').trim();
  }

  function guessColName(el, attr, idx) {
    var cand = el.getAttribute('aria-label') || el.getAttribute('title') ||
               (attr === 'src' ? el.getAttribute('alt') : '') || '';
    var cls = stableClasses(el);
    if (!cand && cls.length) cand = cls[cls.length - 1];
    if (!cand) cand = attr === 'src' ? 'image' : (attr === 'href' ? 'link' : 'text');
    cand = String(cand).toLowerCase().replace(/[^a-z0-9가-힣]+/g, '_').replace(/^_+|_+$/g, '');
    return cand || ('field_' + (idx + 1));
  }

  // rowEl: 클릭/스냅된 행 1개. rowSelector: 전체 행 셀렉터(coverage 검증용, 없으면 단일 행).
  // 반환: [{ name, selector, attr, transform, sample }]
  function autoFields(rowEl, rowSelector) {
    if (!rowEl || rowEl.nodeType !== 1) return [];
    var candidates = [];
    var seen = {};

    // 1) 텍스트 leaf(자기 텍스트가 있는 요소) + 이미지 src 후보 수집
    Array.prototype.forEach.call(rowEl.querySelectorAll('*'), function (el) {
      if (el.id === 'uc-badge' || el.id === 'uc-diag') return;
      var tag = tagName(el);
      if (tag === 'img' && el.getAttribute('src')) {
        candidates.push({ el: el, attr: 'src' });
      }
      var ot = ownText(el);
      if (ot && ot.length <= 200) candidates.push({ el: el, attr: 'text' });
    });

    // 2) 상대 셀렉터화 + 중복 제거
    var fields = [];
    candidates.forEach(function (c) {
      var sel = inferRelative(rowEl, c.el);
      if (!sel) return;
      var key = sel + '|' + c.attr;
      if (seen[key]) return;
      seen[key] = true;
      fields.push({ el: c.el, selector: sel, attr: c.attr });
    });

    // 3) coverage/상수 필터 — 행 전체에 적용해 노이즈(라벨·보일러플레이트) 제거
    var rows = [];
    if (rowSelector) {
      try { rows = Array.prototype.slice.call(document.querySelectorAll(rowSelector)); } catch (e) { rows = []; }
    }
    if (!rows.length) rows = [rowEl];

    fields = fields.filter(function (f) {
      var vals = rows.map(function (r) {
        var n;
        try { n = r.querySelector(':scope ' + f.selector); } catch (e) { n = null; }
        return n ? readVal(n, f.attr) : null;
      });
      var nonEmpty = vals.filter(function (v) { return v != null && v !== ''; }).length;
      if (nonEmpty / rows.length < 0.3) return false; // 30% 미만 매칭 = 제외
      if (rows.length >= 3) {
        var distinct = {};
        vals.forEach(function (v) { if (v) distinct[v] = 1; });
        if (Object.keys(distinct).length <= 1) return false; // 모든 행 동일값 = 보일러플레이트
      }
      return true;
    });

    // 4) 명명 + 샘플값 + 중복 이름 정리
    var usedNames = {};
    return fields.slice(0, 12).map(function (f, i) {
      var name = guessColName(f.el, f.attr, i);
      if (usedNames[name]) { var n = 2; while (usedNames[name + '_' + n]) n++; name = name + '_' + n; }
      usedNames[name] = 1;
      return {
        name: name,
        selector: f.selector,
        attr: f.attr,
        transform: 'none',
        sample: readVal(f.el, f.attr),
      };
    });
  }

  window.__ucInfer = {
    inferFromSamples: inferFromSamples,
    inferSingle: inferSingle,
    generalize: generalize,
    previewCount: previewCount,
    inferRelative: inferRelative,
    snapToRepeatingContainer: snapToRepeatingContainer,
    autoFields: autoFields,
  };
})();
