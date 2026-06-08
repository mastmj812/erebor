import { MapView } from "./MapView";
import { Controls } from "./panels/Controls";
import { Legend } from "./panels/Legend";
import { ProductionPanel } from "./panels/ProductionPanel";
import { ResultsPanel } from "./panels/ResultsPanel";

export function App() {
  return (
    <div className="app">
      <MapView />
      <Controls />
      <Legend />
      <ResultsPanel />
      <ProductionPanel />
    </div>
  );
}
