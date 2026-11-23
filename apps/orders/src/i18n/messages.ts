/**
 * Lightweight client-side i18n for the Orders PWA. The full admin uses
 * next-intl with server-side locale negotiation; this PWA is fully
 * client-rendered (offline-installable) so a flat client dictionary + a
 * localStorage-persisted locale is the right fit — no server round-trip,
 * works offline.
 */
import { BRAND } from '@ebda/shared';

export type Locale = 'en' | 'ar';

export interface Messages {
  appName: string;
  login: {
    title: string;
    subtitle: string;
    email: string;
    password: string;
    submit: string;
    submitting: string;
    invalidEmail: string;
    passwordRequired: string;
    failed: string;
    invalidCredentials: string;
    emailNotVerified: string;
    tooManyAttempts: string;
    invalidCode: string;
    serverError: string;
    adminOnly: string;
    rememberMe: string;
    mfaTitle: string;
    mfaSubtitle: string;
    mfaCodeLabel: string;
    mfaVerify: string;
    mfaCodeRequired: string;
    back: string;
  };
  store: {
    pick: string;
    all: string;
    none: string;
  };
  orders: {
    title: string;
    empty: string;
    emptyFiltered: string;
    loading: string;
    retry: string;
    error: string;
    refresh: string;
    items: string;
    newOrderToast: string;
  };
  dateRange: {
    today: string;
    last7: string;
    last30: string;
    custom: string;
    from: string;
    to: string;
    apply: string;
  };
  search: {
    placeholder: string;
    clear: string;
    count: string;
  };
  bulk: {
    selected: string;
    markPaid: string;
    markPaidConfirm: string;
    processing: string;
    clearSelection: string;
    markPaidSuccess: string;
    markPaidError: string;
    readOnly: string;
  };
  perPage: {
    label: string;
  };
  filters: Record<string, string>;
  status: Record<string, string>;
  /** InstaPay: the merchant confirms a manual transfer arrived (one-thumb flow). */
  instapay: {
    confirm: string;
    sheetTitle: string;
    sheetBody: string;
    sheetYes: string;
    sheetNo: string;
    confirmed: string;
    alreadyConfirmed: string;
    failed: string;
    expired: string;
    reference: string;
    waiting: string;
  };
  detail: {
    back: string;
    customer: string;
    phone: string;
    email: string;
    address: string;
    items: string;
    summary: string;
    subtotal: string;
    tax: string;
    shipping: string;
    deliveryFee: string;
    codFee: string;
    taxIncluded: string;
    discount: string;
    coupon: string;
    promotion: string;
    /** Loyalty-points redemption portion of the discount (issue 197). */
    loyaltyPoints: string;
    total: string;
    /** Customer wallet (D1) — store credit applied to this order. */
    paidFromWallet: string;
    /** Customer wallet (D1) — what the gateway / courier collects. */
    amountDue: string;
    notes: string;
    customerNotes: string;
    payment: string;
    paymentStatus: string;
    paymentMethod: string;
    paymentTransactionId: string;
    paymentLink: string;
    paid: string;
    unpaid: string;
    remain: string;
    refunded: string;
    disputed: string;
    refundedAmount: string;
    delivery: string;
    deliverTo: string;
    deliverBy: string;
    deliverAt: string;
    selfShipping: string;
    callCustomer: string;
    whatsappCustomer: string;
    itemCount: string;
    viewAll: string;
    showLess: string;
    bundleBadge: string;
    notFound: string;
    updateStatus: string;
    markPaid: string;
    updating: string;
    statusUpdated: string;
    paidMarked: string;
    readOnly: string;
    qty: string;
    personalisation: string;
    copy: string;
    copied: string;
    timeline: string;
    timelineEmpty: string;
    timelineBy: string;
    openInvoice: string;
    emailInvoice: string;
    address_block: string;
    address_street: string;
    address_avenue: string;
    address_house: string;
    address_building: string;
    address_floor: string;
    address_apt: string;
    documents: {
      title: string;
      empty: string;
      loadFailed: string;
      issued: string;
      cancelled: string;
      types: Record<string, string>;
    };
    actions: {
      processed: string;
      cancel: string;
      markPaid: string;
      paymentLink: string;
      paymentLinkExisting: string;
      issueNewLink: string;
      copyLink: string;
      linkCopied: string;
      clipboardError: string;
      issueModalTitle: string;
      issueModalDesc: string;
      copyLinkDesc: string;
      issuing: string;
      linkGenerated: string;
      paymentUrl: string;
      done: string;
      issueLinkFailed: string;
      refreshPayment: string;
      refreshChecking: string;
      refreshFailed: string;
      paymentUpdatedTo: string;
      providerStatusNoChange: string;
      refundViaProvider: string;
      refundChecking: string;
      refundModalTitle: string;
      refundModalDesc: string;
      refundModalEffects: string;
      refundReasonLabel: string;
      refundReasonPlaceholder: string;
      refundNow: string;
      refunding: string;
      refundRequested: string;
      refundFailed: string;
      refreshRefund: string;
      refreshRefundChecking: string;
      refreshRefundFailed: string;
      refundStatusCompleted: string;
      refundStatusFailed: string;
      refundStatusPending: string;
      refundStatusNoChange: string;
      emailInvoiceSent: string;
      emailInvoiceNoEmail: string;
      emailInvoiceFailed: string;
      invoiceOpenFailed: string;
      manualRefundTitle: string;
      manualRefundDesc: string;
      manualRefundConfirm: string;
      manualRefundMethodLabel: string;
      manualRefundMethods: Record<string, string>;
      manualRefundReferenceLabel: string;
      manualRefundReferencePlaceholder: string;
      manualRefundFailed: string;
    };
  };
  nav: {
    orders: string;
    logout: string;
  };
  install: {
    cta: string;
    dismiss: string;
  };
  notifications: {
    title: string;
    body: string;
    enable: string;
    enabling: string;
    dismiss: string;
    enabled: string;
    denied: string;
    failed: string;
    swNotReady: string;
    serverError: string;
    iosHint: string;
  };
  notFound: {
    line: string;
    hint: string;
    searchOrders: string;
    orders: string;
    home: string;
    backToSite: string;
  };
}

export const MESSAGES: Record<Locale, Messages> = {
  en: {
    appName: `${BRAND.product.nameEn} Orders`,
    login: {
      title: `${BRAND.product.nameEn} Orders`,
      subtitle: 'Sign in to manage your orders.',
      email: 'Email',
      password: 'Password',
      submit: 'Sign in',
      submitting: 'Signing in…',
      invalidEmail: 'Enter a valid email address.',
      passwordRequired: 'Password is required.',
      failed: 'We could not sign you in. Try again.',
      invalidCredentials: 'The email or password is not right. Check them and try again.',
      emailNotVerified: 'Verify your email first. We sent you a code.',
      tooManyAttempts: 'Too many attempts. Wait a few minutes and try again.',
      invalidCode: 'That code is wrong or has expired. Try again.',
      serverError: 'Something went wrong on our side. Try again in a moment.',
      adminOnly: 'This app is for store staff. Customer accounts cannot sign in here.',
      rememberMe: 'Remember me',
      mfaTitle: 'Two-factor authentication',
      mfaSubtitle: 'Enter the 6-digit code from your authenticator app (or a backup code).',
      mfaCodeLabel: 'Authentication code',
      mfaVerify: 'Verify',
      mfaCodeRequired: 'Enter your authentication code.',
      back: 'Back',
    },
    store: {
      pick: 'Store',
      all: 'All stores',
      none: 'No stores available.',
    },
    orders: {
      title: 'Orders',
      empty: 'No orders yet.',
      emptyFiltered: 'No orders match this filter.',
      loading: 'Loading orders…',
      retry: 'Retry',
      error: 'Could not load orders.',
      refresh: 'Refresh',
      items: 'items',
      newOrderToast: 'New order received',
    },
    dateRange: {
      today: 'Today',
      last7: 'Last 7 days',
      last30: 'Last 30 days',
      custom: 'Custom',
      from: 'From',
      to: 'To',
      apply: 'Apply',
    },
    search: {
      placeholder: 'Search by order # or customer…',
      clear: 'Clear search',
      count: 'Orders: {count}',
    },
    bulk: {
      selected: '{count} selected',
      markPaid: 'Mark paid',
      markPaidConfirm: 'Mark {count} order(s) as paid?',
      processing: 'Processing…',
      clearSelection: 'Clear',
      markPaidSuccess: '{count} order(s) marked as paid',
      markPaidError: 'Could not mark orders as paid',
      readOnly: 'You need manage permission to bulk-mark orders.',
    },
    perPage: {
      label: 'per page',
    },
    filters: {
      all: 'All',
      new: 'New',
      awaiting: 'Awaiting InstaPay',
      paid: 'Paid',
      processing: 'Processing',
      shipped: 'Shipped',
      delivered: 'Delivered',
    },
    status: {
      pending: 'New',
      awaiting_payment_confirmation: 'Awaiting InstaPay',
      confirmed: 'Confirmed',
      processing: 'Processing',
      shipped: 'Shipped',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
      refunded: 'Refunded',
      disputed: 'Disputed',
    },
    instapay: {
      confirm: 'Payment received',
      sheetTitle: 'Did the transfer arrive?',
      sheetBody:
        'Confirm only if you can see {amount} in your InstaPay account. The order then becomes confirmed and can ship.',
      sheetYes: 'Yes, payment received',
      sheetNo: 'Not yet',
      confirmed: 'Payment confirmed',
      alreadyConfirmed: 'Already confirmed',
      failed: 'Could not confirm the payment',
      expired: 'The confirmation window has expired',
      reference: 'Customer reference',
      waiting: 'Waiting for the transfer',
    },
    detail: {
      back: 'Back',
      customer: 'Customer',
      phone: 'Phone',
      email: 'Email',
      address: 'Delivery address',
      items: 'Items',
      summary: 'Summary',
      subtotal: 'Subtotal',
      tax: 'Tax',
      shipping: 'Shipping',
      deliveryFee: 'Delivery fee',
      codFee: 'Cash on delivery fee',
      taxIncluded: 'Incl. VAT',
      discount: 'Discount',
      coupon: 'Coupon',
      promotion: 'Promotion',
      loyaltyPoints: 'Loyalty points',
      total: 'Total',
      paidFromWallet: 'Paid from wallet',
      amountDue: 'Amount due',
      notes: 'Internal notes',
      customerNotes: 'Customer notes',
      payment: 'Payment',
      paymentStatus: 'Payment status',
      paymentMethod: 'Payment method',
      paymentTransactionId: 'Transaction ID',
      paymentLink: 'Payment link',
      paid: 'Paid',
      unpaid: 'Unpaid',
      remain: 'Remaining: {amount}',
      refunded: 'Refunded',
      refundedAmount: 'Refunded {amount}',
      delivery: 'Delivery',
      deliverTo: 'Deliver to',
      deliverBy: 'Delivered by',
      deliverAt: 'Delivery date',
      selfShipping: 'Self shipping',
      callCustomer: 'Call',
      whatsappCustomer: 'WhatsApp',
      itemCount: '{count} items',
      viewAll: 'View all',
      showLess: 'Show less',
      bundleBadge: 'Bundle',
      notFound: 'Order not found.',
      updateStatus: 'Update status',
      markPaid: 'Mark as paid',
      updating: 'Updating…',
      statusUpdated: 'Status updated',
      paidMarked: 'Order marked as paid',
      readOnly: 'You have read-only access to orders.',
      qty: 'Qty',
      personalisation: 'Personalisation',
      copy: 'Copy',
      copied: 'Copied',
      timeline: 'Order timeline',
      timelineEmpty: 'No timeline events yet.',
      timelineBy: 'by {name}',
      openInvoice: 'View invoice',
      emailInvoice: 'Email invoice',
      address_block: 'Block',
      address_street: 'Street',
      address_avenue: 'Avenue',
      address_house: 'House',
      address_building: 'Building',
      address_floor: 'Floor',
      address_apt: 'Apt',
      documents: {
        title: 'Documents',
        empty: 'No documents have been issued for this order yet.',
        loadFailed: 'Could not load this order’s documents.',
        issued: 'Issued',
        cancelled: 'Cancelled',
        types: {
          tax_invoice: 'Tax invoice',
          receipt: 'Sales receipt',
          credit_note: 'Credit note',
          refund_receipt: 'Refund receipt',
          order_record: 'Archived order record',
          billing_record: 'Archived subscription billing record',
        },
      },
      actions: {
        processed: 'Mark processed',
        cancel: 'Cancel',
        markPaid: 'Mark as paid',
        paymentLink: 'Payment link',
        paymentLinkExisting: 'Payment link',
        issueNewLink: 'Issue a new link',
        copyLink: 'Copy link',
        linkCopied: 'Link copied to clipboard',
        clipboardError: 'Could not access clipboard — copy the link manually',
        issueModalTitle: 'Issue payment link',
        issueModalDesc: 'Order {order} — generate a payment link to collect payment.',
        copyLinkDesc: 'Generate the URL — copy and share via WhatsApp, email, or any channel.',
        issuing: 'Issuing payment link…',
        linkGenerated: 'Payment link generated',
        paymentUrl: 'Payment URL',
        done: 'Done',
        issueLinkFailed: 'Failed to issue payment link',
        refreshPayment: 'Refresh payment',
        refreshChecking: 'Checking…',
        refreshFailed: 'Refresh failed',
        paymentUpdatedTo: 'Payment status updated to {status}',
        providerStatusNoChange: 'Provider status: {status} (no change)',
        refundViaProvider: 'Refund via provider',
        refundChecking: 'Refunding…',
        refundModalTitle: 'Refund order {order}?',
        refundModalDesc:
          'A refund of {amount} will be sent to the payment provider. The customer’s card typically reflects it in 1–3 business days.',
        refundModalEffects:
          'Inventory will be restored, coupon usage decremented, loyalty points reversed, and the customer notified by email. This cannot be undone.',
        refundReasonLabel: 'Reason (optional, shown to the customer)',
        refundReasonPlaceholder: 'Out of stock, customer request, duplicate charge…',
        refundNow: 'Refund now',
        refunding: 'Refunding…',
        refundRequested:
          'Refund of {amount} requested via {provider} — reflects in 1–3 business days',
        refundFailed: 'Refund failed',
        refreshRefund: 'Refresh refund status',
        refreshRefundChecking: 'Checking refund…',
        refreshRefundFailed: 'Refund status refresh failed',
        refundStatusCompleted: 'Refund completed — customer card has been credited',
        refundStatusFailed: 'Refund canceled by provider',
        refundStatusPending: 'Refund still pending finance team review',
        refundStatusNoChange: 'Refund still {status} (no change)',
        emailInvoiceSent: 'Invoice email queued',
        emailInvoiceNoEmail: 'Order has no customer email on file',
        emailInvoiceFailed: 'Could not queue invoice email',
        invoiceOpenFailed: 'Could not open invoice',
        manualRefundTitle: 'Mark order as refunded?',
        manualRefundDesc:
          'Confirm only after you have already given the customer their money back. The customer will be told their refund was issued. This records the refund — it does not send any money.',
        manualRefundConfirm: 'Mark refunded',
        manualRefundMethodLabel: 'How did you refund the customer?',
        manualRefundMethods: {
          cash: 'Cash',
          instapay: 'InstaPay',
          bank_transfer: 'Bank transfer',
          store_credit: 'Store credit',
          other: 'Other',
        },
        manualRefundReferenceLabel: 'Reference (optional)',
        manualRefundReferencePlaceholder: 'Transfer number or a short note',
        manualRefundFailed: 'Could not record the refund. Please try again.',
      },
    },
    nav: {
      orders: 'Orders',
      logout: 'Sign out',
    },
    install: {
      cta: 'Install app',
      dismiss: 'Not now',
    },
    notifications: {
      title: 'Get new-order alerts',
      body: 'Enable notifications to be pinged the moment a new order arrives.',
      enable: 'Enable',
      enabling: 'Enabling…',
      dismiss: 'Not now',
      enabled: 'Notifications enabled',
      denied: 'Notifications are blocked. Enable them in your browser settings.',
      failed: 'Could not enable notifications. Try again.',
      swNotReady:
        "Couldn't start the app's background worker. Fully close the app and reopen it, then try again.",
      serverError: 'The server rejected the subscription. Please try again, or contact support.',
      iosHint: 'Install the app first (Share → Add to Home Screen), then open it to enable alerts.',
    },
    notFound: {
      line: "The page you're looking for can't be found.",
      hint: 'Search your orders, or go to a section.',
      searchOrders: 'Search orders',
      orders: 'Orders',
      home: 'Home',
      backToSite: 'Back to the Ebda AI Studio site',
    },
  },
  ar: {
    appName: `طلبات متجر ${BRAND.product.nameAr}`,
    login: {
      title: `طلبات متجر ${BRAND.product.nameAr}`,
      subtitle: 'سجّل دخولك وتابع طلباتك.',
      email: 'البريد الإلكتروني',
      password: 'كلمة المرور',
      submit: 'تسجيل الدخول',
      submitting: 'جارٍ تسجيل الدخول…',
      invalidEmail: 'اكتب بريد إلكتروني صحيح.',
      passwordRequired: 'اكتب كلمة السر.',
      failed: 'معرفناش نسجّل دخولك. جرّب تاني.',
      invalidCredentials: 'البريد الإلكتروني أو كلمة السر مش مظبوطين. راجعهم وجرّب تاني.',
      emailNotVerified: 'لازم تأكد بريدك الإلكتروني الأول. بعتنالك كود.',
      tooManyAttempts: 'محاولات كتير. استنى كام دقيقة وجرّب تاني.',
      invalidCode: 'الكود غلط أو خلص وقته. جرّب تاني.',
      serverError: 'حصلت مشكلة من عندنا. جرّب تاني بعد شوية.',
      adminOnly: 'التطبيق ده لفريق المتجر. حسابات العملاء مش بتدخل هنا.',
      rememberMe: 'تذكّرني',
      mfaTitle: 'المصادقة الثنائية',
      mfaSubtitle: 'اكتب الكود المكوّن من 6 أرقام من تطبيق المصادقة (أو كود احتياطي).',
      mfaCodeLabel: 'رمز المصادقة',
      mfaVerify: 'تحقّق',
      mfaCodeRequired: 'اكتب كود المصادقة.',
      back: 'رجوع',
    },
    store: {
      pick: 'المتجر',
      all: 'كل المتاجر',
      none: 'لا توجد متاجر متاحة.',
    },
    orders: {
      title: 'الطلبات',
      empty: 'لا توجد طلبات بعد.',
      emptyFiltered: 'لا توجد طلبات تطابق هذا الفلتر.',
      loading: 'جارٍ تحميل الطلبات…',
      retry: 'إعادة المحاولة',
      error: 'تعذّر تحميل الطلبات.',
      refresh: 'تحديث',
      items: 'منتجات',
      newOrderToast: 'تم استلام طلب جديد',
    },
    dateRange: {
      today: 'اليوم',
      last7: 'آخر 7 أيام',
      last30: 'آخر 30 يومًا',
      custom: 'مخصص',
      from: 'من',
      to: 'إلى',
      apply: 'تطبيق',
    },
    search: {
      placeholder: 'بحث برقم الطلب أو اسم العميل…',
      clear: 'مسح البحث',
      count: 'عدد الطلبات: {count}',
    },
    bulk: {
      selected: '{count} محدّد',
      markPaid: 'تعليم كمدفوع',
      markPaidConfirm: 'تعليم {count} طلب/طلبات كمدفوعة؟',
      processing: 'جارٍ المعالجة…',
      clearSelection: 'مسح',
      markPaidSuccess: 'تم تعليم {count} طلب/طلبات كمدفوعة',
      markPaidError: 'تعذّر تعليم الطلبات كمدفوعة',
      readOnly: 'تحتاج إلى صلاحية إدارة للتعليم الجماعي.',
    },
    perPage: {
      label: 'لكل صفحة',
    },
    filters: {
      all: 'الكل',
      new: 'جديد',
      awaiting: 'بانتظار إنستاباي',
      paid: 'مدفوع',
      processing: 'قيد التجهيز',
      shipped: 'تم الشحن',
      delivered: 'تم التوصيل',
    },
    status: {
      pending: 'جديد',
      awaiting_payment_confirmation: 'بانتظار إنستاباي',
      confirmed: 'مؤكّد',
      processing: 'قيد التجهيز',
      shipped: 'تم الشحن',
      delivered: 'تم التوصيل',
      cancelled: 'ملغى',
      refunded: 'مُسترد',
    },
    instapay: {
      confirm: 'تم استلام المبلغ',
      sheetTitle: 'هل وصل التحويل؟',
      sheetBody:
        'أكّد فقط إذا رأيت {amount} في حساب إنستاباي الخاص بك. سيصبح الطلب مؤكداً وجاهزاً للشحن.',
      sheetYes: 'نعم، تم استلام المبلغ',
      sheetNo: 'ليس بعد',
      confirmed: 'تم تأكيد الدفع',
      alreadyConfirmed: 'تم تأكيده من قبل',
      failed: 'تعذّر تأكيد الدفع',
      expired: 'انتهت مهلة التأكيد',
      reference: 'مرجع العميل',
      waiting: 'بانتظار التحويل',
    },
    detail: {
      back: 'رجوع',
      customer: 'العميل',
      phone: 'الهاتف',
      email: 'البريد الإلكتروني',
      address: 'عنوان التوصيل',
      items: 'المنتجات',
      summary: 'الملخّص',
      subtotal: 'المجموع الفرعي',
      tax: 'الضريبة',
      shipping: 'الشحن',
      deliveryFee: 'رسوم التوصيل',
      codFee: 'رسوم الدفع عند الاستلام',
      taxIncluded: 'شامل ضريبة القيمة المضافة',
      discount: 'الخصم',
      coupon: 'كوبون',
      promotion: 'عرض ترويجي',
      loyaltyPoints: 'نقاط الولاء',
      total: 'الإجمالي',
      paidFromWallet: 'مدفوع من المحفظة',
      amountDue: 'المبلغ المستحق',
      notes: 'ملاحظات داخلية',
      customerNotes: 'ملاحظات العميل',
      payment: 'الدفع',
      paymentStatus: 'حالة الدفع',
      paymentMethod: 'طريقة الدفع',
      paymentTransactionId: 'رقم العملية',
      paymentLink: 'رابط الدفع',
      paid: 'مدفوع',
      unpaid: 'غير مدفوع',
      remain: 'المتبقّي: {amount}',
      refunded: 'مسترد',
      disputed: 'متنازع عليه',
      refundedAmount: 'المسترد {amount}',
      delivery: 'التوصيل',
      deliverTo: 'التوصيل إلى',
      deliverBy: 'يتم التوصيل بواسطة',
      deliverAt: 'تاريخ التوصيل',
      selfShipping: 'شحن ذاتي',
      callCustomer: 'اتصال',
      whatsappCustomer: 'واتساب',
      itemCount: '{count} منتجات',
      viewAll: 'عرض الكل',
      showLess: 'عرض أقل',
      bundleBadge: 'باقة',
      notFound: 'لم يتم العثور على الطلب.',
      updateStatus: 'تحديث الحالة',
      markPaid: 'تعليم كمدفوع',
      updating: 'جارٍ التحديث…',
      statusUpdated: 'تم تحديث الحالة',
      paidMarked: 'تم تعليم الطلب كمدفوع',
      readOnly: 'لديك صلاحية عرض الطلبات فقط.',
      qty: 'الكمية',
      personalisation: 'التخصيص',
      copy: 'انسخ',
      copied: 'اتنسخ',
      timeline: 'مسار الطلب',
      timelineEmpty: 'لا توجد أحداث حتى الآن.',
      timelineBy: 'بواسطة {name}',
      openInvoice: 'عرض الفاتورة',
      emailInvoice: 'إرسال الفاتورة بالبريد',
      address_block: 'قطعة',
      address_street: 'شارع',
      address_avenue: 'جادة',
      address_house: 'منزل',
      address_building: 'مبنى',
      address_floor: 'دور',
      address_apt: 'شقة',
      documents: {
        title: 'المستندات',
        empty: 'لم يُصدَر أي مستند لهذا الطلب بعد.',
        loadFailed: 'تعذّر تحميل مستندات هذا الطلب.',
        issued: 'صادر',
        cancelled: 'ملغى',
        types: {
          tax_invoice: 'فاتورة ضريبية',
          receipt: 'إيصال بيع',
          credit_note: 'إشعار دائن',
          refund_receipt: 'إيصال استرداد',
          order_record: 'سجل طلب مؤرشف',
          billing_record: 'سجل فاتورة اشتراك مؤرشف',
        },
      },
      actions: {
        processed: 'تعليم كمُجهَّز',
        cancel: 'إلغاء',
        markPaid: 'تعليم كمدفوع',
        paymentLink: 'رابط الدفع',
        paymentLinkExisting: 'رابط الدفع',
        issueNewLink: 'إصدار رابط جديد',
        copyLink: 'نسخ الرابط',
        linkCopied: 'تم نسخ الرابط',
        clipboardError: 'تعذّر الوصول إلى الحافظة — انسخ الرابط يدويًا',
        issueModalTitle: 'إصدار رابط دفع',
        issueModalDesc: 'الطلب {order} — أنشئ رابط دفع لتحصيل المبلغ.',
        copyLinkDesc: 'أنشئ الرابط — انسخه وشاركه عبر واتساب أو البريد أو أي قناة.',
        issuing: 'جارٍ إصدار رابط الدفع…',
        linkGenerated: 'تم إنشاء رابط الدفع',
        paymentUrl: 'رابط الدفع',
        done: 'تم',
        issueLinkFailed: 'فشل إصدار رابط الدفع',
        refreshPayment: 'تحديث الدفع',
        refreshChecking: 'جارٍ التحقّق…',
        refreshFailed: 'فشل التحديث',
        paymentUpdatedTo: 'تم تحديث حالة الدفع إلى {status}',
        providerStatusNoChange: 'حالة المزوّد: {status} (دون تغيير)',
        refundViaProvider: 'استرداد عبر المزوّد',
        refundChecking: 'جارٍ الاسترداد…',
        refundModalTitle: 'استرداد الطلب {order}؟',
        refundModalDesc:
          'سيُرسل طلب استرداد بقيمة {amount} إلى مزوّد الدفع. عادةً ما يظهر على بطاقة العميل خلال 1–3 أيام عمل.',
        refundModalEffects:
          'ستتم إعادة المخزون، وخصم استخدام الكوبون، وعكس نقاط الولاء، وإشعار العميل بالبريد. لا يمكن التراجع عن هذا.',
        refundReasonLabel: 'السبب (اختياري، يظهر للعميل)',
        refundReasonPlaceholder: 'نفاد المخزون، طلب العميل، رسم مكرّر…',
        refundNow: 'استرداد الآن',
        refunding: 'جارٍ الاسترداد…',
        refundRequested: 'تم طلب استرداد {amount} عبر {provider} — يظهر خلال 1–3 أيام عمل',
        refundFailed: 'فشل الاسترداد',
        refreshRefund: 'تحديث حالة الاسترداد',
        refreshRefundChecking: 'جارٍ التحقّق من الاسترداد…',
        refreshRefundFailed: 'فشل تحديث حالة الاسترداد',
        refundStatusCompleted: 'اكتمل الاسترداد — تم إرجاع المبلغ لبطاقة العميل',
        refundStatusFailed: 'أُلغي الاسترداد من المزوّد',
        refundStatusPending: 'الاسترداد لا يزال قيد مراجعة الفريق المالي',
        refundStatusNoChange: 'الاسترداد لا يزال {status} (دون تغيير)',
        emailInvoiceSent: 'تمت جدولة إرسال الفاتورة',
        emailInvoiceNoEmail: 'لا يوجد بريد عميل مسجّل للطلب',
        emailInvoiceFailed: 'تعذّرت جدولة إرسال الفاتورة',
        invoiceOpenFailed: 'تعذّر فتح الفاتورة',
        manualRefundTitle: 'تعليم الطلب كمسترد؟',
        manualRefundDesc:
          'أكّد فقط بعد أن تكون قد أعدت المبلغ إلى العميل فعلاً. سيُبلَّغ العميل بأنه تم إصدار استرداده. هذا الإجراء يسجّل الاسترداد ولا يرسل أي مبلغ.',
        manualRefundConfirm: 'تعليم كمسترد',
        manualRefundMethodLabel: 'كيف أعدت المبلغ إلى العميل؟',
        manualRefundMethods: {
          cash: 'نقداً',
          instapay: 'إنستاباي',
          bank_transfer: 'تحويل بنكي',
          store_credit: 'رصيد في المتجر',
          other: 'أخرى',
        },
        manualRefundReferenceLabel: 'المرجع (اختياري)',
        manualRefundReferencePlaceholder: 'رقم التحويل أو ملاحظة قصيرة',
        manualRefundFailed: 'تعذّر تسجيل الاسترداد. حاول مرة أخرى.',
      },
    },
    nav: {
      orders: 'الطلبات',
      logout: 'تسجيل الخروج',
    },
    install: {
      cta: 'تثبيت التطبيق',
      dismiss: 'ليس الآن',
    },
    notifications: {
      title: 'تنبيهات الطلبات الجديدة',
      body: 'فعّل الإشعارات لتصلك تنبيهات فور وصول طلب جديد.',
      enable: 'تفعيل',
      enabling: 'جارٍ التفعيل…',
      dismiss: 'ليس الآن',
      enabled: 'تم تفعيل الإشعارات',
      denied: 'الإشعارات محظورة. فعّلها من إعدادات المتصفح.',
      failed: 'تعذّر تفعيل الإشعارات. حاول مرة أخرى.',
      swNotReady:
        'تعذّر تشغيل خدمة التطبيق في الخلفية. أغلق التطبيق تمامًا ثم أعد فتحه وحاول مجددًا.',
      serverError: 'رفض الخادم الاشتراك. حاول مرة أخرى أو تواصل مع الدعم.',
      iosHint: 'ثبّت التطبيق أولًا (مشاركة ← إضافة إلى الشاشة الرئيسية) ثم افتحه لتفعيل التنبيهات.',
    },
    notFound: {
      line: 'الصفحة اللي بتدوّر عليها مش موجودة.',
      hint: 'دوّر في طلباتك، أو روح لأي قسم.',
      searchOrders: 'دوّر في الطلبات',
      orders: 'الطلبات',
      home: 'الرئيسية',
      backToSite: 'ارجع لموقع ابدأ ستوديو للذكاء الاصطناعي',
    },
  },
};
