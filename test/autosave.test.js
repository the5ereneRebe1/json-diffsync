import test from "node:test";
import assert from "node:assert/strict";
import {
  applyJsonPatch,
  createAutosaveClient,
  createJsonPatch,
  createLocalStoragePersister,
  hashJson
} from "../src/index.js";
import { createFetchTransport, createMemoryAutosaveServer } from "../src/server.js";

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

function complexJsonDoc({ sections = 12, blocksPerSection = 6, inlinesPerBlock = 4 } = {}) {
  return {
    schemaVersion: 1,
    metadata: {
      title: "Large autosave document",
      tags: ["draft", "internal"],
      flags: {
        archived: false,
        reviewed: false
      }
    },
    sections: Array.from({ length: sections }, (_, sectionIndex) => ({
      key: `section-${sectionIndex}`,
      type: "section",
      attrs: {
        order: sectionIndex,
        collapsed: false
      },
      blocks: Array.from({ length: blocksPerSection }, (_, blockIndex) => ({
        key: `block-${sectionIndex}-${blockIndex}`,
        type: blockIndex % 2 === 0 ? "paragraph" : "quote",
        attrs: {
          align: "left",
          depth: blockIndex % 3
        },
        children: Array.from({ length: inlinesPerBlock }, (_, inlineIndex) => ({
          key: `text-${sectionIndex}-${blockIndex}-${inlineIndex}`,
          type: "text",
          text: `S${sectionIndex} B${blockIndex} T${inlineIndex}`,
          marks: inlineIndex % 2 === 0 ? ["bold"] : []
        })),
        comments: [
          {
            id: `comment-${sectionIndex}-${blockIndex}`,
            authorId: "u1",
            body: `Comment ${sectionIndex}.${blockIndex}`,
            resolved: false
          }
        ]
      }))
    })),
    sidebar: {
      widgets: [
        { id: "toc", type: "table-of-contents", enabled: true },
        { id: "outline", type: "outline", enabled: true }
      ]
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("stale laptop pulls iPad JSON changes instead of overwriting them", async () => {
  const server = createMemoryAutosaveServer();
  const created = server.createDocument({ documentId: "doc-1", value: lexicalDoc() });

  const laptopOpen = server.openDocument({ documentId: created.documentId, sessionId: "laptop" });
  const ipadOpen = server.openDocument({ documentId: created.documentId, sessionId: "ipad" });

  const laptop = createAutosaveClient({
    documentId: "doc-1",
    sessionId: "laptop",
    initialValue: laptopOpen.value,
    transport: server
  });

  const ipad = createAutosaveClient({
    documentId: "doc-1",
    sessionId: "ipad",
    initialValue: ipadOpen.value,
    transport: server
  });

  laptop.setValue(lexicalDoc([paragraph("p1", "Hello world")]));
  await laptop.sync();

  ipad.setValue(lexicalDoc([paragraph("p2", "Hello from iPad")]));
  await ipad.sync();

  await laptop.sync();

  assert.deepEqual(
    server.inspectDocument("doc-1").value.root.children.map((node) => node.key).sort(),
    ["p1", "p2"]
  );
  assert.deepEqual(
    laptop.getValue().root.children.map((node) => node.key).sort(),
    ["p1", "p2"]
  );
});

test("keyed JSON node update is sent as a nested patch", async () => {
  const server = createMemoryAutosaveServer();
  const initial = lexicalDoc([paragraph("p1", "Draft")]);
  server.createDocument({ documentId: "doc-2", value: initial });
  const opened = server.openDocument({ documentId: "doc-2", sessionId: "laptop" });
  const laptop = createAutosaveClient({
    documentId: "doc-2",
    sessionId: "laptop",
    initialValue: opened.value,
    transport: server
  });

  laptop.setValue(lexicalDoc([paragraph("p1", "Published")]));
  await laptop.sync();

  assert.equal(
    server.inspectDocument("doc-2").value.root.children[0].children[0].text,
    "Published"
  );
});

test("delete-most JSON patch is rejected unless confirmed", async () => {
  const server = createMemoryAutosaveServer();
  server.createDocument({
    documentId: "doc-3",
    value: lexicalDoc([paragraph("p1", "Keep this important note")])
  });
  const opened = server.openDocument({ documentId: "doc-3", sessionId: "laptop" });
  const laptop = createAutosaveClient({
    documentId: "doc-3",
    sessionId: "laptop",
    initialValue: opened.value,
    transport: server
  });

  laptop.setValue(lexicalDoc());

  await assert.rejects(() => laptop.sync(), /destructive_patch_requires_confirmation/);
  assert.equal(server.inspectDocument("doc-3").value.root.children.length, 1);
});

test("confirmed delete-most JSON patch can be accepted", async () => {
  const server = createMemoryAutosaveServer();
  server.createDocument({ documentId: "doc-4", value: lexicalDoc([paragraph("p1", "Draft")]) });
  const opened = server.openDocument({ documentId: "doc-4", sessionId: "laptop" });
  const laptop = createAutosaveClient({
    documentId: "doc-4",
    sessionId: "laptop",
    initialValue: opened.value,
    transport: server
  });

  laptop.setValue(lexicalDoc());
  await laptop.sync({ confirmDestructive: true });

  assert.equal(server.inspectDocument("doc-4").value.root.children.length, 0);
});

test("keyed arrays produce non-lossy item-level patches", () => {
  const before = {
    blocks: [{ key: "a", text: "A" }]
  };
  const after = {
    blocks: [
      { key: "a", text: "A" },
      { key: "b", text: "B" }
    ]
  };

  const patch = createJsonPatch(before, after);

  assert.equal(patch.lossy, false);
  assert.equal(patch.ops.some((op) => op.op === "insertItem" && op.key === "b"), true);
  assert.deepEqual(applyJsonPatch(before, patch), after);
});

test("unkeyed arrays are supported but marked lossy", () => {
  const before = {
    tags: ["draft"]
  };
  const after = {
    tags: ["draft", "published"]
  };

  const patch = createJsonPatch(before, after);

  assert.equal(patch.lossy, true);
  assert.equal(patch.ops[0].op, "replace");
  assert.equal(patch.ops[0].lossyReason, "unkeyed_array_replace");
  assert.deepEqual(applyJsonPatch(before, patch), after);
});

test("custom key fields can make arbitrary JSON arrays lossless", async () => {
  const server = createMemoryAutosaveServer({ keyFields: ["uuid"] });
  server.createDocument({
    documentId: "doc-5",
    value: {
      widgets: []
    }
  });

  const laptopOpen = server.openDocument({ documentId: "doc-5", sessionId: "laptop" });
  const ipadOpen = server.openDocument({ documentId: "doc-5", sessionId: "ipad" });

  const laptop = createAutosaveClient({
    documentId: "doc-5",
    sessionId: "laptop",
    initialValue: laptopOpen.value,
    keyFields: ["uuid"],
    transport: server
  });
  const ipad = createAutosaveClient({
    documentId: "doc-5",
    sessionId: "ipad",
    initialValue: ipadOpen.value,
    keyFields: ["uuid"],
    transport: server
  });

  laptop.setValue({ widgets: [{ uuid: "one", label: "Laptop" }] });
  await laptop.sync();

  ipad.setValue({ widgets: [{ uuid: "two", label: "iPad" }] });
  await ipad.sync();

  await laptop.sync();

  assert.deepEqual(
    server.inspectDocument("doc-5").value.widgets.map((widget) => widget.uuid).sort(),
    ["one", "two"]
  );
});

test("strict patch apply rejects stale oldValue while non-strict apply accepts it", () => {
  const before = {
    title: "Original"
  };
  const after = {
    title: "Changed"
  };
  const patch = createJsonPatch(before, after);
  const diverged = {
    title: "Someone else changed this first"
  };

  assert.throws(
    () => applyJsonPatch(diverged, patch, { strict: true }),
    /oldValue does not match/
  );
  assert.deepEqual(applyJsonPatch(diverged, patch), after);
});

test("server keepRevisions can be disabled", async () => {
  const server = createMemoryAutosaveServer({ keepRevisions: false });
  server.createDocument({ documentId: "doc-no-revisions", value: lexicalDoc() });
  const opened = server.openDocument({ documentId: "doc-no-revisions", sessionId: "laptop" });
  const laptop = createAutosaveClient({
    documentId: "doc-no-revisions",
    sessionId: "laptop",
    initialValue: opened.value,
    transport: server
  });

  laptop.setValue(lexicalDoc([paragraph("p1", "No revision history")]));
  await laptop.sync();

  assert.equal(server.inspectDocument("doc-no-revisions").revisions.length, 0);
});

test("server keeps revision history by default", async () => {
  const server = createMemoryAutosaveServer();
  server.createDocument({ documentId: "doc-revisions", value: lexicalDoc() });
  const opened = server.openDocument({ documentId: "doc-revisions", sessionId: "laptop" });
  const laptop = createAutosaveClient({
    documentId: "doc-revisions",
    sessionId: "laptop",
    initialValue: opened.value,
    transport: server
  });

  laptop.setValue(lexicalDoc([paragraph("p1", "Revision history")]));
  await laptop.sync();

  const revisions = server.inspectDocument("doc-revisions").revisions;
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].sessionId, "laptop");
});

test("custom destructiveDeleteRatio can reject smaller keyed removals", async () => {
  const server = createMemoryAutosaveServer({ destructiveDeleteRatio: 0.5 });
  server.createDocument({
    documentId: "doc-strict-destructive",
    value: lexicalDoc([
      paragraph("p1", "One"),
      paragraph("p2", "Two"),
      paragraph("p3", "Three"),
      paragraph("p4", "Four")
    ])
  });
  const opened = server.openDocument({
    documentId: "doc-strict-destructive",
    sessionId: "laptop"
  });
  const laptop = createAutosaveClient({
    documentId: "doc-strict-destructive",
    sessionId: "laptop",
    initialValue: opened.value,
    transport: server
  });

  laptop.setValue(lexicalDoc([paragraph("p1", "One"), paragraph("p2", "Two")]));

  await assert.rejects(() => laptop.sync(), /destructive_patch_requires_confirmation/);
  assert.equal(server.inspectDocument("doc-strict-destructive").value.root.children.length, 4);
});

test("client persister loads saved value, shadow, and versions", async () => {
  const backingStore = new Map();
  const storage = {
    getItem(key) {
      return backingStore.get(key) ?? null;
    },
    setItem(key, value) {
      backingStore.set(key, value);
    },
    removeItem(key) {
      backingStore.delete(key);
    }
  };
  const persister = createLocalStoragePersister("client-state", storage);
  const server = createMemoryAutosaveServer();
  server.createDocument({ documentId: "doc-persist", value: lexicalDoc() });
  const opened = server.openDocument({ documentId: "doc-persist", sessionId: "laptop" });

  const firstClient = createAutosaveClient({
    documentId: "doc-persist",
    sessionId: "laptop",
    initialValue: opened.value,
    transport: server,
    persister
  });
  firstClient.setValue(lexicalDoc([paragraph("p1", "Persisted")]));
  await firstClient.sync();

  const restoredClient = createAutosaveClient({
    documentId: "doc-persist",
    sessionId: "laptop",
    initialValue: lexicalDoc(),
    transport: server,
    persister
  });

  assert.deepEqual(restoredClient.getValue(), lexicalDoc([paragraph("p1", "Persisted")]));
  assert.equal(restoredClient.state.clientVersion, 1);
});

test("server rejects client version mismatches", () => {
  const server = createMemoryAutosaveServer();
  server.createDocument({ documentId: "doc-version", value: lexicalDoc() });
  const opened = server.openDocument({ documentId: "doc-version", sessionId: "laptop" });
  const patch = createJsonPatch(opened.value, opened.value);

  const response = server.sync({
    documentId: "doc-version",
    sessionId: "laptop",
    clientVersion: 99,
    serverVersion: opened.serverVersion,
    shadowHash: hashJson(opened.value),
    patch,
    meta: {}
  });

  assert.equal(response.ok, false);
  assert.equal(response.reason, "client_version_mismatch");
});

test("server rejects shadow hash mismatches", () => {
  const server = createMemoryAutosaveServer();
  server.createDocument({ documentId: "doc-shadow", value: lexicalDoc() });
  const opened = server.openDocument({ documentId: "doc-shadow", sessionId: "laptop" });
  const patch = createJsonPatch(opened.value, opened.value);

  const response = server.sync({
    documentId: "doc-shadow",
    sessionId: "laptop",
    clientVersion: opened.clientVersion,
    serverVersion: opened.serverVersion,
    shadowHash: "not-the-shadow-hash",
    patch,
    meta: {}
  });

  assert.equal(response.ok, false);
  assert.equal(response.reason, "shadow_mismatch");
});

test("createFetchTransport uses the provided fetch implementation", async () => {
  const calls = [];
  const transport = createFetchTransport("https://example.test/sync", async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      async json() {
        return { ok: true, patch: null, clientVersion: 1, serverVersion: 1 };
      }
    };
  });

  const response = await transport.sync({ hello: "world" });

  assert.equal(response.ok, true);
  assert.equal(calls[0].url, "https://example.test/sync");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(JSON.parse(calls[0].init.body).hello, "world");
});

test("large nested keyed JSON patch applies exactly without becoming lossy", () => {
  const before = complexJsonDoc({ sections: 20, blocksPerSection: 8, inlinesPerBlock: 5 });
  const after = clone(before);

  after.metadata.flags.reviewed = true;
  after.sections[3].blocks[2].children[4].text = "Laptop changed a deeply nested text node";
  after.sections[4].blocks.push({
    key: "block-4-new",
    type: "callout",
    attrs: { align: "left", depth: 0 },
    children: [
      {
        key: "text-4-new-0",
        type: "text",
        text: "Inserted block in a large document",
        marks: []
      }
    ],
    comments: []
  });
  after.sections[6].blocks[1].comments[0].resolved = true;
  after.sidebar.widgets[1].enabled = false;

  const moved = after.sections.pop();
  after.sections.splice(2, 0, moved);

  const patch = createJsonPatch(before, after);
  const result = applyJsonPatch(before, patch);

  assert.equal(patch.lossy, false);
  assert.equal(patch.ops.some((op) => op.op === "reorderItems" && op.path[0] === "sections"), true);
  assert.equal(patch.ops.some((op) => op.op === "insertItem" && op.key === "block-4-new"), true);
  assert.deepEqual(result, after);
});

test("large nested JSON with unkeyed array edits is marked lossy but still applies", () => {
  const before = complexJsonDoc({ sections: 10, blocksPerSection: 5, inlinesPerBlock: 3 });
  const after = clone(before);

  after.metadata.tags = ["draft", "internal", "ready-for-review"];
  after.sections[1].blocks[1].children[1].marks = ["italic", "highlight"];

  const patch = createJsonPatch(before, after);
  const result = applyJsonPatch(before, patch);

  assert.equal(patch.lossy, true);
  assert.equal(
    patch.ops.filter((op) => op.lossyReason === "unkeyed_array_replace").length,
    2
  );
  assert.deepEqual(result, after);
});

test("large concurrent keyed edits from laptop and iPad converge on server", async () => {
  const initial = complexJsonDoc({ sections: 16, blocksPerSection: 6, inlinesPerBlock: 4 });
  const server = createMemoryAutosaveServer();
  server.createDocument({ documentId: "doc-large", value: initial });

  const laptopOpen = server.openDocument({ documentId: "doc-large", sessionId: "laptop" });
  const ipadOpen = server.openDocument({ documentId: "doc-large", sessionId: "ipad" });

  const laptop = createAutosaveClient({
    documentId: "doc-large",
    sessionId: "laptop",
    initialValue: laptopOpen.value,
    transport: server
  });
  const ipad = createAutosaveClient({
    documentId: "doc-large",
    sessionId: "ipad",
    initialValue: ipadOpen.value,
    transport: server
  });

  const laptopValue = clone(laptop.getValue());
  laptopValue.sections[2].blocks[4].children[1].text = "Laptop edited section 2";
  laptopValue.sections[2].blocks[4].comments.push({
    id: "comment-laptop-new",
    authorId: "laptop",
    body: "Laptop added a keyed comment",
    resolved: false
  });
  laptop.setValue(laptopValue);
  await laptop.sync();

  const ipadValue = clone(ipad.getValue());
  ipadValue.sections[9].blocks[1].children[3].text = "iPad edited section 9";
  ipadValue.sections[9].blocks.splice(2, 0, {
    key: "block-ipad-new",
    type: "paragraph",
    attrs: { align: "left", depth: 0 },
    children: [
      {
        key: "text-ipad-new-0",
        type: "text",
        text: "iPad inserted a block",
        marks: []
      }
    ],
    comments: []
  });
  ipad.setValue(ipadValue);
  await ipad.sync();

  await laptop.sync();
  await ipad.sync();

  const serverValue = server.inspectDocument("doc-large").value;
  assert.equal(serverValue.sections[2].blocks[4].children[1].text, "Laptop edited section 2");
  assert.equal(serverValue.sections[9].blocks[1].children[3].text, "iPad edited section 9");
  assert.equal(
    serverValue.sections[2].blocks[4].comments.some((comment) => comment.id === "comment-laptop-new"),
    true
  );
  assert.equal(
    serverValue.sections[9].blocks.some((block) => block.key === "block-ipad-new"),
    true
  );
  assert.deepEqual(laptop.getValue(), serverValue);
  assert.deepEqual(ipad.getValue(), serverValue);
});
