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
  })),
  // shared target for linked slots: an axis + frame index (not a physical
  // position — we no longer read any meaning out of filenames).
  link: { axis: "x", index: -1 },
  focusedSlot: 0, // which slot the left/right arrow keys act on
};

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

  header.append(title, linkLabel);
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

  // frame stepping: prev/next buttons + "Frame N / M" only. No dropdown,
  // no slider, no meaning read out of filenames — left/right arrow keys
  // (while this panel is focused) do the same thing.
  const section = slotSection(index);
  const frames = section?.frames ?? [];
  const posRow = document.createElement("div");
  posRow.className = "position-row";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "step-btn";
  prevBtn.textContent = "◀";
  prevBtn.disabled = view.frameIndex <= 0;
  prevBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stepSlot(index, -1);
  });

  const counter = document.createElement("span");
  counter.className = "hint";
  counter.textContent = frames.length
    ? view.frameIndex >= 0
      ? `Frame ${view.frameIndex + 1} / ${frames.length}`
      : "Unavailable"
    : "No frames";

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "step-btn";
  nextBtn.textContent = "▶";
  nextBtn.disabled = view.frameIndex < 0 || view.frameIndex >= frames.length - 1;
  nextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stepSlot(index, 1);
  });

  posRow.append(prevBtn, counter, nextBtn);
  card.appendChild(posRow);

  // image stage — sized to shrink, never to crop (object-fit: contain).
  const stage = document.createElement("div");
  stage.className = "stage";
  const frame = slotFrame(index);
  if (frame) {
    const img = document.createElement("img");
    img.src = frame.url;
    img.alt = frame.name;
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

  return card;
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

  // Grid grows with how many cases are loaded (1 → full-size single view,
  // up to 4 → 2×2), never showing empty slots.
  const columns = slots.length === 1 ? 1 : 2;
  const rows = Math.ceil(slots.length / columns);
  el.panels.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  el.panels.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  el.panels.replaceChildren(...slots.map((i) => renderPanel(i)));
}

// --- keyboard navigation -------------------------------------------------

document.addEventListener("keydown", (e) => {
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
    const found = [];
    for await (const child of rootHandle.values()) {
      if (child.kind !== "directory") continue;
      if (await looksLikeCaseFolder(child)) found.push({ name: child.name, handle: child });
    }
    found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!found.length) {
      showError(
        "No case folders found directly inside that folder (looked for subfolders that themselves contain Field_x-Section directories). Pick the folder that holds all your cases, e.g. \"finished\".",
      );
      return;
    }
    state.resultsRootName = rootHandle.name;
    state.availableCases = found;
    // Load just the first case by default (single-case view); more panels
    // appear as you assign more cases from the sidebar dropdowns.
    await loadCaseIntoSlot(0, found[0].handle);
    render();
  } catch (err) {
    if (err?.name === "AbortError") return;
    showError(err?.message || "Could not open results folder");
  }
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

render();
