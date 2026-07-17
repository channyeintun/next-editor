// Public exports for the host app.
export { default as AuthMenu } from "./auth/AuthMenu";
export { useAuth, useSignOut, useUpdateUsername, signInUrl, avatarProxyUrl } from "./auth/useAuth";
export { default as UploadLessonModal } from "./upload/UploadLessonModal";
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
  listCollaborationInvitations,
  listCollaborationMembers,
  listCollaborationRooms,
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
export { THUMBNAIL_ACCEPT, MAX_THUMBNAIL_BYTES } from "./upload/thumbnailConstraints";
export { resizeThumbnail } from "./upload/resizeThumbnail";
