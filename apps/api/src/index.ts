import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { securityHeaders, requestId, sanitizeInput, csrfProtection } from './middleware/security';
import routes from './routes';
import webhookRoutes from './routes/webhook.routes';
import { socketService } from './services/socket.service';
import { setupSwagger } from './docs/swagger';
import { prisma } from '@force/database';
import { redis } from './services/redis.service';
import { circuitBreaker } from './services/circuit-breaker.service';
import { emailQueue } from './services/email-queue.service';

const app = express();
const httpServer = createServer(app);

// Track server state for graceful shutdown
let isShuttingDown = false;

// Initialize Socket.io
socketService.initialize(httpServer);

// Start email queue processor
emailQueue.startProcessing();

// Request ID for tracing
app.use(requestId);

// Graceful shutdown middleware
app.use((req, res, next) => {
  if (isShuttingDown) {
    res.setHeader('Connection', 'close');
    return res.status(503).json({
      success: false,
      error: {
        code: 'SERVER_SHUTTING_DOWN',
        message: 'Server is shutting down. Please retry.',
      },
    });
  }
  next();
});

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(securityHeaders);

// Compression middleware for better performance
app.use(
  compression({
    filter: (req, res) => {
      if (req.headers['x-no-compression']) {
        return false;
      }
      return compression.filter(req, res);
    },
    level: 6,
  })
);

app.use(
  cors({
    origin: [config.webUrl, config.adminUrl],
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'X-CSRF-Token'],
  })
);

// Global rate limiting
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Webhook routes need raw body parsing (must be before json middleware)
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Input sanitization
app.use(sanitizeInput);

// CSRF protection
app.use(csrfProtection);

// Request logging
app.use(requestLogger);

// Simple health check (for load balancers)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Comprehensive health check with dependency status
app.get('/api/v1/health', async (_req, res) => {
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};

  // Check database
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'connected', latency: Date.now() - dbStart };
  } catch (error) {
    checks.database = {
      status: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check Redis
  const redisStart = Date.now();
  try {
    if (redis.isAvailable()) {
      await redis.getClient()?.ping();
      checks.redis = { status: 'connected', latency: Date.now() - redisStart };
    } else {
      checks.redis = { status: 'unavailable' };
    }
  } catch (error) {
    checks.redis = {
      status: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Get circuit breaker states
  const circuits = circuitBreaker.getAllStates();

  // Get email queue stats
  const emailStats = await emailQueue.getStats();

  // Determine overall status
  const isHealthy = checks.database.status === 'connected';
  const status = isHealthy ? 'healthy' : 'degraded';

  res.status(isHealthy ? 200 : 503).json({
    success: true,
    data: {
      status,
      timestamp: new Date().toISOString(),
      version: config.appVersion,
      environment: config.nodeEnv,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      checks,
      circuits: Object.entries(circuits).reduce(
        (acc, [name, state]) => {
          acc[name] = state.state;
          return acc;
        },
        {} as Record<string, string>
      ),
      emailQueue: emailStats,
    },
  });
});

// API Documentation (Swagger)
setupSwagger(app);

// API Routes
app.use('/api/v1', routes);

// Error handling
app.use(errorHandler);

// Start server
const server = httpServer.listen(config.port, () => {
  console.log(`🚀 API Server running on http://${config.host}:${config.port}`);
  console.log(`📝 Environment: ${config.nodeEnv}`);
  console.log(`🔌 WebSocket enabled`);
  console.log(`📚 API Docs: http://${config.host}:${config.port}/docs`);
});

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  isShuttingDown = true;

  // Stop accepting new connections
  server.close(async () => {
    console.log('HTTP server closed');

    try {
      // Stop email queue
      emailQueue.stopProcessing();
      console.log('Email queue stopped');

      // Close socket connections
      socketService.close();
      console.log('WebSocket connections closed');

      // Close database connection
      await prisma.$disconnect();
      console.log('Database connection closed');

      // Close Redis connection
      await redis.disconnect();
      console.log('Redis connection closed');

      console.log('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  });

  // Force close after 30 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', reason => {
  console.error('Unhandled Rejection:', reason);
  // Don't shutdown for unhandled rejections, just log
});

export default app;
