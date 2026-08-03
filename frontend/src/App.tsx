import { MapView } from "./MapView";
import { AccuracyLegend } from "./panels/AccuracyLegend";
import { AccuracyPanel } from "./panels/AccuracyPanel";
import { AccuracyWellModal } from "./panels/AccuracyWellModal";
import { BottomPanel } from "./panels/BottomPanel";
import { Controls } from "./panels/Controls";
import { HighgradeGunbarrelModal } from "./panels/HighgradeGunbarrelModal";
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
      {appMode === "map" && (
        <>
          <Controls />
          <Legend />
          <ResultsPanel />
          <BottomPanel />
        </>
      )}
      {appMode === "highgrade" && (
        <>
          <HighgradePanel />
          <HighgradeLegend />
          <HighgradeGunbarrelModal />
        </>
      )}
      {appMode === "accuracy" && (
        <>
          <AccuracyPanel />
          <AccuracyLegend />
          <AccuracyWellModal />
        </>
      )}
    </div>
  );
}
