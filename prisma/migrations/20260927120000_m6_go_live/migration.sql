-- Milestone 6 (go live, M6-DESIGN §2.2): data only, no schema change.
-- Campaigns launched before Milestone 5 have no launch flag. Going live was impossible then, so their live sends could
-- only reach the test list: record that, so "emailed" is judged by the flag alone from now on.
UPDATE "Campaign" SET "launchedGoLive" = false WHERE "launchedGoLive" IS NULL AND "launchedAt" IS NOT NULL;
