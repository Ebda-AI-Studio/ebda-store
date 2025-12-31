# Force Website Builder

E-Commerce Website Builder Platform by Force Media

A multi-tenant SaaS platform that allows Force Media (Super Admin) to provision and manage multiple e-commerce stores. Each store has its own admin who can manage products, orders, customers, and analytics.

## Platform Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        FORCE MEDIA (Super Admin)                            │
│                                                                             │
│   - Provision new stores                    - Platform analytics            │
│   - Manage all stores                       - User management               │
│   - Billing & subscriptions                 - Audit logs                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
    ┌───────────────┐       ┌───────────────┐       ┌───────────────┐
    │   Store A     │       │   Store B     │       │   Store C     │
    │   (Owner A)   │       │   (Owner B)   │       │   (Owner C)   │
    ├───────────────┤       ├───────────────┤       ├───────────────┤
    │ - Products    │       │ - Products    │       │ - Products    │
    │ - Orders      │       │ - Orders      │       │ - Orders      │
    │ - Customers   │       │ - Customers   │       │ - Customers   │
    │ - Analytics   │       │ - Analytics   │       │ - Analytics   │
    │ - Settings    │       │ - Settings    │       │ - Settings    │
    └───────────────┘       └───────────────┘       └───────────────┘
            │                       │                       │
            ▼                       ▼                       ▼
    ┌───────────────┐       ┌───────────────┐       ┌───────────────┐
    │  Storefront A │       │  Storefront B │       │  Storefront C │
    │ store-a.com   │       │ store-b.com   │       │ store-c.com   │
    └───────────────┘       └───────────────┘       └───────────────┘
```

## User Roles

| Role            | Access Level  | Capabilities                                                       |
| --------------- | ------------- | ------------------------------------------------------------------ |
| **Super Admin** | Platform-wide | Create/manage stores, view all data, manage users, view audit logs |
| **Store Admin** | Single store  | Manage products, orders, customers, store settings, view analytics |
| **Customer**    | Storefront    | Browse products, place orders, manage account                      |

## Project Structure

```
force-website-builder/
├── apps/
│   ├── web/          # Customer-facing storefront (Next.js)
│   ├── api/          # Backend API server (Express + TypeScript)
│   └── admin/        # Admin dashboard (Next.js) - Super Admin & Store Admin
├── packages/
│   ├── shared/       # Shared types, utilities, constants
│   ├── ui/           # Shared UI components (Button, Input, Badge, etc.)
│   ├── database/     # Prisma schema and client
│   └── config/       # Shared configurations
├── docker/           # Docker compose for local dev
├── docs/             # Documentation
└── scripts/          # Utility scripts
```

## API Routes

### Super Admin Routes (`/api/v1/admin/*`)

- `GET /admin/dashboard` - Platform statistics
- `GET /admin/stores` - List all stores
- `POST /admin/stores` - Provision new store
- `GET /admin/stores/:id` - Store details
- `PUT /admin/stores/:id` - Update store
- `PATCH /admin/stores/:id/status` - Change store status
- `GET /admin/users` - List all users
- `GET /admin/audit-logs` - View audit logs

### Store-Scoped Routes (`/api/v1/stores/:storeId/*`)

- `GET /stores/:storeId/products` - List store products
- `POST /stores/:storeId/products` - Create product
- `GET /stores/:storeId/orders` - List store orders
- `GET /stores/:storeId/customers` - List store customers
- `GET /stores/:storeId/cart` - Get customer cart
- `POST /stores/:storeId/checkout` - Process checkout

## Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- Docker & Docker Compose

## Quick Start

```bash
# 1. Clone and install dependencies
npm install

# 2. Start infrastructure (PostgreSQL, Redis, etc.)
npm run docker:up

# 3. Copy environment config
cp .env.example .env

# 4. Generate Prisma client and run migrations
npm run db:generate
npm run db:migrate

# 5. Start development servers
npm run dev
```

## Available Scripts

| Command               | Description                        |
| --------------------- | ---------------------------------- |
| `npm run dev`         | Start all apps in development mode |
| `npm run dev:web`     | Start web storefront only          |
| `npm run dev:api`     | Start API server only              |
| `npm run dev:admin`   | Start admin dashboard only         |
| `npm run build`       | Build all apps for production      |
| `npm run lint`        | Run ESLint across all workspaces   |
| `npm run format`      | Format code with Prettier          |
| `npm run test`        | Run tests across all workspaces    |
| `npm run docker:up`   | Start Docker services              |
| `npm run docker:down` | Stop Docker services               |
| `npm run db:studio`   | Open Prisma Studio                 |

## Ports

| Service         | Port |
| --------------- | ---- |
| Web Storefront  | 3000 |
| Admin Dashboard | 3001 |
| API Server      | 4000 |
| PostgreSQL      | 5432 |
| Redis           | 6379 |
| Elasticsearch   | 9200 |
| MinIO Console   | 9001 |
| MailHog UI      | 8025 |

## Tech Stack

- **Frontend**: Next.js 14, React 18, TailwindCSS
- **Backend**: Express.js, TypeScript
- **Database**: PostgreSQL + Prisma ORM
- **Cache**: Redis
- **Search**: Elasticsearch / Algolia
- **Storage**: Cloudflare R2 / S3-compatible
- **Payments**: Stripe, PayPal

## License

Proprietary - Force Media
