import axios from "axios";

// Same-origin by design (see docs/cloudflare-architecture.md) — the browser
// already sends cookies on same-origin requests, so no withCredentials needed.
export const apiClient = axios.create({ baseURL: "/api" });
