/**
 * Pure rules for "needs attention": facts in, items out. No I/O, so every signal is unit-tested
 * on/off. The loader (attention.service.ts) gathers the facts from data the app already has.
 *
 * Plan-gated features never show as problems: each gated signal is dropped when the feature is
 * off for the store (`features`), so a merchant is never told to fix something their plan cannot use.
 */
import type { AttentionItem } from '@ebda/shared';

export interface GatewayFact {
  provider: string;
  healthStatus: string | null;
  /** `connectionTest.ok` when a test result is stored, else null. */
  testOk: boolean | null;
}

export interface AttentionFacts {
  features: { tax: boolean; whatsapp: boolean; staffAccounts: boolean };
  domain: { pendingDomain: string | null; domainStatus: string | null };
  emailDomain: { id: string | null; verifiedAt: Date | null };
  /** Enabled non-manual gateways. */
  gateways: GatewayFact[];
  /** Enabled InstaPay row: does it carry a handle or a phone? null = InstaPay not enabled. */
  instapayHasDestination: boolean | null;
  products: number;
  deliveryZones: number;
  deliveryAreaRates: number;
  subscription: { status: string | null; overLimitThisMonth: boolean } | null;
  pendingBillingClaims: number;
  tax: { enabled: boolean; profileStatus: string | null };
  chatLinked: boolean;
  pendingStaffInvites: number;
}

export function computeAttention(f: AttentionFacts): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (
    f.domain.pendingDomain &&
    (f.domain.domainStatus === 'pending' || f.domain.domainStatus === 'failed')
  ) {
    items.push({
      id: 'domain_unverified',
      severity: 'action',
      section: 'domain',
      title: { en: 'Your domain is not connected yet', ar: 'الدومين لسه مش متوصّل' },
      message: {
        en: `${f.domain.pendingDomain} is waiting for its DNS records. Add them at your registrar, then press verify.`,
        ar: `الدومين ${f.domain.pendingDomain} مستني سجلات الـ DNS. ضيفها عند الشركة اللي اشتريت منها الدومين وبعدين اضغط تحقق.`,
      },
    });
  }

  if (f.emailDomain.id && !f.emailDomain.verifiedAt) {
    items.push({
      id: 'email_dns_missing',
      severity: 'info',
      section: 'domain',
      title: { en: 'Email sender DNS is incomplete', ar: 'سجلات إيميل المتجر ناقصة' },
      message: {
        en: 'Add the email DNS records so your store emails come from your own domain and reach the inbox.',
        ar: 'ضيف سجلات الإيميل علشان رسايل متجرك تتبعت من دومينك وتوصل للـ Inbox مش الـ Spam.',
      },
    });
  }

  const failed = f.gateways.filter(g => g.testOk === false || g.healthStatus === 'down');
  if (failed.length > 0) {
    items.push({
      id: 'gateway_connection_failed',
      severity: 'action',
      section: 'payment-settings',
      title: { en: 'A payment gateway is not working', ar: 'بوابة دفع مش شغالة' },
      message: {
        en: 'A gateway you turned on failed its connection check. Customers may not be able to pay with it: re-check the keys.',
        ar: 'بوابة دفع شغّلتها فشل اختبار الاتصال بتاعها، وممكن العملاء ما يعرفوش يدفعوا بيها. راجع المفاتيح.',
      },
      count: failed.length,
    });
  }
  const untested = f.gateways.filter(g => g.testOk === null && g.healthStatus !== 'down');
  if (untested.length > 0) {
    items.push({
      id: 'gateway_untested',
      severity: 'info',
      section: 'payment-settings',
      title: { en: 'A payment gateway was never tested', ar: 'بوابة دفع لسه ما اتجرّبتش' },
      message: {
        en: 'Press Test connection on the gateway so you know it works before a customer tries it.',
        ar: 'اضغط اختبار الاتصال على البوابة علشان تتأكد إنها شغالة قبل ما أي عميل يجرّبها.',
      },
      count: untested.length,
    });
  }

  if (f.instapayHasDestination === false) {
    items.push({
      id: 'instapay_incomplete',
      severity: 'action',
      section: 'payment-settings',
      title: { en: 'InstaPay has no account to pay to', ar: 'إنستاباي من غير حساب يستقبل الدفع' },
      message: {
        en: 'InstaPay is on but has no handle or phone number, so customers cannot see where to send the money.',
        ar: 'إنستاباي شغّال بس مفيش عنوان أو رقم موبايل، فالعميل مش هيعرف يحوّل الفلوس لمين.',
      },
    });
  }

  if (f.products > 0 && f.deliveryZones === 0 && f.deliveryAreaRates === 0) {
    items.push({
      id: 'no_delivery_rates',
      severity: 'action',
      section: 'shipping',
      title: { en: 'No delivery rates set', ar: 'مفيش أسعار شحن' },
      message: {
        en: 'Add at least one delivery zone or area rate so customers can check out with shipping.',
        ar: 'ضيف منطقة شحن أو سعر لمنطقة واحدة على الأقل علشان العملاء يقدروا يكمّلوا الطلب.',
      },
    });
  }

  if (f.subscription?.status === 'past_due') {
    items.push({
      id: 'billing_past_due',
      severity: 'action',
      section: 'billing',
      title: { en: 'Your subscription payment is due', ar: 'اشتراكك محتاج دفع' },
      message: {
        en: 'The last subscription payment did not go through. Pay now to keep your store running.',
        ar: 'آخر دفعة اشتراك ما تمّتش. ادفع دلوقتي علشان متجرك يفضل شغّال.',
      },
    });
  }
  if (f.pendingBillingClaims > 0) {
    items.push({
      id: 'billing_claim_pending',
      severity: 'info',
      section: 'billing',
      title: { en: 'Your InstaPay payment is being reviewed', ar: 'دفعة إنستاباي بتاعتك بتتراجع' },
      message: {
        en: 'We received your transfer proof and are checking it. Nothing to do for now.',
        ar: 'وصلنا إثبات التحويل وبنراجعه. مفيش حاجة مطلوبة منك دلوقتي.',
      },
      count: f.pendingBillingClaims,
    });
  }
  if (f.subscription?.overLimitThisMonth) {
    items.push({
      id: 'orders_over_limit',
      severity: 'info',
      section: 'billing',
      title: { en: 'You passed your monthly order limit', ar: 'عدّيت حد الطلبات الشهري' },
      message: {
        en: 'Orders still go through, but your plan limit was reached this month. Consider upgrading.',
        ar: 'الطلبات لسه شغّالة، بس وصلت لحد باقتك الشهر ده. فكّر تترقّى لباقة أكبر.',
      },
    });
  }

  if (f.features.tax) {
    const st = f.tax.profileStatus;
    if (st === 'pending') {
      items.push({
        id: 'tax_review_pending',
        severity: 'info',
        section: 'tax',
        title: { en: 'Your VAT details are under review', ar: 'بيانات الضريبة بتتراجع' },
        message: {
          en: 'We are reviewing your tax registration. VAT collection starts once it is approved.',
          ar: 'بنراجع تسجيلك الضريبي. تحصيل الضريبة هيبدأ أول ما يتوافق عليه.',
        },
      });
    } else if (f.tax.enabled && st !== 'verified') {
      items.push({
        id: 'tax_not_verified',
        severity: 'action',
        section: 'tax',
        title: { en: 'VAT is on but not verified', ar: 'الضريبة مفعّلة بس مش موثّقة' },
        message: {
          en: 'You asked to collect VAT, but your tax registration is not verified, so no VAT is added yet. Complete your tax details.',
          ar: 'طلبت تحصّل ضريبة، بس تسجيلك الضريبي لسه مش موثّق، فمفيش ضريبة بتتضاف. كمّل بياناتك الضريبية.',
        },
      });
    }
  }

  if (f.features.whatsapp && !f.chatLinked) {
    items.push({
      id: 'chat_not_connected',
      severity: 'info',
      section: 'settings',
      title: { en: 'Ebda Chat is not connected', ar: 'Ebda Chat مش متوصّل' },
      message: {
        en: 'Connect your WhatsApp number to answer customers and send order updates.',
        ar: 'وصّل رقم الواتساب بتاعك علشان ترد على العملاء وتبعتلهم تحديثات الطلبات.',
      },
    });
  }

  if (f.features.staffAccounts && f.pendingStaffInvites > 0) {
    items.push({
      id: 'staff_invites_pending',
      severity: 'info',
      section: 'staff',
      title: { en: 'Staff invitations are waiting', ar: 'دعوات فريق مستنية الرد' },
      message: {
        en: 'Some people you invited have not accepted yet. Resend or cancel the invitation.',
        ar: 'ناس دعيتهم لسه ما قبلوش. ابعت الدعوة تاني أو الغيها.',
      },
      count: f.pendingStaffInvites,
    });
  }

  return items;
}
