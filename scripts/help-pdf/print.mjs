/**
 * Printing the help document, using the browser that is already on the machine.
 *
 * Windows ships Edge and the release runner has it too, so the PDF is made by
 * the same engine the app's own webview uses. Nothing is installed for this and
 * no package is added to the tree: a headless window opens on a local file,
 * prints it, and closes.
 *
 * The devtools protocol rather than the plain `--print-to-pdf` switch, for one
 * reason: page numbers. The switch prints either a browser-styled header with
 * the file's URL in it or nothing at all, while the protocol takes a footer of
 * our own. That footer is the only place in the document that can count pages,
 * because a printing browser will not do it in CSS.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PAGE } from "./page.mjs";

/** Where a Chromium lives on Windows, best first. `BROADSIDE_CHROME` overrides
 * the lot, for a machine that keeps one somewhere else. */
const BROWSERS = [
  process.env.BROADSIDE_CHROME,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean);

const PORT_FILE_TIMEOUT_MS = 25_000;
const PRINT_TIMEOUT_MS = 120_000;

function findBrowser() {
  const found = BROWSERS.find((p) => existsSync(p));
  if (found) return found;
  throw new Error(
    "No Edge or Chrome found to print with. Install Microsoft Edge, or set " +
      "BROADSIDE_CHROME to a Chromium executable.",
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The port the browser chose, which it writes into its profile directory once
 * it is listening. Asking for port 0 and reading it back avoids fighting over a
 * fixed port with anything else on the machine. */
async function waitForPort(userDataDir) {
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + PORT_FILE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (first) return Number(first);
    }
    await sleep(100);
  }
  throw new Error("The browser did not start a devtools port in time.");
}

/** A very small devtools client: send a command, get its result. Enough for
 * open, load, print, close, and nothing more. */
class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();
  #waiters = [];

  static async connect(url) {
    const c = new Cdp();
    c.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      c.#ws.addEventListener("open", resolve, { once: true });
      c.#ws.addEventListener("error", () => reject(new Error("devtools connection failed")), { once: true });
    });
    c.#ws.addEventListener("message", (ev) => c.#onMessage(ev));
    return c;
  }

  #onMessage(ev) {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    for (const w of this.#waiters.splice(0)) {
      if (w.method === msg.method) w.resolve(msg.params);
      else this.#waiters.push(w);
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  once(method) {
    return new Promise((resolve) => this.#waiters.push({ method, resolve }));
  }

  close() {
    this.#ws.close();
  }
}

const footerTemplate = (version) => `
<div style="width:100%;padding:0 ${PAGE.sideMm}mm;font-family:'Segoe UI',Arial,sans-serif;
            font-size:7pt;color:#8a94a0;display:flex;justify-content:space-between;">
  <span>Broadside ${version} &middot; Help and reference</span>
  <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;

/**
 * Print `htmlPath` to `pdfPath`. Returns the size in bytes.
 */
export async function printToPdf(htmlPath, pdfPath, version) {
  const exe = findBrowser();
  const userDataDir = mkdtempSync(join(tmpdir(), "broadside-help-pdf-"));
  const child = spawn(
    exe,
    [
      "--headless=new",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--font-render-hinting=none",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  const timer = setTimeout(() => child.kill(), PRINT_TIMEOUT_MS);
  let cdp;
  try {
    const port = await waitForPort(userDataDir);
    const version_ = await fetch(`http://127.0.0.1:${port}/json/version`);
    const { webSocketDebuggerUrl } = await version_.json();
    cdp = await Cdp.connect(webSocketDebuggerUrl);

    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    await cdp.send("Page.enable", {}, sessionId);
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send(
      "Page.navigate",
      { url: pathToFileURL(htmlPath).href },
      sessionId,
    );
    await loaded;
    // The typeface is inlined in the document, but "inlined" still means
    // decoded asynchronously; printing before it is ready lays the whole book
    // out in the fallback font.
    await cdp.send(
      "Runtime.evaluate",
      { expression: "document.fonts.ready.then(() => true)", awaitPromise: true },
      sessionId,
    );

    const { data } = await cdp.send(
      "Page.printToPDF",
      {
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: "<div></div>",
        footerTemplate: footerTemplate(version),
        generateDocumentOutline: true,
      },
      sessionId,
    );

    const bytes = Buffer.from(data, "base64");
    writeFileSync(pdfPath, bytes);
    await cdp.send("Target.closeTarget", { targetId });
    return bytes.length;
  } finally {
    clearTimeout(timer);
    cdp?.close();
    child.kill();
    // The browser needs a moment to let go of its profile before it can go.
    await sleep(300);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // A locked profile directory in the temp folder is not worth failing a
      // release build over; Windows will clear it later.
    }
  }
}
