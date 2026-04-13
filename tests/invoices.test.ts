import { assertEquals } from "@std/assert";
import { getInitialValues, InvoiceDocLineItemSchema, InvoiceDocOrderItem } from "@cfs/schemas";
import {
  buildOrderScopedItems,
  calculateInvoiceTotals,
  carryForwardOverrides,
  derivePaymentStatus,
  flattenForXero,
  getOrderScopedItems,
  getXeroUnitAmount,
  type InvoiceItem,
  type LineItem,
  type Tax,
  recomputePaymentTotals,
  removeOrderScopedItems,
  syncOrderItems,
} from "../src/invoices.ts";

// ── Schema bases ────────────────────────────────────────────────

const lineItemBase = getInitialValues(InvoiceDocLineItemSchema) as Record<string, unknown>;
const priceBase = (lineItemBase as { price: Record<string, unknown> }).price;
const orderDividerBase = getInitialValues(InvoiceDocOrderItem) as Record<string, unknown>;

function makeItem(
  overrides: Partial<InvoiceItem> = {},
  priceOverrides: Record<string, unknown> = {},
): InvoiceItem {
  return {
    ...lineItemBase,
    name: "Test Item",
    quantity: 1,
    ...overrides,
    price: {
      ...priceBase,
      ...priceOverrides,
    },
  } as unknown as InvoiceItem;
}

// ── Test data ───────────────────────────────────────────────────

const orderDivider: InvoiceItem = {
  ...orderDividerBase,
  uid: "order-div-1",
  name: "Order #1001",
  uid_order: "order-1",
} as InvoiceItem;

const destItem: InvoiceItem = {
  uid: "dest-1",
  type: "destination",
  name: "Main Venue",
  uid_delivery: "del-1",
  uid_collection: null,
  path: ["order-div-1"],
};

const lineItem1: InvoiceItem = {
  ...lineItemBase,
  uid: "item-1",
  type: "rental",
  name: "Spot Light",
  quantity: 2,
  price: {
    ...priceBase,
    base: 100,
    chargeable_days: 5,
    subtotal: 200,
    subtotal_discounted: 200,
    total: 200,
  },
  path: ["order-div-1", "dest-1"],
  coa_revenue: 4100,
  tracking_category: "rentals",
} as InvoiceItem;

const lineItem2: InvoiceItem = {
  ...lineItemBase,
  uid: "item-2",
  type: "sale",
  name: "Tripod",
  quantity: 1,
  price: {
    ...priceBase,
    base: 300,
    formula: "fixed",
    subtotal: 300,
    subtotal_discounted: 300,
    total: 300,
  },
  path: ["order-div-1", "dest-1"],
  xero_id: "xero-123",
} as InvoiceItem;

const orderDivider2: InvoiceItem = {
  ...orderDividerBase,
  uid: "order-div-2",
  name: "Order #1002",
  uid_order: "order-2",
} as InvoiceItem;

const lineItem3: InvoiceItem = {
  ...lineItemBase,
  uid: "item-3",
  type: "rental",
  name: "Camera",
  quantity: 1,
  price: {
    ...priceBase,
    base: 500,
    chargeable_days: 5,
    subtotal: 500,
    subtotal_discounted: 500,
    total: 500,
  },
  path: ["order-div-2"],
} as InvoiceItem;

const multiOrderInvoiceItems: InvoiceItem[] = [
  orderDivider,
  destItem,
  lineItem1,
  lineItem2,
  orderDivider2,
  lineItem3,
];

// ── flattenForXero ──────────────────────────────────────────────

Deno.test("flattenForXero removes destination, group, and order dividers", () => {
  const items: LineItem[] = [
    { type: "order", uid: "o1", name: "Order", path: [] },
    { type: "destination", uid: "d1", name: "Venue", path: [] },
    { type: "group", uid: "g1", name: "Lighting", path: [] },
    { type: "rental", uid: "i1", name: "Light", quantity: 1, path: [] },
    { type: "sale", uid: "i2", name: "Tripod", quantity: 1, path: [] },
  ];
  const result = flattenForXero(items);
  assertEquals(result.length, 2);
  assertEquals(result[0].uid, "i1");
  assertEquals(result[1].uid, "i2");
});

// ── getOrderScopedItems ─────────────────────────────────────────

Deno.test("getOrderScopedItems returns divider and children for order-div-1", () => {
  const result = getOrderScopedItems(multiOrderInvoiceItems, "order-div-1");
  assertEquals(result.length, 4); // divider + dest + 2 line items
  assertEquals(result[0].uid, "order-div-1");
  assertEquals(result[1].uid, "dest-1");
  assertEquals(result[2].uid, "item-1");
  assertEquals(result[3].uid, "item-2");
});

Deno.test("getOrderScopedItems returns divider and children for order-div-2", () => {
  const result = getOrderScopedItems(multiOrderInvoiceItems, "order-div-2");
  assertEquals(result.length, 2); // divider + 1 line item
  assertEquals(result[0].uid, "order-div-2");
  assertEquals(result[1].uid, "item-3");
});

Deno.test("getOrderScopedItems returns empty for unknown divider", () => {
  const result = getOrderScopedItems(multiOrderInvoiceItems, "nonexistent");
  assertEquals(result.length, 0);
});

// ── removeOrderScopedItems ──────────────────────────────────────

Deno.test("removeOrderScopedItems removes order-div-1 scope, keeps order-div-2", () => {
  const result = removeOrderScopedItems(multiOrderInvoiceItems, "order-div-1");
  assertEquals(result.length, 2); // order-div-2 + item-3
  assertEquals(result[0].uid, "order-div-2");
  assertEquals(result[1].uid, "item-3");
});

Deno.test("removeOrderScopedItems removes order-div-2 scope, keeps order-div-1", () => {
  const result = removeOrderScopedItems(multiOrderInvoiceItems, "order-div-2");
  assertEquals(result.length, 4); // order-div-1 + dest + 2 line items
});

// ── buildOrderScopedItems ───────────────────────────────────────

Deno.test("buildOrderScopedItems prepends order divider uid to path", () => {
  const orderItems: LineItem[] = [
    { uid: "dest-1", type: "destination", name: "Venue", path: [] },
    { uid: "item-1", type: "rental", name: "Light", path: ["dest-1"] },
    { uid: "item-2", type: "rental", name: "Camera", path: [] },
  ];
  const result = buildOrderScopedItems(orderItems, "order-div-1");
  assertEquals(result[0].path, ["order-div-1"]);
  assertEquals(result[1].path, ["order-div-1", "dest-1"]);
  assertEquals(result[2].path, ["order-div-1"]);
});

// ── carryForwardOverrides ───────────────────────────────────────

Deno.test("carryForwardOverrides preserves coa_revenue and xero_id from existing items", () => {
  const rebuilt: InvoiceItem[] = [
    { uid: "item-1", type: "rental", name: "Light Updated", quantity: 3, path: [] },
    { uid: "item-new", type: "sale", name: "New Item", quantity: 1, path: [] },
  ];
  const existing: InvoiceItem[] = [
    { uid: "item-1", type: "rental", name: "Light", coa_revenue: 4100, xero_id: "xero-1", path: [] },
    { uid: "item-removed", type: "sale", name: "Gone", coa_revenue: 4200, path: [] },
  ];
  const result = carryForwardOverrides(rebuilt, existing);
  assertEquals(result[0].name, "Light Updated"); // rebuilt field
  assertEquals(result[0].quantity, 3); // rebuilt field
  assertEquals(result[0].coa_revenue, 4100); // carried forward
  assertEquals(result[0].xero_id, "xero-1"); // carried forward
  assertEquals(result[1].coa_revenue, undefined); // new item, no override
});

// ── syncOrderItems ──────────────────────────────────────────────

Deno.test("syncOrderItems replaces scoped items and carries forward overrides", () => {
  const newOrderItems: LineItem[] = [
    { uid: "dest-1", type: "destination", name: "Venue Renamed", path: [] },
    { uid: "item-1", type: "rental", name: "Spot Light v2", quantity: 5, path: ["dest-1"] },
    { uid: "item-new", type: "service", name: "Setup Fee", quantity: 1, path: [] },
  ];

  const result = syncOrderItems(multiOrderInvoiceItems, newOrderItems, "order-div-1");

  // Order divider preserved
  assertEquals(result[0].uid, "order-div-1");
  assertEquals(result[0].type, "order");

  // Rebuilt items have prepended path
  assertEquals(result[1].path, ["order-div-1"]);
  assertEquals(result[1].name, "Venue Renamed");

  assertEquals(result[2].path, ["order-div-1", "dest-1"]);
  assertEquals(result[2].name, "Spot Light v2");
  assertEquals(result[2].quantity, 5);
  assertEquals((result[2] as InvoiceItem).coa_revenue, 4100); // carried forward

  assertEquals(result[3].path, ["order-div-1"]);
  assertEquals(result[3].name, "Setup Fee");

  // Order-div-2 items untouched
  assertEquals(result[4].uid, "order-div-2");
  assertEquals(result[5].uid, "item-3");

  // item-2 (Tripod) was removed from order → gone from invoice
  const tripod = result.find((i) => i.uid === "item-2");
  assertEquals(tripod, undefined);
});

Deno.test("syncOrderItems preserves order when divider not found (appends)", () => {
  const items: InvoiceItem[] = [
    { uid: "existing", type: "rental", name: "Existing Item", quantity: 1, path: [] },
  ];
  const orderItems: LineItem[] = [
    { uid: "new-item", type: "sale", name: "New", quantity: 1, path: [] },
  ];
  const result = syncOrderItems(items, orderItems, "unknown-divider");
  assertEquals(result.length, 2);
  assertEquals(result[0].uid, "existing");
  assertEquals(result[1].path, ["unknown-divider"]);
});

// ── calculateInvoiceTotals ─────────────────────────────────────

const TAXES: Tax[] = [
  { uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent" },
  { uid: "chi-sales-tax", name: "Chicago Sales Tax", rate: 10.25, type: "percent" },
];

Deno.test("calculateInvoiceTotals computes totals from billable items only", () => {
  const items: InvoiceItem[] = [
    { uid: "order-div", type: "order", name: "Order #1", path: [] },
    { uid: "dest", type: "destination", name: "Venue", path: [] },
    { uid: "group", type: "group", name: "Lighting", path: [] },
    makeItem(
      { uid: "item-1", type: "rental", name: "Spot Light", quantity: 2 },
      { base: 100, chargeable_days: 5, subtotal: 200, subtotal_discounted: 200, total: 200 },
    ),
    makeItem(
      { uid: "item-2", type: "sale", name: "Tripod", quantity: 1 },
      { base: 300, formula: "fixed", subtotal: 300, subtotal_discounted: 300, total: 300 },
    ),
  ];

  const result = calculateInvoiceTotals(items, []);
  assertEquals(result.subtotal, 500);
  assertEquals(result.subtotal_discounted, 500);
  assertEquals(result.discount_amount, 0);
  assertEquals(result.total, 500);
  assertEquals(result.amount_paid, 0);
  assertEquals(result.amount_due, 500);
  assertEquals(result.taxes, []);
  assertEquals(result.transaction_fees, []);
});

Deno.test("calculateInvoiceTotals applies discount", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base: 100, chargeable_days: 5, discount: { type: "percent", rate: 10, amount: 10 }, subtotal: 100, subtotal_discounted: 90, total: 90 },
    ),
  ];
  const result = calculateInvoiceTotals(items, []);
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 90);
  assertEquals(result.discount_amount, 10);
  assertEquals(result.total, 90);
});

Deno.test("calculateInvoiceTotals with taxes", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base: 100, chargeable_days: 5, taxes: [{ uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent", amount: 15 }], subtotal: 100, subtotal_discounted: 100, total: 115 },
    ),
  ];
  const result = calculateInvoiceTotals(items, TAXES);
  assertEquals(result.subtotal, 100);
  assertEquals(result.total, 115);
  assertEquals(result.taxes.length, 1);
  assertEquals(result.taxes[0].name, "Chicago Rental Tax");
  assertEquals(result.taxes[0].amount, 15);
});

Deno.test("calculateInvoiceTotals with payments reduces amount_due", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base: 1000, formula: "fixed", subtotal: 1000, subtotal_discounted: 1000, total: 1000 },
    ),
  ];
  const payments = [
    { amount: 400, status: "active" },
    { amount: 100, status: "deleted" },
    { amount: 200, status: "active" },
  ];
  const result = calculateInvoiceTotals(items, [], payments);
  assertEquals(result.total, 1000);
  assertEquals(result.amount_paid, 600);
  assertEquals(result.amount_due, 400);
});

Deno.test("calculateInvoiceTotals with empty items returns zeros", () => {
  const result = calculateInvoiceTotals([], []);
  assertEquals(result.subtotal, 0);
  assertEquals(result.subtotal_discounted, 0);
  assertEquals(result.discount_amount, 0);
  assertEquals(result.total, 0);
  assertEquals(result.amount_paid, 0);
  assertEquals(result.amount_due, 0);
});

Deno.test("calculateInvoiceTotals with transaction fee", () => {
  const items: InvoiceItem[] = [
    makeItem(
      { uid: "item-1", type: "rental", name: "Light" },
      { base: 100, formula: "fixed", subtotal: 100, subtotal_discounted: 100, total: 100 },
    ),
    {
      uid: "fee-1", type: "transaction_fee", name: "Credit Card Fee", path: [],
      price: { uid: "cc-fee", name: "Credit Card Fee", rate: 3, type: "percent", amount: 0 },
    },
  ];
  const result = calculateInvoiceTotals(items, []);
  assertEquals(result.subtotal, 100);
  assertEquals(result.transaction_fees.length, 1);
  assertEquals(result.transaction_fees[0].name, "Credit Card Fee");
  assertEquals(result.transaction_fees[0].amount, 3);
  assertEquals(result.total, 103);
});

// ── derivePaymentStatus ─────────────────────────────────────────

Deno.test("derivePaymentStatus passes through draft", () => {
  assertEquals(derivePaymentStatus("draft", 0, 1000), "draft");
});

Deno.test("derivePaymentStatus passes through void", () => {
  assertEquals(derivePaymentStatus("void", 500, 500), "void");
});

Deno.test("derivePaymentStatus returns paid when amount_due <= 0", () => {
  assertEquals(derivePaymentStatus("issued", 1000, 0), "paid");
});

Deno.test("derivePaymentStatus returns part_paid when some paid", () => {
  assertEquals(derivePaymentStatus("issued", 500, 500), "part_paid");
});

Deno.test("derivePaymentStatus returns issued when nothing paid", () => {
  assertEquals(derivePaymentStatus("issued", 0, 1000), "issued");
});

// ── recomputePaymentTotals ──────────────────────────────────────

Deno.test("recomputePaymentTotals sums active payments only", () => {
  const payments = [
    { amount: 400, status: "active" },
    { amount: 100, status: "deleted" },
    { amount: 200, status: "active" },
  ];
  const result = recomputePaymentTotals(1000, payments);
  assertEquals(result.amount_paid, 600);
  assertEquals(result.amount_due, 400);
});

Deno.test("recomputePaymentTotals with no payments", () => {
  const result = recomputePaymentTotals(500, []);
  assertEquals(result.amount_paid, 0);
  assertEquals(result.amount_due, 500);
});

Deno.test("recomputePaymentTotals with zero total", () => {
  const result = recomputePaymentTotals(0, [{ amount: 50, status: "active" }]);
  assertEquals(result.amount_paid, 50);
  assertEquals(result.amount_due, -50);
});

// ── getXeroUnitAmount ─────────────────────────────���────────────

Deno.test("getXeroUnitAmount divides subtotal by quantity", () => {
  assertEquals(getXeroUnitAmount(500, 2), 250);
});

Deno.test("getXeroUnitAmount returns 0 for zero quantity", () => {
  assertEquals(getXeroUnitAmount(500, 0), 0);
});

Deno.test("getXeroUnitAmount handles fractional result", () => {
  assertEquals(getXeroUnitAmount(100, 3), 33.33);
});
