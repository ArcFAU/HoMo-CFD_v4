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
  residualPaths: [],
  residualSlots: new Map(), // case path -> colour slot, kept while the case stays in the comparison
  residualEquation: "Continuity",
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
  // SLURM job logs (mesh.o123, resTAURANtS.o124, ...): the solver's holds the residuals.
  node.hasJobLogs = entries.some((child) => child.kind === "file" && /\.o\d+$/.test(child.name));
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
  if (node.hasJobLogs && node.handle?.homoServer) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-entry image-folder residuals-entry";
    button.dataset.path = `${node.path}#residuals`;
    button.textContent = "Residuals";
    button.title = `Residuals of ${node.name} from its solver log`;
    button.addEventListener("click", () => openResiduals(node));
    children.appendChild(button);
  }
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
  measurement.textContent = `${formatStation(chosen.position)} mm`;
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

// Forces get one decimal, L/D two; coefficients keep three.
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
    note.textContent = "Δ = simulation − reference";
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

    const sort = readTableSort();
    if (sort && sort.key !== SIMULATION_SORT_KEY && !visibleHeaders.some((column) => column.key === sort.key)) sort.key = null;
    [...headerRow.children].forEach((th, index) => {
      const key = index === 0 ? SIMULATION_SORT_KEY : visibleHeaders[index - 1].key;
      const button = cell("button", th.textContent);
      button.type = "button";
      button.className = "sort-button";
      button.title = "Sort by this column (click again for descending, a third time for the original order)";
      button.addEventListener("click", () => {
        writeTableSort(nextTableSort(readTableSort(), key));
        renderCsvTables(browserState.coefficientRows);
      });
      th.replaceChildren(button);
      th.setAttribute("aria-sort", sort?.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none");
    });

    const body = document.createElement("tbody");
    sortCoefficientRows(validRows, sort?.key ? sort : null, browserState.coefficientView === "delta" ? referenceRow : null).forEach((data) => {
      const sourceRow = data.rows[data.rows.length - 1] ?? [];
      const row = document.createElement("tr");
      if (data.path === referenceRow.path) row.className = "reference-row";
      const nameCell = cell("td", simulationNameFromCsvPath(data.path));
      nameCell.prepend(highlightToggle(data.path, row));
      row.appendChild(nameCell);
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

  const chartViewport = document.createElement("div");
  chartViewport.className = "monitor-chart-viewport";
  const draw = () => {
    browserState.monitorChartHeader = select.value;
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

// Sorting the table by a column: click a header for ascending, again for descending, a third time for the
// original order. Numbers sort by value (in Δ view by the difference from the reference), the Simulation column
// by name; empty cells always go last. The choice is remembered.
// Rows the user highlighted (star before the name), by coefficient file path; remembered per browser.
const HIGHLIGHT_KEY = "homo-cfd-highlighted-simulations-v1";

function readHighlights() {
  try {
    const saved = JSON.parse(localStorage.getItem(HIGHLIGHT_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

// The star that highlights a table row. It has no text of its own (CSS draws it), so the cell's text
// stays the simulation's name.
function highlightToggle(path, row) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-highlight";
  const show = (on) => {
    row.classList.toggle("highlighted-row", on);
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? "Remove the highlight" : "Highlight this row";
  };
  button.setAttribute("aria-label", `Highlight ${simulationNameFromCsvPath(path)}`);
  show(readHighlights().has(path));
  button.addEventListener("click", () => {
    const highlights = readHighlights();
    const on = !highlights.has(path);
    if (on) highlights.add(path); else highlights.delete(path);
    try {
      localStorage.setItem(HIGHLIGHT_KEY, JSON.stringify([...highlights]));
    } catch {}
    show(on);
  });
  return button;
}

const TABLE_SORT_KEY = "homo-cfd-coefficient-table-sort-v1";
const SIMULATION_SORT_KEY = "\u0000simulation";

function readTableSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(TABLE_SORT_KEY) || "null");
    return saved && typeof saved.key === "string" && (saved.direction === "asc" || saved.direction === "desc") ? saved : null;
  } catch {
    return null;
  }
}

function writeTableSort(sort) {
  try {
    if (sort) localStorage.setItem(TABLE_SORT_KEY, JSON.stringify(sort));
    else localStorage.removeItem(TABLE_SORT_KEY);
  } catch {
    // sorting still works for this view
  }
}

function nextTableSort(current, key) {
  if (current?.key !== key) return { key, direction: "asc" };
  return current.direction === "asc" ? { key, direction: "desc" } : null;
}

function sortCoefficientRows(rows, sort, referenceRow = null) {
  if (!sort) return rows;
  const sign = sort.direction === "desc" ? -1 : 1;
  const valueOf = (data) => {
    if (sort.key === SIMULATION_SORT_KEY) return simulationNameFromCsvPath(data.path);
    const value = coefficientValue(data, sort.key);
    const reference = referenceRow ? coefficientValue(referenceRow, sort.key) : 0;
    return value === null || reference === null ? null : value - reference;
  };
  return rows.map((data, index) => ({ data, index, value: valueOf(data) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) return (a.value === null) - (b.value === null) || a.index - b.index;
      const order = typeof a.value === "string" ? naturalOrder.compare(a.value, b.value) : a.value - b.value;
      return sign * order || a.index - b.index;
    })
    .map((entry) => entry.data);
}

function coefficientValue(data, header) {
  const index = data.headers.indexOf(header);
  if (index < 0) return null;
  const raw = String(data.rows[data.rows.length - 1]?.[index] ?? "").trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) ? value : null;  // an empty cell is no value, not 0
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

  // Dragging a row by its grip: the row moves among the others as the pointer passes their middles (the
  // list scrolls near its edges); the new order is taken from the rows when it is dropped. The pointer is
  // followed on the window, not on the grip: moving the row in the list ends the grip's pointer capture.
  const startDrag = (event, row) => {
    if (event.button !== 0) return;
    event.preventDefault();
    row.classList.add("dragging");
    let scroll = 0;
    const move = (moveEvent) => {
      const box = editor.getBoundingClientRect();
      scroll = moveEvent.clientY < box.top + 28 ? -8 : moveEvent.clientY > box.bottom - 28 ? 8 : 0;
      const before = [...editor.children].find((child) => {
        if (child === row) return false;
        const rect = child.getBoundingClientRect();
        return moveEvent.clientY < rect.top + rect.height / 2;
      });
      if (before) {
        if (row.nextElementSibling !== before) editor.insertBefore(row, before);
      } else if (editor.lastElementChild !== row) {
        editor.appendChild(row);
      }
    };
    const timer = setInterval(() => { if (scroll) editor.scrollTop += scroll; }, 16);
    const end = () => {
      clearInterval(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const order = [...editor.children].map((child) => child.dataset.key);
      columns.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
      renderEditor();
      editor.querySelectorAll(".column-drag-handle")[order.indexOf(row.dataset.key)]?.focus();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const renderEditor = () => {
    editor.replaceChildren(...columns.map((column, index) => {
      const row = document.createElement("div");
      row.className = "column-config-row";
      row.dataset.key = column.key;
      // The grip: drag with the mouse, or ↑/↓ while it has the focus.
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "column-drag-handle";
      handle.title = "Drag to move the column (or use the arrow keys)";
      handle.setAttribute("aria-label", `Move ${column.label}: drag, or the up and down arrow keys`);
      handle.addEventListener("pointerdown", (event) => startDrag(event, row));
      handle.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        const target = index + step;
        if (!step || target < 0 || target >= columns.length) return;
        event.preventDefault();
        columns.splice(target, 0, ...columns.splice(index, 1));
        renderEditor();
        editor.querySelectorAll(".column-drag-handle")[target].focus();
      });
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
      row.append(handle, visibility, labelInput);
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

// fresh: a tree from freshServerTree() to show instead of asking serve.py again.
async function loadResultsRoot(handle, fresh = null) {
  const token = ++browserState.renderToken;
  browserState.pressureRequestToken++;
  el.reconnect.hidden = true;
  el.panels.classList.remove("pressure-workspace-layout", "pressure-workspace-with-images");
  el.summary.hidden = true;
  el.panels.replaceChildren(Object.assign(document.createElement("div"), {
    className: "workspace-empty",
    textContent: `Indexing folders in ${handle.name}…`,
  }));
  // The results folder opens from serve.py's saved listing when there is one; it is
  // scanned again right after, and reloaded here if anything changed.
  let shown = null;
  if (fresh) {
    serverListings.clear();
    fillServerListings(handle.path, fresh);
  } else if (handle.homoServer) {
    shown = await prefetchServerTree(handle, { cached: handle.path === "" });
  }
  browserState.root = await buildFolderNode(handle);
  browserState.selectedFolder = null;
  browserState.selectedFile = null;
  renderFilesystemTree();
  // A settings card opened while indexing keeps the main panel.
  if (token !== browserState.renderToken) return;
  await selectFolder(browserState.root);
  if (shown) refreshResultsRoot(handle, shown);
}

// Results shown from the saved listing: scan the folder now and reload if something
// changed, unless the user has moved on (the next start then shows it).
async function refreshResultsRoot(handle, shown) {
  const token = browserState.renderToken;
  try {
    const fresh = await freshServerTree(handle, shown);
    if (fresh && token === browserState.renderToken) await loadResultsRoot(handle, fresh);
  } catch {
    // The saved listing stays; a scan error shows up on the next start.
  }
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
  browserState.renderToken++;
  browserState.pressureRequestToken++;
  el.panels.classList.remove("pressure-workspace-layout", "pressure-workspace-with-images");
  el.panels.closest(".app")?.classList.remove("pressure-fullscreen");
  el.summary.hidden = true;

  const card = document.createElement("section");
  card.className = "working-dir-card";
  const title = document.createElement("h1");
  title.textContent = "Choose working directory";
  const intro = document.createElement("p");
  intro.textContent = "First create a folder for your CFD results, e.g. D:\\HoMo-CFD-results, with two folders inside: " +
    "finished (one folder per simulation; HoMo CFD lists these) and inProgress (downloads from Fritz wait here until they are complete). " +
    "Then choose that folder here. The choice is saved for your user account on this computer.";
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

// Stage 7, step 2: the cases in the saved remote folder, their state from
// the job files on Fritz, and downloads into finished (via inProgress, like
// CFD-Tool). Nothing on Fritz is changed or deleted.
const CLUSTER_STATES = {
  prepared: "Not started",
  meshing: "Meshing",
  solving: "Solving",
  "waiting-post": "Solver done, post-processing queued",
  post: "Post-processing",
  ready: "Ready to download",
  "post-failed": "Post-processing failed (see the post log)",
};
const CLUSTER_REFRESH_MS = 5 * 60 * 1000;

function timeAgo(epochSeconds) {
  const hours = (Date.now() / 1000 - epochSeconds) / 3600;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// --- residuals -----------------------------------------------------------

// Line colours in this fixed order (validated for the dark panel: lightness band, colour-blind separation
// of neighbours, contrast). One simulation: one colour per equation. Several: one colour per simulation,
// kept while it stays in the comparison. Turbulence equations are dashed as well.
const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const TURBULENCE_EQUATION = /^(tke|sdr|tdr|intermittency|re_?theta)/i;
const MAX_RESIDUAL_CASES = 4;
const residualRequests = new Map(); // case path -> promise of /api/residuals

// Residuals, CzA and CxA per iteration of a simulation, from its STAR-CCM+ solver log (serve.py).
function residualsOf(path) {
  if (!residualRequests.has(path)) {
    const request = serverJson("residuals", path);
    request.catch(() => residualRequests.delete(path));
    residualRequests.set(path, request);
  }
  return residualRequests.get(path);
}

// Simulations whose folder has job logs (the cases the Residuals page can show).
function residualCaseNodes() {
  const nodes = [];
  const visit = (node) => {
    if (node.hasJobLogs) nodes.push(node);
    node.folders.forEach(visit);
  };
  if (browserState.root) visit(browserState.root);
  return nodes;
}

function openResiduals(node) {
  browserState.pressureRequestToken++;
  browserState.selectedFolder = node;
  browserState.selectedFile = null;
  browserState.residualPaths = [node.path];
  browserState.residualSlots = new Map([[node.path, 0]]);
  updateTreeSelection();
  renderResidualWorkspace();
}

// The Residuals page: one simulation (all equations, CzA and CxA below), or up to four compared
// (one equation at a time, one line per simulation).
async function renderResidualWorkspace() {
  const token = ++browserState.renderToken;
  const paths = browserState.residualPaths;
  const nodes = residualCaseNodes();
  const nameOf = (path) => nodes.find((node) => node.path === path)?.name ?? path.split("/").pop();
  const colorOf = (path) => SERIES_COLORS[browserState.residualSlots.get(path) ?? 0];
  el.panels.closest(".app")?.classList.remove("pressure-fullscreen");
  el.panels.classList.remove("pressure-workspace-layout", "pressure-workspace-with-images");
  el.summary.hidden = false;
  const heading = document.createElement("h1");
  heading.className = "workspace-title";
  heading.textContent = paths.length === 1 ? `${nameOf(paths[0])} · residuals` : "Residuals";
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "small-control";
  backButton.textContent = "Back to coefficients";
  backButton.addEventListener("click", () => selectFolder(browserState.selectedFolder ?? browserState.root));
  el.summary.replaceChildren(heading, backButton);

  const toolbar = document.createElement("section");
  toolbar.className = "pressure-toolbar residual-toolbar";
  const caseSelect = document.createElement("select");
  caseSelect.setAttribute("aria-label", "Add simulation to compare");
  caseSelect.add(new Option("Compare with…", ""));
  nodes.filter((node) => !paths.includes(node.path)).forEach((node) => caseSelect.add(new Option(node.name, node.path)));
  caseSelect.disabled = paths.length >= MAX_RESIDUAL_CASES || caseSelect.options.length < 2;
  caseSelect.addEventListener("change", () => {
    if (!caseSelect.value || paths.length >= MAX_RESIDUAL_CASES) return;
    const used = new Set(browserState.residualSlots.values());
    browserState.residualSlots.set(caseSelect.value, [...SERIES_COLORS.keys()].find((slot) => !used.has(slot)));
    paths.push(caseSelect.value);
    renderResidualWorkspace();
  });
  toolbar.appendChild(caseSelect);
  const chips = document.createElement("div");
  chips.className = "residual-case-chips";
  if (paths.length > 1) {
    paths.forEach((path) => {
      const chip = document.createElement("span");
      chip.className = "residual-case-chip";
      chip.append(lineSwatch(colorOf(path), false), nameOf(path));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${nameOf(path)}`);
      remove.addEventListener("click", () => {
        browserState.residualPaths = paths.filter((entry) => entry !== path);
        browserState.residualSlots.delete(path);
        renderResidualWorkspace();
      });
      chip.appendChild(remove);
      chips.appendChild(chip);
    });
  }
  const body = document.createElement("div");
  body.className = "residual-body";
  body.appendChild(Object.assign(document.createElement("div"), { className: "workspace-empty", textContent: "Reading the solver logs…" }));
  el.panels.replaceChildren(toolbar, chips, body);

  const results = await Promise.all(paths.map((path) => residualsOf(path).catch((err) => ({ error: err?.message || "Could not read the residuals." }))));
  if (token !== browserState.renderToken) return;
  const notes = [];
  const cases = [];
  results.forEach((data, index) => {
    if (data.error) notes.push(`${nameOf(paths[index])}: ${data.error}`);
    else if (!data.iterations?.length) notes.push(`${nameOf(paths[index])}: none of its job logs has the solver's iteration table.`);
    else cases.push({ path: paths[index], name: nameOf(paths[index]), color: colorOf(paths[index]), data });
  });
  const cards = notes.map((text) => Object.assign(document.createElement("p"), { className: "error", textContent: text }));
  if (!cases.length) {
    body.replaceChildren(...cards);
    return;
  }

  const card = (title, ...content) => {
    const section = document.createElement("section");
    section.className = "csv-card residual-card";
    section.append(Object.assign(document.createElement("h2"), { className: "csv-card-title", textContent: title }), ...content);
    return section;
  };
  const span = (data) => `iterations ${data.iterations[0]}–${data.iterations[data.iterations.length - 1]}`;
  if (cases.length === 1) {
    const { data, color } = cases[0];
    const series = data.names.map((name, index) => ({ label: name, color: SERIES_COLORS[index % SERIES_COLORS.length],
      dashed: TURBULENCE_EQUATION.test(name), x: data.iterations, y: data.values.map((row) => row[index]) }));
    cards.push(card(`Residuals, ${span(data)}`, residualLegend(series), lineChart(series, { log: true, label: "Residuals" })));
    ["CzA", "CxA"].forEach((monitor) => {
      const index = data.monitors?.names.indexOf(monitor) ?? -1;
      if (index < 0) return;
      cards.push(card(`${monitor} (total)`, lineChart([{ label: monitor, color, x: data.iterations, y: data.monitors.values.map((row) => row[index]) }], { label: monitor })));
    });
  } else {
    const equations = [...new Set(cases.flatMap(({ data }) => data.names))];
    if (!equations.includes(browserState.residualEquation)) browserState.residualEquation = equations[0];
    const equationSelect = document.createElement("select");
    equationSelect.setAttribute("aria-label", "Equation");
    equations.forEach((name) => equationSelect.add(new Option(name, name)));
    equationSelect.value = browserState.residualEquation;
    equationSelect.addEventListener("change", () => {
      browserState.residualEquation = equationSelect.value;
      renderResidualWorkspace();
    });
    toolbar.appendChild(equationSelect);
    const perCase = (column, names, rows) => cases.map(({ name, color, data }) => {
      const index = names(data).indexOf(column);
      return index < 0 ? null : { label: name, color, x: data.iterations, y: rows(data).map((row) => row[index]) };
    }).filter(Boolean);
    const equation = browserState.residualEquation;
    cards.push(card(`${equation} residual`, lineChart(perCase(equation, (data) => data.names, (data) => data.values), { log: true, label: `${equation} residual` })));
    ["CzA", "CxA"].forEach((monitor) => {
      const series = perCase(monitor, (data) => data.monitors?.names ?? [], (data) => data.monitors.values);
      if (series.length) cards.push(card(`${monitor} (total)`, lineChart(series, { label: monitor })));
    });
  }
  body.replaceChildren(...cards);
}

// Legend for the single-simulation residual chart: each equation's line and its last residual.
function residualLegend(series) {
  const legend = document.createElement("ul");
  legend.className = "residual-legend";
  series.forEach(({ label, color, dashed, y }) => {
    const item = document.createElement("li");
    item.append(lineSwatch(color, dashed), `${label} `);
    const value = document.createElement("span");
    value.className = "residual-value";
    value.textContent = formatSeriesValue(y[y.length - 1], true);
    item.appendChild(value);
    legend.appendChild(item);
  });
  return legend;
}

function lineSwatch(color, dashed) {
  const namespace = "http://www.w3.org/2000/svg";
  const swatch = document.createElementNS(namespace, "svg");
  swatch.setAttribute("class", "residual-swatch");
  swatch.setAttribute("viewBox", "0 0 22 6");
  const line = document.createElementNS(namespace, "line");
  Object.entries({ x1: 1, y1: 3, x2: 21, y2: 3, stroke: color, "stroke-width": 2, "stroke-linecap": "round" })
    .forEach(([key, value]) => line.setAttribute(key, String(value)));
  if (dashed) line.setAttribute("stroke-dasharray", "5 3");
  swatch.appendChild(line);
  return swatch;
}

function formatSeriesValue(value, log) {
  if (!Number.isFinite(value)) return "–";
  return log ? value.toExponential(2) : value.toFixed(3);
}

// Index of the x value nearest to target in an ascending array.
function nearestIndex(values, target) {
  let low = 0, high = values.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle; else high = middle;
  }
  return Math.abs(values[high] - target) < Math.abs(values[low] - target) ? high : low;
}

// Line chart over iterations, log scale (residuals) or linear (CzA, CxA). A linear scale fits the values
// after the first 10 % of the iterations, so the start-up does not flatten the rest (lines are clipped).
// Hover: a crosshair with every line's value at that iteration.
function lineChart(series, { log = false, label = "" } = {}) {
  const namespace = "http://www.w3.org/2000/svg";
  const width = 960, height = log ? 360 : 240, left = 64, right = 16, top = 12, bottom = 34;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const first = Math.min(...series.map((line) => line.x[0])), last = Math.max(...series.map((line) => line.x[line.x.length - 1]));
  const x = (iteration) => left + (last === first ? plotWidth / 2 : (iteration - first) / (last - first) * plotWidth);
  let low = Infinity, high = -Infinity;
  const settled = first + 0.1 * (last - first);
  series.forEach((line) => line.y.forEach((value, at) => {
    if (log ? !(value > 0) : !Number.isFinite(value) || line.x[at] < settled) return;
    low = Math.min(low, value); high = Math.max(high, value);
  }));
  if (low > high) { low = log ? 1e-6 : 0; high = log ? 1 : 1; }
  let ticks, y;
  if (log) {
    const lowDecade = Math.floor(Math.log10(low)), highDecade = Math.max(lowDecade + 1, Math.ceil(Math.log10(high)));
    ticks = Array.from({ length: highDecade - lowDecade + 1 }, (_, index) => 10 ** (lowDecade + index));
    y = (value) => top + (highDecade - Math.log10(value)) / (highDecade - lowDecade) * plotHeight;
  } else {
    const pad = Math.max((high - low) * 0.08, Math.abs(high) * 1e-4, 1e-9);
    ticks = createTicks(low - pad, high + pad, 7);
    const bottomValue = Math.min(low - pad, ticks[0]), topValue = Math.max(high + pad, ticks[ticks.length - 1]);
    y = (value) => top + (topValue - value) / (topValue - bottomValue) * plotHeight;
  }
  const element = (tag, attributes, text) => {
    const node = document.createElementNS(namespace, tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svg = element("svg", { class: "residual-chart", viewBox: `0 0 ${width} ${height}`, role: "img",
    "aria-label": `${label} over iterations ${first}–${last}${log ? ", log scale" : ""}: ${series.map((line) => line.label).join(", ")}` });
  const clipId = `chart-clip-${++lineChart.count}`;
  const clip = element("clipPath", { id: clipId });
  clip.appendChild(element("rect", { x: left, y: top, width: plotWidth, height: plotHeight }));
  svg.appendChild(clip);
  ticks.forEach((tick) => {
    svg.appendChild(element("line", { class: "residual-grid", x1: left, x2: width - right, y1: y(tick), y2: y(tick) }));
    svg.appendChild(element("text", { class: "residual-tick", x: left - 6, y: y(tick) + 4, "text-anchor": "end" },
      log ? `1e${Math.round(Math.log10(tick))}` : formatTick(tick)));
  });
  createTicks(first, last, 7).forEach((tick) => {
    svg.appendChild(element("text", { class: "residual-tick", x: x(tick), y: height - bottom + 16, "text-anchor": "middle" }, String(Math.round(tick))));
  });
  svg.appendChild(element("text", { class: "residual-tick", x: left + plotWidth / 2, y: height - 4, "text-anchor": "middle" }, "Iteration"));
  svg.appendChild(element("line", { class: "residual-axis", x1: left, x2: width - right, y1: top + plotHeight, y2: top + plotHeight }));
  series.forEach((line) => {
    let path = "";
    line.y.forEach((value, at) => {
      if (log ? !(value > 0) : !Number.isFinite(value)) return;
      path += `${path ? "L" : "M"}${x(line.x[at]).toFixed(1)},${y(value).toFixed(1)}`;
    });
    const drawn = element("path", { class: "residual-line", d: path, stroke: line.color, "clip-path": `url(#${clipId})` });
    if (line.dashed) drawn.setAttribute("stroke-dasharray", "6 4");
    drawn.appendChild(element("title", {}, line.label));
    svg.appendChild(drawn);
  });

  const crosshair = element("line", { class: "residual-crosshair", y1: top, y2: top + plotHeight, visibility: "hidden" });
  const dots = series.map((line) => element("circle", { class: "residual-dot", r: 4, fill: line.color, visibility: "hidden" }));
  svg.append(crosshair, ...dots);
  const wrap = document.createElement("div");
  wrap.className = "residual-chart-wrap";
  const tooltip = document.createElement("div");
  tooltip.className = "residual-tooltip";
  tooltip.hidden = true;
  wrap.append(svg, tooltip);
  const hide = () => {
    tooltip.hidden = true;
    crosshair.setAttribute("visibility", "hidden");
    dots.forEach((dot) => dot.setAttribute("visibility", "hidden"));
  };
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const pointerX = (event.clientX - box.left) * width / box.width;
    if (pointerX < left || pointerX > width - right) return hide();
    const target = Math.round(first + (pointerX - left) / plotWidth * (last - first));
    crosshair.setAttribute("x1", x(target));
    crosshair.setAttribute("x2", x(target));
    crosshair.setAttribute("visibility", "visible");
    const rows = series.map((line, index) => {
      const at = nearestIndex(line.x, target), value = line.y[at];
      const shown = Math.abs(line.x[at] - target) <= 1 && (log ? value > 0 : Number.isFinite(value));
      dots[index].setAttribute("visibility", shown ? "visible" : "hidden");
      if (shown) { dots[index].setAttribute("cx", x(line.x[at])); dots[index].setAttribute("cy", y(value)); }
      const row = document.createElement("div");
      row.append(lineSwatch(line.color, line.dashed), `${line.label} `, cell("span", shown ? formatSeriesValue(value, log) : "–"));
      return row;
    });
    tooltip.replaceChildren(cell("strong", `Iteration ${target}`), ...rows);
    tooltip.hidden = false;
    const scale = box.width / width;
    const flip = x(target) > width * 0.66;
    tooltip.style.left = `${x(target) * scale + (flip ? -12 : 12)}px`;
    tooltip.style.transform = flip ? "translateX(-100%)" : "";
    tooltip.style.top = `${top * scale + 8}px`;
  });
  return wrap;
}
lineChart.count = 0;

// Columns of Results on Fritz: the results table's names for the monitors and computed columns.
const CLUSTER_RESULT_COLUMNS = ["Iteration", "CzA", "CxA", "L/D", "Downforce [N]", "Drag [N]",
  "CzA FW", "CxA FW", "CzA UT", "CxA UT", "CzA RW", "CxA RW"];

function renderClusterResults(table, cases) {
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(cell("th", "Case"));
  CLUSTER_RESULT_COLUMNS.forEach((title) => {
    const th = cell("th", title);
    const derived = derivedAeroColumn(title);
    if (derived) {
      th.classList.add("derived-column");
      th.title = `Computed by HoMo CFD. ${derived.note}`;
    }
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  const body = document.createElement("tbody");
  cases.filter((item) => item.results).forEach((item) => {
    const data = withComputedColumns({ path: item.name, headers: item.results.headers, rows: [item.results.values] });
    const values = {};
    data.headers.forEach((header, index) => {
      const key = /^iteration$/i.test(header) ? "Iteration" : CLUSTER_RESULT_COLUMNS.includes(header) ? header : classifyHeader(header);
      if (key && !(key in values)) values[key] = data.rows[0][index];
    });
    const row = document.createElement("tr");
    row.dataset.case = item.name;
    row.appendChild(cell("td", item.name));
    CLUSTER_RESULT_COLUMNS.forEach((title) => row.appendChild(cell("td", formatCoefficientValue(title, values[title] ?? ""))));
    body.appendChild(row);
  });
  table.replaceChildren(head, body);
}

function clusterCasesSection({ saved, onNeedsPassphrase, templateFolder }) {
  const section = document.createElement("section");
  section.className = "cluster-cases";
  const header = document.createElement("div");
  header.className = "cluster-cases-header";
  const title = document.createElement("h2");
  title.textContent = "Simulations on Fritz";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "small-control";
  refreshButton.id = "cluster-refresh";
  refreshButton.textContent = "Refresh";
  const checked = document.createElement("span");
  checked.className = "hint";
  const includeSim = document.createElement("label");
  includeSim.className = "hint cluster-include-sim";
  const includeSimBox = document.createElement("input");
  includeSimBox.type = "checkbox";
  includeSimBox.id = "cluster-include-sim";
  includeSim.append(includeSimBox, " Also download .sim files (10–20 GB each)");
  header.append(title, refreshButton, checked, includeSim);
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = "The state comes from each case's job files on Fritz: plots/DONE when the solver has finished, and the post-processing " +
    "log for \"Ready to download\". Downloads go to inProgress first and move to finished when complete; an interrupted download resumes. " +
    "Job scripts, macros and .sim~ backups are skipped. Nothing on Fritz is changed or deleted.";
  const status = document.createElement("p");
  status.className = "cluster-status";
  status.hidden = true;
  const tableWrap = document.createElement("div");
  tableWrap.className = "csv-table-wrap";
  const table = document.createElement("table");
  table.className = "data-table cluster-table";
  tableWrap.appendChild(table);
  // Results of the cases on Fritz (last row of each case's coefficients CSV, read by the same
  // status check), with the same columns and force settings as the results table.
  const results = document.createElement("div");
  results.className = "cluster-results";
  results.hidden = true;
  const resultsTitle = document.createElement("h2");
  resultsTitle.textContent = "Results on Fritz";
  const resultsWrap = document.createElement("div");
  resultsWrap.className = "csv-table-wrap";
  const resultsTable = document.createElement("table");
  resultsTable.className = "data-table cluster-results-table";
  resultsWrap.appendChild(resultsTable);
  results.append(resultsTitle, resultsWrap);
  section.append(header, note, status, tableWrap, results);
  const newCase = newCaseSection({
    getCases: () => lastResult?.cases ?? [],
    templateFolder: templateFolder || "SCRIPT_FABSI",
    onCreated: () => refresh(),
  });
  section.appendChild(newCase);

  let lastResult = null;
  let pollTimer = null;
  let notice = null;  // message to keep after the next refresh
  const showStatus = (text, kind) => {
    status.textContent = text;
    status.className = `cluster-status ${kind}`;
    status.hidden = !text;
  };

  const actionCell = (item, canDownload) => {
    const td = document.createElement("td");
    td.className = "cluster-action";
    if (item.state === "prepared" && lastResult?.canSubmit && !item.jobs?.length && !item.submittedJob) {
      const start = document.createElement("button");
      start.type = "button";
      start.className = "primary small";
      start.textContent = "Start";
      start.title = "Runs sbatch mesh.sh in this folder on Fritz; meshing, solving and post-processing then follow one after another.";
      start.addEventListener("click", async () => {
        if (!window.confirm(`Start ${item.name} on Fritz? This submits mesh.sh to SLURM and uses compute time; ` +
          "the solver and post-processing jobs follow automatically.")) return;
        start.disabled = true;
        try {
          const result = await postServerJson("cluster/submit", { case: item.name });
          if (!result.ok) throw new Error([result.error, result.hint].filter(Boolean).join(" "));
          notice = [`${item.name} started: job ${result.jobId}.`, "cluster-ok"];
          refresh();
        } catch (err) {
          showStatus(err?.message || "Could not start the job.", "error");
          start.disabled = false;
        }
      });
      td.appendChild(start);
      return td;
    }
    const download = item.download;
    if (download?.state === "running") {
      const total = download.filesTotal ?? "…";
      td.append(`Downloading ${download.filesDone} / ${total} files `);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "small-control";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        try {
          await postServerJson("cluster/download/cancel", { case: item.name });
        } catch (err) {
          showStatus(err?.message || "Could not cancel.", "error");
        }
      });
      td.appendChild(cancel);
      return td;
    }
    if (download?.state === "done" || item.local === "finished") {
      td.append(download?.state === "done" ? "Downloaded " : "In finished");
      if (download?.state === "done") {
        const reload = document.createElement("button");
        reload.type = "button";
        reload.className = "small-control";
        reload.textContent = "Reload results";
        reload.addEventListener("click", () => location.reload());
        td.appendChild(reload);
      }
      return td;
    }
    if (download?.message) td.append(`${download.message} `);
    if (!canDownload || !item.downloadable || (item.state === "prepared" && item.local !== "partial")) return td;
    const allowed = item.state === "ready" || item.state === "post-failed" || item.stale || item.local === "partial";
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.state === "ready" ? "primary small" : "small-control";
    button.textContent = item.local === "partial" ? "Resume download"
      : item.state === "post-failed" || (item.state !== "ready" && item.stale) ? "Download anyway" : "Download";
    button.disabled = !allowed;
    button.title = allowed ? "" : "Available once post-processing has finished";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await postServerJson("cluster/download", { case: item.name, includeSim: includeSimBox.checked });
        showStatus("", "");
        pollDownloads();
      } catch (err) {
        showStatus(err?.message || "Could not start the download.", "error");
        button.disabled = false;
      }
    });
    td.appendChild(button);
    return td;
  };

  const render = () => {
    const result = lastResult;
    table.replaceChildren();
    if (!result) return;
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Case", "State", "Last job log", "On this computer", ""].forEach((label) => headRow.appendChild(cell("th", label)));
    head.appendChild(headRow);
    const body = document.createElement("tbody");
    result.cases.forEach((item) => {
      const row = document.createElement("tr");
      row.dataset.case = item.name;
      row.appendChild(cell("td", item.name));
      const state = cell("td", CLUSTER_STATES[item.state] ?? item.state);
      state.className = `cluster-state cluster-state-${item.state}${item.stale ? " cluster-stale" : ""}`;
      if (item.stale && !item.jobs?.length) state.append(" · probably stopped (no job log update for over 12 h)");
      state.append(jobDescription(item));
      row.appendChild(state);
      row.appendChild(cell("td", item.lastLog ? timeAgo(item.lastLog) : "—"));
      row.appendChild(cell("td", item.local === "finished" ? "In finished" : item.local === "partial" ? "Partly downloaded" : "—"));
      row.appendChild(actionCell(item, result.canDownload));
      body.appendChild(row);
    });
    table.append(head, body);
    renderClusterResults(resultsTable, result.cases);
    results.hidden = !resultsTable.tBodies[0]?.rows.length;
    if (!result.canDownload) {
      showStatus("To download, set the working directory to the CFD-Tool folder that contains finished and inProgress.", "hint");
    }
  };

  const pollDownloads = async () => {
    clearTimeout(pollTimer);
    if (!section.isConnected || !lastResult) return;
    try {
      const downloads = await (await fetch("/api/cluster/downloads")).json();
      let running = false;
      let changed = false;
      lastResult.cases.forEach((item) => {
        const download = downloads[item.name];
        if (!download) return;
        if (item.download?.state === "running" && download.state !== "running") changed = true;
        item.download = download;
        running ||= download.state === "running";
      });
      render();
      if (running) pollTimer = setTimeout(pollDownloads, 2000);
      else if (changed) refresh();
    } catch {
      pollTimer = setTimeout(pollDownloads, 5000);
    }
  };

  const refresh = async () => {
    if (!section.isConnected && lastResult) return;
    refreshButton.disabled = true;
    showStatus("Checking Fritz… (a few seconds)", "hint");
    try {
      const result = await postServerJson("cluster/cases", {});
      if (!result.ok) {
        showStatus([result.error, result.hint].filter(Boolean).join(" "), "error");
        if (result.needsPassphrase) onNeedsPassphrase();
        return;
      }
      lastResult = result;
      newCase.updateSources();
      checked.textContent = `checked ${new Date(result.checkedAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      showStatus(...(notice ?? ["", ""]));
      notice = null;
      render();
      if (result.cases.some((item) => item.download?.state === "running")) pollDownloads();
    } catch (err) {
      showStatus(err?.message || "Could not check Fritz.", "error");
    } finally {
      refreshButton.disabled = false;
    }
  };

  refreshButton.addEventListener("click", refresh);
  section.refresh = refresh;
  section.start = () => {
    if (!saved) {
      showStatus("Save your WinSCP session and remote folder above, then click Refresh.", "hint");
      return;
    }
    refresh();
    const timer = setInterval(() => {
      if (!section.isConnected) clearInterval(timer);
      else refresh();
    }, CLUSTER_REFRESH_MS);
  };
  return section;
}

// Steps 3-4: a new simulation on Fritz from the team template (SCRIPT_FABSI by
// default): name, Settings (from the template or an existing case, editable
// here) and the base .sim from this computer. HoMo CFD creates the folder only
// if the name is free, copies the template, then uploads Settings and the .sim.
const SETTINGS_OPEN_GROUPS = new Set(["Vehicle State", "Run Settings"]);

function newCaseSection({ getCases, templateFolder, onCreated }) {
  const section = document.createElement("details");
  section.className = "cluster-new-case";
  const summary = document.createElement("summary");
  summary.textContent = "New simulation on Fritz";
  const intro = document.createElement("p");
  intro.className = "hint";
  intro.textContent = `Creates a new folder on Fritz as a copy of the template folder (${templateFolder}: job scripts and macros), ` +
    "with the Settings below and your base .sim. It never changes an existing folder. Start it afterwards from the list above. " +
    "Nodes and run times come from the template's job scripts; the Run Settings values here do not change them.";

  const field = (labelText, control) => {
    const label = document.createElement("label");
    label.className = "cluster-field";
    label.appendChild(Object.assign(document.createElement("span"), { className: "cluster-label", textContent: labelText }));
    label.appendChild(control);
    return label;
  };
  const name = Object.assign(document.createElement("input"), { type: "text", id: "new-case-name", className: "working-dir-input",
    placeholder: "e.g. 1002_mk4_yaw3 (letters, numbers, _ - .)" });
  const source = Object.assign(document.createElement("select"), { id: "new-case-source", className: "working-dir-input" });
  const load = Object.assign(document.createElement("button"), { type: "button", className: "small-control", id: "new-case-load",
    textContent: "Load Settings" });
  const sourceRow = field("Settings from", source);
  sourceRow.appendChild(load);
  const sim = Object.assign(document.createElement("input"), { type: "text", id: "new-case-sim", className: "working-dir-input",
    placeholder: "Base .sim on this computer, e.g. D:\\CFD\\UPSI_CFD_BASE.sim" });
  const browse = Object.assign(document.createElement("button"), { type: "button", className: "small-control", textContent: "Browse…" });
  const simRow = field("Base .sim", sim);
  simRow.appendChild(browse);
  const editor = document.createElement("div");
  editor.className = "settings-editor";
  editor.id = "new-case-settings";
  const create = Object.assign(document.createElement("button"), { type: "button", className: "primary", id: "new-case-create",
    textContent: "Create on Fritz", disabled: true });
  const status = Object.assign(document.createElement("p"), { className: "cluster-status", hidden: true });
  section.append(summary, intro, field("Name", name), sourceRow, editor, simRow, create, status);

  const showStatus = (text, kind) => {
    status.textContent = text;
    status.className = `cluster-status ${kind}`;
    status.hidden = !text;
  };
  let loaded = null;

  section.updateSources = () => {
    const current = source.value;
    source.replaceChildren(new Option(`Template (${templateFolder})`, ""));
    getCases().filter((item) => item.downloadable).forEach((item) => source.add(new Option(`Copy of ${item.name}`, item.name)));
    source.value = [...source.options].some((option) => option.value === current) ? current : "";
  };

  const renderEditor = (pairs) => {
    const groups = new Map();
    pairs.forEach(([key, value]) => {
      const [group, ...rest] = key.split("/");
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push({ key, label: rest.join(" / ") || group, value });
    });
    editor.replaceChildren(...[...groups].map(([group, entries]) => {
      const box = document.createElement("details");
      box.className = "settings-group";
      box.open = SETTINGS_OPEN_GROUPS.has(group);
      box.appendChild(Object.assign(document.createElement("summary"), { textContent: `${group} (${entries.length})` }));
      const grid = document.createElement("div");
      grid.className = "settings-grid";
      entries.forEach((entry) => {
        const input = Object.assign(document.createElement("input"), { type: "text", value: entry.value });
        input.dataset.key = entry.key;
        input.dataset.original = entry.value;
        input.setAttribute("aria-label", entry.key);
        input.addEventListener("input", () => input.classList.toggle("changed", input.value !== input.dataset.original));
        grid.append(Object.assign(document.createElement("span"), { textContent: entry.label, title: entry.key }), input);
      });
      box.appendChild(grid);
      return box;
    }));
  };

  load.addEventListener("click", async () => {
    load.disabled = true;
    showStatus("Reading Settings from Fritz…", "hint");
    try {
      const result = await postServerJson("cluster/settings-file", { source: source.value });
      loaded = result.source;
      renderEditor(result.settings);
      create.disabled = false;
      showStatus(`Settings loaded from ${result.source}. Changed values are highlighted.`, "hint");
    } catch (err) {
      showStatus(err?.message || "Could not read the Settings.", "error");
    } finally {
      load.disabled = false;
    }
  });

  browse.addEventListener("click", async () => {
    browse.disabled = true;
    try {
      const result = await postServerJson("cluster/browse-sim", { initial: "" });
      if (result.path) {
        sim.value = result.path;
        if (result.size) showStatus(`${result.path} · ${(result.size / 1e9).toFixed(2)} GB`, "hint");
      }
    } catch (err) {
      showStatus(err?.message || "Could not open the file dialog.", "error");
    } finally {
      browse.disabled = false;
    }
  });

  const pollTask = async (caseName) => {
    try {
      const tasks = await (await fetch("/api/cluster/new-case")).json();
      const task = tasks[caseName];
      if (task?.state === "running") {
        showStatus(`${caseName}: ${task.message || "working…"}`, "hint");
        setTimeout(() => pollTask(caseName), 2000);
        return;
      }
      showStatus(`${caseName}: ${task?.message ?? "finished."}`, task?.state === "done" ? "cluster-ok" : "error");
      create.disabled = false;
      if (task?.state === "done") onCreated();
    } catch {
      setTimeout(() => pollTask(caseName), 5000);
    }
  };

  create.addEventListener("click", async () => {
    const settings = [...editor.querySelectorAll("input[data-key]")].map((input) => [input.dataset.key, input.value]);
    const caseName = name.value.trim();
    const changed = editor.querySelectorAll("input.changed").length;
    if (!window.confirm(`Create ${caseName || "(no name)"} on Fritz from ${loaded} (${changed} changed setting${changed === 1 ? "" : "s"}) ` +
      "and upload the .sim? Nothing is started yet.")) return;
    create.disabled = true;
    try {
      await postServerJson("cluster/new-case", { name: caseName, settings, simPath: sim.value });
      pollTask(caseName);
    } catch (err) {
      showStatus(err?.message || "Could not create the simulation.", "error");
      create.disabled = false;
    }
  });
  return section;
}

function jobDescription(item) {
  const job = item.jobs?.[0];
  if (job) {
    const state = job.state === "PENDING" ? "Queued" : job.state === "RUNNING" ? `Running ${job.elapsed}` : job.state.toLowerCase();
    return ` · ${state} (job ${job.id}, ${job.name})`;
  }
  return item.submittedJob ? ` · submitted (job ${item.submittedJob})` : "";
}

// Stage 7, step 1: the WinSCP saved session used for Fritz and the remote
// folder. HoMo CFD stores only these two names; the login (host, user, key)
// stays in WinSCP. Testing only logs in and prints the folder.
async function showClusterSettings() {
  // Cancel pending table and pressure renders so they don't replace this card.
  browserState.renderToken++;
  browserState.pressureRequestToken++;
  el.panels.classList.remove("pressure-workspace-layout", "pressure-workspace-with-images");
  el.panels.closest(".app")?.classList.remove("pressure-fullscreen");
  el.summary.hidden = true;

  const card = document.createElement("section");
  card.className = "working-dir-card cluster-card";
  const title = document.createElement("h1");
  title.textContent = "Fritz cluster";
  const intro = document.createElement("p");
  intro.textContent = "HoMo CFD connects to Fritz through WinSCP, like CFD-Tool. Choose the WinSCP saved session you use for Fritz: " +
    "it holds your host, user name and key, and HoMo CFD only remembers the session's name. Both settings are saved for your user " +
    "account on this computer. Testing only logs in and shows the folder; nothing is uploaded, started or deleted.";
  card.append(title, intro);
  el.panels.replaceChildren(card);

  let config;
  try {
    const response = await fetch("/api/cluster");
    config = await response.json();
    if (!response.ok) throw new Error(config?.error || `Server request failed (${response.status})`);
  } catch (err) {
    card.appendChild(Object.assign(document.createElement("p"), { className: "error", textContent: err?.message || "Could not read the cluster settings." }));
    return;
  }

  const winscp = document.createElement("p");
  winscp.className = config.winscp ? "hint" : "error";
  winscp.textContent = config.winscp
    ? `WinSCP: ${config.winscp}`
    : "WinSCP is not installed (WinSCP.com not found). Install WinSCP, as for CFD-Tool, then reopen this page.";
  card.appendChild(winscp);
  const pageantStatus = document.createElement("p");
  pageantStatus.className = "hint";
  pageantStatus.id = "pageant-status";
  const describePageant = (running) => {
    pageantStatus.textContent = !config.pageant?.found
      ? "Pageant (PuTTY's key agent) was not found. It is only needed if your key has a passphrase; install PuTTY to get it."
      : running
        ? "Pageant is running. Keys unlocked in it are used automatically."
        : "Pageant is not running. If your key has a passphrase, unlock it with Pageant before testing.";
  };
  describePageant(config.pageant?.running);
  card.appendChild(pageantStatus);

  const sessionField = document.createElement("label");
  sessionField.className = "cluster-field";
  sessionField.appendChild(Object.assign(document.createElement("span"), { className: "cluster-label", textContent: "WinSCP session" }));
  let session;
  const sessions = [...config.sessions];
  if (config.session && !sessions.includes(config.session)) sessions.unshift(config.session);
  if (sessions.length) {
    session = document.createElement("select");
    session.add(new Option("Choose a session…", ""));
    sessions.forEach((name) => session.add(new Option(name, name)));
    session.value = config.session || (sessions.length === 1 ? sessions[0] : "");
  } else {
    session = document.createElement("input");
    session.type = "text";
    session.placeholder = "No saved sessions found: create one in WinSCP, or type its name";
    session.value = config.session;
  }
  session.id = "cluster-session";
  session.className = "working-dir-input";
  sessionField.appendChild(session);

  const folderField = document.createElement("label");
  folderField.className = "cluster-field";
  folderField.appendChild(Object.assign(document.createElement("span"), { className: "cluster-label", textContent: "Remote folder" }));
  const folder = document.createElement("input");
  folder.type = "text";
  folder.id = "cluster-folder";
  folder.className = "working-dir-input";
  folder.placeholder = "e.g. /home/vault/<group>/<user>/Pipeline (optional for the test)";
  folder.value = config.remoteFolder;
  folderField.appendChild(folder);

  const submitField = document.createElement("label");
  submitField.className = "cluster-field";
  submitField.appendChild(Object.assign(document.createElement("span"), { className: "cluster-label", textContent: "Session for starting jobs" }));
  const submitSession = document.createElement("select");
  submitSession.id = "cluster-submit-session";
  submitSession.className = "working-dir-input";
  submitSession.add(new Option("None (starting jobs disabled)", ""));
  sessions.forEach((name) => submitSession.add(new Option(name, name)));
  if (config.submitSession && !sessions.includes(config.submitSession)) submitSession.add(new Option(config.submitSession, config.submitSession));
  submitSession.value = config.submitSession || "";
  submitSession.title = "A WinSCP session to a Fritz login node (e.g. fritz.nhr.fau.de). The jump host has no SLURM, so jobs are started and listed through this one.";
  const submitNote = Object.assign(document.createElement("span"), { id: "cluster-submit-note", className: "cluster-field-note" });
  submitField.append(submitSession, submitNote);
  // The jump host (csnhr) cannot run SLURM; point at a saved session to a Fritz login node instead.
  const hosts = config.sessionHosts || {};
  const describeSubmitSession = () => {
    const host = hosts[submitSession.value] || "";
    const loginNode = sessions.find((name) => /fritz/i.test(hosts[name] || ""));
    const suggestion = loginNode ? `Choose "${loginNode}" instead, then save.` : "Choose a session to fritz.nhr.fau.de instead, then save.";
    submitNote.textContent = /csnhr/i.test(host)
      ? `This session logs in to csnhr, NHR's jump host, which cannot start jobs. ${suggestion}`
      : !submitSession.value && loginNode ? `To start jobs from HoMo CFD, choose "${loginNode}" (a Fritz login node).` : "";
    submitNote.hidden = !submitNote.textContent;
  };
  submitSession.addEventListener("change", describeSubmitSession);
  describeSubmitSession();

  const templateField = document.createElement("label");
  templateField.className = "cluster-field";
  templateField.appendChild(Object.assign(document.createElement("span"), { className: "cluster-label", textContent: "Template folder" }));
  const template = Object.assign(document.createElement("input"), { type: "text", id: "cluster-template", className: "working-dir-input",
    value: config.templateFolder || "SCRIPT_FABSI", title: "Folder in the remote folder that new simulations are copied from" });
  templateField.appendChild(template);

  const actions = document.createElement("div");
  actions.className = "working-dir-actions";
  const test = document.createElement("button");
  test.type = "button";
  test.className = "primary";
  test.id = "cluster-test";
  test.textContent = "Test connection";
  test.disabled = !config.winscp;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "small-control";
  save.id = "cluster-save";
  save.textContent = "Save";
  const unlock = document.createElement("button");
  unlock.type = "button";
  unlock.className = "small-control";
  unlock.id = "cluster-unlock";
  unlock.textContent = "Unlock key with Pageant";
  unlock.title = "Starts Pageant with this session's key file. Pageant asks for the passphrase in its own window; HoMo CFD never sees it.";
  unlock.hidden = !config.pageant?.found;
  actions.append(test, unlock, save);

  const status = document.createElement("p");
  status.className = "cluster-status";
  status.hidden = true;
  const details = document.createElement("details");
  details.className = "cluster-output";
  details.hidden = true;
  const summary = document.createElement("summary");
  summary.textContent = "WinSCP output";
  const output = document.createElement("pre");
  details.append(summary, output);
  card.append(sessionField, folderField, submitField, templateField, actions, status, details);
  const settingsControls = [session, folder, submitSession, template, test, unlock, save];
  const cases = clusterCasesSection({
    saved: Boolean(config.session && config.remoteFolder),
    onNeedsPassphrase: () => unlock.classList.add("primary"),
    templateFolder: config.templateFolder,
  });
  card.appendChild(cases);
  cases.start();

  const show = (text, kind, log = "") => {
    status.textContent = text;
    status.className = `cluster-status ${kind}`;
    status.hidden = false;
    output.textContent = log;
    details.hidden = !log;
  };
  const busy = (on) => settingsControls.forEach((control) => {
    control.disabled = on || (control === test && !config.winscp);
  });
  const values = () => ({ session: session.value, remoteFolder: folder.value, submitSession: submitSession.value,
    templateFolder: template.value });

  unlock.addEventListener("click", async () => {
    busy(true);
    try {
      await postServerJson("cluster/pageant", { session: session.value });
      describePageant(true);
      show("Pageant is asking for your key's passphrase in its own window (it may be behind the browser). " +
        "After entering it there, click Test connection again.", "hint");
    } catch (err) {
      show(err?.message || "Could not start Pageant.", "error");
    } finally {
      busy(false);
    }
  });

  test.addEventListener("click", async () => {
    busy(true);
    show("Connecting to Fritz… this can take up to a minute.", "hint");
    try {
      const result = await postServerJson("cluster/test", values());
      if (result.ok && result.submit && !result.submit.ok) {
        show(`Connected. Remote folder: ${result.remoteFolder}. But the session for starting jobs: ` +
          [result.submit.error, result.submit.hint].filter(Boolean).join(" "), "error", result.submit.output || result.output);
      } else if (result.ok) {
        show(`Connected. Remote folder: ${result.remoteFolder}` + (result.submit ? ` · Jobs: ${result.submit.version}` : ""),
          "cluster-ok", result.output);
      }
      else {
        show([result.error, result.hint].filter(Boolean).join(" "), "error", result.output);
        if (result.needsPassphrase && !unlock.hidden) unlock.classList.add("primary");
      }
    } catch (err) {
      show(err?.message || "The connection test failed.", "error");
    } finally {
      busy(false);
    }
  });
  save.addEventListener("click", async () => {
    busy(true);
    try {
      await postServerJson("cluster", values());
      show("Saved.", "cluster-ok");
      config.session = session.value;
      config.remoteFolder = folder.value;
      config.submitSession = submitSession.value;
      cases.refresh();
    } catch (err) {
      show(err?.message || "Could not save the cluster settings.", "error");
    } finally {
      busy(false);
    }
  });
}

// HoMo CFD runs without a window, so it is stopped from here (or stops by
// itself a while after the last window closed).
async function quitApp() {
  if (!window.confirm("Quit HoMo CFD? Its windows stop working until you start it again.")) return;
  try {
    await postServerJson("quit");
    serverWasReachable = false;  // stopped on purpose: no "not running" notice
  } catch (err) {
    showError(err?.message || "HoMo CFD could not be stopped.");
    return;
  }
  document.body.replaceChildren(Object.assign(document.createElement("div"), {
    className: "workspace-empty",
    textContent: "HoMo CFD has stopped. Start it again with the desktop shortcut or Start HoMo CFD.bat. You can close this tab.",
  }));
}

async function startFilesystemWorkspace() {
  const openResults = document.getElementById("open-results");
  const clusterButton = document.getElementById("cluster-settings");
  // Attached before the server check so an early click isn't lost.
  const serverConfig = getServerConfig();
  openResults.addEventListener("click", async () => {
    const config = await serverConfig;
    if (config) showWorkingDirectoryChooser(config);
    else chooseResultsRoot();
  });
  clusterButton.addEventListener("click", () => showClusterSettings());
  document.getElementById("quit-app").addEventListener("click", quitApp);
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
      document.getElementById("working-dir-label").textContent = config.workingDir || "Choose working directory";
      clusterButton.hidden = false;
      document.getElementById("quit-app").hidden = false;
      openResults.title = config.workingDir ? `Working directory: ${config.workingDir} — click to change` : "Choose the folder that holds your results";
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
