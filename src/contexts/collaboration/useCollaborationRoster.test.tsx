import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  CollaborationInvitation,
  CollaborationInviteRole,
  CollaborationMember,
  CreatedCollaborationInvitation,
} from "../../collaboration/protocol";
import type { CollaborationRoomProvider } from "../../collaboration/roomProvider";
import { useCollaborationRoster } from "./useCollaborationRoster";

const infra = vi.hoisted(() => ({
  createCollaborationInvitation:
    vi.fn<
      (
        roomId: string,
        input: { role: CollaborationInviteRole },
      ) => Promise<CreatedCollaborationInvitation>
    >(),
  listCollaborationInvitations: vi.fn<(roomId: string) => Promise<CollaborationInvitation[]>>(),
  listCollaborationMembers:
    vi.fn<(roomId: string) => Promise<{ members: CollaborationMember[]; roleVersion: number }>>(),
  removeCollaborationMember: vi.fn<(roomId: string, userId: string) => Promise<void>>(),
  revokeCollaborationInvitation: vi.fn<(roomId: string, invitationId: string) => Promise<void>>(),
  updateCollaborationMemberRole:
    vi.fn<
      (
        roomId: string,
        userId: string,
        role: CollaborationInviteRole,
      ) => Promise<CollaborationMember>
    >(),
}));

vi.mock("@next-editor/infra", () => infra);

const ROOM_A = "20000000-0000-4000-8000-00000000000a";
const ROOM_B = "20000000-0000-4000-8000-00000000000b";
const SHARED_USER = "30000000-0000-4000-8000-000000000001";

function ownerProvider(roomId: string): CollaborationRoomProvider {
  return {
    session: { room: { id: roomId }, membership: { role: "owner" } },
  } as unknown as CollaborationRoomProvider;
}

function invitation(id: string, roomId: string): CreatedCollaborationInvitation {
  return {
    id,
    roomId,
    role: "editor",
    maxUses: 10,
    useCount: 0,
    expiresAt: 2,
    revokedAt: null,
    createdAt: 1,
    token: "t".repeat(32),
  };
}

function member(userId: string, role: CollaborationMember["role"]): CollaborationMember {
  return {
    userId,
    role,
    username: "ada",
    name: "Ada",
    avatarUrl: null,
    joinedAt: 1,
    updatedAt: 1,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

/**
 * Renders the roster for room A, then lets `start` begin a change there and
 * moves to room B the way the collaboration provider does: a new provider
 * generation, an emptied roster, and room B's lists loaded.
 */
function renderRoster() {
  const providerRef = { current: ownerProvider(ROOM_A) };
  const providerGenerationRef = { current: 1 };
  const flushCurrentEdits = vi
    .fn<(provider: CollaborationRoomProvider) => Promise<void>>()
    .mockResolvedValue(undefined);
  const view = renderHook(() =>
    useCollaborationRoster(providerRef, providerGenerationRef, flushCurrentEdits),
  );
  const moveToRoomB = async (
    members: CollaborationMember[],
    invitations: CollaborationInvitation[],
  ) => {
    providerGenerationRef.current += 1;
    providerRef.current = ownerProvider(ROOM_B);
    act(() => view.result.current.resetRoster());
    infra.listCollaborationMembers.mockResolvedValueOnce({ members, roleVersion: 1 });
    infra.listCollaborationInvitations.mockResolvedValueOnce(invitations);
    await act(() =>
      view.result.current.refreshRoomDataFor(ROOM_B, true, providerGenerationRef.current),
    );
  };
  return { view, moveToRoomB };
}

describe("useCollaborationRoster", () => {
  beforeEach(() => {
    for (const mock of Object.values(infra)) mock.mockReset();
  });

  it("adds a new invitation to the room it was created in", async () => {
    const { view } = renderRoster();
    infra.createCollaborationInvitation.mockResolvedValueOnce(invitation("inv-a", ROOM_A));
    await act(() => view.result.current.createInvitation("editor"));
    expect(view.result.current.invitations.map((item) => item.id)).toEqual(["inv-a"]);
  });

  it("keeps an invitation created in one room out of the next room's list", async () => {
    const { view, moveToRoomB } = renderRoster();
    const created = deferred<CreatedCollaborationInvitation>();
    infra.createCollaborationInvitation.mockReturnValueOnce(created.promise);
    const pending = view.result.current.createInvitation("editor");

    await moveToRoomB([], [invitation("inv-b", ROOM_B)]);
    created.resolve(invitation("inv-a", ROOM_A));
    // The caller still gets the invitation it created.
    await act(async () => {
      await expect(pending).resolves.toMatchObject({ id: "inv-a" });
    });

    expect(view.result.current.invitations.map((item) => item.id)).toEqual(["inv-b"]);
  });

  it("keeps a role change made in one room off the next room's member row", async () => {
    const { view, moveToRoomB } = renderRoster();
    const updated = deferred<CollaborationMember>();
    infra.updateCollaborationMemberRole.mockReturnValueOnce(updated.promise);
    const pending = view.result.current.updateMemberRole(SHARED_USER, "editor");

    await moveToRoomB([member(SHARED_USER, "viewer")], []);
    updated.resolve(member(SHARED_USER, "editor"));
    await act(() => pending);

    expect(view.result.current.members).toEqual([member(SHARED_USER, "viewer")]);
  });

  it("keeps a member removed from one room in the next room's list", async () => {
    const { view, moveToRoomB } = renderRoster();
    const removed = deferred<void>();
    infra.removeCollaborationMember.mockReturnValueOnce(removed.promise);
    const pending = view.result.current.removeMember(SHARED_USER);

    await moveToRoomB([member(SHARED_USER, "viewer")], []);
    removed.resolve();
    await act(() => pending);

    expect(view.result.current.members).toEqual([member(SHARED_USER, "viewer")]);
  });

  it("keeps a revoke in one room from touching the next room's list", async () => {
    const { view, moveToRoomB } = renderRoster();
    const revoked = deferred<void>();
    infra.revokeCollaborationInvitation.mockReturnValueOnce(revoked.promise);
    const pending = view.result.current.revokeInvitation("inv-shared");

    // Contrived shared id: only the generation check tells the rooms apart.
    await moveToRoomB([], [invitation("inv-shared", ROOM_B)]);
    revoked.resolve();
    await act(() => pending);

    expect(view.result.current.invitations.map((item) => item.id)).toEqual(["inv-shared"]);
  });
});
