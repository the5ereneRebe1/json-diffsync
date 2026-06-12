export function createMemoryAutosaveServer(options?: {
  destructiveDeleteRatio?: number;
  keepRevisions?: boolean;
  maxRevisions?: number;
  keyFields?: string[];
}): any;
export function createFetchTransport(url: string, fetchImpl?: typeof fetch): {
  sync(message: unknown): Promise<any>;
};
export function createNodeSyncHandler(server: any, options?: {
  maxBodyBytes?: number;
}): (request: any, response: any) => Promise<void>;
