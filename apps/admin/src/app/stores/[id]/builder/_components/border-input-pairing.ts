/**
 * Ruling B1-43 follow-up (W2a): a palette writes `inputColor === borderColor`, and `composeStoreTheme`
 * draws fields with a stored `inputColor` over the border. So a later Borders-only edit in site
 * settings must move a PAIRED input colour with it, or the fields keep the old palette hairline
 * while every other border moves. An input colour that differs from the border (a look's muted
 * input, an explicit pick) is left alone.
 */
export function borderEditPatch(
  current: Record<string, unknown>,
  key: string,
  value: unknown
): Record<string, unknown> {
  if (
    key === 'borderColor' &&
    current.inputColor !== undefined &&
    current.inputColor === current.borderColor
  )
    return { borderColor: value, inputColor: value };
  return { [key]: value };
}
