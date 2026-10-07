export type WorkflowTriggerType =
  | "tool_call"
  | "pull_request"
  | "agent_execution"
  | "prompt_submission"
  | "manual"
  | "webhook";

export type WorkflowStepType =
  | "secret_detection"
  | "prompt_injection_scan"
  | "tool_permission_check"
  | "code_policy_check"
  | "risk_assessment"
  | "human_approval_gate"
  | "dlp_data_masking"
  | "webhook_dispatch"
  | "custom_rule_eval";

export type WorkflowStepAction = "block" | "require_approval" | "warn" | "continue";

export interface WorkflowStepConfig {
  threshold?: number;
  strict?: boolean;
  actionOnFailure?: WorkflowStepAction;
  patterns?: string[];
  allowedTools?: string[];
  blockedTools?: string[];
  approverRole?: string;
  timeoutMs?: number;
  webhookUrl?: string;
  customCondition?: string;
}

export interface WorkflowStep {
  id: string;
  name: string;
  type: WorkflowStepType;
  enabled: boolean;
  description?: string;
  config: WorkflowStepConfig;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  trigger: WorkflowTriggerType;
  enabled: boolean;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  version: number;
}

export type StepExecutionStatus =
  | "passed"
  | "blocked"
  | "require_approval"
  | "warning"
  | "skipped"
  | "failed";

export interface WorkflowFinding {
  rule: string;
  reason: string;
  severity?: "low" | "medium" | "high" | "critical";
  details?: Record<string, unknown>;
}

export interface WorkflowRunStepResult {
  stepId: string;
  stepName: string;
  stepType: WorkflowStepType;
  status: StepExecutionStatus;
  latencyMs: number;
  findings: WorkflowFinding[];
  details: Record<string, unknown>;
  sanitizedPayloadSnapshot?: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  trigger: WorkflowTriggerType;
  status: "completed" | "blocked" | "require_approval" | "failed";
  finalDecision: "allow" | "block" | "require_approval";
  inputPayload: Record<string, unknown>;
  outputPayload?: Record<string, unknown>;
  stepResults: WorkflowRunStepResult[];
  totalLatencyMs: number;
  approvalRequestId?: string;
  createdAt: string;
  executedBy?: string;
}

export interface CreateWorkflowInput {
  name: string;
  description: string;
  trigger: WorkflowTriggerType;
  enabled?: boolean;
  steps: Array<{
    name: string;
    type: WorkflowStepType;
    enabled?: boolean;
    description?: string;
    config?: WorkflowStepConfig;
  }>;
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  trigger?: WorkflowTriggerType;
  enabled?: boolean;
  steps?: Array<{
    id?: string;
    name: string;
    type: WorkflowStepType;
    enabled?: boolean;
    description?: string;
    config?: WorkflowStepConfig;
  }>;
}
