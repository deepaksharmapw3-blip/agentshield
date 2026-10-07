/**
 * AgentShield MCP Proxy Server
 *
 * Exposes a set of tools (read_file, write_file, execute_command, web_fetch,
 * list_directory, delete_file) over the Model Context Protocol (MCP v2,
 * 2026-07-28 spec) via NodeStreamableHTTPServerTransport.
 *
 * Every tool call is routed through AgentShield's inspect() pipeline before
 * the underlying operation executes.  The flow is:
 *
 *   Agent calls tool
 *     → inspect()       ← risk score, secret scan, blocked patterns
 *       → BLOCK         → return error content to agent (never executes)
 *       → REQUIRE_APPROVAL → poll DB every 2 s for up to 5 min
 *           → approved  → execute, return result
 *           → rejected / timeout → return error content
 *       → ALLOW         → execute, return result
 *
 * Mount this at /mcp in app.ts.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isInitializeRequest } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Router, Request, Response } from "express";
import * as z from "zod/v4";

import { inspect } from "./interceptor";
import { getApprovalRequest } from "./approvalGate";
import { logger } from "./logger";

const execAsync = promisify(exec);
const CTX = "MCPProxy";

// ─── Session store ────────────────────────────────────────────────────────────
interface Session {
  transport: NodeStreamableHTTPServerTransport;
  open: number;
  lastActive: number;
}
const sessions = new Map<string, Session>();
const IDLE_MS = 30 * 60_000;   // 30 min idle timeout
const MAX_SESSIONS = 200;

// ─── Approval poller ──────────────────────────────────────────────────────────
/**
 * Waits for a human-in-the-loop approval decision.
 * Returns the final status once it leaves "pending".
 */
async function waitForApproval(
  approvalId: string,
  timeoutMs = 5 * 60_000
): Promise<"approved" | "rejected" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 2_000;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, POLL_MS));
    const req = await getApprovalRequest(approvalId);
    if (!req) return "timeout";
    if (req.status === "approved" || req.status === "auto_approved") return "approved";
    if (req.status === "rejected" || req.status === "auto_blocked" || req.status === "timeout") {
      return req.status === "timeout" ? "timeout" : "rejected";
    }
    // still "pending" — keep polling
  }
  return "timeout";
}

// ─── Intercept wrapper ─────────────────────────────────────────────────────────
/**
 * Calls inspect(), handles block/approval, then runs the executor.
 * Returns a text content block ready for MCP.
 */
async function interceptAndRun(
  tool: string,
  args: Record<string, unknown>,
  agentId: string | undefined,
  executor: () => Promise<string>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {

  let inspection;
  try {
    inspection = await inspect({ tool, args, agentId });
  } catch (err) {
    logger.error(CTX, `inspect() threw for tool "${tool}"`, err);
    return {
      content: [{ type: "text", text: `AgentShield internal error: ${String(err)}` }],
      isError: true,
    };
  }

  // ── BLOCKED ───────────────────────────────────────────────────────────────
  if (inspection.decision === "block") {
    logger.warn(CTX, `🚫 BLOCKED ${tool} (score=${inspection.riskScore})`);
    return {
      content: [{
        type: "text",
        text: [
          `🚫 AgentShield BLOCKED this action.`,
          `Tool: ${tool}`,
          `Risk score: ${inspection.riskScore}/100`,
          `Reason: ${inspection.message}`,
          inspection.riskFindings.length
            ? `Findings:\n${inspection.riskFindings.map(f => `  • ${f.reason}`).join("\n")}`
            : "",
        ].filter(Boolean).join("\n"),
      }],
      isError: true,
    };
  }

  // ── REQUIRES APPROVAL ─────────────────────────────────────────────────────
  if (inspection.decision === "require_approval") {
    logger.info(CTX, `⏳ PENDING approval for ${tool} (id=${inspection.approvalRequestId})`);

    if (!inspection.approvalRequestId) {
      return {
        content: [{ type: "text", text: "AgentShield error: approval request ID missing" }],
        isError: true,
      };
    }

    const outcome = await waitForApproval(inspection.approvalRequestId);

    if (outcome === "approved") {
      logger.info(CTX, `✅ APPROVED ${tool} — executing`);
      // fall through to execution below
    } else {
      const reason = outcome === "timeout" ? "Approval timed out (5 min)" : "Rejected by operator";
      logger.warn(CTX, `❌ ${outcome.toUpperCase()} ${tool}: ${reason}`);
      return {
        content: [{
          type: "text",
          text: [
            `❌ AgentShield ${outcome === "timeout" ? "TIMEOUT" : "REJECTED"} this action.`,
            `Tool: ${tool}`,
            `Risk score: ${inspection.riskScore}/100`,
            reason,
          ].join("\n"),
        }],
        isError: true,
      };
    }
  }

  // ── ALLOWED (or just approved) — execute ──────────────────────────────────
  try {
    const result = await executor();
    logger.info(CTX, `✅ EXECUTED ${tool}`);
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(CTX, `Execution error for ${tool}: ${msg}`);
    return {
      content: [{ type: "text", text: `Execution error: ${msg}` }],
      isError: true,
    };
  }
}

// ─── MCP Server factory ───────────────────────────────────────────────────────
/**
 * Called once per MCP session.  Each session gets its own McpServer instance
 * with the same tool registrations, so context (agentId etc.) can vary per
 * session without leaking across connections.
 */
function buildMcpServer(agentId?: string): McpServer {
  const server = new McpServer({
    name: "AgentShield",
    version: "1.0.0",
  });

  // ── read_file ──────────────────────────────────────────────────────────────
  server.registerTool(
    "read_file",
    {
      description: "Read the text content of a file. AgentShield inspects this call before execution.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or relative path to the file"),
      }),
    },
    async ({ path }) => {
      return interceptAndRun("read_file", { path }, agentId, async () => {
        const content = await fs.readFile(path, "utf-8");
        return content;
      });
    }
  );

  // ── write_file ─────────────────────────────────────────────────────────────
  server.registerTool(
    "write_file",
    {
      description: "Write text content to a file (creates or overwrites). AgentShield inspects this call.",
      inputSchema: z.object({
        path: z.string().describe("Path to write"),
        content: z.string().describe("Text content to write"),
      }),
    },
    async ({ path, content }) => {
      return interceptAndRun("write_file", { path, content }, agentId, async () => {
        await fs.writeFile(path, content, "utf-8");
        return `File written successfully: ${path}`;
      });
    }
  );

  // ── execute_command ────────────────────────────────────────────────────────
  server.registerTool(
    "execute_command",
    {
      description: "Execute a shell command. High risk — AgentShield will inspect and may require approval.",
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        cwd: z.string().optional().describe("Working directory (optional)"),
      }),
    },
    async ({ command, cwd }) => {
      return interceptAndRun("execute_command", { command, cwd }, agentId, async () => {
        const { stdout, stderr } = await execAsync(command, {
          cwd: cwd ?? process.cwd(),
          timeout: 30_000,
        });
        const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n---stderr---\n");
        return out || "(no output)";
      });
    }
  );

  // ── web_fetch ──────────────────────────────────────────────────────────────
  server.registerTool(
    "web_fetch",
    {
      description: "Fetch the content of a URL. AgentShield inspects this call.",
      inputSchema: z.object({
        url: z.string().url().describe("URL to fetch"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
        body: z.string().optional().describe("Request body (for POST/PUT)"),
      }),
    },
    async ({ url, method, body }) => {
      return interceptAndRun("web_fetch", { url, method, body }, agentId, async () => {
        const res = await fetch(url, {
          method: method ?? "GET",
          body: body ?? undefined,
          headers: { "User-Agent": "AgentShield-MCP/1.0" },
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        // Truncate very large responses
        const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n\n[truncated]" : text;
        return `HTTP ${res.status}\n\n${truncated}`;
      });
    }
  );

  // ── list_directory ────────────────────────────────────────────────────────
  server.registerTool(
    "list_directory",
    {
      description: "List files and directories at a given path.",
      inputSchema: z.object({
        path: z.string().describe("Directory path to list"),
      }),
    },
    async ({ path }) => {
      return interceptAndRun("list_directory", { path }, agentId, async () => {
        const entries = await fs.readdir(path, { withFileTypes: true });
        const lines = entries.map(e => `${e.isDirectory() ? "DIR " : "FILE"} ${e.name}`);
        return lines.join("\n") || "(empty directory)";
      });
    }
  );

  // ── delete_file ────────────────────────────────────────────────────────────
  server.registerTool(
    "delete_file",
    {
      description: "Delete a file. HIGH RISK — AgentShield will require human approval.",
      inputSchema: z.object({
        path: z.string().describe("Path of the file to delete"),
      }),
    },
    async ({ path }) => {
      return interceptAndRun("delete_file", { path }, agentId, async () => {
        await fs.unlink(path);
        return `Deleted: ${path}`;
      });
    }
  );

  return server;
}

// ─── Express Router ───────────────────────────────────────────────────────────
/**
 * Mount with:  app.use("/mcp", buildMcpRouter())
 *
 * Handles POST /mcp, GET /mcp, DELETE /mcp per the Streamable HTTP spec.
 * Sessions are tracked in the local `sessions` Map.
 */
export function buildMcpRouter(): Router {
  const router = Router();

  // Idle session cleanup — run every minute
  setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, s] of sessions.entries()) {
      if (s.open === 0 && s.lastActive < cutoff) {
        s.transport.close().catch(() => {/* ignore */});
        sessions.delete(id);
        logger.info(CTX, `Closed idle session ${id}`);
      }
    }
  }, 60_000).unref();

  async function handleMcp(req: Request, res: Response) {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    // ── Route to existing session ─────────────────────────────────────────
    if (existing) {
      if (res.socket && !res.destroyed) {
        existing.open++;
        res.on("close", () => {
          existing.open--;
          existing.lastActive = Date.now();
        });
      }
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    // ── New session — only allow on initialize ────────────────────────────
    if (!sessionId && isInitializeRequest(req.body)) {
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Too many open sessions" },
          id: null,
        });
        return;
      }

      // Extract agentId from initialization metadata if provided
      const agentId: string | undefined =
        (req.body as { params?: { _meta?: { agentId?: string } } })
          ?.params?._meta?.agentId;

      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, open: 0, lastActive: Date.now() });
          logger.info(CTX, `MCP session initialized: ${id} agent=${agentId ?? "unknown"}`);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          logger.info(CTX, `MCP session closed: ${transport.sessionId}`);
        }
      };

      const server = buildMcpServer(agentId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // ── Unknown session ID ────────────────────────────────────────────────
    if (sessionId) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found — start a new session" },
        id: null,
      });
      return;
    }

    // ── Non-initialize request without session header ─────────────────────
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: send initialize first" },
      id: null,
    });
  }

  router.post("/", handleMcp);
  router.get("/",  handleMcp);
  router.delete("/", handleMcp);

  return router;
}
