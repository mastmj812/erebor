import { MapView } from "./MapView";
import { BottomPanel } from "./panels/BottomPanel";
import { Controls } from "./panels/Controls";
import { Legend } from "./panels/Legend";
import { ResultsPanel } from "./panels/ResultsPanel";

export function App() {
  return (
    <div className="app">
      <MapView />
      <Controls />
      <Legend />
      <ResultsPanel />
      <BottomPanel />
    </div>
  );
}
