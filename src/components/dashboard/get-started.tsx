import Link from "next/link";
import { ArrowRight, CircleCheck, Mail, Rocket, ShieldCheck, Upload, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DASHBOARD_TEXTS } from "./texts";
import type { GetStartedStep, GetStartedStepKey, GetStartedView } from "./types";

/**
 * "Get started" on the dashboard (M6-DESIGN §4.4; moved from Contacts, where it was home until the dashboard came).
 * Shown to the Owner until going live (again after a domain change ended go-live, G8), to Members only while there
 * are no companies, and in the practice copy to everyone while there are no companies. Never a "Hide this" link.
 * The first step not done yet is the card's one orange link (the dashboard's only one).
 */

/** What the "Connect Mailgun" step needs to know (loaded on the server). */
export type MailgunStepState = { practiceCopy: boolean; connected: boolean; domain: string | null };

/** The "Connect Mailgun" step's words, link and state (pure; M3-DESIGN §5.9). */
export function mailgunStep(
  state: MailgunStepState,
  isOwner: boolean,
): { title: string; text: string; href: string | null; done: boolean; muted: boolean } {
  if (state.practiceCopy) {
    return {
      title: "Connect Mailgun",
      text: "Not needed here: the practice copy never sends real email, so campaigns run as dry runs.",
      href: null,
      done: false,
      muted: true,
    };
  }
  if (state.connected) {
    return {
      title: "Mailgun connected",
      text: state.domain ? `Emails can go out from ${state.domain}.` : "Emails can go out through Mailgun.",
      href: isOwner ? "/settings/sending" : null,
      done: true,
      muted: false,
    };
  }
  if (isOwner) {
    return {
      title: "Connect Mailgun",
      text: "Add your sending domain and API key so campaigns can send real email. Until then, campaigns run as dry runs.",
      href: "/settings/sending",
      done: false,
      muted: false,
    };
  }
  return {
    title: "Connect Mailgun",
    text: "The Owner connects Mailgun in Settings › Sending & Mailgun. Until then, campaigns run as dry runs.",
    href: null,
    done: false,
    muted: true,
  };
}

/** What decides whether "Get started" shows and which steps are done (all read-only, loaded by the dashboard). */
export type GetStartedInput = {
  role: "OWNER" | "MEMBER";
  practiceCopy: boolean;
  /** Setting "sending.goLive" on real data. */
  live: boolean;
  /** Companies that aren't deleted. */
  companies: number;
  /** Another active user, or an invite link that is still usable (Owner only). */
  teamInvited: boolean;
  mailgun: MailgunStepState;
  /** Setting "backups.secondFolder" is set. */
  secondFolderSet: boolean;
};

/** The card's description and steps, or null when it isn't shown (§4.4). Pure. */
export function getStartedView(input: GetStartedInput): GetStartedView | null {
  const t = DASHBOARD_TEXTS.getStarted;
  const owner = input.role === "OWNER";
  const noCompanies = input.companies <= 0;
  const show = input.practiceCopy ? noCompanies : owner ? !input.live : noCompanies;
  if (!show) return null;

  const imported = !noCompanies;
  const importStep = step("import", imported ? t.importDone : t.importTitle, t.importText, imported, "/import");
  const teamStep = step("team", input.teamInvited ? t.teamDone : t.teamTitle, t.teamText, input.teamInvited, "/settings/team");
  const m = mailgunStep(input.mailgun, owner);
  const mailgun: Omit<GetStartedStep, "primary"> = { key: "mailgun", title: m.title, text: m.text, done: m.done, href: m.href, muted: m.muted };

  let steps: Array<Omit<GetStartedStep, "primary">>;
  let description: string;
  if (input.practiceCopy) {
    steps = owner ? [importStep, teamStep, mailgun] : [importStep, mailgun];
    description = t.descriptionPractice;
  } else if (owner) {
    const protect = step("protect", input.secondFolderSet ? t.protectDone : t.protectTitle, t.protectText, input.secondFolderSet, "/settings/backups");
    const goLive = step("go-live", t.goLiveTitle, t.goLiveText, false, "/settings/sending#go-live");
    steps = [importStep, teamStep, mailgun, protect, goLive];
    description = t.descriptionOwner;
  } else {
    steps = [importStep, mailgun];
    description = t.descriptionMember;
  }
  const next = steps.findIndex((s) => !s.done);
  return {
    description,
    steps: steps.map((s, i) => ({ ...s, primary: i === next && s.href !== null && !s.muted })),
  };
}

function step(key: GetStartedStepKey, title: string, text: string, done: boolean, href: string): Omit<GetStartedStep, "primary"> {
  return { key, title, text, done, href, muted: false };
}

const STEP_ICONS: Record<GetStartedStepKey, typeof Upload> = {
  import: Upload,
  team: Users,
  mailgun: Mail,
  protect: ShieldCheck,
  "go-live": Rocket,
};

/** Columns on a laptop: one per step (2, 3 or 5). Static class names, so Tailwind keeps them. */
const COLUMNS: Record<number, string> = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 5: "lg:grid-cols-5" };

/** The "Get started" card (server component; the view comes from `getStartedView`). */
export function GetStarted({ view }: { view: GetStartedView }) {
  return (
    <section aria-labelledby="get-started-heading">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id="get-started-heading" className="text-base font-semibold">
              {DASHBOARD_TEXTS.getStarted.heading}
            </h2>
          </CardTitle>
          <CardDescription>{view.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className={cn("grid gap-2 sm:grid-cols-2", COLUMNS[view.steps.length])}>
            {view.steps.map((s) => (
              <Step key={s.key} step={s} />
            ))}
          </ol>
        </CardContent>
      </Card>
    </section>
  );
}

function Step({ step }: { step: GetStartedStep }) {
  const Icon = STEP_ICONS[step.key];
  const icon = step.done ? (
    <CircleCheck className="size-4 shrink-0 text-status-client" aria-hidden />
  ) : (
    <Icon className="size-4 shrink-0" aria-hidden />
  );
  const heading = (
    <span className="flex items-center gap-2 text-sm font-medium">
      {icon}
      <span className="min-w-0">{step.title}</span>
      {step.done ? <span className="sr-only">(done)</span> : null}
    </span>
  );
  const text = <span className="text-xs text-muted-foreground">{step.text}</span>;

  if (step.primary && step.href) {
    // The card's one primary link: a real Button, so it carries data-slot="button" data-variant="default".
    return (
      <li className="flex h-full flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
        {heading}
        {text}
        <Button asChild className="mt-auto h-11 w-full sm:h-8">
          <Link href={step.href}>
            {step.title}
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </li>
    );
  }
  if (step.href) {
    return (
      <li>
        <Link
          href={step.href}
          className="flex h-full min-h-11 flex-col gap-1 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-accent"
        >
          <span className="flex items-center gap-2">
            {heading}
            <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
          </span>
          {text}
        </Link>
      </li>
    );
  }
  // Nothing to click: a dashed box (full contrast; the text says why there's nothing to do here).
  return (
    <li>
      <div className="flex h-full flex-col gap-1 rounded-lg border border-dashed border-border px-3 py-2.5">
        {heading}
        {text}
      </div>
    </li>
  );
}
