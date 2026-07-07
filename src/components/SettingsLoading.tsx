import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";

/** Status lines shown under the spinner while Settings warms up. They advance
 * roughly every 550ms (>3 per 2s) and hold on the last one until the page is
 * ready, so the panel always feels alive even during a long first render. */
const MESSAGES = [
  "Loading page…",
  "Pulling current settings…",
  "Reading your preferences…",
  "Preparing controls…",
  "Almost done…",
];

/**
 * Full-bleed loading panel the shell overlays on the Settings tab while the
 * (large) page mounts for the first time. The spinner is a CSS transform
 * animation, so it keeps turning on the compositor even if the first render
 * briefly blocks the main thread — the user never faces a blank/frozen tab.
 */
export function SettingsLoading() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setStep((n) => (n < MESSAGES.length - 1 ? n + 1 : n)),
      550,
    );
    return () => clearInterval(id);
  }, []);

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-background">
      <Loader2Icon className="h-8 w-8 animate-spin text-primary" />
      <p className="text-sm font-medium text-muted-foreground" aria-live="polite">
        {MESSAGES[step]}
      </p>
    </div>
  );
}
