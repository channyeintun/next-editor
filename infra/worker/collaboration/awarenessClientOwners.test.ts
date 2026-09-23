import { afterEach, describe, expect, it } from "vitest";
import { SqliteTestStorage } from "../testing/sqliteStorage";
import { AwarenessClientOwners } from "./awarenessClientOwners";

const MEMBER_ID = "20000000-0000-4000-8000-000000000002";
const PEER_ID = "20000000-0000-4000-8000-000000000003";
const DAY_MS = 24 * 60 * 60 * 1000;

const openStorages: SqliteTestStorage[] = [];

afterEach(() => {
  for (const storage of openStorages.splice(0)) storage.close();
});

function createOwners(): { storage: SqliteTestStorage; owners: AwarenessClientOwners } {
  const storage = new SqliteTestStorage();
  openStorages.push(storage);
  return { storage, owners: new AwarenessClientOwners(storage) };
}

/** The client IDs stored for `userId`, in ascending order. */
function storedClientIds(storage: SqliteTestStorage, userId: string): number[] {
  return storage.sql
    .exec<{ client_id: number }>(
      `SELECT client_id FROM collaboration_awareness_clients
       WHERE user_id = ? ORDER BY client_id`,
      userId,
    )
    .toArray()
    .map((row) => row.client_id);
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, index) => start + index);
}

describe("AwarenessClientOwners", () => {
  it("keeps a client ID for the member who claimed it first", () => {
    const { owners } = createOwners();

    expect(owners.claim(7, MEMBER_ID, 1_000)).toBe(true);
    expect(owners.claim(7, MEMBER_ID, 2_000)).toBe(true);
    expect(owners.claim(7, PEER_ID, 3_000)).toBe(false);
  });

  it("frees a client ID 30 days after its owner last claimed it", () => {
    const { owners } = createOwners();
    owners.claim(7, MEMBER_ID, 0);
    owners.claim(7, MEMBER_ID, 20 * DAY_MS);

    expect(owners.claim(7, PEER_ID, 50 * DAY_MS - 1)).toBe(false);
    expect(owners.claim(7, PEER_ID, 50 * DAY_MS)).toBe(true);
  });

  it("keeps at most 16 client IDs per member, the newest ones", () => {
    const { storage, owners } = createOwners();
    owners.claim(7, PEER_ID, 0);

    for (const clientId of range(100, 120)) owners.claim(clientId, MEMBER_ID, clientId);

    expect(storedClientIds(storage, MEMBER_ID)).toEqual(range(104, 120));
    expect(storedClientIds(storage, PEER_ID)).toEqual([7]);
  });

  it("keeps the client ID just claimed when every claim has the same time", () => {
    const { storage, owners } = createOwners();

    for (const clientId of range(100, 120)) {
      expect(owners.claim(clientId, MEMBER_ID, 5_000)).toBe(true);
      expect(storedClientIds(storage, MEMBER_ID)).toContain(clientId);
    }
    expect(storedClientIds(storage, MEMBER_ID)).toHaveLength(16);
  });
});
