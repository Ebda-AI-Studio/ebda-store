import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';
import { config } from '../config';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Force Website Builder API',
      version: '1.0.0',
      description: `
# Force Website Builder API Documentation

Multi-tenant e-commerce platform API for managing stores, products, orders, and more.

## Authentication

Most endpoints require authentication using JWT Bearer tokens. Include the token in the Authorization header:

\`\`\`
Authorization: Bearer <your-access-token>
\`\`\`

## Rate Limiting

API requests are rate limited to 100 requests per 15-minute window per IP address.

## Error Responses

All errors follow this format:

\`\`\`json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  }
}
\`\`\`

## Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| UNAUTHORIZED | 401 | Missing or invalid authentication token |
| FORBIDDEN | 403 | Insufficient permissions |
| NOT_FOUND | 404 | Resource not found |
| VALIDATION_ERROR | 400 | Invalid request data |
| RATE_LIMITED | 429 | Too many requests |
      `,
      contact: {
        name: 'Force Media Kuwait',
        email: 'support@forcemediakw.com',
        url: 'https://forcemediakw.com',
      },
      license: {
        name: 'Proprietary',
        url: 'https://forcemediakw.com/terms',
      },
    },
    servers: [
      {
        url: `http://localhost:${config.port}/api/v1`,
        description: 'Development server',
      },
      {
        url: 'https://api.forcemediakw.com/api/v1',
        description: 'Production server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT access token',
        },
      },
      schemas: {
        // Common schemas
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: 'Invalid request data' },
              },
            },
          },
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer', example: 1 },
            limit: { type: 'integer', example: 20 },
            total: { type: 'integer', example: 100 },
            totalPages: { type: 'integer', example: 5 },
          },
        },
        // User schemas
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            role: { type: 'string', enum: ['customer', 'admin', 'super_admin'] },
            isVerified: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        // Store schemas
        Store: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            nameAr: { type: 'string' },
            slug: { type: 'string' },
            description: { type: 'string' },
            logo: { type: 'string', format: 'uri' },
            domain: { type: 'string' },
            status: { type: 'string', enum: ['active', 'suspended', 'pending'] },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        // Product schemas
        Product: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            storeId: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            nameAr: { type: 'string' },
            slug: { type: 'string' },
            description: { type: 'string' },
            price: { type: 'integer', description: 'Price in fils (1 KWD = 1000 fils)' },
            compareAtPrice: { type: 'integer' },
            sku: { type: 'string' },
            inventory: { type: 'integer' },
            status: { type: 'string', enum: ['active', 'draft', 'archived'] },
            images: { type: 'array', items: { $ref: '#/components/schemas/ProductImage' } },
            category: { $ref: '#/components/schemas/Category' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        ProductImage: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            url: { type: 'string', format: 'uri' },
            alt: { type: 'string' },
            position: { type: 'integer' },
          },
        },
        Category: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            nameAr: { type: 'string' },
            slug: { type: 'string' },
            description: { type: 'string' },
            image: { type: 'string', format: 'uri' },
          },
        },
        // Order schemas
        Order: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            orderNumber: { type: 'string' },
            status: {
              type: 'string',
              enum: [
                'pending',
                'confirmed',
                'processing',
                'shipped',
                'delivered',
                'cancelled',
                'refunded',
              ],
            },
            subtotal: { type: 'integer' },
            tax: { type: 'integer' },
            shipping: { type: 'integer' },
            total: { type: 'integer' },
            shippingAddress: { type: 'object' },
            billingAddress: { type: 'object' },
            items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' } },
            customer: { $ref: '#/components/schemas/User' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        OrderItem: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            productId: { type: 'string', format: 'uuid' },
            productName: { type: 'string' },
            sku: { type: 'string' },
            quantity: { type: 'integer' },
            price: { type: 'integer' },
            total: { type: 'integer' },
          },
        },
        // Cart schemas
        Cart: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            items: { type: 'array', items: { $ref: '#/components/schemas/CartItem' } },
            itemCount: { type: 'integer' },
            subtotal: { type: 'integer' },
          },
        },
        CartItem: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            productId: { type: 'string', format: 'uuid' },
            quantity: { type: 'integer' },
            product: { $ref: '#/components/schemas/Product' },
          },
        },
        // Review schemas
        Review: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            rating: { type: 'integer', minimum: 1, maximum: 5 },
            title: { type: 'string' },
            comment: { type: 'string' },
            isVerified: { type: 'boolean' },
            isApproved: { type: 'boolean' },
            helpfulCount: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        // Return schemas
        Return: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            returnNumber: { type: 'string' },
            type: { type: 'string', enum: ['return', 'exchange', 'refund'] },
            status: {
              type: 'string',
              enum: [
                'pending',
                'approved',
                'rejected',
                'shipped',
                'received',
                'inspecting',
                'completed',
                'cancelled',
              ],
            },
            reason: { type: 'string' },
            refundAmount: { type: 'integer' },
            items: { type: 'array', items: { $ref: '#/components/schemas/ReturnItem' } },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        ReturnItem: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            productId: { type: 'string', format: 'uuid' },
            productName: { type: 'string' },
            quantity: { type: 'integer' },
            reason: { type: 'string' },
            condition: { type: 'string' },
          },
        },
        // Analytics schemas
        DashboardStats: {
          type: 'object',
          properties: {
            totalOrders: { type: 'integer' },
            totalRevenue: { type: 'integer' },
            totalProducts: { type: 'integer' },
            totalCustomers: { type: 'integer' },
            ordersChange: { type: 'number', format: 'float' },
            revenueChange: { type: 'number', format: 'float' },
          },
        },
      },
      responses: {
        UnauthorizedError: {
          description: 'Access token is missing or invalid',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: {
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
              },
            },
          },
        },
        ForbiddenError: {
          description: 'Insufficient permissions',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: {
                success: false,
                error: { code: 'FORBIDDEN', message: 'Access denied' },
              },
            },
          },
        },
        NotFoundError: {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: {
                success: false,
                error: { code: 'NOT_FOUND', message: 'Resource not found' },
              },
            },
          },
        },
        ValidationError: {
          description: 'Invalid request data',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: {
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Invalid request data' },
              },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Authentication', description: 'User authentication endpoints' },
      { name: 'Stores', description: 'Store management endpoints' },
      { name: 'Products', description: 'Product management endpoints' },
      { name: 'Categories', description: 'Category management endpoints' },
      { name: 'Cart', description: 'Shopping cart endpoints' },
      { name: 'Orders', description: 'Order management endpoints' },
      { name: 'Reviews', description: 'Product review endpoints' },
      { name: 'Returns', description: 'Return/exchange management endpoints' },
      { name: 'Analytics', description: 'Store analytics endpoints' },
      { name: 'Payments', description: 'Payment processing endpoints' },
      { name: 'Uploads', description: 'File upload endpoints' },
      { name: 'AI', description: 'Force AI assistant endpoints' },
      { name: 'Admin', description: 'Super admin management endpoints' },
    ],
  },
  apis: ['./src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(options);

export function setupSwagger(app: Express) {
  // Disable Swagger UI in production to avoid exposing API surface
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  // Serve Swagger UI
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customCss: `
        .swagger-ui .topbar { display: none }
        .swagger-ui .info { margin-bottom: 30px }
        .swagger-ui .info .title { color: #f97316 }
      `,
      customSiteTitle: 'Force API Documentation',
      customfavIcon: '/favicon.ico',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'list',
        filter: true,
        showExtensions: true,
        showCommonExtensions: true,
      },
    })
  );

  // Serve raw OpenAPI spec
  app.get('/docs/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

export { swaggerSpec };
