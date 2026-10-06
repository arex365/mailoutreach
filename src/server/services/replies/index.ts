/**
 * Reply processing and the waiting list (M4-DESIGN §3, §4): `processInboundMessage` / `processPendingInbound` (the
 * event lane and Simulate), the decisions (Answered, No answer needed, Undo, Real reply / It was an auto-reply, Link
 * to a company, Add the sender), the Notifications page's read models, and the 30-day clearing of reply texts (the
 * daily clean-up). The linking, input and effect helpers stay internal to this folder.
 */
export {
  INBOUND_BATCH,
  INBOUND_MAX_FAILURES,
  INBOUND_RETRY_DELAYS_MS,
  QUIET_AFTER_MS,
  REPLY_FROM_MATCH_MS,
  applyReplyFailSafe,
  processInboundMessage,
  processPendingInbound,
  type InboundFailures,
  type ProcessedReply,
} from "./process";
export {
  COMPANY_DELETED,
  DECIDE_FIRST,
  PICK_COMPANY,
  REPLY_GONE,
  addReplySender,
  belongsElsewhereText,
  confirmReply,
  handledByText,
  linkReply,
  markReplyAnswered,
  markReplyNotNeeded,
  reopenReply,
  type LinkReplyInput,
  type ReplyActor,
} from "./actions";
export { REPLY_TEXT_DAYS, clearOldReplyTexts } from "./retention";
export {
  OTHER_MESSAGES_DAYS,
  WAITING_PAGE_SIZE,
  getLinkCompany,
  getWaitingReply,
  listOtherMessages,
  listWaitingReplies,
  type LinkCompanyView,
  type WaitingReplyView,
  type WaitingViewer,
} from "./waiting";
