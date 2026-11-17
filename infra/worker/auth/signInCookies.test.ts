// The sign-in cookies carry the `__Host-` prefix over https, so a page on a
// subdomain (lesson code runs on subdomains) cannot set one this host reads.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { deleteSession, getLiveSession, type LiveSession } from "../../db/queries";
import type { UserRow } from "../../db/types";
import { googleAuthRoute } from "./google";
import { authRoute } from "./session";

vi.mock("../../db/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/queries")>()),
  getLiveSession: vi.fn<(db: D1Database, id: string) => Promise<LiveSession | null>>(),
  deleteSession: vi.fn<(db: D1Database, id: string) => Promise<void>>(),
}));

const env = {
  DB: {} as D1Database,
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  PUBLIC_URL: "https://nexteditor.dev",
  SESSION_SECRET: "session-secret",
} as never;

/** Who /me says the request is: the session id it looked up, or null when it looked none up. */
async function sessionRead(url: string, cookie: string): Promise<string | null> {
  vi.mocked(getLiveSession).mockClear();
  await authRoute.request(url, { headers: { cookie } }, env);
  return vi.mocked(getLiveSession).mock.calls[0]?.[1] ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLiveSession).mockResolvedValue({
    user: { id: "user-1" } as UserRow,
    signedInAt: 0,
  });
});

describe("the session cookie over https", () => {
  const me = "https://nexteditor.dev/me";

  it("is read under its __Host- name", async () => {
    expect(await sessionRead(me, "__Host-ne_session=victim")).toBe("victim");
  });

  it("is not read under the bare name a subdomain can set", async () => {
    // document.cookie = "ne_session=attacker; Domain=nexteditor.dev" on a preview host.
    expect(await sessionRead(me, "ne_session=attacker")).toBeNull();
    const response = await authRoute.request(
      me,
      { headers: { cookie: "ne_session=attacker" } },
      env,
    );
    expect(response.status).toBe(401);
  });

  it("is the visitor's own, whatever a subdomain put in front of it", async () => {
    expect(await sessionRead(me, "ne_session=attacker; __Host-ne_session=victim")).toBe("victim");
    expect(await sessionRead(me, "__Host-ne_session=victim; ne_session=attacker")).toBe("victim");
  });

  it("is cleared under its __Host- name, with the attributes the prefix needs", async () => {
    const response = await authRoute.request(
      "https://nexteditor.dev/logout",
      { method: "POST", headers: { cookie: "__Host-ne_session=victim" } },
      env,
    );
    expect(deleteSession).toHaveBeenCalledWith(expect.anything(), "victim");
    const cleared = response.headers.getSetCookie().join("\n");
    expect(cleared).toMatch(/^__Host-ne_session=;/);
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("Secure");
    expect(cleared).not.toMatch(/Domain=/i);
  });

  it("does not end a session named only by a bare cookie", async () => {
    await authRoute.request(
      "https://nexteditor.dev/logout",
      { method: "POST", headers: { cookie: "ne_session=someone-else" } },
      env,
    );
    expect(deleteSession).not.toHaveBeenCalled();
  });
});

describe("the session cookie over plain http, in local development", () => {
  it("goes by its bare name, since the prefix needs Secure", async () => {
    expect(await sessionRead("http://localhost:8787/me", "ne_session=dev")).toBe("dev");
    expect(await sessionRead("http://localhost:8787/me", "__Host-ne_session=dev")).toBeNull();
  });
});

describe("the Google sign-in handshake cookie over https", () => {
  async function login() {
    const response = await googleAuthRoute.request("https://nexteditor.dev/login", {}, env);
    const cookie = response.headers.getSetCookie()[0]!;
    const state = new URL(response.headers.get("location")!).searchParams.get("state")!;
    return { cookie, state };
  }

  it("is set under its __Host- name, for this host alone", async () => {
    const { cookie } = await login();
    expect(cookie).toMatch(/^__Host-ne_oauth=/);
    expect(cookie).toContain("Path=/;");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("is not taken under the bare name, even validly signed", async () => {
    // An attacker's own handshake, planted on the visitor from a subdomain,
    // would otherwise sign the visitor in as the attacker.
    const { cookie, state } = await login();
    const planted = cookie.split(";")[0]!.replace("__Host-ne_oauth=", "ne_oauth=");
    const response = await googleAuthRoute.request(
      `https://nexteditor.dev/callback?code=attacker-code&state=${state}`,
      { headers: { cookie: planted } },
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("expired handshake");
  });
});
