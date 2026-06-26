import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

// The window is created hidden (tauri.conf.json `visible: false`) so it never
// flashes at the default centered position before the window-state plugin
// restores its saved geometry. That restore (and the off-screen recenter check)
// finishes during window creation — before any of this JS runs — so by the time
// we reveal the window it is already at its last position/size. Wait two frames
// so the first paint has landed, then show: the window appears once, in place,
// with content already drawn (no "blink here first, then jump").
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    // Don't swallow failures: if showing the window ever fails (e.g. a missing
    // capability), surfacing it beats a silently invisible app.
    getCurrentWindow()
      .show()
      .catch((e) => console.error("[main] failed to show window", e));
  });
});
