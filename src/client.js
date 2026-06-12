import { DEFAULT_KEY_FIELDS, cloneJson, hashJson, jsonEqual } from "./core/json.js";
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

  let saved = null;
  try {
    saved = persister?.load() ?? null;
  } catch {
    saved = null;
  }

  const state = {
    documentId,
    sessionId,
    value: saved?.value ?? cloneJson(initialValue),
    shadow: saved?.shadow ?? cloneJson(initialValue),
    clientVersion: saved?.clientVersion ?? clientVersion,
    serverVersion: saved?.serverVersion ?? serverVersion,
    dirty: false,
    syncing: false,
    lastError: null
  };
  state.dirty = !jsonEqual(state.value, state.shadow);

  let shadowHash = null;
  let edits = 0;

  function currentShadowHash() {
    shadowHash ??= hashJson(state.shadow);
    return shadowHash;
  }

  function setShadow(nextShadow) {
    state.shadow = nextShadow;
    shadowHash = null;
  }

  function persist() {
    persister?.save({
      value: state.value,
      shadow: state.shadow,
      clientVersion: state.clientVersion,
      serverVersion: state.serverVersion
    });
  }

  if (!saved) persist();

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
      state.dirty = true;
      edits += 1;
      persist();
    },
    hasLocalChanges() {
      return state.dirty;
    },
    async sync(meta = {}) {
      if (state.syncing) return { skipped: true };
      state.syncing = true;
      state.lastError = null;

      const editsAtStart = edits;
      const previousClientVersion = state.clientVersion;
      const previousServerVersion = state.serverVersion;
      const baseHash = currentShadowHash();
      const patch = createJsonPatch(state.shadow, state.value, { keyFields, baseHash });
      try {
        const response = await transport.sync({
          documentId,
          sessionId,
          clientVersion: state.clientVersion,
          serverVersion: state.serverVersion,
          shadowHash: baseHash,
          patch,
          meta
        });

        if (!response.ok) {
          if (response.reason === "shadow_mismatch" && response.value !== undefined) {
            const hasLocalChanges = !jsonEqual(state.value, state.shadow);
            if (!hasLocalChanges) state.value = cloneJson(response.value);
            setShadow(cloneJson(response.value));
            state.dirty = hasLocalChanges && !jsonEqual(state.value, state.shadow);
            state.clientVersion = response.clientVersion ?? state.clientVersion;
            state.serverVersion = response.serverVersion ?? state.serverVersion;
            persist();
          } else if (response.reason === "client_version_mismatch") {
            state.clientVersion = response.clientVersion ?? state.clientVersion;
            state.serverVersion = response.serverVersion ?? state.serverVersion;
            persist();
          }
          throw new Error(response.reason ?? "Sync failed.");
        }

        if (patch.ops.length > 0) {
          setShadow(applyJsonPatch(state.shadow, patch, { strict: true, keyFields }));
        }
        state.clientVersion = response.clientVersion;

        const receivedOps = response.patch?.ops?.length > 0;
        if (receivedOps) {
          state.value = applyJsonPatch(state.value, response.patch, { keyFields });
          setShadow(applyJsonPatch(state.shadow, response.patch, { strict: true, keyFields }));
        }

        state.serverVersion = response.serverVersion;
        if (edits === editsAtStart) state.dirty = false;

        if (
          patch.ops.length > 0 ||
          receivedOps ||
          state.clientVersion !== previousClientVersion ||
          state.serverVersion !== previousServerVersion
        ) {
          persist();
        }
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
