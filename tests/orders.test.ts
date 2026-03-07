import { assertEquals, assertThrows } from "@std/assert";
import {
  calculateItemDiscount,
  calculateItemSubtotal,
  calculateItemTax,
  calculateItemTotal,
  calculateOrderTotals,
  consolidateItems,
  getGroupItems,
  getGroupPath,
  getGroupTotals,
  getTaxesByTaxProfile,
  getTotalDiscount,
  groupByDestination,
  isPriceableItem,
  type LineItem,
  orderHasDiscount,
  orderHasRentals,
  orderHasTax,
} from "../src/orders.ts";

function makeItem(
  overrides: Partial<LineItem> = {},
  priceOverrides: Record<string, unknown> = {},
): LineItem {
  return {
    name: "Test Item",
    type: "rental",
    quantity: 1,
    ...overrides,
    price: {
      base: 100,
      formula: "five_day_week",
      chargeable_days: 5,
      discount_percent: 0,
      tax_profile: "tax_none",
      total: 0,
      ...priceOverrides,
    },
  };
}

// ── isPriceableItem ──────────────────────────────────────────────

Deno.test("isPriceableItem returns true for rental with price", () => {
  assertEquals(isPriceableItem(makeItem()), true);
});

Deno.test("isPriceableItem returns false for destination", () => {
  assertEquals(isPriceableItem({ type: "destination" }), false);
});

Deno.test("isPriceableItem returns false for group", () => {
  assertEquals(isPriceableItem({ type: "group" }), false);
});

Deno.test("isPriceableItem returns false without price", () => {
  assertEquals(isPriceableItem({ type: "rental" }), false);
});

// ── calculateItemSubtotal ────────────────────────────────────────

Deno.test("calculateItemSubtotal five_day_week 1 week", () => {
  assertEquals(calculateItemSubtotal(makeItem()), 100);
});

Deno.test("calculateItemSubtotal five_day_week 2 weeks", () => {
  assertEquals(calculateItemSubtotal(makeItem({}, { chargeable_days: 10 })), 200);
});

Deno.test("calculateItemSubtotal five_day_week 3 days", () => {
  assertEquals(calculateItemSubtotal(makeItem({}, { chargeable_days: 3 })), 60);
});

Deno.test("calculateItemSubtotal with discount", () => {
  assertEquals(calculateItemSubtotal(makeItem({}, { discount_percent: 10 })), 90);
});

Deno.test("calculateItemSubtotal with quantity", () => {
  assertEquals(calculateItemSubtotal(makeItem({ quantity: 3 })), 300);
});

Deno.test("calculateItemSubtotal fixed formula", () => {
  assertEquals(
    calculateItemSubtotal(makeItem({}, { formula: "fixed", base: 50 })),
    50,
  );
});

Deno.test("calculateItemSubtotal fixed with quantity and discount", () => {
  assertEquals(
    calculateItemSubtotal(
      makeItem({ quantity: 2 }, { formula: "fixed", base: 100, discount_percent: 25 }),
    ),
    150,
  );
});

Deno.test("calculateItemSubtotal throws for non-priceable", () => {
  assertThrows(
    () => calculateItemSubtotal({ type: "destination" }),
    Error,
    "not priceable",
  );
});

Deno.test("calculateItemSubtotal throws for unknown formula", () => {
  assertThrows(
    () => calculateItemSubtotal(makeItem({}, { formula: "unknown" })),
    Error,
    "Unknown formula",
  );
});

// ── calculateItemTax ─────────────────────────────────────────────

Deno.test("calculateItemTax with tax_none returns 0", () => {
  assertEquals(calculateItemTax(makeItem()), 0);
});

Deno.test("calculateItemTax with chicago sales tax", () => {
  const item = makeItem({}, { tax_profile: "tax_chicago_sales_tax" });
  assertEquals(calculateItemTax(item), 10.25);
});

Deno.test("calculateItemTax with chicago rental tax", () => {
  const item = makeItem({}, { tax_profile: "tax_chicago_rental_tax" });
  assertEquals(calculateItemTax(item), 15);
});

// ── calculateItemTotal ───────────────────────────────────────────

Deno.test("calculateItemTotal no tax", () => {
  assertEquals(calculateItemTotal(makeItem()), 100);
});

Deno.test("calculateItemTotal with tax", () => {
  assertEquals(
    calculateItemTotal(makeItem({}, { tax_profile: "tax_chicago_sales_tax" })),
    110.25,
  );
});

// ── calculateItemDiscount ────────────────────────────────────────

Deno.test("calculateItemDiscount returns 0 for no discount", () => {
  assertEquals(calculateItemDiscount(makeItem()), 0);
});

Deno.test("calculateItemDiscount calculates 10% discount", () => {
  assertEquals(calculateItemDiscount(makeItem({}, { discount_percent: 10 })), 10);
});

Deno.test("calculateItemDiscount fixed formula", () => {
  assertEquals(
    calculateItemDiscount(
      makeItem({}, { formula: "fixed", base: 100, discount_percent: 20 }),
    ),
    20,
  );
});

// ── getTotalDiscount ─────────────────────────────────────────────

Deno.test("getTotalDiscount sums all item discounts", () => {
  const items = [
    makeItem({}, { discount_percent: 10 }),
    makeItem({}, { discount_percent: 20 }),
  ];
  assertEquals(getTotalDiscount(items), 30);
});

Deno.test("getTotalDiscount skips non-priceable items", () => {
  const items = [
    makeItem({}, { discount_percent: 10 }),
    { type: "destination" } as LineItem,
  ];
  assertEquals(getTotalDiscount(items), 10);
});

// ── getTaxesByTaxProfile ─────────────────────────────────────────

Deno.test("getTaxesByTaxProfile groups by profile", () => {
  const items = [
    makeItem({}, { tax_profile: "tax_chicago_sales_tax" }),
    makeItem({}, { tax_profile: "tax_chicago_sales_tax" }),
    makeItem({}, { tax_profile: "tax_chicago_rental_tax" }),
    makeItem(),
  ];
  const result = getTaxesByTaxProfile(items);
  assertEquals(result["tax_chicago_sales_tax"], 20.50);
  assertEquals(result["tax_chicago_rental_tax"], 15);
  assertEquals(result["tax_none"], undefined);
});

// ── calculateOrderTotals ─────────────────────────────────────────

Deno.test("calculateOrderTotals computes all totals", () => {
  const items = [
    makeItem({}, { tax_profile: "tax_chicago_sales_tax", discount_percent: 10 }),
    makeItem({}, { formula: "fixed", base: 50 }),
  ];
  const result = calculateOrderTotals(items);
  assertEquals(result.subtotal, 140); // 90 + 50
  assertEquals(result.discount_amount, 10);
  assertEquals(result.taxes["tax_chicago_sales_tax"], 9.23); // 90 * 0.1025
  assertEquals(result.total, 149.23); // 140 + 9.23
});

// ── Order inspection helpers ─────────────────────────────────────

Deno.test("orderHasRentals detects rental items", () => {
  assertEquals(orderHasRentals([makeItem()]), true);
  assertEquals(
    orderHasRentals([makeItem({}, { formula: "fixed" })]),
    true,
  );
  assertEquals(orderHasRentals([makeItem({ type: "sale" })]), false);
});

Deno.test("orderHasDiscount detects discounted items", () => {
  assertEquals(orderHasDiscount([makeItem({}, { discount_percent: 10 })]), true);
  assertEquals(orderHasDiscount([makeItem()]), false);
});

Deno.test("orderHasTax detects taxed items", () => {
  assertEquals(
    orderHasTax([makeItem({}, { tax_profile: "tax_chicago_sales_tax" })]),
    true,
  );
  assertEquals(orderHasTax([makeItem()]), false);
});

// ── getGroupPath ─────────────────────────────────────────────────

Deno.test("getGroupPath finds destination and group", () => {
  const items: LineItem[] = [
    { type: "destination", uid_delivery: "dest-1" },
    { type: "group", name: "Camera" },
    makeItem({ uid: "item-1" }),
  ];
  const result = getGroupPath(items, 2);
  assertEquals(result.destination, "dest-1");
  assertEquals(result.group, "Camera");
});

Deno.test("getGroupPath returns nulls when no headers", () => {
  const items = [makeItem({ uid: "item-1" })];
  const result = getGroupPath(items, 0);
  assertEquals(result.destination, null);
  assertEquals(result.group, null);
});

// ── consolidateItems ─────────────────────────────────────────────

Deno.test("consolidateItems deduplicates by uid", () => {
  const items = [
    makeItem({ uid: "p1", quantity: 2 }, { total: 200 }),
    makeItem({ uid: "p1", quantity: 1 }, { total: 100 }),
    makeItem({ uid: "p2", quantity: 1 }, { total: 50 }),
  ];
  const result = consolidateItems(items);
  assertEquals(result.length, 2);
  const p1 = result.find((r) => r.uid === "p1")!;
  assertEquals(p1.quantity, 3);
  assertEquals(p1.total_price, 300);
  assertEquals(p1.unit_price, 100);
});

Deno.test("consolidateItems skips structural items", () => {
  const items: LineItem[] = [
    { type: "destination", uid_delivery: "d1" },
    { type: "group", name: "G1" },
    makeItem({ uid: "p1" }),
  ];
  const result = consolidateItems(items);
  assertEquals(result.length, 1);
  assertEquals(result[0].uid, "p1");
});

// ── groupByDestination ───────────────────────────────────────────

Deno.test("groupByDestination splits by destination dividers", () => {
  const items: LineItem[] = [
    { type: "destination", uid_delivery: "d1", uid_collection: "d1" },
    makeItem({ uid: "p1", type: "rental" }),
    makeItem({ uid: "p2", type: "sale" }),
    { type: "destination", uid_delivery: "d2", uid_collection: "d2" },
    makeItem({ uid: "p3", type: "rental" }),
  ];
  const result = groupByDestination(items, "fallback");
  assertEquals(result.length, 2);
  assertEquals(result[0].uid_delivery, "d1");
  assertEquals(result[0].items.length, 2);
  assertEquals(result[0].packing_list_delivery.length, 2);
  assertEquals(result[0].packing_list_collection.length, 1);
  assertEquals(result[1].uid_delivery, "d2");
  assertEquals(result[1].items.length, 1);
});

Deno.test("groupByDestination uses fallback when no dividers", () => {
  const items = [makeItem({ uid: "p1", type: "rental" })];
  const result = groupByDestination(items, "fb-delivery", "fb-collection");
  assertEquals(result.length, 1);
  assertEquals(result[0].uid_delivery, "fb-delivery");
  assertEquals(result[0].uid_collection, "fb-collection");
});

Deno.test("groupByDestination returns empty section for empty items", () => {
  const result = groupByDestination([], "fb");
  assertEquals(result.length, 1);
  assertEquals(result[0].items.length, 0);
});

// ── getGroupItems ────────────────────────────────────────────────

Deno.test("getGroupItems collects destination children", () => {
  const items: LineItem[] = [
    { type: "destination" },
    { type: "group", name: "G1" },
    makeItem({ uid: "p1" }),
    makeItem({ uid: "p2" }),
    { type: "destination" },
  ];
  const result = getGroupItems(items, 0);
  assertEquals(result.length, 2);
});

Deno.test("getGroupItems collects group children", () => {
  const items: LineItem[] = [
    { type: "group", name: "G1" },
    makeItem({ uid: "p1" }),
    makeItem({ uid: "p2" }),
    { type: "group", name: "G2" },
  ];
  const result = getGroupItems(items, 0);
  assertEquals(result.length, 2);
});

Deno.test("getGroupItems collects zero-priced components for product", () => {
  const items: LineItem[] = [
    makeItem({ uid: "parent" }),
    makeItem({ uid: "child1", uid_component_of: "parent", zero_priced: true }),
    makeItem({ uid: "child2", uid_component_of: "parent", zero_priced: true }),
    makeItem({ uid: "other" }),
  ];
  const result = getGroupItems(items, 0);
  assertEquals(result.length, 2);
});

// ── getGroupTotals ───────────────────────────────────────────────

Deno.test("getGroupTotals returns count and pricing", () => {
  const items: LineItem[] = [
    { type: "group", name: "G1" },
    makeItem({ uid: "p1" }),
    makeItem({ uid: "p2" }),
  ];
  const result = getGroupTotals(items, 0);
  assertEquals(result.count, 2);
  assertEquals(result.subtotal, 200);
  assertEquals(result.total, 200);
});

Deno.test("getGroupTotals returns zeros for empty group", () => {
  const items: LineItem[] = [
    { type: "group", name: "G1" },
    { type: "group", name: "G2" },
  ];
  const result = getGroupTotals(items, 0);
  assertEquals(result.count, 0);
  assertEquals(result.subtotal, 0);
  assertEquals(result.total, 0);
});
