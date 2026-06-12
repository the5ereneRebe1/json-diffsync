export type JsonPathSegment = string | number | { $key: string };

export interface JsonPatch {
  kind: "json-keyed";
  baseHash: string;
  lossy: boolean;
  ops: Array<Record<string, unknown>>;
}

export interface SyncTransport {
  sync(message: unknown): Promise<any>;
}

export interface CreateJsonPatchOptions {
  keyFields?: string[];
  includeOldValues?: boolean;
  baseHash?: string;
}

export interface AutosaveClientState {
  documentId: string;
  sessionId: string;
  value: any;
  shadow: any;
  clientVersion: number;
  serverVersion: number;
  dirty: boolean;
  syncing: boolean;
  lastError: unknown;
}

export interface AutosaveClient {
  readonly state: AutosaveClientState;
  getValue(): any;
  setValue(nextValue: unknown): void;
  hasLocalChanges(): boolean;
  sync(meta?: Record<string, unknown>): Promise<{ ok?: boolean; changed?: boolean; skipped?: boolean }>;
}

export function cloneJson<T>(value: T): T;
export function stableStringify(value: unknown): string;
export function hashJson(value: unknown): string;
export function jsonEqual(left: unknown, right: unknown): boolean;
export function createJsonPatch(before: unknown, after: unknown, options?: CreateJsonPatchOptions): JsonPatch;
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
}): AutosaveClient;
