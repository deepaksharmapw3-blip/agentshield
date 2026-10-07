import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import "express-async-errors";

import { jwtAuth } from "./middleware/jwtAuth";
import { errorHandler } from "./middleware/errorHandler";
import { asyncHandler } from "./middleware/asyncHandler";
import { healthChecker } from "./healthCheck";
import { getMetrics, getMetricsContentType } from "./monitoring";
import authRoutes from "./routes/auth";
import inspectRoutes from "./routes/inspect";
import approvalsRoutes from "./routes/approvals";
import auditRoutes from "./routes/audit";
import configRoutes from "./routes/config";
import workflowsRoutes from "./routes/workflows";

/**
 * Parse ALLOWED_ORIGINS environment variable
 * Format: "http://localhost:3000,https://example.com,https://api.example.com"
 * Defaults to localhost origins for development
 */
function getAllowedOrigins(): (string | RegExp)[] {
  if (!process.env.ALLOWED_ORIGINS) {
    // Default for development: allow localhost
    return [
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
    ];
  }

  const origins = process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  return origins.map((origin) => {
    // Convert exact origin strings to RegExp for consistent matching
    return new RegExp(`^${origin.replace(/\./g, "\\.")}$`);
  });
}

export function createApp(): express.Application {
  const app = express();

  // ── Security headers ────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS configuration ──────────────────────────────────────────────────
  const allowedOrigins = getAllowedOrigins();
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (Postman, curl, server-to-server)
        if (!origin) {
          callback(null, true);
          return;
        }

        // Check if origin is in allowed list
        const isAllowed = allowedOrigins.some((allowedOrigin) => {
          if (typeof allowedOrigin === "string") {
            return origin === allowedOrigin;
          }
          return allowedOrigin.test(origin);
        });

        if (isAllowed) {
          callback(null, true);
        } else {
          callback(new Error(`CORS: origin "${origin}" not allowed`));
        }
      },
      methods: ["GET", "POST", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
      credentials: true,
    })
  );

  // ── Request logging ──────────────────────────────────────────────────────
  const logFormat = process.env.NODE_ENV === "production" ? "combined" : "dev";
  app.use(morgan(logFormat));

  // ── Body parsing ─────────────────────────────────────────────────────────
  app.use(express.json({ limit: "1mb" }));

  // ── Health check (no auth needed) ────────────────────────────────────────
  app.get(
    "/health",
    asyncHandler(async (_req, res) => {
      const health = await healthChecker.checkSystemHealth();
      const statusCode = health.status === "healthy" || health.status === "degraded" ? 200 : 503;
      res.status(statusCode).json(health);
    })
  );

  app.get("/metrics", asyncHandler(async (_req, res) => {
    res.type(getMetricsContentType()).send(await getMetrics());
  }));

  // ── Auth routes (no auth needed) ─────────────────────────────────────────
  app.use("/auth", authRoutes);

  // ── JWT auth for all protected routes ────────────────────────────────────
  app.use("/inspect", jwtAuth);
  app.use("/approvals", jwtAuth);
  app.use("/audit", jwtAuth);
  app.use("/config", jwtAuth);
  app.use("/workflows", jwtAuth);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use("/inspect", inspectRoutes);
  app.use("/approvals", approvalsRoutes);
  app.use("/audit", auditRoutes);
  app.use("/config", configRoutes);
  app.use("/workflows", workflowsRoutes);

  // ── 404 handler ───────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: "Route not found" });
  });

  // ── Global error handler ──────────────────────────────────────────────────
  app.use(errorHandler);

  return app;
}
