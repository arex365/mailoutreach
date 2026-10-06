/**
 * Settings dialogs open full screen on a phone (M6-DESIGN §5.1 R10): a centred dialog from 640 px, the whole screen
 * below it, scrolling inside when taller than the screen. The width reset is marked important because the alert
 * dialog sets its own `data-[size=…]` widths, which would otherwise win on a phone.
 */
export const SETTINGS_DIALOG_CLASS =
  "max-h-dvh overflow-y-auto max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none! max-sm:translate-x-0 max-sm:translate-y-0 max-sm:content-start max-sm:rounded-none";
