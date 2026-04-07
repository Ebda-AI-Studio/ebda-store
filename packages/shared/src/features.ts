// Feature Toggle Engine — Feature Registry
import { z } from 'zod';

// All 21 toggleable feature keys
export const FEATURE_KEYS_ARRAY = [
  'coupons',
  'loyalty',
  'returns',
  'reviews',
  'inventory',
  'tax',
  'bulk_operations',
  'customer_wallet',
  'upsell_crosssell',
  'whatsapp',
  'sms',
  'push_notifications',
  'email_campaigns',
  'abandoned_cart',
  'affiliate',
  'marketing_pixels',
  'shipping_carriers',
  'staff_accounts',
  'pwa',
  'seo',
  'search_autocomplete',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS_ARRAY)[number];

export type FeatureCategory = 'commerce' | 'marketing' | 'operations' | 'storefront';

export interface FeatureDefinition {
  key: FeatureKey;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  category: FeatureCategory;
}

export const FEATURE_REGISTRY: Record<FeatureKey, FeatureDefinition> = {
  coupons: {
    key: 'coupons',
    name: 'Coupons',
    nameAr: 'الكوبونات',
    description: 'Create and manage discount coupons for customers.',
    descriptionAr: 'إنشاء وإدارة كوبونات الخصم للعملاء.',
    category: 'commerce',
  },
  loyalty: {
    key: 'loyalty',
    name: 'Loyalty Program',
    nameAr: 'برنامج الولاء',
    description: 'Reward repeat customers with points and redeemable benefits.',
    descriptionAr: 'مكافأة العملاء المتكررين بالنقاط والمزايا القابلة للاسترداد.',
    category: 'commerce',
  },
  returns: {
    key: 'returns',
    name: 'Returns & Refunds',
    nameAr: 'المرتجعات والمبالغ المستردة',
    description: 'Manage product returns and process customer refunds.',
    descriptionAr: 'إدارة مرتجعات المنتجات ومعالجة استردادات العملاء.',
    category: 'commerce',
  },
  reviews: {
    key: 'reviews',
    name: 'Product Reviews',
    nameAr: 'تقييمات المنتجات',
    description: 'Allow customers to leave ratings and reviews on products.',
    descriptionAr: 'السماح للعملاء بترك التقييمات والمراجعات على المنتجات.',
    category: 'commerce',
  },
  inventory: {
    key: 'inventory',
    name: 'Inventory Management',
    nameAr: 'إدارة المخزون',
    description: 'Track stock levels, set low-stock alerts, and manage warehouses.',
    descriptionAr: 'تتبع مستويات المخزون وتعيين تنبيهات انخفاض المخزون وإدارة المستودعات.',
    category: 'commerce',
  },
  tax: {
    key: 'tax',
    name: 'Tax Management',
    nameAr: 'إدارة الضرائب',
    description: 'Configure tax rates and rules for different regions.',
    descriptionAr: 'تكوين معدلات الضرائب والقواعد للمناطق المختلفة.',
    category: 'commerce',
  },
  bulk_operations: {
    key: 'bulk_operations',
    name: 'Bulk Operations',
    nameAr: 'العمليات الجماعية',
    description: 'Perform bulk edits on products, orders, and customers at once.',
    descriptionAr: 'إجراء تعديلات جماعية على المنتجات والطلبات والعملاء دفعة واحدة.',
    category: 'operations',
  },
  customer_wallet: {
    key: 'customer_wallet',
    name: 'Customer Wallet',
    nameAr: 'محفظة العميل',
    description: 'Enable store credit wallets for customers to store and spend funds.',
    descriptionAr: 'تمكين محافظ رصيد المتجر للعملاء لتخزين الأموال وإنفاقها.',
    category: 'commerce',
  },
  upsell_crosssell: {
    key: 'upsell_crosssell',
    name: 'Upsell & Cross-sell',
    nameAr: 'البيع الإضافي والبيع المتقاطع',
    description: 'Suggest related or upgraded products to increase average order value.',
    descriptionAr: 'اقتراح منتجات ذات صلة أو محسّنة لزيادة متوسط قيمة الطلب.',
    category: 'commerce',
  },
  whatsapp: {
    key: 'whatsapp',
    name: 'WhatsApp Notifications',
    nameAr: 'إشعارات واتساب',
    description: 'Send order updates and promotions to customers via WhatsApp.',
    descriptionAr: 'إرسال تحديثات الطلبات والعروض الترويجية للعملاء عبر واتساب.',
    category: 'marketing',
  },
  sms: {
    key: 'sms',
    name: 'SMS Notifications',
    nameAr: 'إشعارات الرسائل القصيرة',
    description: 'Send transactional and promotional SMS messages to customers.',
    descriptionAr: 'إرسال رسائل قصيرة للمعاملات والعروض الترويجية للعملاء.',
    category: 'marketing',
  },
  push_notifications: {
    key: 'push_notifications',
    name: 'Push Notifications',
    nameAr: 'الإشعارات الفورية',
    description: 'Send browser and mobile push notifications to subscribed customers.',
    descriptionAr: 'إرسال إشعارات فورية للمتصفح والهاتف للعملاء المشتركين.',
    category: 'marketing',
  },
  email_campaigns: {
    key: 'email_campaigns',
    name: 'Email Campaigns',
    nameAr: 'حملات البريد الإلكتروني',
    description: 'Create and send marketing email campaigns to customer segments.',
    descriptionAr: 'إنشاء وإرسال حملات البريد الإلكتروني التسويقية لشرائح العملاء.',
    category: 'marketing',
  },
  abandoned_cart: {
    key: 'abandoned_cart',
    name: 'Abandoned Cart Recovery',
    nameAr: 'استرداد عربة التسوق المتروكة',
    description: 'Automatically remind customers who left items in their cart.',
    descriptionAr: 'تذكير العملاء تلقائيًا الذين تركوا عناصر في عربة التسوق الخاصة بهم.',
    category: 'marketing',
  },
  affiliate: {
    key: 'affiliate',
    name: 'Affiliate Program',
    nameAr: 'برنامج التسويق بالعمولة',
    description: 'Let partners earn commissions by referring customers to your store.',
    descriptionAr: 'السماح للشركاء بكسب عمولات من خلال إحالة العملاء إلى متجرك.',
    category: 'marketing',
  },
  marketing_pixels: {
    key: 'marketing_pixels',
    name: 'Marketing Pixels',
    nameAr: 'بكسلات التسويق',
    description: 'Integrate tracking pixels for Facebook, Google, TikTok, and more.',
    descriptionAr: 'دمج بكسلات التتبع لـ Facebook وGoogle وTikTok والمزيد.',
    category: 'marketing',
  },
  shipping_carriers: {
    key: 'shipping_carriers',
    name: 'Shipping Carriers',
    nameAr: 'شركات الشحن',
    description: 'Connect with shipping carriers for real-time rates and label printing.',
    descriptionAr: 'الاتصال بشركات الشحن للحصول على أسعار فورية وطباعة الملصقات.',
    category: 'operations',
  },
  staff_accounts: {
    key: 'staff_accounts',
    name: 'Staff Accounts',
    nameAr: 'حسابات الموظفين',
    description: 'Add team members with role-based permissions to manage the store.',
    descriptionAr: 'إضافة أعضاء الفريق بأذونات قائمة على الأدوار لإدارة المتجر.',
    category: 'operations',
  },
  pwa: {
    key: 'pwa',
    name: 'Progressive Web App',
    nameAr: 'تطبيق الويب التقدمي',
    description: 'Enable PWA support so customers can install the store as a mobile app.',
    descriptionAr: 'تمكين دعم PWA حتى يتمكن العملاء من تثبيت المتجر كتطبيق للهاتف المحمول.',
    category: 'storefront',
  },
  seo: {
    key: 'seo',
    name: 'SEO Tools',
    nameAr: 'أدوات تحسين محركات البحث',
    description: 'Advanced SEO settings including meta tags, sitemaps, and structured data.',
    descriptionAr:
      'إعدادات SEO المتقدمة بما في ذلك العلامات الوصفية وخرائط الموقع والبيانات المنظمة.',
    category: 'storefront',
  },
  search_autocomplete: {
    key: 'search_autocomplete',
    name: 'Search Autocomplete',
    nameAr: 'الإكمال التلقائي للبحث',
    description: 'Provide real-time search suggestions as customers type in the search bar.',
    descriptionAr: 'توفير اقتراحات بحث فورية أثناء كتابة العملاء في شريط البحث.',
    category: 'storefront',
  },
};

// Zod Schemas
export const featureKeySchema = z.enum(FEATURE_KEYS_ARRAY);

// Use generic string keys + manual validation so partial updates work in
// Zod 3.23+ (enum-keyed records require all keys to be present otherwise).
export const featureUpdatesSchema = z
  .record(z.string(), z.boolean())
  .refine(val => Object.keys(val).length > 0, {
    message: 'At least one feature update must be provided.',
  })
  .refine(val => Object.keys(val).every(k => FEATURE_KEYS_ARRAY.includes(k as FeatureKey)), {
    message: 'Unknown feature key in update.',
  });
