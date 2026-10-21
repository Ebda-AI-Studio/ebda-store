interface ReceiptCharge {
  id: string;
  status: string;
  type: string;
}

/**
 * Which charge's receipt to print. After a card return only THE charge the
 * gateway returned for counts: until the webhook marks it succeeded the page
 * says "processing" instead of printing the previous paid charge's receipt as
 * the one just paid. A receipt the merchant opens by hand wins.
 */
export function pickReceiptCharge<T extends ReceiptCharge>(
  charges: T[],
  sel: { returnChargeId: string | null; openedId: string | null }
): { charge: T | null; processing: boolean } {
  const paid = (c: T | undefined) =>
    c && c.status === 'succeeded' && c.type !== 'refund' ? c : null;
  if (sel.openedId)
    return { charge: paid(charges.find(c => c.id === sel.openedId)), processing: false };
  if (sel.returnChargeId) {
    const c = paid(charges.find(x => x.id === sel.returnChargeId));
    return { charge: c, processing: c === null };
  }
  return { charge: null, processing: false };
}
