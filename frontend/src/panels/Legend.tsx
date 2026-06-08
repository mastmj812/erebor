import { type FormationGroup, groupedFormations } from "../map/formations";

const GROUP_ORDER: FormationGroup[] = ["Wolfcamp", "Bone Spring", "Spraberry", "Other"];

export function Legend() {
  const groups = groupedFormations();
  return (
    <div className="panel legend">
      <h3>Formation</h3>
      {GROUP_ORDER.map((g) => (
        <div className="legend-group" key={g}>
          <div>{g}</div>
          {groups[g].map((f) => (
            <div className="item" key={f.name}>
              <span className="swatch" style={{ background: f.color }} />
              {f.name}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
