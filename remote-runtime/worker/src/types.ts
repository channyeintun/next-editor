export interface Env {
  RUNTIME_GO_SESSIONS: DurableObjectNamespace;
  RUNTIME_QUOTAS: D1Database;
  RUNTIME_SESSION_SECRET: string;
  PREVIEW_URL_TEMPLATE: string;
  MAX_CONCURRENT_SESSIONS: string;
  MAX_DAILY_MINUTES: string;
}

export interface AuthClaims { userId: string; exp: number }

export interface SessionRecord {
  sessionId: string;
  userId: string;
  runtime: "go1.26.5";
  createdAt: number;
}
