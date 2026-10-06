"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { OWNER_ONLY_POPUP_GROUPS, POPUP_GROUPS, type PopupGroup } from "@/core/notification-types";
import type { PopupPanelState } from "@/core/notifications/popups";
import { savePopupGroupsAction } from "@/app/(app)/settings/notifications/actions";
import {
  currentPopupState,
  insecurePopupText,
  localAppAddress,
  markPopupsUnsupported,
  POPUPS_CHANGED_EVENT,
  showDesktopPopup,
  writeLocalPopupSwitch,
} from "@/app/(app)/settings/notifications/desktop-popups";

/**
 * Settings › Notifications (M4-DESIGN §5.4, §9.6): the "Pop-ups on this computer" card, which shows exactly one state
 * for this browser (insecure address, phone, ask, blocked, on/off), and the "What pops up" card with the pop-up groups
 * saved per account. Whether pop-ups are on is chosen per browser (`localStorage`), because the browser's permission
 * belongs to the browser and the address, not to the account. Replaces Milestones 1–3's DesktopPopupsSetting.
 */

export const POPUP_PHONE_TEXT = "Pop-ups work on a computer only. On your phone, check the bell.";
export const POPUP_ASK_HINT = "Your browser will ask whether this app may show notifications. Click Allow.";
export const POPUP_BLOCKED_TEXT =
  "Your browser is blocking pop-ups from this app. Click the icon to the left of the address, set Notifications to Allow, then reload this page.";
export const POPUP_PIN_TIP =
  "Pop-ups only arrive while this app is open in a tab, even in the background. Pin the tab (right-click the tab, then Pin) so the browser keeps it running.";
export const POPUP_AFTER_TEST =
  "Did you see it? If not, check Windows Settings › System › Notifications: Do not disturb must be off (or your browser must be on its priority list), and your browser must be switched on in the list of apps.";
export const POPUP_GROUPS_HINT =
  "The bell always shows everything. This only chooses what also pops up on your screen. Saved for your account.";

/** The checkbox of each pop-up group (M4-DESIGN §5.4). */
export const POPUP_GROUP_LABELS: Readonly<Record<PopupGroup, string>> = {
  reply: "New replies, and messages you need to check",
  outage: "Follow-ups put on hold after the PC was off",
  campaign: "A campaign finished",
  sending: "Sending paused, bounce and spam warnings",
};

/** The groups a person can choose: everything for the Owner, everything but the Owner-only ones for a Member. */
export function popupGroupsFor(role: "OWNER" | "MEMBER"): PopupGroup[] {
  return POPUP_GROUPS.filter((g) => role === "OWNER" || !OWNER_ONLY_POPUP_GROUPS.includes(g));
}

const TEST_POPUP = {
  title: "Test pop-up from Outreach",
  body: "This is how a new reply will look.",
  tag: "pp-test-popup",
  link: null,
} as const;

const OFFLINE = "Couldn't reach the app, so nothing was saved. Check your connection and try again.";

// ───────────────────────── the view (one state, no browser calls) ─────────────────────────

export type PopupPanelViewProps = {
  /** "loading" until the browser has been read (the server can't know). */
  state: PopupPanelState | "loading";
  /** APP_PUBLIC_URL, for the insecure-address text. */
  publicUrl: string | null;
  /** The office PC's own address with this page's port ("http://localhost:3001"). */
  localAddress: string;
  /** A test pop-up was just sent: show the "Did you see it?" help. */
  testSent: boolean;
  onTurnOn?: () => void;
  onToggle?: (on: boolean) => void;
  onTest?: () => void;
};

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}

/** "Pop-ups on this computer" for one state (M4-DESIGN §9.6). Pure: the tests render it for every state. */
export function PopupPanelView({ state, publicUrl, localAddress, testSent, onTurnOn, onToggle, onTest }: PopupPanelViewProps) {
  if (state === "loading") return <p className="text-sm text-muted-foreground">Checking this browser…</p>;
  if (state === "insecure") return <Note>{insecurePopupText(publicUrl, localAddress)}</Note>;
  if (state === "phone" || state === "unsupported") return <Note>{POPUP_PHONE_TEXT}</Note>;
  if (state === "blocked") return <Note>{POPUP_BLOCKED_TEXT}</Note>;
  if (state === "ask") {
    return (
      <div className="grid gap-2">
        <div>
          <Button type="button" variant="outline" onClick={onTurnOn} aria-describedby="popups-ask-hint">
            Turn on pop-ups
          </Button>
        </div>
        <p id="popups-ask-hint" className="text-sm text-muted-foreground">
          {POPUP_ASK_HINT}
        </p>
      </div>
    );
  }
  const on = state === "on";
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="popups-here">Pop-ups in this browser</Label>
        <Switch
          id="popups-here"
          checked={on}
          onCheckedChange={(v) => onToggle?.(v)}
          aria-describedby="popups-tip"
          // Switches stay neutral (orange only means "primary" or "selected").
          className="data-checked:bg-foreground"
        />
      </div>
      <p id="popups-tip" className="text-sm text-muted-foreground">
        {POPUP_PIN_TIP}
      </p>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onTest}>
          Send a test pop-up
        </Button>
      </div>
      {testSent ? (
        <p role="status" className="text-sm text-muted-foreground">
          {POPUP_AFTER_TEST}
        </p>
      ) : null}
    </div>
  );
}

// ───────────────────────── "Pop-ups on this computer" ─────────────────────────

const noopSubscribe = () => () => {};

function emitPopupsChanged() {
  try {
    window.dispatchEvent(new Event(POPUPS_CHANGED_EVENT));
  } catch {
    // No window (never on the client).
  }
}

/**
 * Re-reads the panel state when anything it depends on changes: the switch or permission in this tab
 * (POPUPS_CHANGED_EVENT), another tab's storage, the permission changed from the address bar (Permissions API), or
 * the person coming back to the tab.
 */
function subscribeToPopupState(onChange: () => void): () => void {
  let status: PermissionStatus | null = null;
  let cancelled = false;
  window.addEventListener(POPUPS_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  window.addEventListener("focus", onChange);
  navigator.permissions
    ?.query({ name: "notifications" as PermissionName })
    .then((s) => {
      if (cancelled) return;
      status = s;
      s.addEventListener("change", onChange);
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    window.removeEventListener(POPUPS_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
    window.removeEventListener("focus", onChange);
    status?.removeEventListener("change", onChange);
  };
}

/** The "Pop-ups on this computer" card body for the signed-in user in this browser. */
export function PopupsOnThisComputer({
  userId,
  legacyDesktopReplies,
  publicUrl,
}: {
  userId: number;
  /** The M1–M3 account switch: pop-ups start on in a browser that never chose, when it was on. */
  legacyDesktopReplies: boolean;
  publicUrl: string | null;
}) {
  const [testSent, setTestSent] = useState(false);
  const getState = useCallback(() => currentPopupState(userId, legacyDesktopReplies), [userId, legacyDesktopReplies]);
  const state = useSyncExternalStore<PopupPanelState | "loading">(subscribeToPopupState, getState, () => "loading");
  const port = useSyncExternalStore(noopSubscribe, () => window.location.port, () => "");

  function turnOn() {
    // Asked straight from the click, with nothing awaited before it (browsers require a user gesture).
    let request: Promise<NotificationPermission> | undefined;
    try {
      request = window.Notification.requestPermission();
    } catch {
      markPopupsUnsupported(userId);
      emitPopupsChanged();
      return;
    }
    void Promise.resolve(request)
      .then((result) => {
        if (result === "granted") writeLocalPopupSwitch(userId, true);
      })
      .catch(() => undefined)
      .finally(emitPopupsChanged);
  }

  function toggle(on: boolean) {
    writeLocalPopupSwitch(userId, on);
    if (!on) setTestSent(false);
    emitPopupsChanged();
  }

  function sendTest() {
    // A browser that refuses to create it is remembered as unsupported, and the panel switches to the phone text.
    if (showDesktopPopup({ ...TEST_POPUP }, userId, () => undefined)) setTestSent(true);
  }

  return (
    <PopupPanelView
      state={state}
      publicUrl={publicUrl}
      localAddress={localAppAddress(port)}
      testSent={testSent}
      onTurnOn={turnOn}
      onToggle={toggle}
      onTest={sendTest}
    />
  );
}

// ───────────────────────── "What pops up" ─────────────────────────

/** The pop-up groups of the account, one checkbox each, saved on every change (toast "Saved."). */
export function PopupGroupsForm({ role, initialGroups }: { role: "OWNER" | "MEMBER"; initialGroups: PopupGroup[] }) {
  const [groups, setGroups] = useState<PopupGroup[]>(initialGroups);
  const [pending, setPending] = useState(false);
  const shown = popupGroupsFor(role);

  async function change(group: PopupGroup, on: boolean) {
    const before = groups;
    const next = POPUP_GROUPS.filter((g) => (g === group ? on : before.includes(g)));
    setGroups(next);
    setPending(true);
    try {
      const res = await savePopupGroupsAction({ groups: next });
      if (res.ok) {
        setGroups(res.data.groups);
        toast.success(res.message ?? "Saved.");
      } else {
        setGroups(before);
        toast.error(res.error);
      }
    } catch {
      setGroups(before);
      toast.error(OFFLINE);
    } finally {
      setPending(false);
    }
  }

  return (
    <fieldset className="grid gap-3" aria-describedby="popup-groups-hint">
      <legend className="sr-only">What pops up</legend>
      {shown.map((g) => {
        const id = `popup-group-${g}`;
        return (
          <div key={g} className="flex items-center gap-3">
            <Checkbox
              id={id}
              checked={groups.includes(g)}
              disabled={pending}
              onCheckedChange={(v) => void change(g, v === true)}
            />
            <Label htmlFor={id} className="font-normal">
              {POPUP_GROUP_LABELS[g]}
            </Label>
          </div>
        );
      })}
      <p id="popup-groups-hint" className="text-sm text-muted-foreground">
        {POPUP_GROUPS_HINT}
      </p>
    </fieldset>
  );
}
