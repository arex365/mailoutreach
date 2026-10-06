"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ellipsis, KeyRound, Link2, Power, PowerOff, Crown, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Field, FormError } from "@/components/forms/field";
import { FlagBadge } from "@/components/badges";
import {
  inviteTeammateAction,
  makeOwnerAction,
  newInviteLinkAction,
  resetPasswordLinkAction,
  switchOffAction,
  switchOnAction,
} from "@/app/(app)/settings/team/actions";
import { switchOffDialogText } from "@/app/(app)/settings/team/switch-off-text";
import { AccessLinkDisplay } from "./access-link-display";
import { SETTINGS_DIALOG_CLASS } from "./dialog-classes";
import { TEAM_PAGE_TEXT } from "./team-text";
import type { AccessLinkResult, TeamRow } from "./types";

type FieldErrors = Record<string, string[] | undefined>;

/** A call that never reached the app (no connection, the office PC restarting): the same words as the other settings. */
export const TEAM_OFFLINE = "Couldn't reach the app, so nothing changed. Check your connection and try again.";

const STATUS_LABELS: Record<TeamRow["status"], string> = {
  ACTIVE: "Active",
  INVITED: "Invited (no password yet)",
  OFF: "Switched off",
};

function StatusPill({ status }: { status: TeamRow["status"] }) {
  return <FlagBadge tone={status === "ACTIVE" ? "good" : "neutral"}>{STATUS_LABELS[status]}</FlagBadge>;
}

type ConfirmKind = "switchOff" | "makeOwner";
type CampaignChoice = "pause" | "finish";

/**
 * The switch-off question (M4-DESIGN §9.8): what switching off does, then, when the teammate sends campaigns, whether
 * to pause them (default) or let them finish, and where their waiting replies go.
 */
function SwitchOffDetails({
  row,
  choice,
  onChoice,
  disabled,
}: {
  row: TeamRow;
  choice: CampaignChoice;
  onChoice: (c: CampaignChoice) => void;
  disabled: boolean;
}) {
  const text = switchOffDialogText(row);
  if (!text.campaigns && !text.replies) return null;
  const idBase = `switch-off-${row.id}`;
  return (
    <div className="grid gap-3 text-sm">
      {text.campaigns ? (
        <div className="grid gap-2">
          <p id={`${idBase}-question`}>{text.campaigns}</p>
          <RadioGroup
            value={choice}
            onValueChange={(v) => onChoice(v === "finish" ? "finish" : "pause")}
            aria-labelledby={`${idBase}-question`}
            disabled={disabled}
          >
            <div className="flex items-start gap-3">
              <RadioGroupItem value="pause" id={`${idBase}-pause`} className="mt-0.5" />
              <Label htmlFor={`${idBase}-pause`} className="font-normal leading-snug">
                {text.pauseLabel}
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <RadioGroupItem value="finish" id={`${idBase}-finish`} className="mt-0.5" />
              <Label htmlFor={`${idBase}-finish`} className="font-normal leading-snug">
                {text.finishLabel}
              </Label>
            </div>
          </RadioGroup>
        </div>
      ) : null}
      {text.replies ? <p className="text-muted-foreground">{text.replies}</p> : null}
    </div>
  );
}

// ───────────────────────────── invite dialog ─────────────────────────────

export function InviteForm({ onInvited }: { onInvited: (result: AccessLinkResult) => void }) {
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const input = { name: String(fd.get("name") ?? ""), email: String(fd.get("email") ?? "") };
    startTransition(async () => {
      try {
        const res = await inviteTeammateAction(input);
        if (res.ok) {
          onInvited(res.data);
        } else {
          setFieldErrors(res.fieldErrors ?? {});
          setFormError(res.fieldErrors && Object.keys(res.fieldErrors).length > 0 ? null : res.error);
        }
      } catch {
        // Uncontrolled fields: nothing is cleared, so the typed name and email stay.
        setFormError(TEAM_OFFLINE);
      }
    });
  }

  return (
    <>
      <form id="invite-form" onSubmit={onSubmit} className="grid gap-4" noValidate>
        <FormError message={formError} />
        <Field label="Name" htmlFor="invite-name" error={fieldErrors.name}>
          <Input
            id="invite-name"
            name="name"
            autoComplete="off"
            required
            autoFocus
            maxLength={100}
            aria-invalid={fieldErrors.name ? true : undefined}
            aria-describedby={fieldErrors.name ? "invite-name-error" : undefined}
          />
        </Field>
        <Field label="Email" htmlFor="invite-email" hint="They'll sign in with this address." error={fieldErrors.email}>
          <Input
            id="invite-email"
            name="email"
            type="email"
            autoComplete="off"
            required
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? "invite-email-error" : "invite-email-hint"}
          />
        </Field>
        <div className="grid gap-1">
          <p className="text-sm font-medium">Role</p>
          <p className="text-sm text-muted-foreground">
            Member. Members can do everything except change settings, keys, limits and the team. You can make them the
            Owner later.
          </p>
        </div>
      </form>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" form="invite-form" disabled={pending}>
          {pending ? "Making the link…" : "Create invite link"}
        </Button>
      </DialogFooter>
    </>
  );
}

// ───────────────────────────── row menu ─────────────────────────────

function RowMenu({
  row,
  busy,
  onNewInvite,
  onResetLink,
  onSwitchOn,
  onConfirm,
}: {
  row: TeamRow;
  busy: boolean;
  onNewInvite: (row: TeamRow) => void;
  onResetLink: (row: TeamRow) => void;
  onSwitchOn: (row: TeamRow) => void;
  onConfirm: (kind: ConfirmKind, row: TeamRow) => void;
}) {
  const canNewInvite = row.status === "INVITED";
  const canReset = row.status === "ACTIVE" && !row.isYou;
  const canMakeOwner = row.status === "ACTIVE" && row.role === "MEMBER";
  const canSwitchOff = row.status !== "OFF" && row.role !== "OWNER" && !row.isYou;
  const canSwitchOn = row.status === "OFF";
  if (!canNewInvite && !canReset && !canMakeOwner && !canSwitchOff && !canSwitchOn) return null;
  return (
    // Not modal: the menu opens dialogs, and two stacked modal layers can leave the page unclickable.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`} disabled={busy}>
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {canNewInvite ? (
          <DropdownMenuItem onSelect={() => onNewInvite(row)}>
            <Link2 aria-hidden /> New invite link
          </DropdownMenuItem>
        ) : null}
        {canReset ? (
          <DropdownMenuItem onSelect={() => onResetLink(row)}>
            <KeyRound aria-hidden /> Reset password link
          </DropdownMenuItem>
        ) : null}
        {canMakeOwner ? (
          <DropdownMenuItem onSelect={() => onConfirm("makeOwner", row)}>
            <Crown aria-hidden /> Make Owner
          </DropdownMenuItem>
        ) : null}
        {canSwitchOn ? (
          <DropdownMenuItem onSelect={() => onSwitchOn(row)}>
            <Power aria-hidden /> Switch back on
          </DropdownMenuItem>
        ) : null}
        {canSwitchOff ? (
          <>
            {canNewInvite || canReset || canMakeOwner ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem variant="destructive" onSelect={() => onConfirm("switchOff", row)}>
              <PowerOff aria-hidden /> Switch off
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ───────────────────────────── the page body ─────────────────────────────

/**
 * Settings › Team (Owner only): the team list in a card whose header has "Invite a teammate" (the page's one orange
 * button), invites, links, switch off/on and ownership. The page title is the server page's (M6-DESIGN §5.1 R2).
 */
export function TeamManager({ rows }: { rows: TeamRow[] }) {
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [linkResult, setLinkResult] = useState<AccessLinkResult | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; row: TeamRow } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [campaignChoice, setCampaignChoice] = useState<CampaignChoice>("pause");
  const [busyId, setBusyId] = useState<number | null>(null);

  function showLink(result: AccessLinkResult) {
    setLinkResult(result);
    setLinkOpen(true);
    router.refresh();
  }

  async function makeLink(row: TeamRow, kind: "invite" | "reset") {
    setBusyId(row.id);
    try {
      const res =
        kind === "invite" ? await newInviteLinkAction({ userId: row.id }) : await resetPasswordLinkAction({ userId: row.id });
      if (res.ok) showLink(res.data);
      else toast.error(res.error);
    } catch {
      toast.error(TEAM_OFFLINE);
    } finally {
      setBusyId(null);
    }
  }

  async function switchOn(row: TeamRow) {
    setBusyId(row.id);
    try {
      const res = await switchOnAction({ userId: row.id });
      if (res.ok) {
        toast.success(res.message ?? `${row.name} can sign in again.`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    } catch {
      toast.error(TEAM_OFFLINE);
    } finally {
      setBusyId(null);
    }
  }

  function askConfirm(kind: ConfirmKind, row: TeamRow) {
    setConfirm({ kind, row });
    setCampaignChoice("pause");
    setConfirmOpen(true);
  }

  async function runConfirm() {
    if (!confirm) return;
    const { kind, row } = confirm;
    setBusyId(row.id);
    try {
      if (kind === "switchOff") {
        const res = await switchOffAction({
          userId: row.id,
          campaigns: row.activeCampaigns.length > 0 ? campaignChoice : "pause",
        });
        if (res.ok) {
          toast.success(res.message ?? `${row.name} is switched off.`);
          setConfirmOpen(false);
          router.refresh();
        } else {
          toast.error(res.error);
        }
      } else {
        const res = await makeOwnerAction({ userId: row.id });
        if (res.ok) {
          toast.success(res.message ?? `${row.name} is now the Owner.`);
          setConfirmOpen(false);
          // You're a Member now: leave the Owner-only pages.
          router.replace("/settings/profile");
          router.refresh();
        } else {
          toast.error(res.error);
        }
      }
    } catch {
      // The dialog stays open with its choice, so trying again is one click.
      toast.error(TEAM_OFFLINE);
    } finally {
      setBusyId(null);
    }
  }

  const confirmBusy = confirm !== null && busyId === confirm.row.id;
  const confirmName = confirm?.row.name ?? "";
  const switchOffText = confirm?.kind === "switchOff" ? switchOffDialogText(confirm.row) : null;

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle>{TEAM_PAGE_TEXT.listTitle}</CardTitle>
          <CardDescription>{TEAM_PAGE_TEXT.listDescription}</CardDescription>
          <div className="pt-2">
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus aria-hidden /> {TEAM_PAGE_TEXT.invite}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {/* Fits a phone (the email line breaks anywhere); if it ever can't, it scrolls inside the card as a named,
              focusable region (M6-DESIGN §5.1 R10). */}
          <Table scrollLabel="Team">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Last sign-in</TableHead>
                <TableHead className="w-12 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={row.status === "OFF" ? "text-muted-foreground" : undefined}>
                  <TableCell className="pl-4 whitespace-normal">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{row.name}</span>
                      {row.isYou ? <FlagBadge>You</FlagBadge> : null}
                    </div>
                    <div className="text-xs [overflow-wrap:anywhere] text-muted-foreground md:hidden">{row.email}</div>
                    <div className="text-xs text-muted-foreground lg:hidden">
                      {row.lastSignIn ? `Last sign-in ${row.lastSignInAgo}` : "Never signed in"}
                    </div>
                    {row.pendingLink ? <div className="text-xs text-muted-foreground">{row.pendingLink}</div> : null}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{row.email}</TableCell>
                  <TableCell>{row.role === "OWNER" ? "Owner" : "Member"}</TableCell>
                  <TableCell className="whitespace-normal">
                    <StatusPill status={row.status} />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {row.lastSignIn ? (
                      <span title={row.lastSignInAgo ?? undefined}>{row.lastSignIn}</span>
                    ) : (
                      <span className="text-muted-foreground">Never</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <RowMenu
                      row={row}
                      busy={busyId === row.id}
                      onNewInvite={(r) => void makeLink(r, "invite")}
                      onResetLink={(r) => void makeLink(r, "reset")}
                      onSwitchOn={(r) => void switchOn(r)}
                      onConfirm={askConfirm}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {rows.length <= 1 ? <p className="px-4 pt-4 text-sm text-muted-foreground">{TEAM_PAGE_TEXT.onlyYou}</p> : null}
        </CardContent>
      </Card>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className={`sm:max-w-md ${SETTINGS_DIALOG_CLASS}`}>
          <DialogHeader>
            <DialogTitle>Invite a teammate</DialogTitle>
            <DialogDescription>
              You&apos;ll get a link to send them. They open it and choose their own password.
            </DialogDescription>
          </DialogHeader>
          <InviteForm
            onInvited={(result) => {
              setInviteOpen(false);
              showLink(result);
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent className={`sm:max-w-lg ${SETTINGS_DIALOG_CLASS}`}>
          {linkResult ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {linkResult.purpose === "INVITE"
                    ? `Invite link for ${linkResult.name}`
                    : `Password reset link for ${linkResult.name}`}
                </DialogTitle>
                <DialogDescription>
                  {linkResult.purpose === "INVITE"
                    ? `${linkResult.name} (${linkResult.email}) chooses a password with it and is signed in.`
                    : `${linkResult.name} chooses a new password with it and is signed out on their other devices.`}
                </DialogDescription>
              </DialogHeader>
              <AccessLinkDisplay result={linkResult} />
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button">Done</Button>
                </DialogClose>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!confirmBusy) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent className={SETTINGS_DIALOG_CLASS}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {switchOffText ? switchOffText.title : `Make ${confirmName} the Owner?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {switchOffText
                ? switchOffText.intro
                : `You'll become a Member and ${confirmName} becomes the Owner. Only the Owner can change settings, keys, limits and the team.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.kind === "switchOff" ? (
            <SwitchOffDetails row={confirm.row} choice={campaignChoice} onChoice={setCampaignChoice} disabled={confirmBusy} />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.kind === "switchOff" ? "destructive" : "default"}
              disabled={confirmBusy}
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open until the change is saved
                void runConfirm();
              }}
            >
              {confirmBusy ? "Saving…" : switchOffText ? switchOffText.confirm : `Make ${confirmName} the Owner`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
