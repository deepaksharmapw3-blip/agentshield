import { v4 as uuidv4 } from "uuid";
import { scanAndRedact } from "./secretsScanner";
import { assessRisk } from "./riskDetector";
import { createApprovalRequest } from "./approvalGate";
import { saveWorkflowRun, getWorkflowById } from "./workflowStorage";
import { logger } from "./logger";
import { eventBus } from "./realtime/eventBus";
import type {
  Workflow,
  WorkflowStep,
  WorkflowRun,
  WorkflowRunStepResult,
  WorkflowFinding,
  StepExecutionStatus,
} from "./workflowTypes";
import type { ToolCall, InspectionResult } from "./types";

const CTX = "WorkflowEngine";

// Common prompt injection attack patterns
const PROMPT_INJECTION_PATTERNS = [
  { name: "instruction_override", regex: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i, reason: "Attempt to override core system instructions" },
  { name: "system_prompt_leak", regex: /(repeat|output|show|print|display)\s+(your\s+)?(system\s+prompt|initial\s+instructions)/i, reason: "Attempt to extract secret system prompt" },
  { name: "dan_jailbreak", regex: /(you\s+are\s+now\s+in\s+DAN\s+mode|do\s+anything\s+now|developer\s+mode\s+enabled)/i, reason: "Classic DAN / unrestricted persona jailbreak pattern" },
  { name: "delimiter_injection", regex: /(<\s*\/?\s*system\s*>|\[\s*system\s*\]|role:\s*system|###\s*instruction)/i, reason: "Attempted delimiter / context escape injection" },
  { name: "safety_bypass", regex: /(disregard|bypass|disable)\s+(safety|content\s+filter|guardrails)/i, reason: "Explicit directive to disable safety policies" },
];

// Dangerous code & shell patterns
const DANGEROUS_CODE_PATTERNS = [
  { name: "destructive_rm", regex: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*-f[a-zA-Z]*r)\s+(\/|~|\.\.|\*)/i, reason: "Destructive recursive file deletion target" },
  { name: "pipe_to_shell", regex: /(curl|wget)\s+[^\n|;&]+\|\s*(sh|bash|zsh|python|perl)/i, reason: "Unverified remote script piped directly into shell" },
  { name: "sql_destruction", regex: /(drop\s+database|drop\s+table|truncate\s+table|delete\s+from\s+[a-zA-Z0-9_]+\s+where\s+1\s*=\s*1)/i, reason: "Destructive database schema or table deletion" },
  { name: "credential_file_access", regex: /(\/etc\/shadow|\/etc\/passwd|~\/\.ssh\/id_rsa|~\/\.aws\/credentials|\.env\.production)/i, reason: "Direct access to high-privilege credentials or shadow files" },
  { name: "reverse_shell", regex: /(nc\s+-e|bash\s+-i\s+>\&|\/dev\/tcp\/\d+\.\d+\.\d+\.\d+)/i, reason: "Interactive reverse shell or network socket pipe detected" },
];

// PII & sensitive data patterns for DLP
const DLP_PATTERNS = [
  { name: "credit_card", regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, mask: "[REDACTED_CREDIT_CARD]" },
  { name: "email_address", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, mask: "[REDACTED_EMAIL]" },
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g, mask: "[REDACTED_SSN]" },
  { name: "jwt_token", regex: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, mask: "[REDACTED_JWT]" },
  { name: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g, mask: "[REDACTED_AWS_KEY]" },
];

function sanitizeDLP(obj: unknown, findings: WorkflowFinding[]): unknown {
  if (typeof obj === "string") {
    let sanitized = obj;
    for (const pat of DLP_PATTERNS) {
      if (pat.regex.test(sanitized)) {
        findings.push({
          rule: `dlp_${pat.name}`,
          reason: `Detected sensitive ${pat.name.replace(/_/g, " ")} in payload`,
          severity: "high",
        });
        sanitized = sanitized.replace(pat.regex, pat.mask);
      }
    }
    return sanitized;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeDLP(item, findings));
  }

  if (obj !== null && typeof obj === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      res[k] = sanitizeDLP(v, findings);
    }
    return res;
  }

  return obj;
}

export async function executeWorkflow(
  workflowInput: Workflow | string,
  inputPayload: Record<string, unknown>,
  executedBy = "operator"
): Promise<WorkflowRun> {
  let workflow: Workflow;
  if (typeof workflowInput === "string") {
    const found = await getWorkflowById(workflowInput);
    if (!found) {
      throw new Error(`Workflow not found with ID: ${workflowInput}`);
    }
    workflow = found;
  } else {
    workflow = workflowInput;
  }

  const runId = uuidv4();
  const startTime = Date.now();
  const now = new Date().toISOString();

  logger.info(CTX, `Starting workflow execution: id=${workflow.id} name="${workflow.name}" runId=${runId}`);

  const stepResults: WorkflowRunStepResult[] = [];
  let currentPayload = { ...inputPayload };
  let finalDecision: "allow" | "block" | "require_approval" = "allow";
  let approvalRequestId: string | undefined;
  let overallStatus: "completed" | "blocked" | "require_approval" | "failed" = "completed";

  // Standardize tool call object for steps that inspect tool calls
  const toolName = (currentPayload.tool as string) || (currentPayload.name as string) || "workflow_execution";
  const toolArgs = (currentPayload.args as Record<string, unknown>) || currentPayload;
  const agentId = (currentPayload.agentId as string) || "WorkflowAgent";
  const stringifiedPayload = JSON.stringify(currentPayload);

  for (const step of workflow.steps) {
    if (!step.enabled) {
      stepResults.push({
        stepId: step.id,
        stepName: step.name,
        stepType: step.type,
        status: "skipped",
        latencyMs: 0,
        findings: [],
        details: { message: "Step disabled by policy configuration" },
      });
      continue;
    }

    const stepStart = Date.now();
    const findings: WorkflowFinding[] = [];
    let stepStatus: StepExecutionStatus = "passed";
    let stepDetails: Record<string, unknown> = {};

    try {
      switch (step.type) {
        case "secret_detection": {
          const { sanitized, findings: secrets } = scanAndRedact(toolArgs);
          if (secrets.length > 0) {
            for (const s of secrets) {
              findings.push({
                rule: `secret_${s.name}`,
                reason: `Secret detected in argument key '${s.argKey}': ${s.name}`,
                severity: "critical",
                details: { pattern: s.pattern, argKey: s.argKey },
              });
            }
            const action = step.config.actionOnFailure || "block";
            stepStatus = action === "block" ? "blocked" : action === "require_approval" ? "require_approval" : "warning";
          }
          currentPayload = { ...currentPayload, args: sanitized };
          stepDetails = { secretsFound: secrets.length, redactedKeys: secrets.map(s => s.argKey) };
          break;
        }

        case "prompt_injection_scan": {
          const textToScan = [
            stringifiedPayload,
            (currentPayload.prompt as string) || "",
            (currentPayload.diff as string) || "",
            (currentPayload.comment as string) || "",
          ].join(" ");

          let score = 0;
          for (const pattern of PROMPT_INJECTION_PATTERNS) {
            if (pattern.regex.test(textToScan)) {
              score += 35;
              findings.push({
                rule: pattern.name,
                reason: pattern.reason,
                severity: score >= 70 ? "critical" : "high",
              });
            }
          }

          const threshold = step.config.threshold ?? 50;
          if (score >= threshold || findings.length > 0) {
            const action = step.config.actionOnFailure || "block";
            stepStatus = action === "block" ? "blocked" : action === "require_approval" ? "require_approval" : "warning";
          }
          stepDetails = { injectionRiskScore: score, patternsChecked: PROMPT_INJECTION_PATTERNS.length };
          break;
        }

        case "tool_permission_check": {
          const blocked = step.config.blockedTools || [];
          const allowed = step.config.allowedTools;

          if (blocked.includes(toolName)) {
            findings.push({
              rule: "blocked_tool_permission",
              reason: `Tool '${toolName}' is explicitly blocked in workflow policy`,
              severity: "critical",
            });
            const action = step.config.actionOnFailure || "block";
            stepStatus = action === "block" ? "blocked" : "require_approval";
          } else if (allowed && allowed.length > 0 && !allowed.includes(toolName)) {
            findings.push({
              rule: "unauthorized_tool_permission",
              reason: `Tool '${toolName}' is not in the allowed capabilities list`,
              severity: "high",
            });
            const action = step.config.actionOnFailure || "require_approval";
            stepStatus = action === "block" ? "blocked" : "require_approval";
          }
          stepDetails = { tool: toolName, isBlocked: blocked.includes(toolName) };
          break;
        }

        case "code_policy_check": {
          const command = (toolArgs.command as string) || (toolArgs.script as string) || stringifiedPayload;
          for (const pattern of DANGEROUS_CODE_PATTERNS) {
            if (pattern.regex.test(command)) {
              findings.push({
                rule: pattern.name,
                reason: pattern.reason,
                severity: "critical",
              });
            }
          }

          if (findings.length > 0) {
            const action = step.config.actionOnFailure || "block";
            stepStatus = action === "block" ? "blocked" : action === "require_approval" ? "require_approval" : "warning";
          }
          stepDetails = { commandChecked: typeof toolArgs.command === "string", violations: findings.length };
          break;
        }

        case "risk_assessment": {
          const pseudoToolCall: ToolCall = {
            id: uuidv4(),
            tool: toolName,
            args: toolArgs,
            agentId,
            timestamp: now,
          };
          const assessment = assessRisk(pseudoToolCall);
          const threshold = step.config.threshold ?? 60;

          if (assessment.findings.length > 0) {
            for (const f of assessment.findings) {
              findings.push({
                rule: f.rule,
                reason: f.reason,
                severity: assessment.riskLevel === 'safe' ? undefined : assessment.riskLevel,
                details: { score: f.score },
              });
            }
          }

          if (assessment.riskScore >= threshold || assessment.requireApproval) {
            const action = step.config.actionOnFailure || (assessment.riskScore >= 80 ? "block" : "require_approval");
            stepStatus = action === "block" ? "blocked" : action === "require_approval" ? "require_approval" : "warning";
          }

          stepDetails = {
            riskScore: assessment.riskScore,
            riskLevel: assessment.riskLevel,
            threshold,
            deterministicScore: assessment.riskScore,
          };
          break;
        }

        case "dlp_data_masking": {
          const dlpFindings: WorkflowFinding[] = [];
          const sanitized = sanitizeDLP(currentPayload, dlpFindings) as Record<string, unknown>;
          currentPayload = sanitized;
          findings.push(...dlpFindings);
          stepDetails = { piiRedactionsCount: dlpFindings.length };
          break;
        }

        case "human_approval_gate": {
          const hasPriorIssues = stepResults.some(r => r.status === "blocked" || r.status === "require_approval" || r.status === "warning");
          const strictGate = step.config.strict ?? false;

          if (hasPriorIssues || strictGate || findings.length > 0) {
            stepStatus = "require_approval";
            findings.push({
              rule: "approval_gate_triggered",
              reason: "Security risk threshold or strict policy requires human operator approval",
              severity: "medium",
            });

            // Create real approval request ticket in AgentShield queue
            const pseudoToolCall: ToolCall = {
              id: uuidv4(),
              tool: toolName,
              args: toolArgs,
              agentId,
              timestamp: now,
            };

            const pseudoInspection: InspectionResult = {
              toolCallId: pseudoToolCall.id,
              tool: toolName,
              riskScore: 75,
              riskLevel: "high",
              decision: "require_approval",
              riskFindings: findings.map(f => ({ rule: f.rule, reason: f.reason, score: 75 })),
              secretFindings: [],
              sanitizedArgs: toolArgs,
              inspectedAt: now,
            };

            try {
              const approval = await createApprovalRequest(
                pseudoToolCall,
                pseudoInspection,
                step.config.timeoutMs || 300000
              );
              approvalRequestId = approval.id;
              stepDetails = { approvalRequestId, timeoutMs: step.config.timeoutMs || 300000, approverRole: step.config.approverRole || "operator" };
            } catch (err) {
              logger.error(CTX, `Failed to create approval ticket for workflow run: ${err}`);
            }
          }
          break;
        }

        case "webhook_dispatch": {
          stepDetails = {
            dispatched: true,
            webhookUrl: step.config.webhookUrl || "https://audit.agentshield.internal/v1/telemetry",
            event: "workflow_step_audit",
          };
          break;
        }

        case "custom_rule_eval": {
          if (step.config.patterns && step.config.patterns.length > 0) {
            for (const pat of step.config.patterns) {
              try {
                const re = new RegExp(pat, "i");
                if (re.test(stringifiedPayload)) {
                  findings.push({
                    rule: "custom_regex_match",
                    reason: `Matched custom rule pattern: ${pat}`,
                    severity: "medium",
                  });
                  stepStatus = step.config.actionOnFailure === "block" ? "blocked" : step.config.actionOnFailure === "require_approval" ? "require_approval" : "warning";
                }
              } catch {
                // Invalid regex
              }
            }
          }
          stepDetails = { customRulesEvaluated: step.config.patterns?.length || 0 };
          break;
        }
      }
    } catch (err) {
      stepStatus = "failed";
      findings.push({
        rule: "step_execution_error",
        reason: err instanceof Error ? err.message : String(err),
        severity: "high",
      });
    }

    const stepLatency = Date.now() - stepStart;
    stepResults.push({
      stepId: step.id,
      stepName: step.name,
      stepType: step.type,
      status: stepStatus,
      latencyMs: stepLatency,
      findings,
      details: stepDetails,
      sanitizedPayloadSnapshot: currentPayload,
    });

    if (stepStatus === "blocked") {
      finalDecision = "block";
      overallStatus = "blocked";
      // If blocked and strict, stop remaining pipeline
      break;
    } else if (stepStatus === "require_approval") {
      finalDecision = "require_approval";
      overallStatus = "require_approval";
    }
  }

  const totalLatencyMs = Date.now() - startTime;

  const run: WorkflowRun = {
    id: runId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    trigger: workflow.trigger,
    status: overallStatus,
    finalDecision,
    inputPayload,
    outputPayload: currentPayload,
    stepResults,
    totalLatencyMs,
    approvalRequestId,
    createdAt: now,
    executedBy,
  };

  await saveWorkflowRun(run);

  try {
    eventBus.emit("workflow:executed", run);
  } catch {
    // Non-fatal if socket server not listening
  }

  logger.info(CTX, `Workflow run completed: id=${runId} decision=${finalDecision} totalMs=${totalLatencyMs}`);
  return run;
}
