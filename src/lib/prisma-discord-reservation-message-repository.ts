import {
  beginInitialSendTerminalDelivery,
  beginInitialSendPost,
  createDiscordReservationMessage,
  createDiscordReservationMessageInSystemContext,
  markInitialSendPendingReview,
  readOperationsControl,
  reconcileExpiredInitialPosts,
  saveInitialSendFailure,
  saveInitialSendSuccess
} from "./prisma-discord-reservation-message-initial-send";
import {
  claimInitialSend,
  claimInitialSends,
  claimMessageSync,
  claimMessageSyncs,
  reconcileLegacyDiscordTransportClaims
} from "./prisma-discord-reservation-message-claims";
import {
  deleteExpiredInteractionReceipts,
  deleteExpiredMessages
} from "./prisma-discord-reservation-message-cleanup";
import {
  bumpMessageRevision,
  beginSyncPatch,
  markSyncPendingReview,
  readMessageSyncState,
  reconcileExpiredSyncPatches,
  saveLeasedSyncSuccess,
  saveSyncFailure,
  saveSyncSuccess
} from "./prisma-discord-reservation-message-sync";

export {
  DISCORD_CLAIM_BATCH_SIZE,
  DISCORD_CLAIM_LEASE_MS,
  type DiscordInitialSendClaim,
  type DiscordMessageSyncClaim
} from "./prisma-discord-reservation-message-claims";
export { DISCORD_CLEANUP_BATCH_SIZE } from "./prisma-discord-reservation-message-cleanup";
export {
  findDiscordInteractionTerminalResult,
  recordDiscordInteractionReceipt,
  recordDiscordReservationDecision
} from "./prisma-discord-reservation-message-interactions";
export {
  cappedDiscordRetryAt,
  createDiscordReservationMessage
} from "./prisma-discord-reservation-message-initial-send";
export type { DiscordMessageSyncState } from "./prisma-discord-reservation-message-sync";

export const prismaDiscordReservationMessageRepository = {
  beginInitialSendPost,
  beginInitialSendTerminalDelivery,
  beginSyncPatch,
  bumpMessageRevision,
  claimInitialSend,
  claimInitialSends,
  claimMessageSync,
  claimMessageSyncs,
  reconcileLegacyDiscordTransportClaims,
  create: createDiscordReservationMessageInSystemContext,
  deleteExpiredInteractionReceipts,
  deleteExpiredMessages,
  readMessageSyncState,
  readOperationsControl,
  reconcileExpiredInitialPosts,
  reconcileExpiredSyncPatches,
  markInitialSendPendingReview,
  markSyncPendingReview,
  saveInitialSendFailure,
  saveInitialSendSuccess,
  saveLeasedSyncSuccess,
  saveSyncFailure,
  saveSyncSuccess
} as const;
