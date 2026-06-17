/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * lib/finder.js — 경량 CSS 셀렉터 빌더
 * algorithm inspired by @medv/finder (MIT). 완전 복제가 아니라 MVP에 필요한
 * 핵심(id 우선 → 안정 class → tag+nth-child 폴백의 bottom-up uniqueness)만 구현.
 * 전역 window.__ucFinder(el, options) 노출. 외부 의존 0.
 */
(function () {
  'use strict';

  // 난수/해시처럼 보이는(=불안정한) 클래스명을 거부하는 휴리스틱.
  // CSS-in-JS(css-1a2b3c, sc-bdfBwQ, jsx-1234567), 16진수 해시, 무의미 토큰 차단.
  // 이 도구가 주입하는 오버레이 클래스 — 셀렉터 추론에 절대 포함하면 안 됨
  // (선택 모드에서 샘플/미리보기 요소에 붙으므로 제외하지 않으면 추론이 자기 클래스로 오염된다)
  var OVERLAY_CLASS = /^uc-(hover-highlight|sample-highlight|preview-highlight|row-confirmed)$/;

  function isStableClass(name) {
    if (!name || name.length < 2) return false;
    if (OVERLAY_CLASS.test(name)) return false;
    if (name.length > 40) return false;
    // 명시적 CSS-in-JS 프리픽스 + 해시
    if (/^(css-|sc-|jsx-|styled-|emotion-)/i.test(name) && /[0-9a-f]{4,}/i.test(name)) return false;
    // 순수 16진수/숫자 해시 토큰
    if (/^[0-9a-f]{6,}$/i.test(name)) return false;
    if (/^[0-9]+$/.test(name)) return false;
    // 4연속 자음(발음 불가 = 난수일 확률↑). 단, 통상 단어는 통과.
    if (/[bcdfghjklmnpqrstvwxyz]{5,}/i.test(name)) return false;
    return true;
  }

  function isStableId(id) {
    if (!id) return false;
    if (/^[0-9]/.test(id)) return false; // 숫자 시작 id는 CSS에서 까다로움
    if (/^(css-|sc-|jsx-|ember\d+|radix-|react-)/i.test(id)) return false;
    if (/[0-9a-f]{8,}/i.test(id)) return false; // 긴 해시
    if (/\d{4,}/.test(id)) return false; // 길게 이어진 숫자(자동 생성 id)
    return true;
  }

  function tagName(el) {
    return el.tagName ? el.tagName.toLowerCase() : '';
  }

  // CSS 식별자 이스케이프 (CSS.escape 우선, 폴백 포함)
  function esc(v) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(v);
    return String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function stableClasses(el) {
    if (!el.classList) return [];
    return Array.prototype.filter.call(el.classList, isStableClass);
  }

  // el의 부모 기준 nth-of-type 인덱스 (1-based). 같은 태그가 없으면 null.
  function nthOfType(el) {
    var parent = el.parentElement;
    if (!parent) return null;
    var tag = tagName(el);
    var sameTag = Array.prototype.filter.call(parent.children, function (c) {
      return tagName(c) === tag;
    });
    if (sameTag.length <= 1) return null;
    return sameTag.indexOf(el) + 1;
  }

  // 단일 요소에 대한 후보 토큰들을 안정성 우선순위로 반환.
  // 각 토큰은 부모 컨텍스트 없이 그 요소를 가리키는 단편(.cls, tag.cls, tag:nth-of-type(n)).
  function tokensFor(el) {
    var tag = tagName(el);
    var tokens = [];
    // 1) id (안정적이면 최우선, 보통 단독으로 고유)
    if (el.id && isStableId(el.id)) {
      tokens.push({ sel: '#' + esc(el.id), kind: 'id' });
    }
    // 2) 안정 class 조합 (단일 → 2개 조합)
    var cls = stableClasses(el);
    cls.forEach(function (c) {
      tokens.push({ sel: tag + '.' + esc(c), kind: 'class' });
      tokens.push({ sel: '.' + esc(c), kind: 'class' });
    });
    if (cls.length >= 2) {
      tokens.push({ sel: tag + '.' + esc(cls[0]) + '.' + esc(cls[1]), kind: 'class' });
    }
    // 3) data-* 속성 (안정적인 경우 많음)
    if (el.attributes) {
      Array.prototype.forEach.call(el.attributes, function (a) {
        if (/^data-/.test(a.name) && a.value && a.value.length < 30 && isStableClass(a.value)) {
          tokens.push({ sel: tag + '[' + a.name + '="' + a.value + '"]', kind: 'attr' });
        }
      });
    }
    // 4) tag + nth-of-type (위치 의존, 최후 폴백)
    var nth = nthOfType(el);
    if (nth) {
      tokens.push({ sel: tag + ':nth-of-type(' + nth + ')', kind: 'nth' });
    } else {
      tokens.push({ sel: tag, kind: 'tag' });
    }
    return tokens;
  }

  function matchesUnique(selector, root, target) {
    var found;
    try {
      found = (root || document).querySelectorAll(selector);
    } catch (e) {
      return false;
    }
    return found.length === 1 && found[0] === target;
  }

  /*
   * 주어진 요소를 고유하게 가리키는 셀렉터를 bottom-up으로 구성.
   * 가장 안정적인 단일 토큰이 이미 고유하면 그대로 반환,
   * 아니면 조상 토큰을 ' > '로 누적하며 고유해질 때까지 확장.
   */
  function finder(el, options) {
    options = options || {};
    var maxDepth = options.maxDepth || 6;
    if (!el || el.nodeType !== 1) return null;

    // 1) 단일 토큰이 즉시 문서 전역 고유한지 검사 (id 등)
    var own = tokensFor(el);
    for (var i = 0; i < own.length; i++) {
      if (own[i].kind === 'id' && matchesUnique(own[i].sel, document, el)) {
        return own[i].sel;
      }
    }

    // 2) bottom-up: el에서 시작해 조상으로 올라가며 경로를 누적
    var parts = [];
    var current = el;
    var depth = 0;
    while (current && current.nodeType === 1 && depth < maxDepth) {
      var toks = tokensFor(current);
      // 이 레벨에서 가장 안정적인 토큰 1개 선택(첫 토큰 = 최우선)
      var chosen = toks[0].sel;
      parts.unshift(chosen);
      var candidate = parts.join(' > ');
      if (matchesUnique(candidate, document, el)) {
        return candidate;
      }
      current = current.parentElement;
      depth++;
    }
    // 고유화 실패 시 현재까지 경로 반환 (best effort)
    return parts.join(' > ');
  }

  window.__ucFinder = finder;
  window.__ucFinder.isStableClass = isStableClass;
  window.__ucFinder.stableClasses = stableClasses;
  window.__ucFinder.tagName = tagName;
  window.__ucFinder.nthOfType = nthOfType;
  window.__ucFinder.esc = esc;
})();
