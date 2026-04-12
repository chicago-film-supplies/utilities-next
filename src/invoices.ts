/**
 * Shared invoice utility functions for CFS applications.
 * Re-exports generic item helpers from orders and adds invoice-specific utilities.
 *
 * ```ts
 * import { flattenForXero, isPriceableItem } from "@cfs/utilities/invoices";
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

/**
 * Filter out structural items (group/destination dividers) and return only
 * billable line items suitable for Xero sync or totals calculation.
 */
export function flattenForXero(items: LineItem[]): LineItem[] {
  return items.filter((item) => item.type !== "destination" && item.type !== "group");
}
