// Visual builder (Phase 1): versioned page document (sections + blocks +
// section groups), section/block registry with settings schemas, global theme
// settings schema, legacy-layout adapter and validator.
// Ebda-only path, self-contained so it can be ported upstream later (list in docs/architecture/page-definition.md).
export * from './section-keys';
export * from './viewports';
export * from './section-spacing';
export * from './schema';
export * from './theme-draft';
export * from './chrome-draft';
export * from './typography-draft';
export * from './smart-palette';
export * from './rebase-draft';
export * from './settings-schema';
export * from './shown-for';
export * from './registry';
export * from './adapter';
export * from './validate';
export * from './placeholder-copy';
export { storeLayoutSchema, heroSlideSchema } from './layout-schema';
export * from './template-families';
export * from './sections-document-only';
export * from './editor';
export * from './page-kinds';
export * from './page-defaults';
export * from './page-settings';
export * from './look-diff';
export * from './ai-patch';
