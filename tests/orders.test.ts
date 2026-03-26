import { assertEquals, assertThrows } from "@std/assert";
import {
  calculateItemDiscount,
  calculateItemPrice,
  calculateItemSubtotal,
  calculateItemTax,
  calculateItemTotal,
  calculateOrderTotals,
  consolidateItems,
  getGroupItems,
  getGroupPath,
  getGroupTotals,
  getTransactionFeeTotals,
  getTaxTotals,
  getTotalDiscount,
  groupByDestination,
  isPriceableItem,
  isPreTaxItem,
  isTransactionFeeItem,
  type LineItem,
  type Tax,
  orderHasDiscount,
  orderHasRentals,
  orderHasTax,
} from "../src/orders.ts";

const TAXES: Tax[] = [
  { uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent" },
  { uid: "chi-sales-tax", name: "Chicago Sales Tax", rate: 10.25, type: "percent" },
  { uid: "rantoul-sales-tax", name: "Rantoul Sales Tax", rate: 9, type: "percent" },
  { uid: "water-bottle-tax", name: "Water Bottle Tax", rate: 0.05, type: "flat" },
  { uid: "tax-none", name: "No Tax", rate: 0, type: "percent" },
];

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
      discount: null,
      taxes: [],
      subtotal: 0,
      subtotal_discounted: 0,
      total: 0,
      ...priceOverrides,
    },
  };
}

function makeFeeItem(
  overrides: Partial<LineItem> = {},
  feeOverrides: Record<string, unknown> = {},
): LineItem {
  return {
    name: "CC Processing Fee",
    type: "transaction_fee",
    quantity: 1,
    ...overrides,
    price: {
      uid: "cc-fee-product",
      name: "Credit Card Processing Fee",
      rate: 3,
      type: "percent" as const,
      amount: 0,
      ...feeOverrides,
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

Deno.test("isPriceableItem returns true for transaction fee with price", () => {
  assertEquals(isPriceableItem(makeFeeItem()), true);
});

// ── isTransactionFeeItem ─────────────────────────────────────────

Deno.test("isTransactionFeeItem returns true for fee item", () => {
  assertEquals(isTransactionFeeItem(makeFeeItem()), true);
});

Deno.test("isTransactionFeeItem returns false for rental", () => {
  assertEquals(isTransactionFeeItem(makeItem()), false);
});

// ── isPreTaxItem ─────────────────────────────────────────────────

Deno.test("isPreTaxItem returns true for rental with price", () => {
  assertEquals(isPreTaxItem(makeItem()), true);
});

Deno.test("isPreTaxItem returns false for transaction fee", () => {
  assertEquals(isPreTaxItem(makeFeeItem()), false);
});

Deno.test("isPreTaxItem returns false for destination", () => {
  assertEquals(isPreTaxItem({ type: "destination" }), false);
});

// ── calculateItemSubtotal ────────────────────────────────────────

Deno.test("calculateItemSubtotal five_day_week 1 week", () => {
  const result = calculateItemSubtotal(makeItem());
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 100);
});

Deno.test("calculateItemSubtotal five_day_week 2 weeks", () => {
  const result = calculateItemSubtotal(makeItem({}, { chargeable_days: 10 }));
  assertEquals(result.subtotal, 200);
  assertEquals(result.subtotal_discounted, 200);
});

Deno.test("calculateItemSubtotal five_day_week 3 days", () => {
  const result = calculateItemSubtotal(makeItem({}, { chargeable_days: 3 }));
  assertEquals(result.subtotal, 60);
  assertEquals(result.subtotal_discounted, 60);
});

Deno.test("calculateItemSubtotal with percent discount", () => {
  const result = calculateItemSubtotal(makeItem({}, {
    discount: { rate: 10, type: "percent", amount: 0 },
  }));
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 90);
});

Deno.test("calculateItemSubtotal with flat discount", () => {
  const result = calculateItemSubtotal(makeItem({ quantity: 2 }, {
    chargeable_days: 5,
    discount: { rate: 10, type: "flat", amount: 0 },
  }));
  // subtotal = 100 * 2 * 1 = 200
  // flat discount = 10 * 2 * 1 = 20
  assertEquals(result.subtotal, 200);
  assertEquals(result.subtotal_discounted, 180);
});

Deno.test("calculateItemSubtotal flat discount scales with days", () => {
  const result = calculateItemSubtotal(makeItem({ quantity: 1 }, {
    chargeable_days: 10,
    discount: { rate: 5, type: "flat", amount: 0 },
  }));
  // subtotal = 100 * 1 * 2 = 200
  // flat discount = 5 * 1 * 2 = 10
  assertEquals(result.subtotal, 200);
  assertEquals(result.subtotal_discounted, 190);
});

Deno.test("calculateItemSubtotal with quantity", () => {
  const result = calculateItemSubtotal(makeItem({ quantity: 3 }));
  assertEquals(result.subtotal, 300);
  assertEquals(result.subtotal_discounted, 300);
});

Deno.test("calculateItemSubtotal fixed formula", () => {
  const result = calculateItemSubtotal(makeItem({}, { formula: "fixed", base: 50 }));
  assertEquals(result.subtotal, 50);
  assertEquals(result.subtotal_discounted, 50);
});

Deno.test("calculateItemSubtotal fixed with quantity and percent discount", () => {
  const result = calculateItemSubtotal(
    makeItem({ quantity: 2 }, { formula: "fixed", base: 100, discount: { rate: 25, type: "percent", amount: 0 } }),
  );
  assertEquals(result.subtotal, 200);
  assertEquals(result.subtotal_discounted, 150);
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

Deno.test("calculateItemTax with no taxes returns empty array", () => {
  assertEquals(calculateItemTax(makeItem(), TAXES), []);
});

Deno.test("calculateItemTax with percent tax", () => {
  const item = makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] });
  const result = calculateItemTax(item, TAXES);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Chicago Sales Tax");
  assertEquals(result[0].amount, 10.25);
});

Deno.test("calculateItemTax with rental tax", () => {
  const item = makeItem({}, { taxes: [{ uid: "chi-rental-tax" }] });
  const result = calculateItemTax(item, TAXES);
  assertEquals(result.length, 1);
  assertEquals(result[0].amount, 15);
});

Deno.test("calculateItemTax with flat tax", () => {
  const item = makeItem({ quantity: 24 }, {
    formula: "fixed",
    base: 1,
    taxes: [{ uid: "water-bottle-tax" }],
  });
  const result = calculateItemTax(item, TAXES);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Water Bottle Tax");
  assertEquals(result[0].type, "flat");
  assertEquals(result[0].amount, 1.20);
});

Deno.test("calculateItemTax multi-tax per item", () => {
  const item = makeItem({ quantity: 24 }, {
    formula: "fixed",
    base: 1,
    taxes: [{ uid: "chi-sales-tax" }, { uid: "water-bottle-tax" }],
  });
  const result = calculateItemTax(item, TAXES);
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "Chicago Sales Tax");
  assertEquals(result[0].amount, 2.46); // 24 * 0.1025
  assertEquals(result[1].name, "Water Bottle Tax");
  assertEquals(result[1].amount, 1.20); // 0.05 * 24
});

Deno.test("calculateItemTax throws for unknown tax uid", () => {
  const item = makeItem({}, { taxes: [{ uid: "nonexistent" }] });
  assertThrows(
    () => calculateItemTax(item, TAXES),
    Error,
    "Unknown tax uid",
  );
});

Deno.test("calculateItemTax applies to subtotal_discounted", () => {
  const item = makeItem({}, {
    discount: { rate: 20, type: "percent", amount: 0 },
    taxes: [{ uid: "chi-rental-tax" }],
  });
  // subtotal_discounted = 100 * 0.8 = 80
  // tax = 80 * 0.15 = 12
  const result = calculateItemTax(item, TAXES);
  assertEquals(result[0].amount, 12);
});

// ── calculateItemPrice ───────────────────────────────────────────

Deno.test("calculateItemPrice computes full pipeline", () => {
  const item = makeItem({}, {
    discount: { rate: 20, type: "percent", amount: 0 },
    taxes: [{ uid: "chi-rental-tax" }],
  });
  const result = calculateItemPrice(item, TAXES);
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 80);
  assertEquals(result.discount!.rate, 20);
  assertEquals(result.discount!.type, "percent");
  assertEquals(result.discount!.amount, 20);
  assertEquals(result.taxes[0].amount, 12); // 80 * 0.15
  assertEquals(result.total, 92); // 80 + 12
});

Deno.test("calculateItemPrice with no discount", () => {
  const item = makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] });
  const result = calculateItemPrice(item, TAXES);
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 100);
  assertEquals(result.discount, null);
  assertEquals(result.total, 110.25);
});

// ── calculateItemTotal ───────────────────────────────────────────

Deno.test("calculateItemTotal no tax", () => {
  assertEquals(calculateItemTotal(makeItem(), TAXES), 100);
});

Deno.test("calculateItemTotal with tax", () => {
  assertEquals(
    calculateItemTotal(makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] }), TAXES),
    110.25,
  );
});

Deno.test("calculateItemTotal for transaction fee item", () => {
  const fee = makeFeeItem({}, { amount: 42.50 });
  assertEquals(calculateItemTotal(fee, TAXES), 42.50);
});

// ── calculateItemDiscount ────────────────────────────────────────

Deno.test("calculateItemDiscount returns 0 for no discount", () => {
  assertEquals(calculateItemDiscount(makeItem()), 0);
});

Deno.test("calculateItemDiscount calculates 10% discount", () => {
  assertEquals(calculateItemDiscount(makeItem({}, {
    discount: { rate: 10, type: "percent", amount: 0 },
  })), 10);
});

Deno.test("calculateItemDiscount fixed formula", () => {
  assertEquals(
    calculateItemDiscount(
      makeItem({}, { formula: "fixed", base: 100, discount: { rate: 20, type: "percent", amount: 0 } }),
    ),
    20,
  );
});

Deno.test("calculateItemDiscount flat discount", () => {
  assertEquals(
    calculateItemDiscount(
      makeItem({ quantity: 3 }, { discount: { rate: 5, type: "flat", amount: 0 } }),
    ),
    15, // 5 * 3 * (5/5)
  );
});

// ── getTotalDiscount ─────────────────────────────────────────────

Deno.test("getTotalDiscount sums all item discounts", () => {
  const items = [
    makeItem({}, { discount: { rate: 10, type: "percent", amount: 0 } }),
    makeItem({}, { discount: { rate: 20, type: "percent", amount: 0 } }),
  ];
  assertEquals(getTotalDiscount(items), 30);
});

Deno.test("getTotalDiscount skips non-priceable items", () => {
  const items = [
    makeItem({}, { discount: { rate: 10, type: "percent", amount: 0 } }),
    { type: "destination" } as LineItem,
  ];
  assertEquals(getTotalDiscount(items), 10);
});

Deno.test("getTotalDiscount skips transaction fee items", () => {
  const items = [
    makeItem({}, { discount: { rate: 10, type: "percent", amount: 0 } }),
    makeFeeItem(),
  ];
  assertEquals(getTotalDiscount(items), 10);
});

// ── getTaxTotals ─────────────────────────────────────────────────

Deno.test("getTaxTotals groups by tax name", () => {
  const items = [
    makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] }),
    makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] }),
    makeItem({}, { taxes: [{ uid: "chi-rental-tax" }] }),
    makeItem(),
  ];
  const result = getTaxTotals(items, TAXES);
  const salesTax = result.find((t) => t.name === "Chicago Sales Tax");
  const rentalTax = result.find((t) => t.name === "Chicago Rental Tax");
  assertEquals(salesTax?.amount, 20.50);
  assertEquals(rentalTax?.amount, 15);
  assertEquals(result.length, 2); // tax_none excluded (zero amount)
});

// ── getTransactionFeeTotals ──────────────────────────────────────

Deno.test("getTransactionFeeTotals aggregates fee items", () => {
  const items = [
    makeFeeItem({}, { amount: 10 }),
    makeFeeItem({}, { amount: 5 }),
  ];
  const result = getTransactionFeeTotals(items);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Credit Card Processing Fee");
  assertEquals(result[0].amount, 15);
});

// ── calculateOrderTotals ─────────────────────────────────────────

Deno.test("calculateOrderTotals computes all totals", () => {
  const items = [
    makeItem({}, { taxes: [{ uid: "chi-sales-tax" }], discount: { rate: 10, type: "percent", amount: 0 } }),
    makeItem({}, { formula: "fixed", base: 50 }),
  ];
  const result = calculateOrderTotals(items, TAXES);
  assertEquals(result.subtotal, 150); // 100 + 50
  assertEquals(result.subtotal_discounted, 140); // 90 + 50
  assertEquals(result.discount_amount, 10);
  assertEquals(result.taxes.find((t) => t.name === "Chicago Sales Tax")?.amount, 9.23); // 90 * 0.1025
  assertEquals(result.total, 149.23); // 140 + 9.23
});

Deno.test("calculateOrderTotals two-pass with transaction fee", () => {
  const items = [
    makeItem({}, { taxes: [{ uid: "chi-rental-tax" }] }),
    makeFeeItem({}, { rate: 3, type: "percent" }),
  ];
  const result = calculateOrderTotals(items, TAXES);
  // subtotal = 100, subtotal_discounted = 100
  // tax = 100 * 0.15 = 15
  // fee = 100 * 0.03 = 3
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 100);
  assertEquals(result.taxes[0].amount, 15);
  assertEquals(result.transaction_fees[0].amount, 3);
  assertEquals(result.total, 118); // 100 + 15 + 3
});

Deno.test("calculateOrderTotals fee based on subtotal_discounted", () => {
  const items = [
    makeItem({}, {
      discount: { rate: 20, type: "percent", amount: 0 },
      taxes: [{ uid: "chi-rental-tax" }],
    }),
    makeFeeItem({}, { rate: 3, type: "percent" }),
  ];
  const result = calculateOrderTotals(items, TAXES);
  // subtotal = 100, subtotal_discounted = 80
  // tax = 80 * 0.15 = 12
  // fee = 80 * 0.03 = 2.40
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 80);
  assertEquals(result.discount_amount, 20);
  assertEquals(result.taxes[0].amount, 12);
  assertEquals(result.transaction_fees[0].amount, 2.40);
  assertEquals(result.total, 94.40); // 80 + 12 + 2.40
});

Deno.test("calculateOrderTotals flat transaction fee", () => {
  const items = [
    makeItem(),
    makeFeeItem({ quantity: 2 }, { rate: 5, type: "flat" }),
  ];
  const result = calculateOrderTotals(items, TAXES);
  // fee = 5 * 2 = 10
  assertEquals(result.transaction_fees[0].amount, 10);
  assertEquals(result.total, 110); // 100 + 0 + 10
});

// ── Order inspection helpers ─────────────────────────────────────

Deno.test("orderHasRentals detects rental items", () => {
  assertEquals(orderHasRentals([makeItem()]), true);
  assertEquals(orderHasRentals([makeItem({ type: "sale" })]), false);
});

Deno.test("orderHasDiscount detects discounted items", () => {
  assertEquals(orderHasDiscount([makeItem({}, {
    discount: { rate: 10, type: "percent", amount: 0 },
  })]), true);
  assertEquals(orderHasDiscount([makeItem()]), false);
});

Deno.test("orderHasTax detects taxed items", () => {
  assertEquals(
    orderHasTax([makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] })]),
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

Deno.test("consolidateItems skips transaction fee items", () => {
  const items: LineItem[] = [
    makeItem({ uid: "p1" }),
    makeFeeItem({ uid: "fee-1" }),
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
  const result = getGroupTotals(items, 0, TAXES);
  assertEquals(result.count, 2);
  assertEquals(result.subtotal, 200);
  assertEquals(result.subtotal_discounted, 200);
  assertEquals(result.total, 200);
});

Deno.test("getGroupTotals returns zeros for empty group", () => {
  const items: LineItem[] = [
    { type: "group", name: "G1" },
    { type: "group", name: "G2" },
  ];
  const result = getGroupTotals(items, 0, TAXES);
  assertEquals(result.count, 0);
  assertEquals(result.subtotal, 0);
  assertEquals(result.subtotal_discounted, 0);
  assertEquals(result.total, 0);
});
