/**
 * The help document, as one self-contained HTML file for the printer.
 *
 * Runs in node (via the SSR bundle beside this file), not in the app. It takes
 * the very same elements the Help tab renders and puts them in a document
 * shell: a cover, a contents page, and every section starting on a page of its
 * own. Nothing is retyped, so the PDF cannot say something the app does not.
 *
 * The app's Tailwind classes come along for the ride and are ignored: paper has
 * no dark mode, no hover and no viewport. `document.css` styles the elements
 * and the `data-h` attributes instead (see `src/pages/help/content.tsx`).
 *
 * Everything the page needs is inlined as a data URI: the typeface and the
 * logo. The printer is launched with no network of its own, and a help file
 * that quietly loses its font on a different machine would be worse than one
 * that never had it.
 *
 * Usage: node render.mjs <repoRoot> <outHtmlPath> <paper> <version>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import { SECTIONS } from "@/pages/help/content";

import { PAGE } from "./page.mjs";

const [repoRoot, outPath, paper = "letter", version] = process.argv.slice(2);
if (!repoRoot || !outPath || !version) {
  throw new Error("usage: render.mjs <repoRoot> <outHtmlPath> <paper> <version>");
}

const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts));
const dataUri = (mime: string, bytes: Buffer) =>
  `data:${mime};base64,${bytes.toString("base64")}`;

const fontDir = ["node_modules", "@fontsource-variable", "geist", "files"];
const fonts = {
  normal: dataUri(
    "font/woff2",
    read(...fontDir, "geist-latin-wght-normal.woff2"),
  ),
  italic: dataUri(
    "font/woff2",
    read(...fontDir, "geist-latin-wght-italic.woff2"),
  ),
};
// The 512px icon rather than the 1024px `app-icon.png` at the repository root:
// a printing browser embeds an image at its own resolution, not the size it is
// drawn at, and the larger one put more than a megabyte of cover art into a
// document nobody will hold a loupe to.
const logo = dataUri("image/png", read("src-tauri", "icons", "icon.png"));

/** Escapes text going into the shell's own markup (titles, the version line).
 * The section bodies come from React already escaped. */
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const issued = new Date().toLocaleDateString("en-GB", {
  month: "long",
  year: "numeric",
});

const contents = SECTIONS.map(
  (s, i) => `<li><a href="#${s.id}"><span class="toc-num">${i + 1}</span>
      <span class="toc-title">${esc(s.title)}</span></a></li>`,
).join("\n");

const chapters = SECTIONS.map(
  (s, i) => `<section class="chapter" id="${s.id}">
    <p class="chapter-num">Section ${i + 1}</p>
    <h1 class="chapter-title">${esc(s.title)}</h1>
    ${renderToStaticMarkup(<>{s.body}</>)}
  </section>`,
).join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Broadside ${esc(version)} help</title>
<style>
@font-face {
  font-family: "Geist Doc";
  src: url("${fonts.normal}") format("woff2-variations");
  font-weight: 100 900;
  font-style: normal;
}
@font-face {
  font-family: "Geist Doc";
  src: url("${fonts.italic}") format("woff2-variations");
  font-weight: 100 900;
  font-style: italic;
}
@page {
  size: ${paper === "a4" ? "A4" : "letter"};
  margin: ${PAGE.topMm}mm ${PAGE.sideMm}mm ${PAGE.bottomMm}mm;
}
@page :first { margin: 0; }
/* The cover has no page margin of its own, so it indents its text by hand.
   This is that margin, handed to the stylesheet. */
:root { --side: ${PAGE.sideMm}mm; }
${read("scripts", "help-pdf", "document.css").toString("utf8")}
</style>
</head>
<body>

<section class="cover">
  <div class="cover-art"><img src="${logo}" alt="Broadside"></div>
  <div class="cover-text">
    <p class="cover-eyebrow">Handbook</p>
    <h1>Broadside</h1>
    <p class="cover-subtitle">Help and reference</p>
    <p class="cover-standfirst">
      Every tab of Broadside, control by control: what it does, what it will ask
      you first, and what it will not do behind your back. With a glossary for
      the terms and two reference tables for the keys and the warnings.
    </p>
    <p class="cover-meta">
      <span class="cover-version">Version ${esc(version)}</span>
      <span class="cover-dot">&middot;</span>
      <span>${esc(issued)}</span>
    </p>
  </div>
</section>

<section class="toc">
  <h1>Contents</h1>
  <ol>
${contents}
  </ol>
  <p class="toc-note">
    This is the same help the app carries, printed as it stood at version
    ${esc(version)}. The copy inside Broadside is the one that is kept up to
    date: open <span data-h="nav">Help</span> in the app if this document is
    older than the version you are running.
  </p>
</section>

<main>
${chapters}
</main>

</body>
</html>
`;

writeFileSync(outPath, html, "utf8");
process.stdout.write(
  `help document: ${SECTIONS.length} sections, ${(html.length / 1024).toFixed(0)} KB of HTML\n`,
);
