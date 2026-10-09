import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router";
import * as Y from "yjs";
import {
  closeCollaborationRoom,
  downloadCollaborationAsset,
  exportCollaborationRoom,
  getCollaborationRoom,
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
  canPublishCollaborationUpdate,
} from "../collaboration/protocol";
import {
  projectCollaborationDocument,
  type CollaborationProjectProjection,
} from "../collaboration/projectDocument";
import {
  createCollaborationRoomFromWorkspace,
  publishCollaborationTeachingInitialization,
} from "../collaboration/roomSetup";
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
import { collaborationParticipantKey } from "../collaboration/participantKey";
import { analytics } from "../utils/analytics";
import { areCollaborationSurfacesEqual, editorSurfaceOn } from "../collaboration/awarenessSurface";
import { messageFromError } from "../collaboration/errorMessage";
import { stopProviderAfterBestEffortFlush } from "../collaboration/providerShutdown";
import {
  projectCollaborationTransaction,
  reprojectCollaborationWorkspace,
} from "../collaboration/workspaceAdapter";
import { WorkspaceActionsContext } from "./WorkspaceContext";
import { useCollaborationInvitation } from "./collaboration/useCollaborationInvitation";
import { useCollaborationRoster } from "./collaboration/useCollaborationRoster";
import { useCollaborativeWorkspaceActions } from "./collaboration/useCollaborativeWorkspaceActions";
import { WebContainerRuntimeActionsContext } from "./WebContainerRuntimeContext";
import type { TextEditEvent } from "../types/textEdit";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { useWorkspaceActions, useWorkspaceActiveFilePath } from "../hooks/useWorkspace";
import { createCollaborationCursor } from "../collaboration/relativePosition";
import { liveRoomEndBlockReason } from "../collaboration/recordingPolicy";
import { getWorkspaceAssetBlob, registerWorkspaceAsset } from "../storage/workspaceAssetStore";
import { createCollaborationUndoManager } from "../collaboration/undo";
import {
  applyCollaborationWhiteboardDelta,
  collaborationTransactionTouchesOnlyTeaching,
  collaborationTransactionTouchesTeaching,
  hydrateCollaborationSlideManifest,
  isCollaborationTeachingInitialized,
  projectCollaborationTeachingDocument,
  setCollaborationCurrentSlide,
  type CollaborationTeachingProjection,
} from "../collaboration/teachingDocument";
import {
  applyTeachingSlides,
  applyTeachingWhiteboard,
  borrowStandaloneTeachingStores,
  isSameTeachingProjection,
  recordCanonicalTeachingChange,
  teachingHydrationKey,
  type StandaloneTeachingStores,
} from "../collaboration/teachingStoreSync";
import { useSlidesStore } from "./SlidesStoreContext";
import { useWhiteboardStore } from "./WhiteboardStoreContext";
import {
  discardPendingWhiteboardChange,
  flushPendingWhiteboardChange,
} from "../hooks/useWhiteboardController";
import { snapshotSlidesStore } from "../stores/slidesStore";
import { snapshotWhiteboardStore } from "../stores/whiteboardStore";
import type { Slide } from "../types/slides";
import type { WhiteboardEvent } from "../core/src/whiteboard";

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
  /** This tab's own participant's collaborationParticipantKey; null without a room or user. */
  ownParticipantKey: string | null;
  followedParticipantKey: string | null;
  followedParticipant: CollaborationParticipant | null;
  /**
   * Bumps once when a follow ended during a follow application's release
   * window, where publishSurface still bails; the surface bridge republishes on it.
   */
  surfaceRepublishVersion: number;
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
  followParticipant: (participant: Pick<CollaborationParticipant, "actorId" | "sessionId">) => void;
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

export function CollaborationProvider({ children }: { children: ReactNode }) {
  const baseActions = useWorkspaceActions();
  // Null where no runtime is mounted, as in tests of this provider alone.
  const runtimeActions = useContext(WebContainerRuntimeActionsContext);
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
  const projectionRef = useRef<CollaborationProjectProjection | null>(null);
  const pendingLocalTextEditRef = useRef<{
    event: TextEditEvent;
    onProjected?: (content: string | null) => void;
  } | null>(null);
  const assetFetchesRef = useRef(new Set<string>());
  const assetHydrationGenerationRef = useRef(0);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  // Bumped by `retry` to rebuild the room's provider and document from scratch.
  const [providerEpoch, setProviderEpoch] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [retryableAssetError, setRetryableAssetError] = useState<string | null>(null);
  const canRetryAssets = localError !== null && localError === retryableAssetError;
  const [participantsBySession, setParticipantsBySession] = useState(
    () => new Map<string, CollaborationParticipant>(),
  );
  const [followedParticipantKey, setFollowedParticipantKey] = useState<string | null>(null);
  const followedParticipantKeyRef = useRef<string | null>(null);
  const followedSurfaceKindRef = useRef<CollaborationSurface["kind"] | null>(null);
  followedParticipantKeyRef.current = followedParticipantKey;
  // The key of the participant publishAwarenessState adds for this tab.
  const ownParticipantKey =
    user && provider
      ? collaborationParticipantKey({ actorId: user.id, sessionId: provider.awarenessSessionId })
      : null;
  const applyingFollowDepthRef = useRef(0);
  const applyingFollowReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedDuringFollowApplicationRef = useRef(false);
  const [surfaceRepublishVersion, setSurfaceRepublishVersion] = useState(0);
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
  const standaloneStoresRef = useRef<({ roomId: string } & StandaloneTeachingStores) | null>(null);
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
    if (!followedParticipantKeyRef.current) return;
    followedParticipantKeyRef.current = null;
    followedSurfaceKindRef.current = null;
    // publishSurface bails until the application's release timer lifts the
    // suppression, so that timer asks the surface bridge to republish.
    if (applyingFollowDepthRef.current > 0) stoppedDuringFollowApplicationRef.current = true;
    providerRef.current?.setAwarenessPublicationSuppressed(applyingFollowDepthRef.current > 0);
    setFollowedParticipantKey(null);
    analytics.capture("collaboration_follow_stopped", { reason });
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
      // A teaching transaction that changes nothing shown (a peer's candidate
      // that loses, a re-projection) must not replace the context value and
      // re-render every collaboration consumer.
      if (!previous || !isSameTeachingProjection(previous, projection)) setTeaching(projection);

      const currentProvider = providerRef.current;
      const currentUser = userRef.current;
      recordCanonicalTeachingChange(
        previous,
        projection,
        Boolean(
          isRecordingRef.current &&
          currentProvider?.session &&
          currentUser &&
          currentProvider.session.room.hostUserId === currentUser.id,
        ),
        { handleSlideEvent, handleWhiteboardEvent },
      );

      const hydrationKey = teachingHydrationKey(targetRoomId, projection);
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
  // The provider's callbacks and the projection effect below read the latest
  // projector through an Effect Event, so a new recorder callback identity does
  // not re-run the effect that owns the room's WebSocket.
  const projectTeachingStateFromEffect = useEffectEvent((doc: Y.Doc, targetRoomId: string) =>
    projectTeachingState(doc, targetRoomId),
  );

  const applyAwarenessEvent = useCallback((event: CollaborationAwarenessEvent) => {
    setParticipantsBySession((current) => applyCollaborationParticipantEvent(current, event));
  }, []);

  const flushCurrentEdits = useCallback(async (current: CollaborationRoomProvider) => {
    // A failed provider never drains its outbox again (the room closed, access
    // was revoked, the room rejected an update as invalid, or reconnects ran
    // out until an explicit retry), so waiting for it would block leaving,
    // closing, exporting and member changes indefinitely. Go ahead without the
    // unsent edits rather than asking: the panel already shows them as
    // "changes waiting" beside "Retry connection", which, once reconnects have
    // run out, is the one action that can still deliver them. Going ahead
    // leaves them out of an export. Leaving or closing discards unsent
    // whiteboard and slide edits along with the room's teaching state, and
    // keeps unsent file edits only in this tab's unsaved workspace until the
    // next room join reprojects over it.
    if (current.connectionState === "failed") return;
    await current.flushNow();
    if (!current.hasPendingUpdates) return;
    const message = "Wait for offline collaboration changes to synchronize before continuing.";
    setLocalError(message);
    throw new Error(message);
  }, []);

  const {
    members,
    invitations,
    refreshRoomDataFor,
    refreshRoomData,
    createInvitation,
    revokeInvitation,
    updateMemberRole,
    removeMember,
    resetRoster,
  } = useCollaborationRoster(providerRef, providerGenerationRef, flushCurrentEdits);

  const { pendingInviteToken, isAcceptingInvitation, acceptInvitation, declineInvitation } =
    useCollaborationInvitation({
      inviteToken,
      isAuthLoading,
      isSignedIn,
      setSearchParams,
      setError: setLocalError,
    });

  // Clears everything that belongs to one room. The room effect runs it on
  // every switch, into a room or out of one; the previous provider itself is
  // stopped by that effect's cleanup.
  const resetRoomScopedState = useCallback(() => {
    if (applyingFollowReleaseTimerRef.current) {
      clearTimeout(applyingFollowReleaseTimerRef.current);
      applyingFollowReleaseTimerRef.current = null;
    }
    applyingFollowDepthRef.current = 0;
    stoppedDuringFollowApplicationRef.current = false;
    stopFollowing("room-changed");
    setParticipantsBySession(new Map());
    resetRoster();
    awarenessCursorRef.current = null;
    awarenessSurfaceRef.current = { kind: "editor", fileNodeId: null, viewport: null };
    awarenessRevisionRef.current = 0;
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
    setRetryableAssetError(null);
  }, [resetRoster, stopFollowing]);

  useEffect(() => {
    if (!roomId || inviteToken) {
      providerGenerationRef.current += 1;
      resetRoomScopedState();
      setIsTeachingLoading(false);
      setProvider(null);
      return;
    }

    flushPendingWhiteboardChange(whiteboardStore);
    setIsCreatingRoom(false);
    const borrowedStores = borrowStandaloneTeachingStores(slidesStore, whiteboardStore);
    const standalone = { roomId, ...borrowedStores.snapshot };
    standaloneStoresRef.current = standalone;

    const providerGeneration = ++providerGenerationRef.current;
    // A whiteboard delta writes one transaction per element so every update
    // stays under the room limit. Projecting the whole teaching tree (which
    // re-validates every element) after each of them made one delta cost
    // O(changed × board); project once after the current task's transactions.
    let isTeachingProjectionScheduled = false;
    const scheduleTeachingProjection = (doc: Y.Doc) => {
      if (isTeachingProjectionScheduled) return;
      isTeachingProjectionScheduled = true;
      queueMicrotask(() => {
        isTeachingProjectionScheduled = false;
        if (providerGenerationRef.current !== providerGeneration || playbackRef.current) return;
        try {
          projectTeachingStateFromEffect(doc, roomId);
        } catch (error) {
          setLocalError(
            messageFromError(error, "The shared teaching surfaces could not be projected."),
          );
        }
      });
    };
    const nextProvider = new CollaborationRoomProvider({
      roomId,
      api: collaborationApi,
      onDocumentChange: (doc, transaction) => {
        if (providerGenerationRef.current !== providerGeneration || playbackRef.current) return;
        try {
          const queuedTextEdit = pendingLocalTextEditRef.current;
          let projectedQueuedTextEdit = false;
          const previousProjection = projectionRef.current;
          const teachingOnly =
            previousProjection !== null &&
            collaborationTransactionTouchesOnlyTeaching(doc, transaction);
          const projection = teachingOnly
            ? previousProjection
            : projectCollaborationTransaction(
                doc,
                transaction,
                previousProjection,
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
          // Asset descriptors live on tree nodes, so only a reprojection (a new
          // projection object) can add or change one. Text edits keep the old
          // projection, and hydrating on them re-notified every asset, forcing
          // a whole-project runtime sync per keystroke.
          if (projection !== previousProjection) hydrateProjectionAssets(projection, roomId);
          if (collaborationTransactionTouchesTeaching(doc, transaction)) {
            scheduleTeachingProjection(doc);
          }
        } catch (error) {
          setLocalError(messageFromError(error, "The shared workspace could not be projected."));
        }
      },
      onAwarenessEvent: (event) => {
        if (providerGenerationRef.current !== providerGeneration) return;
        // The room stamps expiresAt with its own clock, and every expiry check
        // here uses this browser's, so restart the TTL on receipt.
        applyAwarenessEvent(
          event.kind === "state"
            ? { ...event, expiresAt: Date.now() + COLLABORATION_AWARENESS_TTL_MS }
            : event,
        );
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
    resetRoomScopedState();
    providerRef.current = nextProvider;
    setIsTeachingLoading(true);
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
        borrowedStores.restore();
        standaloneStoresRef.current = null;
      }
    };
  }, [
    applyAwarenessEvent,
    hydrateProjectionAssets,
    inviteToken,
    providerEpoch,
    refreshRoomDataFor,
    resetRoomScopedState,
    roomId,
    slidesStore,
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

  // The runtime's reverse sync is off while the room owns the workspace: the
  // room is the source of truth and the container only mirrors it, so files a
  // container process writes stay in this browser's container. Imported into
  // the projected store they would reach the host's recording, could not be
  // edited, and the next projection would delete them from the container.
  // Declared before the reprojection below so the guard is on before the
  // room's first projection.
  const liveRoomOwnsWorkspace = provider !== null && !usesPlaybackModel;
  useLayoutEffect(() => {
    if (!runtimeActions || !liveRoomOwnsWorkspace) return;
    runtimeActions.setReverseSyncEnabled(false);
    return () => runtimeActions.setReverseSyncEnabled(true);
  }, [liveRoomOwnsWorkspace, runtimeActions]);

  useLayoutEffect(() => {
    if (usesPlaybackModel || !provider) return;
    try {
      const projection = reprojectCollaborationWorkspace(provider.doc, baseActionsRef.current);
      projectionRef.current = projection;
      if (roomId) hydrateProjectionAssets(projection, roomId);
      if (roomId) projectTeachingStateFromEffect(provider.doc, roomId);
    } catch {
      // The initial snapshot may not have arrived yet; its transaction callback
      // performs this projection after synchronization.
    }
  }, [hydrateProjectionAssets, provider, roomId, usesPlaybackModel]);

  useEffect(() => {
    if (!provider || usesPlaybackModel || !teaching.initialized) return;
    if (teachingSlides) {
      const presentationRevisionChanged =
        appliedPresentationRevisionRef.current !== teaching.presentationRevision;
      appliedPresentationRevisionRef.current = teaching.presentationRevision;
      applyTeachingSlides(
        slidesStore,
        teachingSlides,
        teaching.currentSlideId,
        presentationRevisionChanged,
      );
    }
    const isLocalCanvasProjection = applyTeachingWhiteboard(
      whiteboardStore,
      teaching.whiteboardElements,
      localWhiteboardProjectionFingerprintRef.current,
    );
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
  const role = session?.membership.role ?? null;
  // Once synced, the provider queues local edits in every reconnect state
  // (reconnecting → connecting → syncing); before the first sync the workspace
  // still shows the pre-room project.
  const isConnectionWritable =
    connectionState === "live" ||
    (Boolean(provider?.hasSynced) &&
      connectionState !== "failed" &&
      connectionState !== "disconnected");
  const canWrite = Boolean(
    provider &&
    role &&
    canPublishCollaborationUpdate(role) &&
    isConnectionWritable &&
    !usesPlaybackModel,
  );
  const { canWriteRef, collaborativeActions } = useCollaborativeWorkspaceActions({
    baseActions,
    provider,
    providerRef,
    playbackRef,
    canWrite,
    getCurrentProjection,
    queueLocalTextEdit,
    setError: setLocalError,
  });

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

  const performCreateRoom = useCallback(async () => {
    if (!isSignedIn) throw new Error("Sign in before starting a collaboration room.");
    flushPendingWhiteboardChange(whiteboardStore);
    const created = await createCollaborationRoomFromWorkspace({
      project: baseActionsRef.current.getProject(),
      slides: snapshotSlidesStore(slidesStore).slides,
      whiteboard: snapshotWhiteboardStore(whiteboardStore),
    });
    updateRoomParam(created.room.id);
    return created;
  }, [isSignedIn, slidesStore, updateRoomParam, whiteboardStore]);

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
    await publishCollaborationTeachingInitialization(
      currentSession.room.id,
      current.doc,
      standalone.slides.slides,
      standalone.whiteboard,
      current.clientId,
    );
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
    const current = providerRef.current;
    if (!current) return;
    // Edits the room refused are still in this document and a reconnect would
    // keep showing them, so rebuild the provider and sync a fresh document.
    if (current.hasDivergedDocument) {
      setProviderEpoch((epoch) => epoch + 1);
      return;
    }
    await current.retryNow();
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
    const blockReason = liveRoomEndBlockReason(isRecording);
    if (blockReason) {
      setLocalError(blockReason);
      throw new Error(blockReason);
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
    const surface =
      currentSurface.kind === "editor"
        ? editorSurfaceOn(currentSurface, activeFileNodeId)
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
        followedParticipantKeyRef.current ||
        applyingFollowDepthRef.current > 0
      ) {
        return;
      }
      const previous = awarenessSurfaceRef.current;
      // An editor surface reported without a viewport keeps the one already
      // published for the same file.
      const nextSurface =
        surface.kind === "editor" && !surface.viewport && previous.kind === "editor"
          ? editorSurfaceOn(previous, surface.fileNodeId)
          : surface;
      if (areCollaborationSurfacesEqual(previous, nextSurface)) return;
      awarenessSurfaceRef.current = nextSurface;
      if (nextSurface.kind !== "editor") awarenessCursorRef.current = null;
      scheduleAwarenessPublish();
    },
    [scheduleAwarenessPublish],
  );

  const followParticipant = useCallback(
    (target: Pick<CollaborationParticipant, "actorId" | "sessionId">) => {
      const current = providerRef.current;
      const key = collaborationParticipantKey(target);
      if (!current || key === ownParticipantKey) return;
      const participant = participantsBySession.get(key);
      if (!participant || participant.expiresAt <= Date.now()) return;
      if (followedParticipantKeyRef.current === key) {
        stopFollowing("user");
        return;
      }
      if (followedParticipantKeyRef.current) stopFollowing("user");
      followedParticipantKeyRef.current = key;
      current.setAwarenessPublicationSuppressed(true);
      setFollowedParticipantKey(key);
      analytics.capture("collaboration_follow_started");
    },
    [ownParticipantKey, participantsBySession, stopFollowing],
  );

  const runFollowApplication = useCallback((application: () => void) => {
    if (applyingFollowReleaseTimerRef.current) {
      clearTimeout(applyingFollowReleaseTimerRef.current);
      applyingFollowReleaseTimerRef.current = null;
    }
    applyingFollowDepthRef.current += 1;
    providerRef.current?.setAwarenessPublicationSuppressed(true);
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
          followedParticipantKeyRef.current !== null,
        );
        if (stoppedDuringFollowApplicationRef.current) {
          stoppedDuringFollowApplicationRef.current = false;
          setSurfaceRepublishVersion((version) => version + 1);
        }
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

  // Keyed on the live room's id, not the session object: every membership change
  // in the room (an invitation claimed, a role changed, a member removed) makes
  // the provider store a fresh session, and re-running this effect would
  // broadcast a leave that drops this participant for everyone and stops anyone
  // following it.
  const liveRoomId = provider && connectionState === "live" ? (session?.room.id ?? null) : null;
  useEffect(() => {
    if (!provider || !liveRoomId) return;
    let cancelled = false;
    const providerGeneration = providerGenerationRef.current;
    const isOwner = provider.session?.membership.role === "owner";
    void refreshRoomDataFor(liveRoomId, isOwner, providerGeneration)
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
  }, [liveRoomId, provider, publishAwarenessState, refreshRoomDataFor]);

  // A new active file changes the published surface; a new role changes this
  // member's own participant entry.
  useEffect(() => {
    scheduleAwarenessPublish();
  }, [activeFilePath, role, scheduleAwarenessPublish]);

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
              key === followedParticipantKeyRef.current &&
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
    if (!followedParticipantKey) return null;
    const participant = participantsBySession.get(followedParticipantKey);
    if (!participant) return null;
    if (participant.expiresAt > Date.now()) return participant;
    return isCollaborationFollowSuspendedConnectionState(connectionState) ? participant : null;
  }, [connectionState, followedParticipantKey, participantsBySession]);
  const followAvailability = useMemo(
    () =>
      getCollaborationFollowAvailability({
        followedParticipantKey,
        ownParticipantKey,
        connectionState,
        participantKeys: new Set(
          Array.from(participantsBySession)
            .filter(([, participant]) => participant.expiresAt > Date.now())
            .map(([key]) => key),
        ),
      }),
    [connectionState, followedParticipantKey, ownParticipantKey, participantsBySession],
  );

  useEffect(() => {
    const surfaceKind = followedParticipant?.surface.kind ?? null;
    if (!surfaceKind) {
      followedSurfaceKindRef.current = null;
      return;
    }
    if (followedSurfaceKindRef.current === surfaceKind) return;
    followedSurfaceKindRef.current = surfaceKind;
    analytics.capture("collaboration_follow_surface_changed", { surface: surfaceKind });
  }, [followedParticipant?.surface.kind]);

  useEffect(() => {
    if (followAvailability === "missing") stopFollowing("target-left");
  }, [followAvailability, stopFollowing]);

  useEffect(() => {
    if (usesPlaybackModel) stopFollowing("playback");
  }, [stopFollowing, usesPlaybackModel]);

  useEffect(() => {
    if (!followedParticipantKey) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      stopFollowing("user");
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [followedParticipantKey, stopFollowing]);

  const exportRoom = useCallback(async () => {
    const currentProvider = providerRef.current;
    const current = currentProvider?.session;
    if (!currentProvider || !current || current.membership.role !== "owner") {
      throw new Error("Only the room owner can export a recovery snapshot.");
    }
    await flushCurrentEdits(currentProvider);
    return exportCollaborationRoom(current.room.id);
  }, [flushCurrentEdits]);

  const updateCursor = useCallback(
    (path: string, anchorOffset: number, headOffset: number) => {
      const current = providerRef.current;
      if (!current || current.connectionState !== "live" || followedParticipantKeyRef.current) {
        return;
      }
      const fileNodeId = getNodeIdForPath(path);
      awarenessCursorRef.current = fileNodeId
        ? createCollaborationCursor(current.doc, fileNodeId, anchorOffset, headOffset)
        : null;
      if (awarenessSurfaceRef.current.kind === "editor") {
        awarenessSurfaceRef.current = editorSurfaceOn(awarenessSurfaceRef.current, fileNodeId);
      }
      scheduleAwarenessPublish();
    },
    [getNodeIdForPath, scheduleAwarenessPublish],
  );

  const publishCurrentSlide = useCallback((slideId: string) => {
    const current = providerRef.current;
    if (!current || !canWriteRef.current || playbackRef.current) return false;
    try {
      // Throws unless the slide is in the room presentation, so returning means
      // the shared current slide is now `slideId`.
      setCollaborationCurrentSlide(current.doc, slideId);
      setLocalError(null);
      return true;
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
        const { elements: next, accepted } = applyCollaborationWhiteboardDelta(current.doc, event);
        // The teaching projection of these transactions runs in a microtask and
        // React applies it to the stores in an effect, both after this callback.
        // Tag that exact authoritative result so normalization cannot make this
        // local canvas echo look like a remote scene update. Only an accepted
        // delta is an echo: when another client's version won, the canvas does
        // not show the result and the projection must reach it.
        if (accepted) {
          localWhiteboardProjectionFingerprintRef.current = JSON.stringify(next);
        }
        setLocalError(null);
        return accepted;
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
      ownParticipantKey,
      followedParticipantKey,
      followedParticipant,
      surfaceRepublishVersion,
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
      followedParticipantKey,
      followParticipant,
      initializeTeachingSurfaces,
      isCreatingRoom,
      isTeachingLoading,
      joinRoom,
      leaveRoom,
      localError,
      members,
      machineSnapshot?.context.error,
      machineSnapshot?.context.hasOfflineChanges,
      ownParticipantKey,
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
      surfaceRepublishVersion,
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
