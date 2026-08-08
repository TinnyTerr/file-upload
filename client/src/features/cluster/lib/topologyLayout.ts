import type { ClusterTopology, TopologyNode } from "../types";

/**
 * Turning the replication graph into coordinates.
 *
 * The graph itself — who leads, who pulls from whom — is computed on the server
 * (`cluster/topology.ts`) from the same `upstreamOf()` the pull job follows.
 * Nothing here decides an edge; it only decides where to draw one, so the
 * picture cannot drift away from the cluster's behaviour.
 *
 * The shape is the hierarchy §5.1 describes: the master alone on top, each
 * region a column beneath it holding that region's leader with its followers
 * under it. Rows are tiers rather than path lengths on purpose — a follower
 * that has fallen back to the master stays on the follower row and its edge
 * simply reaches further, which is exactly the anomaly an operator wants to
 * see at a glance.
 */

export const NODE_W = 176;
export const NODE_H = 82;
const GAP_X = 20;
const GAP_Y = 62;
const PAD_X = 16;
const PAD_Y = 12;
/** Room inside a region band for its border and label. */
const BAND_PAD = 14;
const BAND_LABEL_H = 18;

export interface PlacedNode {
	node: TopologyNode;
	x: number;
	y: number;
}

export interface PlacedEdge {
	id: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	/** The §5.1 fallback: this node's region leader is unreachable, so it pulls
	 * from the master directly. Drawn differently because it is a degraded edge,
	 * not the planned one. */
	fallback: boolean;
}

export interface RegionBand {
	region: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface TopologyLayout {
	width: number;
	height: number;
	nodes: PlacedNode[];
	edges: PlacedEdge[];
	bands: RegionBand[];
	/** Nodes the current generation has never seen. They have no upstream, so
	 * they get no edges — the diagram must not invent one. */
	untiered: TopologyNode[];
}

const rowY = (row: number) => PAD_Y + row * (NODE_H + GAP_Y);

const byName = (a: TopologyNode, b: TopologyNode) =>
	a.name.localeCompare(b.name) || a.node_id.localeCompare(b.node_id);

/** Regions are columns; a node whose region the snapshot never recorded still
 * has to go somewhere, so it gets its own unnamed column. */
const regionKey = (node: TopologyNode) => node.region ?? "—";

export function layoutTopology(topology: ClusterTopology): TopologyLayout {
	const master = topology.nodes.find((n) => n.role === "master") ?? null;
	const tiered = topology.nodes.filter((n) => n.role && n !== master);
	const untiered = topology.nodes.filter((n) => !n.role).sort(byName);

	const regions = new Map<string, TopologyNode[]>();
	for (const node of tiered) {
		const key = regionKey(node);
		const members = regions.get(key);
		if (members) members.push(node);
		else regions.set(key, [node]);
	}

	const placed: PlacedNode[] = [];
	const bands: RegionBand[] = [];
	let cursorX = PAD_X;
	let deepestRow = 0;

	for (const region of [...regions.keys()].sort()) {
		const members = regions.get(region) ?? [];
		const leader = members.find((n) => n.role === "leader") ?? null;
		const followers = members.filter((n) => n !== leader).sort(byName);
		// A region with no leader hangs its followers straight off the master, so
		// there is no empty tier to leave a gap for.
		const followerRow = leader ? 2 : 1;
		const width = Math.max(
			NODE_W,
			followers.length * NODE_W + Math.max(followers.length - 1, 0) * GAP_X,
		);

		if (leader) {
			placed.push({
				node: leader,
				x: cursorX + (width - NODE_W) / 2,
				y: rowY(1),
			});
		}
		followers.forEach((node, i) => {
			placed.push({
				node,
				x: cursorX + i * (NODE_W + GAP_X),
				y: rowY(followerRow),
			});
		});

		const lastRow = followers.length ? followerRow : 1;
		deepestRow = Math.max(deepestRow, lastRow);
		const bandTop = rowY(1) - BAND_PAD - BAND_LABEL_H;
		bands.push({
			region,
			x: cursorX - BAND_PAD,
			y: bandTop,
			width: width + BAND_PAD * 2,
			height: rowY(lastRow) + NODE_H + BAND_PAD - bandTop,
		});
		cursorX += width + GAP_X * 2;
	}

	const contentWidth = regions.size
		? cursorX - GAP_X * 2 - PAD_X
		: master
			? NODE_W
			: 0;

	if (master) {
		placed.push({
			node: master,
			x: PAD_X + Math.max(contentWidth - NODE_W, 0) / 2,
			y: rowY(0),
		});
	}

	// Untiered nodes get a row of their own below everything, deliberately
	// unconnected: until a generation admits them they replicate with nobody.
	const untieredRow = deepestRow + 1;
	untiered.forEach((node, i) => {
		placed.push({
			node,
			x: PAD_X + i * (NODE_W + GAP_X),
			y: rowY(untieredRow),
		});
	});

	const rows = untiered.length ? untieredRow : deepestRow;
	const width =
		Math.max(
			contentWidth,
			untiered.length
				? untiered.length * NODE_W + (untiered.length - 1) * GAP_X
				: 0,
		) +
		PAD_X * 2;

	const at = new Map(placed.map((p) => [p.node.node_id, p]));
	const edges: PlacedEdge[] = [];
	for (const { node, x, y } of placed) {
		if (!node.upstream) continue;
		const parent = at.get(node.upstream);
		if (!parent) continue;
		edges.push({
			id: `${node.node_id}->${node.upstream}`,
			x1: x + NODE_W / 2,
			y1: y,
			x2: parent.x + NODE_W / 2,
			y2: parent.y + NODE_H,
			fallback: node.fell_back,
		});
	}

	return {
		width,
		height: rowY(rows) + NODE_H + PAD_Y,
		nodes: placed,
		edges,
		bands,
		untiered,
	};
}
