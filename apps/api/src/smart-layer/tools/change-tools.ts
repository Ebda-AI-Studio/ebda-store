/** Every write tool of the Store assistant, in one list (plan 4 B6 / C2 / E1-E5). Each module exports a function returning its `ToolSpec`s. */
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { productsTools } from './products.tools';
import { inventoryTools } from './inventory.tools';
import { marketingTools } from './marketing.tools';
import { contentTools } from './content.tools';
import { storeSettingsTools } from './store-settings.tools';
import { seoTools } from './seo.tools';
import { ordersTools } from './orders.tools';
import { returnsTools } from './returns.tools';
import { shippingTools } from './shipping.tools';
import { paymentsTools } from './payments.tools';
import { notificationsTools } from './notifications.tools';
import { customersTools } from './customers.tools';
import { financeTools } from './finance.tools';
import { accountTools } from './account.tools';
import { accountBillingTools } from './account-billing.tools';
import { productsConfirmTools } from './products-confirm.tools';
import { marketingConfirmTools } from './marketing-confirm.tools';

export function changeTools(): ToolSpec[] {
  return [
    ...productsTools(),
    ...inventoryTools(),
    ...marketingTools(),
    ...contentTools(),
    ...storeSettingsTools(),
    ...seoTools(),
    ...ordersTools(),
    ...returnsTools(),
    ...shippingTools(),
    ...paymentsTools(),
    ...notificationsTools(),
    ...customersTools(),
    ...financeTools(),
    ...accountTools(),
    ...accountBillingTools(),
    ...productsConfirmTools(),
    ...marketingConfirmTools(),
  ];
}
