/**
 * Shared invoice utility functions for CFS applications.
 * Re-exports generic item helpers from orders and adds invoice-specific utilities.
 *
 * ```ts
 * import { flattenForXero, isPriceableItem, syncOrderItems } from "@cfs/utilities/invoices";
 *
 * const billableItems = flattenForXero(invoice.items);
 * ```
 *
 * @module
 */

export {
  calculateItemDiscount,
  calculateItemPrice,
  calculateItemSubtotal,
  calculateItemTax,
  calculateItemTotal,
  type Discount,
  isPriceableItem,
  isPreTaxItem,
  isTransactionFeeItem,
  type LineItem,
  type PriceModifier,
  type PriceObject,
  type Tax,
} from "./orders.ts";

import type { LineItem } from "./orders.ts";

// ── Structural helpers ──────────────────────────────────────────

/** Structural item types that are not billable. */
const STRUCTURAL_TYPES = new Set(["destination", "group", "order"]);

/**
 * Filter out structural items (group/destination/order dividers) and return only
 * billable line items suitable for Xero sync or totals calculation.
 */
export function flattenForXero(items: LineItem[]): LineItem[] {
  return items.filter((item) => !STRUCTURAL_TYPES.has(item.type ?? ""));
}

// ── Order-scoped item sync ──────────────────────────────────────

/**
 * An invoice item with optional order-scoping fields.
 * Extends LineItem with invoice-specific properties that should be
 * carried forward during sync (coa_revenue, tracking_category, xero_id).
 */
export interface InvoiceItem extends LineItem {
  uid_order?: string | null;
  coa_revenue?: string | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
}

/**
 * Get all invoice items scoped to a specific order divider.
 * Returns the order divider itself plus all items whose path starts
 * with the order divider's uid.
 *
 * @param items - Full invoice items array
 * @param orderDividerUid - The uid of the order divider item
 * @returns Items scoped to that order (divider + children)
 */
export function getOrderScopedItems(items: InvoiceItem[], orderDividerUid: string): InvoiceItem[] {
  return items.filter((item) =>
    (item.type === "order" && item.uid === orderDividerUid) ||
    item.path?.[0] === orderDividerUid
  );
}

/**
 * Remove all invoice items scoped to a specific order divider.
 * Returns a new array with the order divider and all items whose path
 * starts with the order divider's uid removed.
 *
 * @param items - Full invoice items array
 * @param orderDividerUid - The uid of the order divider item to remove
 * @returns Items with the order scope removed
 */
export function removeOrderScopedItems(items: InvoiceItem[], orderDividerUid: string): InvoiceItem[] {
  return items.filter((item) =>
    !(item.type === "order" && item.uid === orderDividerUid) &&
    item.path?.[0] !== orderDividerUid
  );
}

/**
 * Build invoice items from an order's items, scoped under an order divider.
 * Prepends the order divider uid to each item's path.
 *
 * @param orderItems - The order's items array (may contain destination/group/line items)
 * @param orderDividerUid - The uid of the order divider these items belong under
 * @returns Items with path prepended by orderDividerUid
 */
export function buildOrderScopedItems(orderItems: LineItem[], orderDividerUid: string): LineItem[] {
  return orderItems.map((item) => ({
    ...item,
    path: item.path ? [orderDividerUid, ...item.path] : [orderDividerUid],
  }));
}

/**
 * Carry forward invoice-specific overrides from existing items to rebuilt items.
 * Matches by uid — if a rebuilt item has the same uid as an existing invoice item,
 * the invoice-specific fields (coa_revenue, tracking_category, xero_id,
 * xero_tracking_option_id) are preserved from the existing item.
 *
 * @param rebuiltItems - Items rebuilt from the order
 * @param existingItems - Current invoice items (to carry forward overrides from)
 * @returns Rebuilt items with invoice-specific overrides applied
 */
export function carryForwardOverrides(rebuiltItems: InvoiceItem[], existingItems: InvoiceItem[]): InvoiceItem[] {
  const existingByUid = new Map<string, InvoiceItem>();
  for (const item of existingItems) {
    if (item.uid) existingByUid.set(item.uid, item);
  }

  return rebuiltItems.map((item) => {
    if (!item.uid) return item;
    const existing = existingByUid.get(item.uid);
    if (!existing) return item;

    return {
      ...item,
      ...(existing.coa_revenue !== undefined && { coa_revenue: existing.coa_revenue }),
      ...(existing.tracking_category !== undefined && { tracking_category: existing.tracking_category }),
      ...(existing.xero_id !== undefined && { xero_id: existing.xero_id }),
      ...(existing.xero_tracking_option_id !== undefined && { xero_tracking_option_id: existing.xero_tracking_option_id }),
    };
  });
}

/**
 * Sync a single order's items into an invoice's items array.
 * Replaces all items scoped to the order divider with rebuilt items from the order,
 * carrying forward invoice-specific overrides on matched uids.
 *
 * @param invoiceItems - Current full invoice items array
 * @param orderItems - The order's current items array
 * @param orderDividerUid - The uid of the order divider in the invoice
 * @returns Updated invoice items array
 */
export function syncOrderItems(
  invoiceItems: InvoiceItem[],
  orderItems: LineItem[],
  orderDividerUid: string,
): InvoiceItem[] {
  // Capture existing items under this order scope for override carryforward
  const existingScoped = getOrderScopedItems(invoiceItems, orderDividerUid);

  // Remove old scoped items
  const withoutOld = removeOrderScopedItems(invoiceItems, orderDividerUid);

  // Find where the order divider was (to insert at same position)
  // If not found, append at end
  const orderDividerIndex = invoiceItems.findIndex(
    (item) => item.type === "order" && item.uid === orderDividerUid,
  );

  // Build new scoped items from order
  const rebuilt = buildOrderScopedItems(orderItems, orderDividerUid);
  const withOverrides = carryForwardOverrides(rebuilt, existingScoped);

  // Reconstruct: find the order divider in the original to get its metadata
  const orderDivider = invoiceItems.find(
    (item) => item.type === "order" && item.uid === orderDividerUid,
  );

  if (!orderDivider) {
    // Order divider doesn't exist yet — append at end
    return [...withoutOld, ...withOverrides];
  }

  // Re-insert order divider + rebuilt items at the original position
  // Calculate the insertion point in the filtered array
  let insertAt = 0;
  let origIndex = 0;
  for (const item of invoiceItems) {
    if (origIndex === orderDividerIndex) break;
    if (
      !(item.type === "order" && item.uid === orderDividerUid) &&
      item.path?.[0] !== orderDividerUid
    ) {
      insertAt++;
    }
    origIndex++;
  }

  const result = [...withoutOld];
  result.splice(insertAt, 0, orderDivider, ...withOverrides);
  return result;
}
