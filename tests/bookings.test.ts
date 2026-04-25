import { assertEquals } from "@std/assert";
import {
  applyBookingBreakdownDelta,
  emptyBookingsBreakdown,
  isOrderBookingsBreakdownClosed,
  mergeBookingBreakdown,
  sumBookingBreakdown,
  sumBookingsBreakdown,
} from "../src/bookings.ts";
import type { Booking } from "@cfs/schemas";

const sample = (overrides: Partial<Booking["breakdown"]> = {}): Booking["breakdown"] => ({
  quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0,
  ...overrides,
});

Deno.test("emptyBookingsBreakdown returns all-zero shape", () => {
  assertEquals(emptyBookingsBreakdown(), {
    quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0,
  });
});

Deno.test("sumBookingBreakdown sums seven values", () => {
  assertEquals(sumBookingBreakdown(sample({ out: 3, returned: 2 })), 5);
  assertEquals(sumBookingBreakdown(sample()), 0);
  assertEquals(
    sumBookingBreakdown({ quoted: 1, reserved: 1, prepped: 1, out: 1, returned: 1, lost: 1, damaged: 1 }),
    7,
  );
});

Deno.test("mergeBookingBreakdown applies patch over current", () => {
  const current = sample({ out: 5 });
  const merged = mergeBookingBreakdown(current, { out: 3, returned: 2 });
  assertEquals(merged.out, 3);
  assertEquals(merged.returned, 2);
  // Untouched keys preserved
  assertEquals(merged.quoted, 0);
});

Deno.test("mergeBookingBreakdown clones when patch is undefined", () => {
  const current = sample({ out: 5 });
  const merged = mergeBookingBreakdown(current, undefined);
  assertEquals(merged, current);
  assertEquals(merged === current, false); // fresh object
});

Deno.test("sumBookingsBreakdown rolls up across bookings", () => {
  const bookings = [
    { breakdown: sample({ out: 3 }) },
    { breakdown: sample({ out: 2, returned: 1 }) },
    { breakdown: sample({ damaged: 1 }) },
  ];
  assertEquals(sumBookingsBreakdown(bookings), {
    quoted: 0, reserved: 0, prepped: 0, out: 5, returned: 1, lost: 0, damaged: 1,
  });
});

Deno.test("applyBookingBreakdownDelta mutates roll-up by next - prev", () => {
  const orderRollup = { quoted: 0, reserved: 0, prepped: 0, out: 5, returned: 0, lost: 0, damaged: 0 };
  const prev = sample({ out: 5 });
  const next = sample({ out: 2, returned: 2, lost: 1 });
  applyBookingBreakdownDelta(orderRollup, prev, next);
  assertEquals(orderRollup, { quoted: 0, reserved: 0, prepped: 0, out: 2, returned: 2, lost: 1, damaged: 0 });
});

Deno.test("isOrderBookingsBreakdownClosed: true when all open keys zero and total > 0", () => {
  assertEquals(
    isOrderBookingsBreakdownClosed({
      quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 3, lost: 1, damaged: 1,
    }),
    true,
  );
});

Deno.test("isOrderBookingsBreakdownClosed: false when any open key > 0", () => {
  assertEquals(
    isOrderBookingsBreakdownClosed({
      quoted: 0, reserved: 0, prepped: 0, out: 1, returned: 5, lost: 0, damaged: 0,
    }),
    false,
  );
});

Deno.test("isOrderBookingsBreakdownClosed: false on empty roll-up (no bookings)", () => {
  assertEquals(isOrderBookingsBreakdownClosed(emptyBookingsBreakdown()), false);
});
