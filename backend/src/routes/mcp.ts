/**
 * AgentShield MCP Server Route
 *
 * Implements the Model Context Protocol (MCP) over HTTP+SSE so any AI agent
 * can connect and request permission to use tools.  The flow is:
 *
 *   1. Agent calls POST /mcp/connect  → gets a connectionId + pending status
 *   2. Dashboard receives the request via SSE  GET /mcp/events
 *   3. Operator clicks Approve / Reject in the UI
 *   4. Agent polls GET /mcp/connection/:id  to discover the decision
 *   5. Once approved, agent calls POST /inspect as usual for every tool call
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../logger";

const router = Router();
const CTX = "MCP";

// ─── In-memory store for pending connections ──────────────────────────────────
export interface AgentConnection {
  id: string;
  agentName: string;
  agentType: string;
  mcpServer: string;
  requestedTools: string[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

const connections = new Map<string, AgentConnection>();

// ─── SSE subscriber list ──────────────────────────────────────────────────────
type SseClient = Response;
const sseClients = new Set<SseClient>();

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ─── SSE endpoint — dashboard subscribes here ─────────────────────────────────
// GET /mcp/events
router.get("/events", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send all currently-pending connections so the UI can catch up on load
  const pending = [...connections.values()].filter((c) => c.status === "pending");
  res.write(`event: snapshot\ndata: ${JSON.stringify(pending)}\n\n`);

  sseClients.add(res);
  logger.info(CTX, `SSE client connected (total=${sseClients.size})`);

  // Heartbeat every 25 s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    logger.info(CTX, `SSE client disconnected (total=${sseClients.size})`);
  });
});

// ─── Agent connects — POST /mcp/connect ──────────────────────────────────────
router.post("/connect", (req: Request, res: Response) => {
  const { agentName, agentType, mcpServer, requestedTools } = req.body as {
    agentName?: string;
    agentType?: string;
    mcpServer?: string;
    requestedTools?: string[];
  };

  if (!agentName || typeof agentName !== "string") {
    res.status(400).json({ error: '"agentName" (string) is required' });
    return;
  }

  const connection: AgentConnection = {
    id: uuidv4(),
    agentName,
    agentType: agentType ?? "AI Coding Agent",
    mcpServer: mcpServer ?? "AgentShield",
    requestedTools: Array.isArray(requestedTools)
      ? requestedTools
      : ["read_file", "write_file", "execute_command"],
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  connections.set(connection.id, connection);
  logger.info(CTX, `New agent connection request: ${agentName} (id=${connection.id})`);

  // Push to all dashboard SSE subscribers
  broadcast("connection_request", connection);

  res.status(202).json({
    connectionId: connection.id,
    status: "pending",
    message: "Connection request submitted — awaiting operator approval",
  });
});

// ─── Poll connection status — GET /mcp/connection/:id ────────────────────────
router.get("/connection/:id", (req: Request, res: Response) => {
  const conn = connections.get(req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  res.json(conn);
});

// ─── List all connections — GET /mcp/connections ─────────────────────────────
router.get("/connections", (req: Request, res: Response) => {
  const { status } = req.query;
  let list = [...connections.values()];
  if (status && typeof status === "string") {
    list = list.filter((c) => c.status === status);
  }
  // Most recent first
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ count: list.length, connections: list });
});

// ─── Approve — POST /mcp/connection/:id/approve ──────────────────────────────
router.post("/connection/:id/approve", (req: Request, res: Response) => {
  const conn = connections.get(req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  if (conn.status !== "pending") {
    res.status(409).json({ error: `Connection already ${conn.status}` });
    return;
  }

  conn.status = "approved";
  conn.resolvedAt = new Date().toISOString();
  conn.resolvedBy = (req.body as { resolvedBy?: string }).resolvedBy ?? "operator";

  logger.info(CTX, `Connection approved: ${conn.agentName} (id=${conn.id})`);
  broadcast("connection_resolved", conn);

  res.json({ message: "Connection approved", connection: conn });
});

// ─── Reject — POST /mcp/connection/:id/reject ────────────────────────────────
router.post("/connection/:id/reject", (req: Request, res: Response) => {
  const conn = connections.get(req.params.id);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  if (conn.status !== "pending") {
    res.status(409).json({ error: `Connection already ${conn.status}` });
    return;
  }

  conn.status = "rejected";
  conn.resolvedAt = new Date().toISOString();
  conn.resolvedBy = (req.body as { resolvedBy?: string }).resolvedBy ?? "operator";

  logger.info(CTX, `Connection rejected: ${conn.agentName} (id=${conn.id})`);
  broadcast("connection_resolved", conn);

  res.json({ message: "Connection rejected", connection: conn });
});

export default router;
