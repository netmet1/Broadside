import "@/lib/zodConfig";
import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { InstanceGuard } from "@/components/InstanceGuard";
import { otherInstanceCount } from "@/lib/tauri/instances";
import { IS_MAC } from "@/lib/platform";
import { installNoAutoCapitalize } from "@/lib/noAutoCapitalize";
import "./index.css";

installNoAutoCapitalize();

// Whether another copy is already running is asked before the first render, so
// the first frame the window shows is the right one: the app, or the warning
// in front of it. A failed check is treated as "none" rather than holding the
// app back.
function render(others: number) {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        {/* Dark is the default (D-063); the class is applied to <html>. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <InstanceGuard others={others}>
            <App />
          </InstanceGuard>
        </ThemeProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

// The window is created hidden (tauri.conf.json `visible: false`). Rust restores
// its saved size/position during window creation, before any of this JS runs,
// so by the time we reveal it the window is already at its last geometry. We
// wait two frames so the first paint has landed, then ask Rust to reveal it:
// `reveal_main_window` shows the window and, only then (while it is visible),
// re-applies the saved maximized state. Maximizing the still-hidden window is
// what flashed an empty frame on launch, so it is deliberately deferred here.
function revealWindow() {
  // Don't swallow failures: if revealing the window ever fails (e.g. a missing
  // capability), surfacing it beats a silently invisible app.
  invoke("reveal_main_window").catch((e) =>
    console.error("[main] failed to reveal window", e),
  );
}

function showWindow() {
  if (IS_MAC) {
    // WebKit runs no animation frames for a window that is not on screen, so
    // on a Mac the wait below would never end and the app would never appear.
    // The window is shown straight away instead; at most its dark background
    // shows for the moment before the first paint.
    revealWindow();
  } else {
    requestAnimationFrame(() => {
      requestAnimationFrame(revealWindow);
    });
  }
}

otherInstanceCount()
  .catch((e) => {
    console.error("[main] failed to count other instances", e);
    return 0;
  })
  .then((others) => {
    render(others);
    showWindow();
  });
