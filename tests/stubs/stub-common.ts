/** Shared bits of the local gateway stubs the SP6b adapters are tested against. */
import { PaymentProviderError } from '@api/services/payment-providers/types';

export type StubFault = 'timeout' | 'unavailable' | 'rejected';

/** Fault injection common to every stub: the NEXT call hangs, fails to connect, or is refused (HTTP 422). */
export class FaultGate {
  private next: StubFault | null = null;
  /** While set, EVERY call fails this way (a gateway that is down, not a one-off). */
  down: StubFault | null = null;

  injectNextCall(fault: StubFault): void {
    this.next = fault;
  }

  /** Called at the top of every request; returns a Response to short-circuit with, or throws / hangs. */
  async enter(): Promise<Response | null> {
    const f = this.next ?? this.down;
    this.next = null;
    if (f === 'timeout') await new Promise(() => undefined);
    if (f === 'unavailable') throw new TypeError('fetch failed: ECONNREFUSED');
    if (f === 'rejected') return json(422, { message: 'gateway said no' });
    return null;
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function readJson(init?: RequestInit): Promise<Record<string, unknown>> {
  const raw = init?.body;
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new PaymentProviderError('PROVIDER_REJECTED', 'stub: body is not JSON');
  }
}

export function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
}
