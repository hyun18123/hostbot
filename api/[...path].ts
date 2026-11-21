import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientRequest } from "node:http";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: { code, message } }));
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const workerUrl = process.env.WORKER_API_URL;
  const proxySecret = process.env.WORKER_PROXY_SECRET;
  if (!workerUrl || !proxySecret) { sendError(res, 503, "api_gateway_not_configured", "API gateway is not configured."); return; }

  let base: URL;
  try {
    base = new URL(workerUrl);
    if (base.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("HTTPS required");
  } catch { sendError(res, 500, "invalid_worker_url", "WORKER_API_URL must be a valid HTTPS URL."); return; }

  const incoming = new URL(req.url ?? "/", "https://vercel.invalid");
  const originalPath = incoming.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  const basePath = base.pathname.replace(/\/$/, "");
  const target = new URL(basePath + originalPath + incoming.search, base.origin);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers.host = target.host;
  headers["x-hostbot-proxy-secret"] = proxySecret;
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-proto"] = "https";

  const transport = target.protocol === "https:" ? https : http;
  let upstream: ClientRequest;
  try {
    upstream = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
      method: req.method, path: target.pathname + target.search, headers,
    }, (upstreamResponse) => {
      const responseHeaders: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
        responseHeaders[name] = value;
      }
      res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(res);
    });
  } catch { sendError(res, 502, "worker_unavailable", "Could not connect to the hosting worker."); return; }

  upstream.setTimeout(55_000, () => upstream.destroy(new Error("Worker request timed out")));
  upstream.on("error", () => sendError(res, 502, "worker_unavailable", "The hosting worker is unavailable."));
  if (req.method === "GET" || req.method === "HEAD") upstream.end();
  else req.pipe(upstream);
}