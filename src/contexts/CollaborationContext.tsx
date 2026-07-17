import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router";
import * as Y from "yjs";
import {
  claimCollaborationInvitation,
  closeCollaborationRoom,
  createCollaborationInvitation,
  createCollaborationRoom,
  downloadCollaborationAsset,
  exportCollaborationRoom,
  getCollaborationBootstrap,
  getCollaborationRoom,
  listCollaborationAwareness,
  listCollaborationInvitations,
  listCollaborationMembers,
  publishCollaborationAwareness,
  publishCollaborationUpdate,
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
  CreatedCollaborationInvitation,
} from "../collaboration/protocol";
import {
  CollaborationProjectController,
  canWriteCollaborationDocument,
  projectCollaborationDocument,
  seedCollaborationProject,
  type CollaborationProjectProjection,
} from "../collaboration/projectDocument";
import {
  createCollaborationDocumentUpdate,
  createCollaborationRoomSnapshot,
} from "../collaboration/yjsUpdates";
import {
  UpstashRoomProvider,
  type CollaborationRoomApi,
} from "../collaboration/upstashRoomProvider";
import {
  collaborationConnectionState,
  type CollaborationConnectionState,
} from "../collaboration/collaborationMachine";
import {
  projectCollaborationTransaction,
  reprojectCollaborationWorkspace,
} from "../collaboration/workspaceAdapter";
import { WorkspaceActionsContext, type WorkspaceActions } from "./WorkspaceContext";
import { applyTextEditEvent, type TextEditEvent } from "../types/textEdit";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
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

export type CollaborationParticipant = Extract<CollaborationAwarenessEvent, { kind: "state" }>;

interface CollaborationContextValue {
  provider: UpstashRoomProvider | null;
  doc: Y.Doc | null;
  session: CollaborationRoomSession | null;
  connectionState: CollaborationConnectionState;
  role: CollaborationRole | null;
  isHost: boolean;
  canWrite: boolean;
  hasOfflineChanges: boolean;
  members: CollaborationMember[];
  invitations: CollaborationInvitation[];
  participants: CollaborationParticipant[];
  isFollowingHost: boolean;
  error: string | null;
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
  setFollowingHost: (following: boolean) => void;
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
  getBootstrap: getCollaborationBootstrap,
  publishUpdate: publishCollaborationUpdate,
  publishAwareness: publishCollaborationAwareness,
};

function messageFromError(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const responseMessage = (error as { response?: { data?: { error?: unknown } } }).response?.data
      ?.error;
    if (typeof responseMessage === "string") return responseMessage;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function stopProviderAfterBestEffortFlush(provider: UpstashRoomProvider): void {
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
  const baseActions = useWorkspaceActions();
  const activeFilePath = useWorkspaceActiveFilePath();
  const baseActionsRef = useRef(baseActions);
  baseActionsRef.current = baseActions;
  const { usesPlaybackModel, isRecording } = useNextEditorMetadata();
  const playbackRef = useRef(usesPlaybackModel);
  playbackRef.current = usesPlaybackModel;
  const { user, isSignedIn, isLoading: isAuthLoading } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const roomId = searchParams.get("room");
  const inviteToken = searchParams.get("invite");
  const [provider, setProvider] = useState<UpstashRoomProvider | null>(null);
  const providerRef = useRef<UpstashRoomProvider | null>(null);
  const projectionRef = useRef<CollaborationProjectProjection | null>(null);
  const pendingLocalTextEditRef = useRef<{
    event: TextEditEvent;
    onProjected?: (content: string | null) => void;
  } | null>(null);
  const assetFetchesRef = useRef(new Set<string>());
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [invitations, setInvitations] = useState<CollaborationInvitation[]>([]);
  const [participantsBySession, setParticipantsBySession] = useState(
    () => new Map<string, CollaborationParticipant>(),
  );
  const [isFollowingHost, setIsFollowingHost] = useState(false);
  const claimingTokenRef = useRef<string | null>(null);
  const awarenessRevisionRef = useRef(0);
  const awarenessCursorRef = useRef<CollaborationCursor | null>(null);
  const awarenessPublishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeFilePathRef = useRef(activeFilePath);
  activeFilePathRef.current = activeFilePath;
  const followingHostRef = useRef(isFollowingHost);
  followingHostRef.current = isFollowingHost;

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
      for (const [nodeId, asset] of projection.assetsByNodeId) {
        const path = projection.pathByNodeId.get(nodeId);
        if (!path) continue;
        if (assetFetchesRef.current.has(asset.id)) continue;
        assetFetchesRef.current.add(asset.id);
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
          .then(() => baseActionsRef.current.notifyAssetAvailable(asset.id))
          .catch((error: unknown) => {
            setLocalError(
              messageFromError(error, `The shared asset ${path} could not be downloaded.`),
            );
          })
          .finally(() => assetFetchesRef.current.delete(asset.id));
      }
    },
    [],
  );

  const applyAwarenessEvent = useCallback((event: CollaborationAwarenessEvent) => {
    const key = `${event.actorId}:${event.sessionId}`;
    setParticipantsBySession((current) => {
      const previous = current.get(key);
      if (previous && previous.revision > event.revision) return current;
      const next = new Map(current);
      if (event.kind === "leave" || ("expiresAt" in event && event.expiresAt <= Date.now())) {
        next.delete(key);
      } else {
        next.set(key, event);
      }
      return next;
    });
  }, []);

  const refreshRoomDataFor = useCallback(async (targetRoomId: string, owner: boolean) => {
    const [{ members: nextMembers }, nextInvitations] = await Promise.all([
      listCollaborationMembers(targetRoomId),
      owner ? listCollaborationInvitations(targetRoomId) : Promise.resolve([]),
    ]);
    setMembers(nextMembers);
    setInvitations(nextInvitations);
  }, []);

  useEffect(() => {
    if (!inviteToken || isAuthLoading || claimingTokenRef.current === inviteToken) return;
    if (!isSignedIn) {
      setLocalError("Sign in to accept this collaboration invitation.");
      return;
    }
    claimingTokenRef.current = inviteToken;
    let cancelled = false;
    void claimCollaborationInvitation(inviteToken)
      .then((session: CollaborationRoomSession) => {
        if (cancelled) return;
        setLocalError(null);
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.delete("invite");
            next.set("room", session.room.id);
            return next;
          },
          { replace: true },
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLocalError(
            messageFromError(error, "The collaboration invitation could not be accepted."),
          );
          claimingTokenRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inviteToken, isAuthLoading, isSignedIn, setSearchParams]);

  useEffect(() => {
    if (!roomId || inviteToken) {
      if (providerRef.current) stopProviderAfterBestEffortFlush(providerRef.current);
      providerRef.current = null;
      projectionRef.current = null;
      pendingLocalTextEditRef.current = null;
      assetFetchesRef.current.clear();
      setProvider(null);
      return;
    }

    const nextProvider = new UpstashRoomProvider({
      roomId,
      api: collaborationApi,
      onDocumentChange: (doc, transaction) => {
        if (playbackRef.current) return;
        try {
          const queuedTextEdit = pendingLocalTextEditRef.current;
          let projectedQueuedTextEdit = false;
          const projection = projectCollaborationTransaction(
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
          if (
            projectedQueuedTextEdit &&
            pendingLocalTextEditRef.current === queuedTextEdit
          ) {
            pendingLocalTextEditRef.current = null;
          }
          hydrateProjectionAssets(projection, roomId);
        } catch (error) {
          setLocalError(messageFromError(error, "The shared workspace could not be projected."));
        }
      },
      onAwarenessEvent: applyAwarenessEvent,
      onControlEvent: () => {
        const session = providerRef.current?.session;
        if (session) {
          void refreshRoomDataFor(session.room.id, session.membership.role === "owner").catch(
            () => {},
          );
        }
      },
      onRejectedLocalChanges: setLocalError,
    });
    if (providerRef.current) stopProviderAfterBestEffortFlush(providerRef.current);
    providerRef.current = nextProvider;
    projectionRef.current = null;
    pendingLocalTextEditRef.current = null;
    assetFetchesRef.current.clear();
    awarenessCursorRef.current = null;
    awarenessRevisionRef.current = 0;
    setMembers([]);
    setInvitations([]);
    setParticipantsBySession(new Map());
    setIsFollowingHost(false);
    setProvider(nextProvider);
    setLocalError(null);
    const subscription = nextProvider.subscribe(() => {
      setRuntimeVersion((version) => version + 1);
    });
    void nextProvider.start();

    return () => {
      subscription.unsubscribe();
      stopProviderAfterBestEffortFlush(nextProvider);
      if (providerRef.current === nextProvider) providerRef.current = null;
    };
  }, [applyAwarenessEvent, hydrateProjectionAssets, inviteToken, refreshRoomDataFor, roomId]);

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

  useEffect(() => {
    if (usesPlaybackModel || !provider) return;
    try {
      const projection = reprojectCollaborationWorkspace(provider.doc, baseActionsRef.current);
      projectionRef.current = projection;
      if (roomId) hydrateProjectionAssets(projection, roomId);
    } catch {
      // The initial snapshot may not have arrived yet; its transaction callback
      // performs this projection after synchronization.
    }
  }, [hydrateProjectionAssets, provider, roomId, usesPlaybackModel]);

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
          .then((bytes) => uploadCollaborationAsset(currentSession.room.id, bytes, content.mimeType))
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

  const createRoom = useCallback(async () => {
    if (!isSignedIn) throw new Error("Sign in before starting a collaboration room.");
    const project = baseActionsRef.current.getProject();
    const doc = new Y.Doc();
    seedCollaborationProject(doc, project, { skipBinaryAssets: true });
    const seededState = Y.encodeStateVector(doc);
    const clientId = crypto.randomUUID();
    let created: CollaborationRoomSession;
    try {
      created = await createCollaborationRoom(createCollaborationRoomSnapshot(doc, clientId));
    } catch (error) {
      doc.destroy();
      throw error;
    }
    try {
      const binaryFiles = Object.values(project.files)
        .filter(isWorkspaceAssetFile)
        .sort((left, right) => left.path.localeCompare(right.path));
      if (binaryFiles.length > 0) {
        const controller = new CollaborationProjectController(doc, { canWrite: () => true });
        for (const file of binaryFiles) {
          const bytes = await getWorkspaceAssetBytes(file.content);
          const asset = await uploadCollaborationAsset(
            created.room.id,
            bytes,
            file.content.mimeType,
          );
          controller.createAssetFile(file.path, asset);
        }
        controller.setEntryFile(project.entryFilePath);
        await publishCollaborationUpdate(
          created.room.id,
          createCollaborationDocumentUpdate(Y.encodeStateAsUpdate(doc, seededState), clientId),
        );
      }
      updateRoomParam(created.room.id);
      return created;
    } catch (error) {
      await closeCollaborationRoom(created.room.id).catch(() => {});
      throw error;
    } finally {
      doc.destroy();
    }
  }, [isSignedIn, updateRoomParam]);

  const flushCurrentEdits = useCallback(async (current: UpstashRoomProvider) => {
    await current.flushNow();
    if (!current.hasPendingUpdates) return;
    const message = "Wait for offline collaboration changes to synchronize before continuing.";
    setLocalError(message);
    throw new Error(message);
  }, []);

  const leaveRoom = useCallback(async () => {
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
  }, [flushCurrentEdits, updateRoomParam]);

  const retry = useCallback(async () => {
    setLocalError(null);
    await providerRef.current?.retryNow();
  }, []);

  const retryAssets = useCallback(() => {
    const current = providerRef.current;
    const projection = projectionRef.current;
    const targetRoomId = current?.session?.room.id;
    if (!projection || !targetRoomId) return;
    setLocalError(null);
    hydrateProjectionAssets(projection, targetRoomId);
  }, [hydrateProjectionAssets]);

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
  }, [flushCurrentEdits, isRecording, roomId, updateRoomParam]);

  const publishAwarenessState = useCallback(async () => {
    const current = providerRef.current;
    const currentSession = current?.session;
    if (!current || !currentSession || current.connectionState !== "live") return;
    const activeFileNodeId = getNodeIdForPath(activeFilePathRef.current);
    if (awarenessCursorRef.current?.fileNodeId !== activeFileNodeId) {
      awarenessCursorRef.current = null;
    }
    await current.publishAwareness({
      kind: "state",
      sessionId: current.awarenessSessionId,
      revision: ++awarenessRevisionRef.current,
      activeFileNodeId,
      cursor: awarenessCursorRef.current,
      followingHost: followingHostRef.current,
    });
  }, [getNodeIdForPath]);

  const scheduleAwarenessPublish = useCallback(
    (delay = 75) => {
      if (awarenessPublishTimerRef.current) clearTimeout(awarenessPublishTimerRef.current);
      awarenessPublishTimerRef.current = setTimeout(() => {
        awarenessPublishTimerRef.current = null;
        void publishAwarenessState().catch(() => {});
      }, delay);
    },
    [publishAwarenessState],
  );

  useEffect(() => {
    if (!provider || connectionState !== "live" || !session) return;
    let cancelled = false;
    void Promise.all([
      session.room.transport === "upstash-realtime"
        ? listCollaborationAwareness(session.room.id)
        : Promise.resolve([]),
      refreshRoomDataFor(session.room.id, role === "owner"),
    ])
      .then(([initialParticipants]) => {
        if (cancelled) return;
        for (const participant of initialParticipants) applyAwarenessEvent(participant);
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
  }, [
    applyAwarenessEvent,
    connectionState,
    provider,
    publishAwarenessState,
    refreshRoomDataFor,
    role,
    session,
  ]);

  useEffect(() => {
    scheduleAwarenessPublish();
  }, [activeFilePath, isFollowingHost, scheduleAwarenessPublish]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setParticipantsBySession((current) => {
        const next = new Map(current);
        let changed = false;
        for (const [key, participant] of next) {
          if (participant.expiresAt <= now) {
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

  useEffect(() => {
    if (!isFollowingHost || !provider) return;
    const host = participants.find((participant) => participant.isHost);
    if (!host?.activeFileNodeId) return;
    const path = getPathForNodeId(host.activeFileNodeId);
    if (path && path !== activeFilePathRef.current) baseActionsRef.current.setActiveFilePath(path);
  }, [getPathForNodeId, isFollowingHost, participants, provider]);

  const refreshRoomData = useCallback(async () => {
    const current = providerRef.current?.session;
    if (!current) return;
    await refreshRoomDataFor(current.room.id, current.membership.role === "owner");
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
      if (!current || current.connectionState !== "live") return;
      const fileNodeId = getNodeIdForPath(path);
      awarenessCursorRef.current = fileNodeId
        ? createCollaborationCursor(current.doc, fileNodeId, anchorOffset, headOffset)
        : null;
      scheduleAwarenessPublish();
    },
    [getNodeIdForPath, scheduleAwarenessPublish],
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
      hasOfflineChanges: machineSnapshot?.context.hasOfflineChanges ?? false,
      members,
      invitations,
      participants,
      isFollowingHost,
      error: localError ?? machineSnapshot?.context.error ?? null,
      createRoom,
      joinRoom: updateRoomParam,
      leaveRoom,
      retry,
      closeRoom,
      exportRoom,
      refreshRoomData,
      createInvitation,
      revokeInvitation,
      updateMemberRole,
      removeMember,
      setFollowingHost: setIsFollowingHost,
      updateCursor,
      queueLocalTextEdit,
      getNodeIdForPath,
      getPathForNodeId,
      retryAssets,
      undo,
      redo,
      clearError: () => setLocalError(null),
    }),
    [
      canWrite,
      closeRoom,
      connectionState,
      createInvitation,
      createRoom,
      exportRoom,
      getNodeIdForPath,
      getPathForNodeId,
      invitations,
      isFollowingHost,
      leaveRoom,
      localError,
      members,
      machineSnapshot?.context.error,
      machineSnapshot?.context.hasOfflineChanges,
      participants,
      provider,
      queueLocalTextEdit,
      refreshRoomData,
      redo,
      removeMember,
      revokeInvitation,
      retry,
      retryAssets,
      role,
      session,
      updateCursor,
      updateMemberRole,
      updateRoomParam,
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
