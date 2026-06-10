import { applyJsonPatch, createJsonPatch } from "../core/patch.js";
import { cloneJson, hashJson, stableStringify } from "../core/json.js";

export function createMemoryAutosaveServer(options = {}) {
  const documents = new Map();
  const destructiveDeleteRatio = options.destructiveDeleteRatio ?? 0.8;
  const keepRevisions = options.keepRevisions ?? true;
  const keyFields = options.keyFields ?? ["key", "id"];

  function getDocument(documentId) {
    const document = documents.get(documentId);
    if (!document) throw new Error(`Unknown document: ${documentId}`);
    return document;
  }

  return {
    createDocument({ documentId = cryptoRandomId(), value = null } = {}) {
      const document = {
        documentId,
        value: cloneJson(value),
        version: 0,
        sessions: new Map(),
        revisions: []
      };
      documents.set(documentId, document);
      return { documentId, value: cloneJson(value), version: 0 };
    },
    openDocument({ documentId, sessionId }) {
      const document = getDocument(documentId);
      document.sessions.set(sessionId, {
        value: cloneJson(document.value),
        clientVersion: 0,
        serverVersion: document.version
      });
      return {
        ok: true,
        documentId,
        sessionId,
        value: cloneJson(document.value),
        clientVersion: 0,
        serverVersion: document.version
      };
    },
    inspectDocument(documentId) {
      const document = getDocument(documentId);
      return {
        documentId,
        value: cloneJson(document.value),
        version: document.version,
        sessions: [...document.sessions.entries()].map(([sessionId, shadow]) => ({
          sessionId,
          value: cloneJson(shadow.value),
          clientVersion: shadow.clientVersion,
          serverVersion: shadow.serverVersion
        })),
        revisions: cloneJson(document.revisions)
      };
    },
    sync(message) {
      const document = getDocument(message.documentId);
      const shadow = document.sessions.get(message.sessionId);
      if (!shadow) {
        return { ok: false, reason: "unknown_session" };
      }

      if (message.clientVersion !== shadow.clientVersion) {
        return {
          ok: false,
          reason: "client_version_mismatch",
          clientVersion: shadow.clientVersion,
          serverVersion: shadow.serverVersion
        };
      }

      if (message.shadowHash !== hashJson(shadow.value) || message.patch.baseHash !== hashJson(shadow.value)) {
        return {
          ok: false,
          reason: "shadow_mismatch",
          value: cloneJson(document.value),
          clientVersion: shadow.clientVersion,
          serverVersion: document.version
        };
      }

      if (isDestructivePatch(message.patch, destructiveDeleteRatio) && !message.meta?.confirmDestructive) {
        return {
          ok: false,
          reason: "destructive_patch_requires_confirmation",
          clientVersion: shadow.clientVersion,
          serverVersion: shadow.serverVersion
        };
      }

      let nextShadow;
      let nextValue;
      try {
        nextShadow = applyJsonPatch(shadow.value, message.patch, { strict: true, keyFields });
        nextValue = applyJsonPatch(document.value, message.patch, { keyFields });
      } catch (error) {
        return {
          ok: false,
          reason: "patch_apply_failed",
          detail: error.message,
          clientVersion: shadow.clientVersion,
          serverVersion: shadow.serverVersion
        };
      }

      const changedServer = stableStringify(nextValue) !== stableStringify(document.value);
      if (keepRevisions && changedServer) {
        document.revisions.push({
          version: document.version,
          sessionId: message.sessionId,
          before: cloneJson(document.value),
          after: cloneJson(nextValue),
          patch: cloneJson(message.patch),
          at: new Date().toISOString()
        });
      }

      document.value = nextValue;
      if (changedServer) document.version += 1;
      shadow.value = nextShadow;
      shadow.clientVersion += 1;

      const serverPatch = createJsonPatch(shadow.value, document.value, { keyFields });
      shadow.value = applyJsonPatch(shadow.value, serverPatch, { strict: true, keyFields });
      shadow.serverVersion = document.version;

      return {
        ok: true,
        clientVersion: shadow.clientVersion,
        serverVersion: shadow.serverVersion,
        patch: serverPatch
      };
    },
    documents
  };
}

function isDestructivePatch(patch, ratio) {
  if (patch.beforeBytes === 0) return false;
  const removedMostBytes = patch.afterBytes / patch.beforeBytes <= 1 - ratio;
  const removedMostKeyedItems = patch.ops.some((op) => (
    op.op === "removeItem" &&
    op.beforeLength > 0 &&
    op.afterLength / op.beforeLength <= 1 - ratio
  ));
  const reorderedToEmpty = patch.ops.some((op) => (
    op.op === "reorderItems" &&
    Array.isArray(op.beforeKeys) &&
    op.beforeKeys.length > 0 &&
    Array.isArray(op.keys) &&
    op.keys.length === 0
  ));

  if (!removedMostBytes && !removedMostKeyedItems && !reorderedToEmpty) return false;
  return patch.ops.some((op) => (
    op.op === "delete" ||
    op.op === "removeItem" ||
    (op.op === "replace" && stableStringify(op.value).length < stableStringify(op.oldValue).length)
  ));
}

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `doc_${Math.random().toString(36).slice(2)}`;
}
