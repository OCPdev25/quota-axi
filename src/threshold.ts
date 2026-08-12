import type {
  ProviderId,
  ProviderQuota,
  QuotaThresholdBreach,
  QuotaThresholdResult,
} from "./types.js";

/**
 * Compare normalized quota windows against a caller-selected floor.
 * A pass means every requested provider exposed at least one percentage and
 * no measured window fell below the floor. Missing percentages stay honest:
 * they produce an unknown result instead of silently passing the gate.
 */
export function evaluateQuotaThreshold(
  providers: ProviderQuota[],
  minimumRemainingPercent: number,
): QuotaThresholdResult {
  const breaches: QuotaThresholdBreach[] = [];
  const unknownProviders: ProviderId[] = [];
  let measuredWindows = 0;

  for (const provider of providers) {
    let providerMeasurements = 0;
    for (const window of provider.windows) {
      if (window.percentRemaining === undefined) continue;
      measuredWindows += 1;
      providerMeasurements += 1;
      if (window.percentRemaining >= minimumRemainingPercent) continue;
      breaches.push({
        provider: provider.provider,
        id: window.id,
        label: window.label,
        percentRemaining: window.percentRemaining,
      });
    }
    if (providerMeasurements === 0) unknownProviders.push(provider.provider);
  }

  return {
    minimumRemainingPercent,
    status:
      breaches.length > 0
        ? "fail"
        : unknownProviders.length > 0
          ? "unknown"
          : "pass",
    measuredWindows,
    unknownProviders,
    breaches,
  };
}
