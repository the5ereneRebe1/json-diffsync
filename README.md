# json-diffsync

Differential synchronization primitives for JSON autosave.

`json-diffsync` helps keep multiple open copies of the same JSON document in sync without letting one stale tab or device overwrite newer work from another. It is designed for autosave flows in editors, form builders, dashboard builders, app-state editors, and JSON-based rich-text frameworks.

It is intentionally not a CRDT and not Operational Transformation. It follows the classic differential synchronization model: every client keeps a local value and a shadow, the server keeps a canonical value and one shadow per client session, and sync requests exchange patches computed between the shadow and current JSON.

## Core Idea

```txt
Any JSON works.
Keyed arrays get item-level patches.
Unkeyed arrays still sync, but as lossy atomic replacements.
```

Objects are diffed by property path. Arrays of objects are treated as keyed when each item has a stable `key` or `id` field by default. You can configure other identity fields such as `uuid`, `nodeId`, or `blockId`.

## Client Features

- Create an autosave client with `createAutosaveClient`.
- Track `value`, `shadow`, `clientVersion`, and `serverVersion`.
- Generate patches from local JSON changes.
- Send patches through any transport with a `sync(message)` function.
- Use the built-in `createFetchTransport` for HTTP sync.
- Persist local client state with `createLocalStoragePersister`.
- Recover from server shadow mismatch without blindly discarding unsynced local edits.
- Configure identity fields with `keyFields`.
- Use `sync({ confirmDestructive: true })` for explicit destructive saves.

## React Client Features

- Use `useDifferentialAutosave` for React apps.
- Autosync on an interval with `intervalMs`.
- Persist hook state under a configurable `storageKey`.
- Expose `value`, `setValue`, `sync`, `status`, and `error`.
- Works with any JSON-producing editor or UI state, including Lexical-style JSON.

## Server Features

- Create an in-memory reference server with `createMemoryAutosaveServer`.
- Store canonical JSON document state.
- Maintain one server-side shadow per client/session.
- Validate client versions and shadow hashes.
- Apply client patches and return missing server patches.
- Configure keyed array identity with `keyFields`.
- Configure destructive patch sensitivity with `destructiveDeleteRatio`.
- Keep or disable revision history with `keepRevisions`.
- Expose a Node HTTP handler with `createNodeSyncHandler`.

The in-memory server is a reference implementation. Production apps will usually wrap the same sync logic with durable storage.

## Shared Patch Features

- Diff arbitrary JSON with `createJsonPatch`.
- Apply patches with `applyJsonPatch`.
- Hash JSON deterministically with `hashJson`.
- Diff keyed arrays as item-level operations: `insertItem`, `removeItem`, `reorderItems`.
- Diff objects as path-level operations: `set`, `replace`, `delete`.
- Mark unkeyed array replacements with `patch.lossy === true`.

## Install

```sh
npm install json-diffsync
```

## Quick Start

Create a server-side sync store:

```js
import http from "node:http";
import {
  createMemoryAutosaveServer,
  createNodeSyncHandler
} from "json-diffsync/server";

const sync = createMemoryAutosaveServer({
  keyFields: ["key", "id"]
});

sync.createDocument({
  documentId: "doc-1",
  value: {
    title: "Draft",
    blocks: []
  }
});

const handleSync = createNodeSyncHandler(sync);

http.createServer((request, response) => {
  if (request.url === "/sync") return handleSync(request, response);
  response.writeHead(404).end();
}).listen(3000);
```

Create a client:

```js
import { createAutosaveClient } from "json-diffsync";
import { createFetchTransport } from "json-diffsync/server";

const client = createAutosaveClient({
  documentId: "doc-1",
  sessionId: "laptop",
  initialValue: {
    title: "Draft",
    blocks: []
  },
  transport: createFetchTransport("/sync")
});

client.setValue({
  title: "Draft",
  blocks: [
    { id: "intro", text: "Hello from the laptop" }
  ]
});

await client.sync();
```

## React Usage

```jsx
import { useDifferentialAutosave } from "json-diffsync/react";
import { createFetchTransport } from "json-diffsync/server";

const transport = createFetchTransport("/sync");

export function JsonEditor({ documentId, sessionId }) {
  const autosave = useDifferentialAutosave({
    documentId,
    sessionId,
    initialValue: {
      title: "Untitled",
      blocks: []
    },
    transport,
    keyFields: ["id"],
    intervalMs: 1500
  });

  return (
    <button onClick={() => autosave.sync()}>
      Save now
    </button>
  );
}
```

For Lexical or other editor frameworks, call `autosave.setValue(...)` with the serialized JSON state when the editor updates, then apply `autosave.value` back to the editor when remote patches arrive.

## Fidelity Model

### Objects

Plain objects are diffed by property path:

```json
{ "title": "Draft" }
```

If `title` changes, the patch contains a path-level operation.

### Keyed Arrays

Keyed arrays are diffed by item identity:

```json
{
  "blocks": [
    { "id": "intro", "text": "One" },
    { "id": "body", "text": "Two" }
  ]
}
```

If one client edits `intro` while another inserts a new block, the server can apply both without replacing the whole `blocks` array.

### Unkeyed Arrays

Unkeyed arrays still work:

```json
{ "tags": ["draft", "review"] }
```

But they are treated as atomic replacements and marked lossy:

```js
patch.lossy === true
patch.ops[0].lossyReason === "unkeyed_array_replace"
```

This means the library can sync the value, but concurrent edits to the same unkeyed array can overwrite each other. If a collection matters, give each item a stable key.

## Custom Identity Fields

Use `keyFields` on both client and server:

```js
const sync = createMemoryAutosaveServer({
  keyFields: ["uuid", "nodeId", "blockId"]
});

const client = createAutosaveClient({
  documentId,
  sessionId,
  initialValue,
  transport,
  keyFields: ["uuid", "nodeId", "blockId"]
});
```

## Network Shape

Client sends:

```json
{
  "documentId": "doc-1",
  "sessionId": "laptop",
  "clientVersion": 2,
  "serverVersion": 3,
  "shadowHash": "a1b2c3d4",
  "patch": {
    "kind": "json-keyed",
    "baseHash": "a1b2c3d4",
    "lossy": false,
    "ops": [
      {
        "op": "set",
        "path": ["blocks", { "$key": "intro" }, "text"],
        "value": "Hello from the laptop"
      }
    ]
  }
}
```

Server responds with what the client is missing:

```json
{
  "ok": true,
  "clientVersion": 3,
  "serverVersion": 4,
  "patch": {
    "kind": "json-keyed",
    "lossy": false,
    "ops": []
  }
}
```

## Autosave Flow

Each client maintains:

```txt
client.value       current JSON state
client.shadow      server state this client last synced against
clientVersion      monotonic version for this client shadow
serverVersion      last server version this client received
```

The server maintains:

```txt
document.value                  canonical JSON
document.sessions[laptop].value server-side shadow for laptop
document.sessions[ipad].value   server-side shadow for iPad
```

When a stale laptop autosaves, it does not say “replace the server with my full JSON.” It sends only the diff between `client.shadow` and `client.value`. If the laptop made no local edits, that patch is empty. The server then diffs the laptop shadow against canonical state and sends back changes made elsewhere.

## Guardrails

Differential sync prevents stale full-document overwrites, but it cannot know whether a valid delete-most diff came from a real user action or a broken client. The reference server includes:

- Shadow hash validation.
- Client version validation.
- Destructive patch confirmation.
- Revision history.

By default, a patch that shrinks the JSON payload by at least 80%, or removes at least 80% of a keyed child array, is rejected unless `sync({ confirmDestructive: true })` is used.

## API

### Client And Shared Core

```js
import {
  createAutosaveClient,
  createLocalStoragePersister,
  createJsonPatch,
  applyJsonPatch,
  cloneJson,
  stableStringify,
  hashJson
} from "json-diffsync";
```

Client helpers:

- `createAutosaveClient(options)`
- `createLocalStoragePersister(key, storage?)`

Patch helpers:

- `createJsonPatch(before, after, options?)`
- `applyJsonPatch(value, patch, options?)`
- `hashJson(value)`
- `stableStringify(value)`
- `cloneJson(value)`

### React Client

```js
import { useDifferentialAutosave } from "json-diffsync/react";
```

React hook:

- `useDifferentialAutosave(options)`

### Server

```js
import {
  createMemoryAutosaveServer,
  createNodeSyncHandler,
  createFetchTransport
} from "json-diffsync/server";
```

Server helpers:

- `createMemoryAutosaveServer(options?)`
- `createNodeSyncHandler(server)`
- `createFetchTransport(url, fetchImpl?)`

## Source Layout

```txt
src/index.js             public client/core entrypoint
src/client.js            autosave client state machine
src/persistence.js       localStorage-style persister
src/core/json.js         clone, stable stringify, hash helpers
src/core/patch.js        JSON diff and patch implementation
src/react.js             React autosave hook
src/server.js            public server entrypoint
src/server/memory.js     in-memory reference sync server
src/server/transport.js  fetch transport and Node HTTP handler
```

## Testing

Run the protocol and HTTP E2E tests:

```sh
npm test
```

The suite covers:

- stale laptop/iPad autosave recovery
- keyed item-level patches
- unkeyed lossy patches
- custom key fields
- destructive delete rejection
- large nested JSON documents
- HTTP sync over a real local server

Run browser E2E with React + Lexical:

```sh
npm run test:e2e:browser
```

That test starts a Node sync API, starts a Vite React app, opens two isolated Chromium contexts as `laptop` and `ipad`, types into both editors, syncs over HTTP, and asserts both browser pages plus the server JSON converge.

## Benchmark

Run:

```sh
npm run bench
```

The benchmark generates deterministic nested JSON documents, mutates deep keyed nodes, inserts keyed blocks, reorders sections, and measures patch creation, patch application, and full in-memory client/server sync.

Current MVP behavior: patch size scales well, but full sync time still grows with total JSON size because the implementation hashes, stringifies, and clones whole values in a few places. Optimization targets are documented by the benchmark.

## Status

`json-diffsync` is early-stage software. The core model is working and tested, but the API may change before `1.0.0`.

Good current use cases:

- JSON autosave
- same-user multi-tab/device editing
- keyed editor/app state
- prototype collaboration flows

Use extra care for:

- high-frequency multi-user editing
- very large JSON values
- concurrent edits to the same scalar field
- unkeyed arrays where concurrent edits matter

## License

MIT
