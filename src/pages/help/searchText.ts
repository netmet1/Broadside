/**
 * The words of a help section, as a flat string the filter box can search.
 *
 * The filter used to match a section's title and its hidden keyword list and
 * nothing else, which meant a phrase you could see on the page in front of you
 * did not necessarily find the page it was on. `16/20 sessions connected` is
 * written out in Overview, and searching for it found nothing. Keywords are for
 * the words that are *not* on the page (the wrong name for a thing, the symptom
 * rather than the feature); they were never meant to be the whole index.
 *
 * Section bodies are plain elements built once at module load, so their text can
 * be walked straight out of the tree without rendering anything. The one thing a
 * walk cannot see through is a component that builds its own text from data, and
 * the two reference tables do exactly that; those carry their words on a
 * `searchText` property, which this reads instead of descending.
 */

import { isValidElement, type ReactNode } from "react";

/** A component that generates its own text and so cannot be walked into. It
 * publishes what it will render, derived from the same data it renders from, so
 * the two cannot drift apart. */
export type Searchable = { searchText: string };

/** A component that renders one of its own props as text — `<Term term="SSH" />`
 * puts "SSH" on the page while having no children at all. Naming the props here
 * is how a walk of the tree sees those words. */
export type PropSearchable = { searchProps: readonly string[] };

function hasSearchText(type: unknown): type is Searchable {
  return (
    typeof type === "function" &&
    typeof (type as Partial<Searchable>).searchText === "string"
  );
}

function hasSearchProps(type: unknown): type is PropSearchable {
  return (
    typeof type === "function" &&
    Array.isArray((type as Partial<PropSearchable>).searchProps)
  );
}

/** Every string in a node, in reading order, separated by spaces.
 *
 * Spaces rather than nothing: JSX drops the whitespace around a line break, so
 * `like <Nav>this</Nav> here` arrives as three pieces that would otherwise be
 * run together into one unsearchable word. The cost is that a phrase split
 * across two elements gains a space in the middle, which is why the search
 * compares on single-spaced text at both ends. */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).filter(Boolean).join(" ");
  }
  if (isValidElement(node)) {
    if (hasSearchText(node.type)) return node.type.searchText;
    const props = node.props as Record<string, unknown> & {
      children?: ReactNode;
    };
    const fromProps = hasSearchProps(node.type)
      ? node.type.searchProps
          .map((p) => (typeof props[p] === "string" ? props[p] : ""))
          .filter(Boolean)
          .join(" ")
      : "";
    return [fromProps, textOf(props.children)].filter(Boolean).join(" ");
  }
  // Anything else (a portal, an iterable) contributes nothing. Nothing in Help
  // is built that way, and a wrong guess here would be silent.
  return "";
}

/** `textOf` with the whitespace flattened, ready to be matched against a query
 * that has had the same done to it. */
export function searchableText(node: ReactNode): string {
  return textOf(node).replace(/\s+/g, " ").trim().toLowerCase();
}
