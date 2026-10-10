import axios from "axios";

// Same-origin by design (see docs/cloudflare-architecture.md) — the browser
// already sends cookies on same-origin requests, so no withCredentials needed.
export const apiClient = axios.create({ baseURL: "/api" });

// The one "this resource doesn't exist" test, for reads that resolve a miss to
// null instead of an error (author profiles, tube's catalog lookups).
export function isNotFoundError(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 404;
}
