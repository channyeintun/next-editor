import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceUiState } from "../voice/types";

const voiceMocks = vi.hoisted(() => ({
  join: vi.fn<() => void>(),
  leave: vi.fn<() => void>(),
  mute: vi.fn<() => void>(),
  unmute: vi.fn<() => void>(),
  retry: vi.fn<() => void>(),
  enableAudio: vi.fn<() => void>(),
}));

let voiceState: VoiceUiState;
let collaborationState: Record<string, unknown>;

vi.mock("@next-editor/infra", () => ({
  avatarProxyUrl: (url: string) => url,
  signInUrl: (url: string) => url,
  useAuth: () => ({ isSignedIn: true }),
}));

vi.mock("../contexts/CollaborationContext", () => ({
  useCollaboration: () => collaborationState,
}));

vi.mock("../contexts/CollaborationVoiceContext", () => ({
  useCollaborationVoice: () => ({
    subscribe: () => () => undefined,
    getState: () => voiceState,
    ...voiceMocks,
  }),
  useCollaborationVoiceState: () => voiceState,
}));

import CollaborationPanel from "./CollaborationPanel";

const OWN_SESSION = "10000000-0000-4000-8000-000000000001";
const OWN_USER = "30000000-0000-4000-8000-000000000001";
const PEER_SESSION = "40000000-0000-4000-8000-000000000002";
const PEER_USER = "30000000-0000-4000-8000-000000000002";

function awarenessParticipant(actorId: string, sessionId: string, name: string) {
  return {
    kind: "state",
    roomId: "20000000-0000-4000-8000-000000000001",
    actorId,
    sessionId,
    revision: 1,
    role: "editor",
    username: name.toLowerCase(),
    name,
    avatarUrl: null,
    isHost: false,
    surface: { kind: "editor", fileNodeId: null, viewport: null },
    cursor: null,
    occurredAt: 1,
    expiresAt: Date.now() + 30_000,
  };
}

function voiceRosterEntry(
  userId: string,
  sessionId: string,
  overrides: { muted?: boolean; published?: boolean; isSelf?: boolean; isSpeaking?: boolean } = {},
) {
  return {
    participant: {
      voiceConnectionId: "60000000-0000-4000-8000-000000000009",
      collaborationSessionId: sessionId,
      userId,
      displayName: "Someone",
      role: "editor" as const,
      muted: overrides.muted ?? true,
      publishedTrack:
        (overrides.published ?? false)
          ? { sessionId: "sfu-session", trackName: "track", location: "remote" as const }
          : null,
      revision: 1,
    },
    isSelf: overrides.isSelf ?? false,
    isSpeaking: overrides.isSpeaking ?? false,
  };
}

function idleVoiceState(overrides: Partial<VoiceUiState> = {}): VoiceUiState {
  return {
    state: "idle",
    unavailableReason: null,
    errorCode: null,
    autoplayBlocked: false,
    roster: [],
    isLocalSpeaking: false,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(voiceMocks)) mock.mockClear();
  voiceState = idleVoiceState();
  collaborationState = {
    provider: { awarenessSessionId: OWN_SESSION },
    session: { room: { id: "20000000-0000-4000-8000-000000000001", status: "active" } },
    connectionState: "live",
    role: "editor",
    isHost: false,
    canWrite: true,
    isCreatingRoom: false,
    hasOfflineChanges: false,
    members: [],
    invitations: [],
    participants: [
      awarenessParticipant(OWN_USER, OWN_SESSION, "Self"),
      awarenessParticipant(PEER_USER, PEER_SESSION, "Ada"),
    ],
    followedSessionId: null,
    followedParticipant: null,
    isApplyingFollow: false,
    teaching: { initialized: true, slideOrder: [], slides: new Map(), currentSlideId: null },
    teachingSlides: [],
    isTeachingLoading: false,
    canRetryAssets: false,
    error: null,
    clearError: vi.fn<() => void>(),
    getPathForNodeId: () => null,
    stopFollowing: vi.fn<() => void>(),
    followParticipant: vi.fn<() => void>(),
  };
});

function openPanel() {
  render(<CollaborationPanel />);
  fireEvent.click(screen.getByRole("button", { name: /live/i }));
}

describe("voice controls", () => {
  it("shows Join voice when idle and does not join on panel open", () => {
    openPanel();
    expect(screen.getByRole("button", { name: "Join voice" })).toBeInTheDocument();
    expect(voiceMocks.join).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Join voice" }));
    expect(voiceMocks.join).toHaveBeenCalledTimes(1);
  });

  it("offers Unmute and Leave while listening, with the muted hint", () => {
    voiceState = idleVoiceState({ state: "listening" });
    openPanel();
    expect(screen.getByRole("button", { name: "Unmute" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave voice" })).toBeInTheDocument();
    expect(screen.getByText(/You are muted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(voiceMocks.unmute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Leave voice" }));
    expect(voiceMocks.leave).toHaveBeenCalledTimes(1);
  });

  it("offers Mute while live", () => {
    voiceState = idleVoiceState({ state: "live" });
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(voiceMocks.mute).toHaveBeenCalledTimes(1);
  });

  it("shows actionable copy for a denied microphone", () => {
    voiceState = idleVoiceState({
      state: "listening",
      errorCode: "microphone-permission-denied",
    });
    openPanel();
    expect(screen.getByRole("alert")).toHaveTextContent("Microphone access was denied");
  });

  it("offers Retry when voice failed without touching document status", () => {
    voiceState = idleVoiceState({ state: "failed", errorCode: "network" });
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Retry voice" }));
    expect(voiceMocks.retry).toHaveBeenCalledTimes(1);
    // The document collaboration status is still rendered independently.
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
  });

  it("surfaces Enable audio when autoplay is blocked", () => {
    voiceState = idleVoiceState({ state: "listening", autoplayBlocked: true });
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Enable audio" }));
    expect(voiceMocks.enableAudio).toHaveBeenCalledTimes(1);
  });

  it("explains unsupported browsers instead of showing controls", () => {
    voiceState = idleVoiceState({
      state: "unavailable",
      unavailableReason: "unsupported-browser",
    });
    openPanel();
    expect(screen.getByText(/not supported in this browser/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join voice" })).not.toBeInTheDocument();
  });

  it("hides voice entirely when the server disables the feature", () => {
    voiceState = idleVoiceState({
      state: "unavailable",
      unavailableReason: "feature-disabled",
    });
    openPanel();
    expect(screen.queryByRole("button", { name: "Join voice" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Voice/)).not.toBeInTheDocument();
  });
});

describe("participant voice badges", () => {
  it("marks joined-and-muted participants", () => {
    voiceState = idleVoiceState({
      state: "listening",
      roster: [voiceRosterEntry(PEER_USER, PEER_SESSION, { muted: true, published: false })],
    });
    openPanel();
    expect(screen.getByRole("img", { name: "In voice, muted" })).toBeInTheDocument();
  });

  it("marks publishing participants and speaking state", () => {
    voiceState = idleVoiceState({
      state: "listening",
      roster: [
        voiceRosterEntry(PEER_USER, PEER_SESSION, {
          muted: false,
          published: true,
          isSpeaking: true,
        }),
      ],
    });
    openPanel();
    expect(screen.getByRole("img", { name: "Speaking" })).toBeInTheDocument();
  });

  it("shows nothing for participants who are not in voice", () => {
    voiceState = idleVoiceState({ state: "listening", roster: [] });
    openPanel();
    expect(screen.queryByRole("img", { name: /In voice/ })).not.toBeInTheDocument();
  });

  it("never matches by display name", () => {
    // Same display name, different user/session identity: no badge.
    voiceState = idleVoiceState({
      state: "listening",
      roster: [
        voiceRosterEntry("30000000-0000-4000-8000-00000000000f", PEER_SESSION, {
          muted: true,
        }),
      ],
    });
    openPanel();
    expect(screen.queryByRole("img", { name: /In voice/ })).not.toBeInTheDocument();
  });
});
