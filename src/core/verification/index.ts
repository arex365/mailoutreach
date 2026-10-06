/**
 * Address checks, the pure side (M5-DESIGN §2): the contract types, who needs a check, the policy buckets, the cost
 * estimate and every sentence. Browser-safe, no I/O. The provider mappings (mailgun-map, other-maps, fake-rules) are
 * imported from their own files.
 */
export * from "./types";
export * from "./need";
export * from "./policy";
export * from "./estimate";
export * from "./words";
