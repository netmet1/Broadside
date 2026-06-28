import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import "./index.css";

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
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

// The window is created hidden (tauri.conf.json `visible: false`). Rust restores
// its saved size/position during window creation — before any of this JS runs —
// so by the time we reveal it the window is already at its last geometry. We
// wait two frames so the first paint has landed, then ask Rust to reveal it:
// `reveal_main_window` shows the window and, only then (while it is visible),
// re-applies the saved maximized state. Maximizing the still-hidden window is
// what flashed an empty frame on launch, so it is deliberately deferred here.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    // Don't swallow failures: if revealing the window ever fails (e.g. a missing
    // capability), surfacing it beats a silently invisible app.
    invoke("reveal_main_window").catch((e) =>
      console.error("[main] failed to reveal window", e),
    );
  });
});
