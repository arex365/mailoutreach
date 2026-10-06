import "server-only";
import { UserError } from "@/lib/action";
import { TeamError } from "@/server/services/users";

/** Runs a team/account service call, turning its plain-language TeamError into a UserError for runAction(). */
export async function withTeamErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TeamError) throw new UserError(err.message, err.fieldErrors);
    throw err;
  }
}
