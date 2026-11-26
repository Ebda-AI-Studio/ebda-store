import { z } from 'zod/v3';
import { AppError } from '../../middleware/error-handler';
import { getSystemAccountIdByCode } from './account.service';
import { postManualEntry, type JournalLineInput } from './journal.service';
import type { JournalEntry } from '@prisma/client';

/**
 * A gateway payout or a COD remittance as ONE balanced entry (ACCT-AUDIT-11).
 *
 * Sales are booked to a cash-in-transit account when they are paid (1000 online, 1010 card, 1020 COD), at the GROSS amount.
 * The bank later receives the gross minus the gateway's / carrier's fee, in a batch. Booking that receipt is:
 *
 *   DR bank account          (gross - fee)
 *   DR Bank Fees (5800)      (fee)            -- only when the fee is above zero
 *   CR cash-in-transit       (gross)
 *
 * so the in-transit balance clears and the bank line on the statement matches a ledger line. Integer piastres only.
 */
interface PayoutInput {
  fromAccountId: string;
  bankAccountId: string;
  feeAccountId: string;
  grossMinor: number;
  feeMinor: number;
  reference?: string;
}

// pq-allow(unused-export): test seam, imported by tests/unit/payout-entry.test.ts (runs the lines through the real DO journal)
export function buildPayoutLines(p: PayoutInput): JournalLineInput[] {
  if (!Number.isSafeInteger(p.grossMinor) || p.grossMinor <= 0)
    throw new AppError(422, 'PAYOUT_BAD_AMOUNT', 'The payout amount must be above zero.');
  if (!Number.isSafeInteger(p.feeMinor) || p.feeMinor < 0 || p.feeMinor >= p.grossMinor)
    throw new AppError(
      422,
      'PAYOUT_BAD_FEE',
      'The fee must be zero or more and less than the payout.'
    );
  if (p.fromAccountId === p.bankAccountId)
    throw new AppError(
      422,
      'PAYOUT_SAME_ACCOUNT',
      'The bank account must differ from the source account.'
    );
  const ref = p.reference ? ` (${p.reference})` : '';
  return [
    {
      accountId: p.bankAccountId,
      debit: p.grossMinor - p.feeMinor,
      credit: 0,
      lineMemo: `Payout received${ref}`,
    },
    ...(p.feeMinor > 0
      ? [{ accountId: p.feeAccountId, debit: p.feeMinor, credit: 0, lineMemo: `Payout fee${ref}` }]
      : []),
    {
      accountId: p.fromAccountId,
      debit: 0,
      credit: p.grossMinor,
      lineMemo: `Payout settled${ref}`,
    },
  ];
}

export const payoutSchema = z.object({
  fromAccountId: z.string().uuid(),
  bankAccountId: z.string().uuid(),
  grossMinor: z.number().int().positive(),
  feeMinor: z.number().int().min(0).default(0),
  postedAt: z.string().datetime().optional(),
  reference: z.string().trim().max(120).optional(),
});

export async function postPayout(
  storeId: string,
  input: z.infer<typeof payoutSchema>,
  postedBy: string | undefined,
  idempotencyKey?: string
): Promise<JournalEntry> {
  const feeAccountId = await getSystemAccountIdByCode(storeId, '5800');
  const lines = buildPayoutLines({ ...input, feeAccountId });
  return postManualEntry(
    {
      storeId,
      source: 'manual',
      memo: `Payout${input.reference ? ` — ${input.reference}` : ''}`,
      memoAr: `تحويل مستحقات${input.reference ? ` — ${input.reference}` : ''}`,
      postedAt: input.postedAt ? new Date(input.postedAt) : undefined,
      postedBy,
      lines,
    },
    idempotencyKey
  );
}
