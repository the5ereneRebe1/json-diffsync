import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAutosaveClient, createLocalStoragePersister } from "./index.js";

export function useDifferentialAutosave(options) {
  const {
    documentId,
    sessionId,
    initialValue = null,
    transport,
    intervalMs = 2000,
    keyFields,
    storageKey = `driftsync:${documentId}:${sessionId}`
  } = options;

  const [, forceRender] = useState(0);
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

  useEffect(() => {
    const timer = setInterval(() => {
      sync().catch(() => forceRender((value) => value + 1));
    }, intervalMs);

    const flush = () => {
      sync().catch(() => {});
    };

    globalThis.addEventListener?.("visibilitychange", flush);
    globalThis.addEventListener?.("beforeunload", flush);

    return () => {
      clearInterval(timer);
      globalThis.removeEventListener?.("visibilitychange", flush);
      globalThis.removeEventListener?.("beforeunload", flush);
    };
  }, [intervalMs, sync]);

  const snapshot = client.state;

  return useMemo(() => ({
    value: snapshot.value,
    setValue(nextValue) {
      client.setValue(nextValue);
      forceRender((value) => value + 1);
    },
    sync,
    status: snapshot.syncing ? "syncing" : snapshot.lastError ? "error" : "idle",
    error: snapshot.lastError,
    client
  }), [client, sync, snapshot]);
}
