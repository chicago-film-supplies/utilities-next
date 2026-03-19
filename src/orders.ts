/**
 * @cfs/utilities/orders
 *
 * Shared order utility functions for CFS applications.
 * Includes pricing calculations, item consolidation, and destination grouping.
 * All arithmetic uses currency.js for safe floating-point calculations.
 */

import currency from "currency.js";

/**
 * Tax rates by profile name. Values are decimal multipliers.
 */
const TAX_RATES: Record<string, number> = {
  tax_chicago_sales_tax: 0.1025,
  tax_chicago_rental_tax: 0.15,
  tax_rantoul_sales_tax: 0.09,
  tax_none: 0,
};

function getTaxRate(taxProfile: string): number {
  if (!(taxProfile in TAX_RATES)) {
    throw new Error("Unknown tax profile: " + taxProfile);
  }
  return TAX_RATES[taxProfile];
}

export interface PriceObject {
  base?: number;
  formula: string;
  chargeable_days?: number;
  discount_percent?: number;
  tax_profile: string;
  total?: number;
}

export interface LineItem {
  uid?: string;
  name?: string;
  type?: string;
  quantity?: number;
  price?: PriceObject;
  stock_method?: string;
  uid_component_of?: string;
  uid_delivery?: string;
  uid_collection?: string;
  zero_priced?: boolean;
}

/**
 * Determine whether a line item is priceable (has a calculable total).
 */
export function isPriceableItem(item: LineItem): boolean {
  if (!item || typeof item !== "object") return false;
  if (item.type === "destination" || item.type === "group") return false;
  if (!item.price || typeof item.price !== "object") return false;
  return true;
}

/**
 * Calculate the pre-tax subtotal for a single line item.
 */
export function calculateItemSubtotal(item: LineItem): number {
  if (!isPriceableItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group",
    );
  }

  const quantity = item.quantity || 0;
  const {
    base = 0,
    formula,
    chargeable_days = 0,
    discount_percent = 0,
  } = item.price!;

  if (formula !== "five_day_week" && formula !== "fixed") {
    throw new Error("Unknown formula: " + formula);
  }

  const discountMultiplier = (100 - discount_percent) / 100;

  if (formula === "five_day_week") {
    return currency(base)
      .multiply(quantity)
      .multiply(chargeable_days / 5)
      .multiply(discountMultiplier).value;
  }

  return currency(base)
    .multiply(quantity)
    .multiply(discountMultiplier).value;
}

/**
 * Calculate the tax amount for a single line item.
 */
export function calculateItemTax(item: LineItem): number {
  const subtotal = calculateItemSubtotal(item);
  const taxRate = getTaxRate(item.price!.tax_profile);
  return currency(subtotal).multiply(taxRate).value;
}

/**
 * Calculate the total (subtotal + tax) for a single line item.
 */
export function calculateItemTotal(item: LineItem): number {
  const subtotal = calculateItemSubtotal(item);
  const tax = calculateItemTax(item);
  return currency(subtotal).add(tax).value;
}

/**
 * Calculate the discount dollar amount for a single line item.
 */
export function calculateItemDiscount(item: LineItem): number {
  if (!isPriceableItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group",
    );
  }

  const quantity = item.quantity || 0;
  const {
    base = 0,
    formula,
    chargeable_days = 0,
    discount_percent = 0,
  } = item.price!;

  if (discount_percent === 0) return 0;

  if (formula !== "five_day_week" && formula !== "fixed") {
    throw new Error("Unknown formula: " + formula);
  }

  let undiscounted: currency;
  if (formula === "five_day_week") {
    undiscounted = currency(base).multiply(quantity).multiply(
      chargeable_days / 5,
    );
  } else {
    undiscounted = currency(base).multiply(quantity);
  }

  const discounted = undiscounted.multiply((100 - discount_percent) / 100);
  return undiscounted.subtract(discounted).value;
}

/**
 * Calculate the total discount amount across all priceable items.
 */
export function getTotalDiscount(items: LineItem[]): number {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  let total = currency(0);
  for (const item of items) {
    if (!isPriceableItem(item)) continue;
    total = total.add(calculateItemDiscount(item));
  }

  return total.value;
}

export interface TaxEntry {
  name: string;
  total: number;
}

/**
 * Calculate tax totals grouped by tax profile across all priceable items.
 */
export function getTaxesByTaxProfile(
  items: LineItem[],
): TaxEntry[] {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  const totals: Record<string, currency> = {};

  for (const item of items) {
    if (!isPriceableItem(item)) continue;

    const profile = item.price!.tax_profile;
    const tax = calculateItemTax(item);

    if (tax === 0) continue;

    if (!totals[profile]) {
      totals[profile] = currency(0);
    }
    totals[profile] = totals[profile].add(tax);
  }

  return Object.entries(totals).map(([name, amount]) => ({ name, total: amount.value }));
}

export interface OrderTotals {
  discount_amount: number;
  subtotal: number;
  taxes: TaxEntry[];
  total: number;
}

/**
 * Calculate aggregated pricing totals for an entire order.
 */
export function calculateOrderTotals(items: LineItem[]): OrderTotals {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  let subtotal = currency(0);
  for (const item of items) {
    if (!isPriceableItem(item)) continue;
    subtotal = subtotal.add(calculateItemSubtotal(item));
  }

  const discount_amount = getTotalDiscount(items);
  const taxes = getTaxesByTaxProfile(items);

  let taxSum = currency(0);
  for (const entry of taxes) {
    taxSum = taxSum.add(entry.total);
  }

  return {
    discount_amount,
    subtotal: subtotal.value,
    taxes,
    total: currency(subtotal).add(taxSum).value,
  };
}

// ── Order inspection helpers ─────────────────────────────────────

export function orderHasRentals(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) => item.type === "rental");
}

export function orderHasDiscount(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) =>
    isPriceableItem(item) && (item.price!.discount_percent ?? 0) > 0
  );
}

export function orderHasTax(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) =>
    isPriceableItem(item) && item.price!.tax_profile !== "tax_none"
  );
}

// ── Item consolidation and destination grouping ──────────────────

const NON_PRODUCT_TYPES = new Set(["destination", "group", "surcharge"]);
const DELIVERY_TYPES = new Set(["rental", "sale"]);
const COLLECTION_TYPES = new Set(["rental"]);

export interface GroupPath {
  destination: string | null;
  group: string | null;
  product: string | null;
}

/**
 * Walk backwards from `index` to determine which destination and group
 * an item belongs to.
 */
export function getGroupPath(items: LineItem[], index: number): GroupPath {
  const item = items[index];
  const result: GroupPath = {
    destination: null,
    group: null,
    product: item?.uid_component_of ?? null,
  };

  for (let i = index - 1; i >= 0; i--) {
    const entry = items[i];
    if (entry.type === "group" && result.group === null) {
      result.group = entry.name ?? null;
    }
    if (entry.type === "destination") {
      result.destination = entry.uid_delivery ?? null;
      break;
    }
  }

  return result;
}

export interface ConsolidatedItem {
  uid: string;
  name: string;
  type: string;
  quantity: number;
  total_price: number;
  unit_price: number;
  stock_method: string;
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
    if (NON_PRODUCT_TYPES.has(item.type!)) continue;
    if (!item.uid) continue;

    if (map[item.uid]) {
      map[item.uid].quantity += item.quantity || 0;
      map[item.uid].total_price = map[item.uid].total_price.add(
        item.price?.total || 0,
      );
    } else {
      map[item.uid] = {
        uid: item.uid,
        name: item.name || "",
        type: item.type || "",
        quantity: item.quantity || 0,
        total_price: currency(item.price?.total || 0),
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

    if (DELIVERY_TYPES.has(item.type!) && item.uid) {
      current.packing_list_delivery.push(item);
    }
    if (COLLECTION_TYPES.has(item.type!) && item.uid) {
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
    (i) => i.uid_component_of === item.uid && i.zero_priced === true,
  );
}

export interface GroupTotalsResult {
  count: number;
  subtotal: number;
  total: number;
}

/**
 * Get count and pricing totals for a collapsed section.
 */
export function getGroupTotals(
  items: LineItem[],
  index: number,
): GroupTotalsResult {
  const children = getGroupItems(items, index);
  if (children.length === 0) return { count: 0, subtotal: 0, total: 0 };

  const { subtotal, total } = calculateOrderTotals(children);
  return { count: children.length, subtotal, total };
}
