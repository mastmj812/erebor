import { useEffect, useRef, useState } from "react";

import { useMapStore } from "../store";
import { GunbarrelView } from "./GunbarrelView";
import { ProductionView } from "./ProductionPanel";

// Measure an element (ResizeObserver) so the charts can fill the window as it
// resizes. Seeded with a sensible default before first layout.
function useElementSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 820, height: 380 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      setSize({ width: cr.width, height: cr.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function BottomPanel() {
  const sel = useMapStore((s) => s.selection);
  const overlay = useMapStore((s) => s.wellOverlay);
  const tab = useMapStore((s) => s.bottomTab);
  const setTab = useMapStore((s) => s.setBottomTab);

  // Position is React-controlled (drag); width/height are owned by CSS `resize`.
  const [pos, setPos] = useState(() => ({
    x: 270,
    y: Math.max(80, Math.round(window.innerHeight * 0.42)),
  }));
  const [dragging, setDragging] = useState(false);
  const offset = useRef({ dx: 0, dy: 0 });
  const [bodyRef, size] = useElementSize();

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

  const onHeadDown = (e: React.MouseEvent) => {
    offset.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    setDragging(true);
    e.preventDefault();
  };

  if (!sel && !overlay) return null;

  return (
    <div className="floatwin" style={{ left: pos.x, top: pos.y }}>
      <div className="win-head" onMouseDown={onHeadDown}>
        <span className="win-title">⠿ {tab === "production" ? "Production" : "Gunbarrel"}</span>
        <div className="seg sm tabs" onMouseDown={(e) => e.stopPropagation()}>
          <button className={tab === "production" ? "active" : ""} onClick={() => setTab("production")}>Production</button>
          <button className={tab === "gunbarrel" ? "active" : ""} onClick={() => setTab("gunbarrel")}>Gunbarrel</button>
        </div>
      </div>
      <div className="win-body" ref={bodyRef}>
        {tab === "production" ? (
          <ProductionView width={size.width} height={size.height} />
        ) : (
          <GunbarrelView width={size.width} height={size.height} />
        )}
      </div>
    </div>
  );
}
