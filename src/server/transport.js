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

export function createNodeSyncHandler(server, options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? 16 * 1024 * 1024;

  return async function handleSync(request, response) {
    function respond(status, body) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    }

    if (request.method !== "POST") {
      return respond(405, { ok: false, reason: "method_not_allowed" });
    }

    try {
      const chunks = [];
      let received = 0;
      for await (const chunk of request) {
        received += chunk.length;
        if (received > maxBodyBytes) {
          respond(413, { ok: false, reason: "payload_too_large" });
          request.destroy();
          return;
        }
        chunks.push(chunk);
      }

      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return respond(400, { ok: false, reason: "invalid_json" });
      }
      if (
        !message ||
        typeof message !== "object" ||
        typeof message.documentId !== "string" ||
        typeof message.sessionId !== "string" ||
        !message.patch ||
        !Array.isArray(message.patch.ops)
      ) {
        return respond(400, { ok: false, reason: "invalid_message" });
      }

      const result = server.sync(message);
      const status = result.ok ? 200 : result.reason === "unknown_document" ? 404 : 409;
      respond(status, result);
    } catch (error) {
      if (!response.headersSent) {
        respond(500, { ok: false, reason: "server_error", detail: error.message });
      } else {
        response.end();
      }
    }
  };
}
