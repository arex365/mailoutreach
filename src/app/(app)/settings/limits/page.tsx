import type { Metadata } from "next";
import Link from "next/link";
import { Gauge } from "lucide-react";
import { requireOwner } from "@/lib/auth/dal";
import { EmptyState } from "@/components/page-header";
import { SettingsTitle } from "@/components/settings/settings-title";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { waitingText } from "@/components/campaigns/format";
import { ClearTodayCapButton, TodayCapForm } from "@/components/settings/limits/today-cap-form";
import { LimitsForm } from "@/components/settings/limits/limits-form";
import { RulesForm } from "@/components/settings/limits/rules-form";
import { rulesCardDescription, RULES_CARD } from "@/components/settings/limits/rules-text";
import { SenderCapsForm } from "@/components/settings/limits/sender-caps-form";
import {
  capDaySentence,
  overrideLine,
  todayCapLine,
  usedLine,
  warmupExplanation,
  warmupHistoryLine,
  warmupRows,
  warmupScheduleLines,
} from "@/components/settings/limits/limits-format";
import { timeZoneOptions } from "@/core/geo/display";
import { PLAN_TEST_RESERVE, PLAN_TEXTS } from "@/core/mailgun/plan";
import { warmupTable } from "@/core/sending/caps";
import { ownMailboxHeaders } from "@/core/sending/own-mailbox";
import { pausedWithReason } from "@/core/sending/label";
import { isWeekdaysOnly, warmupUsePercent } from "@/core/sending/warmup-line";
import { nextWindowOpen, parseWindow, resolveZone, windowSentence } from "@/core/sending/window";
import { parsePacerState, parseWarmupState } from "@/core/system-state-parse";
import { STATE_KEYS } from "@/core/system-state";
import { formatTime } from "@/core/time/format";
import { db } from "@/server/db";
import { getSettings } from "@/server/settings";
import { readTyped } from "@/server/state-typed";
import { loadEffectiveMaxDailyCap } from "@/server/services/mailgun/plan";
import { loadTeamFrom } from "@/server/services/mailgun/team-from";
import { noSenderAddressesText } from "@/server/services/sender-addresses";
import { suggestedSenderName } from "@/server/services/users";
import { pickCandidates } from "@/server/services/sending/gates";
import { getPauseState } from "@/server/services/sending/pause";
import { getTodayCap } from "@/server/services/sending/usage";
import { loadRulesView } from "@/server/services/settings/rules";

export const metadata: Metadata = { title: "Limits & warm-up" };

const HISTORY_SHOWN = 14;

function cityOf(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

/**
 * "Waiting for sending hours: the next window opens at 9:00 in Berlin (12:00 your time)." The zone is
 * the one of the due emails whose window opens first.
 */
async function outsideHoursText(until: Date, viewerZone: string, now: Date): Promise<string> {
  const s = await getSettings(["sending.window", "defaultTimeZone"] as const);
  const window = parseWindow(s["sending.window"]);
  const defaultZone = resolveZone(s["defaultTimeZone"], "Europe/Berlin");
  const { due } = await pickCandidates(now, { window, defaultZone });
  const zone = [...new Set(due.map((d) => d.zone))].find((z) => nextWindowOpen(now, z, window).getTime() === until.getTime());
  const theirs = zone ? formatTime(until, zone).replace(/^0(\d)/, "$1") : null;
  const yours = formatTime(until, viewerZone);
  return theirs && zone
    ? `Waiting for sending hours: the next window opens at ${theirs} in ${cityOf(zone)} (${yours} your time).`
    : `Waiting for sending hours: the next window opens at ${yours} your time.`;
}

/**
 * Settings › Limits & warm-up (Owner; PLAN B6.6, M3-DESIGN §5.4, M6-DESIGN §2.6, §5.3): today's limit and its use,
 * what the sending loop is waiting for, "Change today's limit", the warm-up schedule (when it starts: at go-live) and
 * its history, sending hours and the advanced settings, "The 30-day rule" card, and each teammate's own daily limit.
 * One primary action: Save limits (the rules card saves with an outline button). In shared-From mode the per-sender
 * list names each teammate's "Reply address" (SHARED-FROM-DESIGN §3.6).
 *
 * The Mailgun plan (MAIN-DOMAIN-DESIGN O23, §2.8, §3.7): the warm-up table is drawn from the effective maximum
 * (`loadEffectiveMaxDailyCap()`: never above the plan's daily limit minus the test reserve); with a daily-limit plan the
 * Today card says so (`PLAN_TEXTS.capLine`), and while the plan lowers the saved maximum the limits card says it keeps it
 * at the effective number (`PLAN_TEXTS.maxFieldHint`; the form itself still shows and saves the saved number).
 * Own-mailbox mode (`loadTeamFrom().replies`): the per-sender list shows every active user with the From line their
 * emails show ("Emails show"), never the "Nobody has a … address yet" state.
 */
export default async function LimitsPage() {
  const user = await requireOwner();
  const now = new Date();
  const tz = user.timeZone;
  const [s, today, warmup, pacer, pause, users, overrideBy, rules, team, effective] = await Promise.all([
    getSettings([
      "sending.window",
      "defaultTimeZone",
      "sending.maxDailyCap",
      "sending.minGapSeconds",
      "sending.capDayTimeZone",
      "sending.capOverride",
      "warmup.startCap",
      "warmup.steps",
      "warmup.minUsePercent",
      "practice.copy",
      "sending.goLive",
      "sending.goLiveAt",
    ] as const),
    getTodayCap(now),
    readTyped(STATE_KEYS.warmup, parseWarmupState),
    readTyped(STATE_KEYS.pacer, parsePacerState),
    getPauseState(),
    db.user.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        senderDisplayName: true,
        dailyCap: true,
        senderAddresses: { where: { retiredAt: null, domain: { active: true } }, orderBy: { id: "desc" }, take: 1, select: { address: true } },
      },
    }),
    (async () => {
      const o = (await getSettings(["sending.capOverride"] as const))["sending.capOverride"];
      return o ? db.user.findUnique({ where: { id: o.byUserId }, select: { name: true } }) : null;
    })(),
    loadRulesView(),
    loadTeamFrom(),
    loadEffectiveMaxDailyCap(),
  ]);
  // Shared-From mode: the per-sender list says "reply address" (its empty state keeps its one next step, R8).
  const teamFrom = team.address !== null;
  // Own-mailbox mode: nobody has an address of their own; every row shows the From line its emails show (the display
  // name alone while no From fits: nothing goes out until the Owner sets one).
  const ownMailbox = team.replies === "own-mailbox";
  const ownFrom = team.ownFrom;
  const window = parseWindow(s["sending.window"]);
  const table = warmupTable(Number(s["warmup.startCap"]), effective.maxCap, Number(s["warmup.steps"]));
  const savedMaxCap = Number(s["sending.maxDailyCap"]);
  const dailyLimit = effective.limits?.dailyLimit ?? null;
  const planLine = dailyLimit !== null ? PLAN_TEXTS.capLine(Math.max(0, dailyLimit - PLAN_TEST_RESERVE), dailyLimit) : null;
  const maxFieldHint = dailyLimit !== null && savedMaxCap > effective.maxCap ? PLAN_TEXTS.maxFieldHint(effective.maxCap) : null;
  const rows = warmupRows(table, today.warmupStep);
  const history = [...warmup.value.history].reverse().slice(0, HISTORY_SHOWN);
  const practiceCopy = s["practice.copy"] === true;
  const scheduleLines = warmupScheduleLines({
    practiceCopy,
    goLive: s["sending.goLive"] === true,
    goLiveAt: s["sending.goLiveAt"],
    step: today.warmupStep,
    table,
    timeZone: tz,
    now,
    rule: { minUsePercent: warmupUsePercent(s["warmup.minUsePercent"]), weekdaysOnly: isWeekdaysOnly(window.days) },
  });
  // The practice copy has no sending addresses (it never connects Mailgun), and its dry runs still count per sender;
  // in own-mailbox mode every active user sends without one.
  const noSenders = !practiceCopy && !ownMailbox && users.every((u) => u.senderAddresses.length === 0);

  let waitingLine: string | null = null;
  if (pause.paused) waitingLine = `${pausedWithReason("Paused", pause.reason)}.`;
  else if (pacer.value.waiting) {
    const w = pacer.value.waiting;
    const until = w.until ? new Date(Date.parse(w.until)) : null;
    waitingLine =
      w.reason === "outside-hours" && until
        ? await outsideHoursText(until, tz, now)
        : w.reason === "nothing-due"
          ? "Nothing is waiting to send."
          : waitingText({ reason: w.reason, until: w.until }, { timeZone: tz, now, ownMailbox });
  }
  const override = today.override;
  const zones = timeZoneOptions();

  return (
    <div>
      <SettingsTitle
        title="Limits & warm-up"
        description="How many emails go out each day, when, and how the daily limit grows while your sending domain warms up."
      />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Today</CardTitle>
            <CardDescription>{capDaySentence(today.capZone)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1">
              <p className="text-base font-medium">{todayCapLine(today)}</p>
              <p className="tabular text-sm text-muted-foreground">{usedLine(today)}</p>
              {waitingLine ? <p className="text-sm">{waitingLine}</p> : null}
              {planLine ? <p className="text-sm text-muted-foreground">{planLine}</p> : null}
            </div>
            {override ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                <span>
                  {overrideLine({
                    byName: overrideBy?.name ?? "the Owner",
                    atText: formatTime(override.at, tz),
                    cap: today.cap,
                    aboveSchedule: today.aboveSchedule,
                  })}
                </span>
                <ClearTodayCapButton />
              </div>
            ) : null}
            <TodayCapForm current={today.cap} warmupCap={today.warmupCap} maxCap={today.maxCap} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Warm-up schedule</CardTitle>
            <CardDescription>{warmupExplanation(table, Number(s["warmup.minUsePercent"]))}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1 text-sm">
              {scheduleLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            {/* Focusable, so keyboard users can scroll a long schedule (axe: scrollable-region-focusable). */}
            <div
              role="region"
              aria-label="Warm-up schedule"
              tabIndex={0}
              className="max-h-80 overflow-y-auto rounded-lg border border-border"
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Step</TableHead>
                    <TableHead className="text-right">Daily limit</TableHead>
                    <TableHead>
                      <span className="sr-only">Where you are</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.day} aria-current={r.state === "today" ? "true" : undefined}>
                      <TableCell>Step {r.day}</TableCell>
                      <TableCell className="tabular text-right">{r.cap.toLocaleString("en-US")}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.state === "done" ? "Done" : r.state === "today" ? <span className="font-medium text-foreground">Today</span> : r.state === "next" ? "Next" : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <section aria-labelledby="warmup-history" className="grid gap-2">
              <h3 id="warmup-history" className="text-sm font-medium">
                Recent days
              </h3>
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">No days evaluated yet. The limit is checked after each day on which emails went out.</p>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {history.map((d) => (
                    <li key={d.day}>{warmupHistoryLine(d, table)}</li>
                  ))}
                </ul>
              )}
            </section>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sending hours and limits</CardTitle>
            <CardDescription>
              Emails go out {windowSentence(window)} in each recipient&apos;s time zone, spaced out with random gaps.
            </CardDescription>
          </CardHeader>
          <CardContent className={maxFieldHint ? "grid gap-4" : undefined}>
            {maxFieldHint ? <p className="text-sm text-muted-foreground">{maxFieldHint}</p> : null}
            <LimitsForm
              zones={zones}
              initial={{
                window,
                defaultTimeZone: resolveZone(s["defaultTimeZone"], "Europe/Berlin"),
                maxDailyCap: Number(s["sending.maxDailyCap"]),
                minGapSeconds: Number(s["sending.minGapSeconds"]),
                capDayTimeZone: today.capZone,
                warmupStartCap: Number(s["warmup.startCap"]),
                warmupSteps: Number(s["warmup.steps"]),
                warmupMinUsePercent: Number(s["warmup.minUsePercent"]),
              }}
            />
          </CardContent>
        </Card>

        <Card id="rules" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>{RULES_CARD.title}</CardTitle>
            <CardDescription>{rulesCardDescription(rules.teamRuleDays)}</CardDescription>
          </CardHeader>
          <CardContent>
            <RulesForm view={rules} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Per-sender limits</CardTitle>
            <CardDescription>
              A teammate&apos;s own daily limit, on top of the domain&apos;s. Leave it empty for no limit of their own.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {noSenders || users.length === 0 ? (
              <EmptyState
                icon={<Gauge className="size-6" aria-hidden />}
                title={noSenderAddressesText(teamFrom)}
                actions={
                  <Button asChild variant="outline">
                    <Link href="/settings/profile">Open My profile</Link>
                  </Button>
                }
              />
            ) : (
              <SenderCapsForm
                teamFrom={teamFrom}
                {...(ownMailbox ? { ownMailbox: true } : {})}
                senders={users.map((u) => {
                  if (!ownMailbox) return { userId: u.id, name: u.name, address: u.senderAddresses[0]?.address ?? null, dailyCap: u.dailyCap };
                  const displayName = u.senderDisplayName?.trim() || suggestedSenderName(u.name);
                  return {
                    userId: u.id,
                    name: u.name,
                    address: ownFrom ? ownMailboxHeaders({ displayName, from: ownFrom }).from : displayName,
                    dailyCap: u.dailyCap,
                  };
                })}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
