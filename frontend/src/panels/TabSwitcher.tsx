import { useMapStore } from "../store";

export function TabSwitcher() {
  const appMode = useMapStore((s) => s.appMode);
  const setAppMode = useMapStore((s) => s.setAppMode);
  return (
    <div className="tabswitch seg">
      <button className={appMode === "map" ? "active" : ""} onClick={() => setAppMode("map")}>Map</button>
      <button className={appMode === "highgrade" ? "active" : ""} onClick={() => setAppMode("highgrade")}>Highgrade</button>
    </div>
  );
}
