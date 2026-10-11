import { describe, expect, it } from "vitest";
import { importChessComGames, type ChessComGame } from "../src/lib/chesscom";
import { buildFromImport } from "../src/lib/game";
import { buildTree, engineMoves, playMove } from "../src/lib/tree";
import gameA from "./fixtures/159878252255.json";
import gameB from "./fixtures/159878252253.json";

const game = buildFromImport(importChessComGames(gameA as unknown as ChessComGame, gameB as unknown as ChessComGame));

describe("buildFromImport", () => {
  it("replays every move of both boards", () => {
    expect(game.moves).toHaveLength(96);
    expect(game.droppedMoves).toBe(0);
  });

  it("orders moves by time", () => {
    for (let i = 1; i < game.moves.length; i++) {
      expect(game.moves[i].elapsed).toBeGreaterThanOrEqual(game.moves[i - 1].elapsed);
    }
  });

  it("ends in mate on board B", () => {
    const tree = buildTree(game);
    const last = tree.nodes.get(tree.mainline[tree.mainline.length - 1])!;
    expect(last.move?.san).toBe("Qxe2#");
    expect(last.position.isMate("B")).toBe(true);
  });

  it("tracks the mover's reported clock", () => {
    const first = game.moves[0];
    expect(first.board).toBe("A");
    expect(first.clocks.A.white).toBe(1800);
    const last = game.moves[game.moves.length - 1];
    expect(last.clocks.B.black).toBeLessThan(1800);
  });
});

describe("tree", () => {
  it("builds engine move lists with board prefixes", () => {
    const tree = buildTree(game);
    expect(engineMoves(tree, tree.mainline[3])).toEqual(["1e2e4", "1g8f6", "2d2d4"]);
  });

  it("adds variations and reuses existing children", () => {
    const tree = buildTree(game);
    const same = playMove(tree, tree.rootId, "A", "e2e4")!;
    expect(same.id).toBe(tree.mainline[1]);
    const variation = playMove(tree, tree.rootId, "B", "e2e4")!;
    expect(variation.id).not.toBe(tree.mainline[1]);
    expect(variation.tree.nodes.get(tree.rootId)!.children).toHaveLength(2);
    expect(playMove(tree, tree.rootId, "A", "e2e5")).toBeNull();
  });
});
