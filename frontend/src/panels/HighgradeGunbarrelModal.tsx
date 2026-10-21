import { useCallback, useEffect, useRef, useState } from "react";

import { fetchHighgradeGunbarrel, fmtHgValue, hgMetricLabel, type HighgradeMetric } from "../api/highgrade";
import { useMapStore } from "../store";
import { BoxWorkup } from "./BoxWorkup";
import { PadChart } from "./GunbarrelView";

const NO_EXFORM = new Set<string>();

// Label + per-location formatter for the selected screen metric (well_count has no
// per-location value, so no metric row is shown for it).
function metricMeta(metric: string | undefined): { label: string; fmt: (v: number) => string } | undefined {
  if (!metric || metric === "well_count") return undefined;
  return { label: `BOX ${hgMetricLabel(metric)}`, fmt: (v) => fmtHgValue(v, metric) };
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

// Click a DSU on the Highgrade map -> this draggable window opens on the pad's BOX workup,
// with a tab for the unit's gunbarrel (offset vs TVD): every screened location + PDP in the
// pad. Locations that pass the active screen render in bench color; off-screen locations and
// all PDP render muted (grey, dashed). Nothing is hidden. Drag the header to move it.
export function HighgradeGunbarrelModal() {
  const pad = useMapStore((s) => s.hgGunbarrelPad);
  const data = useMapStore((s) => s.hgGunbarrel);
  const loading = useMapStore((s) => s.hgGunbarrelLoading);
  const close = useMapStore((s) => s.closeHgGunbarrel);
  const metric = useMapStore((s) => s.highgrade?.metric);
  const basin = useMapStore((s) => s.basin);
  const mm = metricMeta(metric);
  const [tab, setTab] = useState<"gunbarrel" | "workup">("workup");

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
    const { basin, highgradeFilters, highgrade, mapDeck } = useMapStore.getState();
    const m = (highgrade?.metric ?? "oil_eur_per_kft") as HighgradeMetric;
    setTab("workup");
    // the drawn result's own econ deck, so the window matches the map
    fetchHighgradeGunbarrel({
      basin, pad_key: pad, filters: highgradeFilters ?? {}, metric: m, deck: highgrade?.econ?.deck_id ?? mapDeck,
    })
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
      {(
        <div className="seg sm" style={{ padding: "6px 12px 0" }}>
          <button className={tab === "workup" ? "active" : ""} onClick={() => setTab("workup")}>BOX workup</button>
          <button className={tab === "gunbarrel" ? "active" : ""} onClick={() => setTab("gunbarrel")}>Gunbarrel</button>
        </div>
      )}
      {tab === "workup" && (
        <div className="win-body"><BoxWorkup basin={basin} padKey={pad} /></div>
      )}
      <div className="win-body" ref={bodyRef} style={tab === "workup" ? { display: "none" } : undefined}>
        {loading && <div className="count">Loading gunbarrel…</div>}
        {!loading && data && data.wells.length === 0 && (
          <div className="count">No screened location or PDP found in this unit.</div>
        )}
        {!loading && data && data.wells.length > 0 && (
          <PadChart pad={data} exForm={NO_EXFORM} isMuted={(w) => !w.in_filter}
            width={size.width} height={size.height}
            metricLabel={mm?.label} formatMetric={mm?.fmt} />
        )}
      </div>
      <div className="hg-gb-foot">
        ○ location &nbsp; ● PDP &nbsp; color = bench &nbsp;·&nbsp; grey/dashed = PDP or off the current screen
        &nbsp;·&nbsp; BOX value blank = no BOX forecast (never zero)
        {data && data.wells.length > 0 && (
          <> &nbsp;·&nbsp; {colored} of {data.well_count} match the screen</>
        )}
      </div>
    </div>
  );
}
