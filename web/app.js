const SECTION_FOLDER = /^(.+)_([xyz])-Section$/i;
const ROOT_DB = "homo-cfd-settings";
const ROOT_STORE = "folders";
const TABLE_COLUMN_PREFS_KEY = "homo-cfd-coefficient-table-columns-v1";
// Speed and air density for the Downforce [N] / Drag [N] columns. 1.18415 kg/m³
// is STAR-CCM+'s default air density; users can change both per browser.
const FORCE_SETTINGS_KEY = "homo-cfd-force-settings-v1";
const DEFAULT_FORCE_SETTINGS = { speedKmh: 60, density: 1.18415 };
// Viewer windows receive their folder handles through IndexedDB entries;
// entries older than this are pruned when the main window starts.
const VIEWER_ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

// Removes viewer hand-off entries (viewer:, viewer-path:, viewer-set:,
// viewer-catalog:, viewer-time:) whose window was opened more than
// VIEWER_ENTRY_MAX_AGE_MS ago, or that predate timestamps.
async function pruneViewerEntries() {
  const db = await openSettingsDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(ROOT_STORE, "readwrite");
    const store = transaction.objectStore(ROOT_STORE);
    const keysRequest = store.getAllKeys();
    keysRequest.onsuccess = () => {
      const keys = keysRequest.result.filter((key) => typeof key === "string" && key.startsWith("viewer"));
      const times = new Map();
      keys.filter((key) => key.startsWith("viewer-time:")).forEach((key) => {
        const timeRequest = store.get(key);
        timeRequest.onsuccess = () => times.set(key.slice("viewer-time:".length), timeRequest.result);
      });
      // Second pass runs after the time reads above complete (same transaction, FIFO).
      store.count().onsuccess = () => {
        const now = Date.now();
        keys.forEach((key) => {
          const id = key.slice(key.indexOf(":") + 1);
          const time = times.get(id);
          if (!Number.isFinite(time) || now - time > VIEWER_ENTRY_MAX_AGE_MS) store.delete(key);
        });
      };
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

// --- coefficient column labels ---------------------------------------------

// Short labels matching the CFD-Tool home screen table, including its
// inconsistent abbreviation of "CzA MO" vs "CxA Mono".
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

// --- shared DOM helpers ------------------------------------------------

const el = {
  error: document.getElementById("error"),
  caseSlots: document.getElementById("case-slots"),
  summary: document.getElementById("summary"),
  panels: document.getElementById("panels"),
  reconnect: document.getElementById("reconnect-results"),
};

function showError(message) {
  el.error.hidden = !message;
  el.error.textContent = message || "";
}

function cell(tag, text) {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}

// --- keyboard navigation -------------------------------------------------

// Left/right arrow keys step pressure-distribution stations while the
// pressure workspace is open. Image stepping lives in the viewer windows.
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (!document.querySelector(".pressure-toolbar")) return;
  const target = e.target;
  const isTextEntry = target?.isContentEditable || target?.tagName === "TEXTAREA" ||
    (target?.tagName === "INPUT" && !["checkbox", "radio"].includes(target.type));
  if (isTextEntry) return;
  stepPressureStation(e.key === "ArrowRight" ? 1 : -1);
  e.preventDefault();
});

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
  monitorChartHeader: "",
  coefficientView: "values",
  forceSettings: readForceSettings(),
  coefficientReferencePath: "",
  pressureCasePath: "",
  pressureComparePaths: [],
  pressureSurface: "FW",
  pressureAxis: "x",
  pressureStationPath: "",
  pressureStationPosition: null,
  pressureSceneField: "Cp",
  pressureShowImages: false,
  pressureImageUrls: [],
  pressureRequestToken: 0,
  pressureAvailability: new WeakMap(),
  pressureStationFiles: [],
  pressureRefresh: null,
};

// Natural order ("2" before "10"); one shared collator is much faster than
// localeCompare for the tens of thousands of names in a large results folder.
const naturalOrder = new Intl.Collator(undefined, { numeric: true });
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

// All entries of a folder as an array: one await per folder instead of one
// per entry (server folders come from the prefetched tree).
async function listChildren(handle) {
  if (typeof handle.children === "function") return handle.children();
  const children = [];
  for await (const child of handle.values()) children.push(child);
  return children;
}

async function buildFolderNode(handle, path = "", isSection = false, sceneImageCount = 0, children = null) {
  const node = { name: handle.name, path, handle, isSection, sceneImageCount, isSceneGallery: sceneImageCount > 0, folders: [], files: [], csvFiles: [] };
  if (node.isSceneGallery) return node;
  const entries = children ?? await listChildren(handle);
  for (const child of entries) {
    if (child.kind !== "file" || !/\.csv$/i.test(child.name)) continue;
    const file = { name: child.name, path: path ? `${path}/${child.name}` : child.name, handle: child };
    node.files.push(file);
    node.csvFiles.push(file);
  }
  if (isSection) return node;
  node.isEnsightFolder = /^3d-data$/i.test(handle.name) && entries.some((child) => child.kind === "file" && /\.case$/i.test(child.name));
  for (const child of entries) {
    // Skip hidden folders such as .git or .vscode; they never hold results.
    if (child.kind !== "directory" || child.name.startsWith(".")) continue;
    const childPath = path ? `${path}/${child.name}` : child.name;
    const grandchildren = await listChildren(child);
    const hasImages = grandchildren.some((entry) => entry.kind === "file" && IMAGE_FILE.test(entry.name));
    const childIsSection = SECTION_FOLDER.test(child.name) && hasImages;
    // Folders named 3D holding images are static scene galleries.
    const sceneImages = !childIsSection && /^3d$/i.test(child.name)
      ? grandchildren.filter((entry) => entry.kind === "file" && IMAGE_FILE.test(entry.name)).length
      : 0;
    const folder = await buildFolderNode(child, childPath, childIsSection, sceneImages, grandchildren);
    node.folders.push(folder);
    node.csvFiles.push(...folder.csvFiles);
  }
  node.isCase = node.folders.some((folder) => folder.isSection);
  node.folders.sort((a, b) => naturalOrder.compare(a.name, b.name));
  node.files.sort((a, b) => naturalOrder.compare(a.name, b.name));
  node.csvFiles.sort((a, b) => naturalOrder.compare(a.path, b.path));
  return node;
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
  if (node.isEnsightFolder) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-entry image-folder ensight-folder";
    button.dataset.path = node.path;
    button.textContent = `${node.name} · 3D viewer`;
    button.title = `Open ${node.path} in the interactive 3D viewer`;
    button.addEventListener("click", () => openEnsightViewer(node));
    return button;
  }
  if (node.isSceneGallery) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-entry image-folder scene-gallery-folder";
    button.dataset.path = node.path;
    button.textContent = `${node.name} · ${node.sceneImageCount} scenes`;
    button.title = `Open ${node.sceneImageCount} static 3D scenes in the image viewer`;
    button.addEventListener("click", () => openSceneGallery(node));
    return button;
  }

  const details = document.createElement("details");
  details.className = "folder-node";
  details.open = Boolean(browserState.query);
  const summary = document.createElement("summary");
  summary.className = "tree-entry" + (browserState.selectedFolder?.path === node.path ? " selected" : "");
  summary.dataset.path = node.path;
  summary.textContent = node.name;
  const pressureGroup = pressureGroupFromNode(node);
  summary.title = pressureGroup ? `Open ${pressureGroup.surface} ${pressureGroup.axis.toUpperCase()} pressure plot` : `Show CSV tables in ${node.path}`;
  summary.addEventListener("click", (event) => {
    if (pressureGroup) {
      event.preventDefault();
      openPressureGroup(node, pressureGroup);
      return;
    }
    selectFolder(node);
  });
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

function pressureGroupFromNode(node) {
  const parts = node.path.split("/");
  const pressureIndex = parts.findIndex((part) => /^PressureDistributions$/i.test(part));
  if (pressureIndex < 0 || pressureIndex !== parts.length - 2) return null;
  const match = parts.at(-1).match(/^pd_(FW|UT|RW)_([xy])-Section$/i);
  return match ? { surface: match[1].toUpperCase(), axis: match[2].toLowerCase(), casePath: parts.slice(0, pressureIndex).join("/") } : null;
}

function openPressureGroup(node, group) {
  browserState.selectedFolder = node;
  browserState.selectedFile = null;
  browserState.pressureCasePath = group.casePath;
  browserState.pressureComparePaths = [group.casePath];
  browserState.pressureSurface = group.surface;
  browserState.pressureAxis = group.axis;
  browserState.pressureStationPath = "";
  browserState.pressureStationPosition = null;
  updateTreeSelection();
  openPressureWorkspace();
}

async function selectFolder(node) {
  browserState.pressureRequestToken++;
  browserState.selectedFolder = node;
  browserState.selectedFile = null;
  updateTreeSelection();
  await showCsvTables(node.csvFiles, node.path || node.name);
}

async function selectCsvFile(file) {
  browserState.pressureRequestToken++;
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
  el.panels.classList.remove("pressure-workspace-layout", "pressure-workspace-with-images");
  el.panels.closest(".app")?.classList.remove("pressure-fullscreen");
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
  const pressureButton = document.createElement("button");
  pressureButton.type = "button";
  pressureButton.className = "small-control";
  pressureButton.textContent = "Pressure plots";
  pressureButton.title = "View pressure coefficient distributions by surface and section";
  pressureButton.addEventListener("click", () => openPressureWorkspace());
  const comparisonMode = document.createElement("div");
  comparisonMode.className = "table-mode-switch choices small";
  const valuesButton = document.createElement("button");
  valuesButton.type = "button";
  valuesButton.textContent = "Values";
  valuesButton.className = browserState.coefficientView === "values" ? "active" : "";
  valuesButton.addEventListener("click", () => {
    browserState.coefficientView = "values";
    updateCoefficientViewControls();
    renderCsvTables(browserState.coefficientRows);
  });
  const deltaButton = document.createElement("button");
  deltaButton.type = "button";
  deltaButton.textContent = "Δ vs reference";
  deltaButton.className = browserState.coefficientView === "delta" ? "active" : "";
  deltaButton.addEventListener("click", () => {
    browserState.coefficientView = "delta";
    updateCoefficientViewControls();
    renderCsvTables(browserState.coefficientRows);
  });
  comparisonMode.append(valuesButton, deltaButton);
  const referenceSelect = document.createElement("select");
  referenceSelect.id = "coefficient-reference";
  referenceSelect.className = "coefficient-reference";
  referenceSelect.setAttribute("aria-label", "Reference simulation");
  referenceSelect.addEventListener("change", () => {
    browserState.coefficientReferencePath = referenceSelect.value;
    renderCsvTables(browserState.coefficientRows);
  });
  const forceSettings = document.createElement("div");
  forceSettings.className = "force-settings";
  forceSettings.title = "Speed and air density used for Downforce [N] and Drag [N]: F = ½ · ρ · v² · (−CzA or −CxA)";
  forceSettings.append(forceSettingInput("Speed", "km/h", "speedKmh"), forceSettingInput("ρ", "kg/m³", "density"));
  el.summary.replaceChildren(heading, count, filter, customize, comparisonMode, referenceSelect, forceSettings, pressureButton);
  updateCoefficientViewControls();
  el.panels.replaceChildren(Object.assign(document.createElement("div"), {
    className: "workspace-empty",
    textContent: "Loading coefficient summary…",
  }));
}

// Every simulation folder under the results root, at any depth; the root
// itself counts when it is a simulation folder.
function simulationNodes(node = browserState.root) {
  if (!node) return [];
  if (node.isCase) return [node];
  return node.folders.flatMap((folder) => simulationNodes(folder));
}

function pressureCaseNodes() {
  return simulationNodes();
}

// Parent folder path of a "a/b/c" style tree path; "" for top-level entries.
function parentPath(path) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function openPressureWorkspace() {
  const cases = pressureCaseNodes();
  browserState.pressureComparePaths = browserState.pressureComparePaths.filter((path) => cases.some((node) => node.path === path)).slice(0, 4);
  if (!cases.some((node) => node.path === browserState.pressureCasePath)) browserState.pressureCasePath = cases[0]?.path ?? "";
  if (!browserState.pressureComparePaths.length && browserState.pressureCasePath) browserState.pressureComparePaths = [browserState.pressureCasePath];
  if (browserState.pressureComparePaths[0]) browserState.pressureCasePath = browserState.pressureComparePaths[0];
  releasePressureImageUrls();
  el.panels.closest(".app")?.classList.add("pressure-fullscreen");
  renderPressureWorkspace();
}

function renderPressureWorkspace() {
  el.summary.hidden = false;
  const heading = document.createElement("h1");
  heading.className = "workspace-title";
  heading.textContent = "Pressure distributions";
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "small-control";
  backButton.textContent = "Back to coefficients";
  backButton.addEventListener("click", async () => {
    browserState.pressureRequestToken++;
    releasePressureImageUrls();
    renderCsvWorkspaceHeader();
    el.panels.classList.remove("pressure-workspace-layout", "pressure-workspace-with-images");
    await renderCsvPage();
  });
  el.summary.replaceChildren(heading, backButton);

  const cases = pressureCaseNodes();
  if (!cases.length) {
    el.panels.replaceChildren(Object.assign(document.createElement("div"), {
      className: "workspace-empty",
      textContent: "No simulation cases are loaded. Open a results folder containing case folders to view pressure distributions.",
    }));
    return;
  }

  const toolbar = document.createElement("section");
  toolbar.className = "pressure-toolbar";
  const caseSelect = document.createElement("select");
  caseSelect.setAttribute("aria-label", "Add simulation to comparison");
  caseSelect.add(new Option("Choose case to add…", ""));
  cases.filter((node) => !browserState.pressureComparePaths.includes(node.path)).forEach((node) => caseSelect.add(new Option(node.name, node.path)));
  const addCase = document.createElement("button");
  addCase.type = "button"; addCase.className = "small-control"; addCase.textContent = "Add case";
  addCase.disabled = browserState.pressureComparePaths.length >= 4 || caseSelect.options.length < 2;
  const surfaceSelect = document.createElement("select");
  surfaceSelect.setAttribute("aria-label", "Surface");
  [["FW", "Front wing"], ["UT", "Undertray"], ["RW", "Rear wing"]].forEach(([value, label]) => {
    surfaceSelect.add(new Option(label, value));
  });
  surfaceSelect.value = browserState.pressureSurface;
  const axisSelect = document.createElement("select");
  axisSelect.setAttribute("aria-label", "Section axis");
  axisSelect.add(new Option("X section", "x"));
  axisSelect.add(new Option("Y section", "y"));
  axisSelect.value = browserState.pressureAxis;
  const showImages = document.createElement("input"); showImages.type = "checkbox"; showImages.checked = browserState.pressureShowImages;
  const showImagesLabel = document.createElement("label"); showImagesLabel.className = "pressure-image-toggle";
  showImagesLabel.append(showImages, document.createTextNode("Add scene images"));
  const sceneField = document.createElement("select");
  sceneField.setAttribute("aria-label", "Image field");
  [["Cp", "Cp image"], ["Velocity", "Velocity image"], ["CpT", "CpT image"], ["Lambda2", "Lambda2 image"]].forEach(([value, label]) => sceneField.add(new Option(label, value)));
  sceneField.value = browserState.pressureSceneField;
  const measurement = document.createElement("span");
  measurement.className = "pressure-measurement";
  measurement.textContent = "Overlay up to 4 cases · use keyboard ← / → to step sections";
  const imageControls = document.createElement("div"); imageControls.className = "pressure-image-controls";
  imageControls.append(sceneField);
  toolbar.append(caseSelect, addCase, surfaceSelect, axisSelect, showImagesLabel, imageControls, measurement);

  const plotContainer = document.createElement("section");
  plotContainer.className = "pressure-plot-container";
  plotContainer.setAttribute("aria-live", "polite");
  const selectedCases = document.createElement("div"); selectedCases.className = "pressure-case-chips";
  const imageGallery = document.createElement("section"); imageGallery.className = "pressure-image-gallery";
  el.panels.classList.add("pressure-workspace-layout");
  el.panels.classList.toggle("pressure-workspace-with-images", showImages.checked);
  imageControls.hidden = !showImages.checked;
  imageGallery.hidden = !showImages.checked;
  el.panels.replaceChildren(toolbar, selectedCases, plotContainer, imageGallery);

  const updateCases = () => {
    el.panels.classList.toggle("pressure-case-count-1", browserState.pressureComparePaths.length === 1);
    renderPressureCaseChips(selectedCases, () => { updateCasePicker(); updateCases(); refresh(); });
  };
  const updateCasePicker = () => {
    caseSelect.replaceChildren(new Option("Choose case to add…", ""));
    cases.filter((node) => !browserState.pressureComparePaths.includes(node.path)).forEach((node) => caseSelect.add(new Option(node.name, node.path)));
    addCase.disabled = browserState.pressureComparePaths.length >= 4 || caseSelect.options.length < 2;
  };
  const refresh = () => refreshPressureStations({ surfaceSelect, axisSelect, plotContainer, imageGallery, measurement });
  browserState.pressureRefresh = refresh;
  addCase.addEventListener("click", () => {
    if (caseSelect.value && browserState.pressureComparePaths.length < 4) {
      browserState.pressureComparePaths.push(caseSelect.value);
      updateCasePicker(); updateCases(); refresh();
    }
  });
  surfaceSelect.addEventListener("change", () => {
    browserState.pressureSurface = surfaceSelect.value;
    browserState.pressureStationPosition = null;
    browserState.pressureStationPath = "";
    refresh();
  });
  axisSelect.addEventListener("change", () => {
    browserState.pressureAxis = axisSelect.value;
    browserState.pressureStationPosition = null;
    browserState.pressureStationPath = "";
    refresh();
  });
  sceneField.addEventListener("change", () => { browserState.pressureSceneField = sceneField.value; refresh(); });
  showImages.addEventListener("change", () => {
    browserState.pressureShowImages = showImages.checked;
    imageControls.hidden = !showImages.checked;
    imageGallery.hidden = !showImages.checked;
    el.panels.classList.toggle("pressure-workspace-with-images", showImages.checked);
    refresh();
  });
  updateCasePicker(); updateCases();
  refresh();
}

function renderPressureCaseChips(container, onChange) {
  const nodes = pressureCaseNodes();
  container.replaceChildren(...browserState.pressureComparePaths.map((path, index) => {
    const node = nodes.find((entry) => entry.path === path);
    const chip = document.createElement("span"); chip.className = `pressure-case-chip pressure-case-color-${index}`;
    chip.textContent = node?.name ?? "Simulation";
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${node?.name ?? "simulation"}`);
    remove.addEventListener("click", () => {
      browserState.pressureComparePaths = browserState.pressureComparePaths.filter((entry) => entry !== path);
      if (browserState.pressureCasePath === path) browserState.pressureCasePath = browserState.pressureComparePaths[0] ?? "";
      onChange();
    });
    chip.appendChild(remove); return chip;
  }));
}

function releasePressureImageUrls() {
  browserState.pressureImageUrls.forEach((url) => URL.revokeObjectURL(url));
  browserState.pressureImageUrls = [];
}

function stepPressureStation(delta) {
  const stations = browserState.pressureStationFiles;
  if (stations.length < 2) return false;
  const current = stations.findIndex((file) => file.path === browserState.pressureStationPath);
  const next = Math.max(0, Math.min(stations.length - 1, (current < 0 ? 0 : current) + delta));
  if (next === current) return false;
  browserState.pressureStationPath = stations[next].path;
  browserState.pressureStationPosition = stations[next].position;
  browserState.pressureRefresh?.();
  document.activeElement?.blur?.();
  return true;
}

function pressureGroupFromFile(file) {
  const parts = file.path.split("/");
  const pressureIndex = parts.findIndex((part) => /^PressureDistributions$/i.test(part));
  if (pressureIndex < 0 || pressureIndex + 1 >= parts.length) return null;
  const match = parts[pressureIndex + 1].match(/^pd_(FW|UT|RW)_([xy])-Section$/i);
  if (!match) return null;
  const station = file.name.match(/_(-?\d+(?:\.\d+)?)mm\.csv$/i);
  if (!station) return null;
  return { surface: match[1].toUpperCase(), axis: match[2].toLowerCase(), position: Number(station[1]) };
}

function findPressureFiles(casePath, surface, axis) {
  const caseNode = pressureCaseNodes().find((node) => node.path === casePath);
  if (!caseNode) return [];
  return caseNode.csvFiles.map((file) => ({ file, group: pressureGroupFromFile(file) }))
    .filter((entry) => entry.group?.surface === surface && entry.group.axis === axis)
    .sort((left, right) => left.file.name.localeCompare(right.file.name, undefined, { numeric: true }))
    .map((entry) => ({ ...entry.file, position: entry.group.position }));
}

async function pressureFileHasData(file) {
  if (browserState.pressureAvailability.has(file.handle)) return browserState.pressureAvailability.get(file.handle);
  const checking = (async () => {
    const blob = await file.handle.getFile();
    const previewRows = parseCsv(await blob.slice(0, 512).text());
    return previewRows.slice(1).some((row) => row.length >= 2 && Number.isFinite(Number(row[0])) && Number.isFinite(Number(row[1])));
  })();
  browserState.pressureAvailability.set(file.handle, checking);
  try {
    const available = await checking;
    browserState.pressureAvailability.set(file.handle, available);
    return available;
  } catch (error) {
    browserState.pressureAvailability.delete(file.handle);
    throw error;
  }
}

async function refreshPressureStations({ surfaceSelect, axisSelect, plotContainer, imageGallery, measurement }) {
  const token = ++browserState.pressureRequestToken;
  releasePressureImageUrls();
  imageGallery.replaceChildren();
  browserState.pressureStationFiles = [];
  const primary = browserState.pressureComparePaths[0];
  browserState.pressureCasePath = primary ?? "";
  const files = findPressureFiles(primary, surfaceSelect.value, axisSelect.value);
  plotContainer.replaceChildren(Object.assign(document.createElement("div"), {
    className: "workspace-empty pressure-empty",
    textContent: files.length ? "Finding stations with measurements…" : "No pressure CSVs found for this case, surface, and section.",
  }));
  if (!files.length) { measurement.textContent = "No pressure stations"; return; }

  const availability = await Promise.all(files.map(async (file) => ({ file, hasData: await pressureFileHasData(file).catch(() => false) })));
  if (token !== browserState.pressureRequestToken) return;
  const populated = availability.filter((entry) => entry.hasData).map((entry) => entry.file);
  browserState.pressureStationFiles = populated;
  if (!populated.length) {
    measurement.textContent = "No populated stations";
    plotContainer.replaceChildren(Object.assign(document.createElement("div"), {
      className: "workspace-empty pressure-empty",
      textContent: "These CSV files contain no pressure measurements.",
    }));
    return;
  }

  const defaultFile = populated[0];
  const chosen = populated.find((file) => file.path === browserState.pressureStationPath) ??
    (Number.isFinite(browserState.pressureStationPosition)
      ? populated.reduce((best, file) => Math.abs(file.position - browserState.pressureStationPosition) < Math.abs(best.position - browserState.pressureStationPosition) ? file : best)
      : defaultFile);
  browserState.pressureStationPath = chosen.path;
  browserState.pressureStationPosition = chosen.position;
  measurement.textContent = `${formatStation(chosen.position)} mm · keyboard ← / → to step · up to 4 cases`;
  await renderPressureComparison(populated, chosen.position, { surface: surfaceSelect.value, axis: axisSelect.value, plotContainer, imageGallery, token });
}

// Stations from different cases or image sets count as the same plane
// within half a millimetre (filenames round to whole millimetres).
function stationsMatch(left, right) {
  return Math.abs(left - right) < 0.5;
}

function formatStation(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

async function renderPressureComparison(primaryFiles, position, options) {
  const { surface, axis, plotContainer, imageGallery, token } = options;
  plotContainer.replaceChildren(Object.assign(document.createElement("div"), { className: "workspace-empty pressure-empty", textContent: "Loading pressure measurements…" }));
  releasePressureImageUrls();
  try {
    const series = await Promise.all(browserState.pressureComparePaths.map(async (path, colorIndex) => {
      const node = pressureCaseNodes().find((entry) => entry.path === path);
      const files = path === browserState.pressureCasePath ? primaryFiles : findPressureFiles(path, surface, axis);
      if (!files.length) return null;
      const availableFiles = path === browserState.pressureCasePath
        ? files
        : (await Promise.all(files.map(async (entry) => await pressureFileHasData(entry) ? entry : null))).filter(Boolean);
      if (!availableFiles.length) return null;
      const file = availableFiles.reduce((best, entry) => Math.abs(entry.position - position) < Math.abs(best.position - position) ? entry : best);
      const rows = parseCsv(await (await file.handle.getFile()).text());
      const headers = rows.shift() ?? [];
      const coordinateIndex = headers.findIndex((header) => /Direction/i.test(header));
      const cpIndex = headers.findIndex((header) => /Pressure Coefficient/i.test(header));
      const points = rows.map((row) => ({ x: Number(row[coordinateIndex]), cp: Number(row[cpIndex]) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.cp))
        .sort((left, right) => left.x - right.x);
      const coordinate = (headers[coordinateIndex] ?? "").replace(/^[^:]*:\s*/, "");
      return points.length ? { name: node?.name ?? "Simulation", path, position: file.position, points, colorIndex, coordinate } : null;
    }));
    if (token !== browserState.pressureRequestToken) return;
    const validSeries = series.filter(Boolean);
    if (!validSeries.length) {
      plotContainer.replaceChildren(Object.assign(document.createElement("div"), { className: "workspace-empty pressure-empty", textContent: "No selected case has measurements at this station." }));
      return;
    }
    drawPressureChart(plotContainer, validSeries, {
      surface,
      axis,
      station: position,
      caseName: validSeries.map((entry) => entry.name).join(", "),
      coordinate: validSeries[0].coordinate || (axis === "x" ? "Y coordinate (mm)" : "X coordinate (mm)"),
    });
    if (browserState.pressureShowImages) await renderPressureImages(position, imageGallery, token);
  } catch (error) {
    if (token !== browserState.pressureRequestToken) return;
    plotContainer.replaceChildren(Object.assign(document.createElement("div"), { className: "workspace-empty pressure-empty", textContent: error?.message || "Could not read the selected pressure CSVs." }));
  }
}

async function findPressureSceneImage(casePath, field, axis, station) {
  const caseNode = pressureCaseNodes().find((node) => node.path === casePath);
  const section = caseNode?.folders.find((folder) => new RegExp(`^${field}_${axis}-Section$`, "i").test(folder.name));
  if (!section) return null;
  const images = [];
  for await (const child of section.handle.values()) {
    if (child.kind === "file" && /\.(png|jpe?g|webp)$/i.test(child.name)) images.push({ name: child.name, path: `${section.path}/${child.name}`, handle: child });
  }
  const positionFromName = (name) => {
    const match = name.match(/_(-?\d+(?:\.\d+)?)mm\.(?:png|jpe?g|webp)$/i);
    return match ? Number(match[1]) : null;
  };
  const positioned = images.map((file) => ({ file, position: positionFromName(file.name) })).filter((item) => item.position !== null);
  // Images without an mm station in their name can't be matched to the plot plane.
  return positioned.length ? positioned.reduce((best, item) => Math.abs(item.position - station) < Math.abs(best.position - station) ? item : best) : null;
}

async function renderPressureImages(station, gallery, token) {
  gallery.replaceChildren();
  gallery.className = `pressure-image-gallery pressure-image-count-${browserState.pressureComparePaths.length}`;
  const heading = document.createElement("h2"); heading.className = "pressure-gallery-title";
  heading.textContent = `${browserState.pressureSceneField} ${browserState.pressureAxis.toUpperCase()} scene`;
  gallery.appendChild(heading);
  const cards = await Promise.all(browserState.pressureComparePaths.map(async (path, index) => {
    const match = await findPressureSceneImage(path, browserState.pressureSceneField, browserState.pressureAxis, station);
    const file = match?.file;
    const name = pressureCaseNodes().find((node) => node.path === path)?.name ?? "Simulation";
    const card = document.createElement("figure"); card.className = `pressure-image-card pressure-case-color-${index}`;
    card.title = name;
    if (!file) { card.setAttribute("aria-label", `${name}: no matching scene image`); card.appendChild(Object.assign(document.createElement("div"), { className: "workspace-empty", textContent: "No matching scene image" })); return card; }
    const blob = await file.handle.getFile();
    if (token !== browserState.pressureRequestToken) return card;
    const url = URL.createObjectURL(blob); browserState.pressureImageUrls.push(url);
    const image = document.createElement("img"); image.src = url; image.alt = `${name} · ${file.name}`;
    card.appendChild(image);
    if (!stationsMatch(match.position, station)) {
      card.appendChild(Object.assign(document.createElement("figcaption"), {
        className: "station-mismatch",
        textContent: `Image plane ${formatStation(match.position)} mm (plot ${formatStation(station)} mm)`,
      }));
    }
    return card;
  }));
  if (token === browserState.pressureRequestToken) gallery.append(...cards);
}

function drawPressureChart(container, series, metadata) {
  const NS = "http://www.w3.org/2000/svg";
  const width = 1040;
  const height = 590;
  const margin = { top: 52, right: 30, bottom: 86, left: 86 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const points = series.flatMap((entry) => entry.points);
  const xMin = Math.min(...points.map((point) => point.x));
  const xMax = Math.max(...points.map((point) => point.x));
  // CFD-Tool's pressure renderer uses a consistent Cp window for every section.
  // Keeping the same range makes stations easier to compare and leaves headroom
  // for the positive-pressure peak.
  const yMin = -5;
  const yMax = 1;
  const xScale = (value) => margin.left + (xMax === xMin ? 0.5 : (value - xMin) / (xMax - xMin)) * chartWidth;
  const yScale = (value) => margin.top + (value - yMin) / (yMax - yMin) * chartHeight;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${metadata.surface} ${metadata.axis.toUpperCase()} pressure distribution at ${formatStation(metadata.station)} millimetres`);
  svg.classList.add("pressure-chart");
  const clipId = `pressure-clip-${crypto.randomUUID()}`;
  const defs = document.createElementNS(NS, "defs");
  const clipPath = document.createElementNS(NS, "clipPath"); clipPath.setAttribute("id", clipId);
  const clipRect = document.createElementNS(NS, "rect");
  clipRect.setAttribute("x", String(margin.left)); clipRect.setAttribute("y", String(margin.top));
  clipRect.setAttribute("width", String(chartWidth)); clipRect.setAttribute("height", String(chartHeight));
  clipPath.appendChild(clipRect); defs.appendChild(clipPath); svg.appendChild(defs);
  const title = document.createElementNS(NS, "title");
  title.textContent = `${metadata.caseName} · ${metadata.surface} · ${metadata.axis.toUpperCase()} section · ${formatStation(metadata.station)} mm`;
  svg.appendChild(title);

  const heading = document.createElementNS(NS, "text");
  heading.setAttribute("x", String(margin.left));
  heading.setAttribute("y", "30");
  heading.setAttribute("class", "pressure-chart-title");
  heading.textContent = `${metadata.surface} · ${metadata.axis.toUpperCase()} section at ${formatStation(metadata.station)} mm`;
  svg.appendChild(heading);

  const xTicks = createTicks(xMin, xMax, 6);
  const yTicks = [-5, -4, -3, -2, -1, 0, 1];
  yTicks.forEach((tick) => {
    const y = yScale(tick);
    const grid = document.createElementNS(NS, "line");
    grid.setAttribute("x1", String(margin.left)); grid.setAttribute("x2", String(width - margin.right));
    grid.setAttribute("y1", String(y)); grid.setAttribute("y2", String(y));
    grid.setAttribute("class", "pressure-grid-line"); svg.appendChild(grid);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(margin.left - 12)); label.setAttribute("y", String(y + 4));
    label.setAttribute("text-anchor", "end"); label.setAttribute("class", "pressure-tick-label");
    label.textContent = formatTick(tick); svg.appendChild(label);
  });
  xTicks.forEach((tick) => {
    const x = xScale(tick);
    const grid = document.createElementNS(NS, "line");
    grid.setAttribute("x1", String(x)); grid.setAttribute("x2", String(x));
    grid.setAttribute("y1", String(margin.top)); grid.setAttribute("y2", String(height - margin.bottom));
    grid.setAttribute("class", "pressure-grid-line"); svg.appendChild(grid);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(x)); label.setAttribute("y", String(height - margin.bottom + 24));
    label.setAttribute("text-anchor", "middle"); label.setAttribute("class", "pressure-tick-label");
    label.textContent = formatTick(tick); svg.appendChild(label);
  });

  // The legacy importer separates suction and pressure-side Cp samples around
  // +/-0.1. Keep pressure and suction points visually distinct, and leave
  // near-zero samples out as the old plot did.
  const colors = [
    { pressure: "#3498db", suction: "#e73a27" },
    { pressure: "#0f3f5f", suction: "#c0392b" },
    { pressure: "#48c9b0", suction: "#d6a813" },
    { pressure: "#6a5de2", suction: "#f1948a" },
  ];
  const markerShapes = ["circle", "square", "triangle", "diamond"];
  const addMarker = (shape, x, y, fill, size = 2.5, clipped = true) => {
    let marker;
    if (shape === "circle") {
      marker = document.createElementNS(NS, "circle");
      marker.setAttribute("cx", x); marker.setAttribute("cy", y); marker.setAttribute("r", size);
    } else if (shape === "square") {
      marker = document.createElementNS(NS, "rect");
      marker.setAttribute("x", x - size); marker.setAttribute("y", y - size);
      marker.setAttribute("width", size * 2); marker.setAttribute("height", size * 2);
    } else {
      const shapePoints = shape === "triangle"
        ? `${x},${y - size * 1.3} ${x + size * 1.2},${y + size} ${x - size * 1.2},${y + size}`
        : `${x},${y - size * 1.3} ${x + size * 1.3},${y} ${x},${y + size * 1.3} ${x - size * 1.3},${y}`;
      marker = document.createElementNS(NS, "polygon");
      marker.setAttribute("points", shapePoints);
    }
    marker.setAttribute("fill", fill);
    if (clipped) marker.setAttribute("clip-path", `url(#${clipId})`);
    svg.appendChild(marker);
  };
  const legendX = margin.left + 12;
  series.forEach((entry, index) => {
    const color = colors[entry.colorIndex % colors.length];
    const shape = markerShapes[entry.colorIndex % markerShapes.length];
    const positive = entry.points.filter((point) => point.cp > 0.1);
    const negative = entry.points.filter((point) => point.cp < -0.1);
    [[positive, color.pressure], [negative, color.suction]].forEach(([selected, stroke]) => {
      selected.forEach((point) => {
        addMarker(shape, xScale(point.x), yScale(point.cp), stroke);
      });
    });
    const keyX = legendX + index * 230;
    const key = document.createElementNS(NS, "line");
    key.setAttribute("x1", String(keyX)); key.setAttribute("x2", String(keyX + 22));
    key.setAttribute("y1", "43"); key.setAttribute("y2", "43");
    key.setAttribute("class", "pressure-line"); key.style.stroke = color.pressure; svg.appendChild(key);
    addMarker(shape, keyX + 11, 43, color.pressure, 3, false);
    const suctionKey = document.createElementNS(NS, "line");
    suctionKey.setAttribute("x1", String(keyX + 25)); suctionKey.setAttribute("x2", String(keyX + 47));
    suctionKey.setAttribute("y1", "43"); suctionKey.setAttribute("y2", "43");
    suctionKey.setAttribute("class", "pressure-line"); suctionKey.style.stroke = color.suction; svg.appendChild(suctionKey);
    addMarker(shape, keyX + 36, 43, color.suction, 3, false);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(keyX + 53)); label.setAttribute("y", "47");
    label.setAttribute("class", "pressure-legend-label");
    label.textContent = stationsMatch(entry.position, metadata.station)
      ? entry.name
      : `${entry.name} @ ${formatStation(entry.position)} mm`;
    if (!stationsMatch(entry.position, metadata.station)) label.classList.add("station-mismatch");
    svg.appendChild(label);
  });
  const sideLegend = document.createElementNS(NS, "text");
  sideLegend.setAttribute("x", String(width - margin.right)); sideLegend.setAttribute("y", "28");
  sideLegend.setAttribute("text-anchor", "end"); sideLegend.setAttribute("class", "pressure-legend-label");
  sideLegend.textContent = "Pressure side (+Cp) · Suction side (−Cp)"; svg.appendChild(sideLegend);
  const xLabel = document.createElementNS(NS, "text");
  xLabel.setAttribute("x", String(margin.left + chartWidth / 2));
  xLabel.setAttribute("y", String(height - 20)); xLabel.setAttribute("text-anchor", "middle");
  xLabel.setAttribute("class", "pressure-axis-label"); xLabel.textContent = metadata.coordinate;
  svg.appendChild(xLabel);
  const yLabel = document.createElementNS(NS, "text");
  yLabel.setAttribute("transform", `translate(22 ${margin.top + chartHeight / 2}) rotate(-90)`);
  yLabel.setAttribute("text-anchor", "middle"); yLabel.setAttribute("class", "pressure-axis-label");
  yLabel.textContent = "Pressure coefficient (Cp)"; svg.appendChild(yLabel);

  const card = document.createElement("section");
  card.className = "pressure-chart-card";
  const details = document.createElement("p");
  details.className = "pressure-chart-details";
  details.textContent = `${series.length} cases · ${points.length.toLocaleString()} measurements · ${formatTick(xMin)} to ${formatTick(xMax)} mm · Cp ${formatTick(Math.min(...points.map((point) => point.cp)))} to ${formatTick(Math.max(...points.map((point) => point.cp)))}`;
  const offStation = series.filter((entry) => !stationsMatch(entry.position, metadata.station));
  if (offStation.length) {
    details.textContent += ` · ${offStation.length === 1 ? "1 case has" : `${offStation.length} cases have`} no data at ${formatStation(metadata.station)} mm and ${offStation.length === 1 ? "is" : "are"} shown at the nearest station (see legend)`;
    details.classList.add("station-mismatch");
  }
  card.append(svg, details);
  container.replaceChildren(card);
}

function createTicks(min, max, targetCount) {
  if (min === max) return [min];
  const rawStep = (max - min) / Math.max(1, targetCount - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const fraction = rawStep / magnitude;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  const step = niceFraction * magnitude;
  const first = Math.ceil(min / step) * step;
  const ticks = [];
  for (let tick = first; tick <= max + step * 1e-8 && ticks.length < 100; tick += step) ticks.push(tick);
  return ticks.length ? ticks : [min, max];
}

function formatTick(value) {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 100 || (Math.abs(value) > 0 && Math.abs(value) < 0.01)) return value.toExponential(1);
  return String(Number(value.toFixed(2)));
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

function numericCell(raw) {
  const text = String(raw ?? "").trim();
  return text ? Number(text) : NaN;
}

// Confirmed by the team (2026-10-02): CzA and CxA are the downforce and drag
// coefficients times the reference area; negative means downforce / drag.
// CzA Front (percentage) is the front share of the downforce, as a fraction.
// The exported monitors stay unchanged; HoMo CFD adds these columns from the
// total monitors. Forces use the speed and density set above the table and
// assume CzA and CxA do not change with speed.
const COMPUTED_COLUMNS = [
  { header: "Downforce [N]", sources: ["CzA"], decimals: 1,
    value: (monitor, pressure) => -monitor.CzA * pressure,
    note: () => forceColumnNote("Downforce", "CzA", "downforce") },
  { header: "Drag [N]", sources: ["CxA"], decimals: 1,
    value: (monitor, pressure) => -monitor.CxA * pressure,
    note: () => forceColumnNote("Drag", "CxA", "drag") },
  { header: "L/D", sources: ["CzA", "CxA"], decimals: 2,
    value: (monitor) => monitor.CzA / monitor.CxA,
    note: () => "Lift-to-drag ratio = Downforce ÷ Drag = CzA ÷ CxA. It does not depend on the speed or density. " +
      "Higher means more downforce for the same drag." },
  { header: "Balance [% front]", sources: ["CzA Front(%)"], decimals: 1,
    value: (monitor) => monitor["CzA Front(%)"] * 100,
    note: () => "Aero balance: front share of the downforce = CzA Front (percentage) × 100 (the monitor is exported as a fraction). " +
      "50 % is an even front/rear split; higher means more front-biased." },
];

function derivedAeroColumn(header) {
  const column = COMPUTED_COLUMNS.find((candidate) => candidate.header === header);
  return column ? { ...column, note: column.note() } : undefined;
}

function validForceSetting(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readForceSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(FORCE_SETTINGS_KEY) || "{}");
    return {
      speedKmh: validForceSetting(saved.speedKmh) ? saved.speedKmh : DEFAULT_FORCE_SETTINGS.speedKmh,
      density: validForceSetting(saved.density) ? saved.density : DEFAULT_FORCE_SETTINGS.density,
    };
  } catch {
    return { ...DEFAULT_FORCE_SETTINGS };
  }
}

function dynamicPressure({ speedKmh, density }) {
  const speed = speedKmh / 3.6;
  return 0.5 * density * speed * speed;
}

function forceColumnNote(name, coefficient, meaning) {
  const settings = browserState.forceSettings;
  return `${name} = ½ · ρ · v² · (−${coefficient}), where ${coefficient} is the ${meaning} coefficient × reference area ` +
    `(negative ${coefficient} is ${meaning}, so higher means more ${meaning}). v = ${settings.speedKmh} km/h ` +
    `(${(settings.speedKmh / 3.6).toFixed(2)} m/s) and ρ = ${settings.density} kg/m³, so ½ · ρ · v² = ${dynamicPressure(settings).toFixed(1)} Pa. ` +
    `Change the speed and density above the table. Assumes ${coefficient} does not change with speed.`;
}

function forceSettingInput(labelText, unit, key) {
  const label = document.createElement("label");
  label.className = "force-setting";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "any";
  input.value = String(browserState.forceSettings[key]);
  input.dataset.forceSetting = key;
  input.setAttribute("aria-label", `${labelText} (${unit})`);
  input.addEventListener("change", () => {
    const value = Number(input.value);
    if (!validForceSetting(value)) {
      input.setCustomValidity("Enter a number above 0.");
      input.title = "Enter a number above 0.";
      return;
    }
    input.setCustomValidity("");
    input.title = "";
    browserState.forceSettings = { ...browserState.forceSettings, [key]: value };
    try {
      localStorage.setItem(FORCE_SETTINGS_KEY, JSON.stringify(browserState.forceSettings));
    } catch {}
    if (browserState.coefficientRows.length) renderCsvTables(browserState.coefficientRows);
  });
  label.append(labelText, input, unit);
  return label;
}

// Adds the computed columns right after Iteration, from the total monitors
// of the final row. Done at render time (not in the cached CSV rows) so speed
// and density can change.
function withComputedColumns(data) {
  const row = data.rows[data.rows.length - 1];
  if (!row) return data;
  const pressure = dynamicPressure(browserState.forceSettings);
  const monitor = {};
  data.headers.forEach((header, index) => {
    const kind = classifyHeader(header);
    if (kind && !(kind in monitor)) monitor[kind] = numericCell(row[index]);
  });
  const headers = [...data.headers];
  const values = [...row];
  let insertAt = data.headers.findIndex((header) => /^iteration$/i.test(header)) + 1;
  COMPUTED_COLUMNS.forEach((column) => {
    if (!column.sources.every((source) => source in monitor)) return;
    const value = column.value(monitor, pressure);
    headers.splice(insertAt, 0, column.header);
    values.splice(insertAt, 0, Number.isFinite(value) ? String(value) : "");
    insertAt++;
  });
  return { ...data, headers, rows: [...data.rows.slice(0, -1), values] };
}

// Forces and balance get one decimal, L/D two; coefficients keep three.
function valueDecimals(header) {
  return COMPUTED_COLUMNS.find((column) => column.header === header)?.decimals ?? 3;
}

async function loadCsvTable(file) {
  if (browserState.csvCache.has(file.handle)) return browserState.csvCache.get(file.handle);
  const loading = (async () => {
    const csv = await file.handle.getFile();
    const rows = parseCsv(await csv.text());
    if (!rows.length) return { name: file.name, path: file.path, headers: [], rows: [] };
    const headers = rows.shift().map((value, index) => value || `Column ${index + 1}`);
    if (/^coefficients.*\.csv$/i.test(file.name)) {
      if (!rows.length) return { name: file.name, path: file.path, headers, rows: [] };
      return { name: file.name, path: file.path, headers, rows: [rows[rows.length - 1]] };
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

function coefficientReadErrors(coefficientRows) {
  const failed = coefficientRows.filter((data) => data.error);
  if (!failed.length) return null;
  const note = document.createElement("p");
  note.className = "error";
  note.textContent = `Could not read ${failed.length} coefficient file${failed.length === 1 ? "" : "s"}: ` +
    failed.map((data) => `${data.path} (${data.error})`).join("; ");
  return note;
}

function renderCsvTables(coefficientRows) {
  const validRows = coefficientRows.filter((data) => Array.isArray(data.headers) && Array.isArray(data.rows)).map(withComputedColumns);
  const readErrors = coefficientReadErrors(coefficientRows);
  browserState.columnHeaders = [...new Set(validRows.flatMap((data) => data.headers))];
  const customizeButton = el.summary.querySelector(".customize-columns");
  if (customizeButton) customizeButton.disabled = !browserState.columnHeaders.length;
  updateCoefficientViewControls();
  if (!validRows.length) {
    const empty = document.createElement("div");
    empty.className = "workspace-empty";
    empty.textContent = "No coefficient summaries in this folder.";
    el.panels.replaceChildren(...[readErrors, empty].filter(Boolean));
    return;
  }

  const collective = document.createElement("section");
  collective.className = "csv-card collective-table-card";
  const heading = document.createElement("h2");
  heading.className = "csv-card-title";
  const referencePath = browserState.coefficientReferencePath || validRows[0].path;
  const referenceRow = validRows.find((data) => data.path === referencePath) ?? validRows[0];
  heading.textContent = browserState.coefficientView === "delta"
    ? `Monitor differences from ${simulationNameFromCsvPath(referenceRow.path)}`
    : "Final iteration by simulation";
  collective.appendChild(heading);
  if (readErrors) collective.appendChild(readErrors);
  if (browserState.coefficientView === "delta") {
    const note = document.createElement("p");
    note.className = "comparison-note";
    note.textContent = "Δ = this simulation minus the reference. Downforce [N] and Drag [N] are positive for downforce and drag, so a positive Δ " +
      "there means more downforce or more drag. Other columns are the exported monitors, unchanged: for CzA and CxA a negative Δ means " +
      "more downforce or more drag. A positive Δ L/D means more downforce per unit of drag; a positive Δ Balance means more front-biased.";
    collective.appendChild(note);
  }

    const headers = orderedColumnDefinitions(browserState.columnHeaders);
    const visibleHeaders = headers.filter((column) => column.visible &&
      (browserState.coefficientView !== "delta" || !/^iteration$/i.test(column.key)));
    const tableWrap = document.createElement("div");
    tableWrap.className = "csv-table-wrap";
    const table = document.createElement("table");
    table.className = "data-table";
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headerRow.appendChild(cell("th", "Simulation"));
    visibleHeaders.forEach((column) => {
      const th = cell("th", browserState.coefficientView === "delta" ? `Δ ${column.label}` : column.label);
      const derived = derivedAeroColumn(column.key);
      if (derived) {
        th.classList.add("derived-column");
        th.title = `Computed by HoMo CFD. ${derived.note}`;
      }
      headerRow.appendChild(th);
    });
    head.appendChild(headerRow);
    table.appendChild(head);

    const body = document.createElement("tbody");
    validRows.forEach((data) => {
      const sourceRow = data.rows[data.rows.length - 1] ?? [];
      const row = document.createElement("tr");
      if (data.path === referenceRow.path) row.className = "reference-row";
      row.appendChild(cell("td", simulationNameFromCsvPath(data.path)));
      visibleHeaders.forEach((column) => {
        if (browserState.coefficientView === "delta") {
          const value = coefficientValue(data, column.key);
          const referenceValue = coefficientValue(referenceRow, column.key);
          const difference = value === null || referenceValue === null ? null : value - referenceValue;
          row.appendChild(cell("td", difference === null ? "" : difference.toFixed(valueDecimals(column.key))));
        } else {
          const index = data.headers.indexOf(column.key);
          const value = index < 0 ? "" : sourceRow[index] ?? "";
          row.appendChild(cell("td", formatCoefficientValue(column.key, value)));
        }
      });
      body.appendChild(row);
    });
    table.appendChild(body);
    tableWrap.appendChild(table);
    collective.appendChild(tableWrap);
    collective.appendChild(renderMonitorChart(validRows, referenceRow));
  el.panels.replaceChildren(collective);
}

function renderMonitorChart(coefficientRows, referenceRow) {
  const columns = browserState.columnHeaders.filter((header) => !/^iteration$/i.test(header));
  const chart = document.createElement("details");
  chart.className = "monitor-chart-card";
  chart.open = coefficientRows.length <= 8;
  const title = document.createElement("summary");
  title.textContent = "Monitor comparison";
  chart.appendChild(title);

  const controls = document.createElement("label");
  controls.className = "monitor-chart-controls";
  controls.appendChild(document.createTextNode("Monitor"));
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Monitor to chart");
  orderedColumnDefinitions(columns).forEach((column) => select.add(new Option(column.label, column.key)));
  if (!columns.includes(browserState.monitorChartHeader)) {
    browserState.monitorChartHeader = columns.find((header) => header === "Downforce [N]") ??
      columns.find((header) => classifyHeader(header) === "CzA") ?? columns[0] ?? "";
  }
  select.value = browserState.monitorChartHeader;
  controls.appendChild(select);
  chart.appendChild(controls);

  const note = document.createElement("p");
  note.className = "monitor-chart-note";
  const describeSelection = () => {
    const label = select.selectedOptions[0]?.textContent ?? "monitor";
    const derived = derivedAeroColumn(select.value);
    const meaning = derived ? derived.note : "Exported monitor value, unchanged.";
    return browserState.coefficientView === "delta"
      ? `Δ ${label}: case minus ${simulationNameFromCsvPath(referenceRow.path)}. ${meaning}`
      : `${label}. ${meaning}`;
  };
  note.textContent = describeSelection();
  chart.appendChild(note);

  const chartViewport = document.createElement("div");
  chartViewport.className = "monitor-chart-viewport";
  const draw = () => {
    browserState.monitorChartHeader = select.value;
    note.textContent = describeSelection();
    chartViewport.replaceChildren(drawMonitorChart(coefficientRows, select.value, referenceRow));
  };
  select.addEventListener("change", draw);
  draw();
  chart.appendChild(chartViewport);
  return chart;
}

function drawMonitorChart(coefficientRows, header, referenceRow) {
  const namespace = "http://www.w3.org/2000/svg";
  const width = 960;
  const rowHeight = 32;
  const height = Math.max(100, 48 + coefficientRows.length * rowHeight);
  const labelWidth = 230;
  const plotWidth = 570;
  const zeroX = labelWidth + plotWidth / 2;
  const values = coefficientRows.map((data) => {
    const value = coefficientValue(data, header);
    if (browserState.coefficientView !== "delta" || value === null) return value;
    const reference = coefficientValue(referenceRow, header);
    return reference === null ? null : value - reference;
  });
  const maxMagnitude = Math.max(1e-9, ...values.filter(Number.isFinite).map((value) => Math.abs(value)));
  const scale = (plotWidth / 2 - 18) / maxMagnitude;
  const svg = document.createElementNS(namespace, "svg");
  svg.classList.add("monitor-chart");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Raw monitor comparison: ${header}`);

  [-maxMagnitude, 0, maxMagnitude].forEach((tick) => {
    const x = zeroX + tick * scale;
    const line = document.createElementNS(namespace, "line");
    line.setAttribute("x1", String(x));
    line.setAttribute("x2", String(x));
    line.setAttribute("y1", "26");
    line.setAttribute("y2", String(height - 8));
    line.setAttribute("class", tick === 0 ? "monitor-zero-line" : "monitor-grid-line");
    svg.appendChild(line);
    const label = document.createElementNS(namespace, "text");
    label.setAttribute("x", String(x));
    label.setAttribute("y", "18");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "monitor-tick-label");
    label.textContent = tick.toFixed(valueDecimals(header));
    svg.appendChild(label);
  });

  coefficientRows.forEach((data, index) => {
    const y = 42 + index * rowHeight;
    const value = values[index];
    const label = document.createElementNS(namespace, "text");
    label.setAttribute("x", "8");
    label.setAttribute("y", String(y + 4));
    label.setAttribute("class", "monitor-case-label");
    label.textContent = simulationNameFromCsvPath(data.path);
    svg.appendChild(label);
    if (value === null || !Number.isFinite(value)) return;
    const bar = document.createElementNS(namespace, "rect");
    bar.setAttribute("x", String(value < 0 ? zeroX + value * scale : zeroX));
    bar.setAttribute("y", String(y - 8));
    bar.setAttribute("width", String(Math.abs(value * scale)));
    bar.setAttribute("height", "16");
    bar.setAttribute("rx", "2");
    bar.setAttribute("class", `monitor-bar monitor-color-${index % 6}`);
    svg.appendChild(bar);
    const valueLabel = document.createElementNS(namespace, "text");
    valueLabel.setAttribute("x", String(labelWidth + plotWidth + 16));
    valueLabel.setAttribute("y", String(y + 4));
    valueLabel.setAttribute("class", "monitor-value-label");
    valueLabel.textContent = value.toFixed(valueDecimals(header));
    svg.appendChild(valueLabel);
  });
  return svg;
}

function coefficientValue(data, header) {
  const index = data.headers.indexOf(header);
  if (index < 0) return null;
  const value = Number(data.rows[data.rows.length - 1]?.[index]);
  return Number.isFinite(value) ? value : null;
}

function updateCoefficientViewControls() {
  const buttons = document.querySelectorAll(".table-mode-switch button");
  buttons.forEach((button, index) => {
    button.classList.toggle("active", (index === 0) === (browserState.coefficientView === "values"));
  });

  const reference = document.getElementById("coefficient-reference");
  if (!reference) return;
  const rows = browserState.coefficientRows.filter((data) => Array.isArray(data.headers));
  reference.replaceChildren(...rows.map((data) => new Option(simulationNameFromCsvPath(data.path), data.path)));
  if (!rows.some((data) => data.path === browserState.coefficientReferencePath)) {
    browserState.coefficientReferencePath = rows[0]?.path ?? "";
  }
  reference.value = browserState.coefficientReferencePath;
  reference.hidden = browserState.coefficientView !== "delta";
  reference.disabled = rows.length < 2;
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
  return Number.isFinite(numeric) ? numeric.toFixed(valueDecimals(header)) : value;
}

function simulationNameFromCsvPath(path) {
  const parts = path.split("/");
  const plotsIndex = parts.findIndex((part) => /^plots$/i.test(part));
  if (plotsIndex > 0) return parts[plotsIndex - 1];
  // "plots/Coefficients.csv" directly under the root: the root is the simulation.
  if (plotsIndex === 0 || parts.length === 1) return browserState.root?.name ?? parts[0];
  return parts[parts.length - 2];
}

function viewerTarget(node) {
  return { handle: node.handle, path: node.path, name: node.name };
}

async function saveViewerHandle(key, handle, path) {
  const db = await openSettingsDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(ROOT_STORE, "readwrite");
    const store = transaction.objectStore(ROOT_STORE);
    store.put(handle, `viewer:${key}`);
    store.put(path, `viewer-path:${key}`);
    store.put(Date.now(), `viewer-time:${key}`);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function saveViewerSet(key, nodes, catalog) {
  const db = await openSettingsDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(ROOT_STORE, "readwrite");
    const store = transaction.objectStore(ROOT_STORE);
    store.put(nodes.map(viewerTarget), `viewer-set:${key}`);
    store.put(catalog.map(viewerTarget), `viewer-catalog:${key}`);
    store.put(Date.now(), `viewer-time:${key}`);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function openImageFolder(node) {
  const simulation = findFolderByPath(browserState.root, parentPath(node.path));
  if (!simulation) {
    showError(`Could not find the simulation folder for ${node.path}.`);
    return;
  }
  await openComparisonWindow([simulation], node.path);
}

async function openSceneGallery(node) {
  const popup = window.open(
    "about:blank",
    `homo-cfd-scenes-${crypto.randomUUID()}`,
    `popup,width=${screen.availWidth},height=${screen.availHeight},left=0,top=0`,
  );
  if (!popup) {
    showError("The 3D scene window was blocked. Allow pop-ups for this local app and try again.");
    return;
  }
  const key = crypto.randomUUID();
  try {
    await saveViewerHandle(key, node.handle, node.path);
    popup.location.href = `./image-viewer.html?folder=${encodeURIComponent(key)}&gallery=3d`;
  } catch (err) {
    popup.close();
    showError(err?.message || "Could not open the 3D scene gallery");
  }
}

async function openEnsightViewer(node) {
  const popup = window.open(
    "about:blank",
    `homo-cfd-3d-${crypto.randomUUID()}`,
    `popup,width=${screen.availWidth},height=${screen.availHeight},left=0,top=0`,
  );
  if (!popup) {
    showError("The 3D viewer window was blocked. Allow pop-ups for this local app and try again.");
    return;
  }
  const key = crypto.randomUUID();
  try {
    await saveViewerHandle(key, node.handle, node.path);
    popup.location.href = `./3d-viewer.html?folder=${encodeURIComponent(key)}`;
  } catch (err) {
    popup.close();
    showError(err?.message || "Could not open the 3D viewer");
  }
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
    const simulations = simulationNodes();
    const catalog = simulations.length ? simulations : nodes;
    await saveViewerSet(key, nodes, catalog);
    popup.location.href = `./image-viewer.html?compare=${encodeURIComponent(key)}${initialSectionPath ? `&section=${encodeURIComponent(initialSectionPath)}` : ""}`;
  } catch (err) {
    popup.close();
    showError(err?.message || "Could not open the comparison window");
  }
}

async function loadResultsRoot(handle) {
  browserState.pressureRequestToken++;
  el.reconnect.hidden = true;
  el.panels.classList.remove("pressure-workspace-layout", "pressure-workspace-with-images");
  el.summary.hidden = true;
  el.panels.replaceChildren(Object.assign(document.createElement("div"), {
    className: "workspace-empty",
    textContent: `Indexing folders in ${handle.name}…`,
  }));
  if (handle.homoServer) await prefetchServerTree(handle);
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

// The browser only re-grants access to a remembered folder from a click,
// so a restored folder without permission gets a one-click reconnect.
function offerReconnect(handle) {
  showError(`Access to “${handle.name}” needs to be confirmed again.`);
  el.reconnect.textContent = `Reconnect ${handle.name}`;
  el.reconnect.hidden = false;
  el.reconnect.onclick = async () => {
    try {
      if (await handle.requestPermission({ mode: "read" }) !== "granted") {
        showError(`Access to “${handle.name}” was not granted. Use Open folder to choose a results folder.`);
        return;
      }
      showError("");
      await loadResultsRoot(handle);
    } catch (err) {
      showError(err?.message || "Could not reconnect the results folder");
    }
  };
}

// --- working directory (served by serve.py) ---------------------------

// Like CFD-Tool, the working directory is chosen once per user and saved
// by serve.py (outside the app folder). Results come from its finished/.
function showWorkingDirectoryChooser(config, message = "") {
  browserState.pressureRequestToken++;
  el.panels.classList.remove("pressure-workspace-layout", "pressure-workspace-with-images");
  el.panels.closest(".app")?.classList.remove("pressure-fullscreen");
  el.summary.hidden = true;

  const card = document.createElement("section");
  card.className = "working-dir-card";
  const title = document.createElement("h1");
  title.textContent = "Choose working directory";
  const intro = document.createElement("p");
  intro.textContent = "Select the folder that holds your CFD results — the same working directory CFD-Tool uses " +
    "(with finished, inProgress and archive inside). HoMo CFD lists the simulations in its finished folder; " +
    "a folder without finished is used as the results folder itself. The choice is saved for your user account on this computer.";
  card.append(title, intro);

  if (config.workingDir) {
    const current = document.createElement("p");
    current.className = "hint";
    current.textContent = `Current: ${config.workingDir} (from ${config.source}) · results from ${config.resultsPath}`;
    card.appendChild(current);
  }

  const status = document.createElement("p");
  status.className = "error";
  status.hidden = !message;
  status.textContent = message;

  const apply = async (request) => {
    status.hidden = true;
    card.querySelectorAll("button, input").forEach((control) => { control.disabled = true; });
    try {
      const result = await request();
      if (result?.cancelled) {
        card.querySelectorAll("button, input").forEach((control) => { control.disabled = false; });
        return;
      }
      location.reload();
    } catch (err) {
      status.textContent = err?.message || "Could not use that folder.";
      status.hidden = false;
      card.querySelectorAll("button, input").forEach((control) => { control.disabled = false; });
    }
  };

  const actions = document.createElement("div");
  actions.className = "working-dir-actions";
  if (config.canBrowse) {
    const browse = document.createElement("button");
    browse.type = "button";
    browse.className = "primary";
    browse.textContent = "Browse…";
    browse.title = "Opens a folder dialog on this computer (it may appear behind the browser window)";
    browse.addEventListener("click", () => apply(() => postServerJson("working-dir/browse")));
    actions.appendChild(browse);
  }
  const pathInput = document.createElement("input");
  pathInput.type = "text";
  pathInput.className = "working-dir-input";
  pathInput.placeholder = "or paste a folder path, e.g. D:\\CFD_tool";
  pathInput.setAttribute("aria-label", "Working directory path");
  pathInput.value = config.workingDir ?? "";
  const usePath = document.createElement("button");
  usePath.type = "button";
  usePath.className = "small-control";
  usePath.textContent = "Use this folder";
  usePath.addEventListener("click", () => apply(() => postServerJson("working-dir", { path: pathInput.value })));
  pathInput.addEventListener("keydown", (event) => { if (event.key === "Enter") usePath.click(); });
  actions.append(pathInput, usePath);
  card.append(actions, status);

  if (config.resultsRoot) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "small-control";
    back.textContent = "Keep current folder";
    back.addEventListener("click", () => location.reload());
    card.appendChild(back);
  }
  el.panels.replaceChildren(card);
}

async function startFilesystemWorkspace() {
  const openResults = document.getElementById("open-results");
  // Attached before the server check so an early click isn't lost.
  const serverConfig = getServerConfig();
  openResults.addEventListener("click", async () => {
    const config = await serverConfig;
    if (config) showWorkingDirectoryChooser(config);
    else chooseResultsRoot();
  });
  document.getElementById("open-3d-viewer").addEventListener("click", () => {
    const popup = window.open("./3d-viewer.html", "homo-cfd-3d", `popup,width=${screen.availWidth},height=${screen.availHeight},left=0,top=0`);
    if (!popup) showError("The 3D viewer window was blocked. Allow pop-ups for this local app and try again.");
  });
  document.getElementById("folder-search").addEventListener("input", (event) => {
    browserState.query = event.target.value.trim().toLowerCase();
    renderFilesystemTree();
  });
  el.panels.replaceChildren(Object.assign(document.createElement("div"), {
    className: "workspace-empty",
    textContent: "Open an image section from the results tree to start a comparison, then add cases in its viewer.",
  }));
  try {
    if (window.indexedDB) await pruneViewerEntries().catch(() => {});
    // Served by serve.py: the saved working directory needs no picker or permission.
    const config = await serverConfig;
    if (config) {
      openResults.textContent = "Working directory";
      openResults.title = config.workingDir ? `${config.workingDir} — click to change` : "Choose the folder that holds your results";
      if (!config.resultsRoot) {
        showWorkingDirectoryChooser(config);
        return;
      }
      await loadResultsRoot(new ServerDirectoryHandle("", config.resultsRoot));
      return;
    }
    // Opened without serve.py: choose a folder in the browser (Chrome/Edge).
    if (!window.showDirectoryPicker || !window.indexedDB) return;
    const handle = await getSavedResultsRoot();
    if (!handle) return;
    if (await handle.queryPermission({ mode: "read" }) !== "granted") {
      offerReconnect(handle);
      return;
    }
    await loadResultsRoot(handle);
  } catch (err) {
    showError(err?.message || "Could not restore the remembered results folder");
  }
}

startFilesystemWorkspace();
