import { escapeHtml } from './_util';

export interface LowStockAlertItem {
  productId: string;
  name: string;
  nameAr: string | null;
  inventory: number;
  lowStockThreshold: number;
}

export interface LowStockAlertData {
  items: LowStockAlertItem[];
  storeName: string;
  adminUrl: string;
}

export const lowStockAlertTemplate = {
  subject: {
    en: (d: LowStockAlertData) =>
      `Low stock alert — ${d.items.length} product${
        d.items.length === 1 ? '' : 's'
      } need attention`,
    ar: (d: LowStockAlertData) =>
      `تنبيه المخزون المنخفض — ${d.items.length} ${
        d.items.length === 1 ? 'منتج يحتاج' : 'منتجات تحتاج'
      } إلى اهتمام`,
  },

  en: (d: LowStockAlertData) => `
    <h2>Low Stock Alert</h2>
    <p>The following products in <strong>${escapeHtml(
      d.storeName
    )}</strong> are running low and need to be restocked.</p>
    <table class="order-table">
      <thead>
        <tr>
          <th>Product</th>
          <th>Current Stock</th>
          <th>Threshold</th>
        </tr>
      </thead>
      <tbody>
        ${d.items
          .map(
            item => `
          <tr>
            <td>${escapeHtml(item.name)}</td>
            <td><strong style="color: #dc2626;">${item.inventory}</strong></td>
            <td>${item.lowStockThreshold}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.adminUrl)}/inventory" class="button">Manage Inventory</a>
    </p>
    <p style="font-size: 13px; color: #64748b;">
      You are receiving this alert because stock levels have dropped below the configured threshold.
      To adjust thresholds or notification settings, visit your store settings.
    </p>
  `,

  ar: (d: LowStockAlertData) => `
    <h2>تنبيه المخزون المنخفض</h2>
    <p>المنتجات التالية في <strong>${escapeHtml(
      d.storeName
    )}</strong> وصلت إلى مستوى منخفض وتحتاج إلى إعادة تخزين.</p>
    <table class="order-table">
      <thead>
        <tr>
          <th>المنتج</th>
          <th>المخزون الحالي</th>
          <th>الحد الأدنى</th>
        </tr>
      </thead>
      <tbody>
        ${d.items
          .map(
            item => `
          <tr>
            <td>${escapeHtml(item.nameAr ?? item.name)}</td>
            <td><strong style="color: #dc2626;">${item.inventory}</strong></td>
            <td>${item.lowStockThreshold}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.adminUrl)}/inventory" class="button">إدارة المخزون</a>
    </p>
    <p style="font-size: 13px; color: #64748b;">
      تتلقى هذا التنبيه لأن مستويات المخزون انخفضت عن الحد المُحدد.
      لضبط الحدود أو إعدادات الإشعارات، قم بزيارة إعدادات المتجر.
    </p>
  `,
};
