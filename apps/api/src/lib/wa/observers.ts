import { setModelWriteObserver } from '@ebda/database';
import { onCatalogWrite } from './catalog-state';
import { onConsentWrite } from './consent-state';
import { onPlanWrite } from './plan-state';
import { onStandingWrite } from './standing-state';

let installed = false;
/**
 * The ONE database write observer of the API: every plan / subscription write and every catalog
 * write tells Ebda Chat (store.plan_changed, catalog.product_*), whichever service, job or
 * route made it. Idempotent; installed by app.ts for the Node shell and the Worker alike.
 */
export function installWaWriteObservers(): void {
  if (installed) return;
  installed = true;
  setModelWriteObserver(e => {
    onPlanWrite(e);
    onStandingWrite(e);
    onCatalogWrite(e);
    onConsentWrite(e);
  });
}
