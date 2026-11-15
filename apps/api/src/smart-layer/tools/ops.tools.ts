/**
 * Phase E2 (plan 4): the operations tools of the Store assistant, split by area into ops-orders, ops-inventory and ops-people. Every write is a
 * `change()` whose gate mirrors the admin route line for line and whose `run` calls the SAME service the route calls.
 */
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { opsInventoryTools } from './ops-inventory.tools';
import { opsOrdersTools } from './ops-orders.tools';
import { opsPeopleTools } from './ops-people.tools';

// pq-allow(unused-export): wired into changeTools() by the controller after phase E
export function opsTools(): ToolSpec[] {
  return [...opsOrdersTools(), ...opsInventoryTools(), ...opsPeopleTools()];
}
