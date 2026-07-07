export type CloudSyncStatus = {
  apiKeyConfigured: boolean;
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastRunsIngested: number;
};
