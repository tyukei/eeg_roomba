import { useEffect, useMemo, useRef, useState } from "react";
import UplotReact from "uplot-react";
import uPlot from "uplot";

interface Props {
  baseOpts: Omit<uPlot.Options, "width">;
  data: uPlot.AlignedData;
  height?: number;
}

/**
 * uPlot needs a concrete pixel width — it draws to canvas, can't be CSS-sized.
 * Wrap it in a ResizeObserver so the chart tracks its parent column and
 * doesn't overflow into neighbouring panels.
 */
export function AutoChart({ baseOpts, data, height }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const opts = useMemo<uPlot.Options>(
    () => ({ ...baseOpts, width, height: height ?? baseOpts.height }),
    [baseOpts, width, height],
  );

  return (
    <div ref={ref} style={{ width: "100%" }}>
      {width > 0 && <UplotReact options={opts} data={data} />}
    </div>
  );
}
