// Public exports for the host app.
export { default as AuthMenu } from "./auth/AuthMenu";
export { useAuth, useSignOut, useUpdateUsername, signInUrl, avatarProxyUrl } from "./auth/useAuth";
export {
  default as UploadLessonModal,
  preloadUploadLessonModal,
} from "./upload/LazyUploadLessonModal";
export type { UploadLessonModalProps } from "./upload/UploadLessonModal";
export { loadResumeIntent, clearResumeIntent } from "./upload/resumeIntent";
export type { ResumeIntent } from "./upload/resumeIntent";
export {
  useMyLessons,
  usePublishFromLibrary,
  useUnpublishLesson,
  useDeleteLesson,
  useUpdateThumbnail,
  useUpdateLessonName,
} from "./library/useMyLessons";
export type { OwnedLesson } from "../db/types";
export { useAuthorProfile } from "./authors/useAuthorProfile";
export type { AuthorProfile } from "./authors/authorsApi";
export {
  createCollaborationRoom,
  claimCollaborationInvitation,
  closeCollaborationRoom,
  createCollaborationInvitation,
  downloadCollaborationAsset,
  exportCollaborationRoom,
  getCollaborationRoom,
  getCollaborationVoiceAvailability,
  initializeCollaborationTeachingSurfaces,
  listCollaborationInvitations,
  listCollaborationMembers,
  removeCollaborationMember,
  revokeCollaborationInvitation,
  updateCollaborationMemberRole,
  uploadCollaborationAsset,
} from "./collaboration/collaborationApi";
export type { AuthorSummary } from "../db/types";
export { useSearch } from "./search/useSearch";
export type { SearchResults } from "./search/searchApi";
export {
  useMyPlaylists,
  usePlaylistsForLesson,
  usePlaylistLessons,
  useCreatePlaylist,
  useUpdatePlaylist,
  useDeletePlaylist,
  useAddLessonToPlaylist,
  useRemoveLessonFromPlaylist,
  useReorderPlaylistLessons,
} from "./playlists/usePlaylists";
export type { OwnedPlaylist, OwnedPlaylistWithMembership, PlaylistSummary } from "../db/types";
export { THUMBNAIL_ACCEPT } from "./upload/thumbnailConstraints";
export { prepareThumbnail } from "./upload/prepareThumbnail";
export { MAX_TITLE_CHARS, MAX_DESCRIPTION_CHARS } from "../lessons/metadataLimits";
export { useStudioCapabilities } from "./studio/useStudioCapabilities";
export type { StudioCapabilities } from "./studio/useStudioCapabilities";
export {
  athanLabErrorOf,
  athanLabVoiceSampleUrl,
  invalidateAthanLabAccount,
  useAthanLabKey,
  useAthanLabUsage,
  useAthanLabVoices,
  useRemoveAthanLabKey,
  useSaveAthanLabKey,
} from "./studio/athanlab";
export type {
  AthanLabError,
  AthanLabKeySaveResult,
  AthanLabKeyStatus,
  AthanLabUsage,
  AthanLabUsageReport,
  AthanLabVoice,
  AthanLabVoiceList,
} from "./studio/athanlab";
