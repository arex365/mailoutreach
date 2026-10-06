/**
 * A campaign problem the person can fix, in plain words (launch, pause, skip, edit…). Server Actions
 * turn it into a UserError (`if (err instanceof CampaignError) throw new UserError(err.message)`).
 * `code` is a stable tag for tests and screens; never show it.
 */
export class CampaignError extends Error {
  readonly code: string;
  constructor(message: string, code = "campaign") {
    super(message);
    this.name = "CampaignError";
    this.code = code;
  }
}

export const CAMPAIGN_GONE = "This campaign doesn't exist any more. Refresh the page to see the latest.";
export const RECIPIENT_GONE = "This person isn't in the campaign any more. Refresh the page to see the latest.";
export const EMAIL_GONE = "This email doesn't exist any more. Refresh the page to see the latest.";
/** B6.7: web edits use `updateMany where status = QUEUED`; a count of 0 means the worker has it. */
export const SENDING_NOW = "This email is being sent right now, so it can't be changed.";
