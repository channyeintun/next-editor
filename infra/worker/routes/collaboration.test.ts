import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_SQLITE_PERSISTENCE_VERSION,
} from "../../../src/collaboration/protocol";
import {
  createCollaborationInvitation,
  createProvisioningCollaborationRoom,
  getCollaborationAsset,
  getCollaborationRoomAccess,
  recordCollaborationAuditEvent,
  setCollaborationRoomStatus,
  updateCollaborationMemberRole,
  type CollaborationRoomAccess,
  type CollaborationRoomRow,
} from "../../db/collaborationQueries";
import { getCurrentUser } from "../auth/session";
import { publishCollaborationMaintenanceJob } from "../collaboration/qstash";
import {
  claimClosedRoomCleanup,
  confirmClosedRoomCleanup,
  forwardCollaborationWebSocket,
  notifyCollaborationRoomControl,
} from "../collaboration/roomDurableObject";
import type { Env } from "../env";
import { collaborationRoute } from "./collaboration";

vi.mock("../auth/session", () => ({
  SESSION_COOKIE: "ne_session",
  getCurrentUser: vi.fn<typeof getCurrentUser>(),
}));

vi.mock("../../db/collaborationQueries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/collaborationQueries")>()),
  createCollaborationInvitation: vi.fn<typeof createCollaborationInvitation>(),
  createProvisioningCollaborationRoom: vi.fn<typeof createProvisioningCollaborationRoom>(),
  getCollaborationAsset: vi.fn<typeof getCollaborationAsset>(),
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
  // undici cannot build a 101 response, so the forwarded upgrade answers 204.
  forwardCollaborationWebSocket: vi.fn<typeof forwardCollaborationWebSocket>(
    async () => new Response(null, { status: 204 }),
  ),
  claimClosedRoomCleanup: vi.fn<typeof claimClosedRoomCleanup>(async () => true),
  confirmClosedRoomCleanup: vi.fn<typeof confirmClosedRoomCleanup>(async () => undefined),
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

/** An execution context that keeps what the route hands to waitUntil. */
function collectingExecutionContext() {
  const pending: Promise<unknown>[] = [];
  const executionContext = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  };
  return {
    executionContext: executionContext as unknown as ExecutionContext,
    settled: () => Promise.all(pending),
  };
}

/** POSTs /close and waits for everything the route handed to waitUntil. */
async function closeRoom(): Promise<Response> {
  const { executionContext, settled } = collectingExecutionContext();
  const response = await collaborationRoute.request(
    `https://nexteditor.dev/rooms/${ROOM_ID}/close`,
    { method: "POST" },
    { DB: {} } as Env,
    executionContext,
  );
  await settled();
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: OWNER_ID } as never);
  vi.mocked(claimClosedRoomCleanup).mockResolvedValue(true);
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

describe("POST /rooms", () => {
  /**
   * POSTs a new room whose Durable Object answers each SQLite request with
   * `statusFor(path)`, and waits for everything handed to waitUntil.
   * `requests` lists what the room object was asked, in order.
   */
  async function createRoom(statusFor: (path: string) => number) {
    const requests: string[] = [];
    const stub = {
      fetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
        async (input, init) => {
          const path = new URL(input).pathname;
          requests.push(`${init?.method ?? "GET"} ${path}`);
          return new Response(null, { status: statusFor(path) });
        },
      ),
    };
    const env = { DB: {}, COLLABORATION_ROOMS: { getByName: () => stub } } as unknown as Env;
    const { executionContext, settled } = collectingExecutionContext();
    const response = await collaborationRoute.request(
      "https://nexteditor.dev/rooms",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
          clientId: OWNER_ID,
          updateId: ROOM_ID,
          snapshot: "AAAA",
        }),
      },
      env,
      executionContext,
    );
    await settled();
    return { response, requests };
  }

  beforeEach(() => {
    vi.mocked(createProvisioningCollaborationRoom).mockResolvedValue(
      room({ status: "provisioning" }),
    );
    vi.mocked(setCollaborationRoomStatus).mockResolvedValue(room({ status: "failed" }));
    // The route logs the failed seed, and the second test a failed purge.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The room object may have stored the creator's snapshot even though the
  // Worker saw the call fail. A failed room is never joined, closed or swept,
  // so without this purge that copy of their project stayed for good.
  it("purges the room's document after answering when seeding it fails", async () => {
    const { response, requests } = await createRoom((path) =>
      path === "/sqlite/initialize" ? 500 : 204,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "failed to initialize collaboration room" });
    expect(setCollaborationRoomStatus).toHaveBeenCalledWith(expect.anything(), ROOM_ID, "failed");
    expect(requests).toEqual(["POST /sqlite/initialize", "POST /sqlite/purge"]);
  });

  it("only logs a purge that fails too", async () => {
    const { response, requests } = await createRoom(() => 500);

    expect(response.status).toBe(503);
    expect(requests).toEqual(["POST /sqlite/initialize", "POST /sqlite/purge"]);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to purge failed collaboration room",
      expect.objectContaining({ roomId: ROOM_ID }),
    );
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

  // Each repeat close used to publish the purge job again, with no bound: an
  // owner could spend the QStash budget every room's purge shares.
  it("does not publish the purge again once the room says it is scheduled", async () => {
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(
      ownerAccess({ status: "closed", closed_at: CLOSED_AT }),
    );
    vi.mocked(notifyCollaborationRoomControl).mockResolvedValue(true);
    vi.mocked(claimClosedRoomCleanup).mockResolvedValue(false);

    expect((await closeRoom()).status).toBe(200);
    expect(claimClosedRoomCleanup).toHaveBeenCalledWith(expect.anything(), ROOM_ID, CLOSED_AT);
    expect(publishCollaborationMaintenanceJob).not.toHaveBeenCalled();
    expect(notifyCollaborationRoomControl).toHaveBeenCalledOnce();
  });

  it("tells the room once the purge is published", async () => {
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(ownerAccess());
    vi.mocked(setCollaborationRoomStatus).mockResolvedValue(
      room({ status: "closed", closed_at: CLOSED_AT }),
    );
    vi.mocked(notifyCollaborationRoomControl).mockResolvedValue(true);

    expect((await closeRoom()).status).toBe(200);
    expect(confirmClosedRoomCleanup).toHaveBeenCalledWith(expect.anything(), ROOM_ID, CLOSED_AT);
  });

  it("leaves the purge unconfirmed when publishing fails, so a repeat close retries it", async () => {
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(
      ownerAccess({ status: "closed", closed_at: CLOSED_AT }),
    );
    vi.mocked(notifyCollaborationRoomControl).mockResolvedValue(true);
    vi.mocked(publishCollaborationMaintenanceJob).mockRejectedValueOnce(new Error("quota"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await closeRoom()).status).toBe(200);
    expect(confirmClosedRoomCleanup).not.toHaveBeenCalled();
    vi.mocked(console.error).mockRestore();
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

// A closed room's document and assets are kept seven days. When its purge
// was never scheduled they stayed, and members could still read them.
describe("a closed room past its retention", () => {
  const ASSET_ID = "a".repeat(64);
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const expired = () =>
    ownerAccess({ status: "closed", closed_at: Date.now() - RETENTION_MS - 1000 });
  const env = () =>
    ({
      DB: {},
      BUCKET: { get: async () => ({ body: "asset", httpEtag: '"etag"' }) },
      COLLABORATION_ROOMS: {
        getByName: () => ({ fetch: async () => Response.json({ snapshot: {} }) }),
      },
    }) as unknown as Env;

  it("no longer serves its assets even though its purge has not run", async () => {
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(expired());
    vi.mocked(getCollaborationAsset).mockResolvedValue({
      room_id: ROOM_ID,
      asset_id: ASSET_ID,
      size: 5,
      mime_type: "image/png",
      uploaded_by: OWNER_ID,
      created_at: 1,
    });

    const response = await collaborationRoute.request(
      `https://nexteditor.dev/rooms/${ROOM_ID}/assets/${ASSET_ID}`,
      { method: "GET" },
      env(),
    );

    expect(response.status).toBe(404);
  });

  it("no longer exports its document even though its purge has not run", async () => {
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue(expired());

    const response = await collaborationRoute.request(
      `https://nexteditor.dev/rooms/${ROOM_ID}/export`,
      { method: "GET" },
      env(),
    );

    expect(response.status).toBe(410);
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

describe("GET /rooms/:roomId/websocket", () => {
  const EDITOR_ID = "20000000-0000-4000-8000-000000000002";
  const SOCKET_QUERY =
    "sessionId=30000000-0000-4000-8000-000000000001" +
    "&attemptId=40000000-0000-4000-8000-000000000001&binaryProtocolVersion=3";

  const AUTH_SESSION_ID = "50000000-0000-4000-8000-000000000001";

  function upgrade(origin: string | null, cookie: string | null = `ne_session=${AUTH_SESSION_ID}`) {
    return collaborationRoute.request(
      `https://nexteditor.dev/rooms/${ROOM_ID}/websocket?${SOCKET_QUERY}`,
      {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          ...(origin === null ? {} : { Origin: origin }),
          ...(cookie === null ? {} : { Cookie: cookie }),
        },
      },
      { DB: {}, COLLABORATION_ROOMS: {}, PUBLIC_URL: "https://nexteditor.dev" } as unknown as Env,
    );
  }

  beforeEach(() => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: EDITOR_ID,
      username: "dummy-editor",
      name: "Dummy Editor",
      avatar_url: null,
    } as never);
    vi.mocked(getCollaborationRoomAccess).mockResolvedValue({
      ...ownerAccess(),
      member_role: "editor",
    });
  });

  // Browsers apply no CORS to WebSockets and the session cookie is ambient,
  // so a socket opened from another origin, or from a sandboxed frame (whose
  // Origin is "null"), would otherwise read and write the room as whoever is
  // signed in. The voice socket has always refused these.
  it.each(["null", "https://attacker.test"])(
    "refuses an upgrade from Origin %s before it reads the session",
    async (origin) => {
      const response = await upgrade(origin);

      expect(response.status).toBe(403);
      expect(forwardCollaborationWebSocket).not.toHaveBeenCalled();
      expect(getCurrentUser).not.toHaveBeenCalled();
    },
  );

  it("forwards an upgrade from the app's own origin with the member's session", async () => {
    const response = await upgrade("https://nexteditor.dev");

    expect(response.status).toBe(204);
    expect(forwardCollaborationWebSocket).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ roomId: ROOM_ID, userId: EDITOR_ID, role: "editor" }),
    );
  });

  // The room object rechecks the sign-in session for as long as the socket
  // is open, so signing out ends it.
  it("binds the forwarded session to the sign-in session that opened it", async () => {
    await upgrade("https://nexteditor.dev");

    expect(forwardCollaborationWebSocket).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ authSessionId: AUTH_SESSION_ID }),
    );
  });

  it("answers 401 to an upgrade without a session cookie", async () => {
    const response = await upgrade("https://nexteditor.dev", null);

    expect(response.status).toBe(401);
    expect(forwardCollaborationWebSocket).not.toHaveBeenCalled();
  });
});
