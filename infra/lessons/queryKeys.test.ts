import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";
import { lessonKeys, playlistKeys, primeLessonDetails } from "./queryKeys";
import type { Lesson } from "./types";

// The SSR payload already dehydrated into served documents, and prefix
// invalidation between tube and infra, both depend on these exact values.
describe("lesson and playlist query keys", () => {
  it("keeps the lesson keys' values", () => {
    expect(lessonKeys.infinite).toEqual(["lessons", "infinite"]);
    expect(lessonKeys.mine).toEqual(["lessons", "mine"]);
    expect(lessonKeys.detail("rust-ownership")).toEqual(["lessons", "detail", "rust-ownership"]);
  });

  it("keeps the playlist keys' values", () => {
    expect(playlistKeys.all).toEqual(["playlists"]);
    expect(playlistKeys.mine).toEqual(["playlists", "mine"]);
    expect(playlistKeys.forLesson("l1")).toEqual(["playlists", "mine", "for-lesson", "l1"]);
    expect(playlistKeys.members("p1")).toEqual(["playlists", "members", "p1"]);
    expect(playlistKeys.detail("intro")).toEqual(["playlists", "detail", "intro"]);
  });

  // A playlist mutation invalidates playlistKeys.all and relies on React Query's
  // prefix match to reach every playlist query, tube's public detail included.
  it("puts every playlist key under playlistKeys.all", () => {
    const keys = [
      playlistKeys.mine,
      playlistKeys.forLesson("l1"),
      playlistKeys.members("p1"),
      playlistKeys.detail("intro"),
    ];
    for (const key of keys) {
      expect(key.slice(0, playlistKeys.all.length)).toEqual(playlistKeys.all);
    }
  });
});

describe("primeLessonDetails", () => {
  it("seeds each lesson's detail query from a list", () => {
    const queryClient = new QueryClient();
    const lessons: Lesson[] = ["a", "b"].map((slug) => ({
      slug,
      title: slug,
      description: "",
      thumbnail: `lessons/${slug}/thumb.webp`,
      ne: `lessons/${slug}/lesson.ne`,
    }));

    primeLessonDetails(queryClient, lessons);

    expect(queryClient.getQueryData(lessonKeys.detail("a"))).toBe(lessons[0]);
    expect(queryClient.getQueryData(lessonKeys.detail("b"))).toBe(lessons[1]);
  });
});
