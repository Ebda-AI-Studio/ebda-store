// The StoreDO ships inside the production worker (apps/api/src/cf/store-do). This spike re-exports that SAME class so the
// local workerd tests exercise exactly what is deployed (no second copy to drift). Needs the repo root `npm ci`.
export * from '../../../apps/api/src/cf/store-do/store-do';
