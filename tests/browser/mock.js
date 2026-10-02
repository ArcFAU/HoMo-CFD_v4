// Test double for pages opened without serve.py: File System Access handles
// over the test server's /mock-list and /mock-file routes, plus an in-memory
// IndexedDB shared with the runner page (window.top), so mocked handles can be
// handed to viewer iframes. Injected only into /__*_test.html pages.
(() => {
  const top = window.top;
  if (!top.__mockStore) top.__mockStore = new Map();
  const store = top.__mockStore;

  class MockFile {
    constructor(path, name) { this.kind = "file"; this.path = path; this.name = name; }
    async getFile() {
      const response = await fetch(`/mock-file/${this.path}`);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${this.name}`);
      return new File([await response.blob()], this.name);
    }
  }

  class MockDir {
    constructor(path, permission = "granted") {
      this.kind = "directory"; this.path = path; this.name = path.split("/").pop(); this.permission = permission;
    }
    async list() { return (await fetch(`/mock-list/${this.path}`)).json(); }
    async *values() {
      for (const entry of await this.list()) {
        const child = `${this.path}/${entry.name}`;
        yield entry.kind === "directory" ? new MockDir(child) : new MockFile(child, entry.name);
      }
    }
    async getDirectoryHandle(name) {
      if (!(await this.list()).some((entry) => entry.name === name && entry.kind === "directory")) throw new DOMException("missing", "NotFoundError");
      return new MockDir(`${this.path}/${name}`);
    }
    async getFileHandle(name) {
      if (!(await this.list()).some((entry) => entry.name === name && entry.kind === "file")) throw new DOMException("missing", "NotFoundError");
      return new MockFile(`${this.path}/${name}`, name);
    }
    async queryPermission() { return this.permission; }
    async requestPermission() { this.permission = "granted"; return "granted"; }
  }
  top.MockDir = top.MockDir || MockDir;

  // Requests run in order on timers; oncomplete fires once none are pending.
  function makeTransaction() {
    const transaction = { pending: 0, done: false };
    const finish = () => setTimeout(() => {
      if (transaction.pending === 0 && !transaction.done) { transaction.done = true; transaction.oncomplete?.(); }
    }, 0);
    const request = (operation) => {
      const handle = {};
      transaction.pending++;
      setTimeout(() => {
        try { handle.result = operation(); handle.onsuccess?.({ target: handle }); }
        catch (error) { handle.error = error; handle.onerror?.(); transaction.onerror?.(); }
        transaction.pending--;
        finish();
      }, 0);
      return handle;
    };
    transaction.objectStore = () => ({
      put: (value, key) => request(() => { store.set(key, value); return key; }),
      get: (key) => request(() => store.get(key)),
      delete: (key) => request(() => { store.delete(key); }),
      getAllKeys: () => request(() => [...store.keys()]),
      count: () => request(() => store.size),
    });
    finish();
    return transaction;
  }

  Object.defineProperty(window, "indexedDB", { configurable: true, value: {
    open() {
      const handle = {};
      setTimeout(() => { handle.result = { transaction: makeTransaction, close() {}, createObjectStore() {} }; handle.onsuccess?.(); }, 0);
      return handle;
    },
  } });
  window.showDirectoryPicker = async () => new top.MockDir(top.__pickPath);
  window.open = (url) => {
    const popup = { closed: false, close() { this.closed = true; }, location: {} };
    Object.defineProperty(popup.location, "href", { set: (value) => top.__openViewer(value) });
    if (url && url !== "about:blank") top.__openViewer(url);
    return popup;
  };
})();
