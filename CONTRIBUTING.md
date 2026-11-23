# Contributing to Ebda Store

Thank you for your interest in contributing to Ebda Store! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Testing](#testing)
- [Documentation](#documentation)

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment. We expect all contributors to:

- Be respectful and constructive in discussions
- Welcome newcomers and help them get started
- Focus on what is best for the community and project
- Show empathy towards other community members

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/ebda.git`
3. Create a new branch: `git checkout -b feature/your-feature-name`

## Development Setup

### Prerequisites

- Node.js >= 18.x
- npm >= 9.x
- PostgreSQL >= 14
- Redis (optional, for caching)

### Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Set up the database
npm run db:migrate
npm run db:seed

# Start development servers
npm run dev
```

### Available Scripts

| Script                  | Description                        |
| ----------------------- | ---------------------------------- |
| `npm run dev`           | Start all apps in development mode |
| `npm run build`         | Build all apps for production      |
| `npm run test`          | Run all tests                      |
| `npm run test:coverage` | Run tests with coverage report     |
| `npm run lint`          | Lint all code                      |
| `npm run lint:fix`      | Fix linting issues                 |
| `npm run db:migrate`    | Run database migrations            |
| `npm run db:seed`       | Seed the database                  |

## Project Structure

```
ebda/
├── apps/
│   ├── web/          # Customer-facing storefront (Next.js)
│   ├── admin/        # Admin dashboard (Next.js)
│   └── api/          # REST API server (Express)
├── packages/
│   ├── database/     # Prisma schema and client
│   ├── ui/           # Shared UI components
│   ├── config/       # Shared configurations
│   └── shared/       # Shared utilities
├── docs/             # Documentation
└── tests/            # E2E tests
```

## Coding Standards

### TypeScript

- Use TypeScript strict mode
- Avoid using `any` type - use proper types or `unknown`
- Define interfaces for all data structures
- Use enums for fixed sets of values

### React

- Use functional components with hooks
- Keep components small and focused
- Use proper prop types with TypeScript interfaces
- Follow the container/presentational pattern

### API

- Follow RESTful conventions
- Use proper HTTP status codes
- Validate all inputs with Zod
- Document all endpoints with JSDoc

### Code Style

- Use ESLint and Prettier for formatting
- Maximum line length: 100 characters
- Use meaningful variable and function names
- Add comments for complex logic

## Commit Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples

```
feat(api): add product search endpoint

fix(auth): resolve token refresh issue

docs(readme): update installation instructions
```

## Pull Request Process

1. **Update your branch**: Rebase on the latest main branch
2. **Run tests**: Ensure all tests pass with `npm run test`
3. **Lint your code**: Run `npm run lint` and fix any issues
4. **Update documentation**: Add/update relevant documentation
5. **Create PR**: Submit a pull request with a clear description
6. **Code review**: Address any feedback from reviewers
7. **Merge**: Once approved, your PR will be merged

### PR Checklist

- [ ] Tests pass locally
- [ ] Linting passes
- [ ] Documentation updated
- [ ] Commit messages follow conventions
- [ ] PR description explains the changes
- [ ] Related issues are linked

## Testing

### Running Tests

```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm run test -- path/to/test.ts
```

### Buy-flow parity (money paths)

Any PR touching cart, order, payment, checkout, coupon, promotion, shipping, tax,
stock, bundle, refund/return or webhook code must run
`node scripts/buy-flow-parity/run.mjs --head <your-branch>` and paste the verdict
table into the PR. It replays the storefront's real buy sequences against the
baseline customers bought on (`96814545`) and your branch, and it diffs every
order, payment, stock and gateway field. See `scripts/buy-flow-parity/README.md`.

### Writing Tests

- Write unit tests for all business logic
- Write integration tests for API endpoints
- Use meaningful test descriptions
- Follow AAA pattern (Arrange, Act, Assert)

## Documentation

### Code Documentation

- Add JSDoc comments to all public functions
- Document complex algorithms and business logic
- Keep comments up-to-date with code changes

### API Documentation

- Document all API endpoints in OpenAPI/Swagger format
- Include request/response examples
- Document error responses

## How a new feature joins the capability registry

Every merchant-facing page, route, MCP tool and plan gate belongs to exactly one capability (lens 192: AI-native, self-service, help article). The registry is `capabilities/<id>.capability.json`; the guard config is `capabilities/guard.config.json`; the schema, rules and guards are the vendored `@ebda/foundation` v0.2.0 modules in `packages/shared/src/foundation/`.

1. Add `capabilities/<area>.<feature>.capability.json` (copy a neighbour; the id is the file name). Fill: `status` (`live`, `in-pr` with `pr`, `planned` with `plan`), `screens` (admin paths such as `/stores/[id]/orders`, a trailing `/*` covers a subtree), `api` (exact `METHOD /path` strings as mounted, no wildcards), `mcpTool`, `planGate`, `roles`, `policy` (`free` | `preview` | `confirm` | `forbidden`; any write, money, customer message or DELETE is `confirm`), `undo.class`, and Arabic (3-6) plus English (1-3) example `questions`.
2. A `live` capability that merchants use also needs a help article in BOTH languages under `apps/help/content/{ar,en}/` whose front matter lists `capabilities:` as `id@version`, and `helpArticle` set to its slug. Bump `version` when behaviour changes; the article must then list the new version (`help-stale`).
3. Run `npx vitest run tests/unit/capability-registry.test.ts tests/unit/capability-coverage.test.ts tests/unit/self-service-routes-guard.test.ts tests/unit/smart-layer-bypass-guard.test.ts tests/unit/capability-help-guard.test.ts`. A new offender fails from day one.
4. Baselines (`capabilities/baselines/*.json`) hold today's debt and are shrink-only: fixing an offender means deleting its id in the same PR (`CAPABILITY_WRITE_BASELINES=1 npx vitest run tests/unit/capability-baselines-write.test.ts` rewrites them). A PR that adds an id fails the `capability-ratchet` job in `pr-quality.yml`. Never add an id to hide a new offender.
5. A model call (Workers AI binding, provider SDK or REST host) outside the Smart Layer is a `model-call-outside-smart-layer` violation; do not add one.

## Questions?

If you have questions, please:

1. Check existing issues and documentation
2. Create a new issue with the "question" label
3. Join our community discussions

Thank you for contributing!

## Merging

Merge only through the gate: `scripts/ci/merge-gate.sh <pr> <expected-head-sha>`. Do not run `gh pr merge` yourself. The gate waits for CI, refuses on zero checks, a failed or cancelled check, a conflict or a head that moved since you reviewed it, and pins the merge to the reviewed commit. Details in `CLAUDE.md` ("Merging: always through the gate"). `scripts/ci/merge-gate.sh`, `merge-gate-required.mjs`, `pre-push-gate.sh` and `scripts/ops/cf-logs-setup.sh` are thin wrappers (F10): the scripts themselves are vendored from ebda-foundation into `scripts/foundation/` (`--ops`), never edited here; the Store's own pre-push steps are `scripts/ci/pre-push-extra.sh`.
