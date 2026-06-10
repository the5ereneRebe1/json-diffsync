import { performance } from "node:perf_hooks";
import {
  applyJsonPatch,
  createAutosaveClient,
  createJsonPatch,
  stableStringify
} from "../src/index.js";
import { createMemoryAutosaveServer } from "../src/server.js";

const scenarios = [
  { name: "small", sections: 8, blocks: 4, inlines: 3, edits: 6 },
  { name: "medium", sections: 30, blocks: 8, inlines: 5, edits: 24 },
  { name: "large", sections: 80, blocks: 10, inlines: 6, edits: 60 },
  { name: "xlarge", sections: 150, blocks: 12, inlines: 8, edits: 120 }
];

console.log("json-diffsync benchmark");
console.log(`Node ${process.version}`);
console.log("");

const rows = [];
for (const scenario of scenarios) {
  rows.push(await runScenario(scenario));
}

console.table(rows);

async function runScenario(scenario) {
  const before = createFixture(scenario);
  const after = mutateFixture(before, scenario);

  const beforeBytes = byteLength(before);
  const afterBytes = byteLength(after);

  const diffResult = measure(() => createJsonPatch(before, after));
  const patch = diffResult.value;
  const patchBytes = byteLength(patch);

  const applyResult = measure(() => applyJsonPatch(before, patch));
  assertJsonEqual(applyResult.value, after, `${scenario.name} apply result`);

  const server = createMemoryAutosaveServer({ keepRevisions: false });
  server.createDocument({ documentId: scenario.name, value: before });
  const opened = server.openDocument({
    documentId: scenario.name,
    sessionId: "laptop"
  });
  const client = createAutosaveClient({
    documentId: scenario.name,
    sessionId: "laptop",
    initialValue: opened.value,
    transport: server
  });
  client.setValue(after);

  const syncResult = await measureAsync(() => client.sync());
  assertJsonEqual(server.inspectDocument(scenario.name).value, after, `${scenario.name} sync result`);

  return {
    scenario: scenario.name,
    jsonKB: round(beforeBytes / 1024, 1),
    patchKB: round(patchBytes / 1024, 1),
    patchPct: `${round((patchBytes / afterBytes) * 100, 1)}%`,
    ops: patch.ops.length,
    lossy: patch.lossy,
    diffMs: round(diffResult.ms, 2),
    applyMs: round(applyResult.ms, 2),
    syncMs: round(syncResult.ms, 2)
  };
}

function createFixture({ sections, blocks, inlines }) {
  return {
    schemaVersion: 1,
    metadata: {
      title: "Benchmark document",
      tags: [
        { id: "draft", value: "draft" },
        { id: "internal", value: "internal" }
      ],
      counters: {
        views: 0,
        saves: 0
      }
    },
    sections: Array.from({ length: sections }, (_, sectionIndex) => ({
      key: `section-${sectionIndex}`,
      type: "section",
      attrs: {
        order: sectionIndex,
        collapsed: false,
        color: sectionIndex % 3 === 0 ? "blue" : "default"
      },
      blocks: Array.from({ length: blocks }, (_, blockIndex) => ({
        key: `block-${sectionIndex}-${blockIndex}`,
        type: blockIndex % 4 === 0 ? "heading" : "paragraph",
        attrs: {
          depth: blockIndex % 4,
          align: "left"
        },
        children: Array.from({ length: inlines }, (_, inlineIndex) => ({
          key: `text-${sectionIndex}-${blockIndex}-${inlineIndex}`,
          type: "text",
          text: `Section ${sectionIndex}, block ${blockIndex}, inline ${inlineIndex}`,
          marks: [
            { id: `mark-${inlineIndex}-bold`, type: inlineIndex % 2 === 0 ? "bold" : "plain" }
          ]
        })),
        comments: [
          {
            id: `comment-${sectionIndex}-${blockIndex}`,
            authorId: `user-${blockIndex % 5}`,
            body: `Comment ${sectionIndex}.${blockIndex}`,
            resolved: false
          }
        ]
      }))
    })),
    sidebar: {
      widgets: [
        { id: "toc", type: "table-of-contents", enabled: true },
        { id: "outline", type: "outline", enabled: true },
        { id: "stats", type: "stats", enabled: false }
      ]
    }
  };
}

function mutateFixture(value, { sections, blocks, inlines, edits }) {
  const next = clone(value);

  next.metadata.counters.saves += 1;
  next.sidebar.widgets[2].enabled = true;

  for (let edit = 0; edit < edits; edit += 1) {
    const sectionIndex = (edit * 7) % sections;
    const blockIndex = (edit * 5) % blocks;
    const inlineIndex = (edit * 3) % inlines;
    const block = next.sections[sectionIndex].blocks[blockIndex];

    block.children[inlineIndex].text = `Edited ${edit} at ${sectionIndex}/${blockIndex}/${inlineIndex}`;
    block.children[inlineIndex].marks.push({
      id: `mark-edited-${edit}`,
      type: "highlight"
    });

    if (edit % 8 === 0) {
      block.comments.push({
        id: `comment-new-${edit}`,
        authorId: "bench",
        body: `New comment ${edit}`,
        resolved: false
      });
    }
  }

  for (let sectionIndex = 0; sectionIndex < sections; sectionIndex += 10) {
    next.sections[sectionIndex].blocks.push({
      key: `block-${sectionIndex}-inserted`,
      type: "callout",
      attrs: { depth: 0, align: "left" },
      children: [
        {
          key: `text-${sectionIndex}-inserted-0`,
          type: "text",
          text: `Inserted block in section ${sectionIndex}`,
          marks: []
        }
      ],
      comments: []
    });
  }

  const moved = next.sections.pop();
  next.sections.splice(1, 0, moved);

  return next;
}

function measure(fn) {
  const start = performance.now();
  const value = fn();
  return {
    value,
    ms: performance.now() - start
  };
}

async function measureAsync(fn) {
  const start = performance.now();
  const value = await fn();
  return {
    value,
    ms: performance.now() - start
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function byteLength(value) {
  return Buffer.byteLength(stableStringify(value));
}

function assertJsonEqual(actual, expected, label) {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`${label} did not match expected JSON.`);
  }
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
