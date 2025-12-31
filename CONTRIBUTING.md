# Contributing to Force Website Builder

Thank you for your interest in contributing to Force Website Builder! This document provides guidelines and instructions for contributing.

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
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/force-website-builder.git`
3. Add the upstream remote: `git remote add upstream https://github.com/forcemedia/force-website-builder.git`
4. Create a new branch: `git checkout -b feature/your-feature-name`

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
force-website-builder/
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

## Questions?

If you have questions, please:

1. Check existing issues and documentation
2. Create a new issue with the "question" label
3. Join our community discussions

Thank you for contributing!
