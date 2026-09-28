const SECTION_FOLDER = /^(.+)_([xyz])-Section$/i;
const CASE_LABELS = ["A", "B", "C", "D"];
const SLOT_COUNT = 4;

// --- state -----------------------------------------------------------

const state = {
  resultsRootName: null,
  availableCases: [], // [{ name, handle }] — quick-scanned subfolders of the results root
  cases: [null, null, null, null], // each: { name, sections, extraFolders, handle } | null
  // one view state per case slot (not per "panel" — a loaded case IS a panel now)
  view: Array.from({ length: SLOT_COUNT }, () => ({
    field: "",
    axis: "x",
    frameIndex: -1, // index into the current section's frames; -1 = none/unavailable
    linked: false,
    zoom: 1,
  })),
  // shared target for linked slots: an axis + frame index (not a physical
  // position — we no longer read any meaning out of filenames).
  link: { axis: "x", index: -1 },
  focusedSlot: 0, // which slot the left/right arrow keys act on
  fullViewSlot: null,
  zoomLinked: false,
};

const ROOT_DB = "homo-cfd-settings";
const ROOT_STORE = "folders";
const TABLE_COLUMN_PREFS_KEY = "homo-cfd-coefficient-table-columns-v1";

function openSettingsDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ROOT_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(ROOT_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveResultsRoot(handle) {
  const db = await openSettingsDb();
  await new Promise((resolve, reject) => {
    const request = db.transaction(ROOT_STORE, "readwrite").objectStore(ROOT_STORE).put(handle, "resultsRoot");
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  db.close();
}

async function getSavedResultsRoot() {
  const db = await openSettingsDb();
  const handle = await new Promise((resolve, reject) => {
    const request = db.transaction(ROOT_STORE, "readonly").objectStore(ROOT_STORE).get("resultsRoot");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return handle;
}

// --- parsing / scanning (pure, DOM-free where possible) --------------

async function framesFromDir(dir) {
  const frames = [];
  for await (const child of dir.values()) {
    if (child.kind !== "file") continue;
    if (!/\.(png|jpe?g|webp)$/i.test(child.name)) continue;
    const file = await child.getFile();
    frames.push({ name: child.name, url: URL.createObjectURL(file) });
  }
  // No meaning is read out of the filename (no mm/position parsing) — just
  // a stable, human-sane order to step through with prev/next/arrow keys.
  frames.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return frames;
}

// Cheap check used while scanning a results root: is this a case folder
// (contains at least one Field_axis-Section subfolder), without reading
// any images yet. Full scanCaseFolder only runs once a case is actually
// assigned to a slot.
async function looksLikeCaseFolder(dirHandle) {
  for await (const child of dirHandle.values()) {
    if (child.kind === "directory" && SECTION_FOLDER.test(child.name)) return true;
  }
  return false;
}

async function scanCaseFolder(root) {
  const sections = [];
  const extraFolders = [];
  let coefficients = null;
  for await (const child of root.values()) {
    if (child.kind !== "directory") continue;
    const match = child.name.match(SECTION_FOLDER);
    if (!match) {
      extraFolders.push(child.name);
      if (/^plots$/i.test(child.name)) coefficients = await findCoefficients(child);
      continue;
    }
    sections.push({
      field: match[1],
      axis: match[2].toLowerCase(),
      folderName: child.name,
      frames: await framesFromDir(child),
    });
  }
  sections.sort((a, b) => `${a.field}-${a.axis}`.localeCompare(`${b.field}-${b.axis}`));
  extraFolders.sort();
  return { name: root.name, sections, extraFolders, coefficients, handle: root };
}

// --- coefficients summary (from <case>/plots/Coefficients*.csv) ---------

// Column order/labels match the CFD-Tool home screen table exactly,
// including its inconsistent abbreviation of "CzA MO" vs "CxA Mono".
const COEFF_COLUMNS = [
  "CzA Front(%)",
  "CzA",
  "CzA FW",
  "CzA UT",
  "CzA RW",
  "CzA MO",
  "CzA Rem",
  "CxA",
  "CxA FW",
  "CxA UT",
  "CxA RW",
  "CxA Mono",
  "CxA Rem",
];

function classifyHeader(header) {
  const lower = header.toLowerCase();
  const isCz = lower.startsWith("cza");
  const isCx = lower.startsWith("cxa");
  if (!isCz && !isCx) return null;
  if (isCz && lower.includes("front (percentage)")) return "CzA Front(%)";
  if (isCz && lower.includes("frontwing")) return "CzA FW";
  if (isCz && lower.includes("undertray")) return "CzA UT";
  if (isCz && lower.includes("rearwing")) return "CzA RW";
  if (isCz && lower.includes("mono")) return "CzA MO";
  if (isCz && lower.includes("remaining")) return "CzA Rem";
  if (isCz) return "CzA";
  if (isCx && lower.includes("frontwing")) return "CxA FW";
  if (isCx && lower.includes("undertray")) return "CxA UT";
  if (isCx && lower.includes("rearwing")) return "CxA RW";
  if (isCx && lower.includes("mono")) return "CxA Mono";
  if (isCx && lower.includes("remaining")) return "CxA Rem";
  if (isCx) return "CxA";
  return null;
}

// Quote-aware CSV split — good enough for this monitor-export format
// (quoted header cells, plain numeric data cells).
function splitCsvLine(line) {
  return line
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((cell) => cell.trim().replace(/^"|"$/g, ""));
}

// The CSV is a per-iteration convergence history; the summary table only
// wants the final (most-converged) row, matching what CFD-Tool's home
// screen shows per case.
function coefficientsFromCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  const lastRow = splitCsvLine(lines[lines.length - 1]);
  const values = {};
  header.forEach((h, i) => {
    const label = classifyHeader(h);
    if (label) values[label] = Number(lastRow[i]);
  });
  return values;
}

async function findCoefficients(plotsDir) {
  for await (const file of plotsDir.values()) {
    if (file.kind === "file" && /^coefficients.*\.csv$/i.test(file.name)) {
      try {
        const f = await file.getFile();
        return coefficientsFromCsv(await f.text());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function uniqueFields(cfdCase) {
  if (!cfdCase) return [];
  return [...new Set(cfdCase.sections.map((s) => s.field))].sort();
}

function axesForField(cfdCase, field) {
  if (!cfdCase) return [];
  return cfdCase.sections.filter((s) => s.field === field).map((s) => s.axis);
}

function findSection(cfdCase, field, axis) {
  if (!cfdCase) return undefined;
  return cfdCase.sections.find((s) => s.field === field && s.axis === axis);
}

// --- slot helpers --------------------------------------------------------

function slotSection(index) {
  return findSection(state.cases[index], state.view[index].field, state.view[index].axis);
}

function slotFrame(index) {
  const section = slotSection(index);
  const view = state.view[index];
  if (!section || view.frameIndex < 0) return undefined;
  return section.frames[view.frameIndex];
}

function loadedSlots() {
  const out = [];
  for (let i = 0; i < SLOT_COUNT; i++) if (state.cases[i]) out.push(i);
  return out;
}

// Called when a slot's case or field changes (not a direct axis/frame
// step): picks a sane default frame (the first one), or, if the slot is
// linked, pulls from the current link target instead so it stays in sync
// with the rest of its group.
function resetSlotFrame(index) {
  const view = state.view[index];
  if (view.linked) {
    syncSlotToLink(index);
    return;
  }
  const section = slotSection(index);
  view.frameIndex = section && section.frames.length ? 0 : -1;
}

function syncSlotToLink(index) {
  const view = state.view[index];
  view.axis = state.link.axis;
  const section = slotSection(index);
  view.frameIndex =
    section && state.link.index >= 0 && state.link.index < section.frames.length
      ? state.link.index
      : -1;
}

// Called when a linked slot's own axis/frame control is used directly:
// this slot becomes the new source of truth for every linked slot.
function broadcastLink(fromIndex) {
  const view = state.view[fromIndex];
  state.link.axis = view.axis;
  state.link.index = view.frameIndex;
  for (const i of loadedSlots()) {
    if (i !== fromIndex && state.view[i].linked) syncSlotToLink(i);
  }
}

async function loadCaseIntoSlot(index, dirHandle) {
  const scanned = await scanCaseFolder(dirHandle);
  state.cases[index] = scanned;
  const view = state.view[index];
  view.linked = false; // start each newly (re)loaded case unlinked to avoid surprises
  const fields = uniqueFields(scanned);
  view.field = fields[0] ?? "";
  const axes = axesForField(scanned, view.field);
  view.axis = axes[0] ?? "x";
  resetSlotFrame(index);
  if (!loadedSlots().includes(state.focusedSlot)) state.focusedSlot = index;
}

function clearSlot(index) {
  state.cases[index] = null;
  state.view[index] = { field: "", axis: "x", frameIndex: -1, linked: false };
  if (state.focusedSlot === index) {
    const remaining = loadedSlots();
    state.focusedSlot = remaining.length ? remaining[0] : 0;
  }
}

// --- rendering ---------------------------------------------------------

const el = {
  error: document.getElementById("error"),
  caseSlots: document.getElementById("case-slots"),
  summary: document.getElementById("summary"),
  panels: document.getElementById("panels"),
  fullView: document.getElementById("full-view"),
};

function showError(message) {
  el.error.hidden = !message;
  el.error.textContent = message || "";
}

function chip(label, active, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = active ? "active" : "";
  button.addEventListener("click", onClick);
  return button;
}

function renderCaseSlots() {
  const rows = [];

  const rootRow = document.createElement("div");
  rootRow.className = "results-root";
  const rootBtn = document.createElement("button");
  rootBtn.type = "button";
  rootBtn.className = "primary small";
  rootBtn.textContent = state.resultsRootName ? "Change results folder" : "Open results folder";
  rootBtn.addEventListener("click", openResultsRoot);
  rootRow.appendChild(rootBtn);
  if (state.resultsRootName) {
    const info = document.createElement("p");
    info.className = "hint";
    info.textContent = `${state.resultsRootName} · ${state.availableCases.length} case${state.availableCases.length === 1 ? "" : "s"} found`;
    rootRow.appendChild(info);
  }
  rows.push(rootRow);

  state.cases.forEach((cfdCase, index) => {
    const row = document.createElement("div");
    row.className = "case-slot";

    const topLine = document.createElement("div");
    topLine.className = "case-slot-row";
    const label = document.createElement("span");
    label.className = "case-slot-label";
    label.textContent = `Case ${CASE_LABELS[index]}`;
    topLine.appendChild(label);
    row.appendChild(topLine);

    const controlsLine = document.createElement("div");
    controlsLine.className = "case-slot-row";

    if (state.availableCases.length) {
      const select = document.createElement("select");
      const noneOpt = document.createElement("option");
      noneOpt.value = "-1";
      noneOpt.textContent = "— none —";
      select.appendChild(noneOpt);
      state.availableCases.forEach((c, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = c.name;
        select.appendChild(opt);
      });
      const matchIdx = cfdCase
        ? state.availableCases.findIndex((c) => c.handle === cfdCase.handle)
        : -1;
      select.value = String(matchIdx);
      select.addEventListener("change", async () => {
        const i = Number(select.value);
        if (i < 0) {
          clearSlot(index);
          render();
          return;
        }
        await loadCaseIntoSlot(index, state.availableCases[i].handle);
        render();
      });
      controlsLine.appendChild(select);

      const browseBtn = document.createElement("button");
      browseBtn.type = "button";
      browseBtn.className = "primary small";
      browseBtn.textContent = "Browse…";
      browseBtn.addEventListener("click", () => openCaseIntoSlot(index));
      controlsLine.appendChild(browseBtn);
    } else {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "primary small";
      openBtn.textContent = cfdCase ? "Replace" : "Open";
      openBtn.addEventListener("click", () => openCaseIntoSlot(index));
      controlsLine.appendChild(openBtn);
    }
    row.appendChild(controlsLine);

    const meta = document.createElement("p");
    meta.className = "hint";
    meta.textContent = cfdCase
      ? `${cfdCase.name} · ${cfdCase.sections.length} section folders`
      : "Not loaded";
    row.appendChild(meta);

    rows.push(row);
  });

  el.caseSlots.replaceChildren(...rows);
}

function renderPanel(index) {
  const cfdCase = state.cases[index];
  const view = state.view[index];

  const card = document.createElement("div");
  card.className = "panel" + (index === state.focusedSlot ? " focused" : "");
  // Click-to-focus: this slot becomes the target of left/right arrow keys.
  card.addEventListener("click", () => {
    if (state.focusedSlot !== index) {
      state.focusedSlot = index;
      render();
    }
  });

  const header = document.createElement("div");
  header.className = "panel-header";

  const title = document.createElement("span");
  title.className = "panel-title";
  title.textContent = `Case ${CASE_LABELS[index]} — ${cfdCase.name}`;

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "small-control";
  expandBtn.textContent = "Full view";
  expandBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.fullViewSlot = index;
    render();
  });

  const linkLabel = document.createElement("label");
  linkLabel.className = "link-toggle";
  const linkCheckbox = document.createElement("input");
  linkCheckbox.type = "checkbox";
  linkCheckbox.checked = view.linked;
  linkCheckbox.addEventListener("click", (e) => e.stopPropagation());
  linkCheckbox.addEventListener("change", () => {
    view.linked = linkCheckbox.checked;
    if (view.linked) {
      // First slot to link seeds the shared target; later slots adopt it.
      if (state.link.index === -1) broadcastLink(index);
      else syncSlotToLink(index);
    }
    render();
  });
  linkLabel.append(linkCheckbox, document.createTextNode(" Link"));

  header.append(title, expandBtn, linkLabel);
  card.appendChild(header);

  // field: dropdown, not chips — a case can have a dozen+ fields
  // (Cp, CpT, Velocity, Mesh, TKE, every *-Residual…)
  const fields = uniqueFields(cfdCase);
  const controlsRow = document.createElement("div");
  controlsRow.className = "controls-row";

  const fieldSelect = document.createElement("select");
  fields.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    if (f === view.field) opt.selected = true;
    fieldSelect.appendChild(opt);
  });
  fieldSelect.addEventListener("click", (e) => e.stopPropagation());
  fieldSelect.addEventListener("change", () => {
    view.field = fieldSelect.value;
    const axes = axesForField(cfdCase, view.field);
    if (!axes.includes(view.axis)) view.axis = axes[0] ?? "x";
    // Field is independent even when linked: re-resolve against the
    // group's existing axis/index (resetSlotFrame pulls from the link).
    resetSlotFrame(index);
    render();
  });
  controlsRow.appendChild(fieldSelect);

  // axis: still chips, only ever X / Y / Z
  const axes = axesForField(cfdCase, view.field);
  const axisRow = document.createElement("div");
  axisRow.className = "choices small";
  axisRow.append(
    ...axes.map((a) =>
      chip(a.toUpperCase(), a === view.axis, (e) => {
        e.stopPropagation();
        // Axis is a direct user action: this slot becomes the source of
        // truth for the link group (do NOT pull from the link first).
        view.axis = a;
        const section = slotSection(index);
        view.frameIndex = section && section.frames.length ? 0 : -1;
        if (view.linked) broadcastLink(index);
        render();
      }),
    ),
  );
  controlsRow.appendChild(axisRow);
  card.appendChild(controlsRow);

  // Frame navigation is keyboard-only; the filename caption identifies the image.
  const section = slotSection(index);
  const frames = section?.frames ?? [];

  // image stage — sized to shrink, never to crop (object-fit: contain).
  const stage = document.createElement("div");
  stage.className = "stage";
  const frame = slotFrame(index);
  if (frame) {
    const img = document.createElement("img");
    img.src = frame.url;
    img.alt = frame.name;
    img.style.transform = `scale(${view.zoom ?? 1})`;
    stage.appendChild(img);
  } else {
    const msg = document.createElement("div");
    msg.className = "empty";
    if (!view.field) {
      msg.textContent = "This case has no section folders yet.";
    } else if (view.linked && !axesForField(cfdCase, view.field).includes(state.link.axis)) {
      msg.textContent = `Section unavailable: ${view.field} has no ${state.link.axis.toUpperCase()} sections for this case.`;
    } else if (view.linked) {
      msg.textContent = `Section unavailable: this case's ${view.field} ${state.link.axis.toUpperCase()} folder only has ${frames.length} frame${frames.length === 1 ? "" : "s"}.`;
    } else {
      msg.textContent = "No frames in this field/axis.";
    }
    stage.appendChild(msg);
  }
  card.appendChild(stage);

  if (frame) {
    const caption = document.createElement("div");
    caption.className = "caption";
    caption.textContent = frame.name;
    card.appendChild(caption);
  }

  const zoomRow = document.createElement("div");
  zoomRow.className = "zoom-row";
  const zoomOut = document.createElement("button");
  zoomOut.type = "button";
  zoomOut.className = "small-control";
  zoomOut.textContent = "−";
  zoomOut.title = "Zoom out";
  zoomOut.addEventListener("click", (e) => {
    e.stopPropagation();
    setZoom(index, (view.zoom ?? 1) / 1.2);
  });
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "zoom-label";
  zoomLabel.textContent = `${Math.round((view.zoom ?? 1) * 100)}%`;
  const zoomIn = document.createElement("button");
  zoomIn.type = "button";
  zoomIn.className = "small-control";
  zoomIn.textContent = "+";
  zoomIn.title = "Zoom in";
  zoomIn.addEventListener("click", (e) => {
    e.stopPropagation();
    setZoom(index, (view.zoom ?? 1) * 1.2);
  });
  const zoomReset = document.createElement("button");
  zoomReset.type = "button";
  zoomReset.className = "small-control";
  zoomReset.textContent = "Reset";
  zoomReset.addEventListener("click", (e) => {
    e.stopPropagation();
    setZoom(index, 1);
  });
  const zoomLink = document.createElement("label");
  zoomLink.className = "link-toggle";
  const zoomCheckbox = document.createElement("input");
  zoomCheckbox.type = "checkbox";
  zoomCheckbox.checked = state.zoomLinked;
  zoomCheckbox.addEventListener("click", (e) => e.stopPropagation());
  zoomCheckbox.addEventListener("change", () => {
    state.zoomLinked = zoomCheckbox.checked;
    if (state.zoomLinked) {
      const zoom = view.zoom ?? 1;
      loadedSlots().forEach((slot) => { state.view[slot].zoom = zoom; });
    }
    render();
  });
  zoomLink.append(zoomCheckbox, document.createTextNode(" Sync zoom"));
  zoomRow.append(zoomOut, zoomLabel, zoomIn, zoomReset, zoomLink);
  card.appendChild(zoomRow);

  return card;
}

function setZoom(index, zoom) {
  const boundedZoom = Math.max(0.5, Math.min(4, zoom));
  if (state.zoomLinked) loadedSlots().forEach((slot) => { state.view[slot].zoom = boundedZoom; });
  else state.view[index].zoom = boundedZoom;
  render();
}

function stepSlot(index, delta) {
  const view = state.view[index];
  const section = slotSection(index);
  const frames = section?.frames ?? [];
  if (!frames.length || view.frameIndex < 0) return;
  const next = view.frameIndex + delta;
  if (next < 0 || next >= frames.length) return;
  view.frameIndex = next;
  if (view.linked) broadcastLink(index);
  render();
}

function cell(tag, text) {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}

function renderSummary() {
  const slots = loadedSlots();
  if (!slots.length) {
    el.summary.hidden = true;
    el.summary.replaceChildren();
    return;
  }
  el.summary.hidden = false;

  const table = document.createElement("table");
  table.className = "summary-table";

  const headRow = document.createElement("tr");
  headRow.appendChild(cell("th", "Case"));
  COEFF_COLUMNS.forEach((c) => headRow.appendChild(cell("th", c)));
  const thead = document.createElement("thead");
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  slots.forEach((i) => {
    const c = state.cases[i];
    const row = document.createElement("tr");
    row.appendChild(cell("td", `${CASE_LABELS[i]} — ${c.name}`));
    COEFF_COLUMNS.forEach((col) => {
      const v = c.coefficients?.[col];
      row.appendChild(cell("td", v == null || Number.isNaN(v) ? "—" : v.toFixed(3)));
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  el.summary.replaceChildren(table);
}

function render() {
  renderCaseSlots();
  renderSummary();
  renderFullView();

  const slots = loadedSlots();
  if (!slots.length) {
    el.panels.style.gridTemplateColumns = "1fr";
    el.panels.style.gridTemplateRows = "1fr";
    const empty = document.createElement("div");
    empty.className = "panel-empty standalone";
    empty.textContent = "Open a results folder and load a case to begin.";
    el.panels.replaceChildren(empty);
    return;
  }

  el.panels.style.gridTemplateColumns = "minmax(0, 1fr)";
  el.panels.style.gridTemplateRows = `repeat(${slots.length}, minmax(70vh, auto))`;
  el.panels.replaceChildren(...slots.map((i) => renderPanel(i)));
}

function renderFullView() {
  if (state.fullViewSlot == null || !state.cases[state.fullViewSlot]) {
    el.fullView.hidden = true;
    el.fullView.replaceChildren();
    return;
  }
  const slot = state.fullViewSlot;
  el.fullView.hidden = false;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "small-control close-view";
  close.textContent = "Close full view";
  close.addEventListener("click", () => {
    state.fullViewSlot = null;
    render();
  });
  const panel = renderPanel(slot);
  panel.classList.add("full-panel");
  el.fullView.replaceChildren(close, panel);
}

// --- keyboard navigation -------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.fullViewSlot != null) {
    state.fullViewSlot = null;
    render();
    return;
  }
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const target = e.target;
  if (target && (target.tagName === "SELECT" || target.tagName === "INPUT")) return;
  if (!state.cases[state.focusedSlot]) return;
  e.preventDefault();
  stepSlot(state.focusedSlot, e.key === "ArrowRight" ? 1 : -1);
});

// --- opening folders -----------------------------------------------------

// Opens one parent folder (e.g. the "finished" folder from CFD-Tool) and
// lists every immediate subfolder that looks like a case, so cases can be
// picked from a dropdown afterwards instead of running the OS folder
// picker again for every single case.
async function openResultsRoot() {
  showError("");
  if (!window.showDirectoryPicker) {
    showError("This browser cannot open a local folder. Use Chrome or Edge.");
    return;
  }
  try {
    const rootHandle = await window.showDirectoryPicker({ mode: "read" });
    await saveResultsRoot(rootHandle);
    await scanResultsRoot(rootHandle);
  } catch (err) {
    if (err?.name === "AbortError") return;
    showError(err?.message || "Could not open results folder");
  }
}

async function findCoefficientsForCase(caseHandle) {
  try {
    const plots = await caseHandle.getDirectoryHandle("plots");
    return await findCoefficients(plots);
  } catch {
    return null;
  }
}

async function restoreResultsRoot() {
  try {
    if (!window.showDirectoryPicker || !window.indexedDB) return;
    const rootHandle = await getSavedResultsRoot();
    if (!rootHandle) return;
    if (await rootHandle.queryPermission({ mode: "read" }) !== "granted") {
      showError(`Previously used folder “${rootHandle.name}” needs access. Choose it once with Open results folder to reconnect.`);
      return;
    }
    await scanResultsRoot(rootHandle);
  } catch (err) {
    showError(err?.message || "Could not restore the remembered results folder");
  }
}

async function scanResultsRoot(rootHandle) {
  const found = [];
  for await (const child of rootHandle.values()) {
    if (child.kind !== "directory" || !(await looksLikeCaseFolder(child))) continue;
    found.push({ name: child.name, handle: child, coefficients: await findCoefficientsForCase(child) });
  }
  found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!found.length) {
    showError("No case folders found directly inside that folder. Pick the folder that holds all your cases.");
    return;
  }
  state.resultsRootName = rootHandle.name;
  state.availableCases = found;
  await loadCaseIntoSlot(0, found[0].handle);
  render();
}

async function openCaseIntoSlot(index) {
  showError("");
  if (!window.showDirectoryPicker) {
    showError("This browser cannot open a local folder. Use Chrome or Edge.");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "read" });
    if (!(await looksLikeCaseFolder(handle))) {
      showError(
        "No folders matching Field_x-Section were found. Pick the postprocessing result directory for one case.",
      );
    }
    await loadCaseIntoSlot(index, handle);
    render();
  } catch (err) {
    if (err?.name === "AbortError") return;
    showError(err?.message || "Could not open folder");
  }
}

// --- filesystem and CSV workspace ------------------------------------

const browserState = {
  root: null,
  selectedFolder: null,
  selectedFile: null,
  csvCache: new WeakMap(),
  query: "",
  renderToken: 0,
  activeFiles: [],
  activeTitle: "",
  tableQuery: "",
  tablePage: 0,
  expandedCsv: new Set(),
  columnHeaders: [],
  coefficientRows: [],
};

async function buildFolderNode(handle, path = "", isSection = false) {
  const node = { name: handle.name, path, handle, isSection, folders: [], files: [], csvFiles: [] };
  if (isSection) {
    for await (const child of handle.values()) {
      if (child.kind !== "file" || !/\.csv$/i.test(child.name)) continue;
      const file = { name: child.name, path: path ? `${path}/${child.name}` : child.name, handle: child };
      node.files.push(file);
      node.csvFiles.push(file);
    }
    return node;
  }
  for await (const child of handle.values()) {
    if (child.kind === "file") {
      if (/\.csv$/i.test(child.name)) {
        const file = { name: child.name, path: path ? `${path}/${child.name}` : child.name, handle: child };
        node.files.push(file);
        node.csvFiles.push(file);
      }
      continue;
    }
    if (child.kind !== "directory") continue;
    const childPath = path ? `${path}/${child.name}` : child.name;
    const childIsSection = await isImageSectionFolder(child);
    const folder = await buildFolderNode(child, childPath, childIsSection);
    node.folders.push(folder);
    node.csvFiles.push(...folder.csvFiles);
  }
  node.isCase = node.folders.some((folder) => folder.isSection);
  node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  node.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  node.csvFiles.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return node;
}

async function isImageSectionFolder(handle) {
  if (!SECTION_FOLDER.test(handle.name)) return false;
  for await (const child of handle.values()) {
    if (child.kind === "file" && /\.(png|jpe?g|webp)$/i.test(child.name)) return true;
  }
  return false;
}

function renderFilesystemTree() {
  const rows = [];
  if (!browserState.root) {
    el.caseSlots.replaceChildren();
    return;
  }

  const allResults = document.createElement("button");
  allResults.type = "button";
  allResults.className = "tree-entry tree-root" + (!browserState.selectedFolder ? " selected" : "");
  allResults.dataset.path = "";
  allResults.textContent = `${browserState.root.name} · all simulations`;
  allResults.addEventListener("click", () => selectFolder(browserState.root));
  rows.push(allResults);

  for (const folder of browserState.root.folders) {
    const item = renderFolderNode(folder);
    if (item) rows.push(item);
  }
  el.caseSlots.replaceChildren(...rows);
}

function folderMatchesQuery(node) {
  if (!browserState.query) return true;
  if (node.name.toLowerCase().includes(browserState.query)) return true;
  return node.folders.some(folderMatchesQuery) ||
    node.files.some((file) => file.name.toLowerCase().includes(browserState.query));
}

function renderFolderNode(node) {
  if (!folderMatchesQuery(node)) return null;
  if (node.isSection) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-entry image-folder";
    button.dataset.path = node.path;
    button.textContent = node.name;
    button.title = `Open ${node.path} in image viewer`;
    button.addEventListener("click", () => openImageFolder(node));
    return button;
  }

  const details = document.createElement("details");
  details.className = "folder-node";
  details.open = Boolean(browserState.query);
  const summary = document.createElement("summary");
  summary.className = "tree-entry" + (browserState.selectedFolder?.path === node.path ? " selected" : "");
  summary.dataset.path = node.path;
  summary.textContent = node.name;
  summary.title = `Show CSV tables in ${node.path}`;
  summary.addEventListener("click", () => selectFolder(node));
  details.appendChild(summary);

  const children = document.createElement("div");
  children.className = "tree-children";
  for (const folder of node.folders) {
    const item = renderFolderNode(folder);
    if (item) children.appendChild(item);
  }
  if (children.childElementCount) details.appendChild(children);
  return details;
}

function renderCsvFileButton(file) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-entry csv-file" + (browserState.selectedFile?.path === file.path ? " selected" : "");
  button.textContent = file.name;
  button.title = `Show ${file.path}`;
  button.addEventListener("click", () => selectCsvFile(file));
  return button;
}

async function selectFolder(node) {
  browserState.selectedFolder = node;
  browserState.selectedFile = null;
  updateTreeSelection();
  await showCsvTables(node.csvFiles, node.path || node.name);
}

async function selectCsvFile(file) {
  browserState.selectedFile = file;
  updateTreeSelection();
  await showCsvTables([file], file.path);
}

function updateTreeSelection() {
  const selectedPath = browserState.selectedFolder?.path ?? null;
  document.querySelectorAll("#case-slots .tree-entry").forEach((entry) => {
    const isRoot = entry.classList.contains("tree-root");
    const isSelected = isRoot
      ? selectedPath === ""
      : entry.tagName === "SUMMARY" && entry.dataset.path === selectedPath;
    entry.classList.toggle("selected", isSelected);
  });
}

async function showCsvTables(files, title) {
  browserState.activeFiles = files;
  browserState.activeTitle = title;
  browserState.tableQuery = "";
  browserState.tablePage = 0;
  browserState.columnHeaders = [];
  browserState.coefficientRows = [];
  renderCsvWorkspaceHeader();
  await renderCsvPage();
}

function renderCsvWorkspaceHeader() {
  el.summary.hidden = false;
  const heading = document.createElement("h1");
  heading.className = "workspace-title";
  heading.textContent = browserState.activeTitle;
  const count = document.createElement("span");
  count.className = "workspace-count table-count";
  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "table-filter";
  filter.placeholder = "Filter simulations";
  filter.setAttribute("aria-label", "Filter simulations");
  filter.addEventListener("input", () => {
    browserState.tableQuery = filter.value.trim().toLowerCase();
    renderCsvPage();
  });
  const customize = document.createElement("button");
  customize.type = "button";
  customize.className = "small-control customize-columns";
  customize.textContent = "Customize columns";
  customize.disabled = !browserState.columnHeaders.length;
  customize.addEventListener("click", () => openColumnDialog());
  el.summary.replaceChildren(heading, count, filter, customize);
  el.panels.replaceChildren(Object.assign(document.createElement("div"), {
    className: "workspace-empty",
    textContent: "Loading coefficient summary…",
  }));
}

async function renderCsvPage() {
  const coefficientFiles = browserState.activeFiles.filter((file) =>
    !browserState.tableQuery || file.path.toLowerCase().includes(browserState.tableQuery),
  ).filter((file) => /^coefficients.*\.csv$/i.test(file.name));
  const token = ++browserState.renderToken;
  const count = el.summary.querySelector(".table-count");
  count.textContent = `${coefficientFiles.length} simulation${coefficientFiles.length === 1 ? "" : "s"}`;
  el.panels.replaceChildren(Object.assign(document.createElement("div"), {
    className: "workspace-empty",
    textContent: coefficientFiles.length ? "Loading coefficient summary…" : "No coefficient summaries in this folder.",
  }));

  const coefficientRows = await Promise.all(coefficientFiles.map(loadCsvTable));
  if (token !== browserState.renderToken) return;
  browserState.coefficientRows = coefficientRows.filter(Boolean);
  renderCsvTables(coefficientRows.filter(Boolean));
}

async function loadCsvTable(file) {
  if (browserState.csvCache.has(file.handle)) return browserState.csvCache.get(file.handle);
  const loading = (async () => {
    const csv = await file.handle.getFile();
    const rows = parseCsv(await csv.text());
    if (!rows.length) return { name: file.name, path: file.path, headers: [], rows: [] };
    const headers = rows.shift().map((value, index) => value || `Column ${index + 1}`);
    if (/^coefficients.*\.csv$/i.test(file.name)) {
      return { name: file.name, path: file.path, headers, rows: rows.length ? [rows[rows.length - 1]] : [] };
    }
    return { name: file.name, path: file.path, headers, rows };
  })();
  browserState.csvCache.set(file.handle, loading);
  try {
    return await loading;
  } catch (err) {
    browserState.csvCache.delete(file.handle);
    return { name: file.name, path: file.path, error: err?.message || "Could not read CSV" };
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(value);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  row.push(value);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

function renderCsvTables(coefficientRows) {
  browserState.columnHeaders = [...new Set(coefficientRows.flatMap((data) => data.headers))];
  const customizeButton = el.summary.querySelector(".customize-columns");
  if (customizeButton) customizeButton.disabled = !browserState.columnHeaders.length;
  if (!coefficientRows.length) {
    const empty = document.createElement("div");
    empty.className = "workspace-empty";
    empty.textContent = "No coefficient summaries in this folder.";
    el.panels.replaceChildren(empty);
    return;
  }

  const collective = document.createElement("section");
  collective.className = "csv-card collective-table-card";
  const heading = document.createElement("h2");
  heading.className = "csv-card-title";
  heading.textContent = "Final iteration by simulation";
  collective.appendChild(heading);

    const headers = orderedColumnDefinitions(browserState.columnHeaders);
    const visibleHeaders = headers.filter((column) => column.visible);
    const tableWrap = document.createElement("div");
    tableWrap.className = "csv-table-wrap";
    const table = document.createElement("table");
    table.className = "data-table";
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headerRow.appendChild(cell("th", "Simulation"));
    visibleHeaders.forEach((column) => headerRow.appendChild(cell("th", column.label)));
    head.appendChild(headerRow);
    table.appendChild(head);

    const body = document.createElement("tbody");
    coefficientRows.forEach((data) => {
      const sourceRow = data.rows[data.rows.length - 1] ?? [];
      const row = document.createElement("tr");
      row.appendChild(cell("td", simulationNameFromCsvPath(data.path)));
      visibleHeaders.forEach((column) => {
        const index = data.headers.indexOf(column.key);
        const value = index < 0 ? "" : sourceRow[index] ?? "";
        row.appendChild(cell("td", formatCoefficientValue(column.key, value)));
      });
      body.appendChild(row);
    });
    table.appendChild(body);
    tableWrap.appendChild(table);
    collective.appendChild(tableWrap);
  el.panels.replaceChildren(collective);
}

function readColumnPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(TABLE_COLUMN_PREFS_KEY) || "{}");
    return {
      order: Array.isArray(saved.order) ? saved.order : [],
      hidden: Array.isArray(saved.hidden) ? saved.hidden : [],
      labels: saved.labels && typeof saved.labels === "object" ? saved.labels : {},
    };
  } catch {
    return { order: [], hidden: [], labels: {} };
  }
}

function defaultColumnLabels(headers) {
  const proposed = headers.map((header) => classifyHeader(header) || header);
  const counts = new Map();
  proposed.forEach((label) => counts.set(label, (counts.get(label) || 0) + 1));
  return Object.fromEntries(headers.map((header, index) => [
    header,
    counts.get(proposed[index]) === 1 ? proposed[index] : header,
  ]));
}

function orderedColumnDefinitions(headers) {
  const preferences = readColumnPreferences();
  const savedOrder = preferences.order.filter((header) => headers.includes(header));
  const order = [...savedOrder, ...headers.filter((header) => !savedOrder.includes(header))];
  const defaultLabels = defaultColumnLabels(headers);
  return order.map((key) => ({
    key,
    label: preferences.labels[key] ?? defaultLabels[key],
    visible: !preferences.hidden.includes(key),
  }));
}

function openColumnDialog() {
  if (!browserState.columnHeaders.length) return;
  const columns = orderedColumnDefinitions(browserState.columnHeaders);
  const dialog = document.getElementById("column-dialog");
  const editor = document.getElementById("column-editor");

  const renderEditor = () => {
    editor.replaceChildren(...columns.map((column, index) => {
      const row = document.createElement("div");
      row.className = "column-config-row";
      const visibility = document.createElement("input");
      visibility.type = "checkbox";
      visibility.checked = column.visible;
      visibility.setAttribute("aria-label", `Show ${column.label}`);
      visibility.addEventListener("change", () => { column.visible = visibility.checked; });
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.value = column.label;
      labelInput.setAttribute("aria-label", `Display name for ${column.key}`);
      labelInput.addEventListener("input", () => { column.label = labelInput.value; });
      const moveUp = document.createElement("button");
      moveUp.type = "button";
      moveUp.className = "small-control column-move";
      moveUp.textContent = "↑";
      moveUp.title = "Move column left";
      moveUp.setAttribute("aria-label", `Move ${column.label} left`);
      moveUp.disabled = index === 0;
      moveUp.addEventListener("click", () => {
        [columns[index - 1], columns[index]] = [columns[index], columns[index - 1]];
        renderEditor();
      });
      const moveDown = document.createElement("button");
      moveDown.type = "button";
      moveDown.className = "small-control column-move";
      moveDown.textContent = "↓";
      moveDown.title = "Move column right";
      moveDown.setAttribute("aria-label", `Move ${column.label} right`);
      moveDown.disabled = index === columns.length - 1;
      moveDown.addEventListener("click", () => {
        [columns[index], columns[index + 1]] = [columns[index + 1], columns[index]];
        renderEditor();
      });
      row.append(visibility, labelInput, moveUp, moveDown);
      return row;
    }));
  };

  renderEditor();
  dialog.showModal();
  document.getElementById("column-cancel").onclick = () => dialog.close();
  document.getElementById("column-reset").onclick = () => {
    localStorage.removeItem(TABLE_COLUMN_PREFS_KEY);
    dialog.close();
    renderCsvTables(browserState.coefficientRows);
  };
  document.getElementById("column-save").onclick = () => {
    const labels = {};
    columns.forEach((column) => { labels[column.key] = column.label.trim() || column.key; });
    localStorage.setItem(TABLE_COLUMN_PREFS_KEY, JSON.stringify({
      order: columns.map((column) => column.key),
      hidden: columns.filter((column) => !column.visible).map((column) => column.key),
      labels,
    }));
    dialog.close();
    renderCsvTables(browserState.coefficientRows);
  };
}

function formatCoefficientValue(header, rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) return value;
  const numeric = Number(value);
  if (/^iteration$/i.test(header)) return Number.isFinite(numeric) ? String(numeric) : value;
  return Number.isFinite(numeric) ? numeric.toFixed(3) : value;
}

function simulationNameFromCsvPath(path) {
  const parts = path.split("/");
  const plotsIndex = parts.findIndex((part) => /^plots$/i.test(part));
  if (plotsIndex > 0) return parts[plotsIndex - 1];
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
}

async function saveViewerHandle(key, handle, path) {
  const db = await openSettingsDb();
  await new Promise((resolve, reject) => {
    const store = db.transaction(ROOT_STORE, "readwrite").objectStore(ROOT_STORE);
    store.put(handle, `viewer:${key}`);
    const request = store.put(path, `viewer-path:${key}`);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  db.close();
}

async function saveViewerSet(key, nodes, catalog) {
  const db = await openSettingsDb();
  await new Promise((resolve, reject) => {
    const store = db.transaction(ROOT_STORE, "readwrite").objectStore(ROOT_STORE);
    store.put(nodes.map((node) => ({ handle: node.handle, path: node.path })), `viewer-set:${key}`);
    const request = store.put(catalog.map((node) => ({ handle: node.handle, path: node.path })), `viewer-catalog:${key}`);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  db.close();
}

async function openImageFolder(node) {
  const casePath = node.path.slice(0, node.path.lastIndexOf("/"));
  const simulation = findFolderByPath(browserState.root, casePath);
  if (simulation) await openComparisonWindow([simulation], node.path);
}

async function openComparisonWindow(nodes, initialSectionPath = "") {
  const popup = window.open(
    "about:blank",
    `homo-cfd-compare-${crypto.randomUUID()}`,
    `popup,width=${screen.availWidth},height=${screen.availHeight},left=0,top=0`,
  );
  if (!popup) {
    showError("The comparison window was blocked. Allow pop-ups for this local app and try again.");
    return;
  }
  const key = crypto.randomUUID();
  try {
    const catalog = browserState.root?.folders.filter((folder) => folder.isCase) ?? nodes;
    await saveViewerSet(key, nodes, catalog);
    popup.location.href = `./image-viewer.html?compare=${encodeURIComponent(key)}${initialSectionPath ? `&section=${encodeURIComponent(initialSectionPath)}` : ""}`;
  } catch (err) {
    popup.close();
    showError(err?.message || "Could not open the comparison window");
  }
}

async function loadResultsRoot(handle) {
  el.summary.hidden = true;
  el.panels.replaceChildren(Object.assign(document.createElement("div"), {
    className: "workspace-empty",
    textContent: `Indexing folders in ${handle.name}…`,
  }));
  browserState.root = await buildFolderNode(handle);
  browserState.selectedFolder = null;
  browserState.selectedFile = null;
  renderFilesystemTree();
  await selectFolder(browserState.root);
}

function findFolderByPath(node, path) {
  if (!node) return null;
  if (node.path === path) return node;
  for (const folder of node.folders) {
    const result = findFolderByPath(folder, path);
    if (result) return result;
  }
  return null;
}

async function chooseResultsRoot() {
  showError("");
  if (!window.showDirectoryPicker) {
    showError("This browser cannot open a local folder. Use Chrome or Edge.");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "read" });
    await saveResultsRoot(handle);
    await loadResultsRoot(handle);
  } catch (err) {
    if (err?.name !== "AbortError") showError(err?.message || "Could not open results folder");
  }
}

async function startFilesystemWorkspace() {
  document.getElementById("open-results").addEventListener("click", chooseResultsRoot);
  document.getElementById("folder-search").addEventListener("input", (event) => {
    browserState.query = event.target.value.trim().toLowerCase();
    renderFilesystemTree();
  });
  el.panels.replaceChildren(Object.assign(document.createElement("div"), {
    className: "workspace-empty",
    textContent: "Open a results folder, choose simulations in Case A–D, then open a comparison.",
  }));
  try {
    if (!window.showDirectoryPicker || !window.indexedDB) return;
    const handle = await getSavedResultsRoot();
    if (!handle) return;
    if (await handle.queryPermission({ mode: "read" }) !== "granted") {
      showError(`Previously used folder “${handle.name}” needs access. Choose it once with Open results folder to reconnect.`);
      return;
    }
    await loadResultsRoot(handle);
  } catch (err) {
    showError(err?.message || "Could not restore the remembered results folder");
  }
}

startFilesystemWorkspace();
