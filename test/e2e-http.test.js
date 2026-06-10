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

async function startHttpSyncServer(syncServer) {
  const handler = createNodeSyncHandler(syncServer);
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
