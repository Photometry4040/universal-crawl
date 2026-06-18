/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * popup/popup.js — 컨트롤 패널.
 * 선택 결과/진행률은 chrome.storage.local 단일 채널로 동기화(팝업은 닫혔다 열려도 복원).
 */
(function () {
  'use strict';
  var R = window.__ucRobots;
  var $ = function (id) { return document.getElementById(id); };

  var tab = null;       // 활성 탭
  var origin = null;
  var robotsStatus = 'unknown'; // ok | bad | warn | unknown
  var fields = [];      // [{name, selector, attr, transform}]

  // ---------- storage 헬퍼 ----------
  function sGet(keys) { return new Promise(function (r) { chrome.storage.local.get(keys, r); }); }
  function sSet(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, r); }); }

  function send(msg) {
    return new Promise(function (res) {
      chrome.runtime.sendMessage(msg, function (resp) { void chrome.runtime.lastError; res(resp); });
    });
  }
  function sendTab(msg) {
    return new Promise(function (res) {
      if (!tab) return res(null);
      chrome.tabs.sendMessage(tab.id, msg, function (resp) { void chrome.runtime.lastError; res(resp); });
    });
  }

  // ---------- consent ----------
  async function getConsentMap() { var d = await sGet('uc_consent'); return d.uc_consent || {}; }
  async function saveConsent(patch) {
    var map = await getConsentMap();
    map[origin] = Object.assign({ tos: false, robotsAck: false, robotsText: '', robotsStatus: 'unknown' }, map[origin] || {}, patch, { ts: Date.now() });
    await sSet({ uc_consent: map });
    return map[origin];
  }
  async function getConsent() { var map = await getConsentMap(); return map[origin] || null; }

  // ---------- robots.txt 확인 ----------
  async function checkRobots() {
    var statusEl = $('robots-status');
    var banner = $('robots-banner');
    statusEl.textContent = '확인 중…'; statusEl.className = 'status';
    banner.classList.add('hidden');

    var path = '/';
    try { var u = new URL(tab.url); path = u.pathname + u.search; } catch (e) {}

    var text = '', httpStatus = 0, failed = false;
    try {
      var ctrl = new AbortController();
      var to = setTimeout(function () { ctrl.abort(); }, 5000);
      var res = await fetch(origin + '/robots.txt', { signal: ctrl.signal, credentials: 'omit' });
      clearTimeout(to);
      httpStatus = res.status;
      if (res.ok) text = await res.text();
    } catch (e) { failed = true; }

    var status, allowedInfo = null;
    if (failed || httpStatus === 429 || httpStatus >= 500) {
      status = 'warn'; // 🟠 확인불가 → 보수적 차단
    } else if (httpStatus >= 400) {
      status = 'ok';   // 4xx (404 등) → 규칙 없음 → 허용
    } else if (text && R.looksLikeRobots(text)) {
      var parsed = R.parseRobots(text);
      allowedInfo = R.isAllowed(parsed, path);
      status = allowedInfo.allowed ? 'ok' : 'bad';
    } else {
      status = 'ok';   // 200이나 지시어 없음 → 규칙 없음
    }
    robotsStatus = status;

    // consent에 robotsText/status 저장 (background 재검증용)
    var prev = await getConsent();
    var prevAck = prev && prev.robotsAck && prev.robotsStatus === status; // 상태 바뀌면 ack 무효
    await saveConsent({ robotsText: text, robotsStatus: status, robotsAck: status === 'ok' ? true : !!prevAck });

    // UI 반영
    if (status === 'ok') {
      statusEl.textContent = '🟢 허용'; statusEl.className = 'status ok';
    } else if (status === 'bad') {
      statusEl.textContent = '🔴 Disallow'; statusEl.className = 'status bad';
      showRobotsBanner('이 경로는 robots.txt에서 Disallow 대상입니다' + (allowedInfo && allowedInfo.matchedBy ? ' (' + allowedInfo.matchedBy + ')' : '') + '. 교육 목적이라도 대상 사이트 정책을 존중해야 합니다.', false);
    } else {
      statusEl.textContent = '🟠 확인불가'; statusEl.className = 'status warn';
      showRobotsBanner('robots.txt를 확인할 수 없습니다(네트워크/서버 오류). 안전을 위해 기본 차단됩니다.', true);
    }
    await refreshGate();
  }

  function showRobotsBanner(text, amber) {
    var banner = $('robots-banner');
    banner.className = 'banner' + (amber ? ' amber' : '');
    banner.innerHTML = '';
    var p = document.createElement('div'); p.textContent = text; banner.appendChild(p);
    var btn = document.createElement('button');
    btn.className = 'mini'; btn.textContent = '이해했고 계속한다';
    btn.addEventListener('click', async function () {
      await saveConsent({ robotsAck: true, robotsStatus: robotsStatus });
      banner.classList.add('hidden');
      await refreshGate();
    });
    banner.appendChild(btn);
    banner.classList.remove('hidden');
  }

  // ---------- 게이트(추출 버튼 활성 조건) ----------
  async function refreshGate() {
    var c = await getConsent();
    var tos = !!(c && c.tos);
    var robotsAck = !!(c && c.robotsAck);
    var ready = tos && robotsAck && fields.length > 0 && $('row-selector').value.trim();
    var job = (await send({ type: 'getJob' })) || {};
    var running = job.job && job.job.active;

    $('tos-check').checked = tos;
    $('btn-extract-once').disabled = !ready || running;
    $('btn-collect').disabled = !ready || running;
    $('btn-stop').classList.toggle('hidden', !running);

    var hint = '';
    if (!tos) hint = 'ToS 확인 체크박스를 선택하세요.';
    else if (!robotsAck) hint = 'robots.txt 경고를 확인(이해했고 계속)해야 합니다.';
    else if (!$('row-selector').value.trim()) hint = '행(row) 셀렉터를 지정하세요.';
    else if (!fields.length) hint = '필드를 1개 이상 추가하세요.';
    $('gate-hint').textContent = hint;
  }

  // ---------- 필드 UI ----------
  function renderFields() {
    var wrap = $('field-list');
    wrap.innerHTML = '';
    fields.forEach(function (f, i) {
      var div = document.createElement('div');
      div.className = 'field-item';
      div.innerHTML =
        '<div class="fi-row1">' +
          '<input class="name-in" value="' + escAttr(f.name) + '" placeholder="컬럼 이름 (예: model)">' +
          '<button class="del" title="삭제">×</button>' +
        '</div>' +
        '<div class="fi-row2">' +
          '<input class="sel-in mono" value="' + escAttr(f.selector) + '" placeholder="셀렉터 (예: .title)">' +
          '<input class="attr-in mono" value="' + escAttr(f.attr) + '" placeholder="text" title="attr: text | href | src | text_all | class | classToken:N | 속성명">' +
          '<select class="tf-in"></select>' +
        '</div>';
      var tf = div.querySelector('.tf-in');
      ['none', 'trim', 'to_number', 'word_to_number'].forEach(function (t) {
        var o = document.createElement('option'); o.value = t; o.textContent = t;
        if (t === f.transform) o.selected = true; tf.appendChild(o);
      });
      div.querySelector('.name-in').addEventListener('input', function (e) { fields[i].name = e.target.value; refreshGate(); });
      div.querySelector('.sel-in').addEventListener('input', function (e) { fields[i].selector = e.target.value; });
      div.querySelector('.attr-in').addEventListener('input', function (e) { fields[i].attr = e.target.value; });
      tf.addEventListener('change', function (e) { fields[i].transform = e.target.value; });
      div.querySelector('.del').addEventListener('click', function () { fields.splice(i, 1); renderFields(); refreshGate(); });
      wrap.appendChild(div);
    });
  }
  function escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

  function addField(f) {
    fields.push(Object.assign({ name: 'field' + (fields.length + 1), selector: '', attr: 'text', transform: 'none' }, f || {}));
    renderFields(); refreshGate();
  }

  // ---------- 프로필 빌드 ----------
  function buildProfile() {
    var type = $('pagi-type').value;
    var delay = Math.max(2000, parseInt($('delay-ms').value, 10) || 2000);
    var pages = Math.min(20, Math.max(1, parseInt($('max-pages').value, 10) || 1));
    $('delay-ms').value = delay; $('max-pages').value = pages;
    return {
      version: 1,
      site: origin ? origin.replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '_') : 'extract',
      url_sample: tab ? tab.url : '',
      row_selector: $('row-selector').value.trim(),
      fields: fields.map(function (f) { return { name: f.name, selector: f.selector, attr: f.attr || 'text', transform: f.transform || 'none' }; }),
      pagination: { type: type, selector: $('pagi-selector').value.trim(), pattern: $('pagi-pattern').value.trim() },
      delay_ms: delay, max_pages: pages,
      dedupe_key: '',
    };
  }
  function applyProfile(p) {
    $('row-selector').value = p.row_selector || '';
    fields = (p.fields || []).map(function (f) { return { name: f.name, selector: f.selector, attr: f.attr || 'text', transform: f.transform || 'none' }; });
    var pg = p.pagination || {};
    $('pagi-type').value = pg.type || 'next_button';
    $('pagi-selector').value = pg.selector || '';
    $('pagi-pattern').value = pg.pattern || '';
    $('delay-ms').value = Math.max(2000, p.delay_ms || 2500);
    $('max-pages').value = Math.min(20, Math.max(1, p.max_pages || 5));
    onPagiTypeChange();
    renderFields(); refreshGate();
  }

  // ---------- 결과 미리보기 ----------
  function renderPreview(rows, meta) {
    $('result-meta').textContent = meta || ((rows ? rows.length : 0) + '행');
    var wrap = $('preview-table');
    wrap.innerHTML = '';
    if (!rows || !rows.length) { $('btn-csv').disabled = true; $('btn-json').disabled = true; return; }
    var cols = fields.map(function (f) { return f.name; });
    if (!cols.length && rows[0]) cols = Object.keys(rows[0]);
    var tbl = document.createElement('table');
    var thead = '<tr>' + cols.map(function (c) { return '<th>' + escHtml(c) + '</th>'; }).join('') + '</tr>';
    var body = rows.slice(0, 10).map(function (row) {
      return '<tr>' + cols.map(function (c) { return '<td title="' + escAttr(row[c]) + '">' + escHtml(row[c]) + '</td>'; }).join('') + '</tr>';
    }).join('');
    tbl.innerHTML = thead + body;
    wrap.appendChild(tbl);
    $('btn-csv').disabled = false; $('btn-json').disabled = false;
  }
  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // ---------- storage 동기화 ----------
  function resetSelectButtons() {
    $('btn-row-select').textContent = '행 선택 모드 시작';
    $('btn-field-select').textContent = '필드 선택 모드';
  }
  function applySelection(sel) {
    if (!sel) return;
    if (sel.rowSelector != null && sel.mode === 'row_select') {
      $('row-selector').value = sel.rowSelector;
      $('row-count').textContent = (sel.count || 0) + '개 (샘플 ' + (sel.sampleCount || 0) + ')';
    }
    if (sel.mode === 'idle') resetSelectButtons(); // ESC 등으로 선택 종료
    refreshGate();
  }
  function applyJob(job) {
    if (!job) return;
    var p = job;
    if (p.active) {
      $('progress').textContent = (p.currentPage || 0) + '/' + (p.maxPages || 0) + ' 페이지, 누적 ' + (p.rows ? p.rows.length : 0) + '행';
      $('progress').className = 'status warn';
    } else if (p.status && p.status !== 'idle') {
      var label = { done: '완료', failed: '실패', stopped: '중단' }[p.status] || p.status;
      $('progress').textContent = label + ' — 누적 ' + (p.rows ? p.rows.length : 0) + '행' + (p.lastError ? ' (' + p.lastError + ')' : '');
      $('progress').className = 'status ' + (p.status === 'done' ? 'ok' : 'bad');
    }
    if (p.rows && p.rows.length) renderPreview(p.rows, '누적 ' + p.rows.length + '행');
    refreshGate();
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.uc_selection) applySelection(changes.uc_selection.newValue);
    if (changes.uc_job) applyJob(changes.uc_job.newValue);
    if (changes.uc_field_pick && changes.uc_field_pick.newValue) {
      var pick = changes.uc_field_pick.newValue;
      // 같은 선택을 중복 추가하지 않도록: 마지막 필드 셀렉터와 다르면 추가
      if (!fields.some(function (f) { return f.selector === pick.selector; })) {
        var attr = (pick.tag === 'a' && pick.href) ? 'text' : 'text';
        addField({ selector: pick.selector, attr: attr });
        $('btn-field-select').textContent = '필드 선택 중… (계속 클릭, ESC 종료)';
      }
    }
  });

  // ---------- UI 이벤트 ----------
  function onPagiTypeChange() {
    var t = $('pagi-type').value;
    $('pagi-selector').classList.toggle('hidden', t === 'url_pattern' || t === 'infinite_scroll');
    $('pagi-pattern').classList.toggle('hidden', t !== 'url_pattern');
  }

  function bind() {
    $('robots-recheck').addEventListener('click', checkRobots);
    $('tos-check').addEventListener('change', async function (e) {
      await saveConsent({ tos: e.target.checked });
      refreshGate();
    });
    $('btn-row-select').addEventListener('click', function () {
      // 사이드 패널은 페이지 클릭에도 닫히지 않으므로 그대로 둠(실시간 갱신).
      sendTab({ type: 'enterSelectMode', target: 'row' });
      $('btn-row-select').textContent = '행 선택 중… (페이지에서 클릭, ESC 종료)';
    });
    $('btn-row-preview').addEventListener('click', async function () {
      var r = await sendTab({ type: 'previewSelector', selector: $('row-selector').value.trim() });
      $('row-count').textContent = (r && r.count != null ? r.count : 0) + '개';
    });
    $('row-selector').addEventListener('input', refreshGate);
    $('btn-field-select').addEventListener('click', function () {
      var rs = $('row-selector').value.trim();
      if (!rs) { alert('먼저 행(row) 셀렉터를 지정하세요.'); return; }
      sendTab({ type: 'enterSelectMode', target: 'field', rowSelector: rs });
      $('btn-field-select').textContent = '필드 선택 중… (행 안쪽 클릭, ESC 종료)';
    });
    $('btn-add-field').addEventListener('click', function () { addField(); });
    $('pagi-type').addEventListener('change', onPagiTypeChange);
    $('btn-extract-once').addEventListener('click', async function () {
      var resp = await send({ type: 'extractOnce', profile: buildProfile(), tabId: tab.id });
      if (resp && resp.ok) renderPreview(resp.rows, (resp.rows.length) + '행 (현재 페이지)');
      else renderPreview([], '추출 실패' + (resp && resp.error ? ': ' + resp.error : ''));
    });
    $('btn-collect').addEventListener('click', async function () {
      $('progress').textContent = '수집 시작…';
      await send({ type: 'startCollect', profile: buildProfile(), tabId: tab.id, tabUrl: tab.url });
      refreshGate();
    });
    $('btn-stop').addEventListener('click', async function () { await send({ type: 'stopCollect' }); refreshGate(); });
    $('btn-csv').addEventListener('click', function () { doDownload('exportCsv'); });
    $('btn-json').addEventListener('click', function () { doDownload('exportJson'); });
    $('btn-export-profile').addEventListener('click', exportProfile);
    $('btn-import-profile').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', importProfile);
  }

  async function doDownload(type) {
    var status = $('dl-status');
    status.textContent = '다운로드 준비 중…';
    var resp = await send({ type: type, dir: $('dl-dir').value.trim(), saveAs: $('dl-saveas').checked });
    if (resp && resp.ok) {
      status.textContent = '✅ 다운로드 시작됨' + ($('dl-dir').value.trim() ? ' (다운로드/' + $('dl-dir').value.trim() + ')' : ' (다운로드 폴더)');
    } else {
      status.textContent = '❌ 다운로드 실패: ' + (resp && resp.error ? resp.error : '알 수 없음');
    }
  }

  function exportProfile() {
    var p = buildProfile();
    var blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (p.site || 'profile') + '.profile.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function importProfile(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var p = JSON.parse(reader.result);
        applyProfile(p);
        $('result-meta').textContent = '프로필 import 완료 (ToS/robots는 재확인 필요)';
      } catch (err) { alert('프로필 파싱 실패: ' + err); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ---------- 대상 탭 갱신(사이드 패널은 탭 전환에도 떠 있음) ----------
  async function refreshTarget() {
    var tabs = await new Promise(function (r) { chrome.tabs.query({ active: true, currentWindow: true }, r); });
    var newTab = tabs[0];
    if (!newTab || !/^https?:/.test(newTab.url || '')) {
      tab = newTab || null; origin = null;
      $('domain').textContent = '(http/https 페이지에서만 동작)';
      $('robots-status').textContent = '—'; $('robots-status').className = 'status';
      await refreshGate();
      return;
    }
    var newOrigin = (function () { try { return new URL(newTab.url).origin; } catch (e) { return null; } })();
    var originChanged = newOrigin !== origin;
    tab = newTab; origin = newOrigin;
    $('domain').textContent = origin || tab.url;
    var c = await getConsent();
    $('tos-check').checked = !!(c && c.tos);
    if (originChanged) await checkRobots(); // 오리진 바뀌면 robots 재평가
    await refreshGate();
  }

  // ---------- 초기화 ----------
  async function init() {
    bind();
    onPagiTypeChange();

    // 복원: 선택/잡
    var d = await sGet(['uc_selection', 'uc_job']);
    if (d.uc_selection) applySelection(d.uc_selection);
    renderFields();

    await refreshTarget();
    var jobResp = await send({ type: 'getJob' });
    if (jobResp && jobResp.job) applyJob(jobResp.job);

    // 탭 전환/URL 변경 시 대상 갱신
    chrome.tabs.onActivated.addListener(function () { refreshTarget(); });
    chrome.tabs.onUpdated.addListener(function (tabId, info, t) {
      if (tab && tabId === tab.id && info.url) refreshTarget();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
