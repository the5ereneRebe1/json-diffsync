import { Readable } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyJsonPatch,
  createAutosaveClient,
  createJsonPatch,
  hashJson
} from "../src/index.js";
import {
  createFetchTransport,
  createMemoryAutosaveServer,
  createNodeSyncHandler
} from "../src/server.js";

function doc(children = []) {
  return {
    root: {
      key: "root",
      type: "root",
      children
    }
  };
}

function paragraph(key, text) {
  return {
    key,
    type: "paragraph",
    children: [{ key: `${key}:text`, type: "text", text }]
  };
}

test("failure: applyJsonPatch rejects unsupported patch formats", () => {
  assert.throws(
    () => applyJsonPatch({}, { kind: "not-json-keyed", ops: [] }),
    /Unsupported patch format/
  );
});

test("failure: strict keyed removal rejects missing target keys", () => {
  const before = {
    items: [{ id: "a", text: "A" }]
  };
  const after = {
    items: []
  };
  const patch = createJsonPatch(before, after);

  assert.throws(
    () => applyJsonPatch({ items: [] }, patch, { strict: true }),
    /removeItem target key does not exist/
  );
});

test("failure: strict nested patch rejects unresolved paths", () => {
  const patch = {
    kind: "json-keyed",
    baseHash: "ignored",
    beforeBytes: 0,
    afterBytes: 0,
    lossy: false,
    ops: [
      {
        op: "set",
        path: ["missing", "title"],
        value: "Nope"
      }
    ]
  };

  assert.throws(
    () => applyJsonPatch({}, patch, { strict: true }),
    /Patch path could not be resolved/
  );
});

test("failure: opening an unknown document throws", () => {
  const server = createMemoryAutosaveServer();

  assert.throws(
    () => server.openDocument({ documentId: "missing", sessionId: "laptop" }),
    /Unknown document: missing/
  );
});

test("failure: syncing an unknown session returns a structured error", () => {
  const server = createMemoryAutosaveServer();
  const created = server.createDocument({ documentId: "doc-unknown-session", value: doc() });
  const patch = createJsonPatch(created.value, created.value);

  const response = server.sync({
    documentId: created.documentId,
    sessionId: "not-opened",
    clientVersion: 0,
    serverVersion: 0,
    shadowHash: hashJson(created.value),
    patch,
    meta: {}
  });

  assert.deepEqual(response, { ok: false, reason: "unknown_session" });
});

test("failure: malformed patches return patch_apply_failed without changing server state", () => {
  const server = createMemoryAutosaveServer();
  server.createDocument({ documentId: "doc-bad-patch", value: doc([paragraph("p1", "Keep")]) });
  const opened = server.openDocument({ documentId: "doc-bad-patch", sessionId: "laptop" });

  const response = server.sync({
    documentId: "doc-bad-patch",
    sessionId: "laptop",
    clientVersion: opened.clientVersion,
    serverVersion: opened.serverVersion,
    shadowHash: hashJson(opened.value),
    patch: {
      kind: "json-keyed",
      baseHash: hashJson(opened.value),
      beforeBytes: 1,
      afterBytes: 1,
      lossy: false,
      ops: [{ op: "set", path: ["root", "missing", "text"], value: "Bad" }]
    },
    meta: {}
  });

  assert.equal(response.ok, false);
  assert.equal(response.reason, "patch_apply_failed");
  assert.equal(server.inspectDocument("doc-bad-patch").value.root.children[0].children[0].text, "Keep");
});

test("failure: createFetchTransport converts non-json HTTP failures into structured errors", async () => {
  const transport = createFetchTransport("https://example.test/sync", async () => ({
    ok: false,
    status: 503,
    async json() {
      throw new Error("not json");
    }
  }));

  const response = await transport.sync({ hello: "world" });

  assert.deepEqual(response, { ok: false, reason: "http_503" });
});

test("failure: createFetchTransport preserves structured server errors", async () => {
  const transport = createFetchTransport("https://example.test/sync", async () => ({
    ok: false,
    status: 409,
    async json() {
      return {
        ok: false,
        reason: "destructive_patch_requires_confirmation"
      };
    }
  }));

  const response = await transport.sync({ hello: "world" });

  assert.deepEqual(response, {
    ok: false,
    reason: "destructive_patch_requires_confirmation"
  });
});

test("failure: client sync rejects transport errors and records lastError", async () => {
  const client = createAutosaveClient({
    documentId: "doc-transport-error",
    sessionId: "laptop",
    initialValue: doc(),
    transport: {
      async sync() {
        throw new Error("network down");
      }
    }
  });

  await assert.rejects(() => client.sync(), /network down/);
  assert.equal(client.state.lastError.message, "network down");
});

test("failure: concurrent client sync attempts are skipped instead of duplicated", async () => {
  let releaseSync;
  const firstSync = new Promise((resolve) => {
    releaseSync = () => resolve({
      ok: true,
      clientVersion: 1,
      serverVersion: 0,
      patch: null
    });
  });
  const client = createAutosaveClient({
    documentId: "doc-concurrent-sync",
    sessionId: "laptop",
    initialValue: doc(),
    transport: {
      sync: () => firstSync
    }
  });

  const pending = client.sync();
  const skipped = await client.sync();
  releaseSync();
  await pending;

  assert.deepEqual(skipped, { skipped: true });
});

test("failure: shadow mismatch rejects sync and preserves unsynced local edits", async () => {
  const client = createAutosaveClient({
    documentId: "doc-shadow-mismatch-local",
    sessionId: "laptop",
    initialValue: doc([paragraph("local", "Unsynced local edit")]),
    transport: {
      async sync() {
        return {
          ok: false,
          reason: "shadow_mismatch",
          value: doc([paragraph("server", "Server value")]),
          clientVersion: 7,
          serverVersion: 11
        };
      }
    }
  });

  client.setValue(doc([paragraph("local", "Still local")]));

  await assert.rejects(() => client.sync(), /shadow_mismatch/);
  assert.equal(client.getValue().root.children[0].key, "local");
  assert.equal(client.state.shadow.root.children[0].key, "server");
  assert.equal(client.state.clientVersion, 7);
  assert.equal(client.state.serverVersion, 11);
});

test("failure: HTTP handler returns 405 for non-POST requests", async () => {
  const server = createMemoryAutosaveServer();
  const handler = createNodeSyncHandler(server);
  const request = Readable.from([]);
  request.method = "GET";

  const response = createFakeResponse();
  await handler(request, response);

  assert.equal(response.statusCode, 405);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    reason: "method_not_allowed"
  });
});

function createFakeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = "") {
      this.body += chunk;
    }
  };
}
