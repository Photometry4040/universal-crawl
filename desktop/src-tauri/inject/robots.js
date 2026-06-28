/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * inject/robots.js — robots.txt 파서 (RFC 9309, 외부 의존 0)
 * Tauri WebView inject 컨텍스트에서 사용. 커스텀 User-agent를 쓰지 않으므로 '*' 그룹만 평가한다.
 *
 *  parseRobots(text) -> { rules: [{allow, pattern, regex, len}], hasDirectives }
 *  isAllowed(parsed, pathAndQuery) -> { allowed, matchedBy }
 *
 * HTTP 상태 분기(200/4xx/5xx)는 호출부(프론트엔드 또는 Rust 커맨드)에서 처리한다.
 */
(function () {
  'use strict';

  // robots 패턴(*, $ 와일드카드 포함, 접두사 매칭)을 정규식으로 컴파일
  function compilePattern(pattern) {
    var re = '';
    for (var i = 0; i < pattern.length; i++) {
      var ch = pattern[i];
      if (ch === '*') {
        re += '.*';
      } else if (ch === '$' && i === pattern.length - 1) {
        re += '$';
      } else {
        // 정규식 메타문자 이스케이프
        re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      }
    }
    // 접두사 매칭: 시작 앵커
    return new RegExp('^' + re);
  }

  function parseRobots(text) {
    var lines = String(text || '').split(/\r?\n/);
    var groups = []; // [{ agents: [..], rules: [..] }]
    var current = null;
    var lastWasAgent = false;
    var hasDirectives = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // 주석 제거
      var hash = line.indexOf('#');
      if (hash !== -1) line = line.slice(0, hash);
      line = line.trim();
      if (!line) continue;

      var idx = line.indexOf(':');
      if (idx === -1) continue;
      var field = line.slice(0, idx).trim().toLowerCase();
      var value = line.slice(idx + 1).trim();

      if (field === 'user-agent') {
        hasDirectives = true;
        // 연속된 user-agent 라인은 같은 그룹을 공유
        if (!current || !lastWasAgent) {
          current = { agents: [], rules: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
      } else if (field === 'allow' || field === 'disallow') {
        hasDirectives = true;
        if (!current) { current = { agents: ['*'], rules: [] }; groups.push(current); }
        lastWasAgent = false;
        // 빈 Disallow는 '모두 허용'을 의미 — 규칙으로 보존(빈 패턴)
        current.rules.push({
          allow: field === 'allow',
          pattern: value,
        });
      } else {
        lastWasAgent = false;
        // sitemap, crawl-delay 등은 무시
      }
    }

    // '*' 그룹의 규칙만 수집
    var starRules = [];
    groups.forEach(function (g) {
      if (g.agents.indexOf('*') !== -1) {
        g.rules.forEach(function (r) {
          starRules.push(r);
        });
      }
    });

    // 정규식/길이 사전 컴파일
    var compiled = starRules
      .filter(function (r) { return r.pattern !== ''; }) // 빈 Disallow(=전체 허용)는 매칭에서 자연 제외
      .map(function (r) {
        return { allow: r.allow, pattern: r.pattern, regex: compilePattern(r.pattern), len: r.pattern.length };
      });

    return { rules: compiled, hasDirectives: hasDirectives };
  }

  // RFC 9309: 매칭 규칙 중 최장 패턴 우선, 동률이면 Allow 우선.
  function isAllowed(parsed, pathAndQuery) {
    var path = pathAndQuery || '/';
    try { path = decodeURI(path); } catch (e) { /* keep */ }

    if (!parsed || !parsed.rules || !parsed.rules.length) {
      return { allowed: true, matchedBy: null };
    }

    var best = null;
    parsed.rules.forEach(function (r) {
      if (r.regex.test(path)) {
        if (!best || r.len > best.len || (r.len === best.len && r.allow && !best.allow)) {
          best = r;
        }
      }
    });

    if (!best) return { allowed: true, matchedBy: null };
    return { allowed: best.allow, matchedBy: best.pattern };
  }

  // soft-404 방어: 본문에 지시어 토큰이 전혀 없으면 robots 없음으로 간주
  function looksLikeRobots(text) {
    return /(^|\n)\s*(user-agent|disallow|allow)\s*:/i.test(String(text || ''));
  }

  var api = { parseRobots: parseRobots, isAllowed: isAllowed, looksLikeRobots: looksLikeRobots, compilePattern: compilePattern };

  // popup(window) 및 service worker(self) 양쪽 노출
  if (typeof window !== 'undefined') window.__ucRobots = api;
  if (typeof self !== 'undefined') self.__ucRobots = api;
})();
