/** Split a migration file into single statements: comments stripped, `;` inside a trigger's BEGIN ... END kept. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  const text = sql.replace(/--[^\n]*/g, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") inStr = !inStr;
    if (c === ';' && !inStr) {
      const isTrigger = /^\s*CREATE\s+TRIGGER/i.test(cur);
      if (isTrigger && !/\bEND\s*$/i.test(cur)) {
        cur += c;
        continue;
      }
      if (cur.trim()) out.push(cur.replace(/\s+/g, ' ').trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.replace(/\s+/g, ' ').trim());
  return out;
}
