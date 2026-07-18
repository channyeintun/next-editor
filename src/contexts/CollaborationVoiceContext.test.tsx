import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceEngine } from "../voice/engine";
import type { VoiceUnavailableReason } from "../voice/machine";

let collaborationState: Record<string, unknown> | null;

vi.mock("./CollaborationContext", () => ({
  useOptionalCollaboration: () => collaborationState,
}));

vi.mock("@next-editor/infra", () => ({
  getCollaborationVoiceAvailability: () => Promise.resolve(true),
}));

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

describe("CollaborationVoiceProvider", () => {
  const engines: FakeEngine[] = [];
  const createEngine = (options: { roomId: string; collaborationSessionId: string }) => {
    const engine = new FakeEngine(options);
    engines.push(engine);
    return engine as unknown as VoiceEngine;
  };

  beforeEach(() => {
    engines.length = 0;
    collaborationState = null;
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
