import { v4 as uuidv4 } from "uuid";
import { getDb } from "./auditLogger";
import { logger } from "./logger";
import type {
  Workflow,
  WorkflowStep,
  WorkflowRun,
  CreateWorkflowInput,
  UpdateWorkflowInput,
} from "./workflowTypes";

const CTX = "WorkflowStorage";

const DEFAULT_WORKFLOWS: Array<Omit<Workflow, "id" | "createdAt" | "updatedAt" | "version">> = [
  {
    name: "GitHub Pull Request Security Gate",
    description: "Multi-layered inspection of code reviews, pull request diffs, and developer agent actions prior to merge.",
    trigger: "pull_request",
    enabled: true,
    steps: [
      {
        id: "step-pr-1",
        name: "Secret & Credential Scanner",
        type: "secret_detection",
        enabled: true,
        description: "Scans changed files, diffs, and arguments for AWS keys, API tokens, and private credentials.",
        config: {
          actionOnFailure: "block",
          strict: true,
        },
      },
      {
        id: "step-pr-2",
        name: "Prompt Injection & Jailbreak Guard",
        type: "prompt_injection_scan",
        enabled: true,
        description: "Scans PR comments and agent instructions for adversarial prompts and hidden override commands.",
        config: {
          actionOnFailure: "block",
          threshold: 50,
        },
      },
      {
        id: "step-pr-3",
        name: "Code Security Policy Verification",
        type: "code_policy_check",
        enabled: true,
        description: "Detects dangerous shell executions (rm -rf, curl | bash), unauthorized file system mutations, and SQL drops.",
        config: {
          actionOnFailure: "block",
          strict: true,
        },
      },
      {
        id: "step-pr-4",
        name: "Human Approver Sign-off Gate",
        type: "human_approval_gate",
        enabled: true,
        description: "Requires explicit operator or security lead approval if any medium or high risk signals are detected.",
        config: {
          actionOnFailure: "require_approval",
          threshold: 45,
          timeoutMs: 300000,
        },
      },
    ],
  },
  {
    name: "Production Agent Tool Execution Pipeline",
    description: "Live interceptor pipeline enforcing least privilege and automated DLP redaction on tool invocations.",
    trigger: "tool_call",
    enabled: true,
    steps: [
      {
        id: "step-tool-1",
        name: "Tool Scope & Permission Check",
        type: "tool_permission_check",
        enabled: true,
        description: "Validates tool name against authorized agent capability catalog and blocked command sets.",
        config: {
          actionOnFailure: "block",
          blockedTools: ["format_drive", "drop_production_db", "bypass_firewall"],
        },
      },
      {
        id: "step-tool-2",
        name: "DLP & Argument Sanitization",
        type: "dlp_data_masking",
        enabled: true,
        description: "Redacts PII, emails, authentication tokens, and credit card numbers from tool arguments.",
        config: {
          actionOnFailure: "continue",
          strict: true,
        },
      },
      {
        id: "step-tool-3",
        name: "Dynamic Multi-Model Risk Scoring",
        type: "risk_assessment",
        enabled: true,
        description: "Computes composite deterministic and AI risk score against safety thresholds.",
        config: {
          threshold: 60,
          actionOnFailure: "require_approval",
        },
      },
      {
        id: "step-tool-4",
        name: "Human Approval Enforcement",
        type: "human_approval_gate",
        enabled: true,
        description: "Halts execution and opens ticket in approval queue when risk exceeds review threshold.",
        config: {
          actionOnFailure: "require_approval",
          threshold: 50,
          timeoutMs: 600000,
        },
      },
    ],
  },
  {
    name: "Data Exfiltration & Privacy DLP Guardrail",
    description: "Prevents autonomous agents from exfiltrating sensitive customer information and internal tokens to external endpoints.",
    trigger: "agent_execution",
    enabled: true,
    steps: [
      {
        id: "step-dlp-1",
        name: "Deep Secret & Token Detection",
        type: "secret_detection",
        enabled: true,
        description: "Examines payload buffers for RSA keys, JWT tokens, and connection strings.",
        config: {
          actionOnFailure: "block",
          strict: true,
        },
      },
      {
        id: "step-dlp-2",
        name: "DLP Masking & Data Redaction",
        type: "dlp_data_masking",
        enabled: true,
        description: "Masks emails, phone numbers, and IP addresses before downstream handling.",
        config: {
          actionOnFailure: "continue",
        },
      },
      {
        id: "step-dlp-3",
        name: "Security Audit Notification Webhook",
        type: "webhook_dispatch",
        enabled: true,
        description: "Dispatches compliance event to SIEM / security webhook endpoint.",
        config: {
          actionOnFailure: "warn",
          webhookUrl: "https://audit.agentshield.internal/v1/telemetry",
        },
      },
    ],
  },
  {
    name: "Adversarial Prompt & Jailbreak Defense",
    description: "Evaluates conversational inputs and tool instructions to stop indirect prompt injection attacks.",
    trigger: "prompt_submission",
    enabled: true,
    steps: [
      {
        id: "step-inj-1",
        name: "Prompt Injection & Delimiter Scan",
        type: "prompt_injection_scan",
        enabled: true,
        description: "Inspects text for hidden system prompt overrides, delimiter attacks, and roleplay escape phrases.",
        config: {
          actionOnFailure: "block",
          threshold: 40,
        },
      },
      {
        id: "step-inj-2",
        name: "Tool Permission Gate",
        type: "tool_permission_check",
        enabled: true,
        description: "Blocks high-privilege tool invocations when prompt origin is untrusted.",
        config: {
          actionOnFailure: "require_approval",
        },
      },
      {
        id: "step-inj-3",
        name: "Risk Scoring & Anomaly Detection",
        type: "risk_assessment",
        enabled: true,
        description: "Evaluates anomaly risk rating across payload and metadata.",
        config: {
          threshold: 65,
          actionOnFailure: "block",
        },
      },
    ],
  },
];

let tablesInitialized = false;

async function ensureTables(): Promise<void> {
  if (tablesInitialized) return;
  const db = await getDb();

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS workflows (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL,
        trigger     TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        steps_json  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        created_by  TEXT,
        version     INTEGER NOT NULL DEFAULT 1
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON workflows(trigger)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_workflows_enabled ON workflows(enabled)`);

    db.run(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id                  TEXT PRIMARY KEY,
        workflow_id         TEXT NOT NULL,
        workflow_name       TEXT NOT NULL,
        trigger             TEXT NOT NULL,
        status              TEXT NOT NULL,
        final_decision      TEXT NOT NULL,
        input_payload       TEXT NOT NULL,
        output_payload      TEXT,
        step_results_json   TEXT NOT NULL,
        total_latency_ms    INTEGER NOT NULL,
        approval_request_id TEXT,
        created_at          TEXT NOT NULL,
        executed_by         TEXT
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_created  ON workflow_runs(created_at)`);

    // Check if workflows table has records, if not seed defaults
    const stmt = db.prepare("SELECT COUNT(*) as cnt FROM workflows");
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      if ((row.cnt as number) === 0) {
        logger.info(CTX, "Seeding initial dynamic workflows...");
        const now = new Date().toISOString();
        for (const def of DEFAULT_WORKFLOWS) {
          const id = uuidv4();
          db.run(
            `INSERT INTO workflows (id, name, description, trigger, enabled, steps_json, created_at, updated_at, created_by, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              def.name,
              def.description,
              def.trigger,
              def.enabled ? 1 : 0,
              JSON.stringify(def.steps),
              now,
              now,
              "system",
              1,
            ]
          );
        }
      }
    } else {
      stmt.free();
    }

    tablesInitialized = true;
  } catch (error) {
    logger.error(CTX, `Error initializing workflow tables: ${error}`);
  }
}

export async function listWorkflows(): Promise<Workflow[]> {
  await ensureTables();
  const db = await getDb();
  const stmt = db.prepare("SELECT * FROM workflows ORDER BY created_at ASC");
  const workflows: Workflow[] = [];

  while (stmt.step()) {
    const row = stmt.getAsObject();
    try {
      workflows.push({
        id: row.id as string,
        name: row.name as string,
        description: row.description as string,
        trigger: row.trigger as any,
        enabled: (row.enabled as number) === 1,
        steps: JSON.parse(row.steps_json as string),
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
        createdBy: (row.created_by as string) || undefined,
        version: row.version as number,
      });
    } catch (e) {
      logger.error(CTX, `Failed to parse workflow row ${row.id}: ${e}`);
    }
  }
  stmt.free();
  return workflows;
}

export async function getWorkflowById(id: string): Promise<Workflow | null> {
  await ensureTables();
  const db = await getDb();
  const stmt = db.prepare("SELECT * FROM workflows WHERE id = ?");
  stmt.bind([id]);

  if (!stmt.step()) {
    stmt.free();
    return null;
  }

  const row = stmt.getAsObject();
  stmt.free();

  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    trigger: row.trigger as any,
    enabled: (row.enabled as number) === 1,
    steps: JSON.parse(row.steps_json as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: (row.created_by as string) || undefined,
    version: row.version as number,
  };
}

export async function createWorkflow(
  input: CreateWorkflowInput,
  createdBy = "operator"
): Promise<Workflow> {
  await ensureTables();
  const db = await getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  const steps: WorkflowStep[] = input.steps.map((s, idx) => ({
    id: uuidv4(),
    name: s.name,
    type: s.type,
    enabled: s.enabled !== false,
    description: s.description || "",
    config: s.config || {},
  }));

  const workflow: Workflow = {
    id,
    name: input.name,
    description: input.description,
    trigger: input.trigger,
    enabled: input.enabled !== false,
    steps,
    createdAt: now,
    updatedAt: now,
    createdBy,
    version: 1,
  };

  db.run(
    `INSERT INTO workflows (id, name, description, trigger, enabled, steps_json, created_at, updated_at, created_by, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workflow.name,
      workflow.description,
      workflow.trigger,
      workflow.enabled ? 1 : 0,
      JSON.stringify(workflow.steps),
      now,
      now,
      createdBy,
      1,
    ]
  );

  logger.info(CTX, `Created workflow "${workflow.name}" (id=${id})`);
  return workflow;
}

export async function updateWorkflow(
  id: string,
  input: UpdateWorkflowInput
): Promise<Workflow | null> {
  const existing = await getWorkflowById(id);
  if (!existing) return null;

  const db = await getDb();
  const now = new Date().toISOString();

  const steps: WorkflowStep[] = input.steps
    ? input.steps.map((s, idx) => ({
        id: s.id || uuidv4(),
        name: s.name,
        type: s.type,
        enabled: s.enabled !== false,
        description: s.description || "",
        config: s.config || {},
      }))
    : existing.steps;

  const updated: Workflow = {
    ...existing,
    name: input.name ?? existing.name,
    description: input.description ?? existing.description,
    trigger: input.trigger ?? existing.trigger,
    enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
    steps,
    updatedAt: now,
    version: existing.version + 1,
  };

  db.run(
    `UPDATE workflows
     SET name = ?, description = ?, trigger = ?, enabled = ?, steps_json = ?, updated_at = ?, version = ?
     WHERE id = ?`,
    [
      updated.name,
      updated.description,
      updated.trigger,
      updated.enabled ? 1 : 0,
      JSON.stringify(updated.steps),
      now,
      updated.version,
      id,
    ]
  );

  logger.info(CTX, `Updated workflow "${updated.name}" (id=${id}, v=${updated.version})`);
  return updated;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  await ensureTables();
  const db = await getDb();
  db.run("DELETE FROM workflows WHERE id = ?", [id]);
  logger.info(CTX, `Deleted workflow id=${id}`);
  return true;
}

export async function toggleWorkflow(id: string): Promise<Workflow | null> {
  const existing = await getWorkflowById(id);
  if (!existing) return null;
  return updateWorkflow(id, { enabled: !existing.enabled });
}

export async function saveWorkflowRun(run: WorkflowRun): Promise<void> {
  await ensureTables();
  const db = await getDb();

  db.run(
    `INSERT INTO workflow_runs
     (id, workflow_id, workflow_name, trigger, status, final_decision, input_payload, output_payload, step_results_json, total_latency_ms, approval_request_id, created_at, executed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.workflowId,
      run.workflowName,
      run.trigger,
      run.status,
      run.finalDecision,
      JSON.stringify(run.inputPayload),
      run.outputPayload ? JSON.stringify(run.outputPayload) : null,
      JSON.stringify(run.stepResults),
      run.totalLatencyMs,
      run.approvalRequestId || null,
      run.createdAt,
      run.executedBy || "system",
    ]
  );
}

export async function listWorkflowRuns(
  workflowId?: string,
  limit = 50
): Promise<WorkflowRun[]> {
  await ensureTables();
  const db = await getDb();
  const sql = workflowId
    ? "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?"
    : "SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?";

  const params = workflowId ? [workflowId, limit] : [limit];
  const stmt = db.prepare(sql);
  stmt.bind(params);

  const runs: WorkflowRun[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    try {
      runs.push({
        id: row.id as string,
        workflowId: row.workflow_id as string,
        workflowName: row.workflow_name as string,
        trigger: row.trigger as any,
        status: row.status as any,
        finalDecision: row.final_decision as any,
        inputPayload: JSON.parse(row.input_payload as string),
        outputPayload: row.output_payload ? JSON.parse(row.output_payload as string) : undefined,
        stepResults: JSON.parse(row.step_results_json as string),
        totalLatencyMs: row.total_latency_ms as number,
        approvalRequestId: (row.approval_request_id as string) || undefined,
        createdAt: row.created_at as string,
        executedBy: (row.executed_by as string) || undefined,
      });
    } catch (e) {
      logger.error(CTX, `Failed to parse workflow run ${row.id}: ${e}`);
    }
  }
  stmt.free();
  return runs;
}

export function getDefaultTemplates() {
  return DEFAULT_WORKFLOWS;
}
