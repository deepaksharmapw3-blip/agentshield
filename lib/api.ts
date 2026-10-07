/**
 * AgentShield API Client
 * Central utility for all frontend → backend communication.
 * Uses JWT tokens from auth context.
 */

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3002";

function headers(token?: string): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    h["Authorization"] = `Bearer ${token}`;
  }
  return h;
}

async function request<T>(
  path: string,
  token?: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...headers(token), ...(options.headers ?? {}) },
  });

  if (res.status === 401) {
    // Token expired — clear storage and redirect to login
    if (typeof window !== 'undefined') {
      localStorage.removeItem('agentshield_auth')
      window.location.href = '/login'
    }
    throw new Error('Session expired — please login again')
  }

  if (res.status === 403 && path === "/inspect") {
    const inspection = await res.json().catch(() => null)
    if (inspection?.decision === "block") {
      return inspection as T
    }
    throw new Error(inspection?.error ?? "Inspection request was forbidden")
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type Decision = "allow" | "block" | "require_approval";
export type RiskLevel = "safe" | "low" | "medium" | "high" | "critical";
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "timeout"
  | "auto_approved"
  | "auto_blocked";

export interface RiskFinding {
  rule: string;
  reason: string;
  score: number;
}

export interface InspectResponse {
  toolCallId: string;
  decision: Decision;
  riskScore: number;
  riskLevel: RiskLevel;
  riskFindings: RiskFinding[];
  secretsDetected: boolean;
  approvalRequestId?: string;
  message: string;
}

export interface ApprovalRequest {
  id: string;
  toolCall: {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    agentId?: string;
    sessionId?: string;
    timestamp: string;
  };
  inspection: {
    riskScore: number;
    riskLevel: RiskLevel;
    decision: Decision;
    riskFindings: RiskFinding[];
  };
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  rejectionReason?: string;
}

export interface AuditEntry {
  id: string;
  toolCallId: string;
  tool: string;
  agentId?: string;
  riskScore: number;
  riskLevel: RiskLevel;
  decision: Decision;
  approvalStatus: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface AuditStats {
  total: number;
  byDecision: Array<{ decision: string; count: number }>;
  byLevel: Array<{ risk_level: string; count: number }>;
}

export interface ShieldConfig {
  version: string
  risk: { block_threshold: number; review_threshold: number }
  tools: Array<{
    name: string
    risk_score: number
    enabled?: boolean
    description?: string
    require_approval?: boolean
  }>
  secrets: { enabled: boolean; patterns: Array<{ name: string; regex: string }> }
  blocked_patterns: Array<{ name: string; regex: string; reason: string }>
  allowed_domains: { enabled: boolean; list: string[] }
  audit: { enabled: boolean; retention_days: number }
}

// ─── Health ───────────────────────────────────────────────────────────────────

export async function getHealth(): Promise<{ status: string; service: string }> {
  return request("/health");
}

// ─── Inspect ──────────────────────────────────────────────────────────────────

export async function inspectToolCall(
  payload: {
    tool: string;
    args: Record<string, unknown>;
    agentId?: string;
    sessionId?: string;
  },
  token: string
): Promise<InspectResponse> {
  return request("/inspect", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ─── Approvals ────────────────────────────────────────────────────────────────

export async function getApprovals(
  token: string,
  status?: ApprovalStatus,
  limit = 50
): Promise<{ count: number; requests: ApprovalRequest[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set("status", status);
  return request(`/approvals?${params}`, token);
}

export async function approveRequest(
  id: string,
  token: string,
  resolvedBy = "operator"
): Promise<{ message: string; request: ApprovalRequest }> {
  return request(`/approvals/${id}/approve`, token, {
    method: "POST",
    body: JSON.stringify({ resolvedBy }),
  });
}

export async function rejectRequest(
  id: string,
  token: string,
  rejectionReason?: string,
  resolvedBy = "operator"
): Promise<{ message: string; request: ApprovalRequest }> {
  return request(`/approvals/${id}/reject`, token, {
    method: "POST",
    body: JSON.stringify({ resolvedBy, rejectionReason }),
  });
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export async function getAuditLog(
  token: string,
  opts?: {
    tool?: string;
    decision?: string;
    since?: string;
    limit?: number;
    offset?: number;
  }
): Promise<{ count: number; entries: AuditEntry[] }> {
  const params = new URLSearchParams();
  if (opts?.tool) params.set("tool", opts.tool);
  if (opts?.decision) params.set("decision", opts.decision);
  if (opts?.since) params.set("since", opts.since);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return request(`/audit${qs ? `?${qs}` : ""}`, token);
}

export async function getAuditStats(token: string): Promise<AuditStats> {
  return request("/audit/stats", token);
}

// ─── MCP Agent Connections ────────────────────────────────────────────────────

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

export async function getMcpConnections(
  status?: "pending" | "approved" | "rejected"
): Promise<{ count: number; connections: AgentConnection[] }> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const qs = params.toString();
  return request(`/mcp/connections${qs ? `?${qs}` : ""}`);
}

export async function approveMcpConnection(
  id: string,
  resolvedBy = "operator"
): Promise<{ message: string; connection: AgentConnection }> {
  return request(`/mcp/connection/${id}/approve`, undefined, {
    method: "POST",
    body: JSON.stringify({ resolvedBy }),
  });
}

export async function rejectMcpConnection(
  id: string,
  resolvedBy = "operator"
): Promise<{ message: string; connection: AgentConnection }> {
  return request(`/mcp/connection/${id}/reject`, undefined, {
    method: "POST",
    body: JSON.stringify({ resolvedBy }),
  });
export async function getShieldConfig(token: string): Promise<ShieldConfig> {
  return request("/config", token)
}

export async function updateShieldConfig(
  token: string,
  config: ShieldConfig
): Promise<ShieldConfig> {
  const response = await request<{ config: ShieldConfig }>("/config", token, {
    method: "POST",
    body: JSON.stringify(config),
  })
  return response.config
}
