import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  /** What to render when the child throws. Receives the caught error so the
   *  fallback can describe what broke without us having to globalise state. */
  fallback: (err: Error) => ReactNode;
  children: ReactNode;
}

interface State {
  err: Error | null;
}

/**
 * Minimal error boundary so a lazy-loaded chunk failure (e.g., three.js)
 * can't blank the whole tab. React doesn't expose a hook form yet, so this
 * stays a class component on purpose.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    // The harness console is the user's only feedback channel for this.
    // eslint-disable-next-line no-console
    console.error("ErrorBoundary caught:", err, info);
  }

  render() {
    if (this.state.err) return this.props.fallback(this.state.err);
    return this.props.children;
  }
}
