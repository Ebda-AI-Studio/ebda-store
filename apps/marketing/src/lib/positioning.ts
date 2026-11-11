/**
 * Ruling POSITION-1 (Ahmad, 2026-10-26): the home page states the eliminated monthly cost, as arithmetic from the
 * numbers below and nothing else. No competitor is named. Change a number here and the copy and the test follow;
 * tests/unit/marketing-positioning.test.ts checks 50,000 x 1% = 500.
 * POSITION-1b (M-031, 2026-11-11): 2% became 1%, the online fee in business/ebda/research/2026-11-02-competitor-prices.md (the 2% had no
 * source there); the line now also sits in the Ebda Store window of the Studio home. Cost if wrong: the line understates the fee some platforms charge.
 */
export const POSITIONING = {
  /** An example month of orders, in EGP. */
  monthlyOrdersEgp: 50_000,
  /** A commission some other platforms charge on online orders, in percent (1% online in the 2026-11-02 competitor re-check, POSITION-1b). */
  otherPlatformFeePct: 1,
} as const;

/** What that commission costs per month, in EGP. */
export const MONTHLY_FEE_EGP =
  (POSITIONING.monthlyOrdersEgp * POSITIONING.otherPlatformFeePct) / 100;

const en = (n: number) => n.toLocaleString('en-US');

/** The one line under the home hero, in English. */
export const heroSavingEn = () =>
  `No commission on your sales. With ${en(POSITIONING.monthlyOrdersEgp)} EGP of orders a month, a ${POSITIONING.otherPlatformFeePct}% fee on online orders on some platforms costs you ${en(MONTHLY_FEE_EGP)} EGP every month. With Ebda Store, 0.`;

/** The same line in Egyptian Arabic; `product` is the brand's Arabic product name (BRAND.product.nameAr). */
export const heroSavingAr = (product: string) =>
  `من غير عمولة على مبيعاتك. لو طلباتك ${POSITIONING.monthlyOrdersEgp / 1000} ألف جنيه في الشهر، في منصات بتاخد ${POSITIONING.otherPlatformFeePct}% عمولة على الدفع أونلاين، ودي بتكلفك ${en(MONTHLY_FEE_EGP)} جنيه كل شهر. مع ${product}: صفر.`;
