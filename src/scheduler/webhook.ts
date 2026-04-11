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

    // Parse body
    let body: { prompt?: string; session_id?: string };
    try {
      const rawBody = await readBody(req);
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
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

    // Run agent
    try {
      const session = await sessionManager.createSession(this.config, {
        title: `Webhook: ${body.prompt.slice(0, 50)}`,
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
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export const webhookServer = new WebhookServer();
