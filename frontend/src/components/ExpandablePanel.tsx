import { ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: ReactNode;
  /** Optional small text shown on the right of the title. */
  subtitle?: ReactNode;
  /** Extra controls rendered in the panel head (e.g. selectors). */
  headExtras?: ReactNode;
  /** `data-panel` value, mirrored on both the inline panel and the overlay. */
  dataPanel?: string;
  /** Optional extra class names applied to the outer `.panel`. */
  className?: string;
  /** Inline grid hint — e.g. "span 2" to give a panel double width in the
   *  responsive auto-fit grid. */
  spanColumns?: number;
  children: ReactNode;
}

/**
 * Panel wrapper that supports a "zoom to overlay" interaction.
 *
 * Renders a normal `.panel` inline so it participates in the responsive
 * grid. Clicking the expand button (top-right) opens a full-viewport
 * overlay that re-renders the same children at a larger size. ESC or the
 * close button collapses it back. The children prop is rendered in *one*
 * place at a time — switching between inline and overlay — so internal
 * state (e.g. uPlot canvases, three.js scenes) gets recreated rather than
 * trying to teleport DOM nodes. That's intentional: stateful components
 * tend to break under React portal moves.
 */
export function ExpandablePanel({
  title,
  subtitle,
  headExtras,
  dataPanel,
  className,
  spanColumns,
  children,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    // Lock body scroll while the overlay is up so the page underneath
    // doesn't shift around when the user scrolls inside the overlay.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  const style: React.CSSProperties | undefined =
    spanColumns && spanColumns > 1 ? { gridColumn: `span ${spanColumns}` } : undefined;

  const head = (
    <div className="panel-head">
      <h2>{title}</h2>
      <div className="panel-head-right">
        {subtitle && <small>{subtitle}</small>}
        {headExtras}
        <button
          type="button"
          className="panel-expand-btn"
          aria-label={expanded ? "Collapse panel" : "Expand panel"}
          title={expanded ? "Collapse (Esc)" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? "×" : "⤢"}
        </button>
      </div>
    </div>
  );

  if (expanded) {
    return (
      <>
        <div
          className={`panel ${className ?? ""}`}
          style={style}
          data-panel={dataPanel}
        >
          <div className="panel-head">
            <h2>{title}</h2>
            <div className="panel-head-right">
              <small>(expanded — click × or press Esc to collapse)</small>
            </div>
          </div>
          <div className="panel-stub">expanded</div>
        </div>
        {createPortal(
          <div
            className="expanded-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === "string" ? title : "Expanded panel"}
            onClick={(e) => {
              // Click outside the inner card collapses, like an image lightbox.
              if (e.target === e.currentTarget) setExpanded(false);
            }}
          >
            <div className={`panel expanded-card ${className ?? ""}`} data-panel={dataPanel}>
              {head}
              <div className="expanded-body">{children}</div>
            </div>
          </div>,
          document.body,
        )}
      </>
    );
  }

  return (
    <div
      className={`panel expandable ${className ?? ""}`}
      style={style}
      data-panel={dataPanel}
    >
      {head}
      {children}
    </div>
  );
}
