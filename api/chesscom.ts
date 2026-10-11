// Serverless proxy: GET /api/chesscom?id=<game id or uuid>
//
// The browser cannot call chess.com directly (no CORS headers), so this route
// fetches the live-game payload and passes it through. The Vite dev server
// mounts the same fetcher (see vite.config.ts).

const ID_PATTERN = /^(\d{6,20}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface ProxyResult {
  status: number;
  body: unknown;
  cacheable: boolean;
}

export async function fetchChessComGame(id: string): Promise<ProxyResult> {
  if (!ID_PATTERN.test(id)) {
    return { status: 400, body: { error: "Expected a chess.com game id" }, cacheable: false };
  }
  let response: Response;
  try {
    response = await fetch(`https://www.chess.com/callback/live/game/${id}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { status: 502, body: { error: "chess.com did not respond" }, cacheable: false };
  }
  if (response.status === 404) {
    return { status: 404, body: { error: "Game not found (or still in progress)" }, cacheable: false };
  }
  if (!response.ok) {
    return { status: 502, body: { error: `chess.com returned ${response.status}` }, cacheable: false };
  }
  let body: { game?: { isFinished?: boolean } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { status: 502, body: { error: "chess.com returned an unexpected response" }, cacheable: false };
  }
  return { status: 200, body, cacheable: !!body.game?.isFinished };
}

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const result = await fetchChessComGame(id);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      "Content-Type": "application/json",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": result.cacheable ? "public, max-age=3600, s-maxage=604800" : "no-store",
    },
  });
}
