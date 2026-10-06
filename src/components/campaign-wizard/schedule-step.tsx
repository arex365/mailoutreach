"use client";

import { useEffect, useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleAlert, Info, Rocket } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { plural } from "@/core/text";
import { launchAction, setScheduleAction } from "@/app/(app)/campaigns/[id]/setup/actions";
import {
  launchPhaseCounts,
  NO_CHECK_NOTE,
  secondCheckLaunchLine,
  uncheckedLaunchLine,
  type LaunchCheckNote,
} from "@/components/checks/schedule-note";
import {
  DAYS_AS_MINUTES_HINT,
  defaultZoneNote,
  ignoreWindowText,
  launchSentences,
  limitSentence,
  localDateTimeWords,
  madeBeforeGoLiveText,
  modeLine,
  needsGoLiveTick,
  parseLocalDateTime,
  recipientTimesText,
  timeUntil,
  type RecipientZoneLike,
  type StepTextProblemLike,
} from "./format";
import { PendingSave } from "./pending-save";
import { StepFooter } from "./step-footer";
import { wizardHref } from "./steps";
import { StepIntro } from "./wizard-frame";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

/** LaunchSummary as it reaches the browser (dates as ISO strings). */
export type ScheduleSummary = {
  mode: "DRY_RUN" | "TEST" | "LIVE";
  /** What stops a launch in this mode right now (the launch's own words and order). */
  modeBlockers: string[];
  modeReady: boolean;
  /** Today's limit and its use (live, and dry runs in the practice copy); null otherwise. */
  today: { cap: number; used: number; left: number } | null;
  /** "Monday to Friday, 9:00–17:00". */
  windowText: string;
  fits: { today: number; later: number } | null;
  /** Where the "Ignore sending hours" switch starts (dry runs: on for real data, off in the practice copy). */
  ignoreWindowDefault: boolean;
  practiceCopy: boolean;
  people: number;
  companies: number;
  excludedCompanies: number;
  followUps: number;
  missingEmails: number;
  missingPeople: number;
  textProblems: StepTextProblemLike[];
  editedTextProblems: number;
  recipientZones: RecipientZoneLike[];
  defaultTimeZone: string;
  senderName: string | null;
  problems: Array<{ step: "audience" | "sender" | "message" | "review"; text: string }>;
  /** Setting "sending.goLive" (M6-DESIGN §2.7: the Live line changes with it). Absent = false. */
  goLive?: boolean;
  /** The draft was made before go-live (G11): a LIVE launch needs a tick. Absent = false. */
  madeBeforeGoLive?: boolean;
};

/**
 * The Schedule step's check note (the check services' `campaignLaunchCheckAudience`): the counts, plus what leaving the
 * unchecked people out does to the companies and time zones (without them, only people and today's fit change).
 */
export type ScheduleCheckNote = LaunchCheckNote & {
  /** Companies where everyone who'd get the email still needs a check: launch leaves the whole company out. */
  companiesLeftOut?: number;
  /** The unchecked people by their company's own time zone (null: the company has none, so the default zone). */
  uncheckedZones?: ReadonlyArray<{ timeZone: string | null; people: number }>;
};

/** The recipients' time zones without the unchecked people (most people first, empty zones dropped). */
function zonesWithoutUnchecked(
  zones: readonly RecipientZoneLike[],
  unchecked: ScheduleCheckNote["uncheckedZones"],
  defaultTimeZone: string,
): RecipientZoneLike[] {
  if (!unchecked || unchecked.length === 0) return [...zones];
  const out = new Map(zones.map((z) => [z.timeZone, { ...z }]));
  for (const u of unchecked) {
    const n = Math.max(0, Math.floor(u.people));
    const zone = out.get(u.timeZone ?? defaultTimeZone);
    if (!zone || n === 0) continue;
    zone.people = Math.max(0, zone.people - n);
    // A company with no zone of its own counts as the default zone ("defaulted").
    if (u.timeZone === null) zone.defaulted = Math.max(0, zone.defaulted - n);
    zone.defaulted = Math.min(zone.defaulted, zone.people);
  }
  return [...out.values()].filter((z) => z.people > 0).sort((a, b) => b.people - a.people || a.timeZone.localeCompare(b.timeZone));
}

/**
 * The summary in the launch phase (M5-DESIGN §6.1; M5 review SCREENS-09): people whose addresses still need a check
 * are left out at launch, so the people, today's fit, the companies ("They're for N companies") and the recipients'
 * time zones count without them. People waiting for a second check stay in (their first email waits for it).
 */
export function launchPhaseSummary(draft: ScheduleSummary, note: ScheduleCheckNote): ScheduleSummary {
  const counts = launchPhaseCounts(draft, note);
  const companiesLeft = draft.companies - Math.max(0, Math.floor(note.companiesLeftOut ?? 0));
  const companies = counts.people === 0 ? 0 : Math.max(1, Math.min(counts.people, companiesLeft));
  return {
    ...draft,
    people: counts.people,
    fits: counts.fits,
    companies,
    recipientZones: zonesWithoutUnchecked(draft.recipientZones, note.uncheckedZones, draft.defaultTimeZone),
  };
}

/** The link text of a launch problem: "Open Message", "Open Review"… */
const PROBLEM_STEP_LABELS: Record<ScheduleSummary["problems"][number]["step"], string> = {
  audience: "Audience",
  sender: "Sender",
  message: "Message",
  review: "Review",
};

type ScheduleValue = { when: "now" | "later"; local: string; daysAsMinutes: boolean };

/**
 * Step 6, Schedule: start now or at a date and time (typed in the viewer's own time zone, and
 * shown in the recipients' own time too), the sending hours and today's limit, the dry-run helpers
 * (incl. "Ignore sending hours", which goes with the launch), what launching will do, what stops a
 * launch in this sending mode, and Launch campaign (with a confirmation that sums it up). The
 * engine's launchCampaign does the work; then the campaign page opens. A change still waiting to be
 * saved is saved when the step closes.
 *
 * Address checks (M5-DESIGN §6.1): people whose addresses still need a check are left out at launch, so the counts,
 * "fits today's limit", the companies, the recipients' times and the confirmation leave them out (the launch phase,
 * `launchPhaseSummary`), and the note says how many; people waiting for a second check stay in (their first email
 * waits for it).
 *
 * Go live (M6-DESIGN §2.7, G11): after go-live the Live line says everyone in the campaign gets real email, and a LIVE
 * draft made before go-live needs a tick ("This draft was made before you went live. …") before Launch works; the
 * launch then sends `confirmMadeBeforeGoLive`.
 */
export function ScheduleStep({
  campaignId,
  timeZone,
  initialLocal,
  initialStartIso,
  initialDaysAsMinutes,
  summary: draftSummary,
  nowIso,
  checkNote = NO_CHECK_NOTE,
}: {
  campaignId: number;
  /** The viewer's time zone (their profile). */
  timeZone: string;
  /** The saved start as "YYYY-MM-DDTHH:mm" in the viewer's zone, or "" for start now. */
  initialLocal: string;
  /** The saved start (UTC, ISO) or null. */
  initialStartIso: string | null;
  initialDaysAsMinutes: boolean;
  summary: ScheduleSummary;
  /** When the page was made (for "in 2 days"). */
  nowIso: string;
  /**
   * Ticked people who still need an address check (left out at launch) or wait for a second one, and the companies and
   * time zones of the unchecked ones (M5-DESIGN §6.1).
   */
  checkNote?: ScheduleCheckNote;
}) {
  // The launch phase: people whose addresses still need a check don't count (launch leaves them out).
  const summary = launchPhaseSummary(draftSummary, checkNote);
  const uncheckedLine = uncheckedLaunchLine(checkNote.unchecked);
  const secondCheckLine = secondCheckLaunchLine(checkNote.secondCheck);
  const id = useId();
  const router = useRouter();
  const [when, setWhen] = useState<"now" | "later">(initialLocal ? "later" : "now");
  const [local, setLocal] = useState(initialLocal);
  const [daysAsMinutes, setDaysAsMinutes] = useState(initialDaysAsMinutes);
  const [ignoreWindow, setIgnoreWindow] = useState(summary.ignoreWindowDefault);
  const dryRun = summary.mode === "DRY_RUN";
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [timeError, setTimeError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ local: string; startIso: string | null }>({ local: initialLocal, startIso: initialStartIso });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [launching, startLaunching] = useTransition();
  // A LIVE draft made before go-live sends real email to everyone in it now: the Owner or Member ticks that first.
  const needsTick = needsGoLiveTick(summary);
  const [madeBeforeTicked, setMadeBeforeTicked] = useState(false);
  // The change waiting for its (debounced) save: leaving the step (Back, browser Back, Ctrl+K…)
  // saves it instead of dropping it.
  const [pendingSave] = useState(() => new PendingSave<ScheduleValue>());
  useEffect(
    () => () => {
      pendingSave.flush((next) => void saveOnLeave(campaignId, next));
    },
    [campaignId, pendingSave],
  );

  async function save(next: ScheduleValue): Promise<boolean> {
    if (next.when === "later" && !parseLocalDateTime(next.local)) {
      setTimeError("Choose a date and a time to start.");
      return false;
    }
    setSaveState("saving");
    try {
      const res = await setScheduleAction({ campaignId, when: next.when, local: next.local, daysAsMinutes: next.daysAsMinutes });
      if (!res.ok) {
        setSaveState("idle");
        if (next.when === "later") setTimeError(res.fieldErrors?.local?.[0] ?? res.error);
        else toast.error(res.error);
        return false;
      }
      setTimeError(null);
      setSaved({ local: next.when === "later" ? next.local : "", startIso: res.data.startAt });
      setSaveState("saved");
      return true;
    } catch {
      setSaveState("idle");
      toast.error(OFFLINE);
      return false;
    }
  }

  function saveSoon(next: ScheduleValue, delay = 0) {
    pendingSave.schedule(next, delay, (value) => void save(value));
  }

  function launch() {
    startLaunching(async () => {
      // The start time as shown must be the one saved (it's saved here, so nothing is left waiting).
      pendingSave.cancel();
      if (!(await save({ when, local, daysAsMinutes }))) {
        setConfirmOpen(false);
        return;
      }
      try {
        const res = await launchAction({
          campaignId,
          ...(dryRun ? { ignoreWindow } : {}),
          ...(needsTick && madeBeforeTicked ? { confirmMadeBeforeGoLive: true } : {}),
        });
        if (!res.ok) {
          setConfirmOpen(false);
          toast.error(res.error);
          router.refresh();
          return;
        }
        toast.success(res.message ?? "Campaign launched.");
        router.push(res.data.href);
      } catch {
        setConfirmOpen(false);
        toast.error(OFFLINE);
      }
    });
  }

  const words = when === "later" ? localDateTimeWords(local) : null;
  // The saved start (the server turned the typed time into an exact moment).
  const savedStart = when === "later" && saved.startIso && saved.local === local && !timeError ? new Date(saved.startIso) : null;
  const until = savedStart ? timeUntil(savedStart, new Date(nowIso)) : null;
  const theirTime = savedStart ? recipientTimesText(savedStart, timeZone, summary.recipientZones) : null;
  const zoneNote = theirTime ? defaultZoneNote(summary.recipientZones, summary.defaultTimeZone) : null;
  const sentences = launchSentences(summary);
  const blocked = summary.problems.length > 0 || !summary.modeReady || summary.people === 0 || (needsTick && !madeBeforeTicked);
  const startText =
    when === "now" ? "It starts as soon as you launch it." : words ? `It starts on ${words}, your time.` : "Choose when it starts.";
  const paced = !dryRun || !ignoreWindow;
  const limit = limitSentence(summary);
  // The confirmation's one "fix it" link: the campaign's text first (it affects everyone).
  const fix = sentences.text
    ? { href: wizardHref(campaignId, "message"), label: "Fix in Message" }
    : sentences.missing
      ? { href: wizardHref(campaignId, "review", { filter: "missing" }), label: "Fix in Review" }
      : sentences.editedText
        ? { href: wizardHref(campaignId, "review", { filter: "text" }), label: "Fix in Review" }
        : uncheckedLine
          ? { href: wizardHref(campaignId, "verify"), label: "Open Verify" }
          : null;

  return (
    <div className="flex flex-1 flex-col">
      <StepIntro title="When it starts">Start now, or pick a date and time. Times are in your own time zone ({timeZone}).</StepIntro>

      <div className="grid max-w-3xl gap-6">
        <section aria-labelledby={`${id}-start`} className="grid gap-3 rounded-lg border border-border bg-card p-4">
          <h3 id={`${id}-start`} className="text-sm font-medium">
            Start
          </h3>
          <RadioGroup
            value={when}
            onValueChange={(v) => {
              const next = v === "later" ? "later" : "now";
              setWhen(next);
              setTimeError(null);
              if (next === "now") saveSoon({ when: "now", local, daysAsMinutes });
              else if (parseLocalDateTime(local)) saveSoon({ when: "later", local, daysAsMinutes });
            }}
            aria-label="When the campaign starts"
            className="gap-3"
          >
            <label htmlFor={`${id}-now`} className="flex cursor-pointer items-start gap-3">
              <RadioGroupItem id={`${id}-now`} value="now" className="mt-0.5" />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">Start now</span>
                <span className="text-sm text-muted-foreground">
                  {paced
                    ? "The first emails go out inside each recipient's sending hours, a few minutes apart."
                    : "The first emails go to the dry-run outbox within a minute of launching."}
                </span>
              </span>
            </label>
            <label htmlFor={`${id}-later`} className="flex cursor-pointer items-start gap-3">
              <RadioGroupItem id={`${id}-later`} value="later" className="mt-0.5" />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">Start at a date and time</span>
                <span className="text-sm text-muted-foreground">Nothing goes out before then. You can still pause or cancel it.</span>
              </span>
            </label>
          </RadioGroup>
          {when === "later" ? (
            <div className="grid gap-1.5 pl-7">
              <Label htmlFor={`${id}-local`}>Date and time ({timeZone})</Label>
              <Input
                id={`${id}-local`}
                type="datetime-local"
                className="w-60"
                value={local}
                aria-invalid={timeError ? true : undefined}
                aria-describedby={timeError ? `${id}-local-error` : theirTime ? `${id}-local-words ${id}-local-zones` : `${id}-local-words`}
                onChange={(e) => {
                  const next = e.target.value;
                  setLocal(next);
                  setTimeError(null);
                  if (parseLocalDateTime(next)) saveSoon({ when: "later", local: next, daysAsMinutes }, 600);
                }}
              />
              {timeError ? (
                <p id={`${id}-local-error`} role="alert" className="text-sm text-destructive">
                  {timeError}
                </p>
              ) : (
                <p id={`${id}-local-words`} className="text-sm text-muted-foreground">
                  {words ? `${words}, your time${until ? ` (${until})` : ""}.` : "Pick a day and a time."}
                </p>
              )}
              {theirTime ? (
                <p id={`${id}-local-zones`} className="text-sm text-muted-foreground">
                  {theirTime}
                  {zoneNote ? ` ${zoneNote}` : ""}
                </p>
              ) : null}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved." : null}
          </p>
        </section>

        <section aria-labelledby={`${id}-hours-title`} className="grid gap-2 rounded-lg border border-border bg-card p-4">
          <h3 id={`${id}-hours-title`} className="text-sm font-medium">
            Sending hours and limits
          </h3>
          <p className="text-sm">
            {paced
              ? `Emails go out ${summary.windowText} in each recipient's time zone, spaced out with random gaps.`
              : "This dry run ignores sending hours: its emails go to the dry-run outbox straight away."}
          </p>
          {limit ? <p className="text-sm text-muted-foreground">{limit}</p> : null}
        </section>

        {dryRun ? (
          <section aria-labelledby={`${id}-helpers`} className="grid gap-3 rounded-lg border border-border bg-card p-4">
            <div>
              <h3 id={`${id}-helpers`} className="text-sm font-medium">
                Dry-run helpers
              </h3>
              <p className="text-xs text-muted-foreground">For trying the campaign out. They only work in dry runs.</p>
            </div>
            <div className="flex items-start gap-3">
              <Switch
                id={`${id}-hours`}
                checked={ignoreWindow}
                onCheckedChange={setIgnoreWindow}
                aria-describedby={`${id}-hours-hint`}
                className="mt-0.5 data-checked:bg-foreground"
              />
              <div className="grid gap-0.5">
                <Label htmlFor={`${id}-hours`} className="font-normal">
                  Ignore sending hours
                </Label>
                <p id={`${id}-hours-hint`} className="text-xs text-muted-foreground">
                  {ignoreWindowText(ignoreWindow)}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Switch
                id={`${id}-minutes`}
                checked={daysAsMinutes}
                onCheckedChange={(on) => {
                  setDaysAsMinutes(on);
                  saveSoon({ when, local, daysAsMinutes: on });
                }}
                aria-describedby={`${id}-minutes-hint`}
                className="mt-0.5 data-checked:bg-foreground"
              />
              <div className="grid gap-0.5">
                <Label htmlFor={`${id}-minutes`} className="font-normal">
                  Treat follow-up days as minutes (for testing)
                </Label>
                <p id={`${id}-minutes-hint`} className="text-xs text-muted-foreground">
                  {DAYS_AS_MINUTES_HINT}
                </p>
              </div>
            </div>
          </section>
        ) : null}

        <section aria-labelledby={`${id}-summary`} className="grid gap-3 rounded-lg border border-border bg-card p-4">
          <h3 id={`${id}-summary`} className="text-sm font-medium">
            When you launch
          </h3>
          <ul className="grid gap-1.5 text-sm">
            <li>
              {sentences.main} {summary.people > 0 ? `They're for ${plural(summary.companies, "company", "companies")}` : ""}
              {summary.people > 0 && summary.senderName ? `, sent as ${summary.senderName}.` : summary.people > 0 ? "." : ""}
            </li>
            {uncheckedLine ? (
              <li className="flex items-start gap-2 text-warning">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {uncheckedLine}{" "}
                  <Link href={wizardHref(campaignId, "verify")} className="underline underline-offset-3">
                    Open Verify
                  </Link>
                </span>
              </li>
            ) : null}
            {secondCheckLine ? <li className="text-muted-foreground">{secondCheckLine}</li> : null}
            {sentences.followUps ? <li className="text-muted-foreground">{sentences.followUps}</li> : null}
            {sentences.missing ? (
              <li className="flex items-start gap-2 text-warning">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {sentences.missing}{" "}
                  <Link href={wizardHref(campaignId, "review", { filter: "missing" })} className="underline underline-offset-3">
                    See them in Review
                  </Link>
                </span>
              </li>
            ) : null}
            {sentences.text ? (
              <li className="flex items-start gap-2 text-warning">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {sentences.text}{" "}
                  <Link href={wizardHref(campaignId, "message")} className="underline underline-offset-3">
                    Open Message
                  </Link>
                </span>
              </li>
            ) : null}
            {sentences.editedText ? (
              <li className="flex items-start gap-2 text-warning">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {sentences.editedText}{" "}
                  <Link href={wizardHref(campaignId, "review", { filter: "text" })} className="underline underline-offset-3">
                    See {summary.editedTextProblems === 1 ? "it" : "them"} in Review
                  </Link>
                </span>
              </li>
            ) : null}
            <li className="text-muted-foreground">{modeLine({ mode: summary.mode, practiceCopy: summary.practiceCopy, goLive: summary.goLive })}</li>
            <li className="text-muted-foreground">{startText}</li>
          </ul>
          {summary.modeBlockers.length > 0 ? (
            <div role="alert" className="grid gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              <p className="flex items-start gap-2 font-medium text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {summary.mode === "LIVE" ? "Live" : summary.mode === "TEST" ? "Test mode" : "This"} campaigns can&apos;t start yet:
              </p>
              <ul className="grid list-disc gap-1 pl-5">
                {summary.modeBlockers.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {summary.problems.length > 0 ? (
            <div role="alert" className="grid gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              <p className="font-medium text-destructive">Fix these before launching:</p>
              <ul className="grid gap-1">
                {summary.problems.map((p) => (
                  <li key={`${p.step}-${p.text}`}>
                    {p.text}{" "}
                    <Link href={wizardHref(campaignId, p.step)} className="underline underline-offset-3">
                      Open {PROBLEM_STEP_LABELS[p.step]}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Everyone is checked again at launch (unsubscribes, the 30-day rule, other campaigns). Anyone who can&apos;t be emailed any more is
            left out, and the campaign page says why.
          </p>
          {needsTick ? (
            <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
              <Checkbox
                id={`${id}-made-before`}
                checked={madeBeforeTicked}
                onCheckedChange={(v) => setMadeBeforeTicked(v === true)}
                disabled={launching}
                className="mt-0.5"
                aria-required="true"
              />
              <Label htmlFor={`${id}-made-before`} className="text-sm leading-snug font-normal">
                {madeBeforeGoLiveText(summary.people)}
              </Label>
            </div>
          ) : null}
        </section>
      </div>

      <StepFooter
        campaignId={campaignId}
        current="schedule"
        primary={
          <Button onClick={() => setConfirmOpen(true)} disabled={blocked || launching}>
            <Rocket aria-hidden />
            Launch campaign
          </Button>
        }
      />

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !launching && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Launch this campaign?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2">
                <p>{sentences.main}</p>
                {uncheckedLine ? <p className="text-warning">{uncheckedLine}</p> : null}
                {secondCheckLine ? <p>{secondCheckLine}</p> : null}
                {sentences.missing ? <p className="text-warning">{sentences.missing}</p> : null}
                {sentences.text ? <p className="text-warning">{sentences.text}</p> : null}
                {sentences.editedText ? <p className="text-warning">{sentences.editedText}</p> : null}
                {sentences.followUps ? <p>{sentences.followUps}</p> : null}
                {limit ? <p>{limit}</p> : null}
                <p>{startText}</p>
                {theirTime ? <p>{theirTime}</p> : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {fix ? (
              <Button variant="outline" asChild>
                <Link href={fix.href}>{fix.label}</Link>
              </Button>
            ) : null}
            <AlertDialogCancel disabled={launching}>Not yet</AlertDialogCancel>
            <AlertDialogAction
              disabled={launching}
              onClick={(e) => {
                e.preventDefault();
                launch();
              }}
            >
              {launching ? "Launching…" : sentences.anyWarning || uncheckedLine ? "Launch anyway" : "Launch campaign"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Saves a change that was still waiting when the Schedule step closed. The step is gone, so a
 * problem is told with a toast (it shows on whatever page opens next).
 */
async function saveOnLeave(campaignId: number, next: ScheduleValue): Promise<void> {
  try {
    const res = await setScheduleAction({ campaignId, when: next.when, local: next.local, daysAsMinutes: next.daysAsMinutes });
    if (!res.ok) toast.error(`Your latest change on the Schedule step wasn't saved. ${res.error}`);
  } catch {
    toast.error("Couldn't reach the app, so your latest change on the Schedule step wasn't saved. Open the Schedule step and set it again.");
  }
}
