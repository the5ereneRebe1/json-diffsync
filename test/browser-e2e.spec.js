import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";
import { createMemoryAutosaveServer, createNodeSyncHandler } from "../src/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");

function emptyDocument() {
  return {
    root: {
      type: "root",
      key: "root",
      children: []
    }
  };
}

async function startApiServer(syncServer) {
  const syncHandler = createNodeSyncHandler(syncServer);
  const app = http.createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/sync") return syncHandler(request, response);

    if (url.pathname === "/open") {
      const documentId = url.searchParams.get("documentId");
      const sessionId = url.searchParams.get("sessionId");
      try {
        syncServer.inspectDocument(documentId);
      } catch {
        syncServer.createDocument({ documentId, value: emptyDocument() });
      }
      const result = syncServer.openDocument({ documentId, sessionId });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === "/inspect") {
      const documentId = url.searchParams.get("documentId");
      const result = syncServer.inspectDocument(documentId);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }

    response.writeHead(404);
    response.end("Not found");
  });

  await new Promise((resolveListen) => app.listen(0, "127.0.0.1", resolveListen));
  const address = app.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => app.close(resolveClose))
  };
}

async function startViteServer() {
  const vite = await createViteServer({
    root: packageRoot,
    configFile: false,
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 0
    }
  });

  await vite.listen();
  return {
    url: vite.resolvedUrls.local[0].replace(/\/$/, ""),
    close: () => vite.close()
  };
}

test("browser e2e: two React + Lexical clients converge through differential sync", async ({ browser }) => {
  const syncServer = createMemoryAutosaveServer();
  syncServer.createDocument({ documentId: "browser-doc", value: emptyDocument() });
  const api = await startApiServer(syncServer);
  const vite = await startViteServer();

  const laptopContext = await browser.newContext();
  const ipadContext = await browser.newContext();
  const laptop = await laptopContext.newPage();
  const ipad = await ipadContext.newPage();

  try {
    const laptopUrl = `${vite.url}/test/browser-app/index.html?api=${encodeURIComponent(api.url)}&documentId=browser-doc&sessionId=laptop`;
    const ipadUrl = `${vite.url}/test/browser-app/index.html?api=${encodeURIComponent(api.url)}&documentId=browser-doc&sessionId=ipad`;

    await laptop.goto(laptopUrl);
    await ipad.goto(ipadUrl);

    await expect(laptop.getByTestId("status")).toHaveText("idle");
    await expect(ipad.getByTestId("status")).toHaveText("idle");

    await laptop.getByTestId("editor").click();
    await laptop.keyboard.type("Laptop draft");
    await laptop.getByTestId("sync-now").click();
    await expect(laptop.getByTestId("synced-text")).toContainText("Laptop draft");

    await ipad.getByTestId("editor").click();
    await ipad.keyboard.type("iPad draft");
    await ipad.getByTestId("sync-now").click();
    await laptop.getByTestId("sync-now").click();

    await expect(laptop.getByTestId("synced-text")).toContainText("Laptop draft");
    await expect(laptop.getByTestId("synced-text")).toContainText("iPad draft");
    await expect(ipad.getByTestId("synced-text")).toContainText("Laptop draft");
    await expect(ipad.getByTestId("synced-text")).toContainText("iPad draft");

    await expect(laptop.getByTestId("editor")).toContainText("Laptop draft");
    await expect(laptop.getByTestId("editor")).toContainText("iPad draft");
    await expect(ipad.getByTestId("editor")).toContainText("Laptop draft");
    await expect(ipad.getByTestId("editor")).toContainText("iPad draft");

    const inspected = syncServer.inspectDocument("browser-doc");
    const keys = inspected.value.root.children.map((node) => node.key).sort();
    expect(keys).toEqual(["ipad", "laptop"]);
  } finally {
    await laptopContext.close();
    await ipadContext.close();
    await vite.close();
    await api.close();
  }
});
