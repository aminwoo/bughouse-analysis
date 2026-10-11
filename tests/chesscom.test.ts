import { describe, expect, it } from "vitest";
import { decodeTcn, elapsedTimes, importChessComGames, parseChessComId, type ChessComGame } from "../src/lib/chesscom";
import gameA from "./fixtures/159878252255.json";
import gameB from "./fixtures/159878252253.json";

describe("decodeTcn", () => {
  it("decodes ordinary moves", () => {
    // e2e4 e7e5 g1f3
    expect(decodeTcn("mC0Kgv")).toEqual(["e2e4", "e7e5", "g1f3"]);
  });

  it("decodes drops", () => {
    expect(decodeTcn("=B-S&C*a+h")).toEqual(["P@d4", "N@e6", "Q@e4", "R@a1", "B@h1"]);
  });

  it("decodes promotions with file offsets", () => {
    // a7 is 'W'; '{' = queen to the left, '~' = queen straight, '}' = queen right; '(' knight left.
    expect(decodeTcn("X~")).toEqual(["b7b8q"]);
    expect(decodeTcn("X{")).toEqual(["b7a8q"]);
    expect(decodeTcn("X}")).toEqual(["b7c8q"]);
    expect(decodeTcn("j^")).toEqual(["b2b1n"]);
  });
});

describe("parseChessComId", () => {
  it.each([
    ["159878252255", "159878252255"],
    ["https://www.chess.com/game/live/159878252255", "159878252255"],
    ["https://www.chess.com/live/game/159878252255?move=3", "159878252255"],
    ["chess.com/game/live/159878252255", "159878252255"],
    ["f7ce9e28-d789-11f0-9508-a0369feff220", "f7ce9e28-d789-11f0-9508-a0369feff220"],
  ])("%s", (input, id) => {
    expect(parseChessComId(input)).toBe(id);
  });

  it("rejects junk", () => {
    expect(parseChessComId("hello")).toBeNull();
  });
});

describe("elapsedTimes", () => {
  it("reconstructs time since the start from remaining clocks", () => {
    // White spends 2s, black 3s, white 1s (deciseconds, base 30s).
    expect(elapsedTimes([280, 270, 270], 300, 0)).toEqual([20, 50, 60]);
  });
});

describe("importChessComGames", () => {
  const imported = importChessComGames(gameA as unknown as ChessComGame, gameB as unknown as ChessComGame);

  it("maps players by colour on both boards", () => {
    expect(imported.players.aWhite.username).toBe("vjbaker");
    expect(imported.players.aBlack.username).toBe("Emeraldddd");
    expect(imported.players.bWhite.username).toBe("chickencrossroad");
    expect(imported.players.bBlack.username).toBe("MARVELandDCforLIFE");
  });

  it("reads the result as a team result", () => {
    expect(imported.result.winner).toBe("white-team");
  });

  it("decodes both boards", () => {
    expect(imported.boards.A.moves).toHaveLength(56);
    expect(imported.boards.B.moves).toHaveLength(40);
    expect(imported.boards.A.moves[0]).toBe("e2e4");
  });
});
