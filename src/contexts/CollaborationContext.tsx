import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router";
import { usePostHog } from "@posthog/react";
import * as Y from "yjs";
import {
  claimCollaborationInvitation,
  closeCollaborationRoom,
  createCollaborationInvitation,
  createCollaborationRoom,
  downloadCollaborationAsset,
  exportCollaborationRoom,
  getCollaborationRoom,
  initializeCollaborationTeachingSurfaces,
  listCollaborationInvitations,
  listCollaborationMembers,
  removeCollaborationMember,
  revokeCollaborationInvitation,
  updateCollaborationMemberRole,
  uploadCollaborationAsset,
  useAuth,
} from "@next-editor/infra";
import type {
  CollaborationAwarenessEvent,
  CollaborationCursor,
  CollaborationInvitation,
  CollaborationInviteRole,
  CollaborationMember,
  CollaborationRole,
  CollaborationRoomSession,
  CollaborationSurface,
  CreatedCollaborationInvitation,
} from "../collaboration/protocol";
import {
  COLLABORATION_AWARENESS_TTL_MS,
  MAX_COLLABORATION_ROOM_ASSETS,
  MAX_COLLABORATION_ROOM_ASSET_BYTES,
} from "../collaboration/protocol";
import {
  CollaborationProjectController,
  canWriteCollaborationDocument,
  projectCollaborationDocument,
  seedCollaborationProject,
  type CollaborationProjectProjection,
} from "../collaboration/projectDocument";
import {
  createCollaborationRoomSnapshot,
  createCollaborationTeachingInitialization,
} from "../collaboration/yjsUpdates";
import {
  CollaborationRoomProvider,
  type CollaborationRoomApi,
} from "../collaboration/roomProvider";
import {
  collaborationConnectionState,
  type CollaborationConnectionState,
} from "../collaboration/collaborationMachine";
import {
  applyCollaborationParticipantEvent,
  getCollaborationFollowAvailability,
  isCollaborationFollowSuspendedConnectionState,
  scheduleCollaborationAwarenessFlush,
} from "../collaboration/followLifecycle";
import {
  projectCollaborationTransaction,
  reprojectCollaborationWorkspace,
} from "../collaboration/workspaceAdapter";
import { WorkspaceActionsContext, type WorkspaceActions } from "./WorkspaceContext";
import { applyTextEditEvent, type TextEditEvent } from "../types/textEdit";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { useWorkspaceActions, useWorkspaceActiveFilePath } from "../hooks/useWorkspace";
import { createCollaborationCursor } from "../collaboration/relativePosition";
import { liveRoomEndBlockReason } from "../collaboration/recordingPolicy";
import {
  isWorkspaceAssetDescriptor,
  isWorkspaceAssetFile,
  isWorkspaceTextFile,
} from "../types/workspace";
import {
  getWorkspaceAssetBlob,
  getWorkspaceAssetBytes,
  registerWorkspaceAsset,
} from "../storage/workspaceAssetStore";
import { createCollaborationUndoManager } from "../collaboration/undo";
import {
  applyCollaborationWhiteboardDelta,
  collaborationTransactionTouchesOnlyTeaching,
  collaborationTransactionTouchesTeaching,
  collaborationSlidePayloadAssetId,
  collaborationTeachingSlideMimeType,
  hydrateCollaborationSlideManifest,
  isCollaborationTeachingInitialized,
  normalizeCollaborationTeachingSlides,
  projectCollaborationTeachingDocument,
  seedCollaborationTeachingDocument,
  setCollaborationCurrentSlide,
  type CollaborationTeachingProjection,
} from "../collaboration/teachingDocument";
import { useSlidesStore } from "./SlidesStoreContext";
import { useWhiteboardStore } from "./WhiteboardStoreContext";
import {
  discardPendingWhiteboardChange,
  flushPendingWhiteboardChange,
} from "../hooks/useWhiteboardController";
import {
  restoreSlidesStore,
  setSlidesStoreDeckBorrowed,
  snapshotSlidesStore,
  type SlidesStoreSnapshot,
} from "../stores/slidesStore";
import { restoreWhiteboardStore, snapshotWhiteboardStore } from "../stores/whiteboardStore";
import type { Slide } from "../types/slides";
import {
  EMPTY_WHITEBOARD_SCENE,
  snapshotWhiteboardDelta,
  type WhiteboardEvent,
  type WhiteboardSceneState,
} from "../core/src/whiteboard";

export type CollaborationParticipant = Extract<CollaborationAwarenessEvent, { kind: "state" }>;

export type CollaborationFollowStopReason =
  | "user"
  | "local-editor-input"
  | "local-scroll"
  | "local-file-navigation"
  | "local-slide-input"
  | "local-whiteboard-input"
  | "local-surface-change"
  | "target-left"
  | "room-changed"
  | "playback";

interface CollaborationContextValue {
  provider: CollaborationRoomProvider | null;
  doc: Y.Doc | null;
  session: CollaborationRoomSession | null;
  connectionState: CollaborationConnectionState;
  role: CollaborationRole | null;
  isHost: boolean;
  canWrite: boolean;
  isCreatingRoom: boolean;
  hasOfflineChanges: boolean;
  members: CollaborationMember[];
  invitations: CollaborationInvitation[];
  participants: CollaborationParticipant[];
  followedSessionId: string | null;
  followedParticipant: CollaborationParticipant | null;
  isApplyingFollow: boolean;
  teaching: CollaborationTeachingProjection;
  teachingSlides: Slide[] | null;
  isTeachingLoading: boolean;
  canRetryAssets: boolean;
  error: string | null;
  /** A `?invite=` token staged for confirmation. Never claimed automatically. */
  pendingInviteToken: string | null;
  isAcceptingInvitation: boolean;
  acceptInvitation: () => Promise<void>;
  declineInvitation: () => void;
  createRoom: () => Promise<CollaborationRoomSession>;
  joinRoom: (roomId: string) => void;
  leaveRoom: () => Promise<void>;
  retry: () => Promise<void>;
  closeRoom: () => Promise<void>;
  exportRoom: () => Promise<Blob>;
  refreshRoomData: () => Promise<void>;
  createInvitation: (role: CollaborationInviteRole) => Promise<CreatedCollaborationInvitation>;
  revokeInvitation: (invitationId: string) => Promise<void>;
  updateMemberRole: (userId: string, role: CollaborationInviteRole) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;
  followParticipant: (sessionId: string) => void;
  stopFollowing: (reason?: CollaborationFollowStopReason) => void;
  publishSurface: (surface: CollaborationSurface) => void;
  runFollowApplication: (application: () => void) => void;
  initializeTeachingSurfaces: () => Promise<void>;
  publishCurrentSlide: (slideId: string) => boolean;
  publishWhiteboardDelta: (event: Pick<WhiteboardEvent, "upserts" | "removedIds">) => boolean;
  updateCursor: (path: string, anchorOffset: number, headOffset: number) => void;
  queueLocalTextEdit: (
    event: TextEditEvent,
    onProjected?: (content: string | null) => void,
  ) => void;
  getNodeIdForPath: (path: string) => string | null;
  getPathForNodeId: (nodeId: string) => string | null;
  retryAssets: () => void;
  undo: () => void;
  redo: () => void;
  clearError: () => void;
}

const CollaborationContext = createContext<CollaborationContextValue | null>(null);

const collaborationApi: CollaborationRoomApi = {
  getRoom: getCollaborationRoom,
};

const EMPTY_TEACHING_PROJECTION: CollaborationTeachingProjection = {
  initialized: false,
  slideOrder: [],
  slides: new Map(),
  currentSlideId: null,
  presentationRevision: 0,
  whiteboardElements: [],
};

function messageFromError(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const responseMessage = (error as { response?: { data?: { error?: unknown } } }).response?.data
      ?.error;
    if (typeof responseMessage === "string") return responseMessage;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function isRetryableTeachingInitializationError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null
      ? (error as { response?: { status?: unknown } }).response?.status
      : undefined;
  return status === undefined || status === 429 || (typeof status === "number" && status >= 500);
}

interface CollaborationTeachingAssetPlan {
  items: Array<{ slide: Slide; payload: Uint8Array; assetId: string }>;
  assets: Map<string, { id: string; payload: Uint8Array; mimeType: string }>;
}

async function createCollaborationTeachingAssetPlan(
  slides: readonly Slide[],
): Promise<CollaborationTeachingAssetPlan> {
  const normalized = normalizeCollaborationTeachingSlides(slides);
  const items: CollaborationTeachingAssetPlan["items"] = [];
  const assets: CollaborationTeachingAssetPlan["assets"] = new Map();
  for (const item of normalized) {
    const assetId = await collaborationSlidePayloadAssetId(item.payload);
    const mimeType = collaborationTeachingSlideMimeType(item.slide.contentType);
    const existing = assets.get(assetId);
    if (
      existing &&
      (existing.mimeType !== mimeType ||
        existing.payload.byteLength !== item.payload.byteLength ||
        !existing.payload.every((byte, index) => byte === item.payload[index]))
    ) {
      throw new Error("Distinct teaching payloads produced the same content digest.");
    }
    if (!existing) assets.set(assetId, { id: assetId, payload: item.payload, mimeType });
    items.push({ ...item, assetId });
  }
  return { items, assets };
}

function areCollaborationSurfacesEqual(
  left: CollaborationSurface,
  right: CollaborationSurface,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "editor" && right.kind === "editor") {
    if (left.fileNodeId !== right.fileNodeId) return false;
    if (left.viewport === right.viewport) return true;
    if (!left.viewport || !right.viewport) return false;
    return (
      left.viewport.topAnchor === right.viewport.topAnchor &&
      left.viewport.topDeltaPx === right.viewport.topDeltaPx &&
      left.viewport.scrollLeftPx === right.viewport.scrollLeftPx
    );
  }
  if (left.kind === "slides" && right.kind === "slides") {
    return left.isMaximized === right.isMaximized;
  }
  if (left.kind === "whiteboard" && right.kind === "whiteboard") {
    return (
      left.isMaximized === right.isMaximized &&
      left.viewport.scrollX === right.viewport.scrollX &&
      left.viewport.scrollY === right.viewport.scrollY &&
      left.viewport.zoom === right.viewport.zoom
    );
  }
  return false;
}

function stopProviderAfterBestEffortFlush(provider: CollaborationRoomProvider): void {
  if (provider.connectionState === "live" && provider.hasPendingUpdates) {
    void provider.flushNow().then(
      () => provider.stop(),
      () => provider.stop(),
    );
  } else {
    provider.stop();
  }
}

export function CollaborationProvider({ children }: { children: ReactNode }) {
  const posthog = usePostHog();
  const posthogRef = useRef(posthog);
  posthogRef.current = posthog;
  const baseActions = useWorkspaceActions();
  const { store: slidesStore } = useSlidesStore();
  const { store: whiteboardStore } = useWhiteboardStore();
  const activeFilePath = useWorkspaceActiveFilePath();
  const baseActionsRef = useRef(baseActions);
  baseActionsRef.current = baseActions;
  const { usesPlaybackModel, isRecording } = useNextEditorMetadata();
  const { handleSlideEvent, handleWhiteboardEvent } = useNextEditorActions();
  const playbackRef = useRef(usesPlaybackModel);
  playbackRef.current = usesPlaybackModel;
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;
  const { user, isSignedIn, isLoading: isAuthLoading } = useAuth();
  const userRef = useRef(user);
  userRef.current = user;
  const [searchParams, setSearchParams] = useSearchParams();
  const roomId = searchParams.get("room");
  const inviteToken = searchParams.get("invite");
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [provider, setProvider] = useState<CollaborationRoomProvider | null>(null);
  const providerRef = useRef<CollaborationRoomProvider | null>(null);
  const providerGenerationRef = useRef(0);
  const roomDataRequestRef = useRef(0);
  const projectionRef = useRef<CollaborationProjectProjection | null>(null);
  const pendingLocalTextEditRef = useRef<{
    event: TextEditEvent;
    onProjected?: (content: string | null) => void;
  } | null>(null);
  const assetFetchesRef = useRef(new Set<string>());
  const assetHydrationGenerationRef = useRef(0);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(null);
  const [isAcceptingInvitation, setIsAcceptingInvitation] = useState(false);
  const [retryableAssetError, setRetryableAssetError] = useState<string | null>(null);
  const canRetryAssets = localError !== null && localError === retryableAssetError;
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [invitations, setInvitations] = useState<CollaborationInvitation[]>([]);
  const [participantsBySession, setParticipantsBySession] = useState(
    () => new Map<string, CollaborationParticipant>(),
  );
  const [followedSessionId, setFollowedSessionId] = useState<string | null>(null);
  const followedSessionIdRef = useRef<string | null>(null);
  const followedSurfaceKindRef = useRef<CollaborationSurface["kind"] | null>(null);
  followedSessionIdRef.current = followedSessionId;
  const [isApplyingFollow, setIsApplyingFollow] = useState(false);
  const applyingFollowDepthRef = useRef(0);
  const applyingFollowReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [teaching, setTeaching] =
    useState<CollaborationTeachingProjection>(EMPTY_TEACHING_PROJECTION);
  const [teachingSlides, setTeachingSlides] = useState<Slide[] | null>(null);
  const [isTeachingLoading, setIsTeachingLoading] = useState(false);
  const teachingProjectionRef = useRef<CollaborationTeachingProjection | null>(null);
  const localWhiteboardProjectionFingerprintRef = useRef<string | null>(null);
  const appliedPresentationRevisionRef = useRef<number | null>(null);
  const teachingHydrationGenerationRef = useRef(0);
  const teachingHydrationKeyRef = useRef<string | null>(null);
  const teachingSlideCacheRef = useRef(new Map<string, Promise<Uint8Array>>());
  const standaloneStoresRef = useRef<{
    roomId: string;
    slides: SlidesStoreSnapshot;
    whiteboard: WhiteboardSceneState;
  } | null>(null);
  const claimingTokenRef = useRef<string | null>(null);
  const awarenessRevisionRef = useRef(0);
  const awarenessCursorRef = useRef<CollaborationCursor | null>(null);
  const awarenessSurfaceRef = useRef<CollaborationSurface>({
    kind: "editor",
    fileNodeId: null,
    viewport: null,
  });
  const awarenessPublishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;

  useEffect(() => {
    if (localError === null) setRetryableAssetError(null);
  }, [localError]);

  const stopFollowing = useCallback((reason: CollaborationFollowStopReason = "user") => {
    if (!followedSessionIdRef.current) return;
    followedSessionIdRef.current = null;
    followedSurfaceKindRef.current = null;
    providerRef.current?.setAwarenessPublicationSuppressed(applyingFollowDepthRef.current > 0);
    setFollowedSessionId(null);
    posthogRef.current?.capture("collaboration_follow_stopped", { reason });
  }, []);

  const queueLocalTextEdit = useCallback(
    (event: TextEditEvent, onProjected?: (content: string | null) => void) => {
      const pending = { event, onProjected };
      pendingLocalTextEditRef.current = pending;
      queueMicrotask(() => {
        if (pendingLocalTextEditRef.current === pending) pendingLocalTextEditRef.current = null;
      });
    },
    [],
  );

  const getCurrentProjection = useCallback((): CollaborationProjectProjection | null => {
    if (projectionRef.current) return projectionRef.current;
    const current = providerRef.current;
    if (!current) return null;
    try {
      const projection = projectCollaborationDocument(current.doc);
      projectionRef.current = projection;
      return projection;
    } catch {
      return null;
    }
  }, []);

  const getNodeIdForPath = useCallback(
    (path: string) => getCurrentProjection()?.nodeIdByPath.get(path) ?? null,
    [getCurrentProjection],
  );

  const getPathForNodeId = useCallback(
    (nodeId: string) => getCurrentProjection()?.pathByNodeId.get(nodeId) ?? null,
    [getCurrentProjection],
  );

  const hydrateProjectionAssets = useCallback(
    (projection: CollaborationProjectProjection, targetRoomId: string) => {
      const generation = assetHydrationGenerationRef.current;
      for (const [nodeId, asset] of projection.assetsByNodeId) {
        const path = projection.pathByNodeId.get(nodeId);
        if (!path) continue;
        const fetchKey = `${generation}:${asset.id}`;
        if (assetFetchesRef.current.has(fetchKey)) continue;
        assetFetchesRef.current.add(fetchKey);
        const descriptor = {
          kind: "asset" as const,
          assetId: asset.id,
          mimeType: asset.mimeType,
          size: asset.size,
        };
        void getWorkspaceAssetBlob(descriptor)
          .catch(() =>
            downloadCollaborationAsset(targetRoomId, asset.id).then((bytes) =>
              registerWorkspaceAsset(bytes, {
                mimeType: asset.mimeType,
                expectedAssetId: asset.id,
              }),
            ),
          )
          .then(() => {
            if (generation !== assetHydrationGenerationRef.current) return;
            baseActionsRef.current.notifyAssetAvailable(asset.id);
          })
          .catch((error: unknown) => {
            if (generation !== assetHydrationGenerationRef.current) return;
            const message = messageFromError(
              error,
              `The shared asset ${path} could not be downloaded.`,
            );
            setRetryableAssetError(message);
            setLocalError(message);
          })
          .finally(() => assetFetchesRef.current.delete(fetchKey));
      }
    },
    [],
  );

  const projectTeachingState = useCallback(
    (doc: Y.Doc, targetRoomId: string) => {
      let projection: CollaborationTeachingProjection;
      try {
        projection = projectCollaborationTeachingDocument(doc);
      } catch (error) {
        setLocalError(
          messageFromError(error, "The shared teaching surfaces could not be projected."),
        );
        return;
      }

      const previous = teachingProjectionRef.current;
      teachingProjectionRef.current = projection;
      setTeaching(projection);

      const currentProvider = providerRef.current;
      const currentUser = userRef.current;
      // A known uninitialized projection becoming initialized is a live room
      // change (and must be recorded); `previous === null` is first hydration.
      const shouldRecordCanonicalChange = Boolean(
        previous &&
        projection.initialized &&
        isRecordingRef.current &&
        currentProvider?.session &&
        currentUser &&
        currentProvider.session.room.hostUserId === currentUser.id,
      );
      if (
        shouldRecordCanonicalChange &&
        previous?.currentSlideId !== projection.currentSlideId &&
        projection.currentSlideId
      ) {
        handleSlideEvent({
          type: "slide_change",
          timestamp: performance.now(),
          slideId: projection.currentSlideId,
          indexv: 0,
        });
      }
      if (shouldRecordCanonicalChange && previous) {
        const delta = snapshotWhiteboardDelta(
          previous.whiteboardElements,
          projection.whiteboardElements,
        );
        if (delta) {
          handleWhiteboardEvent({
            timestamp: performance.now(),
            ...(delta.upserts.length ? { upserts: delta.upserts } : {}),
            ...(delta.removedIds.length ? { removedIds: delta.removedIds } : {}),
          });
        }
      }

      const hydrationKey = JSON.stringify({
        roomId: targetRoomId,
        initialized: projection.initialized,
        slides: projection.slideOrder.map((slideId) => {
          const manifest = projection.slides.get(slideId);
          return manifest
            ? [slideId, manifest.contentType, manifest.asset.id, manifest.asset.size]
            : [slideId, null];
        }),
      });
      if (teachingHydrationKeyRef.current === hydrationKey) return;
      teachingHydrationKeyRef.current = hydrationKey;

      const generation = ++teachingHydrationGenerationRef.current;
      if (!projection.initialized || projection.slideOrder.length === 0) {
        setTeachingSlides([]);
        setIsTeachingLoading(false);
        return;
      }
      setTeachingSlides(null);
      setIsTeachingLoading(true);
      const loads = projection.slideOrder.map((slideId) => {
        const manifest = projection.slides.get(slideId);
        if (!manifest) return Promise.reject(new Error("A shared slide manifest is missing."));
        return hydrateCollaborationSlideManifest(manifest, teachingSlideCacheRef.current, () =>
          downloadCollaborationAsset(targetRoomId, manifest.asset.id),
        );
      });
      void Promise.all(loads)
        .then((slides) => {
          if (
            generation !== teachingHydrationGenerationRef.current ||
            providerRef.current?.session?.room.id !== targetRoomId
          ) {
            return;
          }
          setTeachingSlides(slides.map((slide, index) => ({ ...slide, order: index })));
          setIsTeachingLoading(false);
        })
        .catch((error: unknown) => {
          if (generation !== teachingHydrationGenerationRef.current) return;
          setTeachingSlides(null);
          setIsTeachingLoading(false);
          const message = messageFromError(
            error,
            "The shared presentation could not be downloaded.",
          );
          setRetryableAssetError(message);
          setLocalError(message);
        });
    },
    [handleSlideEvent, handleWhiteboardEvent],
  );

  const applyAwarenessEvent = useCallback((event: CollaborationAwarenessEvent) => {
    setParticipantsBySession((current) => applyCollaborationParticipantEvent(current, event));
  }, []);

  const refreshRoomDataFor = useCallback(
    async (targetRoomId: string, owner: boolean, providerGeneration?: number) => {
      const request = ++roomDataRequestRef.current;
      const [{ members: nextMembers }, nextInvitations] = await Promise.all([
        listCollaborationMembers(targetRoomId),
        owner ? listCollaborationInvitations(targetRoomId) : Promise.resolve([]),
      ]);
      if (
        request !== roomDataRequestRef.current ||
        (providerGeneration !== undefined && providerGenerationRef.current !== providerGeneration)
      ) {
        return;
      }
      setMembers(nextMembers);
      setInvitations(nextInvitations);
    },
    [],
  );

  // Claiming an invitation is a state-changing POST that permanently adds the
  // caller to someone else's room, and joining reprojects the room's document
  // over the local workspace — which then auto-starts the runtime and runs the
  // room's package scripts. Firing that from a bare `?invite=` on mount made a
  // single link enough to plant and execute another person's files in a
  // signed-in visitor's workspace, and to start broadcasting their identity,
  // cursor and open file. So the token is only staged here; `acceptInvitation`
  // has to be called from a real user gesture.
  useEffect(() => {
    if (!inviteToken || isAuthLoading) {
      setPendingInviteToken(null);
      return;
    }
    if (!isSignedIn) {
      setPendingInviteToken(null);
      setLocalError("Sign in to accept this collaboration invitation.");
      return;
    }
    if (claimingTokenRef.current === inviteToken) return;
    setPendingInviteToken(inviteToken);
  }, [inviteToken, isAuthLoading, isSignedIn]);

  const acceptInvitation = useCallback(async () => {
    const token = pendingInviteToken;
    if (!token || claimingTokenRef.current === token) return;
    claimingTokenRef.current = token;
    setIsAcceptingInvitation(true);
    try {
      const session = await claimCollaborationInvitation(token);
      setLocalError(null);
      setPendingInviteToken(null);
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("invite");
          next.set("room", session.room.id);
          return next;
        },
        { replace: true },
      );
    } catch (error: unknown) {
      setLocalError(messageFromError(error, "The collaboration invitation could not be accepted."));
      claimingTokenRef.current = null;
    } finally {
      setIsAcceptingInvitation(false);
    }
  }, [pendingInviteToken, setSearchParams]);

  const declineInvitation = useCallback(() => {
    setPendingInviteToken(null);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("invite");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  useEffect(() => {
    if (!roomId || inviteToken) {
      providerGenerationRef.current += 1;
      stopFollowing("room-changed");
      if (applyingFollowReleaseTimerRef.current) {
        clearTimeout(applyingFollowReleaseTimerRef.current);
        applyingFollowReleaseTimerRef.current = null;
      }
      applyingFollowDepthRef.current = 0;
      setIsApplyingFollow(false);
      setParticipantsBySession(new Map());
      setMembers([]);
      setInvitations([]);
      if (providerRef.current) stopProviderAfterBestEffortFlush(providerRef.current);
      providerRef.current = null;
      projectionRef.current = null;
      pendingLocalTextEditRef.current = null;
      assetHydrationGenerationRef.current += 1;
      assetFetchesRef.current.clear();
      teachingProjectionRef.current = null;
      localWhiteboardProjectionFingerprintRef.current = null;
      appliedPresentationRevisionRef.current = null;
      teachingHydrationGenerationRef.current += 1;
      teachingHydrationKeyRef.current = null;
      teachingSlideCacheRef.current.clear();
      setTeaching(EMPTY_TEACHING_PROJECTION);
      setTeachingSlides(null);
      setIsTeachingLoading(false);
      setRetryableAssetError(null);
      setProvider(null);
      return;
    }

    flushPendingWhiteboardChange(whiteboardStore);
    const standalone = {
      roomId,
      slides: snapshotSlidesStore(slidesStore),
      whiteboard: snapshotWhiteboardStore(whiteboardStore),
    };
    setIsCreatingRoom(false);
    assetHydrationGenerationRef.current += 1;
    standaloneStoresRef.current = standalone;
    setSlidesStoreDeckBorrowed(slidesStore, true);
    slidesStore.trigger.setSlides({ slides: [] });
    slidesStore.trigger.setPreviewState({
      previewState: {
        isOpen: false,
        isMaximized: false,
        currentSlideId: null,
        indexv: 0,
      },
    });
    whiteboardStore.trigger.setScene({ scene: structuredClone(EMPTY_WHITEBOARD_SCENE) });

    const providerGeneration = ++providerGenerationRef.current;
    const nextProvider = new CollaborationRoomProvider({
      roomId,
      api: collaborationApi,
      onDocumentChange: (doc, transaction) => {
        if (providerGenerationRef.current !== providerGeneration || playbackRef.current) return;
        try {
          const queuedTextEdit = pendingLocalTextEditRef.current;
          let projectedQueuedTextEdit = false;
          const teachingOnly =
            projectionRef.current !== null &&
            collaborationTransactionTouchesOnlyTeaching(doc, transaction);
          const projection = teachingOnly
            ? projectionRef.current!
            : projectCollaborationTransaction(
                doc,
                transaction,
                projectionRef.current,
                baseActionsRef.current,
                queuedTextEdit?.event,
                (content) => {
                  projectedQueuedTextEdit = true;
                  queuedTextEdit?.onProjected?.(content);
                },
              );
          projectionRef.current = projection;
          if (projectedQueuedTextEdit && pendingLocalTextEditRef.current === queuedTextEdit) {
            pendingLocalTextEditRef.current = null;
          }
          if (!teachingOnly) hydrateProjectionAssets(projection, roomId);
          if (collaborationTransactionTouchesTeaching(doc, transaction)) {
            projectTeachingState(doc, roomId);
          }
        } catch (error) {
          setLocalError(messageFromError(error, "The shared workspace could not be projected."));
        }
      },
      onAwarenessEvent: (event) => {
        if (providerGenerationRef.current === providerGeneration) applyAwarenessEvent(event);
      },
      onControlEvent: () => {
        if (providerGenerationRef.current !== providerGeneration) return;
        const session = providerRef.current?.session;
        if (session) {
          void refreshRoomDataFor(
            session.room.id,
            session.membership.role === "owner",
            providerGeneration,
          ).catch(() => {});
        }
      },
      onRejectedLocalChanges: (message) => {
        if (providerGenerationRef.current === providerGeneration) setLocalError(message);
      },
    });
    if (providerRef.current) stopProviderAfterBestEffortFlush(providerRef.current);
    providerRef.current = nextProvider;
    projectionRef.current = null;
    pendingLocalTextEditRef.current = null;
    assetFetchesRef.current.clear();
    awarenessCursorRef.current = null;
    awarenessSurfaceRef.current = { kind: "editor", fileNodeId: null, viewport: null };
    awarenessRevisionRef.current = 0;
    setMembers([]);
    setInvitations([]);
    setParticipantsBySession(new Map());
    stopFollowing("room-changed");
    setIsApplyingFollow(false);
    applyingFollowDepthRef.current = 0;
    if (applyingFollowReleaseTimerRef.current) {
      clearTimeout(applyingFollowReleaseTimerRef.current);
      applyingFollowReleaseTimerRef.current = null;
    }
    teachingProjectionRef.current = null;
    localWhiteboardProjectionFingerprintRef.current = null;
    appliedPresentationRevisionRef.current = null;
    teachingHydrationGenerationRef.current += 1;
    teachingHydrationKeyRef.current = null;
    teachingSlideCacheRef.current.clear();
    setTeaching(EMPTY_TEACHING_PROJECTION);
    setTeachingSlides(null);
    setIsTeachingLoading(true);
    setRetryableAssetError(null);
    setProvider(nextProvider);
    setLocalError(null);
    const subscription = nextProvider.subscribe(() => {
      setRuntimeVersion((version) => version + 1);
    });
    void nextProvider.start();

    return () => {
      subscription.unsubscribe();
      if (providerGenerationRef.current === providerGeneration) {
        providerGenerationRef.current += 1;
      }
      stopProviderAfterBestEffortFlush(nextProvider);
      if (providerRef.current === nextProvider) providerRef.current = null;
      assetHydrationGenerationRef.current += 1;
      teachingHydrationGenerationRef.current += 1;
      discardPendingWhiteboardChange(whiteboardStore);
      if (standaloneStoresRef.current === standalone) {
        restoreSlidesStore(slidesStore, standalone.slides);
        setSlidesStoreDeckBorrowed(slidesStore, false);
        restoreWhiteboardStore(whiteboardStore, standalone.whiteboard);
        standaloneStoresRef.current = null;
      }
    };
  }, [
    applyAwarenessEvent,
    hydrateProjectionAssets,
    inviteToken,
    projectTeachingState,
    refreshRoomDataFor,
    roomId,
    slidesStore,
    stopFollowing,
    whiteboardStore,
  ]);

  useEffect(() => {
    if (!provider) {
      undoManagerRef.current = null;
      return;
    }

    let manager: Y.UndoManager | null = null;
    const initializeUndoManager = () => {
      // The undo scope helper creates a missing Y.Map. Waiting for SYNCED
      // prevents that local map from racing the seeded map in bootstrap.
      if (manager || provider.connectionState !== "live") return;
      manager = createCollaborationUndoManager(provider.doc);
      undoManagerRef.current = manager;
    };
    const subscription = provider.subscribe(initializeUndoManager);
    initializeUndoManager();

    return () => {
      subscription.unsubscribe();
      if (undoManagerRef.current === manager) undoManagerRef.current = null;
      manager?.destroy();
    };
  }, [provider]);

  useLayoutEffect(() => {
    if (usesPlaybackModel || !provider) return;
    try {
      const projection = reprojectCollaborationWorkspace(provider.doc, baseActionsRef.current);
      projectionRef.current = projection;
      if (roomId) hydrateProjectionAssets(projection, roomId);
      if (roomId) projectTeachingState(provider.doc, roomId);
    } catch {
      // The initial snapshot may not have arrived yet; its transaction callback
      // performs this projection after synchronization.
    }
  }, [hydrateProjectionAssets, projectTeachingState, provider, roomId, usesPlaybackModel]);

  useEffect(() => {
    if (!provider || usesPlaybackModel || !teaching.initialized) return;
    if (teachingSlides) {
      const current = slidesStore.getSnapshot().context;
      const presentationRevisionChanged =
        appliedPresentationRevisionRef.current !== teaching.presentationRevision;
      appliedPresentationRevisionRef.current = teaching.presentationRevision;
      const sameSlides =
        current.slides.length === teachingSlides.length &&
        current.slides.every(
          (slide, index) =>
            slide.id === teachingSlides[index]?.id &&
            slide.content === teachingSlides[index]?.content,
        );
      if (!sameSlides) slidesStore.trigger.setSlides({ slides: teachingSlides });
      const currentSlideId = teaching.currentSlideId;
      const nextPreview = {
        ...current.previewState,
        currentSlideId,
        indexv:
          !presentationRevisionChanged && current.previewState.currentSlideId === currentSlideId
            ? (current.previewState.indexv ?? 0)
            : 0,
      };
      if (
        current.previewState.currentSlideId !== nextPreview.currentSlideId ||
        current.previewState.indexv !== nextPreview.indexv
      ) {
        slidesStore.trigger.setPreviewState({ previewState: nextPreview });
      }
    }

    const currentScene = whiteboardStore.getSnapshot().context.scene;
    const projectedWhiteboardFingerprint = JSON.stringify(teaching.whiteboardElements);
    const isLocalCanvasProjection =
      localWhiteboardProjectionFingerprintRef.current === projectedWhiteboardFingerprint;
    const sameElements =
      currentScene.elements.length === teaching.whiteboardElements.length &&
      currentScene.elements.every((element, index) => {
        const projected = teaching.whiteboardElements[index];
        return (
          element.id === projected?.id &&
          element.version === projected.version &&
          element.versionNonce === projected.versionNonce &&
          element.isDeleted === projected.isDeleted &&
          JSON.stringify(element) === JSON.stringify(projected)
        );
      });
    if (!sameElements) {
      whiteboardStore.trigger.setScene({
        scene: {
          ...currentScene,
          elements: teaching.whiteboardElements.map((element) => structuredClone(element)),
        },
        source: isLocalCanvasProjection ? "canvas" : "external",
      });
    }
    if (isLocalCanvasProjection) localWhiteboardProjectionFingerprintRef.current = null;
  }, [provider, slidesStore, teaching, teachingSlides, usesPlaybackModel, whiteboardStore]);

  // runtimeVersion intentionally makes actor snapshots reactive without
  // putting high-frequency Yjs document content in React state.
  void runtimeVersion;
  const machineSnapshot = provider?.actor.getSnapshot() ?? null;
  const connectionState = machineSnapshot
    ? collaborationConnectionState(machineSnapshot.value)
    : "disconnected";
  const session = provider?.session ?? null;
  const role = session?.membership.role ?? machineSnapshot?.context.role ?? null;
  const canWrite = Boolean(
    provider &&
    role &&
    canWriteCollaborationDocument(role) &&
    (connectionState === "live" || connectionState === "reconnecting") &&
    !usesPlaybackModel,
  );
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const controller = useMemo(
    () =>
      provider
        ? new CollaborationProjectController(provider.doc, {
            canWrite: () => canWriteRef.current,
            getProjection: getCurrentProjection,
          })
        : null,
    [getCurrentProjection, provider],
  );

  const reportWriteError = useCallback((error: unknown) => {
    setLocalError(messageFromError(error, "The shared workspace could not be changed."));
  }, []);

  const collaborativeActions = useMemo<WorkspaceActions>(() => {
    if (!controller) return baseActions;
    const run = (operation: () => void) => {
      try {
        operation();
        setLocalError(null);
      } catch (error) {
        reportWriteError(error);
      }
    };
    return {
      ...baseActions,
      createNewEditor: () =>
        reportWriteError(new Error("Leave the room before replacing the project.")),
      createFile: (path, content = "", encoding) => {
        if (encoding !== "asset") {
          if (typeof content !== "string") {
            reportWriteError(new Error("Text collaboration files require string content."));
            return;
          }
          run(() => controller.createFile(path, content));
          return;
        }
        if (!isWorkspaceAssetDescriptor(content)) {
          reportWriteError(new Error("Binary collaboration files require an asset descriptor."));
          return;
        }
        const currentProvider = providerRef.current;
        const currentSession = currentProvider?.session;
        if (!currentProvider || !currentSession || !canWriteRef.current) {
          reportWriteError(new Error("The collaboration room is not ready for asset uploads."));
          return;
        }
        void getWorkspaceAssetBytes(content)
          .then((bytes) =>
            uploadCollaborationAsset(currentSession.room.id, bytes, content.mimeType),
          )
          .then((asset) => {
            if (providerRef.current !== currentProvider || !canWriteRef.current) return;
            controller.createAssetFile(path, asset);
            setLocalError(null);
          })
          .catch(reportWriteError);
      },
      createFolder: (path) => run(() => controller.createFolder(path)),
      renameFile: (currentPath, nextPath) =>
        run(() => controller.renameFile(currentPath, nextPath)),
      renameFolder: (currentPath, nextPath) =>
        run(() => controller.renameFolder(currentPath, nextPath)),
      deleteFile: (path) => run(() => controller.deleteFile(path)),
      deleteFolder: (path) => run(() => controller.deleteFolder(path)),
      updateFileContent: (path, content) => run(() => controller.replaceFileContent(path, content)),
      applyFileTextEdits: (event) => {
        try {
          const currentFile = baseActions.getFile(event.path);
          const nextContent =
            currentFile && isWorkspaceTextFile(currentFile)
              ? applyTextEditEvent(currentFile.content, event)
              : null;
          if (nextContent === null) return null;
          queueLocalTextEdit(event);
          const applied = controller.applyFileTextEdits(event);
          setLocalError(null);
          return applied ? nextContent : null;
        } catch (error) {
          reportWriteError(error);
          return null;
        }
      },
      updateActiveFileContent: (content) =>
        run(() => controller.replaceFileContent(baseActions.getActiveFilePath(), content)),
      setPreviewFilePath: (path) => run(() => controller.setEntryFile(path)),
      updateLessonType: (lessonType) => run(() => controller.updateLessonType(lessonType)),
      loadProject: () =>
        reportWriteError(new Error("Leave the room before loading another project.")),
      reconcileExternalProject: (project) => {
        if (playbackRef.current) baseActions.reconcileExternalProject(project);
        else reportWriteError(new Error("Bulk project replacement is disabled in a live room."));
      },
    };
  }, [baseActions, controller, queueLocalTextEdit, reportWriteError]);

  const updateRoomParam = useCallback(
    (nextRoomId: string | null) => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete("invite");
        if (nextRoomId) next.set("room", nextRoomId);
        else next.delete("room");
        return next;
      });
    },
    [setSearchParams],
  );

  const joinRoom = useCallback(
    (nextRoomId: string) => {
      flushPendingWhiteboardChange(whiteboardStore);
      updateRoomParam(nextRoomId);
    },
    [updateRoomParam, whiteboardStore],
  );

  const publishTeachingInitialization = useCallback(
    async (
      targetRoomId: string,
      baseDoc: Y.Doc,
      slides: readonly Slide[],
      whiteboard: WhiteboardSceneState,
      clientId: string,
      preparedPlan?: CollaborationTeachingAssetPlan,
    ) => {
      const plan = preparedPlan ?? (await createCollaborationTeachingAssetPlan(slides));
      const uniqueAssets = Array.from(plan.assets.values());
      const totalPayloadBytes = uniqueAssets.reduce(
        (total, asset) => total + asset.payload.byteLength,
        0,
      );
      if (uniqueAssets.length > MAX_COLLABORATION_ROOM_ASSETS) {
        throw new Error("The room presentation contains too many slide assets.");
      }
      if (totalPayloadBytes > MAX_COLLABORATION_ROOM_ASSET_BYTES) {
        throw new Error("The room presentation exceeds the shared asset quota.");
      }

      const uploadedAssets = new Map<
        string,
        Awaited<ReturnType<typeof uploadCollaborationAsset>>
      >();
      for (const item of uniqueAssets) {
        const asset = await uploadCollaborationAsset(targetRoomId, item.payload, item.mimeType);
        if (asset.id !== item.id || asset.size !== item.payload.byteLength) {
          throw new Error("An uploaded teaching asset did not match its source payload.");
        }
        uploadedAssets.set(item.id, asset);
      }
      const uploaded = plan.items.map((item) => {
        const asset = uploadedAssets.get(item.assetId);
        if (!asset) throw new Error("An uploaded teaching asset is missing from the snapshot.");
        return { slide: item.slide, asset };
      });

      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(baseDoc));
        const stateVector = Y.encodeStateVector(candidate);
        seedCollaborationTeachingDocument(candidate, {
          slides: uploaded,
          whiteboardElements: whiteboard.elements,
        });
        const update = Y.encodeStateAsUpdate(candidate, stateVector);
        const initialization = createCollaborationTeachingInitialization(update, clientId);
        try {
          await initializeCollaborationTeachingSurfaces(targetRoomId, initialization);
        } catch (error) {
          // The endpoint is idempotent for this exact update. One bounded retry
          // covers a lost response without exposing a partially initialized room.
          if (!isRetryableTeachingInitializationError(error)) throw error;
          await initializeCollaborationTeachingSurfaces(targetRoomId, initialization);
        }
      } finally {
        candidate.destroy();
      }
    },
    [],
  );

  const performCreateRoom = useCallback(async () => {
    if (!isSignedIn) throw new Error("Sign in before starting a collaboration room.");
    flushPendingWhiteboardChange(whiteboardStore);
    const project = baseActionsRef.current.getProject();
    const standaloneSlides = snapshotSlidesStore(slidesStore).slides;
    const standaloneWhiteboard = snapshotWhiteboardStore(whiteboardStore);
    const teachingAssetPlan = await createCollaborationTeachingAssetPlan(standaloneSlides);
    const binaryFiles = Object.values(project.files)
      .filter(isWorkspaceAssetFile)
      .sort((left, right) => left.path.localeCompare(right.path));
    const uniqueWorkspaceAssets = new Map<string, { mimeType: string; size: number }>();
    for (const file of binaryFiles) {
      const existing = uniqueWorkspaceAssets.get(file.content.assetId);
      if (
        existing &&
        (existing.mimeType !== file.content.mimeType || existing.size !== file.content.size)
      ) {
        throw new Error("Duplicate workspace assets have conflicting metadata.");
      }
      uniqueWorkspaceAssets.set(file.content.assetId, {
        mimeType: file.content.mimeType,
        size: file.content.size,
      });
    }
    const prospectiveAssets = new Map(uniqueWorkspaceAssets);
    for (const asset of teachingAssetPlan.assets.values()) {
      const existing = prospectiveAssets.get(asset.id);
      if (
        existing &&
        (existing.mimeType !== asset.mimeType || existing.size !== asset.payload.byteLength)
      ) {
        throw new Error("Workspace and teaching assets have conflicting digest metadata.");
      }
      prospectiveAssets.set(asset.id, {
        mimeType: asset.mimeType,
        size: asset.payload.byteLength,
      });
    }
    const prospectiveAssetCount = prospectiveAssets.size;
    const prospectiveAssetBytes = Array.from(prospectiveAssets.values()).reduce(
      (total, asset) => total + asset.size,
      0,
    );
    if (prospectiveAssetCount > MAX_COLLABORATION_ROOM_ASSETS) {
      throw new Error(`A live room can contain at most ${MAX_COLLABORATION_ROOM_ASSETS} assets.`);
    }
    if (prospectiveAssetBytes > MAX_COLLABORATION_ROOM_ASSET_BYTES) {
      throw new Error("The project and presentation exceed the live room asset quota.");
    }
    const doc = new Y.Doc();
    seedCollaborationProject(doc, project);
    const clientId = crypto.randomUUID();
    let created: CollaborationRoomSession;
    try {
      created = await createCollaborationRoom(createCollaborationRoomSnapshot(doc, clientId));
    } catch (error) {
      doc.destroy();
      throw error;
    }
    try {
      const uploadedWorkspaceAssetIds = new Set<string>();
      for (const file of binaryFiles) {
        if (uploadedWorkspaceAssetIds.has(file.content.assetId)) continue;
        const bytes = await getWorkspaceAssetBytes(file.content);
        const asset = await uploadCollaborationAsset(created.room.id, bytes, file.content.mimeType);
        if (
          asset.id !== file.content.assetId ||
          asset.mimeType !== file.content.mimeType ||
          asset.size !== file.content.size
        ) {
          throw new Error(`Uploaded collaboration asset did not match ${file.path}`);
        }
        uploadedWorkspaceAssetIds.add(asset.id);
      }
      await publishTeachingInitialization(
        created.room.id,
        doc,
        standaloneSlides,
        standaloneWhiteboard,
        clientId,
        teachingAssetPlan,
      );
      updateRoomParam(created.room.id);
      return created;
    } catch (error) {
      await closeCollaborationRoom(created.room.id).catch(() => {});
      throw error;
    } finally {
      doc.destroy();
    }
  }, [isSignedIn, publishTeachingInitialization, slidesStore, updateRoomParam, whiteboardStore]);

  const createRoom = useCallback(async () => {
    setIsCreatingRoom(true);
    try {
      return await performCreateRoom();
    } catch (error) {
      setIsCreatingRoom(false);
      throw error;
    }
  }, [performCreateRoom]);

  const initializeTeachingSurfaces = useCallback(async () => {
    const current = providerRef.current;
    const currentSession = current?.session;
    const standalone = standaloneStoresRef.current;
    if (!current || !currentSession || currentSession.membership.role !== "owner") {
      throw new Error("Only the room owner can initialize teaching surfaces.");
    }
    if (!standalone || standalone.roomId !== currentSession.room.id) {
      throw new Error("The standalone teaching surfaces are unavailable.");
    }
    if (isCollaborationTeachingInitialized(current.doc)) {
      throw new Error("The room teaching surfaces are already initialized.");
    }
    await publishTeachingInitialization(
      currentSession.room.id,
      current.doc,
      standalone.slides.slides,
      standalone.whiteboard,
      current.clientId,
    );
  }, [publishTeachingInitialization]);

  const flushCurrentEdits = useCallback(async (current: CollaborationRoomProvider) => {
    await current.flushNow();
    if (!current.hasPendingUpdates) return;
    const message = "Wait for offline collaboration changes to synchronize before continuing.";
    setLocalError(message);
    throw new Error(message);
  }, []);

  const leaveRoom = useCallback(async () => {
    flushPendingWhiteboardChange(whiteboardStore);
    stopFollowing("room-changed");
    const current = providerRef.current;
    if (current) {
      await flushCurrentEdits(current);
      await current
        .publishAwareness({
          kind: "leave",
          sessionId: current.awarenessSessionId,
          revision: ++awarenessRevisionRef.current,
        })
        .catch(() => {});
      current.stop();
    }
    setLocalError(null);
    updateRoomParam(null);
  }, [flushCurrentEdits, stopFollowing, updateRoomParam, whiteboardStore]);

  const retry = useCallback(async () => {
    setLocalError(null);
    await providerRef.current?.retryNow();
  }, []);

  const retryAssets = useCallback(() => {
    const current = providerRef.current;
    const projection = projectionRef.current;
    const targetRoomId = current?.session?.room.id;
    if (!projection || !targetRoomId) return;
    setRetryableAssetError(null);
    setLocalError(null);
    hydrateProjectionAssets(projection, targetRoomId);
    teachingSlideCacheRef.current.clear();
    teachingHydrationKeyRef.current = null;
    projectTeachingState(current.doc, targetRoomId);
  }, [hydrateProjectionAssets, projectTeachingState]);

  const undo = useCallback(() => {
    if (!canWriteRef.current) return;
    undoManagerRef.current?.stopCapturing();
    undoManagerRef.current?.undo();
  }, []);

  const redo = useCallback(() => {
    if (!canWriteRef.current) return;
    undoManagerRef.current?.redo();
  }, []);

  const closeRoom = useCallback(async () => {
    flushPendingWhiteboardChange(whiteboardStore);
    stopFollowing("room-changed");
    const current = providerRef.current;
    if (!current) return;
    const blockReason = liveRoomEndBlockReason(isRecording, false);
    if (blockReason) {
      const message = blockReason;
      setLocalError(message);
      throw new Error(message);
    }
    await flushCurrentEdits(current);
    await closeCollaborationRoom(current.session?.room.id ?? roomId ?? "");
    current.stop();
    updateRoomParam(null);
  }, [flushCurrentEdits, isRecording, roomId, stopFollowing, updateRoomParam, whiteboardStore]);

  const publishAwarenessState = useCallback(async () => {
    const current = providerRef.current;
    const currentSession = current?.session;
    if (!current || !currentSession || current.connectionState !== "live") return;
    const activeFileNodeId = getNodeIdForPath(activeFilePathRef.current);
    const currentSurface = awarenessSurfaceRef.current;
    const surface: CollaborationSurface =
      currentSurface.kind === "editor"
        ? {
            kind: "editor",
            fileNodeId: activeFileNodeId,
            viewport:
              currentSurface.fileNodeId === activeFileNodeId ? currentSurface.viewport : null,
          }
        : currentSurface;
    awarenessSurfaceRef.current = surface;
    if (surface.kind !== "editor" || awarenessCursorRef.current?.fileNodeId !== activeFileNodeId) {
      awarenessCursorRef.current = null;
    }
    const revision = ++awarenessRevisionRef.current;
    await current.publishAwareness({
      kind: "state",
      sessionId: current.awarenessSessionId,
      revision,
      surface,
      cursor: awarenessCursorRef.current,
    });
    if (!user) return;
    const now = Date.now();
    applyAwarenessEvent({
      kind: "state",
      roomId: currentSession.room.id,
      actorId: user.id,
      sessionId: current.awarenessSessionId,
      revision,
      role: currentSession.membership.role,
      username: user.username,
      name: user.name,
      avatarUrl: user.avatarUrl,
      isHost: currentSession.room.hostUserId === user.id,
      surface,
      cursor: awarenessCursorRef.current,
      occurredAt: now,
      expiresAt: now + COLLABORATION_AWARENESS_TTL_MS,
    });
  }, [applyAwarenessEvent, getNodeIdForPath, user]);

  const scheduleAwarenessPublish = useCallback(
    (delay = 75) => {
      awarenessPublishTimerRef.current = scheduleCollaborationAwarenessFlush(
        awarenessPublishTimerRef.current,
        () => {
          awarenessPublishTimerRef.current = null;
          void publishAwarenessState().catch(() => {});
        },
        delay,
      );
    },
    [publishAwarenessState],
  );

  const publishSurface = useCallback(
    (surface: CollaborationSurface) => {
      if (
        playbackRef.current ||
        followedSessionIdRef.current ||
        applyingFollowDepthRef.current > 0
      ) {
        return;
      }
      const previous = awarenessSurfaceRef.current;
      const nextSurface =
        surface.kind === "editor" &&
        !surface.viewport &&
        previous.kind === "editor" &&
        previous.fileNodeId === surface.fileNodeId
          ? { ...surface, viewport: previous.viewport }
          : surface;
      if (areCollaborationSurfacesEqual(previous, nextSurface)) return;
      awarenessSurfaceRef.current = nextSurface;
      if (nextSurface.kind !== "editor") awarenessCursorRef.current = null;
      scheduleAwarenessPublish();
    },
    [scheduleAwarenessPublish],
  );

  const followParticipant = useCallback(
    (sessionId: string) => {
      const current = providerRef.current;
      if (!current || current.awarenessSessionId === sessionId) return;
      const participant = Array.from(participantsBySession.values()).find(
        (candidate) => candidate.sessionId === sessionId && candidate.expiresAt > Date.now(),
      );
      if (!participant) return;
      if (followedSessionIdRef.current === sessionId) {
        stopFollowing("user");
        return;
      }
      if (followedSessionIdRef.current) stopFollowing("user");
      followedSessionIdRef.current = sessionId;
      current.setAwarenessPublicationSuppressed(true);
      setFollowedSessionId(sessionId);
      posthog?.capture("collaboration_follow_started");
    },
    [participantsBySession, posthog, stopFollowing],
  );

  const runFollowApplication = useCallback((application: () => void) => {
    if (applyingFollowReleaseTimerRef.current) {
      clearTimeout(applyingFollowReleaseTimerRef.current);
      applyingFollowReleaseTimerRef.current = null;
    }
    applyingFollowDepthRef.current += 1;
    providerRef.current?.setAwarenessPublicationSuppressed(true);
    setIsApplyingFollow(true);
    try {
      application();
    } finally {
      // Keep awareness publication suppressed through the React commit and
      // imperative widget callbacks caused by the application.
      if (applyingFollowReleaseTimerRef.current) {
        clearTimeout(applyingFollowReleaseTimerRef.current);
      }
      applyingFollowReleaseTimerRef.current = setTimeout(() => {
        applyingFollowReleaseTimerRef.current = null;
        applyingFollowDepthRef.current = 0;
        providerRef.current?.setAwarenessPublicationSuppressed(
          followedSessionIdRef.current !== null,
        );
        setIsApplyingFollow(false);
      }, 0);
    }
  }, []);

  useEffect(
    () => () => {
      if (applyingFollowReleaseTimerRef.current) {
        clearTimeout(applyingFollowReleaseTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!provider || connectionState !== "live" || !session) return;
    let cancelled = false;
    const providerGeneration = providerGenerationRef.current;
    void refreshRoomDataFor(session.room.id, role === "owner", providerGeneration)
      .then(() => {
        if (cancelled) return;
        void publishAwarenessState().catch(() => {});
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLocalError(messageFromError(error, "Room presence could not be loaded."));
        }
      });
    const heartbeat = setInterval(() => {
      void publishAwarenessState().catch(() => {});
    }, 15_000);
    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      if (awarenessPublishTimerRef.current) clearTimeout(awarenessPublishTimerRef.current);
      awarenessPublishTimerRef.current = null;
      void provider
        .publishAwareness({
          kind: "leave",
          sessionId: provider.awarenessSessionId,
          revision: ++awarenessRevisionRef.current,
        })
        .catch(() => {});
    };
  }, [connectionState, provider, publishAwarenessState, refreshRoomDataFor, role, session]);

  useEffect(() => {
    scheduleAwarenessPublish();
  }, [activeFilePath, scheduleAwarenessPublish]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setParticipantsBySession((current) => {
        const next = new Map(current);
        let changed = false;
        for (const [key, participant] of next) {
          if (
            participant.expiresAt <= now &&
            !(
              participant.sessionId === followedSessionIdRef.current &&
              isCollaborationFollowSuspendedConnectionState(providerRef.current?.connectionState)
            )
          ) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }, 5_000);
    return () => clearInterval(interval);
  }, []);

  const participants = useMemo(
    () =>
      Array.from(participantsBySession.values()).sort(
        (left, right) =>
          Number(right.isHost) - Number(left.isHost) ||
          (left.name ?? left.username).localeCompare(right.name ?? right.username),
      ),
    [participantsBySession],
  );

  const followedParticipant = useMemo(() => {
    if (!followedSessionId) return null;
    const participant = participants.find((candidate) => candidate.sessionId === followedSessionId);
    if (!participant) return null;
    if (participant.expiresAt > Date.now()) return participant;
    return connectionState === "reconnecting" ||
      connectionState === "connecting" ||
      connectionState === "syncing"
      ? participant
      : null;
  }, [connectionState, followedSessionId, participants]);
  const followAvailability = useMemo(
    () =>
      getCollaborationFollowAvailability({
        followedSessionId,
        ownSessionId: provider?.awarenessSessionId ?? null,
        connectionState,
        participantSessionIds: new Set(
          participants
            .filter((participant) => participant.expiresAt > Date.now())
            .map((participant) => participant.sessionId),
        ),
      }),
    [connectionState, followedSessionId, participants, provider],
  );

  useEffect(() => {
    const surfaceKind = followedParticipant?.surface.kind ?? null;
    if (!surfaceKind) {
      followedSurfaceKindRef.current = null;
      return;
    }
    if (followedSurfaceKindRef.current === surfaceKind) return;
    followedSurfaceKindRef.current = surfaceKind;
    posthog?.capture("collaboration_follow_surface_changed", { surface: surfaceKind });
  }, [followedParticipant?.surface.kind, posthog]);

  useEffect(() => {
    if (followAvailability === "missing") stopFollowing("target-left");
  }, [followAvailability, stopFollowing]);

  useEffect(() => {
    if (usesPlaybackModel) stopFollowing("playback");
  }, [stopFollowing, usesPlaybackModel]);

  useEffect(() => {
    if (!followedSessionId) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      stopFollowing("user");
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [followedSessionId, stopFollowing]);

  const refreshRoomData = useCallback(async () => {
    const current = providerRef.current?.session;
    if (!current) return;
    await refreshRoomDataFor(
      current.room.id,
      current.membership.role === "owner",
      providerGenerationRef.current,
    );
  }, [refreshRoomDataFor]);

  const exportRoom = useCallback(async () => {
    const currentProvider = providerRef.current;
    const current = currentProvider?.session;
    if (!currentProvider || !current || current.membership.role !== "owner") {
      throw new Error("Only the room owner can export a recovery snapshot.");
    }
    await flushCurrentEdits(currentProvider);
    return exportCollaborationRoom(current.room.id);
  }, [flushCurrentEdits]);

  const createInvitation = useCallback(async (inviteRole: CollaborationInviteRole) => {
    const current = providerRef.current?.session;
    if (!current || current.membership.role !== "owner") {
      throw new Error("Only the room owner can create invitations.");
    }
    const invitation = await createCollaborationInvitation(current.room.id, {
      role: inviteRole,
    });
    setInvitations((existing) => [invitation, ...existing]);
    return invitation;
  }, []);

  const revokeInvitation = useCallback(async (invitationId: string) => {
    const current = providerRef.current?.session;
    if (!current) return;
    await revokeCollaborationInvitation(current.room.id, invitationId);
    setInvitations((existing) => existing.filter((item) => item.id !== invitationId));
  }, []);

  const updateMemberRole = useCallback(
    async (userId: string, nextRole: CollaborationInviteRole) => {
      const currentProvider = providerRef.current;
      const current = currentProvider?.session;
      if (!currentProvider || !current) return;
      await flushCurrentEdits(currentProvider);
      const member = await updateCollaborationMemberRole(current.room.id, userId, nextRole);
      setMembers((existing) =>
        existing.map((item) => (item.userId === member.userId ? member : item)),
      );
    },
    [flushCurrentEdits],
  );

  const removeMember = useCallback(
    async (userId: string) => {
      const currentProvider = providerRef.current;
      const current = currentProvider?.session;
      if (!currentProvider || !current) return;
      await flushCurrentEdits(currentProvider);
      await removeCollaborationMember(current.room.id, userId);
      setMembers((existing) => existing.filter((item) => item.userId !== userId));
    },
    [flushCurrentEdits],
  );

  const updateCursor = useCallback(
    (path: string, anchorOffset: number, headOffset: number) => {
      const current = providerRef.current;
      if (!current || current.connectionState !== "live" || followedSessionIdRef.current) return;
      const fileNodeId = getNodeIdForPath(path);
      awarenessCursorRef.current = fileNodeId
        ? createCollaborationCursor(current.doc, fileNodeId, anchorOffset, headOffset)
        : null;
      if (awarenessSurfaceRef.current.kind === "editor") {
        awarenessSurfaceRef.current = {
          ...awarenessSurfaceRef.current,
          fileNodeId,
          viewport:
            awarenessSurfaceRef.current.fileNodeId === fileNodeId
              ? awarenessSurfaceRef.current.viewport
              : null,
        };
      }
      scheduleAwarenessPublish();
    },
    [getNodeIdForPath, scheduleAwarenessPublish],
  );

  const publishCurrentSlide = useCallback((slideId: string) => {
    const current = providerRef.current;
    if (!current || !canWriteRef.current || playbackRef.current) return false;
    try {
      setCollaborationCurrentSlide(current.doc, slideId);
      setLocalError(null);
      return projectCollaborationTeachingDocument(current.doc).currentSlideId === slideId;
    } catch (error) {
      setLocalError(messageFromError(error, "The shared slide could not be changed."));
      return false;
    }
  }, []);

  const publishWhiteboardDelta = useCallback(
    (event: Pick<WhiteboardEvent, "upserts" | "removedIds">) => {
      const current = providerRef.current;
      if (!current || !canWriteRef.current || playbackRef.current) return false;
      if (!(event.upserts?.length || event.removedIds?.length)) return true;
      try {
        const next = applyCollaborationWhiteboardDelta(current.doc, event);
        // projectTeachingState runs synchronously inside the Yjs transaction,
        // while React applies its projection effect after this callback. Tag
        // that exact authoritative result so normalization cannot make this
        // local canvas echo look like a remote scene update.
        localWhiteboardProjectionFingerprintRef.current = JSON.stringify(next);
        const nextById = new Map(next.map((element) => [element.id, element] as const));
        const matchesRequestedDelta =
          (event.upserts ?? []).every((element) => {
            const projected = nextById.get(element.id);
            return projected !== undefined && JSON.stringify(projected) === JSON.stringify(element);
          }) && (event.removedIds ?? []).every((id) => !nextById.has(id));
        setLocalError(null);
        return matchesRequestedDelta;
      } catch (error) {
        setLocalError(messageFromError(error, "The whiteboard change could not be shared."));
        return false;
      }
    },
    [],
  );

  const value = useMemo<CollaborationContextValue>(
    () => ({
      provider,
      doc: provider?.doc ?? null,
      session,
      connectionState,
      role,
      isHost: Boolean(user && session?.room.hostUserId === user.id),
      canWrite,
      isCreatingRoom,
      hasOfflineChanges: machineSnapshot?.context.hasOfflineChanges ?? false,
      members,
      invitations,
      participants,
      followedSessionId,
      followedParticipant,
      isApplyingFollow,
      teaching,
      teachingSlides,
      isTeachingLoading,
      canRetryAssets,
      error: localError ?? machineSnapshot?.context.error ?? null,
      pendingInviteToken,
      isAcceptingInvitation,
      acceptInvitation,
      declineInvitation,
      createRoom,
      joinRoom,
      leaveRoom,
      retry,
      closeRoom,
      exportRoom,
      refreshRoomData,
      createInvitation,
      revokeInvitation,
      updateMemberRole,
      removeMember,
      followParticipant,
      stopFollowing,
      publishSurface,
      runFollowApplication,
      initializeTeachingSurfaces,
      publishCurrentSlide,
      publishWhiteboardDelta,
      updateCursor,
      queueLocalTextEdit,
      getNodeIdForPath,
      getPathForNodeId,
      retryAssets,
      undo,
      redo,
      clearError: () => {
        setRetryableAssetError(null);
        setLocalError(null);
      },
    }),
    [
      canWrite,
      canRetryAssets,
      closeRoom,
      connectionState,
      createInvitation,
      createRoom,
      pendingInviteToken,
      isAcceptingInvitation,
      acceptInvitation,
      declineInvitation,
      exportRoom,
      getNodeIdForPath,
      getPathForNodeId,
      invitations,
      followedParticipant,
      followedSessionId,
      followParticipant,
      initializeTeachingSurfaces,
      isApplyingFollow,
      isCreatingRoom,
      isTeachingLoading,
      joinRoom,
      leaveRoom,
      localError,
      members,
      machineSnapshot?.context.error,
      machineSnapshot?.context.hasOfflineChanges,
      participants,
      publishCurrentSlide,
      publishSurface,
      publishWhiteboardDelta,
      provider,
      queueLocalTextEdit,
      refreshRoomData,
      redo,
      removeMember,
      revokeInvitation,
      retry,
      retryAssets,
      role,
      runFollowApplication,
      session,
      stopFollowing,
      teaching,
      teachingSlides,
      updateCursor,
      updateMemberRole,
      undo,
      user,
    ],
  );

  return (
    <CollaborationContext value={value}>
      <WorkspaceActionsContext value={collaborativeActions}>{children}</WorkspaceActionsContext>
    </CollaborationContext>
  );
}

export function useCollaboration(): CollaborationContextValue {
  const context = useContext(CollaborationContext);
  if (!context) throw new Error("useCollaboration must be used within a CollaborationProvider");
  return context;
}

export function useOptionalCollaboration(): CollaborationContextValue | null {
  return useContext(CollaborationContext);
}
