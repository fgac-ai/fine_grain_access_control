/** Plain-text OpenAI domain-verification response; see src/app/.well-known/openai-apps-challenge/route.ts. */
export function challengeResponse(token: string | undefined): Response {
  const value = token?.trim();
  if (!value) return new Response('Not found\n', { status: 404 });
  return new Response(value, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
