// Outperformance = engagement above THAT creator's own trailing baseline,
// not absolute numbers. Robust statistics (median + MAD) so one viral post
// doesn't poison the baseline; small-n guard refuses to score until there is
// enough history.

export interface Baseline {
  n: number;
  median: number;
  mad: number;
}

export const MIN_BASELINE_N = 8;
const MAD_CONSISTENCY = 0.6745; // normal-consistency constant

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function computeBaseline(engagements: number[]): Baseline {
  const med = median(engagements);
  const deviations = engagements.map((x) => Math.abs(x - med));
  return { n: engagements.length, median: med, mad: median(deviations) };
}

/**
 * Robust z-score of one observation vs a baseline. Returns null when the
 * baseline is too small to trust. A zero MAD (flat history) falls back to a
 * fraction of the median so a genuine spike still registers.
 */
export function robustZ(x: number, baseline: Baseline): number | null {
  if (baseline.n < MIN_BASELINE_N) return null;
  const scale = baseline.mad > 0 ? baseline.mad : Math.max(baseline.median * 0.25, 1);
  return (MAD_CONSISTENCY * (x - baseline.median)) / scale;
}

export const OUTPERFORM_Z = 2.0;

export function engagementOf(metrics: { likes?: number; reposts?: number; replies?: number; quotes?: number }): number {
  return (metrics.likes ?? 0) + 2 * (metrics.reposts ?? 0) + 1.5 * (metrics.replies ?? 0) + 2 * (metrics.quotes ?? 0);
}
