/*
 * e2e/unit.js — 순수 로직 단위테스트 (브라우저 불필요, 의존성 0).
 * 확장의 실제 모듈(lib/robots.js, lib/serialize.js, content/extractor.js)을 그대로 로드해 검증 → 드리프트 없음.
 *   node unit.js
 */
global.self = global;
global.window = global;

require('../lib/robots.js');
require('../lib/serialize.js');
require('../content/extractor.js');

const R = self.__ucRobots;
const S = self.__ucSerialize;
const E = self.__ucExtract;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  — ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  — ' + extra : '')); }
};

// ===== robots.js (RFC 9309) =====
const r1 = R.parseRobots('User-agent: *\nDisallow: /\nAllow: /catalogue/');
check('[robots] Allow 우선: /catalogue 허용', R.isAllowed(r1, '/catalogue/page-2.html').allowed === true);
check('[robots] root 차단', R.isAllowed(r1, '/').allowed === false);
const r2 = R.parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /private/');
check('[robots] *.pdf$ 차단', R.isAllowed(r2, '/docs/a.pdf').allowed === false);
check('[robots] $앵커: a.pdf.html 허용', R.isAllowed(r2, '/a.pdf.html').allowed === true);
check('[robots] /private/ 차단', R.isAllowed(r2, '/private/x').allowed === false);
const r3 = R.parseRobots('User-agent: BadBot\nDisallow: /');
check('[robots] 비-* 그룹 무시', R.isAllowed(r3, '/anything').allowed === true);
const r4 = R.parseRobots('User-agent: *\nDisallow: /a/\nAllow: /a/b/');
check('[robots] 최장 패턴 우선', R.isAllowed(r4, '/a/b/c').allowed === true && R.isAllowed(r4, '/a/x').allowed === false);
check('[robots] soft-404 방어', R.looksLikeRobots('<html>404</html>') === false && R.looksLikeRobots('User-agent: *') === true);

// ===== serialize.js (클램프 + CSV) — background.js가 쓰는 바로 그 코드 =====
check('[clamp] delay 하한 2000', S.clampDelay(0) === 2000 && S.clampDelay(500) === 2000 && S.clampDelay('x') === 2000);
check('[clamp] delay 유지', S.clampDelay(3000) === 3000);
check('[clamp] pages 상한 20', S.clampPages(9999) === 20);
check('[clamp] pages 하한 1', S.clampPages(0) === 1 && S.clampPages(-5) === 1);
check('[clamp] pages 유지', S.clampPages(5) === 5);

check('[csv] 평문', S.csvEscape('hello') === 'hello');
check('[csv] 쉼표 인용', S.csvEscape('a,b') === '"a,b"');
check('[csv] 따옴표 이중화', S.csvEscape('She said "hi"') === '"She said ""hi"""');
check('[csv] 개행 인용', S.csvEscape('l1\nl2') === '"l1\nl2"');
check('[csv] null 빈칸', S.csvEscape(null) === '');
const csv = S.buildCsv(
  [{ text: '안녕, "세계"', n: 1 }, { text: 'line\nbreak', n: null }],
  [{ name: 'text' }, { name: 'n' }]
);
check('[csv] BOM 선두', csv.charCodeAt(0) === 0xFEFF);
check('[csv] CRLF 줄바꿈', csv.indexOf('\r\n') !== -1);
check('[csv] 한글+쉼표+따옴표 셀 이스케이프', csv.includes('"안녕, ""세계"""'));
check('[csv] null 셀 빈칸', /,\r\n|,$/.test(csv.split('\r\n')[2]));

// ===== extractor.js transform — 확장의 실제 추출 변환 =====
check('[transform] to_number £51.77', E.applyTransform('£51.77', 'to_number') === 51.77);
check('[transform] to_number 1,234 KRW', E.applyTransform('1,234 KRW', 'to_number') === 1234);
check('[transform] word_to_number Three', E.applyTransform('Three', 'word_to_number') === 3);
check('[transform] trim', E.applyTransform('  x  ', 'trim') === 'x');
check('[transform] none 보존', E.applyTransform(' x ', 'none') === ' x ');

console.log('\n==== 단위테스트 결과: ' + pass + ' PASS / ' + fail + ' FAIL ====');
process.exit(fail === 0 ? 0 : 1);
