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

import currency from "currency.js";
import type { InvoiceDocItemPrice, PriceModifierType } from "@cfs/schemas";
import {
  calculateItemSubtotal,
  getTotalDiscount,
  getTaxTotals,
  getTransactionFeeTotals,
  isPriceableItem,
  isPreTaxItem,
  isTransactionFeeItem,
  type LineItem,
  type PriceModifier,
  type PriceObject,
  type Tax,
} from "./orders.ts";

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

// ── Invoice item type ──────────────────────────────────────────

/**
 * An invoice item with optional order-scoping and invoice-specific fields.
 * Extends LineItem with properties that should be carried forward during sync
 * and fields needed for Xero mapping.
 *
 * `price` accepts both the utility's intermediate PriceObject and the full
 * InvoiceDocItemPrice from schemas to avoid type drift.
 */
export interface InvoiceItem extends LineItem {
  uid_order?: string | null;
  description?: string;
  price?: PriceObject | PriceModifierType | InvoiceDocItemPrice;
  coa_revenue?: string | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
  crms_id?: number | string | null;
}

// ── Invoice totals ──────────────────────────────────────────────

/** Invoice-level totals including payment tracking. */
export interface InvoiceTotals {
  discount_amount: number;
  subtotal: number;
  subtotal_discounted: number;
  taxes: PriceModifier[];
  transaction_fees: PriceModifier[];
  total: number;
  amount_paid: number;
  amount_due: number;
}

/**
 * Calculate aggregated pricing totals for an invoice.
 *
 * Composes from the same atomic building blocks as orders (calculateItemSubtotal,
 * getTaxTotals, etc.) but assembled independently — shared per-item math,
 * independent aggregation. This avoids business logic drift if invoices need
 * different totals logic in the future (credit notes, partial billing, etc.).
 *
 * @param items - Full invoice items array (structural items are filtered out)
 * @param taxes - Tax definitions for tax calculation
 * @param payments - Optional payments array for amount_paid/amount_due
 */
export function calculateInvoiceTotals(
  items: InvoiceItem[],
  taxes: Tax[],
  payments?: { amount: number; status: string }[],
): InvoiceTotals {
  const billable = flattenForXero(items);

  // Pass 1: pre-tax items — subtotals, discount, taxes
  let subtotal = currency(0);
  let subtotal_discounted = currency(0);

  for (const item of billable) {
    if (!isPreTaxItem(item)) continue;
    const result = calculateItemSubtotal(item);
    subtotal = subtotal.add(result.subtotal);
    subtotal_discounted = subtotal_discounted.add(result.subtotal_discounted);
  }

  const discount_amount = getTotalDiscount(billable);
  const taxTotals = getTaxTotals(billable, taxes);

  let taxSum = currency(0);
  for (const entry of taxTotals) {
    taxSum = taxSum.add(entry.amount);
  }

  // Pass 2: transaction fees — computed from subtotal_discounted
  const feeItems: LineItem[] = [];
  for (const item of billable) {
    if (!isTransactionFeeItem(item) || !isPriceableItem(item)) continue;

    const fee = item.price as PriceModifier;
    let amount: number;
    if (fee.type === "percent") {
      amount = currency(subtotal_discounted).multiply(fee.rate / 100).value;
    } else {
      amount = currency(fee.rate).multiply(item.quantity || 0).value;
    }

    feeItems.push({ ...item, price: { ...fee, amount } });
  }

  const transaction_fees = getTransactionFeeTotals(feeItems);

  let feeSum = currency(0);
  for (const entry of transaction_fees) {
    feeSum = feeSum.add(entry.amount);
  }

  const total = currency(subtotal_discounted).add(taxSum).add(feeSum).value;

  // Payment accounting
  const { amount_paid, amount_due } = recomputePaymentTotals(total, payments ?? []);

  return {
    discount_amount,
    subtotal: subtotal.value,
    subtotal_discounted: subtotal_discounted.value,
    taxes: taxTotals,
    transaction_fees,
    total,
    amount_paid,
    amount_due,
  };
}

// ── Payment helpers ─────────────────────────────────────────────

/**
 * Derive invoice status from payment amounts.
 * Pure function — does not mutate the invoice.
 *
 * @param currentStatus - Current invoice status
 * @param amountPaid - Total amount paid
 * @param amountDue - Total amount still due
 * @returns The derived status
 */
export function derivePaymentStatus(
  currentStatus: string,
  amountPaid: number,
  amountDue: number,
): string {
  if (currentStatus === "draft" || currentStatus === "void") return currentStatus;
  if (currency(amountDue).value <= 0) return "paid";
  if (currency(amountPaid).value > 0) return "part_paid";
  return "issued";
}

/**
 * Compute amount_paid and amount_due from a payments array.
 * Pure function — returns values instead of mutating.
 *
 * @param total - Invoice total amount
 * @param payments - Payments array with amount and status fields
 * @returns Computed amount_paid and amount_due
 */
export function recomputePaymentTotals(
  total: number,
  payments: { amount: number; status: string }[],
): { amount_paid: number; amount_due: number } {
  let amountPaid = currency(0);
  for (const p of payments) {
    if (p.status === "active") {
      amountPaid = amountPaid.add(p.amount);
    }
  }
  return {
    amount_paid: amountPaid.value,
    amount_due: currency(total).subtract(amountPaid).value,
  };
}

// ── Xero helpers ────────────────────────────────────────────────

/**
 * Compute the Xero unit amount from subtotal and quantity.
 * Bakes duration (chargeable_days × formula) into per-unit price,
 * since Xero has no concept of rental duration.
 *
 * @param subtotal - Pre-discount subtotal (base × days × formula × quantity)
 * @param quantity - Item quantity
 * @returns Per-unit amount for Xero, or 0 if quantity is 0
 */
export function getXeroUnitAmount(subtotal: number, quantity: number): number {
  if (!quantity) return 0;
  return currency(subtotal).divide(quantity).value;
}

// ── Selective sync helpers ──────────────────────────────────────

/** Invoice-only item fields excluded from override comparison. */
const INVOICE_ONLY_ITEM_FIELDS = new Set([
  "coa_revenue", "tracking_category", "xero_id", "xero_tracking_option_id",
]);

/**
 * Return the intersection of two key arrays, minus any keys in the exclude set.
 * Used to derive comparable fields from two schema shapes without hardcoding.
 *
 * @param keysA - Field names from schema A
 * @param keysB - Field names from schema B
 * @param excludes - Field names to exclude from the result
 * @returns Shared field names, excluding the exclude set
 */
export function getSharedFields(keysA: string[], keysB: string[], excludes: string[]): string[] {
  const setB = new Set(keysB);
  const excl = new Set(excludes);
  return keysA.filter((k) => setB.has(k) && !excl.has(k));
}

/**
 * Stable key for path-based item matching.
 * Joins path segments with "/" to produce a unique positional identifier.
 */
function itemPathKey(path: string[] | undefined): string {
  return (path ?? []).join("/");
}

/**
 * Strip the order divider uid prefix from an invoice item's path.
 * Invoice items under an order divider have path = [orderDividerUid, ...originalPath].
 */
function stripOrderPrefix(path: string[] | undefined, orderDividerUid: string): string[] {
  if (!path || path.length === 0) return [];
  if (path[0] === orderDividerUid) return path.slice(1);
  return path;
}

/**
 * Pick only invoice-only override fields from an invoice item.
 * Used to carry forward overrides when replacing an item with updated order data.
 */
function pickInvoiceOnlyFields(item: InvoiceItem): Partial<InvoiceItem> {
  const result: Partial<InvoiceItem> = {};
  if (item.coa_revenue !== undefined) result.coa_revenue = item.coa_revenue;
  if (item.tracking_category !== undefined) result.tracking_category = item.tracking_category;
  if (item.xero_id !== undefined) result.xero_id = item.xero_id;
  if (item.xero_tracking_option_id !== undefined) result.xero_tracking_option_id = item.xero_tracking_option_id;
  return result;
}

/**
 * Compare a previous order item to a current invoice item to detect overrides.
 * Returns true if the invoice item is "synced" (matches the order item on all
 * non-invoice-only fields), false if it has been manually overridden.
 *
 * The comparison strips the order divider prefix from the invoice item's path
 * and ignores invoice-only fields (coa_revenue, tracking_category, xero_id,
 * xero_tracking_option_id).
 *
 * @param prevOrderItem - The order item from the previous version of the order
 * @param invoiceItem - The current invoice item (with order-scoped path)
 * @param orderDividerUid - The uid of the order divider (for path prefix stripping)
 * @returns true if the item is synced (not overridden), false if overridden
 */
export function isItemSynced(
  prevOrderItem: LineItem,
  invoiceItem: InvoiceItem,
  orderDividerUid: string,
): boolean {
  // Build a normalized version of the invoice item for comparison:
  // strip invoice-only fields and order divider path prefix
  const normalizedInvoice: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(invoiceItem)) {
    if (INVOICE_ONLY_ITEM_FIELDS.has(key)) continue;
    if (key === "path") {
      normalizedInvoice[key] = stripOrderPrefix(value as string[], orderDividerUid);
    } else {
      normalizedInvoice[key] = value;
    }
  }

  // Compare all fields from the order item against the normalized invoice item
  const orderKeys = Object.keys(prevOrderItem);
  const invoiceKeys = Object.keys(normalizedInvoice);

  // Must have the same set of non-invoice-only keys
  const orderKeySet = new Set(orderKeys);
  const invoiceKeySet = new Set(invoiceKeys);
  for (const k of orderKeySet) {
    if (!invoiceKeySet.has(k)) return false;
  }
  for (const k of invoiceKeySet) {
    if (!orderKeySet.has(k)) return false;
  }

  for (const key of orderKeys) {
    const a = (prevOrderItem as Record<string, unknown>)[key];
    const b = normalizedInvoice[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }

  return true;
}

/**
 * Selectively sync order items into an invoice, respecting invoice-side overrides.
 *
 * Items are matched by **path** (not uid), since the same product can appear at
 * multiple positions in the items array. For each item:
 *
 * - **Synced** (prev order matches current invoice, minus invoice-only fields):
 *   replaced with the new order item, carrying forward invoice-only overrides
 * - **Overridden** (invoice item differs from prev order): left unchanged
 * - **New** (in new order, not in prev): added under the order divider
 * - **Removed** (in prev order, not in new): removed only if synced, kept if overridden
 *
 * @param prevOrderItems - Items from the previous version of the order
 * @param newOrderItems - Items from the new version of the order
 * @param currentInvoiceItems - Items scoped to this order in the current invoice (without order divider)
 * @param orderDividerUid - The uid of the order divider in the invoice
 * @returns Updated invoice items (scoped under the order divider, ready for insertion)
 */
export function syncOrderToInvoiceSelective(
  prevOrderItems: LineItem[],
  newOrderItems: LineItem[],
  currentInvoiceItems: InvoiceItem[],
  orderDividerUid: string,
): InvoiceItem[] {
  // Index prev order items by path key
  const prevByPath = new Map<string, LineItem>();
  for (const item of prevOrderItems) {
    prevByPath.set(itemPathKey(item.path), item);
  }

  // Index current invoice items by order-relative path key
  const invoiceByPath = new Map<string, InvoiceItem>();
  for (const item of currentInvoiceItems) {
    const relPath = stripOrderPrefix(item.path, orderDividerUid);
    invoiceByPath.set(itemPathKey(relPath), item);
  }

  const result: InvoiceItem[] = [];
  const processedInvoicePaths = new Set<string>();

  // Process new order items in order
  for (const newItem of newOrderItems) {
    const pathKey = itemPathKey(newItem.path);
    const prevItem = prevByPath.get(pathKey);
    const invoiceItem = invoiceByPath.get(pathKey);
    processedInvoicePaths.add(pathKey);

    if (!invoiceItem) {
      // New item — add it scoped under the order divider
      result.push({
        ...newItem,
        path: newItem.path ? [orderDividerUid, ...newItem.path] : [orderDividerUid],
      });
    } else if (prevItem && isItemSynced(prevItem, invoiceItem, orderDividerUid)) {
      // Not overridden — update with new order item, carry forward invoice-only fields
      result.push({
        ...newItem,
        path: newItem.path ? [orderDividerUid, ...newItem.path] : [orderDividerUid],
        ...pickInvoiceOnlyFields(invoiceItem),
      });
    } else {
      // Overridden or no prev item — keep invoice item unchanged
      result.push(invoiceItem);
    }
  }

  // Handle removed items (in invoice but not in new order)
  for (const [pathKey, invoiceItem] of invoiceByPath) {
    if (processedInvoicePaths.has(pathKey)) continue;

    const prevItem = prevByPath.get(pathKey);
    if (prevItem && !isItemSynced(prevItem, invoiceItem, orderDividerUid)) {
      // Overridden — keep it even though it's been removed from the order
      result.push(invoiceItem);
    }
    // Else: synced and removed from order — drop it
  }

  return result;
}

// ── Order-scoped item sync ──────────────────────────────────────

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
