/**
 * Splits a secret into runs of letters, digits, symbols and spaces, so a shown
 * password can colour each kind the way password managers do: letters plain,
 * digits blue, symbols red. That is what tells `1` from `l` and `0` from `O`
 * at a glance.
 */
export type CharClass = "letter" | "digit" | "symbol" | "space";

export type CharRun = { cls: CharClass; text: string };

const LETTER = /[\p{L}\p{M}]/u;
const DIGIT = /\p{Nd}/u;
const SPACE = /\s/u;

export function charClassOf(ch: string): CharClass {
  if (LETTER.test(ch)) return "letter";
  if (DIGIT.test(ch)) return "digit";
  if (SPACE.test(ch)) return "space";
  return "symbol";
}

/** Consecutive characters of one class, joined. Walks code points, so an emoji
 * or other astral character stays whole. */
export function charRuns(text: string): CharRun[] {
  const runs: CharRun[] = [];
  for (const ch of text) {
    const cls = charClassOf(ch);
    const last = runs[runs.length - 1];
    if (last && last.cls === cls) last.text += ch;
    else runs.push({ cls, text: ch });
  }
  return runs;
}
