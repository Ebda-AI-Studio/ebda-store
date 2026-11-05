// Cloudflare SQLite schema (INFRA-CF-1 phase 1). Import the namespace you need:
//   import { store } from '@ebda/cf-schema'      // StoreDO tables (one SQLite Durable Object per store)
//   import { platform } from '@ebda/cf-schema'   // D1 ebda-platform tables
// The DDL lives in migrations/{store,platform}/*.sql; these are the query-builder definitions.
export * as store from './store/schema.generated';
export * as platform from './platform/schema.generated';
export { STORE_MIGRATIONS } from './store/migrations.generated';
