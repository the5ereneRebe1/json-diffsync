import { DEFAULT_KEY_FIELDS, cloneJson, hashJson } from "./core/json.js";
import { applyJsonPatch, createJsonPatch } from "./core/patch.js";

export function createAutosaveClient(options) {
  const {
    documentId,
    sessionId,
    initialValue = null,
    clientVersion = 0,
    serverVersion = 0,
    transport,
    persister,
    keyFields = DEFAULT_KEY_FIELDS
  } = options;

  const saved = persister?.load();
  const state = {
    documentId,
    sessionId,
    value: saved?.value ?? cloneJson(initialValue),
    shadow: saved?.shadow ?? cloneJson(initialValue),
    clientVersion: saved?.clientVersion ?? clientVersion,
    serverVersion: saved?.serverVersion ?? serverVersion,
    syncing: false,
    lastError: null
  };

  function persist() {
    persister?.save({
      value: state.value,
      shadow: state.shadow,
      clientVersion: state.clientVersion,
      serverVersion: state.serverVersion
    });
  }

  persist();

  return {
    get state() {
      return {
        ...state,
        value: cloneJson(state.value),
        shadow: cloneJson(state.shadow)
      };
    },
    getValue() {
      return cloneJson(state.value);
    },
    setValue(nextValue) {
      state.value = cloneJson(nextValue);
      persist();
    },
    async sync(meta = {}) {
      if (state.syncing) return { skipped: true };
      state.syncing = true;
      state.lastError = null;

      const patch = createJsonPatch(state.shadow, state.value, { keyFields });
      try {
        const response = await transport.sync({
          documentId,
          sessionId,
          clientVersion: state.clientVersion,
          serverVersion: state.serverVersion,
          shadowHash: hashJson(state.shadow),
          patch,
          meta
        });

        if (!response.ok) {
          if (response.reason === "shadow_mismatch" && response.value !== undefined) {
            const hasLocalChanges = hashJson(state.value) !== hashJson(state.shadow);
            if (!hasLocalChanges) state.value = cloneJson(response.value);
            state.shadow = cloneJson(response.value);
            state.clientVersion = response.clientVersion ?? state.clientVersion;
            state.serverVersion = response.serverVersion ?? state.serverVersion;
            persist();
          }
          throw new Error(response.reason ?? "Sync failed.");
        }

        state.shadow = applyJsonPatch(state.shadow, patch, { strict: true, keyFields });
        state.clientVersion = response.clientVersion;

        if (response.patch) {
          state.value = applyJsonPatch(state.value, response.patch, { keyFields });
          state.shadow = applyJsonPatch(state.shadow, response.patch, { strict: true, keyFields });
        }

        state.serverVersion = response.serverVersion;
        persist();
        return { ok: true, changed: patch.ops.length > 0 };
      } catch (error) {
        state.lastError = error;
        throw error;
      } finally {
        state.syncing = false;
      }
    }
  };
}
