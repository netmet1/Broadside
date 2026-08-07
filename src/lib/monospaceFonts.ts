/**
 * Which monospace fonts this machine can actually render.
 *
 * The Terminal font setting used to be a free-text CSS font-family list, which
 * put the whole burden of being right on the person typing: a misspelling, or a
 * font that simply is not installed, silently fell through to the next name in
 * the list, and the only symptom was a terminal that looked slightly wrong. The
 * shipped default said `Consolas, 'Cascadia Mono', monospace` for exactly that
 * reason, three names deep so that *something* would land. A list of fonts that
 * are known to be here needs no fallback chain, because every entry in it has
 * already been proved to work.
 *
 * Detection is done here rather than asked of the OS. `queryLocalFonts()` is the
 * API for this and it raises a permission prompt, which is a lot of ceremony for
 * a settings dropdown; reading the Windows font registry means a new Rust
 * dependency for a list we can measure our way to. Measuring is the old trick
 * and it is exact: ask the canvas to draw a string in the candidate font, and
 * see whether the answer differs from what the generic fallback alone gives. A
 * font that is not installed cannot change the width of anything.
 *
 * The candidate list is therefore the one real limit: a font nobody thought to
 * name here is invisible even if it is installed. It is deliberately long, and
 * covers the Windows built-ins, the fonts that ship with developer tooling, and
 * the Nerd Font repacks by the names their installers actually register.
 */

/** Families to probe. Only the ones that turn out to be installed AND to
 * measure as monospace survive, so an over-long list costs a few microseconds
 * and never a wrong entry. Ordered by family for readability only; the result
 * is sorted before it is returned. */
const CANDIDATES: string[] = [
  // Windows built-ins, and the Cascadia family that ships with Terminal / VS.
  "Cascadia Code",
  "Cascadia Code PL",
  "Cascadia Mono",
  "Cascadia Mono PL",
  "Consolas",
  "Courier New",
  "Lucida Console",
  "Lucida Sans Typewriter",
  "MS Gothic",
  "NSimSun",
  "SimSun-ExtB",
  // Widely installed developer fonts.
  "Anonymous Pro",
  "Berkeley Mono",
  "Commit Mono",
  "DejaVu Sans Mono",
  "Envy Code R",
  "Fantasque Sans Mono",
  "Fira Code",
  "Fira Mono",
  "Geist Mono",
  "Hack",
  "IBM Plex Mono",
  "Inconsolata",
  "Input Mono",
  "Iosevka",
  "Iosevka Term",
  "JetBrains Mono",
  "JetBrains Mono NL",
  "Liberation Mono",
  "Menlo",
  "Meslo LG L",
  "Meslo LG M",
  "Meslo LG S",
  "Monaco",
  "Noto Sans Mono",
  "Overpass Mono",
  "PT Mono",
  "Red Hat Mono",
  "Roboto Mono",
  "SF Mono",
  "Source Code Pro",
  "Space Mono",
  "Terminus",
  "Ubuntu Mono",
  "Victor Mono",
  // Nerd Font repacks, under the family names their installers register. The
  // "Propo" variants are deliberately absent: they are proportional, and the
  // monospace check below would drop them anyway.
  "3270 Nerd Font",
  "AnonymicePro Nerd Font",
  "BlexMono Nerd Font",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "Cousine Nerd Font",
  "DejaVuSansMono Nerd Font",
  "FiraCode Nerd Font",
  "FiraMono Nerd Font",
  "GoMono Nerd Font",
  "Hack Nerd Font",
  "Hasklug Nerd Font",
  "Inconsolata Nerd Font",
  "Iosevka Nerd Font",
  "IosevkaTerm Nerd Font",
  "JetBrainsMono Nerd Font",
  "Lilex Nerd Font",
  "MartianMono Nerd Font",
  "MesloLGL Nerd Font",
  "MesloLGM Nerd Font",
  "MesloLGS NF",
  "MesloLGS Nerd Font",
  "MonaspiceNe Nerd Font",
  "NotoSansM Nerd Font",
  "RobotoMono Nerd Font",
  "SauceCodePro Nerd Font",
  "ShureTechMono Nerd Font",
  "SpaceMono Nerd Font",
  "Terminess Nerd Font",
  "UbuntuMono Nerd Font",
  "VictorMono Nerd Font",
];

/** The generic families the probe measures against. Three of them, because a
 * candidate that happens to have the same metrics as one generic will not have
 * the same as all three, and one base alone turns that coincidence into a font
 * that is installed but reported missing. */
const BASES = ["monospace", "serif", "sans-serif"] as const;

/** Big enough that a one-part-in-a-thousand metric difference between two fonts
 * is a whole pixel or more, which is what makes the comparison reliable. */
const PROBE_PX = 72;

/** Mixed widths on purpose: a string of one repeated glyph can match between two
 * different fonts by chance far more easily than this can. */
const PROBE_TEXT = "mmmmmmmmmmlli0OiIl1";

/** The always-present entry. Whatever the OS considers monospace: never wrong,
 * never missing, and the only thing left to offer if detection finds nothing
 * (a canvas that will not give a 2d context, most likely). */
export const GENERIC_MONOSPACE = "monospace";

/** Render a family name as a CSS `font-family` value. Always quoted, because a
 * name may begin with a digit (`3270 Nerd Font`), which is not a valid unquoted
 * CSS identifier; the generic keyword must never be quoted, because quoting it
 * turns it into a request for a font literally called "monospace". */
export function cssFontFamily(family: string): string {
  return family === GENERIC_MONOSPACE ? family : `"${family}"`;
}

/** What gets stored in settings for a chosen family: the family, with the
 * generic kept behind it. The tail is not the old fallback chain coming back;
 * every family offered has been proved installed. It is insurance against the
 * font being uninstalled later, so a terminal degrades to something monospaced
 * rather than to whatever proportional face the webview defaults to. */
export function storedFontValue(family: string): string {
  return family === GENERIC_MONOSPACE
    ? GENERIC_MONOSPACE
    : `${cssFontFamily(family)}, ${GENERIC_MONOSPACE}`;
}

/** First family named in a stored CSS font-family list, unquoted and trimmed.
 * Generic keywords are skipped, so `Consolas, monospace` gives `Consolas` and a
 * bare `monospace` gives nothing. */
function familiesIn(stored: string): string[] {
  return stored
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
}

/**
 * Which entry in the list a stored setting corresponds to.
 *
 * This is what makes the change from a text box to a dropdown invisible to
 * anyone upgrading. A stored `Consolas, 'Cascadia Mono', monospace` is not one
 * family, but it has always *resolved* to one: the first name in it that is
 * actually installed, which is precisely what the browser was already doing when
 * it picked a face. Returning that name selects the font the operator has been
 * looking at all along, rather than appearing to change their setting.
 *
 * Returns null when nothing in the stored list is installed, which leaves the
 * caller to decide (it keeps the raw string as its own entry rather than
 * silently moving anyone onto a font they did not choose).
 */
export function resolveStoredFamily(
  stored: string,
  installed: readonly string[],
): string | null {
  const known = new Set(installed);
  for (const family of familiesIn(stored)) {
    if (known.has(family)) return family;
    // Case-insensitive second look: CSS family matching is, and a value typed
    // by hand into the old box very often was not capitalised as the font is.
    const hit = installed.find(
      (f) => f.toLowerCase() === family.toLowerCase(),
    );
    if (hit) return hit;
    if (BASES.includes(family as (typeof BASES)[number])) {
      return GENERIC_MONOSPACE;
    }
  }
  return null;
}

/** Width of `PROBE_TEXT` in a given CSS font-family value. */
function widthOf(ctx: CanvasRenderingContext2D, fontFamily: string): number {
  ctx.font = `${PROBE_PX}px ${fontFamily}`;
  return ctx.measureText(PROBE_TEXT).width;
}

/** Whether every glyph in this font is the same width. Catches the proportional
 * faces that share a name with a monospace family (several Nerd Font repacks
 * ship both), which are exactly the ones that would look wrong in a terminal
 * and give no clue why. */
function isMonospace(ctx: CanvasRenderingContext2D, family: string): boolean {
  ctx.font = `${PROBE_PX}px ${cssFontFamily(family)}`;
  const narrow = ctx.measureText("iiiiiiiiii").width;
  const wide = ctx.measureText("WWWWWWWWWW").width;
  // Not exact equality: hinting and subpixel positioning move the last decimal
  // place around, and a genuinely proportional face differs by a factor, not by
  // a rounding error.
  return Math.abs(narrow - wide) < 0.5;
}

/**
 * The monospace fonts installed on this machine, sorted, with the generic
 * `monospace` entry first.
 *
 * Not cached at module scope on purpose: the result is only ever asked for when
 * the Settings page mounts, and a stale list would outlive a font being
 * installed. (It would anyway, in truth: the webview caches the system font list
 * for the life of the process, so a font installed while Broadside is running
 * needs a restart before it can be measured at all. The Settings copy says so.)
 */
export function detectMonospaceFonts(): string[] {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return [GENERIC_MONOSPACE];

  // The baseline widths, one per generic. Measured once rather than per
  // candidate: they cannot change between candidates.
  const baseWidths = BASES.map((base) => widthOf(ctx, base));

  const found: string[] = [];
  for (const family of CANDIDATES) {
    // Installed if naming it first changes the answer for ANY of the three
    // generics. It cannot displace a fallback it is not there to displace.
    const installed = BASES.some(
      (base, i) =>
        widthOf(ctx, `${cssFontFamily(family)}, ${base}`) !== baseWidths[i],
    );
    if (installed && isMonospace(ctx, family)) found.push(family);
  }

  found.sort((a, b) => a.localeCompare(b));
  return [GENERIC_MONOSPACE, ...found];
}
