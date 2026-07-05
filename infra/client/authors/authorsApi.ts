import axios from "axios";
import { apiClient } from "../apiClient";
import type { AuthorSummary } from "../../db/types";
import type { Lesson } from "../../../tube/src/types";

export interface AuthorProfile {
  user: AuthorSummary;
  lessons: Lesson[];
}

// null (not undefined — Query rejects undefined) when the username doesn't
// match any user, so callers can tell "not found" from a real fetch failure.
export async function fetchAuthorProfile(username: string): Promise<AuthorProfile | null> {
  try {
    const res = await apiClient.get<AuthorProfile>(`/authors/${encodeURIComponent(username)}`);
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}
