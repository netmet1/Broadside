/**
 * The page geometry, in one place because two documents have to agree on it.
 *
 * The help itself is laid out by `document.css` inside these margins, and the
 * running footer is a separate little document the browser draws in the bottom
 * margin. If the two disagree the page number sits out of line with the text
 * above it, which is the kind of thing nobody can name but everybody sees.
 *
 * The side margin is what it is for the sake of the line length. A Letter sheet
 * with narrow margins gives a hundred characters a line, which is a wall to
 * read; 28mm a side brings it back to the mid eighties.
 */

export const PAGE = {
  sideMm: 28,
  topMm: 20,
  bottomMm: 18,
};
