import { Component, type ErrorInfo, type ReactNode } from "react";

type MdxPreviewErrorBoundaryProps = {
  componentName: string;
  /** Rendered instead of the host component after it throws. */
  fallback: ReactNode;
  children?: ReactNode;
};

type MdxPreviewErrorBoundaryState = {
  hasError: boolean;
};

/**
 * Contains errors thrown while rendering a host MDX component's preview, so a
 * broken or mis-registered component shows its fallback instead of taking the
 * whole editor down. The document content is not affected.
 */
export class MdxPreviewErrorBoundary extends Component<
  MdxPreviewErrorBoundaryProps,
  MdxPreviewErrorBoundaryState
> {
  override state: MdxPreviewErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): MdxPreviewErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    console.warn(
      `MDCMS Studio: the preview of MDX component "${this.props.componentName}" failed to render.`,
      error,
      errorInfo.componentStack,
    );
  }

  override render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
