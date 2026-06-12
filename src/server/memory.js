import { applyJsonPatch, createJsonPatch } from "../core/patch.js";
import { cloneJson, hashJson, jsonEqual, stableStringify } from "../core/json.js";

export function createMemoryAutosaveServer(options = {}) {
  const documents = new Map();
  const destructiveDeleteRatio = options.destructiveDeleteRatio ?? 0.8;
  const keepRevisions = options.keepRevisions ?? true;
  const maxRevisions = options.maxRevisions ?? 100;
  const keyFields = options.keyFields ?? ["key", "id"];

  function getDocument(documentId) {
    const document = documents.get(documentId);
    if (!document) throw new Error(`Unknown document: ${documentId}`);
    return document;
  }

  function createSessionShadow(document) {
    return {
      value: cloneJson(document.value),
      hash: null,
      clientVersion: 0,
      serverVersion: document.version
    };
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
      document.sessions.set(sessionId, createSessionShadow(document));
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
      const document = documents.get(message.documentId);
      if (!document) {
        return { ok: false, reason: "unknown_document" };
      }
      let shadow = document.sessions.get(message.sessionId);
      if (!shadow) {
        shadow = createSessionShadow(document);
        document.sessions.set(message.sessionId, shadow);
      }

      if (message.clientVersion !== shadow.clientVersion) {
        return {
          ok: false,
          reason: "client_version_mismatch",
          clientVersion: shadow.clientVersion,
          serverVersion: shadow.serverVersion
        };
      }

      shadow.hash ??= hashJson(shadow.value);
      if (message.shadowHash !== shadow.hash || message.patch.baseHash !== shadow.hash) {
        return {
          ok: false,
          reason: "shadow_mismatch",
          value: cloneJson(document.value),
          clientVersion: shadow.clientVersion,
          serverVersion: document.version
        };
      }

      const clientChanged = message.patch.ops.length > 0;
      let nextShadow = shadow.value;
      let nextValue = document.value;
      if (clientChanged) {
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
      }

      if (
        clientChanged &&
        !message.meta?.confirmDestructive &&
        isDestructivePatch(message.patch, destructiveDeleteRatio, shadow.value, nextShadow)
      ) {
        return {
          ok: false,
          reason: "destructive_patch_requires_confirmation",
          clientVersion: shadow.clientVersion,
          serverVersion: shadow.serverVersion
        };
      }

      const changedServer = clientChanged && !jsonEqual(nextValue, document.value);
      if (keepRevisions && changedServer) {
        document.revisions.push({
          version: document.version,
          sessionId: message.sessionId,
          before: cloneJson(document.value),
          after: cloneJson(nextValue),
          patch: cloneJson(message.patch),
          at: new Date().toISOString()
        });
        if (document.revisions.length > maxRevisions) {
          document.revisions.splice(0, document.revisions.length - maxRevisions);
        }
      }

      document.value = nextValue;
      if (changedServer) document.version += 1;
      shadow.value = nextShadow;
      if (clientChanged) {
        shadow.hash = null;
        shadow.clientVersion += 1;
      }

      shadow.hash ??= hashJson(shadow.value);
      const serverPatch = createJsonPatch(shadow.value, document.value, {
        keyFields,
        baseHash: shadow.hash
      });
      if (serverPatch.ops.length > 0) {
        shadow.value = cloneJson(document.value);
        shadow.hash = null;
      }
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

// Shrinkage is measured against the server's own shadow rather than any
// client-reported sizes, so a broken client cannot understate a deletion.
function isDestructivePatch(patch, ratio, beforeValue, afterValue) {
  const hasShrinkingOps = patch.ops.some((op) => (
    op.op === "delete" || op.op === "removeItem" || op.op === "replace"
  ));
  if (!hasShrinkingOps) return false;

  const beforeBytes = stableStringify(beforeValue).length;
  if (beforeBytes === 0) return false;
  const removedMostBytes = stableStringify(afterValue).length / beforeBytes <= 1 - ratio;
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

  return removedMostBytes || removedMostKeyedItems || reorderedToEmpty;
}

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `doc_${Math.random().toString(36).slice(2)}`;
}
