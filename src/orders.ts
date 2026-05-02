/**
 * Shared order utility functions for CFS applications.
 * Includes pricing calculations, item consolidation, and destination grouping.
 * All arithmetic uses currency.js for safe floating-point calculations.
 *
 * ```ts
 * import { calculateOrderTotals } from "@cfs/utilities/orders";
 *
 * const items = [
 *   {
 *     type: "rental",
 *     quantity: 1,
 *     price: {
 *       base: 100,
 *       formula: "five_day_week",
 *       chargeable_days: 5,
 *       discount: null,
 *       taxes: [],
 *       subtotal: 100,
 *       subtotal_discounted: 100,
 *     },
 *   },
 * ];
 * const totals = calculateOrderTotals(items, []);
 * console.log(totals.total); // 100
 * ```
 *
 * @module
 */

import currency from "currency.js";
import type {
  DiscountType,
  PriceModifierType,
  OrderDocTotalsType,
  OrderDocItemPriceType,
  OrderDatesType,
  DestinationType,
  ConsolidatedItemType,
  GroupPathType,
  Tax as SchemaTax,
} from "@cfs/schemas";
import { getDuration } from "./dates.ts";

// ── Types ────────────────────────────────────────────────────────

/** @see {@link DiscountType} from `@cfs/schemas` */
export type Discount = DiscountType;

/** @see {@link PriceModifierType} from `@cfs/schemas` */
export type PriceModifier = PriceModifierType;

/** @see {@link OrderDocItemPriceType} from `@cfs/schemas` */
export type PriceObject = OrderDocItemPriceType;

/** Subset of the full Tax document needed by utility functions. */
export type Tax = Pick<SchemaTax, "uid" | "name" | "rate" | "type">;

/**
 * A single line item in an order (product, destination, group, surcharge, or fee).
 * Loose interface compatible with all OrderDocItemType members — utility functions
 * use type guards (isPriceableItem, isTransactionFeeItem) before accessing
 * member-specific fields.
 */
export interface LineItem {
  uid: string;
  name: string;
  type: string;
  quantity?: number;
  price?: PriceObject | PriceModifierType;
  stock_method?: string;
  path: string[];
  uid_delivery?: string | null;
  uid_collection?: string | null;
  zero_priced?: boolean | null;
  description?: string;
  order_number?: number;
  uid_order?: string | null;
}

/** A pre-tax line item with a full price object (rental, sale, service, surcharge, replacement). */
export interface PreTaxLineItem extends LineItem {
  type: "rental" | "sale" | "service" | "surcharge" | "replacement";
  quantity: number;
  price: PriceObject;
}

/** A transaction fee line item with a PriceModifier price. */
export interface TransactionFeeLineItem extends LineItem {
  type: "transaction_fee";
  quantity: number;
  price: PriceModifierType;
}

/** Any item that has pricing — pre-tax or transaction fee. */
export type PriceableLineItem = PreTaxLineItem | TransactionFeeLineItem;

/** @see {@link OrderDocTotalsType} from `@cfs/schemas` */
export type OrderTotals = OrderDocTotalsType;

/** @see {@link ConsolidatedItemType} from `@cfs/schemas` */
export type ConsolidatedItem = ConsolidatedItemType;

/** @see {@link GroupPathType} from `@cfs/schemas` */
export type GroupPath = GroupPathType;

// ── Date & destination comparison ───────────────────────────────

/**
 * Whether charge dates match the delivery/collection dates
 * (i.e. no custom charge period has been set).
 */
export function isSameAsDeliveryDates(dates: OrderDatesType): boolean {
  return dates.charge_start === dates.delivery_start
    && dates.charge_end === dates.collection_start;
}

/**
 * Whether a destination's collection endpoint matches its delivery endpoint
 * (address, contact, and instructions are all equal).
 */
export function isSameAsDeliveryDestination(destination: DestinationType): boolean {
  if (!destination.delivery && !destination.collection) return true;
  if (!destination.collection) return true;
  if (!destination.delivery) return false;

  return JSON.stringify(destination.delivery.address) === JSON.stringify(destination.collection.address)
    && JSON.stringify(destination.delivery.contact) === JSON.stringify(destination.collection.contact)
    && destination.delivery.instructions === destination.collection.instructions;
}

/**
 * Build a display name for a destination pair from its delivery/collection addresses.
 * Falls back to "Destination N" when no addresses are present.
 */
export function getDestinationPairItemName(
  destination: DestinationType,
  index: number,
): string {
  const deliveryName = destination.delivery?.address?.name || destination.delivery?.address?.street || "";
  const collectionName = destination.collection?.address?.name || destination.collection?.address?.street || "";

  if (!deliveryName && !collectionName) {
    return "Destination " + (index + 1);
  }

  if (!collectionName || deliveryName === collectionName) {
    return deliveryName || "Destination " + (index + 1);
  }

  return deliveryName + " - " + collectionName;
}

/**
 * Pair-derived legend strings for the order's start/end dates.
 *
 * Each pair contributes a label based on its `customer_collecting` /
 * `customer_returning` flags. Labels are deduped and joined with " / ", so
 * a mixed-mode order (one pair we deliver, one pair the customer picks up)
 * renders as "Pickup / Delivery".
 *
 * Mapping:
 *   start: customer_collecting === true → "Pickup", else → "Delivery"
 *   end:   customer_returning  === true → "Return", else → "Pickup"
 *
 * Empty input returns empty strings.
 */
export function getDestinationsLegend(
  destinations: DestinationType[] | undefined | null,
): { start: string; end: string } {
  if (!destinations || destinations.length === 0) {
    return { start: "", end: "" };
  }

  const startSet = new Set<string>();
  const endSet = new Set<string>();
  for (const d of destinations) {
    startSet.add(d.customer_collecting ? "Pickup" : "Delivery");
    endSet.add(d.customer_returning ? "Return" : "Pickup");
  }

  return {
    start: Array.from(startSet).join(" / "),
    end: Array.from(endSet).join(" / "),
  };
}

/**
 * Compute default chargeable days from order dates and holidays.
 * Returns null if required dates are missing.
 */
export function getDefaultChargeDays(
  dates: OrderDatesType,
  holidays: string[],
): number | null {
  if (!dates?.delivery_start || !dates?.collection_start) return null;
  try {
    const duration = getDuration(dates, holidays);
    return duration?.chargeDays ?? null;
  } catch {
    return null;
  }
}

/**
 * Update chargeable_days on line items that still match the previous default.
 * Skips structural items, items without a price, and manual overrides.
 */
export function syncChargeDaysToItems(
  items: LineItem[],
  previousDefault: number | null,
  newDefault: number | null,
): void {
  if (previousDefault === newDefault) return;

  for (const item of items) {
    if (item.type === "destination" || item.type === "group") continue;
    if (!item.price) continue;
    const days = (item.price as PriceObject).chargeable_days;
    if (days === null || days === undefined) continue;
    if (previousDefault === null) continue;
    if (days !== previousDefault) continue;
    (item.price as PriceObject).chargeable_days = newDefault;
  }
}

// ── Type guards ──────────────────────────────────────────────────

/**
 * Determine whether a line item is priceable (has a price object, not a structural item).
 */
export function isPriceableItem(item: LineItem): item is PriceableLineItem {
  if (!item || typeof item !== "object") return false;
  if (item.type === "destination" || item.type === "group") return false;
  if (!item.price || typeof item.price !== "object") return false;
  return true;
}

/**
 * Determine whether a line item is a transaction fee.
 */
export function isTransactionFeeItem(item: LineItem): item is TransactionFeeLineItem {
  if (!item || typeof item !== "object") return false;
  if (item.type !== "transaction_fee") return false;
  if (!item.price || typeof item.price !== "object") return false;
  return true;
}

/**
 * Determine whether a line item participates in subtotal/discount/tax calculations.
 * Standalone predicate (not composed) because TS doesn't support negated predicates.
 */
export function isPreTaxItem(item: LineItem): item is PreTaxLineItem {
  if (!item || typeof item !== "object") return false;
  if (item.type === "destination" || item.type === "group" || item.type === "transaction_fee") return false;
  if (!item.price || typeof item.price !== "object") return false;
  return true;
}

// ── Days factor ──────────────────────────────────────────────────

/** @param formula - Pricing formula: `"five_day_week"` or `"fixed"`. */
function getDaysFactor(formula: "five_day_week" | "fixed", chargeable_days: number | null): number {
  if (formula === "five_day_week") {
    return (chargeable_days ?? 0) / 5;
  }
  if (formula === "fixed") {
    return 1;
  }
  throw new Error("Unknown formula: " + formula);
}

// ── Item-level calculations ──────────────────────────────────────

/**
 * Calculate the pre-discount and post-discount subtotals for a single line item.
 */
export function calculateItemSubtotal(
  item: LineItem,
): { subtotal: number; subtotal_discounted: number } {
  if (!isPreTaxItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group/transaction_fee",
    );
  }

  const { base = 0, formula, chargeable_days = null, discount } = item.price;
  const quantity = item.quantity;

  const daysFactor = getDaysFactor(formula, chargeable_days);
  const pricingFactor = Math.max(daysFactor, 1);

  const subtotal = currency(base)
    .multiply(quantity)
    .multiply(pricingFactor);

  if (!discount) {
    return { subtotal: subtotal.value, subtotal_discounted: subtotal.value };
  }

  let subtotal_discounted: currency;
  if (discount.type === "percent") {
    subtotal_discounted = subtotal.multiply((100 - discount.rate) / 100);
  } else {
    const discountAmount = currency(discount.rate)
      .multiply(quantity)
      .multiply(pricingFactor);
    subtotal_discounted = subtotal.subtract(discountAmount);
  }

  return { subtotal: subtotal.value, subtotal_discounted: subtotal_discounted.value };
}

/**
 * Calculate the discount dollar amount for a single line item.
 */
export function calculateItemDiscount(item: LineItem): number {
  const { subtotal, subtotal_discounted } = calculateItemSubtotal(item);
  return currency(subtotal).subtract(subtotal_discounted).value;
}

/**
 * Calculate tax amounts for a single line item from the Tax[] parameter.
 * Returns a PriceModifier[] with computed amounts.
 */
export function calculateItemTax(
  item: LineItem,
  taxes: Tax[],
): PriceModifier[] {
  if (!isPreTaxItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group/transaction_fee",
    );
  }

  const { subtotal_discounted } = calculateItemSubtotal(item);
  const quantity = item.quantity;

  return item.price.taxes.map((itemTax) => {
    const taxDoc = taxes.find((t) => t.uid === itemTax.uid);
    if (!taxDoc) {
      throw new Error("Unknown tax uid: " + itemTax.uid);
    }

    let amount: number;
    if (taxDoc.type === "percent") {
      amount = currency(subtotal_discounted).multiply(taxDoc.rate / 100).value;
    } else {
      amount = currency(taxDoc.rate).multiply(quantity).value;
    }

    return {
      uid: taxDoc.uid,
      name: taxDoc.name,
      rate: taxDoc.rate,
      type: taxDoc.type,
      amount,
    };
  });
}

/**
 * Calculate the complete price for a single line item.
 * Runs the full pipeline: subtotal → discount → taxes → total.
 */
export function calculateItemPrice(
  item: LineItem,
  taxes: Tax[],
): { subtotal: number; subtotal_discounted: number; discount: Discount | null; taxes: PriceModifier[]; total: number } {
  if (!isPreTaxItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group/transaction_fee",
    );
  }

  const { subtotal, subtotal_discounted } = calculateItemSubtotal(item);
  const itemTaxes = calculateItemTax(item, taxes);

  let taxSum = currency(0);
  for (const t of itemTaxes) {
    taxSum = taxSum.add(t.amount);
  }

  let discount: Discount | null = null;
  if (item.price.discount) {
    discount = {
      rate: item.price.discount.rate,
      type: item.price.discount.type,
      amount: currency(subtotal).subtract(subtotal_discounted).value,
    };
  }

  return {
    subtotal,
    subtotal_discounted,
    discount,
    taxes: itemTaxes,
    total: currency(subtotal_discounted).add(taxSum).value,
  };
}

/**
 * Calculate the total (subtotal_discounted + taxes) for a single line item.
 * Handles both PriceObject (regular items) and PriceModifier (transaction fee items).
 */
export function calculateItemTotal(
  item: LineItem,
  taxes: Tax[],
): number {
  if (!isPriceableItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group",
    );
  }

  if (isTransactionFeeItem(item)) {
    return item.price.amount;
  }

  const { total } = calculateItemPrice(item, taxes);
  return total;
}

// ── Aggregation functions ────────────────────────────────────────

/**
 * Calculate the total discount amount across all pre-tax items.
 */
export function getTotalDiscount(items: LineItem[]): number {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  let total = currency(0);
  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    total = total.add(calculateItemDiscount(item));
  }

  return total.value;
}

/**
 * Aggregate tax PriceModifiers by name across all pre-tax items.
 */
export function getTaxTotals(
  items: LineItem[],
  taxes: Tax[],
): PriceModifier[] {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  const totals: Record<string, { uid: string; rate: number; type: "percent" | "flat"; amount: currency }> = {};

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;

    const itemTaxes = calculateItemTax(item, taxes);
    for (const tax of itemTaxes) {
      if (tax.amount === 0) continue;

      if (!totals[tax.name]) {
        totals[tax.name] = { uid: tax.uid, rate: tax.rate, type: tax.type, amount: currency(0) };
      }
      totals[tax.name].amount = totals[tax.name].amount.add(tax.amount);
    }
  }

  return Object.entries(totals).map(([name, { uid, rate, type, amount }]) => ({
    uid, name, rate, type, amount: amount.value,
  }));
}

/**
 * Aggregate transaction fee PriceModifiers across all fee items.
 */
export function getTransactionFeeTotals(items: LineItem[]): PriceModifier[] {
  const totals: Record<string, { uid: string; rate: number; type: "percent" | "flat"; amount: currency }> = {};

  for (const item of items) {
    if (!isTransactionFeeItem(item)) continue;

    if (item.price.amount === 0) continue;

    if (!totals[item.price.name]) {
      totals[item.price.name] = { uid: item.price.uid, rate: item.price.rate, type: item.price.type, amount: currency(0) };
    }
    totals[item.price.name].amount = totals[item.price.name].amount.add(item.price.amount);
  }

  return Object.entries(totals).map(([name, { uid, rate, type, amount }]) => ({
    uid, name, rate, type, amount: amount.value,
  }));
}

/**
 * Calculate aggregated pricing totals for an entire order.
 * Owns the two-pass computation: pre-tax items first, then transaction fees.
 */
export function calculateOrderTotals(
  items: LineItem[],
  taxes: Tax[],
): OrderTotals {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  // Pass 1: compute subtotals from pre-tax items
  let subtotal = currency(0);
  let subtotal_discounted = currency(0);

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    const result = calculateItemSubtotal(item);
    subtotal = subtotal.add(result.subtotal);
    subtotal_discounted = subtotal_discounted.add(result.subtotal_discounted);
  }

  const discount_amount = getTotalDiscount(items);
  const taxTotals = getTaxTotals(items, taxes);

  let taxSum = currency(0);
  for (const entry of taxTotals) {
    taxSum = taxSum.add(entry.amount);
  }

  // Pass 2: compute transaction fee amounts
  const feeItems: LineItem[] = [];
  for (const item of items) {
    if (!isTransactionFeeItem(item)) continue;

    let amount: number;
    if (item.price.type === "percent") {
      amount = currency(subtotal_discounted).multiply(item.price.rate / 100).value;
    } else {
      amount = currency(item.price.rate).multiply(item.quantity).value;
    }

    feeItems.push({
      ...item,
      price: { ...item.price, amount },
    });
  }

  const transaction_fees = getTransactionFeeTotals(feeItems);

  let feeSum = currency(0);
  for (const entry of transaction_fees) {
    feeSum = feeSum.add(entry.amount);
  }

  const replacement = calculateReplacementTotals(items, taxes);

  return {
    discount_amount,
    subtotal: subtotal.value,
    subtotal_discounted: subtotal_discounted.value,
    taxes: taxTotals,
    transaction_fees,
    total: currency(subtotal_discounted).add(taxSum).add(feeSum).value,
    replacement_total: replacement.total,
  };
}

// ── Order inspection helpers ─────────────────────────────────────

/** Check whether any line item is a rental. */
export function orderHasRentals(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) => item.type === "rental");
}

/** Check whether any pre-tax line item has a discount. */
export function orderHasDiscount(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) =>
    isPreTaxItem(item) && item.price.discount !== null
  );
}

/** Check whether any pre-tax line item has taxes applied. */
export function orderHasTax(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) =>
    isPreTaxItem(item) && item.price.taxes.length > 0
  );
}

// ── Replacement totals ──────────────────────────────────────────

/** Replacement cost totals for an order, with and without tax. */
export interface ReplacementTotals {
  subtotal: number;
  tax: number;
  total: number;
}

/**
 * Calculate the total replacement cost across all pre-tax items that have
 * a replacement value on their price object.
 *
 * Returns `subtotal` (sum of replacement × quantity), `tax` (taxes applied
 * to that subtotal), and `total` (subtotal + tax).
 */
export function calculateReplacementTotals(
  items: LineItem[],
  taxes: Tax[],
): ReplacementTotals {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  let subtotal = currency(0);
  let taxTotal = currency(0);

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;

    if (item.price.replacement == null) continue;

    const quantity = item.quantity;
    const itemReplacementSubtotal = currency(item.price.replacement).multiply(quantity);
    subtotal = subtotal.add(itemReplacementSubtotal);

    for (const itemTax of item.price.taxes) {
      const taxDoc = taxes.find((t) => t.uid === itemTax.uid);
      if (!taxDoc) continue;

      if (taxDoc.type === "percent") {
        taxTotal = taxTotal.add(
          itemReplacementSubtotal.multiply(taxDoc.rate / 100),
        );
      } else {
        taxTotal = taxTotal.add(currency(taxDoc.rate).multiply(quantity));
      }
    }
  }

  return {
    subtotal: subtotal.value,
    tax: taxTotal.value,
    total: subtotal.add(taxTotal).value,
  };
}

// ── Path computation ──────────────────────────────────────────────

/**
 * Build a set of structural item uids (dest/group) from items array.
 * Used to distinguish structural path elements from product parent refs.
 */
export function getStructuralUids(items: LineItem[]): Set<string> {
  return new Set(
    items.filter((i) => i.type === "destination" || i.type === "group").map((i) => i.uid),
  );
}

/**
 * Get the parent product uid from an item's path.
 * Returns null for non-components (where path.at(-2) is a structural uid or absent).
 */
export function getParentProductUid(item: LineItem, structuralUids: Set<string>): string | null {
  const secondToLast = item.path?.at(-2);
  if (!secondToLast) return null;
  if (structuralUids.has(secondToLast)) return null;
  return secondToLast;
}

/**
 * Return the contiguous index range covering an item and every descendant of it,
 * derived purely from `path` (not from item types or adjacency rules).
 *
 * `computeItemPaths` lays items out depth-first, so descendants of `items[index]`
 * are always contiguous starting at `index + 1` and run until the first item
 * whose path does not start with `items[index].path`.
 *
 * Generic over any `{ path: string[] }` so it works on order line items, invoice
 * line items (whose paths are scoped by an order divider uid), and any other
 * path-keyed flat array.
 */
export function getItemSubtreeRange<T extends { path: string[] }>(
  items: T[],
  index: number,
): { startIndex: number; endIndex: number } {
  const prefix = items[index].path;
  let endIndex = index;
  for (let i = index + 1; i < items.length; i++) {
    const p = items[i].path;
    if (p.length < prefix.length) break;
    let matches = true;
    for (let j = 0; j < prefix.length; j++) {
      if (p[j] !== prefix[j]) { matches = false; break; }
    }
    if (!matches) break;
    endIndex = i;
  }
  return { startIndex: index, endIndex };
}

/**
 * Compute full structural paths for a flat items array.
 * Each item's path = [structural context...] + [component ancestry...] + [self uid].
 *
 * Client-sent paths carry component ancestry (from ProductComponent.path).
 * This function prepends structural context (dest/group) and appends self uid.
 *
 * Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
 * safe to pass items that originate from a Solid store proxy (the manager app
 * routes reordered arrays through this function inside `setEntity` updaters).
 * Callers should replace their working array with the return value.
 */
export function computeItemPaths<T extends LineItem>(items: T[]): T[] {
  let currentDestUid: string | null = null;
  let currentGroupUid: string | null = null;
  return items.map((item) => {
    if (item.type === "destination") {
      currentDestUid = item.uid;
      currentGroupUid = null;
      return { ...item, path: [item.uid] };
    }
    if (item.type === "group") {
      currentGroupUid = item.uid;
      return { ...item, path: currentDestUid ? [currentDestUid, item.uid] : [item.uid] };
    }
    // Line items: structural prefix + component ancestry + self uid
    const prefix: string[] = [];
    if (currentDestUid) prefix.push(currentDestUid);
    if (currentGroupUid) prefix.push(currentGroupUid);
    // Strip any structural/self uids already in client-sent path
    const clientPath = (item.path ?? []).filter(
      (seg) => seg !== currentDestUid && seg !== currentGroupUid && seg !== item.uid,
    );
    return { ...item, path: [...prefix, ...clientPath, item.uid] };
  });
}

// ── Item consolidation and destination grouping ──────────────────

const NON_PRODUCT_TYPES = new Set(["destination", "group", "surcharge", "transaction_fee"]);
const PACKING_LIST_ITEM_TYPES = new Set(["rental", "sale"]);
const DELIVERY_TYPES = new Set(["rental", "sale"]);
const COLLECTION_TYPES = new Set(["rental"]);

/**
 * Walk backwards from `index` to determine which destination and group
 * an item belongs to. `destination` is the destination's `uid_delivery`;
 * `group` is the group item's `uid` (not its display name) — keying on
 * uid lets group display names be edited without losing collapse state
 * or risking collisions between two groups that happen to share a name.
 */
export function getGroupPath(items: LineItem[], index: number): GroupPath {
  const item = items[index];
  const structuralUids = getStructuralUids(items);
  const result: GroupPath = {
    destination: null,
    group: null,
    product: getParentProductUid(item, structuralUids),
  };

  for (let i = index - 1; i >= 0; i--) {
    const entry = items[i];
    if (entry.type === "group" && result.group === null) {
      result.group = entry.uid ?? null;
    }
    if (entry.type === "destination") {
      result.destination = entry.uid_delivery ?? null;
      break;
    }
  }

  return result;
}

/**
 * Deduplicate line items by product UID and sum quantities.
 */
export function consolidateItems(lineItems: LineItem[]): ConsolidatedItem[] {
  if (!Array.isArray(lineItems)) {
    throw new Error("lineItems must be an array");
  }

  const map: Record<
    string,
    {
      uid: string;
      name: string;
      type: string;
      quantity: number;
      total_price: currency;
      stock_method: string;
    }
  > = {};

  for (const item of lineItems) {
    if (NON_PRODUCT_TYPES.has(item.type)) continue;
    if (!item.uid) continue;

    const total = item.price && "total" in item.price ? (item.price.total || 0) : 0;

    if (map[item.uid]) {
      map[item.uid].quantity += item.quantity || 0;
      map[item.uid].total_price = map[item.uid].total_price.add(total);
    } else {
      map[item.uid] = {
        uid: item.uid,
        name: item.name || "",
        type: item.type || "",
        quantity: item.quantity || 0,
        total_price: currency(total),
        stock_method: item.stock_method || "none",
      };
    }
  }

  return Object.values(map).map((entry) => ({
    uid: entry.uid,
    name: entry.name,
    type: entry.type,
    quantity: entry.quantity,
    total_price: entry.total_price.value,
    unit_price: entry.quantity > 0
      ? currency(entry.total_price).divide(entry.quantity).value
      : 0,
    stock_method: entry.stock_method,
  }));
}

/** A destination section with its delivery/collection UIDs and child items. */
export interface DestinationGroup {
  uid_delivery: string;
  uid_collection: string;
  items: LineItem[];
  packing_list_delivery: LineItem[];
  packing_list_collection: LineItem[];
}

/**
 * Slice the flat items array into destination sections.
 */
export function groupByDestination(
  items: LineItem[],
  fallbackDeliveryUid: string,
  fallbackCollectionUid?: string,
): DestinationGroup[] {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  const collectionFallback = fallbackCollectionUid || fallbackDeliveryUid;

  const groups: DestinationGroup[] = [];
  let current: DestinationGroup | null = null;

  for (const item of items) {
    if (item.type === "destination") {
      if (current) groups.push(current);
      current = {
        uid_delivery: item.uid_delivery || fallbackDeliveryUid,
        uid_collection: item.uid_collection || collectionFallback,
        items: [],
        packing_list_delivery: [],
        packing_list_collection: [],
      };
      continue;
    }

    if (!current) {
      current = {
        uid_delivery: fallbackDeliveryUid,
        uid_collection: collectionFallback,
        items: [],
        packing_list_delivery: [],
        packing_list_collection: [],
      };
    }

    current.items.push(item);

    if (DELIVERY_TYPES.has(item.type) && item.uid) {
      current.packing_list_delivery.push(item);
    }
    if (COLLECTION_TYPES.has(item.type) && item.uid) {
      current.packing_list_collection.push(item);
    }
  }

  if (current) groups.push(current);

  if (groups.length === 0) {
    return [{
      uid_delivery: fallbackDeliveryUid,
      uid_collection: collectionFallback,
      items: [],
      packing_list_delivery: [],
      packing_list_collection: [],
    }];
  }

  return groups;
}

/**
 * Collect the child product items belonging to a collapsible section.
 */
export function getGroupItems(items: LineItem[], index: number): LineItem[] {
  if (!Array.isArray(items) || index < 0 || index >= items.length) return [];

  const item = items[index];

  if (item.type === "destination") {
    const result: LineItem[] = [];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "destination") break;
      if (items[i].type === "group") continue;
      result.push(items[i]);
    }
    return result;
  }

  if (item.type === "group") {
    const result: LineItem[] = [];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "group" || items[i].type === "destination") break;
      result.push(items[i]);
    }
    return result;
  }

  return items.filter(
    (i) => i.path.at(-2) === item.uid,
  );
}

/**
 * Collect the indices of all items that should be removed when the item
 * at `index` is deleted — the item itself plus all its descendants.
 * Returns indices sorted ascending.
 */
export function getRemovalIndices(items: LineItem[], index: number): number[] {
  if (!Array.isArray(items) || index < 0 || index >= items.length) return [];

  const item = items[index];

  // Destination: self + everything until the next destination
  if (item.type === "destination") {
    const indices = [index];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "destination") break;
      indices.push(i);
    }
    return indices;
  }

  // Group: self + everything until the next group or destination
  if (item.type === "group") {
    const indices = [index];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "group" || items[i].type === "destination") break;
      indices.push(i);
    }
    return indices;
  }

  // Product: self + ALL descendants via path chain
  const indexSet = new Set([index]);
  const descendantUids = new Set<string>();
  if (item.uid) descendantUids.add(item.uid);

  let prevSize = 0;
  while (descendantUids.size > prevSize) {
    prevSize = descendantUids.size;
    for (let i = 0; i < items.length; i++) {
      if (indexSet.has(i)) continue;
      const parentUid = items[i].path.at(-2);
      if (parentUid && descendantUids.has(parentUid)) {
        indexSet.add(i);
        if (items[i].uid) descendantUids.add(items[i].uid!);
      }
    }
  }

  return [...indexSet].sort((a, b) => a - b);
}

/** Count and pricing totals for a collapsed destination or group section. */
export interface GroupTotalsResult {
  count: number;
  subtotal: number;
  subtotal_discounted: number;
  total: number;
}

/**
 * Get count and pricing totals for a collapsed section.
 */
export function getGroupTotals(
  items: LineItem[],
  index: number,
  taxes: Tax[],
): GroupTotalsResult {
  const children = getGroupItems(items, index);
  if (children.length === 0) return { count: 0, subtotal: 0, subtotal_discounted: 0, total: 0 };

  const { subtotal, subtotal_discounted, total } = calculateOrderTotals(children, taxes);
  return { count: children.length, subtotal, subtotal_discounted, total };
}

/** An expanded packing list entry preserving group context. */
export interface PackingListItem {
  uid: string;
  name: string;
  type: string;
  quantity: number;
  stock_method: string;
  group_name: string | null;
}

/**
 * Build a packing list from order line items.
 *
 * When `consolidated` is true, deduplicates by product UID and sums quantities
 * (delegates to {@link consolidateItems}). When false (default), returns
 * expanded entries with `group_name` preserved.
 *
 * Pass `destinationUid` to scope to a single destination; omit for the full order.
 *
 * Excludes structural rows, surcharges, transaction fees, and services.
 */
export function buildPackingList(
  items: LineItem[],
  consolidated?: boolean,
  destinationUid?: string,
): PackingListItem[] | ConsolidatedItem[] {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  // Scope to destination if requested
  let scoped: LineItem[];
  if (destinationUid) {
    scoped = [];
    let inDestination = false;
    for (const item of items) {
      if (item.type === "destination") {
        inDestination = item.uid_delivery === destinationUid ||
          item.uid_collection === destinationUid;
        continue;
      }
      if (inDestination) scoped.push(item);
    }
  } else {
    scoped = items;
  }

  // Filter to packing-list-eligible items
  const filtered = scoped.filter(
    (item) => item.uid && PACKING_LIST_ITEM_TYPES.has(item.type),
  );

  if (consolidated) {
    return consolidateItems(filtered);
  }

  // Expanded: walk the scoped array to track current group name
  const result: PackingListItem[] = [];
  let currentGroup: string | null = null;

  for (const item of scoped) {
    if (item.type === "group") {
      currentGroup = item.name ?? null;
      continue;
    }
    if (item.type === "destination") {
      currentGroup = null;
      continue;
    }
    if (!item.uid || !PACKING_LIST_ITEM_TYPES.has(item.type)) continue;

    result.push({
      uid: item.uid,
      name: item.name || "",
      type: item.type || "",
      quantity: item.quantity || 0,
      stock_method: item.stock_method || "none",
      group_name: currentGroup,
    });
  }

  return result;
}
