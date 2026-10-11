import { describe, expect, it } from "vitest";
import { BughousePosition, teamOf, colorOf } from "../src/lib/bughouse";

function play(pos: BughousePosition, moves: [("A" | "B"), string][]) {
  for (const [board, uci] of moves) pos.play(board, uci);
  return pos;
}

describe("teams", () => {
  it("pairs A White with B Black", () => {
    expect(teamOf("A", "white")).toBe("white");
    expect(teamOf("B", "black")).toBe("white");
    expect(teamOf("A", "black")).toBe("black");
    expect(colorOf("B", "white")).toBe("black");
  });
});

describe("BughousePosition", () => {
  it("sends captured pieces to the capturer's partner", () => {
    const pos = play(BughousePosition.initial(), [
      ["A", "e2e4"],
      ["A", "d7d5"],
      ["A", "e4d5"],
    ]);
    // White on A captured a pawn: it goes to Black on B, not White on A.
    expect(pos.pocket("A", "white").pawn).toBe(0);
    expect(pos.pocket("B", "black").pawn).toBe(1);
  });

  it("lets the partner drop the piece", () => {
    const pos = play(BughousePosition.initial(), [
      ["A", "e2e4"],
      ["A", "d7d5"],
      ["A", "e4d5"],
      ["B", "e2e4"],
    ]);
    const played = pos.play("B", "P@e5");
    expect(played.san).toBe("P@e5");
    expect(pos.pocket("B", "black").pawn).toBe(0);
  });

  it("refuses drops without the piece and pawn drops on the back rank", () => {
    const pos = BughousePosition.initial();
    expect(pos.isLegal("A", "N@e4")).toBe(false);
    pos.setPocket("A", "white", "pawn", 1);
    expect(pos.isLegal("A", "P@e4")).toBe(true);
    const back = BughousePosition.fromFens("4k3/8/8/8/8/8/8/4K3[P] w - - 0 1", "4k3/8/8/8/8/8/8/4K3[] w - - 0 1");
    expect(back.isLegal("A", "P@a1")).toBe(false);
    expect(back.isLegal("A", "P@a8")).toBe(false);
  });

  it("marks promotions and returns a captured promoted piece as a pawn", () => {
    const pos = BughousePosition.fromFens("1n2k3/P7/8/8/8/8/8/4K3[] w - - 0 1", "4k3/8/8/8/8/8/8/4K3[] w - - 0 1");
    pos.play("A", "a7b8q");
    expect(pos.fen("A")).toContain("Q~");
    expect(pos.pocket("B", "black").knight).toBe(1);

    const capture = BughousePosition.fromFens("1Q~2k3/8/8/8/8/8/7K/1r6[] b - - 0 1", "4k3/8/8/8/8/8/8/4K3[] w - - 0 1");
    capture.play("A", "b1b8");
    expect(capture.pocket("B", "white").pawn).toBe(1);
    expect(capture.pocket("B", "white").queen).toBe(0);
  });

  it("writes castling as the king's two-square move", () => {
    const pos = BughousePosition.fromFens("4k3/8/8/8/8/8/8/4K2R[] w K - 0 1", "4k3/8/8/8/8/8/8/4K3[] w - - 0 1");
    expect(pos.play("A", "e1g1").uci).toBe("e1g1");
  });

  it("does not call a blockable check mate", () => {
    // Rook check along the back rank with an empty square in between: a drop could block.
    const blockable = BughousePosition.fromFens("4k3/8/8/8/8/8/5PPP/r5K1[] w - - 0 1", "4k3/8/8/8/8/8/8/4K3[] w - - 0 1");
    expect(blockable.board("A").isCheckmate()).toBe(true);
    expect(blockable.isMate("A")).toBe(false);
    // Contact mate cannot be blocked.
    const contact = BughousePosition.fromFens("4k3/8/8/8/8/8/5PPP/5qK1[] w - - 0 1", "4k3/8/8/8/8/8/8/4K3[] w - - 0 1");
    expect(contact.isMate("A")).toBe(false); // the king takes the queen
    const smothered = BughousePosition.fromFens("4k3/8/8/8/8/8/5nPP/6RK[] w - - 0 1", "4k3/8/8/8/8/8/8/4K3[] w - - 0 1");
    expect(smothered.isMate("A")).toBe(true);
  });
});
