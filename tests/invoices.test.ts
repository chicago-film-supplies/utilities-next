import { assertEquals } from "@std/assert";
import {
  buildOrderScopedItems,
  carryForwardOverrides,
  flattenForXero,
  getOrderScopedItems,
  type InvoiceItem,
  type LineItem,
  removeOrderScopedItems,
  syncOrderItems,
} from "../src/invoices.ts";

// ── Test data ───────────────────────────────────────────────────

const orderDivider: InvoiceItem = {
  uid: "order-div-1",
  type: "order",
  name: "Order #1001",
  uid_order: "order-1",
};

const destItem: InvoiceItem = {
  uid: "dest-1",
  type: "destination",
  name: "Main Venue",
  uid_delivery: "del-1",
  uid_collection: null,
  path: ["order-div-1"],
};

const lineItem1: InvoiceItem = {
  uid: "item-1",
  type: "rental",
  name: "Spot Light",
  quantity: 2,
  price: {
    base: 100,
    formula: "five_day_week" as const,
    chargeable_days: 5,
    discount: null,
    taxes: [],
    subtotal: 200,
    subtotal_discounted: 200,
  },
  path: ["order-div-1", "dest-1"],
  coa_revenue: "4100",
  tracking_category: "rentals",
};

const lineItem2: InvoiceItem = {
  uid: "item-2",
  type: "sale",
  name: "Tripod",
  quantity: 1,
  price: {
    base: 300,
    formula: "fixed" as const,
    chargeable_days: null,
    discount: null,
    taxes: [],
    subtotal: 300,
    subtotal_discounted: 300,
  },
  path: ["order-div-1", "dest-1"],
  xero_id: "xero-123",
};

const orderDivider2: InvoiceItem = {
  uid: "order-div-2",
  type: "order",
  name: "Order #1002",
  uid_order: "order-2",
};

const lineItem3: InvoiceItem = {
  uid: "item-3",
  type: "rental",
  name: "Camera",
  quantity: 1,
  price: {
    base: 500,
    formula: "five_day_week" as const,
    chargeable_days: 5,
    discount: null,
    taxes: [],
    subtotal: 500,
    subtotal_discounted: 500,
  },
  path: ["order-div-2"],
};

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
    { type: "order", uid: "o1", name: "Order" },
    { type: "destination", uid: "d1", name: "Venue" },
    { type: "group", uid: "g1", name: "Lighting" },
    { type: "rental", uid: "i1", name: "Light", quantity: 1 },
    { type: "sale", uid: "i2", name: "Tripod", quantity: 1 },
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
    { uid: "dest-1", type: "destination", name: "Venue" },
    { uid: "item-1", type: "rental", name: "Light", path: ["dest-1"] },
    { uid: "item-2", type: "rental", name: "Camera" },
  ];
  const result = buildOrderScopedItems(orderItems, "order-div-1");
  assertEquals(result[0].path, ["order-div-1"]);
  assertEquals(result[1].path, ["order-div-1", "dest-1"]);
  assertEquals(result[2].path, ["order-div-1"]);
});

// ── carryForwardOverrides ───────────────────────────────────────

Deno.test("carryForwardOverrides preserves coa_revenue and xero_id from existing items", () => {
  const rebuilt: InvoiceItem[] = [
    { uid: "item-1", type: "rental", name: "Light Updated", quantity: 3 },
    { uid: "item-new", type: "sale", name: "New Item", quantity: 1 },
  ];
  const existing: InvoiceItem[] = [
    { uid: "item-1", type: "rental", name: "Light", coa_revenue: "4100", xero_id: "xero-1" },
    { uid: "item-removed", type: "sale", name: "Gone", coa_revenue: "4200" },
  ];
  const result = carryForwardOverrides(rebuilt, existing);
  assertEquals(result[0].name, "Light Updated"); // rebuilt field
  assertEquals(result[0].quantity, 3); // rebuilt field
  assertEquals(result[0].coa_revenue, "4100"); // carried forward
  assertEquals(result[0].xero_id, "xero-1"); // carried forward
  assertEquals(result[1].coa_revenue, undefined); // new item, no override
});

// ── syncOrderItems ──────────────────────────────────────────────

Deno.test("syncOrderItems replaces scoped items and carries forward overrides", () => {
  const newOrderItems: LineItem[] = [
    { uid: "dest-1", type: "destination", name: "Venue Renamed" },
    { uid: "item-1", type: "rental", name: "Spot Light v2", quantity: 5, path: ["dest-1"] },
    { uid: "item-new", type: "service", name: "Setup Fee", quantity: 1 },
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
  assertEquals((result[2] as InvoiceItem).coa_revenue, "4100"); // carried forward

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
    { uid: "existing", type: "rental", name: "Existing Item", quantity: 1 },
  ];
  const orderItems: LineItem[] = [
    { uid: "new-item", type: "sale", name: "New", quantity: 1 },
  ];
  const result = syncOrderItems(items, orderItems, "unknown-divider");
  assertEquals(result.length, 2);
  assertEquals(result[0].uid, "existing");
  assertEquals(result[1].path, ["unknown-divider"]);
});
