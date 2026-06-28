/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
/*
 * desktop/e2e/picker.test.js — 주입 스크립트 전달 로직 e2e (jsdom, 브라우저 불필요)
 *
 * 검증 범위: finder/selector-infer/extractor/picker를 실제 DOM(jsdom)에 로드하고
 * 클릭을 시뮬레이션해, picker가 Tauri IPC(invoke)로 '무엇을' 보내는지 확인한다.
 *   - 행 클릭 → invoke('on_pick', {pick:{selector,...}})
 *   - 필드 집기 → invoke('on_field_pick', {pick:{fieldIndex,selector,attr,...}})
 *   - 추출 → invoke('collect_rows', {rows,fields})
 * 이 테스트가 통과하면 JS 전달 로직은 정상 → 버그는 Tauri eval/IPC 경계에 있음.
 * (Rust↔webview 경계 자체는 jsdom으로 못 테스트 — tauri-driver는 macOS 미지원.)
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const INJECT = path.join(__dirname, '..', 'src-tauri', 'inject');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  — ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  — ' + extra : '')); }
}

// quotes.toscrape.com 유사 DOM
const HTML = `<!doctype html><html><body><div class="container">
  <div class="quote"><span class="text">"Q1"</span><small class="author">A1</small><a class="tag" href="/t/1">t1</a></div>
  <div class="quote"><span class="text">"Q2"</span><small class="author">A2</small><a class="tag" href="/t/2">t2</a></div>
  <div class="quote"><span class="text">"Q3"</span><small class="author">A3</small><a class="tag" href="/t/3">t3</a></div>
</div></body></html>`;

const dom = new JSDOM(HTML, { url: 'https://quotes.toscrape.com/', runScripts: 'outside-only' });
const { window } = dom;

// Tauri IPC 스텁: invoke 호출 기록
const calls = [];
window.__TAURI__ = {
  core: { invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve(); } },
};

// 주입 순서대로 로드(앱과 동일)
for (const f of ['finder.js', 'selector-infer.js', 'extractor.js', 'picker.js']) {
  window.eval(fs.readFileSync(path.join(INJECT, f), 'utf8'));
}

function clickEl(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function lastCall(cmd) {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].cmd === cmd) return calls[i];
  return null;
}

const doc = window.document;
const quotes = doc.querySelectorAll('.quote');

// --- 모듈 로드 확인 ---
check('[로드] __ucFinder/__ucInfer/__ucExtract 전역', !!(window.__ucFinder && window.__ucInfer && window.__ucExtract));
check('[로드] picker __ucStartFieldPick/__ucRunExtract 전역', !!(window.__ucStartFieldPick && window.__ucRunExtract));

// --- 1) 행 클릭 → on_pick 전달 ---
clickEl(quotes[0]);
const onPick = lastCall('on_pick');
check('[행] on_pick invoke 호출됨', !!onPick);
const rowSel = onPick && onPick.args && onPick.args.pick && onPick.args.pick.selector;
check('[행] pick.selector 비어있지 않음', !!rowSel, rowSel);
check('[행] 셀렉터가 .quote 3개 매칭', !!rowSel && doc.querySelectorAll(rowSel).length === 3, rowSel);

// --- 2) 필드 집기 → on_field_pick 전달 ---
window.__ucStartFieldPick(1);
clickEl(quotes[0].querySelector('.text'));
const fp = lastCall('on_field_pick');
check('[필드] on_field_pick invoke 호출됨', !!fp);
const fpick = fp && fp.args && fp.args.pick;
check('[필드] fieldIndex 전달 == 1', !!fpick && fpick.fieldIndex === 1, fpick && String(fpick.fieldIndex));
check('[필드] 상대 셀렉터 .text', !!fpick && fpick.selector === '.text', fpick && fpick.selector);
check('[필드] attr 추정 text', !!fpick && fpick.attr === 'text', fpick && fpick.attr);

// 링크 필드 → href 추정
window.__ucStartFieldPick(2);
clickEl(quotes[1].querySelector('.tag'));
const fp2 = lastCall('on_field_pick');
check('[필드] 링크 attr 추정 href', !!fp2 && fp2.args.pick.attr === 'href', fp2 && fp2.args.pick.attr);

// --- 3) 추출 → collect_rows 전달 ---
const profile = {
  row_selector: '.quote',
  fields: [
    { name: 'text', selector: '.text', attr: 'text', transform: 'none' },
    { name: 'author', selector: '.author', attr: 'text', transform: 'none' },
  ],
};
window.__ucRunExtract(profile);
const cr = lastCall('collect_rows');
check('[추출] collect_rows invoke 호출됨', !!cr);
const rows = cr && cr.args && cr.args.rows;
check('[추출] 3행 추출', Array.isArray(rows) && rows.length === 3, rows && String(rows.length));
check('[추출] row[0].text == "Q1"', !!rows && rows[0].text === '"Q1"', rows && rows[0] && rows[0].text);
check('[추출] row[0].author == A1', !!rows && rows[0].author === 'A1', rows && rows[0] && rows[0].author);
check('[추출] fields 전달', !!cr && Array.isArray(cr.args.fields) && cr.args.fields.length === 2);

console.log(`\n==== picker e2e: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
