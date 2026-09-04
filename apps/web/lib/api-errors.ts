/** Consistent API error envelope - see docs/agent-api.md "Error format".
 *  Never leak raw DB/exception messages to a client. */
export function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
