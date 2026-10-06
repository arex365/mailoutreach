import type { Metadata } from "next";
import { requireOwner } from "@/lib/auth/dal";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsTitle } from "@/components/settings/settings-title";
import { CountedTable } from "@/components/settings/deliverability/counted-table";
import { HealthCard } from "@/components/settings/deliverability/health-card";
import { SuppressionList, type SuppressionFilterValue } from "@/components/settings/deliverability/suppression-list";
import { ThresholdsForm } from "@/components/settings/deliverability/thresholds-form";
import { CheckKeyCard } from "@/components/settings/checks/check-key-card";
import { CheckSettingsForm } from "@/components/settings/checks/check-settings-form";
import {
  checkKeyStatusLine,
  checkSettingsValuesFrom,
  checksThisMonthLine,
  STORED_CHECK_SETTING_KEYS,
  type CheckKeyView,
  type CheckSettingsView,
  type TestChecksView,
} from "@/components/settings/checks/check-settings";
import { ChecksPausedCard } from "@/components/settings/checks/checks-paused-card";
import { TestChecksCard } from "@/components/settings/checks/test-checks-card";
import type { CheckPauseState } from "@/core/system-state";
import type { SessionUser } from "@/lib/auth/session";
import { db } from "@/server/db";
import { secretInfo } from "@/server/secrets";
import { getSettings } from "@/server/settings";
import {
  listSuppressionPage,
  loadCountedRows,
  loadHealthView,
  SUPPRESSION_FILTERS,
} from "@/server/services/mail-events/deliverability";
import { getChecksPause } from "@/server/services/verification/pause";
import { checksThisMonth } from "@/server/services/verification/spend";

export const metadata: Metadata = { title: "Deliverability" };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function asFilter(v: string | undefined): SuppressionFilterValue {
  return v && (SUPPRESSION_FILTERS as readonly string[]).includes(v) ? (v as SuppressionFilterValue) : "all";
}

/** Everything the three "Address checks" cards show (M5-DESIGN §6.6). */
async function loadChecksViews(
  user: SessionUser,
  now: Date,
): Promise<{ pause: CheckPauseState; settings: CheckSettingsView; key: CheckKeyView; test: TestChecksView }> {
  const [pause, stored, flags, month, key, me] = await Promise.all([
    getChecksPause(now),
    getSettings(STORED_CHECK_SETTING_KEYS),
    getSettings(["practice.copy"] as const),
    checksThisMonth(now),
    secretInfo("verification.apiKey"),
    db.user.findUnique({ where: { id: user.id }, select: { email: true, replyInbox: true } }),
  ]);
  const values = checkSettingsValuesFrom(stored);
  const practiceCopy = flags["practice.copy"] === true;
  const savedBy = key.set && key.updatedById ? await db.user.findUnique({ where: { id: key.updatedById }, select: { name: true } }) : null;
  return {
    pause,
    settings: { values, thisMonth: checksThisMonthLine(month.count, month.costUsd, values.monthlyLimitUsd) },
    key: {
      statusLine: checkKeyStatusLine(
        key.set ? { set: true, last4: key.last4, updatedAt: key.updatedAt, byName: savedBy?.name ?? null } : { set: false },
        user.timeZone,
        now,
      ),
      hasOwnKey: key.set,
      practiceCopy,
    },
    test: { defaultEmail: me?.replyInbox?.trim() || me?.email || user.email, practiceCopy, pricePerCheck: values.pricePerCheck },
  };
}

/**
 * Settings › Deliverability (Owner, M3-DESIGN §5.5): how many recent emails bounced or were marked as spam and when
 * sending pauses by itself, exactly which emails count right now (SPEC §8 "show why"), the thresholds, the address
 * checks (M5-DESIGN §6.6: which results are emailed, price and limit, the separate key, a test, the paused banner),
 * and the do-not-email list with search, filters, "Add an address" and (for test mailboxes and reply inboxes only)
 * "Remove".
 */
export default async function DeliverabilityPage({ searchParams }: PageProps<"/settings/deliverability">) {
  const user = await requireOwner();
  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim().slice(0, 200);
  const filter = asFilter(first(sp.filter));
  const pageRaw = Number(first(sp.page));
  const now = new Date();

  const health = await loadHealthView(user.timeZone, now);
  const [bounceRows, complaintRows, list, checks] = await Promise.all([
    loadCountedRows(health.counts.bounceEmailIds, "bounce"),
    loadCountedRows(health.counts.complaintEmailIds, "complaint"),
    listSuppressionPage({ q, filter, page: Number.isFinite(pageRaw) ? pageRaw : 1 }),
    loadChecksViews(user, now),
  ]);

  return (
    <div>
      <SettingsTitle
        title="Deliverability"
        description="How many emails bounce or are marked as spam, when sending pauses by itself, how addresses are checked, and who is never emailed."
      />
      <div className="grid gap-8">
        <HealthCard
          bounce={{
            label: "Bounces toward the automatic pause",
            line: health.bounceLine,
            count: health.counts.bounces,
            limit: health.bounceLimit,
            note: health.bounceNote,
            href: "#bounces",
          }}
          complaint={{
            label: "Spam complaints toward the automatic pause",
            line: health.complaintLine,
            count: health.counts.complaints,
            limit: health.complaintLimit,
            note: health.complaintNote,
            href: "#complaints",
          }}
          sinceNote={health.sinceNote}
        />

        <CountedTable
          id="bounces"
          title="Bounces counted now"
          description="Each bounced email that counts toward the automatic pause, with the list it came from."
          rows={bounceRows}
          emptyText="No bounces count toward the limit right now."
          timeZone={user.timeZone}
        />
        <CountedTable
          id="complaints"
          title="Complaints counted now"
          description="Each spam complaint that counts toward the automatic pause, with the list it came from."
          rows={complaintRows}
          emptyText="No spam complaints count toward the limit right now."
          timeZone={user.timeZone}
        />

        <Card>
          <CardHeader>
            <CardTitle>Thresholds</CardTitle>
            <CardDescription>
              When sending pauses by itself, and how healthy sending must be for the warm-up to raise the daily limit.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* While checks are paused, "Resume checks" is the page's one orange button (M5-DESIGN §6.6). */}
            <ThresholdsForm initial={health.thresholds} primary={!checks.pause.paused} />
          </CardContent>
        </Card>

        <section id="checks" aria-label="Address checks" className="grid scroll-mt-20 gap-8">
          {checks.pause.paused ? (
            <ChecksPausedCard
              text={checks.pause.text || "Address checks are paused. Open Settings › Deliverability to see why."}
              detail={checks.pause.detail}
            />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Address checks</CardTitle>
              <CardDescription>
                Every address is checked with Mailgun before a live campaign emails it. These settings decide which results are emailed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CheckSettingsForm view={checks.settings} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Address check key</CardTitle>
              <CardDescription>Address checks use your Mailgun key unless you save a separate one here.</CardDescription>
            </CardHeader>
            <CardContent>
              <CheckKeyCard view={checks.key} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Test address checks</CardTitle>
              <CardDescription>Check one address to see that checks work on your Mailgun plan.</CardDescription>
            </CardHeader>
            <CardContent>
              <TestChecksCard view={checks.test} />
            </CardContent>
          </Card>
        </section>

        <SuppressionList
          rows={list.rows}
          total={list.total}
          page={list.page}
          pageCount={list.pageCount}
          q={q}
          filter={filter}
          timeZone={user.timeZone}
        />
      </div>
    </div>
  );
}
