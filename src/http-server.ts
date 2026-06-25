/**
 * Exa MCP Server — HTTP transport entry point.
 *
 * Uses Node.js built-in `createServer` plus the MCP SDK's Node-flavoured
 * `StreamableHTTPServerTransport`. The SDK transport's `handleRequest`
 * takes the raw Node `IncomingMessage`/`ServerResponse` (and an optional
 * pre-parsed body) and writes the response itself — including correct
 * Streamable-HTTP SSE framing via @hono/node-server. We do NOT construct
 * Web `Request`/`Response` objects by hand; the transport owns that.
 *
 * Session model (canonical SDK pattern):
 *   - A POST /mcp `initialize` request with no Mcp-Session-Id creates a new
 *     transport + McpServer, stored in `transports` keyed by the generated
 *     session id (returned to the client in the Mcp-Session-Id header).
 *   - Subsequent POST/GET/DELETE /mcp requests carry that header and are
 *     routed to the matching transport.
 *   - On transport close (client DELETE or disconnect) the entry is removed.
 * This isolates concurrent clients, unlike a single shared transport.
 *
 * Health endpoint (`GET /health`) lives on the same port (3000) so a single
 * listening socket serves both /health and /mcp.
 *
 * Environment variables:
 *   EXA_API_KEY          — Required. Exa API key from https://exa.com/
 *   ENABLED_TOOLS        — Comma-separated tool list
 *   MCP_SERVER_PORT      — Port to listen on (default: 3000)
 *   DEBUG                — Set to "true" for verbose logging
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  buildConfigFromEnv,
  initializeMcpServer,
  type McpConfig,
} from "./mcp-handler.js";
import { log } from "./utils/logger.js";

const port = parseInt(process.env.MCP_SERVER_PORT || "3000", 10);
const debug = process.env.DEBUG === "true";

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Accumulate and JSON-parse a request body. Returns undefined if empty. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.length === 0) return undefined;
  return JSON.parse(raw);
}

/** Write a JSON-RPC error response. */
function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Build a fully-configured McpServer instance (one per session). */
function createMcpServer(config: McpConfig): McpServer {
  const server = new McpServer({
    name: "exa-search-server",
    title: "Exa",
    version: "3.2.1",
    websiteUrl: "https://exa.ai",
    icons: [
      {
        src: "https://exa.ai/images/favicon-32x32.png",
        mimeType: "image/png",
        sizes: ["32x32"],
      },
    ],
  });
  initializeMcpServer(server, config);
  return server;
}

/* ── main ────────────────────────────────────────────────────────────── */

export async function main(): Promise<void> {
  const config = buildConfigFromEnv();

  if (!config.exaApiKey) {
    log("ERROR: EXA_API_KEY environment variable is required");
    throw new Error("EXA_API_KEY is required");
  }

  // Active transports keyed by MCP session id.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const baseUrl = `http://localhost:${port}`;
      const url = new URL(req.url || "/", baseUrl);

      // ── Health endpoint ───────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/health") {
        const body = JSON.stringify({
          status: "ok",
          component: "exa-mcp",
          apiConfigured: Boolean(config.exaApiKey),
          sessions: Object.keys(transports).length,
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      // ── MCP endpoint ──────────────────────────────────────────────
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      try {
        // POST: may start a new session (initialize) or continue one.
        if (req.method === "POST") {
          const body = await readJsonBody(req);

          if (debug) {
            log(
              `POST /mcp  session=${sessionId ?? "-"}  initialize=${isInitializeRequest(body)}`,
            );
          }

          let transport: StreamableHTTPServerTransport | undefined = sessionId
            ? transports[sessionId]
            : undefined;

          if (!transport) {
            if (!isInitializeRequest(body)) {
              // No session and not an initialize request → invalid.
              writeJsonRpcError(
                res,
                400,
                -32000,
                "Bad Request: no valid session ID provided",
              );
              return;
            }

            // New session: create transport + server and wire cleanup.
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                transports[sid] = transport!;
                if (debug) log(`Session initialised: ${sid}`);
              },
            });

            transport.onclose = () => {
              const sid = transport!.sessionId;
              if (sid && transports[sid]) {
                delete transports[sid];
                if (debug) log(`Session closed: ${sid}`);
              }
            };

            await createMcpServer(config).connect(transport);
          }

          // The transport reads the (pre-parsed) body and writes the response.
          await transport.handleRequest(req, res, body);
          return;
        }

        // GET (standalone SSE stream) / DELETE (terminate): require a session.
        if (req.method === "GET" || req.method === "DELETE") {
          const transport = sessionId ? transports[sessionId] : undefined;
          if (!transport) {
            writeJsonRpcError(
              res,
              400,
              -32000,
              "Bad Request: invalid or missing session ID",
            );
            return;
          }
          await transport.handleRequest(req, res);
          return;
        }

        // Any other method.
        res.writeHead(405, { Allow: "GET, POST, DELETE" });
        res.end();
      } catch (err) {
        log(`Error handling MCP request: ${err}`);
        log(`Stack: ${err instanceof Error ? err.stack : String(err)}`);
        if (!res.headersSent) {
          writeJsonRpcError(res, 500, -32603, "Internal server error");
        } else {
          res.end();
        }
      }
    },
  );

  server.on("error", (err: Error) => log(`Server error: ${err.message}`));

  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      log(`Exa MCP Server listening on :${port}  (/health + /mcp)`);
      resolve();
    });
  });

  /* ── Graceful shutdown ─────────────────────────────────────────── */
  const shutdown = async (signal: string) => {
    log(`${signal} received, shutting down…`);
    // Close all live MCP sessions first.
    await Promise.allSettled(Object.values(transports).map((t) => t.close()));
    server.close(() => {
      log("HTTP server closed");
      process.exit(0);
    });
    // Safety valve — force exit after 5 s if graceful close hangs.
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// NOTE: `main()` is invoked by the entry point (src/http-server-cli.ts), not
// here. Self-invoking on import would double-run main() — and double-bind the
// listen socket (EADDRINUSE) — when http-server-cli.ts imports this module.
