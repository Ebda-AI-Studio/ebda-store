export type Meta = {
  models: Record<string, ModelMeta>;
  enums: Record<string, string[]>;
};
export type ModelMeta = {
  table: string;
  db: 'store-do' | 'd1';
  pk: string[];
  uniques: string[][];
  fields: Record<string, FieldMeta>;
};
export type ScalarField = {
  kind: 'scalar' | 'enum';
  type: string;
  column: string;
  list: boolean;
  optional: boolean;
  scale?: number;
  enum?: string;
  default?: string;
  updatedAt?: boolean;
  id?: boolean;
};
export type RelationField = {
  kind: 'relation';
  type: string;
  list: boolean;
  optional: boolean;
  external: boolean;
  owner?: boolean;
  from?: string[];
  fromProps?: string[];
  to?: string[];
  toProps?: string[];
  onDelete?: string | null;
};
export type FieldMeta = ScalarField | RelationField;

/** The synchronous SQL surface of a Durable Object (`ctx.storage.sql`) or node:sqlite in tests. */
export interface SqlRunner {
  all(sql: string, params: unknown[]): Record<string, unknown>[];
  run(sql: string, params: unknown[]): { changes: number };
}
