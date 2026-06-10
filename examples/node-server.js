import http from "node:http";
import { createMemoryAutosaveServer, createNodeSyncHandler } from "../src/server.js";

const syncServer = createMemoryAutosaveServer();
const document = syncServer.createDocument({
  documentId: "demo",
  value: {
    root: {
      type: "root",
      key: "root",
      children: [
        {
          type: "paragraph",
          key: "p1",
          children: [
            {
              type: "text",
              key: "p1:text",
              text: "Open this document from two devices."
            }
          ]
        }
      ]
    }
  }
});

console.log(`Created document ${document.documentId}`);

const handleSync = createNodeSyncHandler(syncServer);

http
  .createServer((request, response) => {
    if (request.url === "/sync") return handleSync(request, response);
    response.writeHead(404);
    response.end("Not found");
  })
  .listen(3000, () => {
    console.log("Sync server listening on http://localhost:3000");
  });
