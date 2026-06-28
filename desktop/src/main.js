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

function createFieldRow(index) {
  const row = document.createElement("div");
  row.className = "field-row";
  row.dataset.fieldIndex = String(index);

  row.innerHTML = `
    <input class="field-name" placeholder="필드명" value="field_${index}" />
    <input class="field-selector" placeholder="상대 셀렉터 (.text)" />
    <select class="field-attr" aria-label="추출 속성">
      <option value="text">text</option>
      <option value="href">href</option>
      <option value="src">src</option>
      <option value="text_all">text_all</option>
      <option value="attribute">속성</option>
    </select>
    <input class="field-custom-attr" placeholder="속성명" hidden />
    <select class="field-transform" aria-label="변환">
      <option value="none">none</option>
      <option value="to_number">to_number</option>
      <option value="trim">trim</option>
      <option value="word_to_number">word_to_number</option>
    </select>
    <button type="button" class="secondary pick-field" aria-label="필드 집기">집기</button>
    <button type="button" class="danger remove-field" aria-label="필드 삭제">삭제</button>
  `;

  const attr = row.querySelector(".field-attr");
  const customAttr = row.querySelector(".field-custom-attr");
  attr.addEventListener("change", () => {
    customAttr.hidden = attr.value !== "attribute";
    if (!customAttr.hidden) {
      customAttr.focus();
    }
  });

  row.querySelector(".pick-field").addEventListener("click", async () => {
    try {
      await invoke("start_field_pick", { fieldIndex: index });
      setStatus("필드 집기 #" + index + " · 대상 창에서 요소를 클릭하세요");
    } catch (e) {
      $("run-msg").textContent = "⚠ " + e;
    }
  });

  row.querySelector(".remove-field").addEventListener("click", () => {
    row.remove();
    if (!document.querySelector(".field-row")) {
      addFieldRow();
    }
    setStatus("필드 행 삭제됨");
  });

  return row;
}

function addFieldRow(options = {}) {
  const list = $("field-list");
  fieldCounter += 1;
  list.appendChild(createFieldRow(fieldCounter));
  if (!options.silent) {
    setStatus("필드 행 추가됨");
  }
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
  return { row_selector: rowSelector, fields };
}

async function runExtract() {
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

window.addEventListener("DOMContentLoaded", () => {
  addFieldRow({ silent: true });

  $("open-form").addEventListener("submit", (e) => {
    e.preventDefault();
    openTarget($("url-input").value.trim());
  });

  $("add-field").addEventListener("click", addFieldRow);
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

  $("run-extract").addEventListener("click", runExtract);
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
  });

  // 추출 결과(collect_rows → 'uc-rows') → 누적 개수·미리보기 갱신
  listen("uc-rows", (event) => {
    const payload = event.payload || {};
    renderPreview(payload);
    setStatus("추출 완료 · " + (payload.count ?? 0) + "행");
  });

  // 필드 집기 결과(on_field_pick → 'uc-field-pick') → 해당 필드 행 채우기
  listen("uc-field-pick", (event) => {
    const p = event.payload || {};
    const row = document.querySelector(`.field-row[data-field-index="${p.fieldIndex}"]`);
    if (!row) return;
    if (p.selector) row.querySelector(".field-selector").value = p.selector;
    const attrSel = row.querySelector(".field-attr");
    if (p.attr && ["text", "href", "src"].includes(p.attr)) {
      attrSel.value = p.attr;
      attrSel.dispatchEvent(new Event("change"));
    }
    setStatus("필드 #" + p.fieldIndex + " 집힘 · " + (p.selector || ""));
  });
});
