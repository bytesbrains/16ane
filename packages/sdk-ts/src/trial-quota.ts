import { type KeyValueStore, MemoryKeyValueStore } from "./store.ts";

export interface TrialQuotaConfig {
  enabled: boolean;
  freeCallsPerCaller: number;
  globalDailyCap: number;
  sponsorDisclosure?: string;
}

// Counts are keyed by UTC day, so a new day starts from zero without any reset step, and a persistent store
// (#75) keeps them across restarts.
export class TrialQuotaTracker {
  readonly config: TrialQuotaConfig;
  readonly store: KeyValueStore;

  constructor(config: TrialQuotaConfig, store: KeyValueStore = new MemoryKeyValueStore()) {
    this.config = config;
    this.store = store;
  }

  checkAndConsume(callerId: string): {
    allowed: boolean;
    remainingCallerQuota: number;
    remainingGlobalQuota: number;
    disclosure: string;
  } {
    const day = new Date().toISOString().slice(0, 10);
    const callerKey = `${day}:caller:${callerId.toLowerCase()}`;
    const globalKey = `${day}:global`;
    const globalUsedToday = this.store.get<number>("trial.quota", globalKey) ?? 0;
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
    const usedByCaller = this.store.get<number>("trial.quota", callerKey) ?? 0;
    if (usedByCaller >= this.config.freeCallsPerCaller || globalUsedToday >= this.config.globalDailyCap) {
      return {
        allowed: false,
        remainingCallerQuota: Math.max(0, this.config.freeCallsPerCaller - usedByCaller),
        remainingGlobalQuota: Math.max(0, this.config.globalDailyCap - globalUsedToday),
        disclosure,
      };
    }
    const nextCaller = usedByCaller + 1;
    this.store.set("trial.quota", callerKey, nextCaller);
    this.store.set("trial.quota", globalKey, globalUsedToday + 1);
    return {
      allowed: true,
      remainingCallerQuota: Math.max(0, this.config.freeCallsPerCaller - nextCaller),
      remainingGlobalQuota: Math.max(0, this.config.globalDailyCap - globalUsedToday - 1),
      disclosure,
    };
  }
}
