import { useCallback, useEffect, useRef, useState } from "react";

import { fetchHighgradeGunbarrel, type HighgradeMetric } from "../api/highgrade";
import { useMapStore } from "../store";
import { PadChart } from "./GunbarrelView";

const NO_EXFORM = new Set<string>();

// Label + per-well formatter for the selected screen metric (well_count has no
// per-well value, so no metric row is shown for it).
function metricMeta(metric: string | undefined): { label: string; fmt: (v: number) => string } | undefined {
  if (!metric || metric === "well_count") return undefined;
  if (metric.startsWith("npv") || metric.startsWith("pv")) {
    const rate = metric.replace(/^(npv|pv)/, "");
    const label = `${metric.startsWith("npv") ? "NPV" : "PV"} @ ${rate}%`;
    return { label, fmt: (v) => `$${Math.round(v).toLocaleString()}` };
  }
  if (metric === "oil_eur") return { label: "Oil EUR", fmt: (v) => `${Math.round(v).toLocaleString()} bbl` };
  if (metric === "gas_eur") return { label: "Gas EUR", fmt: (v) => `${Math.round(v).toLocaleString()} mcf` };
  return undefined;
}

// Measure the body (ResizeObserver) so the chart fills the window as it's resized.
function useElementSize() {
  const [size, setSize] = useState({ width: 660, height: 360 });
  const roRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      setSize({ width: cr.width, height: cr.height });
    });
    ro.observe(node);
    roRef.current = ro;
  }, []);
  return [ref, size] as const;
}

// Click a DSU on the Highgrade map -> this draggable window shows that single
// unit's gunbarrel (offset vs TVD): every PUD + PDP in the pad. PUDs that pass
// the active screen render in formation color; off-filter PUDs and all PDPs
// render muted (grey, dashed). Nothing is hidden. Drag the header to move it.
export function HighgradeGunbarrelModal() {
  const pad = useMapStore((s) => s.hgGunbarrelPad);
  const data = useMapStore((s) => s.hgGunbarrel);
  const loading = useMapStore((s) => s.hgGunbarrelLoading);
  const close = useMapStore((s) => s.closeHgGunbarrel);
  const metric = useMapStore((s) => s.highgrade?.metric);
  const mm = metricMeta(metric);

  const [pos, setPos] = useState(() => ({
    x: Math.max(20, Math.round(window.innerWidth * 0.5 - 360)),
    y: Math.max(60, Math.round(window.innerHeight * 0.5 - 230)),
  }));
  const [dragging, setDragging] = useState(false);
  const offset = useRef({ dx: 0, dy: 0 });
  const [bodyRef, size] = useElementSize();

  // Fetch whenever a new pad is opened, using the last-applied screen.
  useEffect(() => {
    if (!pad) return;
    let live = true;
    const { basin, highgradeFilters, highgrade, hgIncludeRealized } = useMapStore.getState();
    const m = (highgrade?.metric ?? "npv25") as HighgradeMetric;
    fetchHighgradeGunbarrel({ basin, pad_name: pad, filters: highgradeFilters ?? {}, metric: m, include_realized: hgIncludeRealized })
      .then((d) => { if (live) useMapStore.getState().setHgGunbarrel(d); })
      .catch((e) => {
        console.error("highgrade gunbarrel failed", e);
        if (live) useMapStore.getState().setHgGunbarrel({ pad_name: pad, well_count: 0, wells: [] });
      });
    return () => { live = false; };
  }, [pad]);

  // Drag-to-move (header is the handle).
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) =>
      setPos({ x: e.clientX - offset.current.dx, y: e.clientY - offset.current.dy });
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // Close on Escape.
  useEffect(() => {
    if (!pad) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pad, close]);

  if (!pad) return null;

  const onHeadDown = (e: React.MouseEvent) => {
    offset.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    setDragging(true);
    e.preventDefault();
  };

  const colored = data?.wells.filter((w) => w.in_filter).length ?? 0;

  return (
    <div className="floatwin hg-gb-win" style={{ left: pos.x, top: pos.y }}>
      <div className="win-head" onMouseDown={onHeadDown}>
        <span className="win-title">
          ⠿ {pad}{data ? ` · ${data.well_count} well${data.well_count === 1 ? "" : "s"}` : ""}
        </span>
        <button className="hg-gb-close" aria-label="Close"
          onMouseDown={(e) => e.stopPropagation()} onClick={close}>×</button>
      </div>
      <div className="win-body" ref={bodyRef}>
        {loading && <div className="count">Loading gunbarrel…</div>}
        {!loading && data && data.wells.length === 0 && (
          <div className="count">No PUD or PDP wells found in this unit.</div>
        )}
        {!loading && data && data.wells.length > 0 && (
          <PadChart pad={data} exForm={NO_EXFORM} isMuted={(w) => !w.in_filter}
            width={size.width} height={size.height}
            metricLabel={mm?.label} formatMetric={mm?.fmt} />
        )}
      </div>
      <div className="hg-gb-foot">
        ○ PUD &nbsp; ● PDP &nbsp; color = formation &nbsp;·&nbsp; grey/dashed = PDP or off current screen
        {data && data.wells.length > 0 && (
          <> &nbsp;·&nbsp; {colored} of {data.well_count} match the screen</>
        )}
      </div>
    </div>
  );
}
