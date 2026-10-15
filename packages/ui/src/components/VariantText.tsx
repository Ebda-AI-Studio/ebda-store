import { Fragment } from 'react';
import { variantTitleSegments } from '@ebda/shared';

/**
 * A variant title ("وردي / M / 54 سم") as one `<bdi>` per option value, joined " · ".
 *
 * As one bidi run, mixed Arabic and Latin values reorder: "وردي / M / 54 سم" rendered as
 * "وردي / 54 / M سم", the unit glued to the size (F8; a seamstress reading the pick list
 * could swap size and length). Isolating each value keeps the merchant's order in both
 * directions. Every surface that prints a variant title uses it: storefront cart page and
 * drawer, every CartTable, receipt, account order detail; admin and orders-PWA order items
 * and the scan-to-pick list.
 */
export function VariantText({ title }: { title: string }) {
  return (
    <>
      {variantTitleSegments(title).map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          <bdi>{part}</bdi>
        </Fragment>
      ))}
    </>
  );
}
