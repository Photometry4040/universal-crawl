/* 교육/테스트 전용 도구. 대상 사이트의 robots.txt·ToS를 반드시 준수할 것. */
// UniCrawl Desktop PoC — 컨트롤 패널 로직.
// open_target(url)로 임베디드 WebView를 열고, picker.js가 보내는 'uc-pick'
// 이벤트를 받아 집은 셀렉터/매칭 수를 패널에 표시한다.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let fieldCounter = 0;

function $(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  $("status").textContent = text;
}

// ---------- 안전장치: robots 배너 + ToS 게이트 ----------
const consent = { origin: "", robots: null, ack: false, tos: false };

function renderRobotsBanner() {
  const b = $("robots-banner");
  const ackBtn = $("robots-ack");
  const map = {
    allow: ["🟢 robots.txt: 수집 허용", "ok"],
    disallow: ["🔴 robots.txt: 이 경로는 Disallow — 자동 수집이 금지된 사이트입니다", "bad"],
    unknown: ["🟠 robots.txt 확인 불가 — 보수적으로 차단합니다", "warn"],
  };
  const [text, cls] = map[consent.robots] || ["robots 확인 중…", ""];
  b.textContent = text;
  b.className = "robots-banner " + cls;
  // 🟢는 자동 확인, 그 외엔 명시적 "이해했고 계속" 필요
  if (consent.robots === "allow") {
    consent.ack = true;
    ackBtn.hidden = true;
  } else {
    ackBtn.hidden = consent.ack; // 이미 눌렀으면 숨김
  }
}

function pushConsent() {
  if (!consent.origin) return;
  invoke("set_consent", {
    origin: consent.origin,
    tos: consent.tos,
    robotsAck: consent.ack,
  }).catch(() => {});
}

function updateGate() {
  const ok = consent.tos && consent.ack;
  $("run-extract").disabled = !ok;
  $("run-collect").disabled = !ok;
  $("target-step").classList.toggle("needs-consent", !ok);
  $("gate-hint").hidden = ok;
  $("gate-hint").textContent = consent.origin
    ? "① ToS 확인 후 추출할 수 있습니다."
    : "① 대상 열기 후 ToS를 확인하면 추출할 수 있습니다.";
  $("run-extract").title = ok ? "" : "① ToS 확인과 robots 확인이 필요합니다";
  $("run-collect").title = ok ? "" : "① ToS 확인과 robots 확인이 필요합니다";
}

// 셀렉터에서 필드 이름 추정(.author → author). 비개발자가 안 짜도 되게.
function guessFieldName(selector) {
  if (!selector) return "";
  const classes = selector.match(/\.([a-zA-Z][\w-]*)/g);
  if (classes && classes.length) {
    return classes[classes.length - 1].slice(1).replace(/-/g, "_");
  }
  const tag = selector.trim().split(/[\s>]+/).pop() || "";
  return tag.replace(/[^a-zA-Z0-9_]/g, "");
}

async function startFieldPickFor(index) {
  try {
    await invoke("start_field_pick", { fieldIndex: index });
    setStatus("대상 창에서 추출할 부분을 클릭하세요 (필드 #" + index + ")");
  } catch (e) {
    $("run-msg").textContent = "⚠ " + e;
  }
}

function createFieldRow(index) {
  const row = document.createElement("div");
  row.className = "field-row";
  row.dataset.fieldIndex = String(index);

  // 기본 보기: 이름 + 값 미리보기 + 집기/고급/삭제. 기술 옵션(셀렉터/속성/변환)은 '고급'에 숨김.
  row.innerHTML = `
    <div class="field-main">
      <input class="field-name" placeholder="이름 (예: 제목)" />
      <span class="field-preview" title="추출 미리보기">아직 안 집음</span>
      <button type="button" class="pick-field">⊕ 집기</button>
      <button type="button" class="ghost toggle-adv" title="셀렉터/속성 직접 편집">고급</button>
      <button type="button" class="ghost remove-field" title="삭제">✕</button>
    </div>
    <div class="field-adv" hidden>
      <label>셀렉터<input class="field-selector" placeholder=".text" /></label>
      <label>값
        <select class="field-attr">
          <option value="text">텍스트</option>
          <option value="href">링크(href)</option>
          <option value="src">이미지(src)</option>
          <option value="text_all">전체 텍스트</option>
          <option value="attribute">속성…</option>
        </select>
        <input class="field-custom-attr" placeholder="속성명" hidden />
      </label>
      <label>변환
        <select class="field-transform">
          <option value="none">없음</option>
          <option value="to_number">숫자로</option>
          <option value="trim">공백제거</option>
          <option value="word_to_number">영단어→숫자</option>
        </select>
      </label>
    </div>
  `;

  const attr = row.querySelector(".field-attr");
  const customAttr = row.querySelector(".field-custom-attr");
  attr.addEventListener("change", () => {
    customAttr.hidden = attr.value !== "attribute";
    if (!customAttr.hidden) customAttr.focus();
  });

  row.querySelector(".toggle-adv").addEventListener("click", () => {
    const adv = row.querySelector(".field-adv");
    adv.hidden = !adv.hidden;
  });

  row.querySelector(".pick-field").addEventListener("click", () => startFieldPickFor(index));

  row.querySelector(".remove-field").addEventListener("click", () => {
    row.remove();
    if (!document.querySelector(".field-row")) addFieldRow();
    setStatus("필드 삭제됨");
  });

  return row;
}

// 새 필드 행 생성 후 곧바로 집기 모드(클릭 우선 흐름).
async function addFieldByClick() {
  const idx = addFieldRow({ silent: true });
  await startFieldPickFor(idx);
}

function addFieldRow(options = {}) {
  const list = $("field-list");
  fieldCounter += 1;
  list.appendChild(createFieldRow(fieldCounter));
  if (!options.silent) {
    setStatus("필드 추가됨");
  }
  return fieldCounter;
}

function clampNumberInput(input, min, max) {
  const raw = Number.parseInt(input.value, 10);
  let next = Number.isFinite(raw) ? raw : min;
  if (next < min) next = min;
  if (max != null && next > max) next = max;
  input.value = String(next);
}

async function openTarget(url) {
  $("open-msg").textContent = "";
  try {
    await invoke("open_target", { url });
    setStatus("대상 열림 · 요소를 클릭하세요");
  } catch (e) {
    $("open-msg").textContent = "⚠ " + e;
    setStatus("열기 실패");
  }
}

function isGateOpen() {
  return consent.tos && consent.ack;
}

function guideToConsent() {
  $("target-step").classList.add("needs-consent", "pulse-consent");
  $("gate-hint").hidden = false;
  $("gate-hint").textContent = "① ToS 확인 후 추출할 수 있습니다.";
  $("target-step").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => $("target-step").classList.remove("pulse-consent"), 1200);
  setStatus("① ToS 확인이 필요합니다");
}

function ensureRunnable() {
  if (isGateOpen()) return true;
  guideToConsent();
  return false;
}

// 패널 입력 → profile 조립. row_selector는 ②에서 집은 셀렉터 사용.
function collectProfile() {
  const rowSelector = $("r-selector").textContent.trim();
  const fields = Array.from(document.querySelectorAll(".field-row")).map((row) => {
    const attrSel = row.querySelector(".field-attr").value;
    const customAttr = row.querySelector(".field-custom-attr").value.trim();
    return {
      name: row.querySelector(".field-name").value.trim() || "field",
      selector: row.querySelector(".field-selector").value.trim(),
      attr: attrSel === "attribute" ? (customAttr || "text") : attrSel,
      transform: row.querySelector(".field-transform").value,
    };
  });
  const mode = document.querySelector('input[name="pagination-mode"]:checked');
  const target = $("pagination-target").value.trim();
  const pagination = {
    type: mode ? mode.value : "next_button",
    selector: target,
    pattern: target,
  };
  // 안전장치: UI 입력 보정(백엔드에서 한 번 더 재클램프)
  const delay = Math.max(2000, parseInt($("pagination-delay").value, 10) || 2000);
  const maxPages = Math.min(20, Math.max(1, parseInt($("pagination-max-pages").value, 10) || 1));
  return { row_selector: rowSelector, fields, pagination, delay_ms: delay, max_pages: maxPages, dedupe_key: "" };
}

async function runCollect() {
  if (!ensureRunnable()) return;
  const profile = collectProfile();
  if (!profile.row_selector || profile.row_selector === "—") {
    $("run-msg").textContent = "⚠ 먼저 대상 창에서 행(반복 요소)을 클릭해 집으세요.";
    return;
  }
  $("run-msg").textContent = "";
  $("progress").textContent = "수집 시작…";
  try {
    await invoke("start_collect", { profile });
    setStatus("다중 페이지 수집 시작 (최대 " + profile.max_pages + "페이지)");
  } catch (e) {
    $("run-msg").textContent = "⚠ " + e;
  }
}

async function runExtract() {
  if (!ensureRunnable()) return;
  const profile = collectProfile();
  if (!profile.row_selector || profile.row_selector === "—") {
    $("run-msg").textContent = "⚠ 먼저 대상 창에서 행(반복 요소)을 클릭해 집으세요.";
    return;
  }
  $("run-msg").textContent = "";
  try {
    await invoke("request_extract", { profile });
    setStatus("추출 요청 전송 · 결과 대기");
  } catch (e) {
    $("run-msg").textContent = "⚠ " + e;
  }
}

async function runAutoCollect() {
  if (!ensureRunnable()) return;
  await runCollect();
}

async function exportFile(kind) {
  $("run-msg").textContent = "";
  try {
    const path = await invoke(kind === "csv" ? "export_csv" : "export_json");
    $("run-msg").textContent = "✅ 저장됨: " + path;
    setStatus("내보내기 완료");
  } catch (e) {
    $("run-msg").textContent = "⚠ " + e;
  }
}

function renderPreview(payload) {
  const headers = payload.headers || [];
  const preview = payload.preview || [];
  $("row-count").textContent = payload.count ?? 0;

  const table = $("preview-table");
  if (!headers.length || !preview.length) {
    table.innerHTML = "<tbody><tr><td>—</td></tr></tbody>";
    return;
  }
  const head = "<thead><tr>" + headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("") + "</tr></thead>";
  const body =
    "<tbody>" +
    preview
      .map(
        (r) =>
          "<tr>" +
          headers.map((h) => `<td>${escapeHtml(r[h])}</td>`).join("") +
          "</tr>"
      )
      .join("") +
    "</tbody>";
  table.innerHTML = head + body;
}

function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 자동 발견 컬럼 → ③ 필드 행 자동 생성 + 샘플 1행 미리보기(동의 없이도 에코).
function applyAutoFields(fields) {
  if (!Array.isArray(fields) || !fields.length) return;
  $("field-list").innerHTML = ""; // 기존 행 교체
  fields.forEach((f) => {
    const idx = addFieldRow({ silent: true });
    const row = document.querySelector(`.field-row[data-field-index="${idx}"]`);
    if (!row) return;
    row.querySelector(".field-name").value = f.name || "";
    row.querySelector(".field-selector").value = f.selector || "";
    const attrSel = row.querySelector(".field-attr");
    if (["text", "href", "src", "text_all"].includes(f.attr)) {
      attrSel.value = f.attr;
      attrSel.dispatchEvent(new Event("change"));
    }
    const preview = row.querySelector(".field-preview");
    if (preview) {
      preview.textContent = f.sample != null && f.sample !== "" ? "“" + String(f.sample).slice(0, 40) + "”" : "(빈 값)";
      preview.classList.add("picked");
    }
  });
  // 샘플 1행 미리보기로 '이렇게 뽑혀요'를 즉시 보여줌(전체 추출은 ToS 확인 후).
  const headers = fields.map((f) => f.name);
  const sampleRow = {};
  fields.forEach((f) => { sampleRow[f.name] = f.sample; });
  renderPreview({ headers, preview: [sampleRow], count: 1 });
  $("progress").textContent =
    "자동으로 " + fields.length + "개 항목을 찾았어요 — 이름을 바꾸거나 ✕로 지우고, ① ToS 확인 후 추출하세요.";
}

function applyAutoPagination(pagination) {
  if (!pagination || pagination.type !== "next_button" || !pagination.selector) return;
  const radio = document.querySelector('input[name="pagination-mode"][value="next_button"]');
  if (radio) radio.checked = true;
  $("pagination-target").value = pagination.selector;
  $("pagination-auto-msg").hidden = false;
  const detail = pagination.href ? " · " + pagination.href : "";
  $("pagination-auto-msg").textContent = "다음 페이지 자동 감지됨 ✓" + detail;
}

window.addEventListener("DOMContentLoaded", () => {
  addFieldRow({ silent: true });

  $("open-form").addEventListener("submit", (e) => {
    e.preventDefault();
    openTarget($("url-input").value.trim());
  });

  $("add-field").addEventListener("click", addFieldByClick);
  $("pagination-delay").addEventListener("change", (e) => {
    clampNumberInput(e.target, 2000);
  });
  $("pagination-max-pages").addEventListener("change", (e) => {
    clampNumberInput(e.target, 1, 20);
  });

  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const url = btn.dataset.url;
      $("url-input").value = url;
      openTarget(url);
    });
  });

  // 초기 게이트: ToS/robots 확인 전엔 추출·수집 비활성
  updateGate();
  $("tos-check").addEventListener("change", (e) => {
    consent.tos = e.target.checked;
    pushConsent();
    updateGate();
  });
  $("robots-ack").addEventListener("click", () => {
    consent.ack = true;
    renderRobotsBanner();
    pushConsent();
    updateGate();
    setStatus("robots 상태 확인됨 — 계속 진행");
  });

  // 대상 webview가 보고하는 robots.txt 판정 → ① 배너 갱신
  listen("uc-robots", (event) => {
    const p = event.payload || {};
    // origin이 바뀌면 consent 초기화(오리진 스코프, 재확인 강제)
    if (p.origin !== consent.origin) {
      consent.origin = p.origin;
      consent.ack = false;
      consent.tos = $("tos-check").checked; // 체크 유지 시 반영
    }
    consent.robots = p.status;
    $("consent-area").hidden = false;
    renderRobotsBanner();
    pushConsent();
    updateGate();
  });

  $("run-auto").addEventListener("click", runAutoCollect);
  $("run-extract").addEventListener("click", runExtract);
  $("run-collect").addEventListener("click", runCollect);
  $("export-csv").addEventListener("click", () => exportFile("csv"));
  $("export-json").addEventListener("click", () => exportFile("json"));

  // Layer2 브리지: 대상 WebView의 picker.js → on_pick → 'uc-pick' 이벤트
  listen("uc-pick", (event) => {
    const p = event.payload || {};
    $("r-selector").textContent = p.selector || "—";
    $("r-count").textContent = (p.count ?? "—") + (p.count != null ? " 개" : "");
    $("r-samples").textContent = p.sampleCount ?? "—";
    $("r-text").textContent = p.sampleText || "—";
    setStatus("셀렉터 집힘 · " + (p.count ?? 0) + "개 매칭");
    // 자동 발견된 컬럼이 있으면 ③에 자동 채우고 샘플 미리보기 표시(초보자 친화).
    if (Array.isArray(p.fields) && p.fields.length) applyAutoFields(p.fields);
    applyAutoPagination(p.pagination);
  });

  // 추출 결과(collect_rows → 'uc-rows') → 누적 개수·미리보기·진행률 갱신
  listen("uc-rows", (event) => {
    const payload = event.payload || {};
    if (payload.preview) renderPreview(payload);
    if (payload.job) {
      if (payload.done) {
        $("progress").textContent = "✅ 수집 완료 · 누적 " + (payload.count ?? $("row-count").textContent) + "행";
        setStatus("수집 완료");
      } else {
        $("progress").textContent =
          "수집 중 · " + (payload.page ?? "?") + "/" + (payload.max ?? "?") + "페이지 · 누적 " + (payload.count ?? 0) + "행";
        setStatus("수집 중 " + (payload.page ?? "?") + "/" + (payload.max ?? "?"));
      }
    } else {
      setStatus("추출 완료 · " + (payload.count ?? 0) + "행");
    }
  });

  // 필드 집기 결과(on_field_pick → 'uc-field-pick') → 해당 필드 행 자동 채움
  listen("uc-field-pick", (event) => {
    const p = event.payload || {};
    const row = document.querySelector(`.field-row[data-field-index="${p.fieldIndex}"]`);
    if (!row) return;
    if (p.selector) row.querySelector(".field-selector").value = p.selector;
    // 이름이 비어 있으면 셀렉터에서 자동 추정
    const nameInput = row.querySelector(".field-name");
    if (!nameInput.value.trim()) nameInput.value = guessFieldName(p.selector);
    const attrSel = row.querySelector(".field-attr");
    if (p.attr && ["text", "href", "src"].includes(p.attr)) {
      attrSel.value = p.attr;
      attrSel.dispatchEvent(new Event("change"));
    }
    const preview = row.querySelector(".field-preview");
    if (preview) {
      preview.textContent = p.sampleText ? "“" + p.sampleText + "”" : "(빈 값)";
      preview.classList.add("picked");
    }
    setStatus("필드 #" + p.fieldIndex + " 집힘");
  });
});
