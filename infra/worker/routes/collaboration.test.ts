import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_SQLITE_PERSISTENCE_VERSION,
} from "../../../src/collaboration/protocol";
import {
  getCollaborationRoomAccess,
  recordCollaborationAuditEvent,
  setCollaborationRoomStatus,
  type CollaborationRoomAccess,
  type CollaborationRoomRow,
} from "../../db/collaborationQueries";
import { getCurrentUser } from "../auth/session";
import { publishCollaborationMaintenanceJob } from "../collaboration/qstash";
import { notifyCollaborationRoomControl } from "../collaboration/roomDurableObject";
import type { Env } from "../env";
import { collaborationRoute } from "./collaboration";

vi.mock("../auth/session", () => ({
  getCurrentUser: vi.fn<typeof getCurrentUser>(),
}));

vi.mock("../../db/collaborationQueries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/collaborationQueries")>()),
  getCollaborationRoomAccess: vi.fn<typeof getCollaborationRoomAccess>(),
  setCollaborationRoomStatus: vi.fn<typeof setCollaborationRoomStatus>(),
  recordCollaborationAuditEvent: vi.fn<typeof recordCollaborationAuditEvent>(async () => {}),
}));

vi.mock("../collaboration/qstash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../collaboration/qstash")>()),
  publishCollaborationMaintenanceJob: vi.fn<typeof publishCollaborationMaintenanceJob>(
    async () => ({ queued: true, messageId: "message-1", deduplicated: false }),
  ),
}));

vi.mock("../collaboration/roomDurableObject", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../collaboration/roomDurableObject")>()),
  notifyCollaborationRoomControl: vi.fn<typeof notifyCollaborationRoomControl>(),
}));

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "20000000-0000-4000-8000-000000000001";
const CLOSED_AT = 1_700_000_000_000;

function room(overrides: Partial<CollaborationRoomRow> = {}): CollaborationRoomRow {
  return {
    id: ROOM_ID,
    owner_id: OWNER_ID,
    host_user_id: OWNER_ID,
    status: "active",
    transport: "cloudflare-websocket",
    persistence_version: COLLABORATION_SQLITE_PERSISTENCE_VERSION,
    protocol_version: COLLABORATION_PROTOCOL_VERSION,
    document_schema_version: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    role_version: 1,
    max_members: 10,
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    purged_at: null,
    ...overrides,
  };
}

function ownerAccess(overrides: Partial<CollaborationRoomRow> = {}): CollaborationRoomAccess {
  return { ...room(overrides), member_role: "owner" };
}

/** POSTs /close and waits for everything the route handed to waitUntil. */
async function closeRoom(): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const executionContext = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  };
  const response = await collaborationRoute.request(
    `https://nexteditor.dev/rooms/${ROOM_ID}/close`,
    { method: "POST" },
    { DB: {} } as Env,
    executionContext as unknown as ExecutionContext,
  );
  await Promise.all(pending);
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: OWNER_ID } as never);
});

describe("POST /rooms/:roomId/close", () => {
  it("schedules the purge even when the room coordinator cannot be reached", async () => {
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(ownerAccess());
    vi.mocked(setCollaborationRoomStatus).mockResolvedValue(
      room({ status: "closed", closed_at: CLOSED_AT }),
    );
    vi.mocked(notifyCollaborationRoomControl).mockRejectedValue(new Error("room unavailable"));
    // Hono's default error handler logs the thrown coordinator failure.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await closeRoom();
    logged.mockRestore();

    expect(response.status).toBe(500);
    expect(publishCollaborationMaintenanceJob).toHaveBeenCalledWith(
      expect.anything(),
      { kind: "cleanup-room", roomId: ROOM_ID, closedAt: CLOSED_AT },
      expect.anything(),
    );
    expect(recordCollaborationAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "room.closed" }),
    );
  });

  it("schedules the purge again when the owner repeats a close", async () => {
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(
      ownerAccess({ status: "closed", closed_at: CLOSED_AT }),
    );
    vi.mocked(notifyCollaborationRoomControl).mockResolvedValue(true);

    const response = await closeRoom();

    expect(response.status).toBe(200);
    expect(notifyCollaborationRoomControl).toHaveBeenCalledOnce();
    expect(publishCollaborationMaintenanceJob).toHaveBeenCalledWith(
      expect.anything(),
      { kind: "cleanup-room", roomId: ROOM_ID, closedAt: CLOSED_AT },
      expect.anything(),
    );
  });

  it("does not schedule a purge for a room that is already purged", async () => {
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(
      ownerAccess({ status: "closed", closed_at: CLOSED_AT, purged_at: CLOSED_AT + 1 }),
    );
    vi.mocked(notifyCollaborationRoomControl).mockResolvedValue(true);

    expect((await closeRoom()).status).toBe(200);
    expect(publishCollaborationMaintenanceJob).not.toHaveBeenCalled();
  });
});
