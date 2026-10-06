/**
 * The fixed sentences of Settings › Team (SPEC §1, M6-DESIGN §5.1 R2, R8). A plain module, so the server page can read
 * them too (a "use client" file's values can't be read on the server).
 */
export const TEAM_PAGE_TEXT = {
  description:
    "Everyone who can sign in. Members can do everything except settings, keys, limits and the team. There's always exactly one Owner.",
  listTitle: "People",
  listDescription: "Invite links, password reset links, switching people off or on, and who the Owner is.",
  invite: "Invite a teammate",
  /** R8: the list's empty state (only the Owner so far). */
  onlyYou: "Only you so far. Click Invite a teammate to create an invite link.",
} as const;
