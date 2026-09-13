import type { ReactNode } from "react";
import { CircleHelpIcon, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useHint } from "@/lib/status";
import type { HelpSectionId } from "@/pages/help/sections";

/**
 * What a tab looks like before anything has been put in it.
 *
 * One component for Hosts, Skills and Templates, because a fresh install used
 * to show three different answers to the same question. Hosts had a line of
 * text inside an otherwise empty table, under column headings for data that did
 * not exist; Skills had a paragraph in the rail; the first thing a new operator
 * saw depended on which tab they happened to open.
 *
 * The four parts are in the order somebody reads them: what this is, the one
 * button that fixes it, a sentence saying what the thing actually does, and a
 * way to the page that explains it properly. The description is deliberately
 * below the button rather than above it, because the reader who already knows
 * what a host is should not have to read past a paragraph to find "Add host".
 *
 * A second button is allowed and stays quieter than the first (outline against
 * solid), for the case where the thing you want already exists somewhere else:
 * Templates has a file to import, and somebody arriving with one should not
 * have to make an empty template first to find the button that reads it.
 */
export function EmptyState({
  icon: Icon,
  title,
  actionLabel,
  onAction,
  actionHint,
  secondaryLabel,
  onSecondary,
  secondaryHint,
  description,
  helpSection,
  onOpenHelp,
}: {
  icon: LucideIcon;
  /** What is missing, in the plural: "Hosts", "Skills", "Templates". */
  title: string;
  actionLabel: string;
  onAction: () => void;
  /** Status-bar line for the button, as everywhere else. */
  actionHint: string;
  /** An optional second way in, drawn beside the first and less loudly. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  secondaryHint?: string;
  /** One or two sentences on what this thing is for. */
  description: ReactNode;
  helpSection: HelpSectionId;
  /** Opens the Help tab at `helpSection`. Absent leaves the link out, so a
   * caller that cannot navigate does not paint a dead one. */
  onOpenHelp?: (section: HelpSectionId) => void;
}) {
  const hint = useHint();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="h-6 w-6" />
      </span>
      <h2 className="font-heading text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={onAction} {...hint(actionHint)}>
          {actionLabel}
        </Button>
        {secondaryLabel && onSecondary && (
          <Button
            variant="outline"
            onClick={onSecondary}
            {...hint(secondaryHint ?? secondaryLabel)}
          >
            {secondaryLabel}
          </Button>
        )}
      </div>
      <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      {onOpenHelp && (
        <button
          type="button"
          onClick={() => onOpenHelp(helpSection)}
          className="mt-3 flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          {...hint("Open the Help tab at the section about this")}
        >
          <CircleHelpIcon className="h-3.5 w-3.5" />
          Read more in Help
        </button>
      )}
    </div>
  );
}
