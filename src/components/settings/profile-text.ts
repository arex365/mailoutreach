/**
 * Help text under "Sign-in email" on My profile. A sign-in email can't be edited in the app: the
 * real remedy is a new account for the new address (Settings › Team), so the text says exactly that.
 */
export function signInEmailHelp(isOwner: boolean): string {
  return isOwner
    ? "It can't be changed here. To sign in with a different address, invite it in Settings › Team and accept the invite, make the new account the Owner, then switch this one off."
    : "It can't be changed here. To use a different address, the Owner switches this account off and invites the new address in Settings › Team.";
}
