/**
 * The one sentence for "the public address isn't set yet" (M6-DESIGN §5.2, docs audit §2.6): with the Windows services
 * installed, setup.bat alone doesn't reach the running app, so every screen names update.bat too. A plain module, so
 * server and client components share it.
 */
export const PUBLIC_ADDRESS_SETUP_TEXT =
  "Follow the Cloudflare guide (docs\\setup\\3-cloudflare.md), then run setup.bat again (and update.bat if the app runs as a Windows service).";
