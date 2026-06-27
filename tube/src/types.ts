export interface Lesson {
  slug: string;
  title: string;
  description: string;
  thumbnail: string;
  ne: string;
  duration?: string;
  tags?: string[];
  author?: string;
  publishedAt?: string;
}

export interface LessonsManifest {
  lessons: Lesson[];
}
