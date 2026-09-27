/**
 * The message to show for a failed collaboration call: the error string of an
 * axios-style `response.data.error` body, else the error's own message, else
 * `fallback`.
 */
export function messageFromError(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const responseMessage = (error as { response?: { data?: { error?: unknown } } }).response?.data
      ?.error;
    if (typeof responseMessage === "string") return responseMessage;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
