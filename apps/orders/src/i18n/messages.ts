/**
 * Lightweight client-side i18n for the Orders PWA. The full admin uses
 * next-intl with server-side locale negotiation; this PWA is fully
 * client-rendered (offline-installable) so a flat client dictionary + a
 * localStorage-persisted locale is the right fit — no server round-trip,
 * works offline.
 */

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
    adminOnly: string;
    rememberMe: string;
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
    discount: string;
    total: string;
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
    notFound: string;
    updateStatus: string;
    markPaid: string;
    updating: string;
    statusUpdated: string;
    paidMarked: string;
    readOnly: string;
    qty: string;
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
      sendEmail: string;
      issueModalTitle: string;
      issueModalDesc: string;
      copyLinkDesc: string;
      sendEmailDesc: string;
      issuing: string;
      emailSent: string;
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
    iosHint: string;
  };
}

export const MESSAGES: Record<Locale, Messages> = {
  en: {
    appName: 'Force AI Store Orders',
    login: {
      title: 'Force AI Store Orders',
      subtitle: 'Sign in to manage your orders.',
      email: 'Email',
      password: 'Password',
      submit: 'Sign in',
      submitting: 'Signing in…',
      invalidEmail: 'Enter a valid email address.',
      passwordRequired: 'Password is required.',
      failed: 'Sign in failed. Check your credentials.',
      adminOnly: 'This app is for store staff. Customer accounts cannot sign in here.',
      rememberMe: 'Remember me',
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
      paid: 'Paid',
      processing: 'Processing',
      shipped: 'Shipped',
      delivered: 'Delivered',
    },
    status: {
      pending: 'New',
      confirmed: 'Confirmed',
      processing: 'Processing',
      shipped: 'Shipped',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
      refunded: 'Refunded',
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
      discount: 'Discount',
      total: 'Total',
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
      notFound: 'Order not found.',
      updateStatus: 'Update status',
      markPaid: 'Mark as paid',
      updating: 'Updating…',
      statusUpdated: 'Status updated',
      paidMarked: 'Order marked as paid',
      readOnly: 'You have read-only access to orders.',
      qty: 'Qty',
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
        sendEmail: 'Send via email',
        issueModalTitle: 'Issue payment link',
        issueModalDesc: 'Order {order} — generate a MyFatoorah link to collect payment.',
        copyLinkDesc: 'Generate the URL — copy and share via WhatsApp, email, or any channel.',
        sendEmailDesc: 'MyFatoorah delivers the payment link directly to the customer’s email.',
        issuing: 'Issuing payment link…',
        emailSent: 'Email sent to {email}',
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
      iosHint: 'Install the app first (Share → Add to Home Screen), then open it to enable alerts.',
    },
  },
  ar: {
    appName: 'طلبات متجر Force AI',
    login: {
      title: 'طلبات متجر Force AI',
      subtitle: 'سجّل الدخول لإدارة طلباتك.',
      email: 'البريد الإلكتروني',
      password: 'كلمة المرور',
      submit: 'تسجيل الدخول',
      submitting: 'جارٍ تسجيل الدخول…',
      invalidEmail: 'أدخل بريدًا إلكترونيًا صحيحًا.',
      passwordRequired: 'كلمة المرور مطلوبة.',
      failed: 'فشل تسجيل الدخول. تحقّق من بياناتك.',
      adminOnly: 'هذا التطبيق لموظفي المتجر. لا يمكن لحسابات العملاء تسجيل الدخول هنا.',
      rememberMe: 'تذكّرني',
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
      last7: 'آخر ٧ أيام',
      last30: 'آخر ٣٠ يومًا',
      custom: 'مخصص',
      from: 'من',
      to: 'إلى',
      apply: 'تطبيق',
    },
    search: {
      placeholder: 'بحث برقم الطلب أو اسم العميل…',
      clear: 'مسح البحث',
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
      paid: 'مدفوع',
      processing: 'قيد التجهيز',
      shipped: 'تم الشحن',
      delivered: 'تم التوصيل',
    },
    status: {
      pending: 'جديد',
      confirmed: 'مؤكّد',
      processing: 'قيد التجهيز',
      shipped: 'تم الشحن',
      delivered: 'تم التوصيل',
      cancelled: 'ملغى',
      refunded: 'مُسترد',
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
      discount: 'الخصم',
      total: 'الإجمالي',
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
      notFound: 'لم يتم العثور على الطلب.',
      updateStatus: 'تحديث الحالة',
      markPaid: 'تعليم كمدفوع',
      updating: 'جارٍ التحديث…',
      statusUpdated: 'تم تحديث الحالة',
      paidMarked: 'تم تعليم الطلب كمدفوع',
      readOnly: 'لديك صلاحية عرض الطلبات فقط.',
      qty: 'الكمية',
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
        sendEmail: 'إرسال عبر البريد',
        issueModalTitle: 'إصدار رابط دفع',
        issueModalDesc: 'الطلب {order} — أنشئ رابط MyFatoorah لتحصيل الدفع.',
        copyLinkDesc: 'أنشئ الرابط — انسخه وشاركه عبر واتساب أو البريد أو أي قناة.',
        sendEmailDesc: 'يرسل MyFatoorah رابط الدفع مباشرة إلى بريد العميل.',
        issuing: 'جارٍ إصدار رابط الدفع…',
        emailSent: 'تم إرسال البريد إلى {email}',
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
      iosHint: 'ثبّت التطبيق أولًا (مشاركة ← إضافة إلى الشاشة الرئيسية) ثم افتحه لتفعيل التنبيهات.',
    },
  },
};
