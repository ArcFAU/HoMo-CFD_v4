const DB_NAME = "homo-cfd-settings";
const STORE_NAME = "folders";
const searchParams = new URLSearchParams(location.search);
const folderKey = searchParams.get("folder");
const compareKey = searchParams.get("compare");
const is3DSceneGallery = searchParams.get("gallery") === "3d";
const initialSectionPath = searchParams.get("section") || "";
const stage = document.getElementById("image-stage");
const caption = document.getElementById("image-caption");
const error = document.getElementById("viewer-error");
const reconnectButton = document.getElementById("reconnect-folder");
let folderHandle;
let images = [];
let compareTargets = [];
let caseCatalog = [];
let compareCases = [];
let focusedCaseIndex = 0;
let frameIndex = 0;
let zoom = 1;
const syncZoom = true;
let syncImages = false;
let syncingPan = false;
let syncFrameIndex = 0;
const viewerId = crypto.randomUUID();
const zoomChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("homo-cfd-image-zoom");
// Refit on the next frame: resizing inside the callback (e.g. when zoom adds
// scrollbars) would trigger a "ResizeObserver loop" error.
const imageStageObserver = new ResizeObserver((entries) => {
  requestAnimationFrame(() => entries.forEach((entry) => fitZoomedImage(entry.target)));
});

function openSettingsDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getViewerTarget(key) {
  const db = await openSettingsDb();
  const target = await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const handleRequest = store.get(`viewer:${key}`);
    const pathRequest = store.get(`viewer-path:${key}`);
    transaction.oncomplete = () => resolve({ handle: reviveHandle(handleRequest.result), path: pathRequest.result });
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
  return target;
}

async function getViewerSet(key) {
  const db = await openSettingsDb();
  const targets = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(`viewer-set:${key}`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return Array.isArray(targets) ? targets.map((target) => ({ ...target, handle: reviveHandle(target.handle) })) : targets;
}

async function getViewerCatalog(key) {
  const db = await openSettingsDb();
  const catalog = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(`viewer-catalog:${key}`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return Array.isArray(catalog) ? catalog.map((target) => ({ ...target, handle: reviveHandle(target.handle) })) : catalog;
}

function showError(message) {
  error.hidden = !message;
  error.textContent = message || "";
}

// Image loading is async, so user actions run one at a time in order.
// Without this, two quick key presses both read the same frame index, and
// two field switches could fill one panel with two image lists.
let actionQueue = Promise.resolve();
let pendingActions = 0;

function runAction(action) {
  pendingActions++;
  actionQueue = actionQueue
    .then(action)
    .catch((err) => showError(err?.message || "Could not load images"))
    .finally(() => { pendingActions--; });
  return actionQueue;
}

// Speed over memory: every frame of the sequences on screen is read and
// decoded once in the background, nearest to the current frame first, and
// kept, so stepping back and forth never waits for a frame twice. A case keeps
// the frames of every section it has shown until it is removed or replaced.
const MAX_PARALLEL_LOADS = 6;
let activeLoads = 0;
const preloadSequences = new Map(); // owner -> { frames, current: () => frame index }

function preloadSequence(owner, frames, current) {
  preloadSequences.set(owner, { frames, current });
  pumpLoads();
}

function nextFrameToLoad() {
  let best = null;
  let bestDistance = Infinity;
  for (const { frames, current } of preloadSequences.values()) {
    const at = current();
    for (let distance = 0; distance < Math.min(bestDistance, frames.length); distance++) {
      const frame = [frames[at + distance], frames[at - distance]]
        .find((candidate) => candidate && !candidate.image && !candidate.loading && !candidate.failed);
      if (frame) {
        best = frame;
        bestDistance = distance;
        break;
      }
    }
  }
  return best;
}

function pumpLoads() {
  while (activeLoads < MAX_PARALLEL_LOADS) {
    const frame = nextFrameToLoad();
    if (!frame) return;
    activeLoads++;
    ensureFrameReady(frame)
      .catch(() => { frame.failed = true; })
      .finally(() => {
        activeLoads--;
        pumpLoads();
      });
  }
}

function newFrame(name, handle) {
  return { name, handle, url: null, image: null, loading: null, failed: false, generation: 0 };
}

function releaseFrame(frame) {
  frame.generation++;
  if (frame.url) URL.revokeObjectURL(frame.url);
  frame.url = null;
  frame.image = null;
  frame.loading = null;
}

function releaseCaseImages(item) {
  if (!item) return;
  preloadSequences.delete(item);
  item.images.forEach(releaseFrame);
  item.sectionFrames?.forEach((frames) => frames.forEach(releaseFrame));
}

function renderFrame() {
  if (compareKey) {
    renderComparisonFrame();
    return;
  }
  if (!images.length) {
    stage.replaceChildren(Object.assign(document.createElement("div"), {
      className: "workspace-empty",
      textContent: "No image files in this folder.",
    }));
    caption.textContent = "";
    return;
  }
  showSingleFrame();
}

// Single folder / scene gallery: the current image stays on screen until the
// next one is decoded, then it is swapped in already sized, so stepping does
// not flash. The other images load in the background (see pumpLoads).
let singleFrameToken = 0;

async function showSingleFrame() {
  const token = ++singleFrameToken;
  const entry = images[frameIndex];
  let image;
  try {
    image = await ensureFrameReady(entry);
  } catch (err) {
    if (token === singleFrameToken) showError(`Could not open ${entry.name}: ${err?.message || err}`);
    return;
  }
  if (token !== singleFrameToken || !image) return;
  let frameBox = stage.querySelector(".compare-zoom-frame");
  if (!frameBox) {
    frameBox = document.createElement("div");
    frameBox.className = "compare-zoom-frame";
    stage.replaceChildren(frameBox);
  }
  swapImage(stage, frameBox, image);
  caption.textContent = `${entry.name} · ${frameIndex + 1} / ${images.length}`;
}

// Puts a decoded image into a zoom frame, sized before the browser paints and
// keeping the pan position.
function swapImage(imageStage, frameBox, image) {
  if (frameBox.firstElementChild === image) return;
  const { scrollLeft, scrollTop } = imageStage;
  frameBox.replaceChildren(image);
  fitZoomedImage(imageStage);
  imageStage.scrollLeft = scrollLeft;
  imageStage.scrollTop = scrollTop;
}

// Comparison window: stepping frames swaps the images inside the existing
// panels instead of rebuilding them. Falls back to a full render when the
// panels don't match (case added/removed, image still loading).
function updateComparisonImages() {
  const stages = [...stage.querySelectorAll(".compare-image-stage")];
  const ready = stages.length === compareCases.length && compareCases.every((item, index) =>
    item?.images[item.frameIndex]?.image && stages[index].querySelector(".compare-zoom-frame"));
  if (!ready) {
    renderFrame();
    return;
  }
  compareCases.forEach((item, index) => {
    const frame = item.images[item.frameIndex];
    frame.image.alt = `${item.name} ${item.field} ${item.axis.toUpperCase()} ${frame.name}`;
    frame.image.draggable = false;
    swapImage(stages[index], stages[index].querySelector(".compare-zoom-frame"), frame.image);
    const panelCaption = stages[index].closest(".compare-image-panel")?.querySelector(".compare-image-caption");
    if (panelCaption) panelCaption.textContent = `${frame.name} · ${item.frameIndex + 1} / ${item.images.length}`;
  });
}

function focusCase(index) {
  focusedCaseIndex = index;
  zoom = compareCases[index]?.zoom ?? 1;
  document.getElementById("zoom-level").textContent = `${Math.round(zoom * 100)}%`;
  document.querySelectorAll(".compare-image-panel").forEach((panel, panelIndex) => {
    panel.classList.toggle("focused", panelIndex === index);
  });
}

function renderComparisonFrame() {
  updateAddCaseButton();
  const panels = compareCases.map((item, index) => {
    const panel = document.createElement("section");
    panel.className = `compare-image-panel${index === focusedCaseIndex ? " focused" : ""}`;
    panel.addEventListener("click", (event) => {
      if (event.target.closest("button, select, input")) return;
      focusCase(index);
    });
    const caseHeader = document.createElement("div");
    caseHeader.className = "compare-case-header";
    const caseSelect = document.createElement("select");
    caseSelect.setAttribute("aria-label", `Simulation for comparison ${index + 1}`);
    caseSelect.addEventListener("click", () => focusCase(index));
    const emptyOption = new Option("Select simulation", "");
    caseSelect.add(emptyOption);
    caseCatalog.forEach((entry) => {
      const option = new Option(entry.path || entry.name, entry.path);
      caseSelect.add(option);
    });
    caseSelect.value = item?.path ?? "";
    caseSelect.addEventListener("change", () => runAction(async () => {
      const selected = caseCatalog.find((entry) => entry.path === caseSelect.value);
      const replacement = selected ? await createCaseView(selected, "") : null;
      releaseCaseImages(compareCases[index]);
      compareCases[index] = replacement;
      focusCase(index);
      if (syncImages) {
        applySyncedFrameIndex();
        await ensureCurrentFramesReady();
      }
      zoom = compareCases[index]?.zoom ?? 1;
      renderFrame();
    }));
    caseHeader.appendChild(caseSelect);
    if (compareCases.length > 1) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "small-control remove-case";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => runAction(() => {
        releaseCaseImages(compareCases[index]);
        compareCases.splice(index, 1);
        focusedCaseIndex = Math.min(focusedCaseIndex, compareCases.length - 1);
        renderFrame();
      }));
      caseHeader.appendChild(remove);
    }
    panel.appendChild(caseHeader);
    if (!item) {
      const prompt = document.createElement("div");
      prompt.className = "compare-unavailable";
      prompt.textContent = "Select a simulation for this panel.";
      panel.appendChild(prompt);
      return panel;
    }

    const controls = document.createElement("div");
    controls.className = "compare-case-controls";
    const fieldSelect = document.createElement("select");
    fieldSelect.setAttribute("aria-label", `Field for ${item.name}`);
    const fields = [...new Set(item.sections.map((section) => section.field))].sort();
    fields.forEach((field) => fieldSelect.add(new Option(field, field)));
    fieldSelect.value = item.field;
    fieldSelect.addEventListener("click", (event) => {
      event.stopPropagation();
      focusCase(index);
    });
    fieldSelect.addEventListener("change", () => runAction(() => showSection(index, fieldSelect.value, item.axis)));
    const axisControls = document.createElement("div");
    axisControls.className = "choices small";
    axesForCase(item).forEach((axis) => {
      const axisButton = document.createElement("button");
      axisButton.type = "button";
      axisButton.textContent = axis.toUpperCase();
      axisButton.className = axis === item.axis ? "active" : "";
      axisButton.addEventListener("click", (event) => {
        event.stopPropagation();
        focusCase(index);
        runAction(() => showSection(index, item.field, axis));
      });
      axisControls.appendChild(axisButton);
    });
    controls.append(fieldSelect, axisControls);
    panel.appendChild(controls);

    const frame = item.images[item.frameIndex];
    const imageStage = document.createElement("div");
    imageStage.className = "compare-image-stage";
    imageStage.dataset.caseIndex = String(index);
    imageStage.addEventListener("scroll", () => syncPanFromStage(imageStage), { passive: true });
    imageStage.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      focusCase(index);
      setZoom((item.zoom ?? 1) * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
    enableDragPan(imageStage, index);
    if (frame?.image) {
      const image = frame.image;
      image.alt = `${item.name} ${item.field} ${item.axis.toUpperCase()} ${frame.name}`;
      image.draggable = false;
      image.style.transform = "none";
      imageStage.dataset.caseIndex = String(index);
      const frameBox = document.createElement("div");
      frameBox.className = "compare-zoom-frame";
      frameBox.appendChild(image);
      imageStage.appendChild(frameBox);
    } else if (frame) {
      const loading = document.createElement("div");
      loading.className = "compare-unavailable image-loading";
      loading.textContent = "Loading image…";
      imageStage.appendChild(loading);
    } else {
      const unavailable = document.createElement("div");
      unavailable.className = "compare-unavailable";
      unavailable.textContent = `No ${item.field} ${item.axis.toUpperCase()} images in this simulation.`;
      imageStage.appendChild(unavailable);
    }
    panel.appendChild(imageStage);
    const imageCaption = document.createElement("div");
    imageCaption.className = "compare-image-caption";
    imageCaption.textContent = frame ? `${frame.name} · ${item.frameIndex + 1} / ${item.images.length}` : "";
    panel.appendChild(imageCaption);
    return panel;
  });
  imageStageObserver.disconnect();
  stage.replaceChildren(...panels);
  // Layout per case count lives in CSS: 3-4 panels keep a minimum readable
  // size and the window scrolls instead of shrinking the images.
  stage.classList.remove("compare-count-1", "compare-count-2", "compare-count-3", "compare-count-4");
  stage.classList.add(`compare-count-${Math.min(4, Math.max(1, panels.length))}`);
  // Size the images now, before the first paint, so they don't flash at their
  // natural size; the observer keeps them fitted when the window resizes.
  stage.querySelectorAll(".compare-image-stage").forEach((imageStage) => {
    fitZoomedImage(imageStage);
    imageStageObserver.observe(imageStage);
  });
  caption.textContent = syncImages
    ? "Sync images is on: left/right arrow keys step every panel by frame index."
    : "Click an image panel, then use left/right arrow keys to step that simulation.";
}

function enableDragPan(imageStage, caseIndex) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startScrollLeft = 0;
  let startScrollTop = 0;

  imageStage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (!compareKey && zoom <= 1) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startScrollLeft = imageStage.scrollLeft;
    startScrollTop = imageStage.scrollTop;
    if (caseIndex !== null) focusCase(caseIndex);
    imageStage.classList.add("panning");
    imageStage.setPointerCapture(pointerId);
    event.preventDefault();
  });

  imageStage.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    imageStage.scrollLeft = startScrollLeft - (event.clientX - startX);
    imageStage.scrollTop = startScrollTop - (event.clientY - startY);
  });

  const finishPan = (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    imageStage.classList.remove("panning");
  };
  imageStage.addEventListener("pointerup", finishPan);
  imageStage.addEventListener("pointercancel", finishPan);
  imageStage.addEventListener("lostpointercapture", finishPan);
}

// Switches one panel to a field/axis (keeping the axis when the field has
// it) and resets to the first image.
async function showSection(index, field, axis) {
  const item = compareCases[index];
  if (!item) return;
  item.field = field;
  const axes = axesForCase(item);
  item.axis = axes.includes(axis) ? axis : axes[0] ?? "x";
  item.frameIndex = 0;
  await loadCaseImages(item);
  if (syncImages) {
    syncFrameIndexes(index);
    await ensureCurrentFramesReady();
  }
  renderFrame();
}

function axesForCase(item) {
  return [...new Set(item.sections.filter((section) => section.field === item.field).map((section) => section.axis))].sort();
}

function syncFrameIndexes(sourceIndex) {
  const source = compareCases[sourceIndex];
  if (!source?.images.length) return;
  syncFrameIndex = source.frameIndex;
  applySyncedFrameIndex();
}

function applySyncedFrameIndex() {
  compareCases.forEach((item) => {
    if (item?.images.length) item.frameIndex = Math.min(syncFrameIndex, item.images.length - 1);
  });
}

function fitZoomedImage(imageStage) {
  const zoomLevel = compareKey ? compareCases[Number(imageStage.dataset.caseIndex)]?.zoom : zoom;
  const image = imageStage.querySelector("img");
  const frameBox = imageStage.querySelector(".compare-zoom-frame");
  if (!zoomLevel || !image || !frameBox || !image.naturalWidth || !imageStage.clientWidth || !imageStage.clientHeight) return;

  const fitScale = Math.min(
    imageStage.clientWidth / image.naturalWidth,
    imageStage.clientHeight / image.naturalHeight,
  );
  const width = Math.max(1, Math.round(image.naturalWidth * fitScale * zoomLevel));
  const height = Math.max(1, Math.round(image.naturalHeight * fitScale * zoomLevel));
  frameBox.style.width = `${Math.max(imageStage.clientWidth, width)}px`;
  frameBox.style.height = `${Math.max(imageStage.clientHeight, height)}px`;
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
}

function applyZoomToVisiblePanels() {
  const stages = compareKey ? [...document.querySelectorAll(".compare-image-stage")] : [stage];
  const centers = stages.map((imageStage) => ({
    x: imageStage.scrollWidth ? (imageStage.scrollLeft + imageStage.clientWidth / 2) / imageStage.scrollWidth : 0.5,
    y: imageStage.scrollHeight ? (imageStage.scrollTop + imageStage.clientHeight / 2) / imageStage.scrollHeight : 0.5,
  }));
  stages.forEach((imageStage) => fitZoomedImage(imageStage));
  stages.forEach((imageStage, index) => {
    imageStage.scrollLeft = centers[index].x * imageStage.scrollWidth - imageStage.clientWidth / 2;
    imageStage.scrollTop = centers[index].y * imageStage.scrollHeight - imageStage.clientHeight / 2;
  });
}

function syncPanFromStage(sourceStage) {
  if (syncingPan) return;
  const horizontalRange = sourceStage.scrollWidth - sourceStage.clientWidth;
  const verticalRange = sourceStage.scrollHeight - sourceStage.clientHeight;
  const horizontalPosition = horizontalRange > 0 ? sourceStage.scrollLeft / horizontalRange : 0;
  const verticalPosition = verticalRange > 0 ? sourceStage.scrollTop / verticalRange : 0;
  syncingPan = true;
  document.querySelectorAll(".compare-image-stage").forEach((targetStage) => {
    if (targetStage === sourceStage) return;
    targetStage.scrollLeft = horizontalPosition * Math.max(0, targetStage.scrollWidth - targetStage.clientWidth);
    targetStage.scrollTop = verticalPosition * Math.max(0, targetStage.scrollHeight - targetStage.clientHeight);
  });
  requestAnimationFrame(() => { syncingPan = false; });
}

async function ensureCurrentFramesReady() {
  await Promise.all(compareCases.map((item) => {
    const frame = item?.images[item.frameIndex];
    return frame ? ensureFrameReady(frame) : Promise.resolve();
  }));
}

async function createCaseView(target, preferredSectionPath) {
  const permission = await target.handle.queryPermission({ mode: "read" });
  if (permission !== "granted") throw new Error(`Folder access needs to be restored for ${target.path}.`);
  // With serve.py the whole case is listed in one request; otherwise the
  // section folders are checked in parallel.
  if (target.handle.homoServer) await prefetchServerTree(target.handle).catch(() => {});
  const candidates = [];
  for await (const child of target.handle.values()) {
    const match = child.kind === "directory" && child.name.match(/^(.+)_([xyz])-Section$/i);
    if (match) candidates.push({ field: match[1], axis: match[2].toLowerCase(), handle: child });
  }
  const hasImage = async (folder) => {
    for await (const entry of folder.values()) {
      if (entry.kind === "file" && /\.(png|jpe?g|webp)$/i.test(entry.name)) return true;
    }
    return false;
  };
  const withImages = await Promise.all(candidates.map((section) => hasImage(section.handle)));
  const sections = candidates.filter((_, index) => withImages[index]);
  sections.sort((left, right) => `${left.field}-${left.axis}`.localeCompare(`${right.field}-${right.axis}`));
  const preferredName = preferredSectionPath.split("/").pop()?.match(/^(.+)_([xyz])-Section$/i);
  const fields = [...new Set(sections.map((section) => section.field))].sort();
  const field = preferredName?.[1] && fields.includes(preferredName[1])
    ? preferredName[1]
    : fields.includes("Cp") ? "Cp" : fields[0] ?? "";
  const axes = [...new Set(sections.filter((section) => section.field === field).map((section) => section.axis))];
  const axis = preferredName?.[2] && axes.includes(preferredName[2].toLowerCase())
    ? preferredName[2].toLowerCase()
    : axes.includes("x") ? "x" : axes[0] ?? "x";
  const item = { ...target, name: target.name || target.path.split("/").pop(), sections, field, axis, frameIndex: 0, zoom: 1, images: [] };
  await loadCaseImages(item);
  return item;
}

async function listImages(folder) {
  const frames = [];
  for await (const child of folder.values()) {
    if (child.kind === "file" && /\.(png|jpe?g|webp)$/i.test(child.name)) frames.push(newFrame(child.name, child));
  }
  return frames.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
}

// Each section's frames are kept per case, so switching back to a field or
// axis shown before is instant.
async function loadCaseImages(item) {
  const section = item.sections.find((entry) => entry.field === item.field && entry.axis === item.axis);
  if (!section) {
    item.images = [];
    preloadSequences.delete(item);
    return;
  }
  item.sectionFrames ??= new Map();
  const key = `${section.field}_${section.axis}`;
  if (!item.sectionFrames.has(key)) item.sectionFrames.set(key, await listImages(section.handle));
  item.images = item.sectionFrames.get(key);
  item.frameIndex = Math.min(item.frameIndex, Math.max(0, item.images.length - 1));
  preloadSequence(item, item.images, () => item.frameIndex);
  const currentFrame = item.images[item.frameIndex];
  if (currentFrame) await ensureFrameReady(currentFrame);
}

// frame.generation changes whenever a frame is released, so a load that
// finishes after its frame was released discards its result.
async function ensureFrameReady(frame) {
  if (frame.image) return frame.image;
  if (!frame.loading) {
    const generation = frame.generation;
    const loading = (async () => {
      const file = await frame.handle.getFile();
      if (frame.generation !== generation) return null;
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.decoding = "async";
      image.draggable = false;
      image.alt = frame.name;
      image.src = url;
      try {
        await image.decode();
      } catch (err) {
        URL.revokeObjectURL(url);
        throw err;
      }
      if (frame.generation !== generation) {
        URL.revokeObjectURL(url);
        return null;
      }
      frame.url = url;
      frame.image = image;
      return image;
    })();
    frame.loading = loading;
    loading.catch(() => {
      if (frame.loading === loading) frame.loading = null;
    });
  }
  return frame.loading;
}

function updateAddCaseButton() {
  const button = document.getElementById("add-case");
  button.hidden = !compareKey;
  button.disabled = compareCases.length >= 4;
  button.title = compareCases.length >= 4 ? "A maximum of four cases can be compared" : "Add another simulation";
}

function setZoom(value, broadcast = true) {
  zoom = Math.max(0.5, Math.min(5, value));
  document.getElementById("zoom-level").textContent = `${Math.round(zoom * 100)}%`;
  if (compareKey) {
    if (syncZoom) compareCases.forEach((item) => { if (item) item.zoom = zoom; });
    else if (compareCases[focusedCaseIndex]) compareCases[focusedCaseIndex].zoom = zoom;
    applyZoomToVisiblePanels();
    if (broadcast && syncZoom) zoomChannel?.postMessage({ source: viewerId, zoom });
    return;
  }
  applyZoomToVisiblePanels();
  if (broadcast && syncZoom) zoomChannel?.postMessage({ source: viewerId, zoom });
}

async function loadFolder() {
  if (compareKey) {
    await loadComparison();
    return;
  }
  if (!folderKey) throw new Error("This image-viewer link is missing its folder reference.");
  const target = await getViewerTarget(folderKey);
  folderHandle = target.handle;
  if (!folderHandle) throw new Error("The selected folder is no longer available. Reopen it from the results tree.");
  const permission = await folderHandle.queryPermission({ mode: "read" });
  if (permission !== "granted") {
    reconnectButton.hidden = false;
    throw new Error("Folder access needs to be reconnected in this window.");
  }
  document.getElementById("viewer-title").textContent = is3DSceneGallery ? "3D reference scenes" : folderHandle.name;
  document.getElementById("viewer-path").textContent = is3DSceneGallery
    ? `${target.path || folderHandle.name} · Use left/right arrow keys to step through scenes; + / − / 0 to zoom.`
    : `${target.path || folderHandle.name} · Use left/right arrow keys to step through images.`;
  document.title = `${is3DSceneGallery ? "3D reference scenes" : target.path || folderHandle.name} | HoMo CFD`;
  // Only the names are listed here; the first image shows as soon as it is
  // read, and the others load in the background.
  images.forEach(releaseFrame);
  images = await listImages(folderHandle);
  frameIndex = Math.min(frameIndex, Math.max(0, images.length - 1));
  preloadSequence("single", images, () => frameIndex);
  if (!stage.classList.contains("single-stage")) {
    stage.classList.add("single-stage");
    enableDragPan(stage, null);
    imageStageObserver.observe(stage);
  }
  if (is3DSceneGallery) {
    document.getElementById("viewer-path").textContent = `${target.path || folderHandle.name} · ${images.length} scenes · Use left/right arrow keys to step through scenes; + / − / 0 to zoom.`;
  }
  renderFrame();
}

async function loadComparison() {
  compareTargets = await getViewerSet(compareKey);
  if (!Array.isArray(compareTargets) || !compareTargets.length) {
    throw new Error("This comparison no longer has a selected simulation.");
  }
  caseCatalog = await getViewerCatalog(compareKey) ?? compareTargets;
  for (const target of compareTargets) {
    const permission = await target.handle.queryPermission({ mode: "read" });
    if (permission !== "granted") {
      reconnectButton.hidden = false;
      throw new Error(`Folder access needs to be reconnected for ${target.path}.`);
    }
  }
  const initialCasePath = initialSectionPath.includes("/")
    ? initialSectionPath.slice(0, initialSectionPath.lastIndexOf("/"))
    : "";
  compareCases = await Promise.all(compareTargets.map((target) =>
    createCaseView(target, target.path === initialCasePath ? initialSectionPath : ""),
  ));
  document.getElementById("add-case").addEventListener("click", () => {
    if (compareCases.length >= 4) return;
    compareCases.push(null);
    focusCase(compareCases.length - 1);
    renderFrame();
  });
  document.getElementById("sync-images-control").hidden = false;
  document.getElementById("viewer-title").textContent = "Simulation comparison";
  document.getElementById("viewer-path").textContent = "Each panel has independent field, axis, frame, and zoom controls. T: CpT · V: Velocity · P: Cp · L: Lambda2 · X/Y/Z: axis (focused panel) · + / − / 0: zoom.";
  document.title = "Simulation comparison | HoMo CFD";
  stage.classList.add("compare-stage");
  renderFrame();
}

document.getElementById("zoom-out").addEventListener("click", () => setZoom(zoom / 1.2));
document.getElementById("zoom-in").addEventListener("click", () => setZoom(zoom * 1.2));
document.getElementById("zoom-reset").addEventListener("click", () => setZoom(1));
document.getElementById("sync-images").addEventListener("change", (event) => {
  const checked = event.target.checked;
  runAction(async () => {
    syncImages = checked;
    if (syncImages) syncFrameIndexes(focusedCaseIndex);
    await ensureCurrentFramesReady();
    renderFrame();
  });
});
document.getElementById("full-screen").addEventListener("click", async () => {
  if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  else await document.exitFullscreen();
});
document.getElementById("close-viewer").addEventListener("click", () => window.close());
reconnectButton.addEventListener("click", async () => {
  try {
    if (compareKey) {
      for (const target of compareTargets) {
        const permission = await target.handle.requestPermission({ mode: "read" });
        if (permission !== "granted") throw new Error(`Folder access was not granted for ${target.path}.`);
      }
    } else {
      const permission = await folderHandle.requestPermission({ mode: "read" });
      if (permission !== "granted") throw new Error("Folder access was not granted.");
    }
    reconnectButton.hidden = true;
    showError("");
    await loadFolder();
  } catch (err) {
    showError(err?.message || "Could not reconnect folder access");
  }
});
stage.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });
zoomChannel?.addEventListener("message", (event) => {
  if (syncZoom && event.data?.source !== viewerId && Number.isFinite(event.data?.zoom)) {
    setZoom(event.data.zoom, false);
  }
});
document.addEventListener("keydown", (event) => {
  const target = event.target;
  // + / - zoom every panel, 0 resets to fit (also on the number pad).
  if (!event.ctrlKey && !event.altKey && !event.metaKey &&
    !(target?.isContentEditable || ["INPUT", "TEXTAREA"].includes(target?.tagName))) {
    const zoomStep = { "+": 1.2, "=": 1.2, "-": 1 / 1.2, "_": 1 / 1.2 }[event.key];
    if (zoomStep || event.key === "0") {
      event.preventDefault();
      setZoom(zoomStep ? zoom * zoomStep : 1);
      return;
    }
  }
  if (compareKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const key = event.key.toLowerCase();
    const isTextEntry = target?.isContentEditable || ["INPUT", "TEXTAREA"].includes(target?.tagName);
    const item = compareCases[focusedCaseIndex];
    const requestedField = { t: "CpT", v: "Velocity", p: "Cp", l: "Lambda2" }[key];
    if (requestedField && !isTextEntry && target?.tagName !== "SELECT" &&
      item?.sections.some((section) => section.field === requestedField)) {
      event.preventDefault();
      runAction(() => showSection(focusedCaseIndex, requestedField, item.axis));
      return;
    }
    // X/Y/Z also work while a field dropdown has focus (they aren't field names).
    const requestedAxis = { x: "x", y: "y", z: "z" }[key];
    if (requestedAxis && !isTextEntry && item && axesForCase(item).includes(requestedAxis)) {
      event.preventDefault();
      runAction(() => showSection(focusedCaseIndex, item.field, requestedAxis));
      return;
    }
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (target?.tagName === "SELECT" || target?.tagName === "INPUT") return;
  event.preventDefault();
  const step = event.key === "ArrowRight" ? 1 : -1;
  if (!compareKey) {
    frameIndex = Math.max(0, Math.min(images.length - 1, frameIndex + step));
    renderFrame();
    return;
  }
  // A held key repeats faster than images load; ignore repeats until the
  // current step has finished instead of queueing a backlog.
  if (pendingActions) return;
  runAction(async () => {
    const item = compareCases[focusedCaseIndex];
    if (!item?.images.length) return;
    if (syncImages) {
      const longestSequence = Math.max(0, ...compareCases.map((compareCase) => compareCase?.images.length ?? 0));
      const nextIndex = Math.max(0, Math.min(longestSequence - 1, syncFrameIndex + step));
      for (const compareCase of compareCases) {
        const frame = compareCase?.images[Math.min(nextIndex, (compareCase?.images.length ?? 1) - 1)];
        if (frame) await ensureFrameReady(frame);
      }
      syncFrameIndex = nextIndex;
      applySyncedFrameIndex();
    } else {
      const nextIndex = Math.max(0, Math.min(item.images.length - 1, item.frameIndex + step));
      await ensureFrameReady(item.images[nextIndex]);
      item.frameIndex = nextIndex;
    }
    pumpLoads();
    updateComparisonImages();
  });
});

loadFolder().catch((err) => showError(err?.message || "Could not load images"));
