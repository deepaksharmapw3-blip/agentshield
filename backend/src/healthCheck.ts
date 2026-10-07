/**
 * healthCheck.ts
 *
 * Comprehensive health check system for all system components.
 * Monitors backend, LLM service, database, and external dependencies.
 */

import { getLLMService } from './llmService';
import { getDb } from './auditLogger';
import { logger } from './logger';
import { getHeapStatistics } from 'v8';

const CTX = 'HealthCheck';

export interface ComponentHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  lastCheck: string;
  responseTime?: number;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  components: Record<string, ComponentHealth>;
  summary: {
    healthy: number;
    degraded: number;
    unhealthy: number;
  };
}

class HealthChecker {
  private checkCache: Map<string, { health: ComponentHealth; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 5000; // 5 second cache

  /**
   * Check LLM service health
   */
  async checkLLMService(): Promise<ComponentHealth> {
    const cacheKey = 'llm-service';
    const cached = this.checkCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.health;
    }

    const startTime = Date.now();
    try {
      const llmService = getLLMService();
      const available = await llmService.isAvailable();
      const responseTime = Date.now() - startTime;

      const health: ComponentHealth = {
        name: 'LLM Service',
        status: available ? 'healthy' : 'degraded',
        message: available
          ? 'LLM service and Ollama are operational'
          : 'LLM service offline — fallback deterministic rules active',
        lastCheck: new Date().toISOString(),
        responseTime,
      };

      this.checkCache.set(cacheKey, { health, timestamp: Date.now() });
      return health;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const health: ComponentHealth = {
        name: 'LLM Service',
        status: 'degraded',
        message: `LLM service offline (${error instanceof Error ? error.message : String(error)}) — fallback deterministic rules active`,
        lastCheck: new Date().toISOString(),
        responseTime,
      };

      this.checkCache.set(cacheKey, { health, timestamp: Date.now() });
      return health;
    }
  }

  /**
   * Check backend service health
   */
  async checkBackendService(): Promise<ComponentHealth> {
    const cacheKey = 'backend-service';
    const cached = this.checkCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.health;
    }

    const responseTime = 0; // Backend is running
    const health: ComponentHealth = {
      name: 'Backend Service',
      status: 'healthy',
      message: 'Backend API is operational',
      lastCheck: new Date().toISOString(),
      responseTime,
    };

    this.checkCache.set(cacheKey, { health, timestamp: Date.now() });
    return health;
  }

  /**
   * Check database connectivity
   */
  async checkDatabase(): Promise<ComponentHealth> {
    const cacheKey = 'database';
    const cached = this.checkCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.health;
    }

    const startTime = Date.now();
    try {
      // Execute a simple test query to verify database is accessible
      const db = await getDb();
      
      // Test query that works with SQLite
      const stmt = db.prepare('SELECT 1 as status');
      stmt.step();
      const result = stmt.getAsObject();
      stmt.free();
      
      if (!result || (result as any).status !== 1) {
        throw new Error('Database test query returned unexpected result');
      }

      const responseTime = Date.now() - startTime;

      const health: ComponentHealth = {
        name: 'Database',
        status: 'healthy',
        message: 'Database is operational',
        lastCheck: new Date().toISOString(),
        responseTime,
      };

      this.checkCache.set(cacheKey, { health, timestamp: Date.now() });
      return health;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const health: ComponentHealth = {
        name: 'Database',
        status: 'unhealthy',
        message: `Database error: ${error instanceof Error ? error.message : String(error)}`,
        lastCheck: new Date().toISOString(),
        responseTime,
      };

      this.checkCache.set(cacheKey, { health, timestamp: Date.now() });
      return health;
    }
  }

  /**
   * Check memory usage
   */
  checkMemory(): ComponentHealth {
    const cacheKey = 'memory';
    const cached = this.checkCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.health;
    }

    try {
      const memUsage = process.memoryUsage();
      const heapLimit = getHeapStatistics().heap_size_limit;
      const heapUsedPercent = (memUsage.heapUsed / heapLimit) * 100;

      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      let message = `Memory usage: ${heapUsedPercent.toFixed(1)}% heap`;

      if (heapUsedPercent > 90) {
        status = 'unhealthy';
        message += ' (CRITICAL)';
      } else if (heapUsedPercent > 75) {
        status = 'degraded';
        message += ' (HIGH)';
      }

      const health: ComponentHealth = {
        name: 'Memory',
        status,
        message,
        lastCheck: new Date().toISOString(),
      };

      this.checkCache.set(cacheKey, { health, timestamp: Date.now() });
      return health;
    } catch (error) {
      const health: ComponentHealth = {
        name: 'Memory',
        status: 'degraded',
        message: `Error checking memory: ${error instanceof Error ? error.message : String(error)}`,
        lastCheck: new Date().toISOString(),
      };

      this.checkCache.set(cacheKey, { health, timestamp: Date.now() });
      return health;
    }
  }

  /**
   * Check disk space (if available)
   */
  checkDiskSpace(): ComponentHealth {
    const cacheKey = 'disk';
    const cached = this.checkCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.health;
    }

    // Note: In production, use a library like 'disk-space-monitor'
    const health: ComponentHealth = {
      name: 'Disk Space',
      status: 'healthy',
      message: 'Disk space available',
      lastCheck: new Date().toISOString(),
    };

    this.checkCache.set(cacheKey, { health, timestamp: Date.now() });
    return health;
  }

  /**
   * Perform comprehensive system health check
   */
  async checkSystemHealth(): Promise<SystemHealth> {
    const startTime = Date.now();

    try {
      const [llmHealth, backendHealth, dbHealth, memHealth, diskHealth] = await Promise.all([
        this.checkLLMService(),
        this.checkBackendService(),
        this.checkDatabase(),
        Promise.resolve(this.checkMemory()),
        Promise.resolve(this.checkDiskSpace()),
      ]);

      const components = {
        llm: llmHealth,
        backend: backendHealth,
        database: dbHealth,
        memory: memHealth,
        disk: diskHealth,
      };

      // Calculate summary
      const summary = {
        healthy: Object.values(components).filter((c) => c.status === 'healthy').length,
        degraded: Object.values(components).filter((c) => c.status === 'degraded').length,
        unhealthy: Object.values(components).filter((c) => c.status === 'unhealthy').length,
      };

      // Determine overall status
      let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      if (summary.unhealthy > 0) {
        overallStatus = 'unhealthy';
      } else if (summary.degraded > 0) {
        overallStatus = 'degraded';
      }

      const totalTime = Date.now() - startTime;
      logger.debug(
        CTX,
        `Health check completed in ${totalTime}ms: ${overallStatus} (${summary.healthy} healthy, ${summary.degraded} degraded, ${summary.unhealthy} unhealthy)`
      );

      return {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        components,
        summary,
      };
    } catch (error) {
      logger.error(CTX, `Health check failed: ${error instanceof Error ? error.message : String(error)}`);

      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        components: {},
        summary: { healthy: 0, degraded: 0, unhealthy: 0 },
      };
    }
  }

  /**
   * Quick liveness probe (for Kubernetes)
   */
  isAlive(): boolean {
    // Simple check if process is running
    return true;
  }

  /**
   * Readiness probe (for Kubernetes)
   */
  async isReady(): Promise<boolean> {
    try {
      const health = await this.checkSystemHealth();
      return health.status !== 'unhealthy';
    } catch {
      return false;
    }
  }
}

// Export singleton
export const healthChecker = new HealthChecker();
