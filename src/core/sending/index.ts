/**
 * Sending rules (PLAN B6.5, B6.6, M3-DESIGN §4.1, §4.5.7): pure functions shared by the web app, the worker and the
 * tests. Cap days, limits, sending hours, pacing, warm-up, health, the top-bar label and the mode gates. The server
 * side that loads the facts lives in @/server/services/sending.
 */
export * from "./capday";
export * from "./caps";
export * from "./window";
export * from "./pacing";
export * from "./warmup";
export * from "./health";
export * from "./label";
export * from "./mode-gates";
