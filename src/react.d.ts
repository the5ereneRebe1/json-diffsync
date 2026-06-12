import type { AutosaveClient } from "./index.js";

export function useDifferentialAutosave(options: {
  documentId: string;
  sessionId: string;
  initialValue?: unknown;
  transport: { sync(message: unknown): Promise<any> };
  intervalMs?: number;
  pullIntervalMs?: number;
  keyFields?: string[];
  storageKey?: string;
}): {
  value: any;
  setValue(nextValue: unknown): void;
  sync(meta?: Record<string, unknown>): Promise<any>;
  status: "idle" | "syncing" | "error";
  error: unknown;
  dirty: boolean;
  client: AutosaveClient;
};
