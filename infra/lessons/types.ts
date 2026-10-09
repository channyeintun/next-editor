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
