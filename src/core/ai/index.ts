/**
 * Milestone 5 (docs/dev/M5-DESIGN.md §3): the Claude side of AI personal lines, browser-safe and pure: the step-C
 * contracts (types, normaliser), the prompt, the request, reading answers, the automatic checks and costs.
 * Website reading (picker, site rules) and the estimate live in their own modules of this folder.
 */
export * from "./types";
export * from "./normalize";
export * from "./prompt";
export * from "./request";
export * from "./parse";
export * from "./checks";
export * from "./cost";
