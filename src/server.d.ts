export function createMemoryAutosaveServer(options?: {
  destructiveDeleteRatio?: number;
  keepRevisions?: boolean;
  keyFields?: string[];
}): any;
export function createFetchTransport(url: string, fetchImpl?: typeof fetch): {
  sync(message: unknown): Promise<any>;
};
export function createNodeSyncHandler(server: any): (request: any, response: any) => Promise<void>;
