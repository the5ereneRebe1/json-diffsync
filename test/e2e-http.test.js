import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { createAutosaveClient } from "../src/index.js";
import {
  createFetchTransport,
  createMemoryAutosaveServer,
  createNodeSyncHandler
} from "../src/server.js";

function lexicalDoc(children = []) {
  return {
    root: {
      type: "root",
      key: "root",
      children
    }
  };
}

function paragraph(key, text) {
  return {
    type: "paragraph",
    key,
    children: [
      {
        type: "text",
        key: `${key}:text`,
        text
      }
    ]
  };
}

async function startHttpSyncServer(syncServer, handlerOptions) {
  const handler = createNodeSyncHandler(syncServer, handlerOptions);
  const app = http.createServer((request, response) => {
    if (request.url === "/sync") return handler(request, response);
    response.writeHead(404);
    response.end("Not found");
  });

  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();

  return {
    url: `http://127.0.0.1:${address.port}/sync`,
    close: () => new Promise((resolve) => app.close(resolve))
  };
}

test("e2e: two JSON clients sync through the HTTP transport", async () => {
  const syncServer = createMemoryAutosaveServer();
  syncServer.createDocument({ documentId: "doc-http", value: lexicalDoc() });
  const httpServer = await startHttpSyncServer(syncServer);

  try {
    const laptopOpen = syncServer.openDocument({
      documentId: "doc-http",
      sessionId: "laptop"
    });
    const ipadOpen = syncServer.openDocument({
      documentId: "doc-http",
      sessionId: "ipad"
    });

    const transport = createFetchTransport(httpServer.url);
    const laptop = createAutosaveClient({
      documentId: "doc-http",
      sessionId: "laptop",
      initialValue: laptopOpen.value,
      transport
    });
    const ipad = createAutosaveClient({
      documentId: "doc-http",
      sessionId: "ipad",
      initialValue: ipadOpen.value,
      transport
    });

    laptop.setValue(lexicalDoc([paragraph("laptop-p1", "Laptop draft")]));
    await laptop.sync();

    ipad.setValue(lexicalDoc([paragraph("ipad-p1", "iPad draft")]));
    await ipad.sync();

    await laptop.sync();

    const serverKeys = syncServer
      .inspectDocument("doc-http")
      .value.root.children.map((node) => node.key)
      .sort();
    const laptopKeys = laptop
      .getValue()
      .root.children.map((node) => node.key)
      .sort();

    assert.deepEqual(serverKeys, ["ipad-p1", "laptop-p1"]);
    assert.deepEqual(laptopKeys, ["ipad-p1", "laptop-p1"]);
  } finally {
    await httpServer.close();
  }
});

test("e2e: a fresh client syncs over HTTP without a manual openDocument call", async () => {
  const syncServer = createMemoryAutosaveServer({ keyFields: ["key", "id"] });
  syncServer.createDocument({ documentId: "doc-1", value: lexicalDoc() });
  const httpServer = await startHttpSyncServer(syncServer);

  try {
    // Mirrors the README Quick Start: no openDocument anywhere, just create a
    // client against the HTTP transport and sync. This is the only path a real
    // remote consumer has, since openDocument is not reachable over HTTP.
    const client = createAutosaveClient({
      documentId: "doc-1",
      sessionId: "laptop",
      initialValue: lexicalDoc(),
      transport: createFetchTransport(httpServer.url)
    });

    client.setValue(lexicalDoc([paragraph("p1", "Hello from the laptop")]));
    const result = await client.sync();

    assert.equal(result.ok, true);
    assert.deepEqual(
      syncServer
        .inspectDocument("doc-1")
        .value.root.children.map((node) => node.key),
      ["p1"]
    );
  } finally {
    await httpServer.close();
  }
});

test("e2e: handler survives malformed bodies, unknown documents, and oversized payloads", async () => {
  const syncServer = createMemoryAutosaveServer();
  syncServer.createDocument({ documentId: "doc-robust", value: lexicalDoc() });
  const httpServer = await startHttpSyncServer(syncServer, { maxBodyBytes: 2048 });

  try {
    const badJson = await fetch(httpServer.url, { method: "POST", body: "{not json" });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).reason, "invalid_json");

    const badShape = await fetch(httpServer.url, {
      method: "POST",
      body: JSON.stringify({ hello: "world" })
    });
    assert.equal(badShape.status, 400);
    assert.equal((await badShape.json()).reason, "invalid_message");

    const unknownDoc = await fetch(httpServer.url, {
      method: "POST",
      body: JSON.stringify({
        documentId: "nope",
        sessionId: "laptop",
        clientVersion: 0,
        shadowHash: "x",
        patch: { kind: "json-keyed", baseHash: "x", ops: [] }
      })
    });
    assert.equal(unknownDoc.status, 404);
    assert.equal((await unknownDoc.json()).reason, "unknown_document");

    // Oversized bodies are either answered with 413 or the connection is cut;
    // either way the server must not crash.
    const oversized = await fetch(httpServer.url, {
      method: "POST",
      body: JSON.stringify({
        documentId: "doc-robust",
        sessionId: "laptop",
        clientVersion: 0,
        shadowHash: "x",
        patch: { kind: "json-keyed", baseHash: "x", ops: [] },
        padding: "x".repeat(64 * 1024)
      })
    }).catch(() => null);
    if (oversized) assert.equal(oversized.status, 413);

    // The server is still alive and fully functional afterwards.
    const client = createAutosaveClient({
      documentId: "doc-robust",
      sessionId: "laptop",
      initialValue: lexicalDoc(),
      transport: createFetchTransport(httpServer.url)
    });
    client.setValue(lexicalDoc([paragraph("p1", "Still alive")]));
    const result = await client.sync();
    assert.equal(result.ok, true);
  } finally {
    await httpServer.close();
  }
});

test("e2e: destructive JSON autosave is rejected over HTTP", async () => {
  const syncServer = createMemoryAutosaveServer();
  syncServer.createDocument({
    documentId: "doc-delete",
    value: lexicalDoc([paragraph("p1", "Keep me")])
  });
  const httpServer = await startHttpSyncServer(syncServer);

  try {
    const opened = syncServer.openDocument({
      documentId: "doc-delete",
      sessionId: "laptop"
    });
    const laptop = createAutosaveClient({
      documentId: "doc-delete",
      sessionId: "laptop",
      initialValue: opened.value,
      transport: createFetchTransport(httpServer.url)
    });

    laptop.setValue(lexicalDoc());

    await assert.rejects(
      () => laptop.sync(),
      /destructive_patch_requires_confirmation/
    );
    assert.equal(
      syncServer.inspectDocument("doc-delete").value.root.children.length,
      1
    );
  } finally {
    await httpServer.close();
  }
});
