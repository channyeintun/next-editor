import { describe, expect, it, vi } from "vite-plus/test";
import type { LessonScript } from "../script/schema";
import {
  MODAL_VOXCPM2_BURMESE_PROFILE,
  modalVoxCpm2BurmeseProfileOf,
  VOICE_PROFILES,
  type VoiceProfile,
} from "../tts/profiles";
import { NARRATION_REQUEST_PACK_FORMAT, narrationPackEngineOf } from "./packFormat";
import {
  buildNarrationRequestPack,
  type NarrationPackLesson,
  type NarrationRequestPackDeps,
} from "./requestPack";

const narrator = modalVoxCpm2BurmeseProfileOf({ id: "voice-1", sampleSha256: "a".repeat(64) });
const NOW = new Date("2026-11-14T03:40:42.000Z");

/** A lesson the stand-in Director narrates as `<slug> dialog N`, hashed `<slug>#N`. */
function lessonOf(slug: string, voiceProfile: VoiceProfile = narrator): NarrationPackLesson {
  return { slug, script: { build: { seed: slug.length } } as LessonScript, voiceProfile };
}

function depsOf({
  dialogsPerLesson = 2,
  cached = new Set<string>(),
  texts = {} as Record<string, string>,
}: {
  dialogsPerLesson?: number;
  cached?: Set<string>;
  texts?: Record<string, string>;
} = {}) {
  const slugOf = new Map<LessonScript, string>();
  const deps = {
    requestsOf: vi.fn<NarrationRequestPackDeps["requestsOf"]>(async (script, options) => {
      const slug = slugOf.get(script) ?? "";
      return {
        profile: options?.voiceProfile ?? VOICE_PROFILES["pocket-alba-v1"],
        requests: Array.from({ length: dialogsPerLesson }, (_, index) => {
          const requestHash = `${slug}#${index + 1}`;
          return {
            requestHash,
            speechText: texts[requestHash] ?? `${slug} dialog ${index + 1}`,
            seed: script.build.seed,
            label: `dialog ${index + 1}/${dialogsPerLesson} "${slug}.${index}"`,
          };
        }),
      };
    }),
    hasCached: vi.fn<NarrationRequestPackDeps["hasCached"]>(async (hash) => cached.has(hash)),
    referenceWavBase64: vi.fn<NarrationRequestPackDeps["referenceWavBase64"]>(
      async () => "UkVGRVJFTkNF",
    ),
    cacheAvailable: vi.fn<NarrationRequestPackDeps["cacheAvailable"]>(() => true),
  } satisfies NarrationRequestPackDeps;
  const lessons = (...slugs: string[]) =>
    slugs.map((slug) => {
      const lesson = lessonOf(slug);
      slugOf.set(lesson.script, slug);
      return lesson;
    });
  return { deps, lessons, slugOf };
}

describe("buildNarrationRequestPack", () => {
  it("packs each lesson's requests with the narrator's reference and the engine they need", async () => {
    const { deps, lessons } = depsOf();

    const exported = await buildNarrationRequestPack(lessons("intro", "loops"), { now: NOW, deps });

    expect(exported).toMatchObject({
      lessonCount: 2,
      dialogCount: 4,
      cachedCount: 0,
      cacheUnavailable: null,
      characterCount: "intro dialog 1".length * 2 + "loops dialog 1".length * 2,
    });
    expect(exported.pack).toEqual({
      format: NARRATION_REQUEST_PACK_FORMAT,
      version: 1,
      createdAt: "2026-11-14T03:40:42.000Z",
      engine: narrationPackEngineOf(MODAL_VOXCPM2_BURMESE_PROFILE),
      reference: { sampleRate: 24000, wavBase64: "UkVGRVJFTkNF" },
      dialogs: [
        { hash: "intro#1", lesson: "intro", text: "intro dialog 1", seed: 5 },
        { hash: "intro#2", lesson: "intro", text: "intro dialog 2", seed: 5 },
        { hash: "loops#1", lesson: "loops", text: "loops dialog 1", seed: 5 },
        { hash: "loops#2", lesson: "loops", text: "loops dialog 2", seed: 5 },
      ],
    });
    // The Director is asked with the voice the render of that lesson gets.
    expect(deps.requestsOf).toHaveBeenCalledWith(expect.anything(), { voiceProfile: narrator });
    expect(deps.referenceWavBase64).toHaveBeenCalledExactlyOnceWith(narrator);
  });

  it("leaves out the dialogs this browser already keeps a take for", async () => {
    const { deps, lessons } = depsOf({ cached: new Set(["intro#1", "loops#2"]) });

    const exported = await buildNarrationRequestPack(lessons("intro", "loops"), { now: NOW, deps });

    expect(exported.pack?.dialogs.map((dialog) => dialog.hash)).toEqual(["intro#2", "loops#1"]);
    expect(exported).toMatchObject({ dialogCount: 2, cachedCount: 2 });
  });

  it("has no pack, and reads no reference, when every dialog is already kept", async () => {
    const { deps, lessons } = depsOf({ cached: new Set(["intro#1", "intro#2"]) });

    const exported = await buildNarrationRequestPack(lessons("intro"), { now: NOW, deps });

    expect(exported).toMatchObject({ pack: null, dialogCount: 0, cachedCount: 2 });
    expect(deps.referenceWavBase64).not.toHaveBeenCalled();
  });

  it("packs every dialog and says so when the browser cannot tell what it keeps", async () => {
    const { deps, lessons } = depsOf();
    deps.hasCached.mockImplementation(async (_hash, onUnavailable) => {
      onUnavailable?.("QuotaExceededError");
      return false;
    });

    const exported = await buildNarrationRequestPack(lessons("intro"), { now: NOW, deps });

    expect(exported).toMatchObject({ dialogCount: 2, cacheUnavailable: "QuotaExceededError" });
  });

  it("says so when this page has no Cache storage to import the audio into", async () => {
    const { deps, lessons } = depsOf();
    deps.cacheAvailable.mockReturnValue(false);

    const exported = await buildNarrationRequestPack(lessons("intro"), { now: NOW, deps });

    expect(exported).toMatchObject({
      dialogCount: 2,
      cacheUnavailable: "Cache storage is not available in this page",
    });
  });

  it("asks once for a request two lessons share", async () => {
    const { deps, lessons, slugOf } = depsOf();
    const [first, second] = lessons("intro", "intro-again");
    slugOf.set(second.script, "intro");

    const exported = await buildNarrationRequestPack([first, second], { now: NOW, deps });

    expect(exported.pack?.dialogs.map((dialog) => dialog.hash)).toEqual(["intro#1", "intro#2"]);
    expect(deps.hasCached).toHaveBeenCalledTimes(2);
  });

  it("refuses a lesson that another voice narrates, naming it", async () => {
    const { deps, lessons, slugOf } = depsOf();
    const english = lessonOf("go-swap", VOICE_PROFILES["pocket-alba-v1"]);
    slugOf.set(english.script, "go-swap");

    await expect(
      buildNarrationRequestPack([...lessons("intro"), english], { now: NOW, deps }),
    ).rejects.toThrow('"go-swap" is not narrated by VoxCPM2');
  });

  it("refuses lessons that do not share a narrator", async () => {
    const { deps, lessons, slugOf } = depsOf();
    const other = lessonOf(
      "loops",
      modalVoxCpm2BurmeseProfileOf({ id: "voice-2", sampleSha256: "b".repeat(64) }),
    );
    slugOf.set(other.script, "loops");

    await expect(
      buildNarrationRequestPack([...lessons("intro"), other], { now: NOW, deps }),
    ).rejects.toThrow('"loops" uses another narrator');
  });

  it("refuses a dialog VoxCPM2 would refuse, naming the lesson and the dialog", async () => {
    const { deps, lessons } = depsOf({ texts: { "loops#2": "x".repeat(2001) } });

    await expect(
      buildNarrationRequestPack(lessons("intro", "loops"), { now: NOW, deps }),
    ).rejects.toThrow(
      '"loops", dialog 2/2 "loops.1": this dialog is 2001 characters long, and VoxCPM2 speaks at most 2000 per request',
    );
  });
});
