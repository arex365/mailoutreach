/**
 * Dialog classes for the AI screens (docs/dev/M5-DESIGN.md §6: "dialogs open full screen on a phone"): a centred dialog
 * on a laptop, the whole screen below the `sm` breakpoint, scrolling inside when it is taller than the screen.
 */
export const PHONE_FULL_SCREEN_DIALOG =
  "max-h-dvh overflow-y-auto sm:max-w-lg max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none";

/** "Couldn't reach the app…": a Server Action call that never got an answer (offline, the app restarting). */
export const OFFLINE_TEXT = "Couldn't reach the app, so nothing changed. Check your connection and try again.";
