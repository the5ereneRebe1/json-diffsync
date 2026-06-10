import { useDifferentialAutosave } from "json-diffsync/react";
import { createFetchTransport } from "json-diffsync/server";

const transport = createFetchTransport("/sync");

const emptyLexicalState = {
  root: {
    type: "root",
    key: "root",
    children: []
  }
};

export function App({ documentId, sessionId }) {
  const autosave = useDifferentialAutosave({
    documentId,
    sessionId,
    initialValue: emptyLexicalState,
    transport,
    intervalMs: 1500
  });

  const plainText = autosave.value.root.children
    .flatMap((node) => node.children ?? [])
    .map((node) => node.text ?? "")
    .join("\n");

  function setPlainText(text) {
    autosave.setValue({
      root: {
        type: "root",
        key: "root",
        children: [
          {
            type: "paragraph",
            key: "p1",
            children: [{ type: "text", key: "p1:text", text }]
          }
        ]
      }
    });
  }

  return (
    <main>
      <textarea
        value={plainText}
        onChange={(event) => setPlainText(event.target.value)}
        rows={20}
      />
      <button onClick={() => autosave.sync()}>Save now</button>
      <span>{autosave.status}</span>
    </main>
  );
}
