/**
 * Replies (M4-DESIGN §3): the pure core the reply processor, the Notifications page, Simulate and the tests share —
 * classification, quoting, link ids, stored kind and scope, notification and activity copy, and link hints. No I/O.
 * The word lists live in `./phrases` (imported directly where needed).
 */
export * from "./types";
export * from "./classify";
export * from "./quote";
export * from "./link-ids";
export * from "./kind";
export * from "./copy";
export * from "./hints";
