import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import {
  createAutosaveClient,
  createLocalStoragePersister
} from "../../../src/index.js";
import { createFetchTransport } from "../../../src/server.js";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const apiUrl = params.get("api");
const documentId = params.get("documentId") ?? "browser-doc";
const sessionId = params.get("sessionId") ?? crypto.randomUUID();

function emptyDocument() {
  return {
    root: {
      type: "root",
      key: "root",
      children: []
    }
  };
}

function upsertSessionFragment(value, fragment) {
  const next = structuredClone(value ?? emptyDocument());
  const children = next.root.children;
  const index = children.findIndex((node) => node.key === fragment.key);
  if (index >= 0) children[index] = fragment;
  else children.push(fragment);
  return next;
}

function combinedText(value) {
  return (value?.root?.children ?? [])
    .map((node) => node.plainText)
    .filter(Boolean)
    .join("\n");
}

function LexicalSyncBridge({ client, onValue, suppressRef }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    window.__applySyncedValueToEditor = (value) => {
      const text = combinedText(value);
      suppressRef.current = true;
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        for (const line of text.split("\n").filter(Boolean)) {
          const paragraph = $createParagraphNode();
          paragraph.append($createTextNode(line));
          root.append(paragraph);
        }
      });
      queueMicrotask(() => {
        suppressRef.current = false;
      });
    };
  }, [editor, suppressRef]);

  return (
    <OnChangePlugin
      ignoreSelectionChange
      onChange={(editorState) => {
        if (suppressRef.current) return;
        let plainText = "";
        editorState.read(() => {
          plainText = $getRoot().getTextContent();
        });
        const currentValue = client.getValue() ?? emptyDocument();
        const fragment = {
          type: "lexical-fragment",
          key: sessionId,
          sessionId,
          plainText,
          lexical: editorState.toJSON()
        };
        const nextValue = upsertSessionFragment(currentValue, fragment);
        client.setValue(nextValue);
        onValue(nextValue);
      }}
    />
  );
}

function App() {
  const [client, setClient] = useState(null);
  const [value, setValue] = useState(emptyDocument());
  const [status, setStatus] = useState("opening");
  const suppressRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function open() {
      const response = await fetch(
        `${apiUrl}/open?documentId=${encodeURIComponent(documentId)}&sessionId=${encodeURIComponent(sessionId)}`
      );
      const opened = await response.json();
      const syncClient = createAutosaveClient({
        documentId,
        sessionId,
        initialValue: opened.value,
        clientVersion: opened.clientVersion,
        serverVersion: opened.serverVersion,
        transport: createFetchTransport(`${apiUrl}/sync`),
        persister: createLocalStoragePersister(`driftsync-browser:${documentId}:${sessionId}`)
      });

      if (cancelled) return;
      setClient(syncClient);
      setValue(syncClient.getValue());
      setStatus("idle");
      window.__driftsync = {
        client: syncClient,
        getValue: () => syncClient.getValue()
      };
    }

    open().catch((error) => {
      setStatus(`error:${error.message}`);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const initialConfig = useMemo(() => ({
    namespace: `driftsync-${sessionId}`,
    onError(error) {
      throw error;
    },
    theme: {
      paragraph: "editor-paragraph"
    }
  }), []);

  async function syncNow() {
    if (!client) return;
    setStatus("syncing");
    try {
      await client.sync();
      const nextValue = client.getValue();
      setValue(nextValue);
      window.__applySyncedValueToEditor?.(nextValue);
      setStatus("idle");
    } catch (error) {
      setStatus(`error:${error.message}`);
    }
  }

  useEffect(() => {
    if (!client) return undefined;
    const timer = setInterval(syncNow, 400);
    return () => clearInterval(timer);
  }, [client]);

  return (
    <main>
      <header>
        <strong>{sessionId}</strong>
        <span data-testid="status">{status}</span>
        <button data-testid="sync-now" onClick={syncNow}>Save now</button>
      </header>

      <LexicalComposer initialConfig={initialConfig}>
        <PlainTextPlugin
          contentEditable={<ContentEditable className="editor-input" data-testid="editor" />}
          placeholder={<div className="placeholder">Type here</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
        {client ? (
          <LexicalSyncBridge client={client} onValue={setValue} suppressRef={suppressRef} />
        ) : null}
      </LexicalComposer>

      <section>
        <h2>Synced JSON Preview</h2>
        <pre data-testid="synced-text">{combinedText(value)}</pre>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
