// §6 reconciliation-status stick counts for the current basin, used to annotate
// the map Legend (status color mode). Keys match RECON_STATUS entry keys, with
// NULL status keyed "(null)".
export async function fetchReconCounts(basin: string): Promise<Record<string, number>> {
  const r = await fetch(`/api/recon_counts?basin=${basin}`);
  if (!r.ok) throw new Error(`recon_counts failed: ${r.status}`);
  return r.json();
}

// Novi depletion-tier stick counts for the current basin (depletion color mode
// legend). Keys match DEPLETION_TIERS entry keys, NULL tier keyed "(null)".
export async function fetchDepletionCounts(basin: string): Promise<Record<string, number>> {
  const r = await fetch(`/api/depletion_counts?basin=${basin}`);
  if (!r.ok) throw new Error(`depletion_counts failed: ${r.status}`);
  return r.json();
}

// Offset-PDP support bucket counts over the SCORED population (PUD/RES) for the
// current basin (support color-mode legend). Keys match SUPPORT_TIERS entry keys
// (0 / 1 / 3 / 8), NULL (unscorable) keyed "(null)". PDP is excluded.
export async function fetchSupportCounts(basin: string): Promise<Record<string, number>> {
  const r = await fetch(`/api/support_counts?basin=${basin}`);
  if (!r.ok) throw new Error(`support_counts failed: ${r.status}`);
  return r.json();
}
