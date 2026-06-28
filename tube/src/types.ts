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

export interface LessonsManifest {
  lessons: Lesson[];
}
