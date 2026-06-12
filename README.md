# json-diffsync

[![npm version](https://img.shields.io/npm/v/json-diffsync)](https://www.npmjs.com/package/json-diffsync)
[![runtime dependencies](https://img.shields.io/badge/runtime_deps-0-brightgreen)](https://www.npmjs.com/package/json-diffsync?activeTab=dependencies)
[![node](https://img.shields.io/node/v/json-diffsync)](https://nodejs.org)
[![types](https://img.shields.io/badge/types-included-blue)](./src/index.d.ts)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Differential synchronization primitives for JSON autosave.

`json-diffsync` helps keep multiple open copies of the same JSON document in sync without letting one stale tab or device overwrite newer work from another. It is designed for autosave flows in editors, form builders, dashboard builders, app-state editors, and JSON-based rich-text frameworks.

It is intentionally not a CRDT and not Operational Transformation. It follows the classic differential synchronization model: every client keeps a local value and a shadow, the server keeps a canonical value and one shadow per client session, and sync requests exchange patches computed between the shadow and current JSON.

## The Problem

Full-document autosave has a failure mode everyone has met: the browser tab you opened this morning quietly saves over the work you did this afternoon.

![Without diff sync, a stale laptop PUTs its full document and silently erases the 47 blocks written on the iPad. With json-diffsync, the stale laptop syncs an empty patch and the server replies with the 47 blocks it missed.](assets/stale-tab-problem.svg)

A client never uploads its document. It uploads the difference between its document and the last state both sides agreed on — for a stale client, that difference is empty.

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
- Recover from client version mismatch after a server restart loses session state.
- Check for unsynced edits with `hasLocalChanges()` and `state.dirty`.
- Configure identity fields with `keyFields`.
- Use `sync({ confirmDestructive: true })` for explicit destructive saves.

## React Client Features

- Use `useDifferentialAutosave` for React apps.
- Autosave dirty changes on an interval with `intervalMs`; clean ticks are skipped.
- Poll for remote changes with `pullIntervalMs` (default 10s), plus a pull when the tab becomes visible.
- Flush unsynced edits when the tab is hidden or unloaded.
- Persist hook state under a configurable `storageKey`.
- Expose `value`, `setValue`, `sync`, `status`, `error`, and `dirty`.
- Works with any JSON-producing editor or UI state, including Lexical-style JSON.

## Server Features

- Create an in-memory reference server with `createMemoryAutosaveServer`.
- Store canonical JSON document state.
- Maintain one server-side shadow per client/session.
- Validate client versions and shadow hashes.
- Apply client patches and return missing server patches.
- Configure keyed array identity with `keyFields`.
- Configure destructive patch sensitivity with `destructiveDeleteRatio`.
- Keep or disable revision history with `keepRevisions`; cap it with `maxRevisions` (default 100).
- Create sessions lazily on first sync, so remote HTTP clients need no separate open call.
- Expose a Node HTTP handler with `createNodeSyncHandler(server, { maxBodyBytes })` that rejects malformed JSON (400), unknown documents (404), and oversized bodies (413, 16 MB default) without crashing.

The in-memory server is a reference implementation. Production apps will usually wrap the same sync logic with durable storage.

## Shared Patch Features

- Diff arbitrary JSON with `createJsonPatch`.
- Apply patches with `applyJsonPatch`.
- Hash JSON deterministically with `hashJson`; compare structurally with `jsonEqual`.
- Patches carry only new values by default; pass `includeOldValues: true` to embed `oldValue` for strict standalone verification.
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

How much of your structure survives a diff depends on whether array items can be identified:

![Keyed arrays, where items carry an id or key, get item-level set and insertItem operations that merge with concurrent edits. Unkeyed arrays of plain values are replaced atomically on any change and marked lossy, so concurrent edits overwrite each other.](assets/keyed-vs-unkeyed.svg)

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

Both sides keep two copies of the document. The extra copy — the shadow — is what makes diffing against a moving target safe:

![Every client keeps a value (what the user sees) and a shadow (the last agreed-upon state). The server keeps the canonical value plus one shadow per client session.](assets/value-shadow-model.svg)

One sync round trip:

![The client diffs its shadow against its value and sends the patch with a shadow hash and versions. The server validates the hash, applies the patch to the session shadow and the canonical value, then replies with the diff the client is missing. The client applies the reply and now matches the server.](assets/sync-roundtrip.svg)

When a stale laptop autosaves, it does not say “replace the server with my full JSON.” It sends only the diff between `client.shadow` and `client.value`. If the laptop made no local edits, that patch is empty. The server then diffs the laptop shadow against canonical state and sends back changes made elsewhere.

## Guardrails

Differential sync prevents stale full-document overwrites, but it cannot know whether a valid delete-most diff came from a real user action or a broken client. A user clearing their document and a buggy editor emitting `[]` produce the same patch, so the big deletes get a speed bump:

![A patch that deletes 80 percent or more of the document is applied with a revision recorded only when meta.confirmDestructive is true; otherwise it is rejected with a 409 destructive_patch_requires_confirmation.](assets/destructive-guardrail.svg)

The reference server includes:

- Shadow hash validation.
- Client version validation.
- Destructive patch confirmation.
- Revision history.

By default, a patch that shrinks the JSON payload by at least 80%, or removes at least 80% of a keyed child array, is rejected unless `sync({ confirmDestructive: true })` is used. Shrinkage is measured server-side against the server's own session shadow, so a broken client cannot understate a deletion.

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
  hashJson,
  jsonEqual
} from "json-diffsync";
```

Client helpers:

- `createAutosaveClient(options)`
- `createLocalStoragePersister(key, storage?)`

Patch helpers:

- `createJsonPatch(before, after, options?)` with `keyFields`, `includeOldValues`, `baseHash`
- `applyJsonPatch(value, patch, options?)`
- `hashJson(value)`
- `jsonEqual(left, right)`
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

- `createMemoryAutosaveServer(options?)` with `keyFields`, `destructiveDeleteRatio`, `keepRevisions`, `maxRevisions`
- `createNodeSyncHandler(server, options?)` with `maxBodyBytes`
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

Current behavior: patch size scales with the edit, not the document. Diffing is structural (no per-level stringification) and shadow hashes are cached on both sides, so an idle sync costs almost nothing. The remaining cost on very large documents is the full-document clone inside `setValue` and `applyJsonPatch`; copy-on-write path updates are the next optimization target.

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
