/**
 * Job "ai.draftLines" (docs/dev/M5-DESIGN.md §3.1, §8 P8): drafting personal lines in the worker's `ai` lane. The
 * handler lives in src/server/ai/run.ts (it shares the website reader, the Claude client and the AI services with the
 * rest of the server code); this file is where the job registry (worker/jobs/index.ts, P11) takes it from, like every
 * other job: `"ai.draftLines": createAiDraftLinesJob(deps.ai)` with the worker's `ai` option (tests inject a fixture
 * reader and the fake Claude there).
 */
export { aiDraftLinesJob, createAiDraftLinesJob, type AiDeps } from "@/server/ai/run";
