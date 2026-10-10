import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_SQLITE_PERSISTENCE_VERSION,
} from "../../../src/collaboration/protocol";
import {
  createCollaborationInvitation,
  getCollaborationRoomAccess,
  recordCollaborationAuditEvent,
  setCollaborationRoomStatus,
  updateCollaborationMemberRole,
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
  createCollaborationInvitation: vi.fn<typeof createCollaborationInvitation>(),
  getCollaborationRoomAccess: vi.fn<typeof getCollaborationRoomAccess>(),
  setCollaborationRoomStatus: vi.fn<typeof setCollaborationRoomStatus>(),
  recordCollaborationAuditEvent: vi.fn<typeof recordCollaborationAuditEvent>(async () => {}),
  updateCollaborationMemberRole: vi.fn<typeof updateCollaborationMemberRole>(),
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

describe("signed-out callers", () => {
  const ASSET_ID = "a".repeat(64);
  const INVITATION_ID = "30000000-0000-4000-8000-000000000001";
  it.each([
    ["GET", "/rooms"],
    ["POST", "/rooms"],
    ["GET", `/rooms/${ROOM_ID}`],
    ["POST", `/rooms/${ROOM_ID}/teaching/initialize`],
    ["PUT", `/rooms/${ROOM_ID}/assets/${ASSET_ID}`],
    ["GET", `/rooms/${ROOM_ID}/assets/${ASSET_ID}`],
    ["GET", `/rooms/${ROOM_ID}/export`],
    ["GET", `/rooms/${ROOM_ID}/members`],
    ["GET", `/rooms/${ROOM_ID}/invitations`],
    ["POST", `/rooms/${ROOM_ID}/invitations`],
    ["DELETE", `/rooms/${ROOM_ID}/invitations/${INVITATION_ID}`],
    ["PATCH", `/rooms/${ROOM_ID}/members/${OWNER_ID}`],
    ["DELETE", `/rooms/${ROOM_ID}/members/${OWNER_ID}`],
    ["POST", `/rooms/${ROOM_ID}/close`],
    ["POST", "/invitations/claim"],
  ])("%s %s answers 401 before reading the body or the room", async (method, path) => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const hasBody = method !== "GET" && method !== "DELETE";

    const response = await collaborationRoute.request(
      `https://nexteditor.dev${path}`,
      {
        method,
        ...(hasBody ? { headers: { "Content-Type": "application/json" }, body: "not json" } : {}),
      },
      { DB: {} } as Env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not signed in" });
    expect(getCollaborationRoomAccess).not.toHaveBeenCalled();
  });
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

describe("POST /rooms/:roomId/invitations", () => {
  it("applies the schema's 24-hour and 10-use defaults to a role-only request", async () => {
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(ownerAccess());
    vi.mocked(createCollaborationInvitation).mockImplementation(async (_db, params) => ({
      id: "30000000-0000-4000-8000-000000000001",
      room_id: params.roomId,
      created_by: params.createdBy,
      token_hash: params.tokenHash,
      role: params.role,
      max_uses: params.maxUses,
      use_count: 0,
      expires_at: params.expiresAt,
      revoked_at: null,
      created_at: 1,
      updated_at: 1,
    }));
    const executionContext = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    };
    const before = Date.now();

    const response = await collaborationRoute.request(
      `https://nexteditor.dev/rooms/${ROOM_ID}/invitations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      },
      { DB: {} } as Env,
      executionContext as unknown as ExecutionContext,
    );

    expect(response.status).toBe(201);
    const params = vi.mocked(createCollaborationInvitation).mock.calls[0]?.[1];
    expect(params).toMatchObject({ roomId: ROOM_ID, role: "viewer", maxUses: 10 });
    const dayMs = 24 * 60 * 60 * 1000;
    expect(params?.expiresAt).toBeGreaterThanOrEqual(before + dayMs);
    expect(params?.expiresAt).toBeLessThanOrEqual(Date.now() + dayMs);
  });
});

describe("PATCH /rooms/:roomId/members/:userId", () => {
  const MEMBER_ID = "20000000-0000-4000-8000-000000000002";

  it("tells the room the role_version the update itself wrote", async () => {
    vi.mocked(updateCollaborationMemberRole).mockResolvedValue({
      member: {
        user_id: MEMBER_ID,
        role: "editor",
        username: "member",
        name: null,
        avatar_url: null,
        joined_at: 1,
        updated_at: 2,
      },
      roleVersion: 7,
    });
    vi.mocked(notifyCollaborationRoomControl).mockResolvedValue(true);
    const executionContext = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    };

    const response = await collaborationRoute.request(
      `https://nexteditor.dev/rooms/${ROOM_ID}/members/${MEMBER_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "editor" }),
      },
      { DB: {} } as Env,
      executionContext as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      member: {
        userId: MEMBER_ID,
        role: "editor",
        username: "member",
        name: null,
        avatarUrl: null,
        joinedAt: 1,
        updatedAt: 2,
      },
    });
    expect(updateCollaborationMemberRole).toHaveBeenCalledWith(
      expect.anything(),
      ROOM_ID,
      OWNER_ID,
      MEMBER_ID,
      "editor",
    );
    expect(notifyCollaborationRoomControl).toHaveBeenCalledWith(expect.anything(), ROOM_ID, {
      event: expect.objectContaining({
        kind: "membership-changed",
        roomId: ROOM_ID,
        roleVersion: 7,
        targetUserId: MEMBER_ID,
      }),
      targetRole: "editor",
    });
    expect(getCollaborationRoomAccess).not.toHaveBeenCalled();
  });

  it("answers 404 and tells no one when there is no such member", async () => {
    vi.mocked(updateCollaborationMemberRole).mockResolvedValue(null);

    const response = await collaborationRoute.request(
      `https://nexteditor.dev/rooms/${ROOM_ID}/members/${MEMBER_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      },
      { DB: {} } as Env,
    );

    expect(response.status).toBe(404);
    expect(notifyCollaborationRoomControl).not.toHaveBeenCalled();
  });
});

describe("small JSON bodies", () => {
  it("refuses an invitation claim larger than a few kilobytes before parsing it", async () => {
    const response = await collaborationRoute.request(
      "https://nexteditor.dev/invitations/claim",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "x".repeat(64), padding: "y".repeat(8 * 1024) }),
      },
      { DB: {} } as Env,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "invalid invitation" });
  });

  it("still claims with a well-formed small body", async () => {
    const response = await collaborationRoute.request(
      "https://nexteditor.dev/invitations/claim",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "not-a-valid-token!" }),
      },
      { DB: {} } as Env,
    );

    // Parsed and rejected by the token schema, as before.
    expect(response.status).toBe(400);
  });
});
