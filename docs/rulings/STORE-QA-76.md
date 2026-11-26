# STORE-QA-76

Ruling QA76-1 (2026-11-20) - the per-line "do not restock" choice of a merchant-opened return is stored as `return_items.condition = 'no_restock'`, honoured only when `byMerchant` is set (a shopper-supplied value is dropped), with no schema change. Not-restocked lines move no stock and reverse no inventory in the GL (COGS stays expensed). Cost if wrong: a dedicated column is one mechanical migration; the `damaged` condition keeps its current behaviour.

Ruling QA76-2 (2026-11-20) - a return that covers every line of the order takes the whole-order reversal, which restocks every line, so a mixed restock choice there is refused before money moves (`FULL_RETURN_RESTOCK_ALL`) and the admin locks restock on. Cost if wrong: the merchant leaves one unit out of the return; no amount is ever wrong.

Ruling QA76-3 (2026-11-20) - the admin partial refund is a merchant-opened return (`type: refund`) completed in one request, not a second refund engine, so the one refundable balance (#624), the line cap, REVENUE-DEF-1b netting and the partial-return journal apply unchanged; `POST /orders/:id/partial-refund` needs `orders:refund` like every refund route (staff open a return from /returns). Cost if wrong: a return row exists for what a merchant may think of as "just a refund"; it is visible and filterable in /returns.
