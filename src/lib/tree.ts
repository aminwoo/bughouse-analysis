// Analysis tree: the game's mainline plus any variations the user plays.
// Nodes are immutable once created; positions are cloned before playing on.

import type { BughousePosition, PlayedMove, BoardId } from "./bughouse";
import { enginePositionArg, startPosition, type Clocks, type GameRecord, type MainlineMove } from "./game";

export interface TreeNode {
  id: string;
  parent: string | null;
  /** Number of moves from the start (both boards). */
  ply: number;
  move: PlayedMove | MainlineMove | null;
  position: BughousePosition;
  /** First child continues the line it belongs to. */
  children: string[];
  mainline: boolean;
  /** Clocks after the move; mainline nodes only. */
  clocks: Clocks | null;
}

export interface Tree {
  nodes: Map<string, TreeNode>;
  rootId: string;
  /** Mainline node ids in order, starting with the root. */
  mainline: string[];
}

let counter = 0;
const nextId = () => `v${++counter}`;

export function mainlineId(ply: number): string {
  return `m${ply}`;
}

export function buildTree(game: GameRecord): Tree {
  const nodes = new Map<string, TreeNode>();
  const root: TreeNode = {
    id: mainlineId(0),
    parent: null,
    ply: 0,
    move: null,
    position: startPosition(game),
    children: [],
    mainline: true,
    clocks: game.startClocks,
  };
  nodes.set(root.id, root);
  const mainline = [root.id];
  let current = root;
  let pos = root.position.clone();
  for (let i = 0; i < game.moves.length; i++) {
    const move = game.moves[i];
    pos.play(move.board, move.uci);
    const node: TreeNode = {
      id: mainlineId(i + 1),
      parent: current.id,
      ply: i + 1,
      move,
      position: pos,
      children: [],
      mainline: true,
      clocks: move.clocks,
    };
    pos = pos.clone();
    current.children.push(node.id);
    nodes.set(node.id, node);
    mainline.push(node.id);
    current = node;
  }
  return { nodes, rootId: root.id, mainline };
}

export function getNode(tree: Tree, id: string): TreeNode {
  const node = tree.nodes.get(id);
  if (!node) throw new Error(`unknown node ${id}`);
  return node;
}

/** Root-to-node path, root first. */
export function pathTo(tree: Tree, id: string): TreeNode[] {
  const path: TreeNode[] = [];
  let node: TreeNode | undefined = tree.nodes.get(id);
  while (node) {
    path.push(node);
    node = node.parent ? tree.nodes.get(node.parent) : undefined;
  }
  return path.reverse();
}

/** Engine moves ("1e2e4", "2N@f3") from the root to a node. */
export function engineMoves(tree: Tree, id: string): string[] {
  return pathTo(tree, id)
    .slice(1)
    .map((node) => (node.move!.board === "A" ? "1" : "2") + node.move!.uci);
}

export function engineRequestFor(tree: Tree, game: GameRecord, id: string) {
  return { position: enginePositionArg(game), moves: engineMoves(tree, id) };
}

/**
 * Plays a move from a node. Reuses an existing child with the same move,
 * otherwise adds a variation. Returns the child's id, or null if illegal.
 */
export function playMove(tree: Tree, fromId: string, board: BoardId, uci: string): { tree: Tree; id: string } | null {
  const from = getNode(tree, fromId);
  const pos = from.position.clone();
  let played: PlayedMove;
  try {
    played = pos.play(board, uci);
  } catch {
    return null;
  }
  for (const childId of from.children) {
    const child = getNode(tree, childId);
    if (child.move && child.move.board === board && child.move.uci === played.uci) return { tree, id: childId };
  }
  const node: TreeNode = {
    id: nextId(),
    parent: from.id,
    ply: from.ply + 1,
    move: played,
    position: pos,
    children: [],
    mainline: false,
    clocks: null,
  };
  const nodes = new Map(tree.nodes);
  nodes.set(node.id, node);
  nodes.set(from.id, { ...from, children: [...from.children, node.id] });
  return { tree: { ...tree, nodes }, id: node.id };
}

/** Removes a variation node and everything after it. Mainline nodes stay. */
export function deleteVariation(tree: Tree, id: string): Tree {
  const node = getNode(tree, id);
  if (node.mainline || !node.parent) return tree;
  const nodes = new Map(tree.nodes);
  const drop = (nid: string) => {
    const n = nodes.get(nid);
    if (!n) return;
    n.children.forEach(drop);
    nodes.delete(nid);
  };
  drop(id);
  const parent = nodes.get(node.parent)!;
  nodes.set(parent.id, { ...parent, children: parent.children.filter((c) => c !== id) });
  return { ...tree, nodes };
}

/** Last node reached by always following first children. */
export function lineEnd(tree: Tree, id: string): string {
  let node = getNode(tree, id);
  while (node.children.length) node = getNode(tree, node.children[0]);
  return node.id;
}

/** The mainline node a variation branches from (or the node itself). */
export function mainlineAnchor(tree: Tree, id: string): TreeNode {
  let node = getNode(tree, id);
  while (!node.mainline && node.parent) node = getNode(tree, node.parent);
  return node;
}
