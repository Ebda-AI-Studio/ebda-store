/** STORE-QA-34: nothing to show in any of engines, trend or prompts is ONE empty state, not three copies of it. */
export function isEmptyAnswerEngineSummary(summary: {
  engines: readonly unknown[];
  trend: readonly unknown[];
  prompts: readonly unknown[];
}): boolean {
  return summary.engines.length === 0 && summary.trend.length === 0 && summary.prompts.length === 0;
}
