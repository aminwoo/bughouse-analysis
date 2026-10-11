import { describe, expect, it } from "vitest";
import { blend, moveAccuracy, reviewMoves, timeAdvantageWeight, valueFor, type PositionEval } from "../src/lib/review";
import { cpToValue, parseInfo, parseJointMove } from "../src/engine/engineClient";
import type { GameRecord } from "../src/lib/game";

const evalOf = (ply: number, team: "white" | "black", ta: number, noTa: number, best: string | null = null): PositionEval => ({
  ply,
  team,
  withTA: { value: ta, mate: null, best: best ? { a: best, b: null } : null, pv: [], nodes: 100 },
  withoutTA: { value: noTa, mate: null, best: best ? { a: best, b: null } : null, pv: [], nodes: 100 },
});

describe("time advantage weight", () => {
  const clocks = { A: { white: 1500, black: 1400 }, B: { white: 1400, black: 1500 } };
  it("favours the team ahead on its diagonal", () => {
    expect(timeAdvantageWeight(clocks, "white", "clocks")).toBeGreaterThan(0.9);
    expect(timeAdvantageWeight(clocks, "black", "clocks")).toBeLessThan(0.1);
    expect(timeAdvantageWeight(clocks, "white", "binary")).toBe(1);
    expect(timeAdvantageWeight(clocks, "white", "neutral")).toBe(0.5);
    expect(timeAdvantageWeight(null, "white", "clocks")).toBe(0.5);
  });
});

describe("valueFor", () => {
  it("converts the opponents' search into our perspective", () => {
    const e = evalOf(0, "black", 0.9, -0.6);
    // Black may sit with probability 0.3 <=> white may sit with probability 0.7.
    expect(valueFor(e, "black", 0.3)).toBeCloseTo(0.3 * 0.9 + 0.7 * -0.6);
    expect(valueFor(e, "white", 0.7)).toBeCloseTo(-(0.3 * 0.9 + 0.7 * -0.6));
    expect(blend(e, 1)).toBe(0.9);
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

  it("charges a move with its team's value drop", () => {
    const evals = [evalOf(0, "white", 0.2, 0.2, "d2d4"), evalOf(1, "black", 0.3, 0.3), evalOf(2, "white", -0.3, -0.3)];
    const reviews = reviewMoves(game, evals, "neutral");
    expect(reviews[1]!.loss).toBeCloseTo(0.5);
    expect(reviews[1]!.judgement).toBe("blunder");
    expect(reviews[1]!.best).toBe("d2d4");
    expect(reviews[2]!.loss).toBeCloseTo(0);
  });

  it("does not blame a move the engine itself chose", () => {
    const evals = [evalOf(0, "white", 0.2, 0.2, "e2e4"), evalOf(1, "black", 0.3, 0.3), evalOf(2, "white", 0, 0)];
    expect(reviewMoves(game, evals, "neutral")[1]!.judgement).toBeNull();
  });

  it("scores accuracy like lichess", () => {
    expect(moveAccuracy(0, 0)).toBeCloseTo(100, 0);
    expect(moveAccuracy(0.5, -0.5)).toBeLessThan(20);
  });
});

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
