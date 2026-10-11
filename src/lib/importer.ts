// Loads a bughouse game and its partner board from chess.com via /api/chesscom.

import { importChessComGames, parseChessComId, type ChessComGame } from "./chesscom";
import { buildFromImport, type GameRecord } from "./game";

async function fetchGame(id: string): Promise<ChessComGame | null> {
  const response = await fetch(`${import.meta.env.BASE_URL}api/chesscom?id=${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as ChessComGame;
}

function isBughouse(game: ChessComGame): boolean {
  return game.game.type === "bughouse" || /bughouse/i.test(game.game.typeName ?? "");
}

async function findPartner(game: ChessComGame): Promise<ChessComGame | null> {
  if (game.game.partnerGameId) {
    const partner = await fetchGame(String(game.game.partnerGameId));
    if (partner) return partner;
  }
  // Older payloads omit the partner id; the partner usually has an adjacent id.
  for (const delta of [-1, 1, -2, 2]) {
    const candidate = await fetchGame(String(game.game.id + delta)).catch(() => null);
    if (!candidate || !isBughouse(candidate)) continue;
    const back = candidate.game.partnerGameId == null ? null : String(candidate.game.partnerGameId);
    if (back === null || back === String(game.game.id) || back === game.game.uuid) return candidate;
  }
  return null;
}

export async function importFromChessCom(input: string, onStatus?: (text: string) => void): Promise<GameRecord> {
  const id = parseChessComId(input);
  if (!id) throw new Error("Paste a chess.com game link or game id.");
  onStatus?.("Fetching game…");
  const game = await fetchGame(id);
  if (!game) throw new Error("chess.com could not find that game (it may still be in progress).");
  if (!isBughouse(game)) throw new Error(`That is a ${game.game.typeName ?? game.game.type ?? "non-bughouse"} game, not bughouse.`);
  onStatus?.("Fetching partner board…");
  const partner = await findPartner(game);
  return buildFromImport(importChessComGames(game, partner));
}
