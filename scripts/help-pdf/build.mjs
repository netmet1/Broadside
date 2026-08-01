/**
 * Build the help PDF that ships inside the app.
 *
 *   npm run help:pdf              letter paper, the default
 *   npm run help:pdf -- --a4      A4
 *   npm run help:pdf -- --keep    leave the intermediate HTML behind to look at
 *
 * Three steps: bundle the help prose into something node can run, render it to
 * a single HTML file, print that file. The result lands in
 * `src-tauri/resources/` and is committed, because the release MSI is built by
 * a cloud runner from what is in the repository.
 *
 * WHEN TO RUN THIS: at release, and only at release. See the rule in CLAUDE.md.
 * The PDF is a snapshot of the help at a version; regenerating it on every
 * change to a sentence would put a new binary in every commit and tell the
 * reader a version number that was never released.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { printToPdf } from "./print.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cacheDir = join(repoRoot, "node_modules", ".cache", "help-pdf");
const htmlPath = join(cacheDir, "help.html");
const outPath = join(repoRoot, "src-tauri", "resources", "broadside-help.pdf");

const args = process.argv.slice(2);
const paper = args.includes("--a4") ? "a4" : "letter";
const keepHtml = args.includes("--keep");

// The version exactly as the app shows it: the manifest number, plus the smoke
// test tag when this is a hand-over build. Read the same way `release.ps1`
// reads it, because neither can import a TypeScript module. A release has the
// tag cleared, so the cover reads a bare 1.3.0 and nothing else.
const version = (() => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
  ).version;
  const tag = /BUILD_TAG\s*=\s*"([^"]*)"/.exec(
    readFileSync(join(repoRoot, "src", "lib", "buildTag.ts"), "utf8"),
  )?.[1];
  return tag ? `${manifest}-build${tag}` : manifest;
})();

console.log(`Building the Broadside ${version} help PDF (${paper}).`);

// 1. The help prose, bundled for node.
await build({ configFile: join(here, "vite.config.mjs") });

// 2. The document, as one HTML file with the font and the logo inside it.
const render = spawnSync(
  process.execPath,
  [join(cacheDir, "render.mjs"), repoRoot, htmlPath, paper, version],
  { stdio: "inherit" },
);
if (render.status !== 0) {
  console.error("FAILED: could not render the help document.");
  process.exit(1);
}

// 3. Print it.
mkdirSync(dirname(outPath), { recursive: true });
const bytes = await printToPdf(htmlPath, outPath, version);
if (!keepHtml && existsSync(htmlPath)) rmSync(htmlPath);

// Best effort, for the log line only. Counting the page objects rather than
// reading the page tree's `/Count`, because the document outline has a `/Count`
// of its own and gets there first.
const pages = (
  readFileSync(outPath, "latin1").match(/\/Type\s*\/Page[^s]/g) ?? []
).length;

console.log(
  `Wrote ${outPath}\n  ${(bytes / 1024).toFixed(0)} KB` +
    (pages > 0 ? `, ${pages} pages` : "") +
    (keepHtml ? `\n  HTML kept at ${htmlPath}` : ""),
);
