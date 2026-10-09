import { useId, useRef, useState } from "react";
import {
  Check,
  Copy,
  Crown,
  Headphones,
  Link2,
  LogOut,
  Mic,
  MicOff,
  Radio,
  RefreshCw,
  UserMinus,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { avatarProxyUrl, signInUrl, useAuth } from "@next-editor/infra";
import { useCollaboration, type CollaborationParticipant } from "../contexts/CollaborationContext";
import {
  useCollaborationVoice,
  useCollaborationVoiceState,
} from "../contexts/CollaborationVoiceContext";
import { collaborationParticipantKey } from "../collaboration/participantKey";
import { collaborationParticipantColorIndex } from "../collaboration/relativePosition";
import type { CollaborationInviteRole, CollaborationSurface } from "../collaboration/protocol";
import type { VoiceClientErrorCode } from "../voice/machine";
import { COLLABORATOR_DOT_CLASSES, collaboratorDisplayName } from "./collaboratorAppearance";

const STATUS_LABELS = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  syncing: "Syncing…",
  live: "Live",
  reconnecting: "Reconnecting…",
  failed: "Connection failed",
} as const;

const VOICE_STATUS_LABELS = {
  idle: "Not in voice",
  joining: "Connecting…",
  listening: "Listening",
  unmuting: "Enabling microphone…",
  live: "Live",
  reconnecting: "Reconnecting…",
  failed: "Voice failed",
  leaving: "Leaving…",
  unavailable: "Unavailable",
} as const;

const VOICE_ERROR_COPY: Partial<Record<VoiceClientErrorCode, string>> = {
  "microphone-permission-denied":
    "Microphone access was denied. Allow the microphone in your browser settings, then try again.",
  "microphone-unavailable": "No usable microphone was found. Check your device and try again.",
  network: "The voice connection failed. Document collaboration is unaffected.",
  capacity: "The voice room is full.",
  "rate-limited": "Voice is briefly rate limited. Try again in a moment.",
};

function voiceErrorCopy(code: VoiceClientErrorCode): string {
  return VOICE_ERROR_COPY[code] ?? "Voice is temporarily unavailable. Try again.";
}

// Voice controls live in their own component so speaking/roster updates
// rerender only the voice UI, never the surrounding panel or editor.
function VoiceControls() {
  const voice = useCollaborationVoice();
  const state = useCollaborationVoiceState();

  if (state.state === "unavailable") {
    if (state.unavailableReason === "unsupported-browser") {
      return (
        <p className="rounded-lg border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-[11px] text-slate-300">
          Voice chat is not supported in this browser. Document collaboration still works.
        </p>
      );
    }
    return null;
  }

  const status = VOICE_STATUS_LABELS[state.state];
  const inVoice = state.state !== "idle";
  const canJoin = state.state === "idle";
  const showMute =
    state.state === "live" ||
    state.state === "unmuting" ||
    (state.state === "reconnecting" && state.wantsMicrophone);
  const showUnmute =
    state.state === "listening" || (state.state === "reconnecting" && !state.wantsMicrophone);
  // Mute and Unmute are one button, so React keeps its DOM node, and the
  // keyboard focus on it, when one replaces the other. Join stays separate:
  // a second press on Join must never turn the microphone on.
  const micToggle = showMute
    ? {
        label: "Mute",
        Icon: MicOff,
        onClick: voice.mute,
        className: "bg-amber-500/15 text-amber-200 hover:bg-amber-500/25",
      }
    : showUnmute
      ? {
          label: "Unmute",
          Icon: Mic,
          onClick: voice.unmute,
          className: "bg-sky-500/15 text-sky-200 hover:bg-sky-500/25",
        }
      : null;

  return (
    <section
      aria-label="Voice chat"
      className="rounded-lg border border-slate-700/70 bg-slate-950/30 p-3"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5 text-slate-300">
          <Headphones size={13} aria-hidden="true" /> Voice
        </span>
        <span
          role="status"
          className={
            state.state === "live" || state.state === "listening"
              ? "text-emerald-300"
              : state.state === "failed"
                ? "text-rose-300"
                : "text-amber-300"
          }
        >
          {status}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {canJoin ? (
          <button
            type="button"
            onClick={voice.join}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25"
          >
            <Headphones size={13} aria-hidden="true" /> Join voice
          </button>
        ) : null}
        {micToggle ? (
          <button
            key="mic-toggle"
            type="button"
            onClick={micToggle.onClick}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${micToggle.className}`}
          >
            <micToggle.Icon size={13} aria-hidden="true" /> {micToggle.label}
          </button>
        ) : null}
        {state.state === "failed" ? (
          <button
            type="button"
            onClick={voice.retry}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/25"
          >
            <RefreshCw size={13} aria-hidden="true" /> Retry voice
          </button>
        ) : null}
        {inVoice && state.state !== "leaving" ? (
          <button
            type="button"
            onClick={voice.leave}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/10"
          >
            <LogOut size={13} aria-hidden="true" /> Leave voice
          </button>
        ) : null}
      </div>

      {state.autoplayBlocked ? (
        <button
          type="button"
          onClick={voice.enableAudio}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-violet-500/15 px-3 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-500/25"
        >
          <Volume2 size={13} aria-hidden="true" /> Enable audio
        </button>
      ) : null}

      {state.errorCode ? (
        <p role="alert" className="mt-2 text-[11px] leading-4 text-rose-200">
          {voiceErrorCopy(state.errorCode)}
        </p>
      ) : null}

      {state.state === "listening" ? (
        <p className="mt-2 text-[10px] leading-4 text-slate-300">
          You are muted. Others cannot hear you until you unmute.
        </p>
      ) : null}
    </section>
  );
}

// Per-row voice indicator, correlated by canonical user + session identity
// (never by display name).
function VoiceParticipantBadge({ userId, sessionId }: { userId: string; sessionId: string }) {
  const state = useCollaborationVoiceState();
  const entry = state.roster.find(
    (candidate) =>
      candidate.participant.userId === userId &&
      candidate.participant.collaborationSessionId === sessionId,
  );
  if (!entry) return null;
  const publishing = entry.participant.publishedTrack !== null && !entry.participant.muted;
  const speaking = publishing && (entry.isSelf ? state.isLocalSpeaking : entry.isSpeaking);
  if (!publishing) {
    return (
      <span
        role="img"
        aria-label="In voice, muted"
        title="In voice, muted"
        className="text-slate-500"
      >
        <MicOff size={13} />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={speaking ? "Speaking" : "In voice"}
      title={speaking ? "Speaking" : "In voice"}
      className={speaking ? "text-emerald-300 motion-safe:animate-pulse" : "text-emerald-400/80"}
    >
      <Mic size={13} />
    </span>
  );
}

interface InvitationPromptProps {
  isAccepting: boolean;
  /** Why the last claim failed, shown where the user pressed Join. */
  error: string | null;
  onAccept: () => void;
  onDecline: () => void;
}

/**
 * Joining a room reprojects its document over the local workspace, which
 * auto-starts the runtime and runs that project's package scripts. That must
 * never happen from a bare link, so a `?invite=` token is staged and only
 * claimed from this prompt's Join button.
 */
function InvitationPrompt({ isAccepting, error, onAccept, onDecline }: InvitationPromptProps) {
  const descriptionId = useId();
  return (
    <div
      role="dialog"
      aria-label="Collaboration invitation"
      aria-describedby={descriptionId}
      className="absolute right-0 top-10 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-700 bg-[#171b25] p-4 text-left shadow-2xl"
    >
      <h2 className="text-sm font-semibold text-white">Join this collaboration room?</h2>
      <p id={descriptionId} className="mt-2 text-xs leading-relaxed text-slate-300">
        Accepting replaces your current workspace with the room&apos;s files and runs that project.
        Your name and what you have open become visible to everyone in the room.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={isAccepting}
          onClick={onAccept}
          className="inline-flex h-8 flex-1 items-center justify-center rounded-lg bg-emerald-500/20 px-3 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/30 disabled:opacity-50"
        >
          {isAccepting ? "Joining…" : "Join room"}
        </button>
        <button
          type="button"
          disabled={isAccepting}
          onClick={onDecline}
          className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
        >
          Not now
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type CollaborationContextValue = ReturnType<typeof useCollaboration>;

interface ParticipantRowProps {
  participant: CollaborationParticipant;
  /**
   * What the participant has open. The panel works it out on every render
   * (describeParticipantSurface) rather than this row, which is memoized.
   */
  surfaceLabel: string;
  isSelf: boolean;
  isFollowed: boolean;
  onFollow: () => void;
  onStopFollowing: () => void;
}

/** One person in the online list: who they are, where they are, and a follow toggle. */
function ParticipantRow({
  participant,
  surfaceLabel,
  isSelf,
  isFollowed,
  onFollow,
  onStopFollowing,
}: ParticipantRowProps) {
  const colorIndex = collaborationParticipantColorIndex(participant);
  const name = collaboratorDisplayName(participant);
  return (
    <li className="flex items-center gap-2 rounded-lg bg-white/3 px-2.5 py-2">
      {participant.avatarUrl ? (
        <img src={avatarProxyUrl(participant.avatarUrl)} alt="" className="size-6 rounded-full" />
      ) : (
        <span className={`size-2.5 rounded-full ${COLLABORATOR_DOT_CLASSES[colorIndex]}`} />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-slate-200">
          {name}
          {isSelf ? " (you)" : ""}
        </span>
        <span className="block truncate text-[10px] text-slate-300">{surfaceLabel}</span>
      </span>
      <VoiceParticipantBadge userId={participant.actorId} sessionId={participant.sessionId} />
      {participant.isHost ? <Crown size={13} className="text-amber-300" aria-label="Host" /> : null}
      <span className="text-[10px] capitalize text-slate-300">{participant.role}</span>
      {!isSelf ? (
        // A toggle keeps one name and lets aria-pressed carry the state; the
        // name holds both visible labels ("Follow", "Following"), and the
        // title keeps the action as the hover hint.
        <button
          type="button"
          aria-label={`Following ${name}`}
          aria-pressed={isFollowed}
          title={isFollowed ? `Stop following ${name}` : `Follow ${name}`}
          onClick={() => (isFollowed ? onStopFollowing() : onFollow())}
          className={`rounded px-2 py-1 text-[10px] font-semibold ${
            isFollowed ? "bg-sky-400 text-slate-950" : "bg-white/5 text-slate-300 hover:bg-white/10"
          }`}
        >
          {isFollowed ? "Following" : "Follow"}
        </button>
      ) : null}
    </li>
  );
}

/**
 * What a participant has open, for their row in the online list. A file's
 * name comes from getPathForNodeId, which reads the room's current project
 * projection: no prop, state or context change announces a rename, so call
 * this on every render, never from memoized code.
 */
function describeParticipantSurface(
  surface: CollaborationSurface,
  collaboration: Pick<
    CollaborationContextValue,
    "isTeachingLoading" | "teachingSlides" | "teaching" | "getPathForNodeId"
  >,
): string {
  if (surface.kind === "slides") {
    if (collaboration.isTeachingLoading) return "Loading shared slide…";
    if (collaboration.teachingSlides === null) {
      return "Shared slide unavailable";
    }
    const index = collaboration.teaching.currentSlideId
      ? collaboration.teaching.slideOrder.indexOf(collaboration.teaching.currentSlideId)
      : -1;
    return index >= 0
      ? `Slides · ${index + 1}/${collaboration.teaching.slideOrder.length}`
      : "Slides";
  }
  if (surface.kind === "whiteboard") return "Whiteboard";
  if (!surface.fileNodeId) return "Editor";
  const path = collaboration.getPathForNodeId(surface.fileNodeId);
  return path?.split("/").at(-1) ?? "Editor";
}

interface RoomOwnerSectionProps {
  isBusy: boolean;
  /** Runs a room action under the panel's busy flag and error message. */
  run: (operation: () => Promise<unknown>) => Promise<void>;
  shareUrl: string | null;
  copied: boolean;
  onCreateShareLink: (role: CollaborationInviteRole) => Promise<void>;
  onCopyShareUrl: () => Promise<void>;
}

/**
 * What only the room owner manages: invitation links, members and their
 * roles, the active invitations, and the recovery export. The last share link
 * and its "copied" flag stay in the panel, which is always mounted, so they
 * survive closing and reopening it.
 */
function RoomOwnerSection({
  isBusy,
  run,
  shareUrl,
  copied,
  onCreateShareLink,
  onCopyShareUrl,
}: RoomOwnerSectionProps) {
  const collaboration = useCollaboration();

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

  return (
    <>
      <section>
        <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-300">
          Invite people
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void onCreateShareLink("editor")}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-500/15 text-xs font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-50 p-2"
          >
            <Link2 size={13} /> Editor link
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void onCreateShareLink("viewer")}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-violet-500/15 text-xs font-semibold text-violet-200 hover:bg-violet-500/25 disabled:opacity-50 p-2"
          >
            <Link2 size={13} /> Viewer link
          </button>
        </div>
        {shareUrl ? (
          <button
            type="button"
            onClick={() => void onCopyShareUrl()}
            className="mt-2 flex w-full items-center gap-2 rounded-lg border border-slate-700 px-2.5 py-2 text-left text-[11px] text-slate-300 hover:bg-white/3"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {/* The copy icon is hidden from assistive tech, so the action is
                spelled out ahead of the visible link. The space sits outside
                the hidden span because a name drops an element's own trailing
                whitespace. */}
            {copied ? null : (
              <>
                <span className="sr-only">Copy invitation link:</span>{" "}
              </>
            )}
            <span className="min-w-0 flex-1 truncate">
              {copied ? "Copied invitation link" : shareUrl}
            </span>
          </button>
        ) : null}
        <p className="mt-1.5 text-[10px] leading-4 text-slate-300">
          Invitation tokens are shown only when created. Revoke unused links below.
        </p>
      </section>

      <section>
        <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-300">
          Members
        </h3>
        {/* The panel's lists keep an explicit role="list": Tailwind's preflight
            sets list-style: none, and Safari then drops the list role. */}
        <ul role="list" className="space-y-1.5">
          {collaboration.members.map((member) => (
            <li key={member.userId} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-slate-300">
                {collaboratorDisplayName(member)}
              </span>
              {member.role === "owner" ? (
                <span className="text-[10px] text-amber-300">owner · host</span>
              ) : (
                <>
                  <select
                    aria-label={`Role for ${collaboratorDisplayName(member)}`}
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
                    aria-label={`Remove ${collaboratorDisplayName(member)}`}
                    disabled={isBusy}
                    onClick={() => void run(() => collaboration.removeMember(member.userId))}
                    className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                  >
                    <UserMinus size={13} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      {collaboration.invitations.length > 0 ? (
        <section>
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-300">
            Active invitation records
          </h3>
          <ul role="list" className="space-y-1">
            {collaboration.invitations
              .filter((invitation) => invitation.revokedAt === null)
              .map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex items-center justify-between text-[11px] text-slate-300"
                >
                  <span className="capitalize">
                    {invitation.role} · {invitation.useCount}/{invitation.maxUses} used
                  </span>
                  <button
                    type="button"
                    aria-label={`Revoke ${invitation.role} invitation, ${invitation.useCount} of ${invitation.maxUses} used`}
                    disabled={isBusy}
                    onClick={() => void run(() => collaboration.revokeInvitation(invitation.id))}
                    className="inline-flex min-h-6 items-center rounded px-1.5 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <button
        type="button"
        disabled={isBusy}
        onClick={() => void downloadRecoveryExport()}
        className="w-full rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/3 disabled:opacity-50"
      >
        Export room recovery snapshot
      </button>
    </>
  );
}

/**
 * Who joined and who left between two snapshots of the online list, for the
 * panel's status region. Never reports this member's own session, and says
 * nothing when either snapshot is empty: entering a room would otherwise read
 * out everyone already in it, and leaving one would read them all out as gone.
 */
function describePresenceChange(
  before: readonly CollaborationParticipant[],
  after: readonly CollaborationParticipant[],
  ownParticipantKey: string | null,
): string {
  if (before.length === 0 || after.length === 0) return "";
  const byKey = (participants: readonly CollaborationParticipant[]) =>
    new Map(
      participants.map((participant) => [collaborationParticipantKey(participant), participant]),
    );
  const beforeByKey = byKey(before);
  const afterByKey = byKey(after);
  const changes = (
    from: Map<string, CollaborationParticipant>,
    to: Map<string, CollaborationParticipant>,
    verb: string,
  ) =>
    [...from]
      .filter(([key]) => key !== ownParticipantKey && !to.has(key))
      .map(([, participant]) => `${collaboratorDisplayName(participant)} ${verb}`);
  return [
    ...changes(afterByKey, beforeByKey, "joined"),
    ...changes(beforeByKey, afterByKey, "left"),
  ].join(". ");
}

export default function CollaborationPanel() {
  const collaboration = useCollaboration();
  const { isSignedIn } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [isBusy, setIsBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  // Joins and leaves are worked out while rendering, against the last roster
  // seen, so the status region updates in the same commit as the list.
  const rosterKey = collaboration.participants.map(collaborationParticipantKey).join("|");
  const [roster, setRoster] = useState({
    key: rosterKey,
    participants: collaboration.participants,
  });
  const [presenceMessage, setPresenceMessage] = useState("");
  if (roster.key !== rosterKey) {
    setRoster({ key: rosterKey, participants: collaboration.participants });
    setPresenceMessage(
      describePresenceChange(
        roster.participants,
        collaboration.participants,
        collaboration.ownParticipantKey,
      ),
    );
  }

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
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setPanelError("The invitation link could not be copied. Select and copy it manually.");
    }
  };

  const isInRoom = Boolean(collaboration.provider);
  const status = STATUS_LABELS[collaboration.connectionState];
  const connectionMessage = isInRoom
    ? `Live collaboration: ${status}${collaboration.hasOfflineChanges ? ", changes waiting" : ""}`
    : "";
  const invitationMessage = collaboration.isAcceptingInvitation
    ? "Joining collaboration room…"
    : collaboration.pendingInviteToken
      ? "Collaboration invitation: join this collaboration room? Use the Join room or Not now buttons in the editor header."
      : "";

  return (
    <div className="relative">
      {/* The panel's one status region. It is mounted with the header button,
          so connection, presence, invitation and copy messages are heard
          whether or not the panel is open. aria-atomic is off so a change to
          one line is read on its own, not together with the others. */}
      <div role="status" aria-atomic="false" className="sr-only">
        <p>{connectionMessage}</p>
        <p>{presenceMessage}</p>
        <p>{invitationMessage}</p>
        <p>{copied ? "Invitation link copied to clipboard." : ""}</p>
      </div>

      {collaboration.pendingInviteToken ? (
        <InvitationPrompt
          isAccepting={collaboration.isAcceptingInvitation}
          error={collaboration.error}
          onAccept={() => void collaboration.acceptInvitation()}
          onDecline={collaboration.declineInvitation}
        />
      ) : null}

      <button
        ref={triggerRef}
        data-tour="collaboration"
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => setIsOpen((current) => !current)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
          isInRoom
            ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
            : "text-slate-300 hover:bg-white/5 hover:text-white"
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
          aria-labelledby={titleId}
          className="absolute right-0 top-10 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-700 bg-[#171b25] text-left shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-slate-700/80 px-4 py-3">
            <div>
              <h2 id={titleId} className="text-sm font-semibold text-white">
                Live collaboration
              </h2>
              <p className="text-[11px] text-slate-300">
                {isInRoom
                  ? `${status} · ${collaboration.role ?? "checking access"}`
                  : "Edit together in real time"}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close collaboration panel"
              onClick={() => {
                // Closing unmounts this button; hand focus back to the opener.
                setIsOpen(false);
                triggerRef.current?.focus();
              }}
              className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
            {!isInRoom ? (
              <div className="space-y-3">
                <p className="text-xs leading-5 text-slate-300">
                  Start from the current project, prepared slides, and whiteboard. Room content is
                  shared while each participant keeps a separate local runtime and view.
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
                {panelError || collaboration.error ? (
                  <div
                    role="alert"
                    className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
                  >
                    <p>{panelError ?? collaboration.error}</p>
                  </div>
                ) : null}
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

                <VoiceControls />

                {collaboration.isHost ? (
                  <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
                    You are the room host. Recording is available only in this browser and stays
                    local until live ends.
                  </p>
                ) : null}

                {collaboration.followedParticipant ? (
                  <button
                    type="button"
                    onClick={() => collaboration.stopFollowing("user")}
                    className="flex w-full items-center justify-between rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-100"
                  >
                    <span className="truncate">
                      Following {collaboratorDisplayName(collaboration.followedParticipant)}
                    </span>
                    <span className="font-semibold">Stop</span>
                  </button>
                ) : null}

                {!collaboration.teaching.initialized && collaboration.role === "owner" ? (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void run(() => collaboration.initializeTeachingSurfaces())}
                    className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-100 disabled:opacity-50"
                  >
                    Initialize room slides and whiteboard
                  </button>
                ) : null}

                <section>
                  <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-300">
                    Online now
                  </h3>
                  {collaboration.participants.length === 0 ? (
                    <p className="text-xs text-slate-300">Waiting for presence…</p>
                  ) : (
                    <ul role="list" className="space-y-1.5">
                      {collaboration.participants.map((participant) => {
                        const participantKey = collaborationParticipantKey(participant);
                        return (
                          <ParticipantRow
                            key={participantKey}
                            participant={participant}
                            surfaceLabel={describeParticipantSurface(
                              participant.surface,
                              collaboration,
                            )}
                            isSelf={participantKey === collaboration.ownParticipantKey}
                            isFollowed={participantKey === collaboration.followedParticipantKey}
                            onFollow={() => collaboration.followParticipant(participant)}
                            onStopFollowing={() => collaboration.stopFollowing("user")}
                          />
                        );
                      })}
                    </ul>
                  )}
                </section>

                {collaboration.role === "owner" ? (
                  <RoomOwnerSection
                    isBusy={isBusy}
                    run={run}
                    shareUrl={shareUrl}
                    copied={copied}
                    onCreateShareLink={createShareLink}
                    onCopyShareUrl={copyShareUrl}
                  />
                ) : null}

                {panelError || collaboration.error ? (
                  <div
                    role="alert"
                    className="space-y-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
                  >
                    <p>{panelError ?? collaboration.error}</p>
                    {collaboration.error && collaboration.canRetryAssets ? (
                      <button
                        type="button"
                        onClick={collaboration.retryAssets}
                        className="inline-flex items-center gap-1 font-semibold text-sky-200 hover:text-sky-100"
                      >
                        <RefreshCw size={12} /> Retry shared assets
                      </button>
                    ) : null}
                  </div>
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
