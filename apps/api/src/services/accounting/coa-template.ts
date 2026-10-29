import type { AccountType } from '@ebda/database';

export interface CoaTemplateRow {
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountType;
  parentCode?: string;
}

/**
 * Egypt small-retail Chart of Accounts. All rows in this template are seeded
 * with isSystem=true and cannot be renamed or deleted by the merchant; they
 * may add custom child accounts (e.g. 5210 "Meta Ads" under 5200 Marketing).
 *
 * Code convention: 1000s=asset, 2000s=liability, 3000s=equity,
 * 4000s=revenue, 5000s=expense. Sibling spacing of 10 leaves room for
 * future system accounts within each band without renumbering.
 */
export const COA_TEMPLATE: CoaTemplateRow[] = [
  { code: '1000', nameEn: 'Cash Online', nameAr: 'كاش مدفوعات إلكترونية', type: 'asset' },
  { code: '1010', nameEn: 'Cash Card', nameAr: 'كاش بطاقات', type: 'asset' },
  { code: '1020', nameEn: 'Cash COD', nameAr: 'كاش الدفع عند الاستلام', type: 'asset' },
  { code: '1030', nameEn: 'Bank Main', nameAr: 'بنك رئيسي', type: 'asset' },
  { code: '1100', nameEn: 'Accounts Receivable', nameAr: 'الذمم المدينة', type: 'asset' },
  { code: '1200', nameEn: 'Inventory', nameAr: 'المخزون', type: 'asset' },
  { code: '2000', nameEn: 'Accounts Payable', nameAr: 'الذمم الدائنة', type: 'liability' },
  { code: '2100', nameEn: 'Tax Payable', nameAr: 'الضريبة المستحقة', type: 'liability' },
  // What the store owes customers as credit (owner decision 2026-10-01, M1-8):
  // 2150 = balances held in the on-platform customer wallet; 2160 = store
  // credit the merchant issues off-platform (the `store_credit` refund method
  // with the customer wallet off). Existing stores get them on first use via
  // getSystemAccountIdByCode's template self-heal.
  {
    code: '2150',
    nameEn: 'Customer Wallet Liability',
    nameAr: 'التزام محفظة العملاء',
    type: 'liability',
  },
  {
    code: '2160',
    nameEn: 'Store Credit Liability',
    nameAr: 'التزام رصيد المتجر',
    type: 'liability',
  },
  { code: '3000', nameEn: "Owner's Equity", nameAr: 'حقوق الملكية', type: 'equity' },
  { code: '3100', nameEn: "Owner's Draws", nameAr: 'سحوبات المالك', type: 'equity' },
  { code: '4000', nameEn: 'Sales Revenue', nameAr: 'إيرادات المبيعات', type: 'revenue' },
  { code: '4010', nameEn: 'Shipping Income', nameAr: 'إيرادات الشحن', type: 'revenue' },
  { code: '4090', nameEn: 'Sales Returns', nameAr: 'مرتجعات المبيعات', type: 'revenue' },
  // Store credit that expired or was forfeited (Ruling WALLET-GL-1): other income, not sales.
  {
    code: '4100',
    nameEn: 'Unused Store Credit',
    nameAr: 'رصيد متجر غير مستخدم',
    type: 'revenue',
  },
  { code: '5000', nameEn: 'Cost of Goods Sold', nameAr: 'تكلفة البضاعة المباعة', type: 'expense' },
  { code: '5010', nameEn: 'COGS Variance', nameAr: 'فرق تكلفة البضاعة', type: 'expense' },
  { code: '5100', nameEn: 'Packaging', nameAr: 'التغليف', type: 'expense' },
  { code: '5200', nameEn: 'Marketing', nameAr: 'تسويق', type: 'expense' },
  { code: '5300', nameEn: 'Salaries', nameAr: 'رواتب', type: 'expense' },
  { code: '5400', nameEn: 'Rent', nameAr: 'إيجار', type: 'expense' },
  { code: '5500', nameEn: 'Utilities', nameAr: 'كهرباء وماء واتصالات', type: 'expense' },
  { code: '5600', nameEn: 'Software', nameAr: 'اشتراكات برمجية', type: 'expense' },
  { code: '5700', nameEn: 'Courier', nameAr: 'شحن وتوصيل', type: 'expense' },
  { code: '5800', nameEn: 'Bank Fees', nameAr: 'رسوم بنكية', type: 'expense' },
  { code: '5900', nameEn: 'Damage / Loss', nameAr: 'تلف وفقد', type: 'expense' },
  { code: '5910', nameEn: 'Theft', nameAr: 'سرقة', type: 'expense' },
  { code: '5920', nameEn: 'Write-off', nameAr: 'شطب', type: 'expense' },
  // Goodwill / admin store credit issued to customers (Ruling WALLET-GL-1).
  {
    code: '5950',
    nameEn: 'Customer Goodwill',
    nameAr: 'مجاملة العملاء',
    type: 'expense',
  },
  { code: '5990', nameEn: 'Other', nameAr: 'متفرقات', type: 'expense' },
];
