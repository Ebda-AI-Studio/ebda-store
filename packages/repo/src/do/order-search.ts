import { normalizeArabicSearch } from '../../../shared/src/search/arabic-normalize';
import { matchingCustomers, searchOrderNumbers } from './search-customers';
import type { SyncSql } from './sync-sql';

/** The most registered customers / guest orders one admin order search resolves on a DO store (json_each: one bound parameter). */
export const DO_ORDER_SEARCH_CAP = 20_000;

export interface OrderSearchIds {
  /** live orders whose number contains the term (typed text, plus its digits alone for a digits-only term of 4+) */
  numberIds: string[];
  /** registered customers matching name / phone / email */
  userIds: string[];
  /** guest orders (no customer) whose contact snapshot matches */
  guestOrderIds: string[];
  /** a cap was hit: the answer is incomplete, the caller refuses instead of answering a short list */
  truncated: boolean;
}

/**
 * The id sets behind the admin order-list search on a DO store (Ruling CF-R4-1), the DO twin of `orderSearchWhere`'s three
 * lookups (order number, `ebda_customer_search_ids` users + guests). It runs as a money op so the dirty-marked index rows
 * (customers, guest orders: triggers fire INSIDE the order write's own section) are flushed in a section of their own before
 * the read: a search can never see an order that is not committed, nor miss one that is.
 */
export function searchOrderIds(
  db: SyncSql,
  storeId: string,
  search: string,
  numberLimit = DO_ORDER_SEARCH_CAP
): OrderSearchIds {
  const term = (search ?? '').trim();
  if (!term) return { numberIds: [], userIds: [], guestOrderIds: [], truncated: false };
  // Only a term made of digits (with #, spaces, dashes) is also tried as the number's digits alone ("#١٢٣٤" finds "EB-1234").
  const folded = normalizeArabicSearch(term);
  const digits = /^[#\s-]*[0-9][0-9\s-]*$/.test(folded) ? folded.replace(/\D/g, '') : '';
  const numberIds = new Set(searchOrderNumbers(db, storeId, term, numberLimit + 1));
  if (digits.length >= 4 && digits !== term)
    for (const i of searchOrderNumbers(db, storeId, digits, numberLimit + 1)) numberIds.add(i);
  const m = matchingCustomers(db, storeId, term, {
    userCap: DO_ORDER_SEARCH_CAP,
    guestCap: DO_ORDER_SEARCH_CAP,
  });
  return {
    numberIds: [...numberIds].slice(0, numberLimit),
    userIds: m.userIds,
    guestOrderIds: m.guestOrderIds,
    truncated: numberIds.size > numberLimit || m.truncated,
  };
}
