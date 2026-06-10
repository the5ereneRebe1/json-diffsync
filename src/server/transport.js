export function createFetchTransport(url, fetchImpl = globalThis.fetch) {
  return {
    async sync(message) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message)
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        return body.ok === false ? body : { ok: false, reason: `http_${response.status}` };
      }
      return response.json();
    }
  };
}

export function createNodeSyncHandler(server) {
  return async function handleSync(request, response) {
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, reason: "method_not_allowed" }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = server.sync(message);

    response.writeHead(result.ok ? 200 : 409, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  };
}
