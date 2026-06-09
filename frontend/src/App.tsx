import { MapView } from "./MapView";
import { BottomPanel } from "./panels/BottomPanel";
import { Controls } from "./panels/Controls";
import { HighgradeLegend } from "./panels/HighgradeLegend";
import { HighgradePanel } from "./panels/HighgradePanel";
import { Legend } from "./panels/Legend";
import { ResultsPanel } from "./panels/ResultsPanel";
import { TabSwitcher } from "./panels/TabSwitcher";
import { useMapStore } from "./store";

export function App() {
  const appMode = useMapStore((s) => s.appMode);
  return (
    <div className="app">
      <MapView />
      <TabSwitcher />
      {appMode === "map" ? (
        <>
          <Controls />
          <Legend />
          <ResultsPanel />
          <BottomPanel />
        </>
      ) : (
        <>
          <HighgradePanel />
          <HighgradeLegend />
        </>
      )}
    </div>
  );
}
