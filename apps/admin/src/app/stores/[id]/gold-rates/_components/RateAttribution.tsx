/**
 * The ONE place a feed provider is named (Ruling B5-15). The free USD/EGP source's licence asks for an
 * attribution link wherever its data is used; it is shown in the merchant ADMIN rate editor, next to
 * the automatic rate, and nowhere shopper-facing. It is licence attribution, not marketing: the
 * never-name-providers rule for storefront, email and marketing copy stands, and
 * `tests/unit/gold-provider-name-gate.test.ts` exempts exactly this file by its exact path.
 */
export function RateAttribution({ className }: { className?: string }) {
  return (
    <p className={className}>
      <a
        href="https://www.exchangerate-api.com"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-[44px] items-center text-xs text-muted-foreground underline underline-offset-4"
      >
        {/* i18n-gate-allow: licence-mandated attribution wording, shown verbatim in every locale (Ruling B5-15) */}
        Rates By Exchange Rate API
      </a>
    </p>
  );
}

export default RateAttribution;
