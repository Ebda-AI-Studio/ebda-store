/**
 * Ruling POSITION-1 (Ahmad, 2026-10-26): the home page states the eliminated monthly cost, as arithmetic from the
 * numbers below and nothing else. No competitor is named. Change a number here and the copy and the test follow;
 * tests/unit/marketing-positioning.test.ts checks 50,000 x 2% = 1,000.
 */
export const POSITIONING = {
  /** An example month of orders, in EGP. */
  monthlyOrdersEgp: 50_000,
  /** A typical commission on other platforms, in percent. */
  otherPlatformFeePct: 2,
} as const;

/** What that commission costs per month, in EGP. */
export const MONTHLY_FEE_EGP =
  (POSITIONING.monthlyOrdersEgp * POSITIONING.otherPlatformFeePct) / 100;

const en = (n: number) => n.toLocaleString('en-US');

/** The one line under the home hero, in English. */
export const heroSavingEn = () =>
  `No commission on your sales. With ${en(POSITIONING.monthlyOrdersEgp)} EGP of orders a month, a ${POSITIONING.otherPlatformFeePct}% fee on other platforms costs you ${en(MONTHLY_FEE_EGP)} EGP every month. With Ebda Store, 0.`;

/** The same line in Egyptian Arabic; `product` is the brand's Arabic product name (BRAND.product.nameAr). */
export const heroSavingAr = (product: string) =>
  `من غير عمولة على مبيعاتك. لو طلباتك ${POSITIONING.monthlyOrdersEgp / 1000} ألف جنيه في الشهر، عمولة ${POSITIONING.otherPlatformFeePct}% في منصات تانية بتكلفك ${en(MONTHLY_FEE_EGP)} جنيه كل شهر. مع ${product}: صفر.`;
