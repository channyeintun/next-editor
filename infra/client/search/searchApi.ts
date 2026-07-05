import { apiClient } from "../apiClient";
import type { AuthorSummary } from "../../db/types";
import type { Lesson } from "../../../tube/src/types";

export interface SearchResults {
  authors: AuthorSummary[];
  lessons: Lesson[];
}

export async function search(q: string): Promise<SearchResults> {
  const res = await apiClient.get<SearchResults>("/search", { params: { q } });
  return res.data;
}
