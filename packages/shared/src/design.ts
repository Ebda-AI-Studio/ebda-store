/**
 * Ebda design language v1 as the Store consumes it: the vendored foundation tokens and guard rules (FDN-VENDOR-1),
 * one import path (`@ebda/shared/design`). Never fork the values here; change them in ebda-foundation and `ebda-foundation sync`.
 */
export * from './foundation/tokens';
export * from './foundation/guards';
