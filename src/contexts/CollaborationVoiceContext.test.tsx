import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { VoiceEngine } from "../voice/engine";
import type { VoiceUnavailableReason } from "../voice/machine";

let collaborationState: Record<string, unknown> | null;

vi.mock("./CollaborationContext", () => ({
  useOptionalCollaboration: () => collaborationState,
}));

vi.mock("@next-editor/infra", () => ({
  getCollaborationVoiceAvailability: () => Promise.resolve(true),
}));

// The production engine, which the provider imports on demand.
const browserEngines: FakeEngine[] = [];
function fakeBrowserVoiceEngineModule() {
  return {
    createBrowserVoiceEngine: (options: { roomId: string; collaborationSessionId: string }) => {
      const engine = new FakeEngine(options);
      browserEngines.push(engine);
      return engine;
    },
  };
}
vi.mock("../voice/browserVoiceEngine", () => fakeBrowserVoiceEngineModule());

import {
  CollaborationVoiceProvider,
  useCollaborationVoiceState,
} from "./CollaborationVoiceContext";

const ROOM_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";

class FakeEngine {
  options: { roomId: string; collaborationSessionId: string };
  disposed = false;
  joinCalls = 0;
  availability: Array<VoiceUnavailableReason | null> = [];

  constructor(options: { roomId: string; collaborationSessionId: string }) {
    this.options = options;
  }

  // Like the real engine, the ui-state snapshot is referentially stable
  // between changes; useSyncExternalStore depends on that.
  private readonly uiState = {
    state: "idle" as const,
    unavailableReason: null,
    errorCode: null,
    wantsMicrophone: false,
    autoplayBlocked: false,
    roster: [],
    isLocalSpeaking: false,
  };

  subscribe(): () => void {
    return () => undefined;
  }

  getUiState() {
    return this.uiState;
  }

  setAvailability(reason: VoiceUnavailableReason | null): void {
    this.availability.push(reason);
  }

  join(): void {
    this.joinCalls += 1;
  }

  leave(): void {}
  mute(): void {}
  unmute(): void {}
  retry(): void {}
  enableAudio(): void {}

  dispose(): void {
    this.disposed = true;
  }
}

function activeCollaboration(roomId: string, sessionId: string) {
  return {
    session: { room: { id: roomId, status: "active" } },
    provider: { awarenessSessionId: sessionId },
  };
}

function StateProbe() {
  useCollaborationVoiceState();
  return null;
}

function UnavailableReasonProbe() {
  const state = useCollaborationVoiceState();
  return <p data-testid="voice-reason">{`${state.state}:${state.unavailableReason}`}</p>;
}

describe("CollaborationVoiceProvider", () => {
  const engines: FakeEngine[] = [];
  const createEngine = (options: { roomId: string; collaborationSessionId: string }) => {
    const engine = new FakeEngine(options);
    engines.push(engine);
    return engine as unknown as VoiceEngine;
  };

  beforeEach(() => {
    engines.length = 0;
    browserEngines.length = 0;
    collaborationState = null;
  });

  afterEach(() => {
    vi.doMock("../voice/browserVoiceEngine", () => fakeBrowserVoiceEngineModule());
    vi.useRealTimers();
  });

  it("creates no engine without an active room", () => {
    collaborationState = null;
    render(
      <CollaborationVoiceProvider createEngine={createEngine}>
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    expect(engines).toHaveLength(0);
  });

  it("creates one engine per active room and never joins on mount", async () => {
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    render(
      <CollaborationVoiceProvider
        createEngine={createEngine}
        checkAvailability={() => Promise.resolve(true)}
      >
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(engines).toHaveLength(1);
    expect(engines[0].options).toEqual({
      roomId: ROOM_ID,
      collaborationSessionId: SESSION_ID,
    });
    // Mounting the provider (or opening the panel) never joins voice or
    // requests devices.
    expect(engines[0].joinCalls).toBe(0);
    expect(engines[0].availability).toEqual([null]);
  });

  it("marks the feature disabled when the availability probe rejects it", async () => {
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    render(
      <CollaborationVoiceProvider
        createEngine={createEngine}
        checkAvailability={() => Promise.resolve(false)}
      >
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(engines[0].availability).toEqual(["feature-disabled"]);
  });

  it("probes availability once more after a network error", async () => {
    vi.useFakeTimers();
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    const checkAvailability = vi
      .fn<(roomId: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockResolvedValueOnce(true);
    render(
      <CollaborationVoiceProvider createEngine={createEngine} checkAvailability={checkAvailability}>
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // A blip at room entry does not hide voice for the whole visit.
    expect(engines[0].availability).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(checkAvailability).toHaveBeenCalledTimes(2);
    expect(engines[0].availability).toEqual([null]);
  });

  it("marks the feature disabled when the retry after a server fault fails too", async () => {
    vi.useFakeTimers();
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    const serverFault = Object.assign(new Error("Bad Gateway"), { response: { status: 502 } });
    const checkAvailability = vi
      .fn<(roomId: string) => Promise<boolean>>()
      .mockRejectedValue(serverFault);
    render(
      <CollaborationVoiceProvider createEngine={createEngine} checkAvailability={checkAvailability}>
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(checkAvailability).toHaveBeenCalledTimes(2);
    expect(engines[0].availability).toEqual(["feature-disabled"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(checkAvailability).toHaveBeenCalledTimes(2);
  });

  it("takes a 4xx availability answer as final", async () => {
    vi.useFakeTimers();
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    const forbidden = Object.assign(new Error("Forbidden"), { response: { status: 403 } });
    const checkAvailability = vi
      .fn<(roomId: string) => Promise<boolean>>()
      .mockRejectedValue(forbidden);
    render(
      <CollaborationVoiceProvider createEngine={createEngine} checkAvailability={checkAvailability}>
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(engines[0].availability).toEqual(["feature-disabled"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(checkAvailability).toHaveBeenCalledTimes(1);
  });

  it("drops a pending availability retry when the room ends", async () => {
    vi.useFakeTimers();
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    const checkAvailability = vi
      .fn<(roomId: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockResolvedValue(true);
    const view = render(
      <CollaborationVoiceProvider createEngine={createEngine} checkAvailability={checkAvailability}>
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(checkAvailability).toHaveBeenCalledTimes(1);
    expect(engines[0].availability).toEqual([]);
  });

  it("disposes the engine when the room changes and builds a fresh one", async () => {
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    const view = render(
      <CollaborationVoiceProvider
        createEngine={createEngine}
        checkAvailability={() => Promise.resolve(true)}
      >
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    collaborationState = activeCollaboration("20000000-0000-4000-8000-000000000002", SESSION_ID);
    view.rerender(
      <CollaborationVoiceProvider
        createEngine={createEngine}
        checkAvailability={() => Promise.resolve(true)}
      >
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(engines).toHaveLength(2);
    expect(engines[0].disposed).toBe(true);
    expect(engines[1].disposed).toBe(false);
  });

  it("disposes the engine when collaboration ends or the room closes", async () => {
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    const view = render(
      <CollaborationVoiceProvider
        createEngine={createEngine}
        checkAvailability={() => Promise.resolve(true)}
      >
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    collaborationState = {
      session: { room: { id: ROOM_ID, status: "closed" } },
      provider: { awarenessSessionId: SESSION_ID },
    };
    view.rerender(
      <CollaborationVoiceProvider
        createEngine={createEngine}
        checkAvailability={() => Promise.resolve(true)}
      >
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    expect(engines).toHaveLength(1);
    expect(engines[0].disposed).toBe(true);
  });

  it("loads the browser engine once a room is active", async () => {
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    const view = render(
      <CollaborationVoiceProvider>
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    await waitFor(() => expect(browserEngines).toHaveLength(1));
    expect(browserEngines[0].options).toEqual({
      roomId: ROOM_ID,
      collaborationSessionId: SESSION_ID,
    });
    // jsdom has no WebRTC.
    expect(browserEngines[0].availability).toEqual(["unsupported-browser"]);
    view.unmount();
    expect(browserEngines[0].disposed).toBe(true);
  });

  it("builds no browser engine when the room ends while the engine loads", async () => {
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    const view = render(
      <CollaborationVoiceProvider>
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    view.unmount();
    await act(() => import("../voice/browserVoiceEngine"));
    expect(browserEngines).toHaveLength(0);
  });

  it("says voice could not load when the engine chunk fails to load", async () => {
    // A tab still on an old bundle after a deploy: the hashed chunk is gone.
    vi.doMock("../voice/browserVoiceEngine", () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    render(
      <CollaborationVoiceProvider>
        <UnavailableReasonProbe />
      </CollaborationVoiceProvider>,
    );
    expect(screen.getByTestId("voice-reason")).toHaveTextContent("unavailable:no-room");
    await waitFor(() =>
      expect(screen.getByTestId("voice-reason")).toHaveTextContent("unavailable:load-failed"),
    );
    expect(browserEngines).toHaveLength(0);
  });

  it("disposes the engine on unmount", async () => {
    collaborationState = activeCollaboration(ROOM_ID, SESSION_ID);
    const view = render(
      <CollaborationVoiceProvider
        createEngine={createEngine}
        checkAvailability={() => Promise.resolve(true)}
      >
        <StateProbe />
      </CollaborationVoiceProvider>,
    );
    view.unmount();
    expect(engines[0].disposed).toBe(true);
  });
});
