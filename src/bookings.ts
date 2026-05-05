/**
 * Pure helpers over the booking breakdown shape and the order's denormalized
 * roll-up. Used both server-side (api-cloudrun) and client-side (manager) so
 * the warehouse picker sees instant optimistic updates and the order detail
 * page can compute "is this order done?" without a round-trip.
 *
 * ```ts
 * import {
 *   sumBookingBreakdown,
 *   isOrderBookingsBreakdownClosed,
 *   mergeBookingBreakdown,
 * } from "@cfs/utilities/bookings";
 * ```
 *
 * @module
 */
import type { Booking, Order } from "@cfs/schemas";

/** All seven keys of the booking lifecycle breakdown. Order matches the schema. */
export const BOOKING_BREAKDOWN_KEYS = [
  "quoted", "reserved", "prepped", "out", "returned", "lost", "damaged",
] as const;

/** Keys representing items that are still in flight (pre-terminal). */
export const BOOKING_BREAKDOWN_OPEN_KEYS = ["quoted", "reserved", "prepped", "out"] as const;

/** Keys representing items that have reached a terminal state. */
export const BOOKING_BREAKDOWN_TERMINAL_KEYS = ["returned", "lost", "damaged"] as const;

/**
 * The empty breakdown shape — all seven keys at zero.
 *
 * Use as the seed for new orders and as the target shape for fresh bookings.
 *
 * ```ts
 * const order = { ...orderInput, bookings_breakdown: emptyBookingsBreakdown() };
 * ```
 */
export function emptyBookingsBreakdown(): Order["bookings_breakdown"] {
  return { quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0 };
}

/**
 * Sum the seven values of a single booking's breakdown.
 *
 * The booking-level invariant is `sumBookingBreakdown(booking.breakdown) === booking.quantity`.
 * Use this to verify that a proposed breakdown change preserves the invariant
 * before submitting it through `PUT /bookings/{uid}`.
 */
export function sumBookingBreakdown(b: Booking["breakdown"]): number {
  return b.quoted + b.reserved + b.prepped + b.out + b.returned + b.lost + b.damaged;
}

/**
 * Merge a `Partial<breakdown>` over a current breakdown. Missing keys are
 * inherited from `current`. Useful for the optimistic UI path: a picker
 * types "returned: 1, out: 2" and the manager renders the merged result
 * before the API confirms.
 */
export function mergeBookingBreakdown(
  current: Booking["breakdown"],
  patch: Partial<Booking["breakdown"]> | undefined,
): Booking["breakdown"] {
  if (!patch) return { ...current };
  return {
    quoted: patch.quoted ?? current.quoted,
    reserved: patch.reserved ?? current.reserved,
    prepped: patch.prepped ?? current.prepped,
    out: patch.out ?? current.out,
    returned: patch.returned ?? current.returned,
    lost: patch.lost ?? current.lost,
    damaged: patch.damaged ?? current.damaged,
  };
}

/**
 * Sum a list of booking breakdowns into the order's roll-up shape.
 *
 * Mirrors the keys of `stock-summaries.bookings_breakdown` (which aggregates
 * along the *product* axis) but aggregated along the *order* axis. Used to
 * seed `order.bookings_breakdown` at create/update time and to recompute it
 * client-side from cached bookings when the order doc isn't authoritative
 * yet.
 */
export function sumBookingsBreakdown(
  bookings: Array<{ breakdown: Booking["breakdown"] }>,
): Order["bookings_breakdown"] {
  const total = emptyBookingsBreakdown();
  for (const b of bookings) {
    total.quoted += b.breakdown.quoted ?? 0;
    total.reserved += b.breakdown.reserved ?? 0;
    total.prepped += b.breakdown.prepped ?? 0;
    total.out += b.breakdown.out ?? 0;
    total.returned += b.breakdown.returned ?? 0;
    total.lost += b.breakdown.lost ?? 0;
    total.damaged += b.breakdown.damaged ?? 0;
  }
  return total;
}

/**
 * Apply a per-key delta to an order's bookings_breakdown roll-up in place.
 *
 * Given a booking's previous and next breakdown, mutate the order roll-up by
 * `+= next[k] - prev[k]` for each key. Useful both server-side (where
 * `updateBooking` applies a single-doc delta to avoid reading every sibling
 * booking) and client-side (where the manager can apply the same delta
 * locally for instant feedback).
 */
export function applyBookingBreakdownDelta(
  orderBreakdown: Order["bookings_breakdown"],
  prev: Booking["breakdown"],
  next: Booking["breakdown"],
): void {
  orderBreakdown.quoted += next.quoted - prev.quoted;
  orderBreakdown.reserved += next.reserved - prev.reserved;
  orderBreakdown.prepped += next.prepped - prev.prepped;
  orderBreakdown.out += next.out - prev.out;
  orderBreakdown.returned += next.returned - prev.returned;
  orderBreakdown.lost += next.lost - prev.lost;
  orderBreakdown.damaged += next.damaged - prev.damaged;
}

/**
 * Project a booking's breakdown for a given order status, item type, and
 * total quantity. Pure sync — no I/O.
 *
 * The new bucket (`quoted` for status `quoted`, `reserved` for `reserved`/
 * `active`, `returned`/`out` for `complete`) is computed as
 * `quantity - (carried-over progress)` so the resulting breakdown always
 * sums to `quantity`. The carry-over set is `prepped + out + returned + lost
 * + damaged` — the previous `quoted` and `reserved` values are intentionally
 * dropped, which is what fixes the "two open buckets after a status flip"
 * data corruption that surfaced in opportunity webhook ingestion.
 *
 * Status rules:
 *   draft / canceled  → all zeros (cleared on cancel/draft)
 *   quoted            → quoted = quantity − carry; preserves prepped/out/terminals
 *   reserved / active → reserved = quantity − carry; preserves prepped/out/terminals
 *   complete + rental → returned = quantity − (lost + damaged); zero everything else
 *   complete + sale   → out = quantity; zero everything else
 *   anything else     → all zeros
 */
export function calculateBookingBreakdown(
  status: string,
  type: string,
  quantity: number,
  existingBreakdown?: Booking["breakdown"],
): Booking["breakdown"] {
  const base = emptyBookingsBreakdown();
  const prev = existingBreakdown ?? base;

  if (status === "canceled" || status === "draft") {
    return base;
  }

  const carry = prev.prepped + prev.out + prev.returned + prev.lost + prev.damaged;

  if (status === "quoted") {
    return {
      ...base,
      prepped: prev.prepped,
      out: prev.out,
      returned: prev.returned,
      lost: prev.lost,
      damaged: prev.damaged,
      quoted: quantity - carry,
    };
  }

  if (status === "reserved" || status === "active") {
    return {
      ...base,
      prepped: prev.prepped,
      out: prev.out,
      returned: prev.returned,
      lost: prev.lost,
      damaged: prev.damaged,
      reserved: quantity - carry,
    };
  }

  if (status === "complete") {
    if (type === "rental") {
      return {
        ...base,
        returned: quantity - (prev.lost + prev.damaged),
        lost: prev.lost,
        damaged: prev.damaged,
      };
    }
    if (type === "sale") {
      return { ...base, out: quantity };
    }
  }

  return base;
}

/**
 * Predicate: is the order fully closed?
 *
 * An order is closed when no quantity is in a non-terminal state
 * (`quoted + reserved + prepped + out === 0`) AND at least one booking has
 * been recorded (`total > 0`). The total guard prevents auto-completing an
 * empty order whose bookings_breakdown is all zeros simply because it has no
 * bookings yet.
 *
 * Drives the auto-cascade rule in `update-booking`: when this predicate
 * flips to true after applying a delta, the order's status is set to
 * "complete" in the same Firestore transaction.
 */
export function isOrderBookingsBreakdownClosed(
  orderBreakdown: Order["bookings_breakdown"],
): boolean {
  const open = orderBreakdown.quoted + orderBreakdown.reserved
    + orderBreakdown.prepped + orderBreakdown.out;
  const total = open + orderBreakdown.returned + orderBreakdown.lost + orderBreakdown.damaged;
  return total > 0 && open === 0;
}
