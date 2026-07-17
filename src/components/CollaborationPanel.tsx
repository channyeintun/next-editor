import { useState } from "react";
import { Check, Copy, Crown, Link2, Radio, RefreshCw, UserMinus, Users, X } from "lucide-react";
import { avatarProxyUrl, signInUrl, useAuth } from "@next-editor/infra";
import { useCollaboration } from "../contexts/CollaborationContext";
import { collaborationParticipantColorIndex } from "../collaboration/relativePosition";
import type { CollaborationInviteRole } from "../collaboration/protocol";

const STATUS_LABELS = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  syncing: "Syncing…",
  live: "Live",
  reconnecting: "Reconnecting…",
  failed: "Connection failed",
} as const;

const PARTICIPANT_COLORS = [
  "bg-sky-400",
  "bg-emerald-400",
  "bg-amber-400",
  "bg-fuchsia-400",
  "bg-cyan-400",
  "bg-orange-400",
  "bg-violet-400",
  "bg-lime-400",
] as const;

function displayName(person: { name: string | null; username: string }): string {
  return person.name?.trim() || person.username;
}

export default function CollaborationPanel() {
  const collaboration = useCollaboration();
  const { isSignedIn } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  const run = async (operation: () => Promise<unknown>) => {
    setIsBusy(true);
    setPanelError(null);
    collaboration.clearError();
    try {
      await operation();
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Collaboration action failed.");
    } finally {
      setIsBusy(false);
    }
  };

  const createShareLink = async (role: CollaborationInviteRole) => {
    await run(async () => {
      const invitation = await collaboration.createInvitation(role);
      const url = new URL("/code", window.location.origin);
      url.searchParams.set("invite", invitation.token);
      setShareUrl(url.toString());
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  };

  const copyShareUrl = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  const downloadRecoveryExport = async () => {
    await run(async () => {
      const blob = await collaboration.exportRoom();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `collaboration-${collaboration.session?.room.id ?? "room"}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
    });
  };

  const isInRoom = Boolean(collaboration.provider);
  const status = STATUS_LABELS[collaboration.connectionState];

  return (
    <div className="relative">
      <button
        data-tour="collaboration"
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => setIsOpen((current) => !current)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
          isInRoom
            ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
            : "text-slate-400 hover:bg-white/5 hover:text-white"
        }`}
        title={isInRoom ? status : "Start live collaboration"}
      >
        {isInRoom ? <Radio size={15} /> : <Users size={15} />}
        <span>{isInRoom ? status : "Live"}</span>
        {collaboration.participants.length > 0 ? (
          <span className="rounded-full bg-white/10 px-1.5 text-[10px] text-slate-200">
            {collaboration.participants.length}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div
          role="dialog"
          aria-label="Live collaboration"
          className="absolute right-0 top-10 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-700 bg-[#171b25] text-left shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-slate-700/80 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-white">Live collaboration</p>
              <p className="text-[11px] text-slate-400">
                {isInRoom
                  ? `${status} · ${collaboration.role ?? "checking access"}`
                  : "Edit together in real time"}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close collaboration panel"
              onClick={() => setIsOpen(false)}
              className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
            {!isInRoom ? (
              <div className="space-y-3">
                <p className="text-xs leading-5 text-slate-300">
                  Start from the current project. Text and file-tree changes are shared; each
                  participant keeps a separate local runtime.
                </p>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    if (!isSignedIn) {
                      window.location.assign(signInUrl(window.location.href));
                      return;
                    }
                    void run(() => collaboration.createRoom());
                  }}
                  className="w-full rounded-lg bg-emerald-400 px-3 py-2 text-xs font-bold text-slate-950 hover:bg-emerald-300 disabled:opacity-50"
                >
                  {isSignedIn ? "Start live room" : "Sign in to start live"}
                </button>
              </div>
            ) : (
              <>
                <div className="rounded-lg border border-slate-700/70 bg-slate-950/30 p-3">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-slate-300">Connection</span>
                    <span
                      className={
                        collaboration.connectionState === "live"
                          ? "text-emerald-300"
                          : collaboration.connectionState === "failed"
                            ? "text-rose-300"
                            : "text-amber-300"
                      }
                    >
                      {status}
                      {collaboration.hasOfflineChanges ? " · changes waiting" : ""}
                    </span>
                  </div>
                  {collaboration.connectionState === "failed" ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void run(() => collaboration.retry())}
                      className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-sky-300 hover:text-sky-200"
                    >
                      <RefreshCw size={13} /> Retry connection
                    </button>
                  ) : null}
                </div>

                {!collaboration.isHost ? (
                  <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-700/70 px-3 py-2 text-xs text-slate-200">
                    Follow host’s active file
                    <input
                      type="checkbox"
                      checked={collaboration.isFollowingHost}
                      onChange={(event) => collaboration.setFollowingHost(event.target.checked)}
                      className="accent-emerald-400"
                    />
                  </label>
                ) : (
                  <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
                    You are the room host. Recording is available only in this browser and stays
                    local until live ends.
                  </p>
                )}

                <section>
                  <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Online now
                  </h3>
                  <div className="space-y-1.5">
                    {collaboration.participants.length === 0 ? (
                      <p className="text-xs text-slate-500">Waiting for presence…</p>
                    ) : (
                      collaboration.participants.map((participant) => {
                        const color = collaborationParticipantColorIndex(participant);
                        return (
                          <div
                            key={`${participant.actorId}:${participant.sessionId}`}
                            className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-2"
                          >
                            {participant.avatarUrl ? (
                              <img
                                src={avatarProxyUrl(participant.avatarUrl)}
                                alt=""
                                className="size-6 rounded-full"
                              />
                            ) : (
                              <span
                                className={`size-2.5 rounded-full ${PARTICIPANT_COLORS[color]}`}
                              />
                            )}
                            <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
                              {displayName(participant)}
                            </span>
                            {participant.isHost ? (
                              <Crown size={13} className="text-amber-300" aria-label="Host" />
                            ) : null}
                            <span className="text-[10px] capitalize text-slate-500">
                              {participant.role}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>

                {collaboration.role === "owner" ? (
                  <>
                    <section>
                      <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                        Invite people
                      </h3>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void createShareLink("editor")}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-500/15 px-2 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-50"
                        >
                          <Link2 size={13} /> Editor link
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void createShareLink("viewer")}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-violet-500/15 px-2 py-2 text-xs font-semibold text-violet-200 hover:bg-violet-500/25 disabled:opacity-50"
                        >
                          <Link2 size={13} /> Viewer link
                        </button>
                      </div>
                      {shareUrl ? (
                        <button
                          type="button"
                          onClick={() => void copyShareUrl()}
                          className="mt-2 flex w-full items-center gap-2 rounded-lg border border-slate-700 px-2.5 py-2 text-left text-[11px] text-slate-300 hover:bg-white/[0.03]"
                        >
                          {copied ? <Check size={13} /> : <Copy size={13} />}
                          <span className="min-w-0 flex-1 truncate">
                            {copied ? "Copied invitation link" : shareUrl}
                          </span>
                        </button>
                      ) : null}
                      <p className="mt-1.5 text-[10px] leading-4 text-slate-500">
                        Invitation tokens are shown only when created. Revoke unused links below.
                      </p>
                    </section>

                    <section>
                      <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                        Members
                      </h3>
                      <div className="space-y-1.5">
                        {collaboration.members.map((member) => (
                          <div key={member.userId} className="flex items-center gap-2 text-xs">
                            <span className="min-w-0 flex-1 truncate text-slate-300">
                              {displayName(member)}
                            </span>
                            {member.role === "owner" ? (
                              <span className="text-[10px] text-amber-300">owner · host</span>
                            ) : (
                              <>
                                <select
                                  aria-label={`Role for ${displayName(member)}`}
                                  value={member.role}
                                  disabled={isBusy}
                                  onChange={(event) =>
                                    void run(() =>
                                      collaboration.updateMemberRole(
                                        member.userId,
                                        event.target.value as CollaborationInviteRole,
                                      ),
                                    )
                                  }
                                  className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-[11px] text-slate-300"
                                >
                                  <option value="editor">Editor</option>
                                  <option value="viewer">Viewer</option>
                                </select>
                                <button
                                  type="button"
                                  aria-label={`Remove ${displayName(member)}`}
                                  disabled={isBusy}
                                  onClick={() =>
                                    void run(() => collaboration.removeMember(member.userId))
                                  }
                                  className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                                >
                                  <UserMinus size={13} />
                                </button>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </section>

                    {collaboration.invitations.length > 0 ? (
                      <section>
                        <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          Active invitation records
                        </h3>
                        <div className="space-y-1">
                          {collaboration.invitations
                            .filter((invitation) => invitation.revokedAt === null)
                            .map((invitation) => (
                              <div
                                key={invitation.id}
                                className="flex items-center justify-between text-[11px] text-slate-400"
                              >
                                <span className="capitalize">
                                  {invitation.role} · {invitation.useCount}/{invitation.maxUses}{" "}
                                  used
                                </span>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() =>
                                    void run(() => collaboration.revokeInvitation(invitation.id))
                                  }
                                  className="text-rose-300 hover:text-rose-200"
                                >
                                  Revoke
                                </button>
                              </div>
                            ))}
                        </div>
                      </section>
                    ) : null}

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void downloadRecoveryExport()}
                      className="w-full rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/[0.03] disabled:opacity-50"
                    >
                      Export room recovery snapshot
                    </button>
                  </>
                ) : null}

                {panelError || collaboration.error ? (
                  <p
                    role="alert"
                    className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
                  >
                    {panelError ?? collaboration.error}
                  </p>
                ) : null}

                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() =>
                    void run(async () => {
                      if (collaboration.isHost) await collaboration.closeRoom();
                      else await collaboration.leaveRoom();
                    })
                  }
                  className="w-full rounded-lg border border-rose-500/30 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-50"
                >
                  {collaboration.isHost ? "End live room" : "Leave room"}
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
