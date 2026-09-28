const DB_NAME = "homo-cfd-settings";
const STORE_NAME = "folders";
const searchParams = new URLSearchParams(location.search);
const folderKey = searchParams.get("folder");
const compareKey = searchParams.get("compare");
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
const imageStageObserver = new ResizeObserver((entries) => {
  entries.forEach((entry) => fitZoomedImage(entry.target));
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
    transaction.oncomplete = () => resolve({ handle: handleRequest.result, path: pathRequest.result });
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
  return targets;
}

async function getViewerCatalog(key) {
  const db = await openSettingsDb();
  const catalog = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(`viewer-catalog:${key}`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return catalog;
}

function showError(message) {
  error.hidden = !message;
  error.textContent = message || "";
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
  const image = document.createElement("img");
  image.src = images[frameIndex].url;
  image.alt = images[frameIndex].name;
  image.style.transform = `scale(${zoom})`;
  stage.replaceChildren(image);
  caption.textContent = images[frameIndex].name;
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
      const option = new Option(entry.path, entry.path);
      option.disabled = compareCases.some((selected, selectedIndex) =>
        selectedIndex !== index && selected?.path === entry.path);
      caseSelect.add(option);
    });
    caseSelect.value = item?.path ?? "";
    caseSelect.addEventListener("change", async () => {
      const selected = caseCatalog.find((entry) => entry.path === caseSelect.value);
      if (!selected) {
        compareCases[index] = null;
      } else {
        compareCases[index] = await createCaseView(selected, "");
      }
      focusCase(index);
      if (syncImages) {
        applySyncedFrameIndex();
        await ensureCurrentFramesReady();
      }
      zoom = compareCases[index]?.zoom ?? 1;
      renderFrame();
    });
    caseHeader.appendChild(caseSelect);
    if (compareCases.length > 1) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "small-control remove-case";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        compareCases.splice(index, 1);
        focusedCaseIndex = Math.min(focusedCaseIndex, compareCases.length - 1);
        renderFrame();
      });
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
    fieldSelect.addEventListener("change", async () => {
      item.field = fieldSelect.value;
      const axes = axesForCase(item);
      if (!axes.includes(item.axis)) item.axis = axes[0] ?? "x";
      item.frameIndex = 0;
      await loadCaseImages(item);
      if (syncImages) {
        syncFrameIndexes(index);
        await ensureCurrentFramesReady();
      }
      renderFrame();
    });
    const axisControls = document.createElement("div");
    axisControls.className = "choices small";
    axesForCase(item).forEach((axis) => {
      const axisButton = document.createElement("button");
      axisButton.type = "button";
      axisButton.textContent = axis.toUpperCase();
      axisButton.className = axis === item.axis ? "active" : "";
      axisButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        focusCase(index);
        item.axis = axis;
        item.frameIndex = 0;
        await loadCaseImages(item);
        if (syncImages) {
          syncFrameIndexes(index);
          await ensureCurrentFramesReady();
        }
        renderFrame();
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
    if (frame?.image) {
      const image = frame.image;
      image.src = frame.url;
      image.alt = `${item.name} ${item.field} ${item.axis.toUpperCase()} ${frame.name}`;
      image.style.transform = "none";
      image.style.width = "";
      image.style.height = "";
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
  stage.querySelectorAll(".compare-image-stage").forEach((imageStage) => imageStageObserver.observe(imageStage));
  caption.textContent = syncImages
    ? "Sync images is on: left/right arrow keys step every panel by frame index."
    : "Click an image panel, then use left/right arrow keys to step that simulation.";
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
  const item = compareCases[Number(imageStage.dataset.caseIndex)];
  const image = imageStage.querySelector("img");
  const frameBox = imageStage.querySelector(".compare-zoom-frame");
  if (!item || !image || !frameBox || !image.naturalWidth || !imageStage.clientWidth || !imageStage.clientHeight) return;

  const fitScale = Math.min(
    imageStage.clientWidth / image.naturalWidth,
    imageStage.clientHeight / image.naturalHeight,
  );
  const width = Math.max(1, Math.round(image.naturalWidth * fitScale * item.zoom));
  const height = Math.max(1, Math.round(image.naturalHeight * fitScale * item.zoom));
  frameBox.style.width = `${Math.max(imageStage.clientWidth, width)}px`;
  frameBox.style.height = `${Math.max(imageStage.clientHeight, height)}px`;
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
}

function applyZoomToVisiblePanels() {
  const stages = [...document.querySelectorAll(".compare-image-stage")];
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
  const sections = [];
  for await (const child of target.handle.values()) {
    if (child.kind !== "directory") continue;
    const match = child.name.match(/^(.+)_([xyz])-Section$/i);
    if (!match) continue;
    let containsImage = false;
    for await (const entry of child.values()) {
      if (entry.kind === "file" && /\.(png|jpe?g|webp)$/i.test(entry.name)) {
        containsImage = true;
        break;
      }
    }
    if (containsImage) sections.push({ field: match[1], axis: match[2].toLowerCase(), handle: child });
  }
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
  const item = { ...target, name: target.path.split("/").pop(), sections, field, axis, frameIndex: 0, zoom: 1, images: [] };
  await loadCaseImages(item);
  return item;
}

async function loadCaseImages(item) {
  item.images.forEach((image) => {
    image.released = true;
    if (image.url) URL.revokeObjectURL(image.url);
  });
  item.images = [];
  const section = item.sections.find((entry) => entry.field === item.field && entry.axis === item.axis);
  if (!section) return;
  for await (const child of section.handle.values()) {
    if (child.kind !== "file" || !/\.(png|jpe?g|webp)$/i.test(child.name)) continue;
    item.images.push({ name: child.name, handle: child, url: null, image: null, loading: null, released: false });
  }
  item.images.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  item.frameIndex = Math.min(item.frameIndex, Math.max(0, item.images.length - 1));
  const currentFrame = item.images[item.frameIndex];
  if (currentFrame) {
    await ensureFrameReady(currentFrame);
    preloadNearbyFrames(item, item.frameIndex);
  }
}

async function ensureFrameReady(frame) {
  if (frame.image) return frame.image;
  if (!frame.loading) {
    frame.loading = (async () => {
      const file = await frame.handle.getFile();
      const url = URL.createObjectURL(file);
      if (frame.released) {
        URL.revokeObjectURL(url);
        return null;
      }
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      try {
        await image.decode();
      } catch (err) {
        URL.revokeObjectURL(url);
        throw err;
      }
      if (frame.released) {
        URL.revokeObjectURL(url);
        return null;
      }
      frame.url = url;
      frame.image = image;
      return image;
    })();
  }
  try {
    return await frame.loading;
  } catch (err) {
    frame.loading = null;
    throw err;
  }
}

function preloadNearbyFrames(item, index) {
  for (const nearbyIndex of [index - 1, index + 1]) {
    const frame = item.images[nearbyIndex];
    if (frame) ensureFrameReady(frame).catch(() => {});
  }
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
  renderFrame();
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
  document.getElementById("viewer-title").textContent = folderHandle.name;
  document.getElementById("viewer-path").textContent = `${target.path || folderHandle.name} · Use left/right arrow keys to step through images.`;
  document.title = `${target.path || folderHandle.name} | HoMo CFD`;
  images = [];
  for await (const child of folderHandle.values()) {
    if (child.kind !== "file" || !/\.(png|jpe?g|webp)$/i.test(child.name)) continue;
    const file = await child.getFile();
    images.push({ name: child.name, url: URL.createObjectURL(file) });
  }
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
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
  compareCases = await Promise.all(compareTargets.map((target) =>
    createCaseView(target, target.path === initialSectionPath.slice(0, initialSectionPath.lastIndexOf("/")) ? initialSectionPath : ""),
  ));
  document.getElementById("add-case").addEventListener("click", () => {
    if (compareCases.length >= 4) return;
    compareCases.push(null);
    focusCase(compareCases.length - 1);
    renderFrame();
  });
  document.getElementById("sync-images-control").hidden = false;
  document.getElementById("viewer-title").textContent = "Simulation comparison";
  document.getElementById("viewer-path").textContent = "Each panel has independent field, axis, frame, and zoom controls.";
  document.title = "Simulation comparison | HoMo CFD";
  stage.classList.add("compare-stage");
  renderFrame();
}

document.getElementById("zoom-out").addEventListener("click", () => setZoom(zoom / 1.2));
document.getElementById("zoom-in").addEventListener("click", () => setZoom(zoom * 1.2));
document.getElementById("zoom-reset").addEventListener("click", () => setZoom(1));
document.getElementById("sync-images").addEventListener("change", (event) => {
  syncImages = event.target.checked;
  if (syncImages) syncFrameIndexes(focusedCaseIndex);
  ensureCurrentFramesReady().then(renderFrame).catch((err) => showError(err?.message || "Could not prepare synchronized images"));
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
document.addEventListener("keydown", async (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (event.target?.tagName === "SELECT" || event.target?.tagName === "INPUT") return;
    event.preventDefault();
    if (compareKey) {
      const item = compareCases[focusedCaseIndex];
      if (!item?.images.length) return;
      if (syncImages) {
        const longestSequence = Math.max(0, ...compareCases.map((compareCase) => compareCase?.images.length ?? 0));
        const nextIndex = Math.max(0, Math.min(longestSequence - 1, syncFrameIndex + (event.key === "ArrowRight" ? 1 : -1)));
        for (const compareCase of compareCases) {
          const frame = compareCase?.images[Math.min(nextIndex, (compareCase?.images.length ?? 1) - 1)];
          if (frame) await ensureFrameReady(frame);
        }
        syncFrameIndex = nextIndex;
        applySyncedFrameIndex();
      } else {
        const nextIndex = Math.max(0, Math.min(item.images.length - 1, item.frameIndex + (event.key === "ArrowRight" ? 1 : -1)));
        await ensureFrameReady(item.images[nextIndex]);
        item.frameIndex = nextIndex;
      }
      compareCases.forEach((compareCase) => {
        if (compareCase) preloadNearbyFrames(compareCase, compareCase.frameIndex);
      });
    } else {
      frameIndex = Math.max(0, Math.min(images.length - 1, frameIndex + (event.key === "ArrowRight" ? 1 : -1)));
    }
    renderFrame();
  }
});

loadFolder().catch((err) => showError(err?.message || "Could not load images"));