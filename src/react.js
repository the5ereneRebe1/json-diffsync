import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAutosaveClient, createLocalStoragePersister } from "./index.js";

export function useDifferentialAutosave(options) {
  const {
    documentId,
    sessionId,
    initialValue = null,
    transport,
    intervalMs = 2000,
    pullIntervalMs = 10000,
    keyFields,
    storageKey = `json-diffsync:${documentId}:${sessionId}`
  } = options;

  const [version, forceRender] = useState(0);
  const clientRef = useRef(null);

  if (!clientRef.current) {
    clientRef.current = createAutosaveClient({
      documentId,
      sessionId,
      initialValue,
      transport,
      keyFields,
      persister: createLocalStoragePersister(storageKey)
    });
  }

  const client = clientRef.current;

  const sync = useCallback(
    async (meta) => {
      const result = await client.sync(meta);
      forceRender((value) => value + 1);
      return result;
    },
    [client]
  );

  const lastPullRef = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      const pullDue = Date.now() - lastPullRef.current >= pullIntervalMs;
      if (!pullDue && !client.hasLocalChanges()) return;
      lastPullRef.current = Date.now();
      sync().catch(() => forceRender((value) => value + 1));
    }, intervalMs);

    const flushIfDirty = () => {
      if (client.hasLocalChanges()) sync().catch(() => {});
    };
    const onVisibilityChange = () => {
      const visibility = globalThis.document?.visibilityState;
      if (visibility === "hidden") flushIfDirty();
      if (visibility === "visible") {
        lastPullRef.current = Date.now();
        sync().catch(() => {});
      }
    };

    globalThis.addEventListener?.("visibilitychange", onVisibilityChange);
    globalThis.addEventListener?.("beforeunload", flushIfDirty);

    return () => {
      clearInterval(timer);
      globalThis.removeEventListener?.("visibilitychange", onVisibilityChange);
      globalThis.removeEventListener?.("beforeunload", flushIfDirty);
    };
  }, [client, intervalMs, pullIntervalMs, sync]);

  const snapshot = useMemo(() => client.state, [client, version]);

  return useMemo(() => ({
    value: snapshot.value,
    setValue(nextValue) {
      client.setValue(nextValue);
      forceRender((value) => value + 1);
    },
    sync,
    status: snapshot.syncing ? "syncing" : snapshot.lastError ? "error" : "idle",
    error: snapshot.lastError,
    dirty: snapshot.dirty,
    client
  }), [client, sync, snapshot]);
}
