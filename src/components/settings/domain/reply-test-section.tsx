"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleCheck, CircleDashed, CircleX, Send, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { CopyField } from "@/components/copy-text";
import { FormError } from "@/components/forms/field";
import {
  authResultsText,
  dmarcResultsText,
  REPLY_TEST_TEAM_TEXTS,
  REPLY_TEST_TEXTS,
  replyTestAnswerChange,
  replyTestAnswersFrom,
  replyTestAnswersKey,
  replyTestRoundOf,
  teamFromDomainOf,
  testOriginalTexts,
  type ReplyTestAnswerField,
  type ReplyTestAnswersInput,
  type ReplyTestAnswerState,
} from "@/core/reply-test";
import { MODE_GATE_TEXTS } from "@/core/sending/mode-gates";
import { mailtoOnOwnDomain, OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS } from "@/core/sending/own-mailbox";
import { cn } from "@/lib/utils";
import {
  decideReplyTestAction,
  saveReplyTestAnswersAction,
  saveReplyTestOriginalAction,
  sendReplyTestAction,
  setLeaveOutMailtoAction,
  switchUnsubscribeSetupAction,
} from "@/app/(app)/settings/domain/actions";
import { SETTINGS_DIALOG_CLASS } from "../dialog-classes";
import { useJobPoll } from "./use-job-poll";
import type { ReplyTestMailboxView, ReplyTestView } from "../types";

const OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

type YesNoUnsure = "pass" | "fail" | "unsure";
/** One mailbox's answers; `placementOk` and `dmarcOk` only in shared-From mode (SHARED-FROM-DESIGN §3.4). */
type Answer = ReplyTestAnswerState;
const NO_ANSWER: Answer = { inboxOk: null, authOk: null };

function Fact({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-sm text-success">
      <CircleCheck className="size-4" aria-hidden /> {yes}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
      <CircleDashed className="size-4" aria-hidden /> {no}
    </span>
  );
}

function YesNo({
  id,
  label,
  value,
  onChange,
  withUnsure,
  disabled,
}: {
  id: string;
  label: string;
  value: string | null;
  onChange: (v: string) => void;
  withUnsure?: boolean;
  disabled?: boolean;
}) {
  const options = withUnsure
    ? [
        { v: "pass", l: "Yes" },
        { v: "fail", l: "No" },
        { v: "unsure", l: "Not sure" },
      ]
    : [
        { v: "yes", l: "Yes" },
        { v: "no", l: "No" },
      ];
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1 text-sm">{label}</legend>
      <RadioGroup value={value ?? ""} onValueChange={onChange} className="flex flex-wrap gap-4" disabled={disabled}>
        {options.map((o) => (
          <div key={o.v} className="flex items-center gap-1.5">
            <RadioGroupItem id={`${id}-${o.v}`} value={o.v} />
            <Label htmlFor={`${id}-${o.v}`} className="font-normal">
              {o.l}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

/** A paste box that reads pasted headers or an original (never saved) with its button and the result line. */
function PasteBox({
  id,
  label,
  value,
  onChange,
  onRead,
  result,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onRead: () => void;
  result: string | undefined;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        rows={5}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
        placeholder="Delivered-To: …"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onRead} disabled={disabled}>
          Read the headers
        </Button>
        {result ? (
          <p className="text-sm" role="status">
            {result}
          </p>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">The pasted text is only read, never saved.</p>
    </div>
  );
}

/**
 * Settings › Domain checklist › Reply test (PLAN A4.5, M3-DESIGN §1.5, §5.3): what's missing before it can start, the
 * steps, one block per test mailbox with what the app saw and the two questions only the Owner can answer (with the
 * "paste the headers" helper), the List-Unsubscribe question, the unsubscribe fact, the verdict and "Save the result".
 * Answers are saved as they're given; pasted headers are read and never stored.
 *
 * Shared From address (`view.teamFrom`, SHARED-FROM-DESIGN §3.4): the intro names the From address and the reply
 * address; each mailbox is asked four questions in this order — placement, the reply in the inbox, dkim/arc (with the
 * Zoho Mail help), DMARC (with its own paste box) —; below the mailboxes, "The test email's original" (one pasted
 * original, read and never kept, with one line per check); the List-Unsubscribe question gets the mailto note; the
 * verdict shows the spam warnings; and a failure names the shared-From way back instead of a separate reply address.
 * Without `teamFrom` the section is exactly as before.
 *
 * The answers on the page always follow the saved ones (SECURITY-1, REPLIES-03): a click saves only the answer that
 * changed (with the value it replaced and the round the page shows), "Save the result" decides on the saved answers,
 * and whenever the saved answers change (a save, a DMARC result read from a pasted original, another window) the page
 * takes them over. A refused save puts the saved answers back and reloads the section.
 *
 * Own-mailbox mode (`view.ownFrom` present, MAIN-DOMAIN-DESIGN §3.5): the test by hand. The intro names the own From,
 * with the note that Mailgun's reports arrive within the hour; each mailbox asks placement, "did your reply arrive in
 * {from}" and DMARC (never dkim/arc, never "Reply reached the app"); the pasted original's own lines; the List-Unsubscribe
 * question's own mailto note; and, while the original shows a `mailto:`, the unsubscribe-by-email question with a copy
 * button for the address. No Setup switch: **Back to normal** shows only while a restored setup isn't A.
 *
 * Own-mailbox review fixes: the List-Unsubscribe question asks for what the Free plan produces (a link, http on Free;
 * SCREENS-04); under the unsubscribe-by-email question, an address on the From's own domain can only be proved by a
 * mailbox you read, never by Settings › Deliverability (REPLIES-01); and once emails to it don't arrive (or its address
 * can't be read), **Leave out unsubscribe by email** is offered as the last resort, with **Offer unsubscribe by email
 * again** while it is on (REPLIES-03). The verdict's `warnings` carry `leftOutNote` while it is on (never a spam line).
 */
export function ReplyTestSection({ view }: { view: ReplyTestView }) {
  const router = useRouter();
  const team = view.teamFrom ?? null;
  const own = view.ownFrom !== undefined;
  const ownFrom = own ? (view.ownFrom ?? null) : null;
  const org = teamFromDomainOf(team);
  // The round and the saved answers belong to the From the test runs with: the shared From, or the own From.
  const roundView = own ? { ...view, teamFrom: ownFrom } : view;
  const round = replyTestRoundOf(roundView);
  const roundKey = JSON.stringify(round);
  const saved = replyTestAnswersFrom(view.mailboxes, team !== null || own);
  const savedKey = replyTestAnswersKey(roundView);
  const [answers, setAnswers] = useState<Record<string, Answer>>(saved);
  const [headersOk, setHeadersOk] = useState<boolean | null>(view.headersOk);
  const [mailtoArrived, setMailtoArrived] = useState<boolean | null>(view.mailtoArrived ?? null);
  const [syncedKey, setSyncedKey] = useState(savedKey);
  const [syncedRound, setSyncedRound] = useState(roundKey);
  const [pasted, setPasted] = useState<Record<string, string>>({});
  const [pasteResult, setPasteResult] = useState<Record<string, string>>({});
  const [dmarcPasted, setDmarcPasted] = useState<Record<string, string>>({});
  const [dmarcResult, setDmarcResult] = useState<Record<string, string>>({});
  const [originalText, setOriginalText] = useState("");
  const [originalLines, setOriginalLines] = useState<Array<{ ok: boolean; text: string }> | null>(null);
  const [originalError, setOriginalError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(view.runningJobId);
  const [switchTo, setSwitchTo] = useState<"A" | "B" | null>(null);
  /** Own-mailbox mode (REPLIES-03): the confirm dialog for leaving out (true) or offering again (false) unsubscribe by email. */
  const [leaveOutAsk, setLeaveOutAsk] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();

  // The saved answers changed on the server: take them over (React's "adjust state when a prop changes").
  if (syncedKey !== savedKey) {
    setSyncedKey(savedKey);
    setAnswers(saved);
    setHeadersOk(view.headersOk);
    setMailtoArrived(view.mailtoArrived ?? null);
  }
  // The test started again (another From address, sending domain or setup): what was pasted for the old one is gone.
  if (syncedRound !== roundKey) {
    setSyncedRound(roundKey);
    setPasted({});
    setPasteResult({});
    setDmarcPasted({});
    setDmarcResult({});
    setOriginalText("");
    setOriginalLines(null);
    setOriginalError(null);
  }

  useJobPoll(jobId, {
    onDone: (job) => {
      setJobId(null);
      router.refresh();
      if (job?.status === "DONE") toast.success(job.summary ?? "The test emails are on their way.");
      else if (job?.status === "FAILED") toast.error(job.error ?? "The test emails weren't sent.");
    },
  });

  /** A save that didn't go through: say why, show the saved answers again and reload them. */
  function refused(message: string) {
    setError(message);
    setAnswers(saved);
    setHeadersOk(view.headersOk);
    setMailtoArrived(view.mailtoArrived ?? null);
    router.refresh();
  }

  /** Saves one change (only what changed, never the other answers the page holds). */
  function persist(input: ReplyTestAnswersInput) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await saveReplyTestAnswersAction(input);
        if (!res.ok) {
          refused(res.error);
          return;
        }
        // Every save shows a toast (M6-DESIGN §5.1 R4), also an answer saved as it's given.
        toast.success(res.message ?? "Answers saved.");
        router.refresh();
      } catch {
        setError(OFFLINE);
        setAnswers(saved);
        setHeadersOk(view.headersOk);
        setMailtoArrived(view.mailtoArrived ?? null);
      }
    });
  }

  function setAnswer<F extends ReplyTestAnswerField>(address: string, field: F, value: Answer[F]) {
    const shown = answers[address];
    setAnswers({ ...answers, [address]: { ...(shown ?? NO_ANSWER), [field]: value } });
    persist(replyTestAnswerChange(address, field, value, shown, round));
  }

  function readHeaders(address: string) {
    const text = (pasted[address] ?? "").trim();
    if (!text) {
      setPasteResult((r) => ({ ...r, [address]: "Paste the email's original headers first." }));
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await saveReplyTestAnswersAction({ mailboxes: [{ address, pastedHeaders: text }], round });
        if (!res.ok) {
          refused(res.error);
          return;
        }
        const r = res.data.authFromHeaders[address] ?? null;
        toast.success(res.message ?? "Answers saved.");
        setPasteResult((p) => ({ ...p, [address]: authResultsText(r) }));
        if (r) {
          setAnswers((a) => ({ ...a, [address]: { ...(a[address] ?? { inboxOk: null, authOk: null }), authOk: r } }));
          setPasted((p) => ({ ...p, [address]: "" }));
        }
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  /** Shared-From mode: reads DMARC from a pasted original for one mailbox (never saved). */
  function readDmarc(address: string) {
    const text = (dmarcPasted[address] ?? "").trim();
    if (!text) {
      setDmarcResult((r) => ({ ...r, [address]: "Paste the email's original headers first." }));
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await saveReplyTestAnswersAction({ mailboxes: [{ address, dmarcPasted: text }], round });
        if (!res.ok) {
          refused(res.error);
          return;
        }
        const r = res.data.dmarcFromHeaders?.[address] ?? null;
        toast.success(res.message ?? "Answers saved.");
        setDmarcResult((p) => ({ ...p, [address]: dmarcResultsText(r) }));
        if (r) {
          setAnswers((a) => ({ ...a, [address]: { ...(a[address] ?? { inboxOk: null, authOk: null }), dmarcOk: r } }));
          setDmarcPasted((p) => ({ ...p, [address]: "" }));
        }
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  /**
   * Shared-From mode: "Read the original" (F25). The text is read on the server and never kept. The server also sets
   * that mailbox's DMARC answer from it; the page shows that answer at once (SECURITY-1), and the refresh brings the rest.
   */
  function readOriginal() {
    const text = originalText.trim();
    setOriginalError(null);
    if (!text) {
      setOriginalError("Paste the test email's original first.");
      return;
    }
    startTransition(async () => {
      try {
        const res = await saveReplyTestOriginalAction({ pasted: text });
        if (!res.ok) {
          setOriginalError(res.error);
          return;
        }
        toast.success(res.message ?? "The original is read.");
        setOriginalLines(res.data.lines);
        setOriginalText("");
        const { address, dmarc } = res.data;
        if (dmarc) setAnswers((a) => ({ ...a, [address]: { ...(a[address] ?? NO_ANSWER), dmarcOk: dmarc } }));
        router.refresh();
      } catch {
        setOriginalError(OFFLINE);
      }
    });
  }

  function send() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await sendReplyTestAction();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        toast.success(res.message ?? "Sending the test emails.");
        setJobId(res.data.jobId);
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  /** "Save the result" decides on the saved answers (each answer was saved when it was clicked), never the page's. */
  function decide() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await decideReplyTestAction({ round });
        if (!res.ok) {
          refused(res.error);
          return;
        }
        toast.success(res.message ?? "Saved.");
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  /** Own-mailbox mode (REPLIES-03): leaves out unsubscribe by email, or offers it again; the reply test's proof starts again. */
  function doLeaveOut(leaveOut: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await setLeaveOutMailtoAction({ leaveOut, round });
        if (!res.ok) {
          refused(res.error);
          return;
        }
        toast.success(res.message ?? (leaveOut ? OWN_REPLY_TEST_TEXTS.leaveOutDone : OWN_REPLY_TEST_TEXTS.offerAgainDone));
        setHeadersOk(null);
        setMailtoArrived(null);
        setOriginalLines(null);
        router.refresh();
      } catch {
        setError(OFFLINE);
      }
    });
  }

  function doSwitch(setup: "A" | "B") {
    startTransition(async () => {
      try {
        const res = await switchUnsubscribeSetupAction({ setup });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Switched.");
        setAnswers({});
        setHeadersOk(null);
        setMailtoArrived(null);
        router.refresh();
      } catch {
        toast.error(OFFLINE);
      }
    });
  }

  const blocked = view.blockers.length > 0;
  const verdict = view.verdict;
  const domainExample = view.domain ?? "your-domain";
  // With an empty test list, the box below already says to add mailboxes: the lists don't repeat it.
  const emptyList = view.testList.length === 0;
  const notTheEmptyListSentence = (t: string) => !emptyList || (t !== MODE_GATE_TEXTS.testMailboxes && t !== REPLY_TEST_TEXTS.noMailboxes);
  const blockersShown = view.blockers.filter(notTheEmptyListSentence);
  const missingShown = verdict.missing.filter(notTheEmptyListSentence);
  const allWarnings = team || own ? (view.warnings ?? []) : [];
  // Own-mailbox mode (REPLIES-03): the saved choice (`mailtoLeftOut`); an older view without it falls back to the verdict's
  // note. The note isn't a spam placement, so it never shows in the spam list.
  const leftOut = own && (view.mailtoLeftOut ?? allWarnings.includes(OWN_REPLY_TEST_TEXTS.leftOutNote));
  const warnings = allWarnings.filter((w) => w !== OWN_REPLY_TEST_TEXTS.leftOutNote);
  // Own-mailbox mode: the own From the texts name (the blockers already say to type one while none fits).
  const ownFromText = ownFrom ?? "your From address";
  // While it's left out, a mailto: in an original only fails the test (the verdict says why): no question to answer.
  const mailtoAddress = own && !leftOut ? (view.mailtoAddress ?? null) : null;
  // REPLIES-01: an address on the From's own domain is proved only by a mailbox you read (the default in this mode).
  const mailtoOnDomain = mailtoAddress !== null && (ownFrom === null || mailtoOnOwnDomain(mailtoAddress, ownFrom));
  // REPLIES-03: the last resort, once emails to the address don't arrive or its address can't be read (SECURITY-03).
  const offerLeaveOut =
    own &&
    !leftOut &&
    ((mailtoAddress !== null && mailtoArrived === false) || verdict.missing.includes(OWN_REPLY_TEST_TEXTS.mailtoUnreadable));
  const shownOriginalLines = own
    ? (originalLines ??
      (view.original && ownFrom
        ? testOriginalTexts(view.original, { from: ownFrom, d: domainExample, org: domainExample, ownMailbox: true })
        : null))
    : team && org
      ? (originalLines ?? (view.original ? testOriginalTexts(view.original, { from: team, d: domainExample, org }) : null))
      : null;

  return (
    <Card aria-labelledby="reply-test" role="region">
      <CardHeader>
        <CardTitle>
          <h3 id="reply-test">Reply test</h3>
        </CardTitle>
        <CardDescription>
          Before live campaigns can start, check that replies still arrive cleanly and unsubscribe links work (about 15 minutes).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1">
          <p className="text-sm [overflow-wrap:anywhere]">
            {view.decided ? (
              <span className={view.decided.status === "passed" ? "text-success" : "text-destructive"}>{view.decided.text}</span>
            ) : own ? (
              ownFrom ? (
                REPLY_TEST_TEAM_TEXTS.notTestedYet(ownFrom)
              ) : (
                OWN_REPLY_TEST_TEXTS.noFromRow
              )
            ) : team ? (
              REPLY_TEST_TEAM_TEXTS.notTestedYet(team)
            ) : (
              "Not tested yet. Live campaigns start once this passes."
            )}
          </p>
          {/* Own-mailbox mode has one setup only: no "Setup A/B" words (MAIN-DOMAIN-DESIGN §3.5, B12). */}
          {own ? null : (
            <p className="text-sm text-muted-foreground">
              {view.setup === "B"
                ? "Setup B (check only): Mailgun's unsubscribe handling is off. It's expected to fail and is never used for campaigns."
                : "Setup A: Mailgun's unsubscribe handling is on, with its own footers blank. Your footer carries the unsubscribe link."}
            </p>
          )}
        </div>

        {emptyList ? (
          <div className="grid justify-items-start gap-3 rounded-lg border border-dashed border-border px-4 py-5">
            <p className="text-sm">{REPLY_TEST_TEXTS.noMailboxes}</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/sending">Open Sending & Mailgun</Link>
            </Button>
          </div>
        ) : null}

        {blockersShown.length > 0 ? (
          <div className="grid gap-1 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm" role="status">
            <p className="flex items-center gap-1.5 font-medium">
              <TriangleAlert className="size-4 text-warning" aria-hidden /> Before you start
            </p>
            <ul className="grid gap-0.5 pl-6">
              {blockersShown.map((b) => (
                <li key={b} className="list-disc">
                  {b}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <ol className="grid list-decimal gap-1 pl-5 text-sm [overflow-wrap:anywhere]">
          {own ? (
            <li>
              {OWN_REPLY_TEST_TEXTS.intro(ownFromText)}
              <span className="mt-0.5 block text-muted-foreground">{OWN_REPLY_TEST_TEXTS.logsNote}</span>
            </li>
          ) : team ? (
            <li>{REPLY_TEST_TEAM_TEXTS.intro(team, view.ownerAddress ?? "your reply address")}</li>
          ) : (
            <li>Send the test emails: one to each mailbox on your test list, from {view.ownerAddress ?? "your sending address"}.</li>
          )}
          <li>Reply from each mailbox with a short message such as “Got it”. If it landed in spam, move it to your inbox first.</li>
          {team || own ? (
            <li>For each mailbox, answer the questions below. The app can&apos;t see your inbox.</li>
          ) : (
            <li>For each mailbox, answer the two questions below. The app can&apos;t see your inbox.</li>
          )}
          <li>Check the unsubscribe link and headers once, in one test email.</li>
          {team || own ? <li>{REPLY_TEST_TEXTS.originalMissing}</li> : null}
          <li>Save the result.</li>
        </ol>

        <div>
          <Button variant="outline" onClick={send} disabled={pending || blocked || jobId !== null || view.testList.length === 0}>
            <Send aria-hidden />
            {jobId !== null ? "Sending the test emails…" : "Send test emails to my test list"}
          </Button>
        </div>

        <FormError message={error} />

        {view.mailboxes.length > 0 ? (
          <ul className="grid grid-cols-1 gap-3" aria-label="Test mailboxes">
            {view.mailboxes.map((m: ReplyTestMailboxView) => {
              const a = answers[m.address] ?? NO_ANSWER;
              const id = `rt-${m.address.replace(/[^a-z0-9]/gi, "-")}`;
              const placement =
                team || own ? (
                  <YesNo
                    id={`${id}-placement`}
                    label={REPLY_TEST_TEAM_TEXTS.placementQuestion}
                    value={a.placementOk === null || a.placementOk === undefined ? null : a.placementOk ? "yes" : "no"}
                    onChange={(v) => setAnswer(m.address, "placementOk", v === "yes")}
                    disabled={pending}
                  />
                ) : null;
              return (
                <li key={m.address} className="grid min-w-0 gap-3 rounded-md border border-border p-3" data-mailbox={m.address}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="min-w-0 break-all font-mono text-sm">{m.address}</p>
                    <p className="text-xs text-muted-foreground">Provider: {m.providerLabel}</p>
                  </div>
                  <dl className="grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-0.5">
                      <dt className="text-xs text-muted-foreground">Test email</dt>
                      <dd>
                        <Fact ok={m.delivered} yes="Delivered" no={m.testEmail} />
                      </dd>
                    </div>
                    {/* Own-mailbox mode: replies never reach the app, so there is no such fact (§3.5). */}
                    {own ? null : (
                      <div className="grid gap-0.5">
                        <dt className="text-xs text-muted-foreground">Reply reached the app</dt>
                        <dd>
                          <Fact ok={m.replyStored} yes="Yes" no="Not yet" />
                        </dd>
                      </div>
                    )}
                  </dl>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {placement}
                    <YesNo
                      id={`${id}-inbox`}
                      label={own ? OWN_REPLY_TEST_TEXTS.replyQuestion(ownFromText) : "Did the reply arrive in your reply inbox, not in spam?"}
                      value={a.inboxOk === null ? null : a.inboxOk ? "yes" : "no"}
                      onChange={(v) => setAnswer(m.address, "inboxOk", v === "yes")}
                      disabled={pending}
                    />
                    {own ? null : (
                      <YesNo
                        id={`${id}-auth`}
                        label="Open the reply in your inbox and show its original (Gmail: ⋮ › Show original. Outlook.com: ⋯ › View › View message source). Does it say dkim=pass or arc=pass?"
                        value={a.authOk}
                        withUnsure
                        onChange={(v) => setAnswer(m.address, "authOk", v as YesNoUnsure)}
                        disabled={pending}
                      />
                    )}
                    {team || own ? (
                      <YesNo
                        id={`${id}-dmarc`}
                        label={REPLY_TEST_TEAM_TEXTS.dmarcQuestion}
                        value={a.dmarcOk ?? null}
                        withUnsure
                        onChange={(v) => setAnswer(m.address, "dmarcOk", v as YesNoUnsure)}
                        disabled={pending}
                      />
                    ) : null}
                  </div>
                  {team ? <p className="text-xs text-muted-foreground">{REPLY_TEST_TEAM_TEXTS.zohoHelp}</p> : null}
                  {!own && m.authFromHeaders && a.authOk === m.authOk && a.authOk !== null ? (
                    <p className="text-xs text-muted-foreground">Read from the pasted headers.</p>
                  ) : null}
                  {(team || own) && m.dmarcFromHeaders && a.dmarcOk === m.dmarcOk && a.dmarcOk !== null ? (
                    <p className="text-xs text-muted-foreground">DMARC was read from the pasted original.</p>
                  ) : null}
                  {!own && a.authOk === "unsure" ? (
                    <PasteBox
                      id={`${id}-paste`}
                      label="Paste the email's original headers here, and the app reads them for you."
                      value={pasted[m.address] ?? ""}
                      onChange={(v) => setPasted((p) => ({ ...p, [m.address]: v }))}
                      onRead={() => readHeaders(m.address)}
                      result={pasteResult[m.address]}
                      disabled={pending}
                    />
                  ) : null}
                  {(team || own) && a.dmarcOk === "unsure" ? (
                    <PasteBox
                      id={`${id}-dmarc-paste`}
                      label={REPLY_TEST_TEAM_TEXTS.dmarcPasteLabel}
                      value={dmarcPasted[m.address] ?? ""}
                      onChange={(v) => setDmarcPasted((p) => ({ ...p, [m.address]: v }))}
                      onRead={() => readDmarc(m.address)}
                      result={dmarcResult[m.address]}
                      disabled={pending}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {(team || own) && view.mailboxes.length > 0 ? (
          <section aria-labelledby="rt-original-heading" className="grid min-w-0 gap-2 rounded-md border border-border p-3" data-part="original">
            <h4 id="rt-original-heading" className="text-sm font-medium">
              {REPLY_TEST_TEAM_TEXTS.originalHeading}
            </h4>
            <p className="text-sm text-muted-foreground">{REPLY_TEST_TEAM_TEXTS.originalText}</p>
            <Label htmlFor="rt-original" className="sr-only">
              {REPLY_TEST_TEAM_TEXTS.originalHeading}
            </Label>
            <Textarea
              id="rt-original"
              rows={6}
              value={originalText}
              onChange={(e) => setOriginalText(e.target.value)}
              className="font-mono text-xs"
              placeholder="Delivered-To: …"
              aria-invalid={originalError ? true : undefined}
              aria-describedby={originalError ? "rt-original-error" : undefined}
            />
            <div>
              <Button type="button" variant="outline" size="sm" onClick={readOriginal} disabled={pending}>
                {REPLY_TEST_TEAM_TEXTS.readOriginalButton}
              </Button>
            </div>
            {originalError ? (
              <p id="rt-original-error" role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                {originalError}
              </p>
            ) : null}
            {shownOriginalLines ? (
              // The live region wraps the list: role="status" on the <ul> itself would take away its list role.
              <div role="status" aria-label="What the original shows">
                <ul className="grid gap-0.5 text-sm [overflow-wrap:anywhere]">
                  {shownOriginalLines.map((l) => (
                    <li key={l.text} className={cn("flex items-start gap-1.5", l.ok ? "text-success" : "text-destructive")}>
                      {l.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />}
                      <span className="min-w-0">{l.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}

        {view.mailboxes.length > 0 ? (
          <div className="grid gap-3 rounded-md border border-border p-3">
            <YesNo
              id="rt-headers"
              label={
                own
                  ? OWN_REPLY_TEST_TEXTS.headersQuestion
                  : "In one test mailbox, open the test email's original. Do you see List-Unsubscribe: <https://…> and List-Unsubscribe-Post?"
              }
              value={headersOk === null ? null : headersOk ? "yes" : "no"}
              onChange={(v) => {
                const next = v === "yes";
                setHeadersOk(next);
                persist({ mailboxes: [], headersOk: next, round });
              }}
              disabled={pending}
            />
            {own ? (
              // SCREENS-04: what the Free plan produces; the mailto note only while unsubscribe by email is offered.
              <div className="grid gap-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                <p>{OWN_REPLY_TEST_TEXTS.headersNote}</p>
                {leftOut ? null : <p>{OWN_REPLY_TEST_TEXTS.mailtoNote}</p>}
              </div>
            ) : team && org ? (
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{REPLY_TEST_TEAM_TEXTS.mailtoNote(domainExample, org)}</p>
            ) : null}
            <div className="grid gap-1 text-sm">
              <p>Then click the unsubscribe link at the bottom of that test email.</p>
              {view.unsubscribeSeen ? (
                <>
                  <Fact ok yes="Unsubscribe reached the app" no="" />
                  <p className="text-muted-foreground">
                    Put that test mailbox back:{" "}
                    <Link href="/settings/deliverability" className="underline underline-offset-3">
                      Settings › Deliverability
                    </Link>
                    , then Remove from the do-not-email list.
                  </p>
                </>
              ) : (
                <Fact ok={false} yes="" no="Waiting for the unsubscribe to reach the app" />
              )}
            </div>
          </div>
        ) : null}

        {/* Own-mailbox mode (O13): the unsubscribe-by-email question, only while the stored original shows a mailto:. */}
        {mailtoAddress && view.mailboxes.length > 0 ? (
          <div className="grid min-w-0 gap-3 rounded-md border border-border p-3 [overflow-wrap:anywhere]" data-part="mailto">
            <YesNo
              id="rt-mailto"
              label={OWN_REPLY_TEST_TEXTS.mailtoQuestion(mailtoAddress, ownFromText)}
              value={mailtoArrived === null ? null : mailtoArrived ? "yes" : "no"}
              onChange={(v) => {
                const next = v === "yes";
                setMailtoArrived(next);
                persist({ mailboxes: [], mailtoArrived: next, round });
              }}
              disabled={pending}
            />
            <CopyField value={mailtoAddress} label="unsubscribe-by-email address" />
            <p className="text-xs text-muted-foreground">
              {mailtoOnDomain ? OWN_REPLY_TEST_TEXTS.mailtoAfter : OWN_REPLY_TEST_TEXTS.mailtoAfterElsewhere}
            </p>
          </div>
        ) : null}

        {leftOut ? (
          <div className="grid min-w-0 justify-items-start gap-2 rounded-md border border-border p-3 text-sm [overflow-wrap:anywhere]" data-part="left-out">
            <p>{OWN_REPLY_TEST_TEXTS.leftOutNote}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => setLeaveOutAsk(false)} disabled={pending}>
              {OWN_REPLY_TEST_TEXTS.offerAgainButton}
            </Button>
          </div>
        ) : null}

        <div
          role="status"
          className={cn(
            "grid gap-1 rounded-md border px-3 py-2 text-sm [overflow-wrap:anywhere]",
            verdict.status === "passed" && "border-success/40 bg-success/5",
            verdict.status === "failed" && "border-destructive/40 bg-destructive/10",
            verdict.status === "incomplete" && "border-border",
          )}
        >
          <p className="flex items-center gap-1.5 font-medium">
            {verdict.status === "passed" ? (
              <CircleCheck className="size-4 text-success" aria-hidden />
            ) : verdict.status === "failed" ? (
              <CircleX className="size-4 text-destructive" aria-hidden />
            ) : (
              <CircleDashed className="size-4 text-muted-foreground" aria-hidden />
            )}
            {verdict.status === "passed" ? "Passed" : verdict.status === "failed" ? "Failed" : "Not finished"}
          </p>
          {missingShown.length > 0 ? (
            <ul className="grid gap-0.5 pl-6">
              {missingShown.map((t) => (
                <li key={t} className="list-disc">
                  {t}
                </li>
              ))}
            </ul>
          ) : null}
          {warnings.length > 0 ? (
            <ul className="grid gap-0.5 pl-6 text-warning" aria-label="Spam placements">
              {warnings.map((t) => (
                <li key={t} className="list-disc">
                  {t}
                </li>
              ))}
            </ul>
          ) : null}
          {verdict.status === "failed" || view.decided?.status === "failed" ? (
            <div className="mt-1 grid gap-1">
              {own ? (
                <p>{OWN_REPLY_TEST_TEXTS.sectionFailed(ownFromText)}</p>
              ) : team ? (
                <p>{REPLY_TEST_TEXTS.failedTeam(team, domainExample)}</p>
              ) : (
                <p>
                  Setup {view.setup} didn&apos;t pass. The usual fix is a separate reply address such as ali@reply.{domainExample}. This needs a
                  small change to the app and your OK.
                </p>
              )}
              {!own && view.setup === "A" ? (
                <p className="text-muted-foreground">
                  You can also try Setup B as a check: Mailgun&apos;s unsubscribe handling off. It&apos;s expected to fail (the unsubscribe
                  link stays plain text) and is never used for campaigns.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Own-mailbox mode (REPLIES-03): the last resort, below the failure line that points to it. */}
        {offerLeaveOut && view.mailboxes.length > 0 ? (
          <div className="grid min-w-0 justify-items-start gap-2 rounded-md border border-border p-3 text-sm [overflow-wrap:anywhere]" data-part="leave-out">
            <p>{OWN_REPLY_TEST_TEXTS.leaveOutOffer}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => setLeaveOutAsk(true)} disabled={pending}>
              {OWN_REPLY_TEST_TEXTS.leaveOutButton}
            </Button>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={decide} disabled={pending || view.mailboxes.length === 0}>
            Save the result
          </Button>
          {own ? (
            // Own-mailbox mode (§3.5): no Setup switch; a restored check-only setup can go back to normal.
            view.setup !== "A" ? (
              <Button variant="ghost" onClick={() => doSwitch("A")} disabled={pending}>
                {OWN_MAILBOX_TEXTS.backToNormal}
              </Button>
            ) : null
          ) : view.setup === "B" ? (
            <Button variant="ghost" onClick={() => setSwitchTo("A")} disabled={pending}>
              Back to Setup A
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setSwitchTo("B")} disabled={pending}>
              Try Setup B (check only)
            </Button>
          )}
        </div>

        <AlertDialog open={switchTo !== null} onOpenChange={(o) => !o && setSwitchTo(null)}>
          <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
            <AlertDialogHeader>
              <AlertDialogTitle>{switchTo === "B" ? "Try Setup B (check only)?" : "Back to Setup A?"}</AlertDialogTitle>
              <AlertDialogDescription>
                {switchTo === "B"
                  ? "This switches Mailgun's unsubscribe handling off and starts the reply test again. Setup B is only a check: live campaigns never use it."
                  : "This switches Mailgun's unsubscribe handling back on and starts the reply test again."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (switchTo) doSwitch(switchTo);
                  setSwitchTo(null);
                }}
              >
                {switchTo === "B" ? "Try Setup B" : "Back to Setup A"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={leaveOutAsk !== null} onOpenChange={(o) => !o && setLeaveOutAsk(null)}>
          <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
            <AlertDialogHeader>
              <AlertDialogTitle>{leaveOutAsk === false ? OWN_REPLY_TEST_TEXTS.offerAgainTitle : OWN_REPLY_TEST_TEXTS.leaveOutTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {leaveOutAsk === false ? OWN_REPLY_TEST_TEXTS.offerAgainBody : OWN_REPLY_TEST_TEXTS.leaveOutBody}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (leaveOutAsk !== null) doLeaveOut(leaveOutAsk);
                  setLeaveOutAsk(null);
                }}
              >
                {leaveOutAsk === false ? OWN_REPLY_TEST_TEXTS.offerAgainConfirm : OWN_REPLY_TEST_TEXTS.leaveOutConfirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
