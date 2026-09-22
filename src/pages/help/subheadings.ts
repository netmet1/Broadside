/**
 * The sub-headers of each help section, for the rail under the section in view.
 *
 * Read off the same element tree the search walks (see ./searchText), so a
 * heading added to a section shows in the rail with nothing else to update.
 * The heading component marks itself with `isSubheading`; a walk compares on
 * that rather than on a function name, which minification would change.
 *
 * Nothing here gives the headings ids. The rail finds the Nth heading of a
 * section in the DOM when it needs one, which keeps `content.tsx` free of
 * anchors that would have to stay unique across fourteen sections (two of
 * them already have a "Building one").
 */

import { isValidElement, type ReactNode } from "react";

import { textOf } from "./searchText";

export type Subheading = { isSubheading: true };

function isSubheading(type: unknown): type is Subheading {
  return (
    typeof type === "function" &&
    (type as Partial<Subheading>).isSubheading === true
  );
}

/** Every sub-header in a section body, in reading order. */
export function subheadingsOf(node: ReactNode): string[] {
  const out: string[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    const children = (n.props as { children?: ReactNode }).children;
    if (isSubheading(n.type)) {
      const title = textOf(children).replace(/\s+/g, " ").trim();
      if (title) out.push(title);
      return;
    }
    walk(children);
  };
  walk(node);
  return out;
}

/** The rendered heading elements of one section, in the order `subheadingsOf`
 * lists them. */
export function subheadingElements(sectionId: string): HTMLElement[] {
  const section = document.getElementById(sectionId);
  if (!section) return [];
  return Array.from(section.querySelectorAll<HTMLElement>('h3[data-h="h3"]'));
}
