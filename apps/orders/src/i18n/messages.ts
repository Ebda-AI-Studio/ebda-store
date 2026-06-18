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
    discount: string;
    total: string;
    notes: string;
    customerNotes: string;
    payment: string;
    paymentStatus: string;
    notFound: string;
    updateStatus: string;
    markPaid: string;
    updating: string;
    statusUpdated: string;
    paidMarked: string;
    readOnly: string;
    qty: string;
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
      discount: 'Discount',
      total: 'Total',
      notes: 'Internal notes',
      customerNotes: 'Customer notes',
      payment: 'Payment',
      paymentStatus: 'Payment status',
      notFound: 'Order not found.',
      updateStatus: 'Update status',
      markPaid: 'Mark as paid',
      updating: 'Updating…',
      statusUpdated: 'Status updated',
      paidMarked: 'Order marked as paid',
      readOnly: 'You have read-only access to orders.',
      qty: 'Qty',
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
      discount: 'الخصم',
      total: 'الإجمالي',
      notes: 'ملاحظات داخلية',
      customerNotes: 'ملاحظات العميل',
      payment: 'الدفع',
      paymentStatus: 'حالة الدفع',
      notFound: 'لم يتم العثور على الطلب.',
      updateStatus: 'تحديث الحالة',
      markPaid: 'تعليم كمدفوع',
      updating: 'جارٍ التحديث…',
      statusUpdated: 'تم تحديث الحالة',
      paidMarked: 'تم تعليم الطلب كمدفوع',
      readOnly: 'لديك صلاحية عرض الطلبات فقط.',
      qty: 'الكمية',
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
