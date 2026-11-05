// Pair `d1QueryMany` result sets (one per statement, in the order the statements were sent) with their table NAMES.
// Callers must never index the result by another list's position (the plan's FK order differs from the family's list).
export function countsByTable(tables, results) {
  if (results.length !== tables.length)
    throw new Error(`${results.length} count result sets for ${tables.length} tables`);
  const out = {};
  tables.forEach((t, i) => {
    out[t] = Number(results[i][0].n);
  });
  return out;
}
