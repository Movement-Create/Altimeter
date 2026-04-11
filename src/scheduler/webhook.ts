/**
 * Webhook trigger server.
 *
 * Listens on a port for incoming HTTP POST requests that trigger agent runs.
 * This enables event-driven automation from external systems.
 *
 * Endpoint: POST /trigger
 * Body: { prompt: string, session_id?: string }
 * Auth: Bearer token (ALTIMETER_WEBHOOK_SECRET env var)
 *
 * Design (from OpenCode event-driven pattern):
 * - Each webhook call creates a new agent session
 * - Response is streamed as SSE (Server-Sent Events) or returned as JSON
 * - Webhook failures don't crash the server
 * - Rate limiting and concurrency cap protect against abuse
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { AltimeterConfig } from "../core/types.js";
import { sessionManager } from "../core/session.js";
import { runAgent } from "../core/agent-loop.js";

export class WebhookServer {
  private server?: ReturnType<typeof createServer>;
  private config?: AltimeterConfig;
  private port: number;
  private secret: string;

  // Rate limiting
  private requestCounts: Map<string, { count: number; resetAt: number }> = new Map();
  private activeRequests = 0;
  private readonly MAX_REQUESTS_PER_MINUTE = 30;
  private readonly MAX_CONCURRENT_REQUESTS = 5;
  private readonly MAX_BODY_BYTES = 1_048_576; // 1MB

  constructor(port = 7331) {
    this.port = port;
    this.secret = process.env.ALTIMETER_WEBHOOK_SECRET ?? "";
  }

  configure(config: AltimeterConfig): void {
    this.config = config;
  }

  /**
   * Start the webhook server.
   */
  start(): void {
    this.server = createServer(this.handleRequest.bind(this));
    this.server.listen(this.port, () => {
      console.log(`[Webhook] Server listening on port ${this.port}`);
    });
  }

  /**
   * Stop the webhook server.
   */
  stop(): void {
    this.server?.close();
    console.log("[Webhook] Server stopped");
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private checkRateLimit(clientIp: string): boolean {
    const now = Date.now();
    const entry = this.requestCounts.get(clientIp);

    if (!entry || now > entry.resetAt) {
      this.requestCounts.set(clientIp, { count: 1, resetAt: now + 60_000 });
      return true;
    }

    entry.count++;
    return entry.count <= this.MAX_REQUESTS_PER_MINUTE;
  }

  private getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
    return req.socket.remoteAddress ?? "unknown";
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Rate limit check
    const clientIp = this.getClientIp(req);
    if (!this.checkRateLimit(clientIp)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Rate limit exceeded. Max 30 requests/minute." }));
      return;
    }

    // Concurrent request check
    if (this.activeRequests >= this.MAX_CONCURRENT_REQUESTS) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many concurrent requests. Try again shortly." }));
      return;
    }

    // Auth check
    if (this.secret) {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token !== this.secret) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    // Parse body with size limit
    let body: { prompt?: string; session_id?: string };
    try {
      const rawBody = await readBody(req, this.MAX_BODY_BYTES);
      body = JSON.parse(rawBody);
    } catch (e) {
      const message = e instanceof Error && e.message === "Body too large"
        ? "Request body too large"
        : "Invalid JSON body";
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return;
    }

    if (!body.prompt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'prompt' field" }));
      return;
    }

    if (!this.config) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server not configured" }));
      return;
    }

    // Run agent with concurrency tracking
    this.activeRequests++;
    try {
      const session = await sessionManager.createSession(this.config, {
        title: `Webhook: ${body.prompt.slice(0, 50)}`,
        permission_mode: "auto", // Webhooks are headless — must explicitly opt in
      });

      const result = await runAgent({ prompt: body.prompt, session });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          text: result.text,
          turns: result.turns,
          cost_usd: result.cost_usd,
          session_id: session.id,
        })
      );
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    } finally {
      this.activeRequests--;
    }
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export const webhookServer = new WebhookServer();
