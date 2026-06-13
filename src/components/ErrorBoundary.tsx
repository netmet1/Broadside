import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

type Props = {
  children: ReactNode;
  /** Shown in the fallback so the user knows which area failed. */
  label?: string;
  /** Render-prop fallback override; defaults to the standard panel. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = { error: Error | null };

/** Catches render-time exceptions in its subtree so one component's crash
 * shows a recoverable panel instead of unmounting the whole React root (which
 * presented as a blank white window requiring an app restart — smoke test
 * 7.2). Reset re-mounts the subtree without restarting the app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the stack for diagnosis (e.g. the xterm search throw behind 7.2).
    console.error(
      `[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`,
      error,
      info.componentStack,
    );
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <p className="text-sm font-medium text-red-400">
            {this.props.label
              ? `Something went wrong in ${this.props.label}.`
              : "Something went wrong."}
          </p>
          <p className="break-words font-mono text-xs text-muted-foreground">
            {error.message}
          </p>
          <Button variant="outline" size="sm" onClick={this.reset}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
}
