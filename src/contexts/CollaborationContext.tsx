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
  createCollaborationRoom,
  getCollaborationBootstrap,
  getCollaborationRoom,
  publishCollaborationUpdate,
  useAuth,
} from "@next-editor/infra";
import type {
  CollaborationRole,
  CollaborationRoomSession,
} from "../collaboration/protocol";
import {
  CollaborationProjectController,
  canWriteCollaborationDocument,
  seedCollaborationProject,
  type CollaborationProjectProjection,
} from "../collaboration/projectDocument";
import { createCollaborationRoomSnapshot } from "../collaboration/yjsUpdates";
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
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { useWorkspaceActions } from "../hooks/useWorkspace";

interface CollaborationContextValue {
  provider: UpstashRoomProvider | null;
  doc: Y.Doc | null;
  session: CollaborationRoomSession | null;
  connectionState: CollaborationConnectionState;
  role: CollaborationRole | null;
  isHost: boolean;
  canWrite: boolean;
  hasOfflineChanges: boolean;
  error: string | null;
  createRoom: () => Promise<CollaborationRoomSession>;
  joinRoom: (roomId: string) => void;
  leaveRoom: () => void;
  retry: () => Promise<void>;
  closeRoom: () => Promise<void>;
  clearError: () => void;
}

const CollaborationContext = createContext<CollaborationContextValue | null>(null);

const collaborationApi: CollaborationRoomApi = {
  getRoom: getCollaborationRoom,
  getBootstrap: getCollaborationBootstrap,
  publishUpdate: publishCollaborationUpdate,
};

function messageFromError(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const responseMessage = (error as { response?: { data?: { error?: unknown } } }).response?.data
      ?.error;
    if (typeof responseMessage === "string") return responseMessage;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export function CollaborationProvider({ children }: { children: ReactNode }) {
  const baseActions = useWorkspaceActions();
  const baseActionsRef = useRef(baseActions);
  baseActionsRef.current = baseActions;
  const { usesPlaybackModel } = useNextEditorMetadata();
  const playbackRef = useRef(usesPlaybackModel);
  playbackRef.current = usesPlaybackModel;
  const { user, isSignedIn, isLoading: isAuthLoading } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const roomId = searchParams.get("room");
  const inviteToken = searchParams.get("invite");
  const [provider, setProvider] = useState<UpstashRoomProvider | null>(null);
  const providerRef = useRef<UpstashRoomProvider | null>(null);
  const projectionRef = useRef<CollaborationProjectProjection | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const claimingTokenRef = useRef<string | null>(null);

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
          setLocalError(messageFromError(error, "The collaboration invitation could not be accepted."));
          claimingTokenRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inviteToken, isAuthLoading, isSignedIn, setSearchParams]);

  useEffect(() => {
    if (!roomId || inviteToken) {
      providerRef.current?.stop();
      providerRef.current = null;
      projectionRef.current = null;
      setProvider(null);
      return;
    }

    const nextProvider = new UpstashRoomProvider({
      roomId,
      api: collaborationApi,
      onDocumentChange: (doc, transaction) => {
        if (playbackRef.current) return;
        try {
          projectionRef.current = projectCollaborationTransaction(
            doc,
            transaction,
            projectionRef.current,
            baseActionsRef.current,
          );
        } catch (error) {
          setLocalError(messageFromError(error, "The shared workspace could not be projected."));
        }
      },
      onRejectedLocalChanges: setLocalError,
    });
    providerRef.current?.stop();
    providerRef.current = nextProvider;
    projectionRef.current = null;
    setProvider(nextProvider);
    setLocalError(null);
    const subscription = nextProvider.subscribe(() => {
      setRuntimeVersion((version) => version + 1);
    });
    void nextProvider.start();

    return () => {
      subscription.unsubscribe();
      nextProvider.stop();
      if (providerRef.current === nextProvider) providerRef.current = null;
    };
  }, [inviteToken, roomId]);

  useEffect(() => {
    if (usesPlaybackModel || !provider) return;
    try {
      projectionRef.current = reprojectCollaborationWorkspace(provider.doc, baseActionsRef.current);
    } catch {
      // The initial snapshot may not have arrived yet; its transaction callback
      // performs this projection after synchronization.
    }
  }, [provider, usesPlaybackModel]);

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
          })
        : null,
    [provider],
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
      createNewEditor: () => reportWriteError(new Error("Leave the room before replacing the project.")),
      createFile: (path, content = "", encoding) =>
        run(() => controller.createFile(path, content, encoding)),
      createFolder: (path) => run(() => controller.createFolder(path)),
      renameFile: (currentPath, nextPath) =>
        run(() => controller.renameFile(currentPath, nextPath)),
      renameFolder: (currentPath, nextPath) =>
        run(() => controller.renameFolder(currentPath, nextPath)),
      deleteFile: (path) => run(() => controller.deleteFile(path)),
      deleteFolder: (path) => run(() => controller.deleteFolder(path)),
      updateFileContent: (path, content) =>
        run(() => controller.replaceFileContent(path, content)),
      updateActiveFileContent: (content) =>
        run(() => controller.replaceFileContent(baseActions.getActiveFilePath(), content)),
      setPreviewFilePath: (path) => run(() => controller.setEntryFile(path)),
      updateLessonType: (lessonType) => run(() => controller.updateLessonType(lessonType)),
      loadProject: () => reportWriteError(new Error("Leave the room before loading another project.")),
      reconcileExternalProject: (project) => {
        if (playbackRef.current) baseActions.reconcileExternalProject(project);
        else reportWriteError(new Error("Bulk project replacement is disabled in a live room."));
      },
    };
  }, [baseActions, controller, reportWriteError]);

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
    const doc = new Y.Doc();
    seedCollaborationProject(doc, baseActionsRef.current.getProject());
    const created = await createCollaborationRoom(
      createCollaborationRoomSnapshot(doc, crypto.randomUUID()),
    );
    updateRoomParam(created.room.id);
    return created;
  }, [isSignedIn, updateRoomParam]);

  const leaveRoom = useCallback(() => {
    providerRef.current?.stop();
    updateRoomParam(null);
  }, [updateRoomParam]);

  const retry = useCallback(async () => {
    setLocalError(null);
    await providerRef.current?.retryNow();
  }, []);

  const closeRoom = useCallback(async () => {
    const current = providerRef.current;
    if (!current) return;
    await closeCollaborationRoom(current.session?.room.id ?? roomId ?? "");
    leaveRoom();
  }, [leaveRoom, roomId]);

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
      error: localError ?? machineSnapshot?.context.error ?? null,
      createRoom,
      joinRoom: updateRoomParam,
      leaveRoom,
      retry,
      closeRoom,
      clearError: () => setLocalError(null),
    }),
    [
      canWrite,
      closeRoom,
      connectionState,
      createRoom,
      leaveRoom,
      localError,
      machineSnapshot?.context.error,
      machineSnapshot?.context.hasOfflineChanges,
      provider,
      retry,
      role,
      session,
      updateRoomParam,
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
