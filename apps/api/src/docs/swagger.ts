import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';
import { config } from '../config';
import { isWorkers } from '../lib/runtime';
import { BRAND, BRAND_MARKETING_URL, BRAND_API_URL } from '@ebda/shared';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: `${BRAND.product.nameEn} API`,
      version: '1.0.0',
      description: `
# ${BRAND.product.nameEn} API Documentation

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
        name: BRAND.product.nameEn,
        email: BRAND.supportEmail,
        url: BRAND_MARKETING_URL,
      },
      license: {
        name: 'Proprietary',
        url: BRAND.legalUrls.terms,
      },
    },
    servers: [
      {
        url: `http://localhost:${config.port}/api/v1`,
        description: 'Development server',
      },
      {
        url: `${BRAND_API_URL}/api/v1`,
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
            role: { type: 'string', enum: ['customer', 'store_admin', 'super_admin'] },
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
            // Nullable free text. On PUT, `null` CLEARS the column and an
            // omitted key leaves it alone (Prisma's convention) — sending
            // `undefined` is what made an emptied field impossible to clear.
            nameAr: { type: 'string', nullable: true },
            slug: { type: 'string' },
            description: { type: 'string', nullable: true },
            descriptionAr: { type: 'string', nullable: true },
            price: { type: 'integer', description: 'Price in piastres (1 EGP = 100 piastres)' },
            compareAtPrice: { type: 'integer', nullable: true },
            sku: { type: 'string', nullable: true },
            // Merchant-authored free-text card badge (EN + AR), same clearable
            // contract as nameAr above: `null` clears, an omitted key leaves
            // the stored value alone. Trimmed and capped at 32 characters by
            // the update schema, so a documented `maxLength` here is the
            // contract, not a hint.
            badgeLabel: { type: 'string', nullable: true, maxLength: 32 },
            badgeLabelAr: { type: 'string', nullable: true, maxLength: 32 },
            searchTerms: {
              type: 'string',
              nullable: true,
              maxLength: 500,
              description:
                'Extra words shoppers type (dialect / Franco / English); comma-separated, cleaned to "a, b, c". Searched, never displayed. null clears.',
            },
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
            // Same clearable-field contract as Product above: these are
            // nullable columns, `updateCategorySchema` accepts `null` for
            // each (category.routes.ts) and the admin now SENDS null when the
            // merchant empties the input. Documenting them as plain `string`
            // told an integrator a clear was invalid.
            nameAr: { type: 'string', nullable: true },
            slug: { type: 'string' },
            description: { type: 'string', nullable: true },
            descriptionAr: { type: 'string', nullable: true },
            image: { type: 'string', format: 'uri', nullable: true },
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
            // Bundle-tagging snapshot joined from the returned line's
            // OrderItem (list/getById `items.include.orderItem`) — present
            // when this line was one component of an atomic bundle-box
            // return, null/absent for a loose line. See
            // packages/database's OrderItem model.
            orderItem: {
              type: 'object',
              nullable: true,
              properties: {
                bundleGroupId: { type: 'string', format: 'uuid', nullable: true },
                bundleName: { type: 'string', nullable: true },
                bundleNameAr: { type: 'string', nullable: true },
              },
            },
          },
        },
        // Analytics schemas
        DashboardStats: {
          type: 'object',
          properties: {
            totalOrders: { type: 'integer' },
            totalRevenue: { type: 'integer' },
            totalProducts: { type: 'integer' },
            totalCustomers: {
              type: 'integer',
              description:
                'Distinct customers in the period, keyed like the Customers page (user, else shipping email, else phone)',
            },
            allTimeCustomers: { type: 'integer' },
            ordersChange: { type: 'number', format: 'float' },
            revenueChange: { type: 'number', format: 'float' },
            previousRevenue: {
              type: 'integer',
              description:
                'Previous-period revenue; 0 means the change is "first sales", not a percentage',
            },
            previousOrders: { type: 'integer' },
            previousCustomers: { type: 'integer' },
            previousProfit: { type: 'integer', nullable: true },
            conversionRate: {
              type: 'number',
              format: 'float',
              nullable: true,
              description: 'Orders per product view (%), null when no views were recorded',
            },
            totalProfit: {
              type: 'integer',
              nullable: true,
              description: 'Piastres; null when sold lines have no cost price',
            },
            profitItemsMissingCost: { type: 'integer' },
            profitRevenueMissingCost: { type: 'integer' },
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
      { name: 'AI', description: 'Ebda Store assistant endpoints' },
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
  // Workers: swagger-jsdoc scans files through fs and swagger-ui serves static
  // assets from disk. The API reference lives at docs.ebda.app (SP9).
  if (isWorkers) {
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
        .swagger-ui .info .title { color: ${BRAND.colors.gold} }
      `,
      customSiteTitle: `${BRAND.product.nameEn} API Documentation`,
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
