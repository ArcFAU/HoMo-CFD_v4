// Shared helpers for the browser test pages. Each page defines main() and
// calls runTests(main); results are POSTed to the test server.
const results = [];
const pageErrors = [];
const check = (name, condition, detail = "") => results.push({ name, pass: !!condition, detail: String(detail ?? "") });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(probe, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const value = probe(); if (value) return value; } catch {}
    await sleep(50);
  }
  return null;
}

// Opened windows become iframes so they can be inspected. Pages served by
// serve.py get window.open redirected here; mocked pages do it in mock.js.
let opened = [];
function frame(src, { captureOpen = false } = {}) {
  const element = document.createElement("iframe");
  element.style.width = "1400px";
  element.style.height = "900px";
  element.addEventListener("load", () => {
    const win = element.contentWindow;
    win.addEventListener("error", (event) => pageErrors.push(`${src}: ${event.message}`));
    win.addEventListener("unhandledrejection", (event) => pageErrors.push(`${src}: ${event.reason?.message || event.reason}`));
    if (captureOpen) {
      win.open = (url) => {
        const popup = { closed: false, close() { this.closed = true; }, location: {} };
        Object.defineProperty(popup.location, "href", { set: (value) => opened.push(frame(new URL(value, win.location.href).href, { captureOpen: true })) });
        if (url && url !== "about:blank") opened.push(frame(new URL(url, win.location.href).href, { captureOpen: true }));
        return popup;
      };
    }
  });
  element.src = src;
  document.body.appendChild(element);
  return element;
}

function resetFrames() {
  document.querySelectorAll("iframe").forEach((element) => element.remove());
  opened = [];
  window.__mockStore?.clear();
}

const rowNames = (doc) => [...doc.querySelectorAll(".data-table tbody tr td:first-child")].map((td) => td.textContent);
const key = (win, name) => win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: name, bubbles: true }));
const captionIndex = (doc, panel) => Number(doc.querySelectorAll(".compare-image-caption")[panel]?.textContent.match(/· (\d+) \//)?.[1]);
async function idle(win) { await waitFor(() => win.eval("pendingActions") === 0); await sleep(50); }

function runTests(main) {
  main()
    .catch((error) => check("test page crashed", false, error.stack))
    .finally(() => {
      check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" || "));
      fetch("/result", { method: "POST", body: JSON.stringify(results) });
    });
}
