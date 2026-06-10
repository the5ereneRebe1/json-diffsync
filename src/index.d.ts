export type JsonPathSegment = string | number | { $key: string };

export interface JsonPatch {
  kind: "json-keyed";
  baseHash: string;
  beforeBytes: number;
  afterBytes: number;
  lossy: boolean;
  ops: Array<Record<string, unknown>>;
}

export interface SyncTransport {
  sync(message: unknown): Promise<any>;
}

export function cloneJson<T>(value: T): T;
export function stableStringify(value: unknown): string;
export function hashJson(value: unknown): string;
export function createJsonPatch(before: unknown, after: unknown, options?: { keyFields?: string[] }): JsonPatch;
export function applyJsonPatch<T>(value: T, patch: JsonPatch, options?: { strict?: boolean; keyFields?: string[] }): T;
export function createLocalStoragePersister(key: string, storage?: Storage): {
  load(): any;
  save(state: unknown): void;
  clear(): void;
};
export function createAutosaveClient(options: {
  documentId: string;
  sessionId: string;
  initialValue?: unknown;
  clientVersion?: number;
  serverVersion?: number;
  keyFields?: string[];
  transport: SyncTransport;
  persister?: { load(): any; save(state: unknown): void };
}): any;
