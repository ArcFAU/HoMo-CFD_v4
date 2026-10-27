// Folder handles backed by serve.py's results API. They implement the parts
// of the File System Access API the app uses (kind, name, values(),
// getDirectoryHandle(), getFileHandle(), getFile(), queryPermission(),
// requestPermission()), so the same code reads a server-configured results
// folder or a folder chosen in the browser.
//
// Handles saved to IndexedDB lose their methods; reviveHandle() restores them.

const serverListings = new Map(); // folder path -> [{ name, kind }]

function serverUrl(endpoint, path) {
  return `/api/${endpoint}?path=${encodeURIComponent(path)}`;
}

async function serverJson(endpoint, path) {
  const response = await fetch(serverUrl(endpoint, path));
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `Server request failed (${response.status}) for ${path || "results folder"}`);
  return body;
}

function joinServerPath(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

class ServerFileHandle {
  constructor(path, name) {
    this.kind = "file";
    this.name = name;
    this.path = path;
    this.homoServer = true;
  }

  async getFile() {
    const response = await fetch(serverUrl("file", this.path));
    if (!response.ok) throw new Error(`Could not read ${this.path} (HTTP ${response.status})`);
    const modified = Date.parse(response.headers.get("Last-Modified") ?? "");
    return new File([await response.blob()], this.name, Number.isFinite(modified) ? { lastModified: modified } : {});
  }

  // The bytes only, without a File in between: about 3x faster for the 3D viewer's 100+ MB files.
  async getArrayBuffer() {
    const response = await fetch(serverUrl("file", this.path));
    if (!response.ok) throw new Error(`Could not read ${this.path} (HTTP ${response.status})`);
    return response.arrayBuffer();
  }
}

class ServerDirectoryHandle {
  constructor(path, name) {
    this.kind = "directory";
    this.name = name;
    this.path = path;
    this.homoServer = true;
  }

  async entries() {
    if (!serverListings.has(this.path)) serverListings.set(this.path, await serverJson("list", this.path));
    return serverListings.get(this.path);
  }

  // All child handles at once (used for fast indexing).
  async children() {
    return (await this.entries()).map((entry) => {
      const path = joinServerPath(this.path, entry.name);
      return entry.kind === "directory" ? new ServerDirectoryHandle(path, entry.name) : new ServerFileHandle(path, entry.name);
    });
  }

  async *values() {
    for (const entry of await this.entries()) {
      const path = joinServerPath(this.path, entry.name);
      yield entry.kind === "directory" ? new ServerDirectoryHandle(path, entry.name) : new ServerFileHandle(path, entry.name);
    }
  }

  async getDirectoryHandle(name) {
    if (!(await this.entries()).some((entry) => entry.name === name && entry.kind === "directory")) {
      throw new DOMException(`${name} was not found in ${this.name}.`, "NotFoundError");
    }
    return new ServerDirectoryHandle(joinServerPath(this.path, name), name);
  }

  async getFileHandle(name) {
    if (!(await this.entries()).some((entry) => entry.name === name && entry.kind === "file")) {
      throw new DOMException(`${name} was not found in ${this.name}.`, "NotFoundError");
    }
    return new ServerFileHandle(joinServerPath(this.path, name), name);
  }

  // The server already has access; there is nothing to grant.
  async queryPermission() { return "granted"; }
  async requestPermission() { return "granted"; }
}

function fillServerListings(path, node) {
  serverListings.set(path, [
    ...Object.keys(node.d).map((name) => ({ name, kind: "directory" })),
    ...node.f.map((name) => ({ name, kind: "file" })),
  ]);
  Object.entries(node.d).forEach(([name, child]) => fillServerListings(joinServerPath(path, name), child));
}

// Loads the whole folder tree in one request so indexing doesn't need a
// request per folder. Later listings of these folders come from memory.
// With cached, serve.py may answer from its saved copy of the results folder
// (instant, even on a slow hard disk); the return value is then that tree as
// JSON, so the caller can compare it with a fresh scan (freshServerTree).
async function prefetchServerTree(handle, { cached = false } = {}) {
  if (!cached) {
    fillServerListings(handle.path, await serverJson("tree", handle.path));
    return null;
  }
  const response = await fetch(`${serverUrl("tree", handle.path)}&cached=1`);
  const body = await response.json().catch(() => null);
  // A serve.py started before this version ignores cached=1 and sends the plain tree.
  const tree = body?.tree ?? (body?.d ? body : null);
  if (!response.ok || !tree) throw new Error(body?.error || `Server request failed (${response.status}) for the results folder`);
  fillServerListings(handle.path, tree);
  return body.cached ? JSON.stringify(tree) : null;
}

// A fresh scan of the folder; null when it equals the tree shown (JSON).
async function freshServerTree(handle, shown) {
  const tree = await serverJson("tree", handle.path);
  return JSON.stringify(tree) === shown ? null : tree;
}

// Every HoMo CFD window tells serve.py once a minute that it is open; started
// without a console, serve.py stops itself when no window has been open for a
// while. If it is gone (stopped, or Quit), the window says so.
const HEARTBEAT_MS = 60 * 1000;
let serverWasReachable = false;

function showServerStopped() {
  if (document.getElementById("server-stopped")) return;
  const notice = document.createElement("div");
  notice.id = "server-stopped";
  notice.setAttribute("role", "alert");
  notice.style.cssText = "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:10000;max-width:min(560px,calc(100vw - 32px));" +
    "padding:10px 14px;border-radius:8px;background:#3b1719;border:1px solid #7d3034;color:#ffd7d3;font:14px 'Segoe UI',system-ui,sans-serif;" +
    "box-shadow:0 6px 20px #0008";
  notice.textContent = "HoMo CFD is not running any more. Start it again (desktop shortcut or Start HoMo CFD.bat), then reload this page.";
  document.body.appendChild(notice);
}

async function heartbeat() {
  try {
    const response = await fetch("/api/alive", { cache: "no-store" });
    if (response.ok) {
      serverWasReachable = true;
      document.getElementById("server-stopped")?.remove();
      return;
    }
  } catch {
    // not reachable
  }
  if (serverWasReachable) showServerStopped();
}

if (location.protocol.startsWith("http")) {
  heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);
}

// serve.py's working-directory settings ({ workingDir, source, resultsRoot,
// resultsPath, canBrowse }), or null when the page isn't served by serve.py.
async function getServerConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return null;
    const config = await response.json();
    return config && "workingDir" in config ? config : null;
  } catch {
    return null;
  }
}

async function postServerJson(endpoint, body = {}) {
  const response = await fetch(`/api/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || `Server request failed (${response.status})`);
  return result;
}

function reviveHandle(handle) {
  if (!handle?.homoServer) return handle;
  return handle.kind === "directory"
    ? new ServerDirectoryHandle(handle.path, handle.name)
    : new ServerFileHandle(handle.path, handle.name);
}
