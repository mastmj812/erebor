// Multi-select chip group: empty selection = "all" (no constraint), click a chip
// to include it. Shared by the Highgrade filter panel and the Map-tab formation
// picker. Optional `swatch` paints a color dot (e.g. formation_blueox color);
// optional `labelOf` shows a display label for a chip value.
export function ChipGroup({
  label, options, selected, onToggle, swatch, hint, labelOf,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  swatch?: (name: string) => string;
  hint?: string;
  labelOf?: (value: string) => string;
}) {
  if (!options || options.length === 0) return null;
  return (
    <div className="hg-chipgroup">
      <h3>{label} {selected.length === 0 ? <span className="hg-n">(all)</span> : <span className="hg-n">({selected.length})</span>}</h3>
      {hint && <div className="count" style={{ margin: "0 0 4px" }}>{hint}</div>}
      <div className="hg-chips">
        {options.map((o) => (
          <button
            key={o}
            className={`hg-chip${selected.includes(o) ? " on" : ""}`}
            onClick={() => onToggle(o)}
          >
            {swatch && <span className="swatch" style={{ background: swatch(o), width: 9, height: 9, marginRight: 4 }} />}
            {labelOf ? labelOf(o) : o}
          </button>
        ))}
      </div>
    </div>
  );
}
