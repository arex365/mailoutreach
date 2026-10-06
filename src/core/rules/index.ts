/**
 * Campaign rules (PLAN.md B6.1, B6.2, B6.4, B6.5): pure functions shared by the web app, the worker
 * and the tests. The server side that loads the facts lives in @/server/services/eligibility and
 * @/server/services/reservations.
 */
export * from "./mode";
export * from "./wording";
export * from "./team-rule";
export * from "./eligibility";
export * from "./default-people";
