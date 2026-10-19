export interface TrialQuotaConfig {
  enabled: boolean;
  freeCallsPerCaller: number;
  globalDailyCap: number;
  sponsorDisclosure?: string;
}

export class TrialQuotaTracker {
  readonly config: TrialQuotaConfig;
  private callerCounts = new Map<string, number>();
  private globalUsedToday = 0;
  private currentDayKey = new Date().toISOString().slice(0, 10);

  constructor(config: TrialQuotaConfig) {
    this.config = config;
  }

  private rollDayIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDayKey) {
      this.currentDayKey = today;
      this.globalUsedToday = 0;
      this.callerCounts.clear();
    }
  }

  checkAndConsume(callerId: string): {
    allowed: boolean;
    remainingCallerQuota: number;
    remainingGlobalQuota: number;
    disclosure: string;
  } {
    this.rollDayIfNeeded();
    const disclosure =
      this.config.sponsorDisclosure ??
      "Provider-sponsored sandbox compute trial (0 tANE charged; strict per-caller & global daily cap)";
    if (!this.config.enabled) {
      return {
        allowed: false,
        remainingCallerQuota: 0,
        remainingGlobalQuota: 0,
        disclosure,
      };
    }
    const usedByCaller = this.callerCounts.get(callerId.toLowerCase()) ?? 0;
    if (
      usedByCaller >= this.config.freeCallsPerCaller ||
      this.globalUsedToday >= this.config.globalDailyCap
    ) {
      return {
        allowed: false,
        remainingCallerQuota: Math.max(0, this.config.freeCallsPerCaller - usedByCaller),
        remainingGlobalQuota: Math.max(0, this.config.globalDailyCap - this.globalUsedToday),
        disclosure,
      };
    }
    const nextCaller = usedByCaller + 1;
    this.callerCounts.set(callerId.toLowerCase(), nextCaller);
    this.globalUsedToday += 1;
    return {
      allowed: true,
      remainingCallerQuota: Math.max(0, this.config.freeCallsPerCaller - nextCaller),
      remainingGlobalQuota: Math.max(0, this.config.globalDailyCap - this.globalUsedToday),
      disclosure,
    };
  }
}
