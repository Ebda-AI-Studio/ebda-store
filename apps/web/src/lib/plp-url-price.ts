import { fromMinor } from '@ebda/shared';

/**
 * Ruling B5-7: the product list seeds its price range from `?minPrice=` / `?maxPrice=` (integer
 * MINOR units, the API's own params), so the gift finder's budget chips and shared links land
 * filtered. Returns the range in MAJOR units (what the slider speaks) and the slider ceiling: a cap
 * at or above the natural ceiling widens the slider to twice the cap, so the cap stays a real
 * restriction the slider can show instead of reading as "no limit". Anything that is not a positive
 * safe integer up to 1e9 is ignored.
 */
export function plpUrlPrice(
  params: { get(key: string): string | null },
  naturalCeil: number
): { min: number; max: number; sliderMax: number } {
  const minor = (key: string) => {
    const v = Number(params.get(key));
    return Number.isSafeInteger(v) && v > 0 && v <= 1_000_000_000 ? v : 0;
  };
  const min = minor('minPrice');
  const max = minor('maxPrice');
  const maxMajor = max ? fromMinor(max) : 0;
  return {
    min: min ? fromMinor(min) : 0,
    max: maxMajor,
    sliderMax: maxMajor >= naturalCeil ? maxMajor * 2 : naturalCeil,
  };
}
