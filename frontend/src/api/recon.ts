// §6 reconciliation-status stick counts for the current basin, used to annotate
// the map Legend (status color mode). Keys match RECON_STATUS entry keys, with
// NULL status keyed "(null)".
export async function fetchReconCounts(basin: string): Promise<Record<string, number>> {
  const r = await fetch(`/api/recon_counts?basin=${basin}`);
  if (!r.ok) throw new Error(`recon_counts failed: ${r.status}`);
  return r.json();
}
