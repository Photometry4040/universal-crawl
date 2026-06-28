/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * content/paginator.js — 페이지네이션 다음 행동 계산 (content 측)
 * 전역 window.__ucPaginate 노출.
 *
 * 설계: content는 가능하면 직접 네비게이트(click)하지 않고, "다음 후보 정보"를
 * background에 반환한다. background가 tabs.update로 네비게이션을 주도(상태머신 일관성).
 *
 *  - getNext(profile, currentPage): { type, href?, hasNext, jsButton? }
 *      next_button: next 링크의 href를 반환(있으면 background가 tabs.update).
 *                   href 없는 순수 JS 버튼이면 jsButton=true (content click 폴백 대상).
 *      url_pattern: pattern의 {N}을 (currentPage+1)로 치환한 URL.
 *  - clickJsNext(profile): 순수 JS 버튼 폴백 클릭(즉시 unload 가능).
 *  - scrollAndWait(profile): infinite_scroll 한 라운드 — 스크롤 후 신규 행 대기.
 */
(function () {
  'use strict';

  function findNextElement(selector) {
    var el = null;
    if (selector) {
      try { el = document.querySelector(selector); } catch (e) { el = null; }
      if (el) return el;
      return null;
    }

    var candidates = [
      'a[rel~="next"]',
      'link[rel~="next"]',
      '.next a[href]',
      'li.next a[href]',
      'a.next[href]',
      'a.pagination-next[href]',
      '[aria-label="Next"]',
      '[aria-label="next"]',
      '[aria-label*="Next"]',
      '[aria-label*="next"]',
    ];
    for (var i = 0; i < candidates.length; i++) {
      try {
        el = document.querySelector(candidates[i]);
        if (el) return el;
      } catch (e2) { /* ignore invalid candidate */ }
    }

    var links = Array.prototype.slice.call(document.querySelectorAll('a[href], button'));
    for (var j = 0; j < links.length; j++) {
      var text = (links[j].textContent || '').replace(/\s+/g, ' ').trim();
      var label = links[j].getAttribute && (links[j].getAttribute('aria-label') || links[j].getAttribute('title') || '');
      if (/^(next|next page|다음|›|»|>)$/i.test(text) || /next|다음/i.test(label)) {
        return links[j];
      }
    }
    return null;
  }

  function getNext(profile, currentPage) {
    var pg = (profile && profile.pagination) || {};
    var type = pg.type || 'next_button';

    if (type === 'url_pattern') {
      var pattern = pg.pattern || pg.selector || '';
      var n = (currentPage || 1) + 1;
      var url = pattern.replace(/\{N\}/g, String(n)).replace(/\{page\}/g, String(n));
      return { type: type, href: url ? new URL(url, document.baseURI).href : null, hasNext: !!url };
    }

    if (type === 'next_button') {
      var el = findNextElement(pg.selector);
      if (!el) return { type: type, hasNext: false };
      // 링크면 href, 아니면 내부 a 탐색
      var href = el.getAttribute && el.getAttribute('href');
      if (!href && el.querySelector) {
        var a = el.querySelector('a[href]');
        if (a) href = a.getAttribute('href');
      }
      if (href && href !== '#' && href.indexOf('javascript:') !== 0) {
        return { type: type, href: new URL(href, document.baseURI).href, hasNext: true };
      }
      // 순수 JS 버튼: content가 click 폴백
      return { type: type, hasNext: true, jsButton: true };
    }

    if (type === 'infinite_scroll') {
      return { type: type, hasNext: true };
    }

    return { type: type, hasNext: false };
  }

  function clickJsNext(profile) {
    var pg = (profile && profile.pagination) || {};
    var el = findNextElement(pg.selector);
    if (!el) return false;
    el.click();
    return true;
  }

  // infinite_scroll 한 라운드: 현재 행 수 기록 → 하단 스크롤 → 폴링으로 신규 행 대기.
  // 반환: Promise<{ grew: boolean, count: number }>
  function scrollAndWait(profile, opts) {
    opts = opts || {};
    var rowSel = profile.row_selector;
    var timeoutMs = opts.timeoutMs || 4000;
    var intervalMs = opts.intervalMs || 250;

    function count() {
      try { return document.querySelectorAll(rowSel).length; } catch (e) { return 0; }
    }

    var before = count();
    window.scrollTo(0, document.body.scrollHeight);

    return new Promise(function (resolve) {
      var elapsed = 0;
      var timer = setInterval(function () {
        var now = count();
        elapsed += intervalMs;
        if (now > before) {
          clearInterval(timer);
          resolve({ grew: true, count: now });
        } else if (elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve({ grew: false, count: now });
        } else {
          // 계속 하단으로 밀어 lazy-load 유도
          window.scrollTo(0, document.body.scrollHeight);
        }
      }, intervalMs);
    });
  }

  window.__ucPaginate = {
    getNext: getNext,
    clickJsNext: clickJsNext,
    scrollAndWait: scrollAndWait,
  };
})();
