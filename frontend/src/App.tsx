import { MapView } from "./MapView";
import { AccuracyLegend } from "./panels/AccuracyLegend";
import { AccuracyPanel } from "./panels/AccuracyPanel";
import { AccuracySelectionModal } from "./panels/AccuracySelectionModal";
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
          <div className="left-col">
            <Controls />
            <Legend />
          </div>
          <ResultsPanel />
          <BottomPanel />
        </>
      )}
      {appMode === "highgrade" && (
        <>
          <div className="left-col">
            <HighgradePanel />
            <HighgradeLegend />
          </div>
          <HighgradeGunbarrelModal />
        </>
      )}
      {appMode === "accuracy" && (
        <>
          <div className="left-col">
            <AccuracyPanel />
            <AccuracyLegend />
          </div>
          <AccuracySelectionModal />
          <AccuracyWellModal />
        </>
      )}
    </div>
  );
}
