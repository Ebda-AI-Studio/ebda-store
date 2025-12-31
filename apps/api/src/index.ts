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

const app = express();
const httpServer = createServer(app);

// Initialize Socket.io
socketService.initialize(httpServer);

// Request ID for tracing
app.use(requestId);

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

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Documentation (Swagger)
setupSwagger(app);

// API Routes
app.use('/api/v1', routes);

// Error handling
app.use(errorHandler);

// Start server
httpServer.listen(config.port, () => {
  console.log(`🚀 API Server running on http://${config.host}:${config.port}`);
  console.log(`📝 Environment: ${config.nodeEnv}`);
  console.log(`🔌 WebSocket enabled`);
  console.log(`📚 API Docs: http://${config.host}:${config.port}/docs`);
});

export default app;
