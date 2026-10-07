import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import {
  listWorkflows,
  getWorkflowById,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  toggleWorkflow,
  listWorkflowRuns,
  getDefaultTemplates,
} from "../workflowStorage";
import { executeWorkflow } from "../workflowEngine";
import type { CreateWorkflowInput, UpdateWorkflowInput, Workflow } from "../workflowTypes";

const router = Router();

// ─── List workflows ──────────────────────────────────────────────────────────
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const workflows = await listWorkflows();
    res.json({ count: workflows.length, workflows });
  })
);

// ─── Get default templates ───────────────────────────────────────────────────
router.get(
  "/templates",
  asyncHandler(async (_req, res) => {
    const templates = getDefaultTemplates();
    res.json({ count: templates.length, templates });
  })
);

// ─── List workflow execution runs ────────────────────────────────────────────
router.get(
  "/runs",
  asyncHandler(async (req, res) => {
    const workflowId = req.query.workflowId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const runs = await listWorkflowRuns(workflowId, limit);
    res.json({ count: runs.length, runs });
  })
);

// ─── Get workflow by ID ──────────────────────────────────────────────────────
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.json(workflow);
  })
);

// ─── Create workflow ─────────────────────────────────────────────────────────
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = req.body as CreateWorkflowInput;
    if (!input.name || !input.trigger || !input.steps || !Array.isArray(input.steps)) {
      res.status(400).json({ error: "Missing required fields: name, trigger, and steps array" });
      return;
    }

    const createdBy = (req as any).user?.username || "operator";
    const workflow = await createWorkflow(input, createdBy);
    res.status(201).json({ message: "Workflow created successfully", workflow });
  })
);

// ─── Update workflow ─────────────────────────────────────────────────────────
router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = req.body as UpdateWorkflowInput;
    const updated = await updateWorkflow(req.params.id, input);
    if (!updated) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.json({ message: "Workflow updated successfully", workflow: updated });
  })
);

// ─── Delete workflow ─────────────────────────────────────────────────────────
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const deleted = await deleteWorkflow(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.json({ message: "Workflow deleted successfully" });
  })
);

// ─── Toggle workflow enabled/disabled ────────────────────────────────────────
router.post(
  "/:id/toggle",
  asyncHandler(async (req, res) => {
    const workflow = await toggleWorkflow(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.json({ message: `Workflow ${workflow.enabled ? "enabled" : "disabled"}`, workflow });
  })
);

// ─── Execute workflow by ID ──────────────────────────────────────────────────
router.post(
  "/:id/run",
  asyncHandler(async (req, res) => {
    const payload = req.body?.payload || req.body || {};
    const executedBy = (req as any).user?.username || "operator";
    const run = await executeWorkflow(req.params.id, payload, executedBy);
    res.json({ message: "Workflow execution completed", run });
  })
);

// ─── Execute custom workflow definition (for live playground / visual builder)
router.post(
  "/execute-custom",
  asyncHandler(async (req, res) => {
    const { workflow, payload } = req.body;
    if (!workflow || !workflow.steps) {
      res.status(400).json({ error: "Missing workflow definition in request body" });
      return;
    }

    const executedBy = (req as any).user?.username || "operator";
    const run = await executeWorkflow(workflow as Workflow, payload || {}, executedBy);
    res.json({ message: "Custom workflow execution completed", run });
  })
);

export default router;
