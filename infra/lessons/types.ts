// The lesson and playlist shapes the Worker serves and the client renders.
// They live with the other shared lesson rules, not in the tube UI package, so
// the Worker and the DB layer do not depend on the UI for their data types.

export interface Lesson {
  slug: string;
  title: string;
  description: string;
  thumbnail: string;
  ne: string;
  duration?: string;
  tags?: string[];
  author?: string;
  /** Author's profile URL — makes the author name a link on the lesson card. */
  authorUrl?: string;
  publishedAt?: string;
}

/** A public, always-visible ordered collection of the owner's own lessons. */
export interface Playlist {
  slug: string;
  title: string;
  description: string;
  lessons: Lesson[];
}

/**
 * A public playlist as a card shows it: its link, its cover and how many
 * lessons it holds, without the lessons themselves. `lessonCount` counts the
 * published members only, which is what the playlist's own page shows.
 */
export interface PlaylistSummary {
  slug: string;
  title: string;
  description: string;
  lessonCount: number;
  /** Cover image — the first published member's thumbnail, or null. */
  thumbnail: string | null;
  /** The owner's display name, or username without one. Only the gallery
   *  sends it: its cards are of many authors. */
  author?: string;
  /** The owner's profile URL — makes the author name a link on the card. */
  authorUrl?: string;
}

/**
 * One card of the public gallery. A playlist stands in for the lessons it
 * holds; a lesson in no playlist is its own card.
 */
export type GalleryItem =
  | { kind: "lesson"; lesson: Lesson }
  | { kind: "playlist"; playlist: PlaylistSummary };
