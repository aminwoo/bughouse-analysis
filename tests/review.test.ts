import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOVE_TIME_MS,
  gameAccuracy,
  moveAccuracy,
  reviewMoves,
  searchClock,
  summarize,
  teamMoveTimes,
  valueFor,
  volatilityWeights,
  type MoveReview,
  type PositionEval,
} from "../src/lib/review";
import { cpToValue, parseInfo, parseJointMove } from "../src/engine/engineClient";
import type { GameRecord } from "../src/lib/game";

const LEVEL = { leadMs: 0, teamMoveTimeMs: 1000, opponentMoveTimeMs: 1000 };

/** `played` is the restricted search for the game's next move. */
const evalOf = (ply: number, team: "white" | "black", value: number, best: string | null = null, played?: number): PositionEval => ({
  ply,
  team,
  clock: LEVEL,
  search: { value, mate: null, best: best ? { a: best, b: null } : null, pv: [], nodes: 100, played },
});

describe("search clock", () => {
  const clocks = { A: { white: 1500, black: 1400 }, B: { white: 1400, black: 1500 } };
  const moveTimes = { white: 800, black: 2000 };
  it("gives each team its diagonal lead and puts its own move time first", () => {
    expect(searchClock(clocks, "white", moveTimes)).toEqual({ leadMs: 10_000, teamMoveTimeMs: 800, opponentMoveTimeMs: 2000 });
    expect(searchClock(clocks, "black", moveTimes)).toEqual({ leadMs: -10_000, teamMoveTimeMs: 2000, opponentMoveTimeMs: 800 });
  });
  it("searches level clocks when the clocks are unknown", () => {
    expect(searchClock(null, "white", moveTimes).leadMs).toBe(0);
  });
});

describe("teamMoveTimes", () => {
  // thinkTime is in deciseconds; A White and B Black are the white team.
  const move = (board: "A" | "B", color: "white" | "black", thinkTime: number) => ({ board, color, thinkTime });
  it("takes the median think time of each team's moves, within the trained range", () => {
    const game = {
      moves: [
        ...[12, 15, 9, 600, 14].map((t) => move("A", "white", t)),
        ...[1, 0, 1, 0].map((t) => move("B", "white", t)),
      ],
    } as unknown as GameRecord;
    // White's long sit does not count; black's premoves are held at 0.1 s.
    expect(teamMoveTimes(game)).toEqual({ white: 1400, black: 100 });
  });
  it("falls back to the default with too few moves", () => {
    const game = { moves: [move("A", "white", 50)] } as unknown as GameRecord;
    expect(teamMoveTimes(game)).toEqual({ white: DEFAULT_MOVE_TIME_MS, black: DEFAULT_MOVE_TIME_MS });
  });
});

describe("valueFor", () => {
  it("converts the opponents' search into our perspective", () => {
    const e = evalOf(0, "black", 0.9);
    expect(valueFor(e, "black")).toBe(0.9);
    expect(valueFor(e, "white")).toBe(-0.9);
  });
});

describe("reviewMoves", () => {
  const game = {
    moves: [
      { board: "A", color: "white", uci: "e2e4", san: "e4", clocks: null },
      { board: "A", color: "black", uci: "e7e5", san: "e5", clocks: null },
    ],
    startClocks: null,
  } as unknown as GameRecord;

  it("charges a move with how far its own search falls below the best", () => {
    const evals = [evalOf(0, "white", 0.2, "d2d4", -0.3), evalOf(1, "black", 0.3, "e7e5"), evalOf(2, "white", -0.3)];
    const reviews = reviewMoves(game, evals);
    expect(reviews[1]!.before).toBeCloseTo(0.2);
    expect(reviews[1]!.after).toBeCloseTo(-0.3);
    expect(reviews[1]!.loss).toBeCloseTo(0.5);
    expect(reviews[1]!.judgement).toBe("blunder");
    expect(reviews[1]!.best).toBe("d2d4");
    expect(reviews[2]!.loss).toBeCloseTo(0);
  });

  it("does not blame a move the engine itself chose", () => {
    // The next position's value is lower, but the move was the engine's pick.
    const evals = [evalOf(0, "white", 0.2, "e2e4"), evalOf(1, "black", 0.3), evalOf(2, "white", 0)];
    expect(reviewMoves(game, evals)[1]!.loss).toBe(0);
  });

  it("leaves a move unjudged until the position before it is searched", () => {
    const evals = [undefined, evalOf(1, "black", 0, "e7e5")];
    const reviews = reviewMoves(game, evals);
    expect(reviews[1]).toBeNull();
    expect(reviews[2]!.loss).toBe(0);
  });

  it("scores accuracy like lichess", () => {
    expect(moveAccuracy(0, 0)).toBeCloseTo(100, 0);
    expect(moveAccuracy(0.5, -0.5)).toBeLessThan(20);
  });
});

describe("summarize", () => {
  // A White, B White, A Black, B Black, A White: two moves per team plus one.
  const seats = [
    ["A", "white"],
    ["B", "white"],
    ["A", "black"],
    ["B", "black"],
    ["A", "white"],
  ] as const;
  const game = { moves: seats.map(([board, color]) => ({ board, color })) } as unknown as GameRecord;
  const review = (ply: number, accuracy: number, judgement: MoveReview["judgement"] = null) => ({ ply, accuracy, judgement }) as MoveReview;
  const reviews = [null, review(1, 90), review(2, 40, "blunder"), review(3, 70, "inaccuracy"), review(4, 100), review(5, 60, "mistake")];
  // A flat evaluation gives every move the same weight.
  const flat = Array(6).fill(0);

  it("totals each team over both of its players' moves", () => {
    const [white, black] = summarize(game, reviews, flat);
    expect(white.team).toBe("white");
    // A White (plies 1, 5) and B Black (ply 4).
    expect(white.moves).toBe(3);
    expect(white.accuracy).toBeCloseTo(equalWeightAccuracy([90, 60, 100])!);
    expect([white.inaccuracy, white.mistake, white.blunder]).toEqual([0, 1, 0]);
    // A Black (ply 3) and B White (ply 2).
    expect(black.moves).toBe(2);
    expect(black.accuracy).toBeCloseTo(equalWeightAccuracy([70, 40])!);
    expect([black.inaccuracy, black.mistake, black.blunder]).toEqual([1, 0, 1]);
  });

  it("lists each team's players, board A first", () => {
    const [white, black] = summarize(game, reviews, flat);
    expect(white.players.map((p) => `${p.board}${p.color}`)).toEqual(["Awhite", "Bblack"]);
    expect(black.players.map((p) => `${p.board}${p.color}`)).toEqual(["Ablack", "Bwhite"]);
    expect(white.players[0].accuracy).toBeCloseTo(equalWeightAccuracy([90, 60])!);
    expect(black.players[1].blunder).toBe(1);
  });

  it("leaves accuracy empty before any move is reviewed", () => {
    const [white] = summarize(game, [], []);
    expect(white.accuracy).toBeNull();
    expect(white.players[0].moves).toBe(0);
  });
});

describe("lichess accuracy", () => {
  it("scores a move by its win-percentage drop", () => {
    expect(moveAccuracy(0.2, 0.2)).toBe(100);
    expect(moveAccuracy(0.2, 0.3)).toBe(100);
    // A 5-point drop (0.1 in value) scores about 80.8 on lichess's curve.
    expect(moveAccuracy(0.1, 0)).toBeCloseTo(80.82, 1);
    expect(moveAccuracy(1, -1)).toBe(0);
  });

  it("pulls game accuracy down for a bad move more than a plain average does", () => {
    const accs = [100, 100, 100, 100, 100, 100, 100, 100, 100, 30];
    const mean = accs.reduce((s, x) => s + x, 0) / accs.length;
    expect(mean).toBe(93);
    // Harmonic mean 10 / (9/100 + 1/30) = 81.08, averaged with the mean 93.
    expect(equalWeightAccuracy(accs)).toBeCloseTo(87.04, 2);
    expect(equalWeightAccuracy([95, 95])).toBeCloseTo(95);
    expect(gameAccuracy([])).toBeNull();
  });

  it("weights moves by how volatile the evaluation is around them", () => {
    // Flat start, then a swing: the later moves get more weight.
    const win = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 80, 30];
    const weights = volatilityWeights(win);
    expect(weights).toHaveLength(win.length - 1);
    expect(weights[0]).toBe(0.5);
    expect(weights[weights.length - 1]).toBeGreaterThan(5);
    expect(Math.max(...volatilityWeights([0, 100, 0, 100, 0, 100]))).toBe(12);
  });
});

function equalWeightAccuracy(accs: number[]) {
  return gameAccuracy(accs.map((accuracy) => ({ accuracy, weight: 1 })));
}

describe("UCI parsing", () => {
  it("parses hivemind info lines", () => {
    const info = parseInfo("info depth 7 score cp -1327 nodes 444 nps 768 hashfull 0 tbhits 0 time 578 pv (e2e4,pass) (e7e5,d2d4) (P@e4,N@f3)")!;
    expect(info.depth).toBe(7);
    expect(info.nodes).toBe(444);
    expect(info.value).toBeCloseTo(-0.92, 2);
    expect(info.pv).toEqual([
      { a: "e2e4", b: null },
      { a: "e7e5", b: "d2d4" },
      { a: "P@e4", b: "N@f3" },
    ]);
  });

  it("parses mates", () => {
    const info = parseInfo("info depth 3 score mate -2 nodes 10 nps 1 time 5 pv (pass,e1e2)")!;
    expect(info.mate).toBe(-2);
    expect(info.value).toBe(-1);
  });

  it("inverts the score scale", () => {
    for (const q of [-0.9, -0.3, 0, 0.5, 0.95]) {
      expect(cpToValue(180 * Math.tan(1.56 * q))).toBeCloseTo(q, 5);
    }
    expect(parseJointMove("(pass,pass)")).toEqual({ a: null, b: null });
  });
});
