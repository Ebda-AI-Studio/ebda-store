import { parseArgs } from 'node:util';

export function cli(options, extra = {}) {
  const { values, positionals } = parseArgs({
    options: {
      'pg-url': { type: 'string' },
      'allow-prod-read': { type: 'boolean', default: false },
      store: { type: 'string' },
      all: { type: 'boolean', default: false },
      'do-url': { type: 'string' },
      batch: { type: 'string' },
      'page-size': { type: 'string', default: '1000' },
      report: { type: 'string' },
      json: { type: 'boolean', default: false },
      ...options,
    },
    allowPositionals: true,
    strict: true,
    ...extra,
  });
  values.pgUrl = values['pg-url'] ?? process.env.CUTOVER_PG_URL;
  values.doUrl = (values['do-url'] ?? process.env.CUTOVER_DO_URL ?? '').replace(/\/$/, '');
  values.secret = process.env.CUTOVER_IMPORT_SECRET;
  values.pageSize = Number(values['page-size']);
  return { args: values, positionals };
}

export const fmtMs = ms => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
