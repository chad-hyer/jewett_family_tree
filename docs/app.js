"use strict";

const RELATIONSHIP_LABELS = {
  0: "Unknown",
  1: "Undergraduate student",
  2: "Master's student",
  3: "PhD student",
  4: "Postdoctoral scholar",
};
const RELATIONSHIP_COLORS = {
  0: "#9e9e9e",
  1: "#4caf50",
  2: "#2196f3",
  3: "#9c27b0",
  4: "#ff9800",
};

const CARD_WIDTH = 190;
const CARD_HEIGHT = 58;
const AVATAR_R = 16;
const TOGGLE_R = 9;
const DATA_URL = new URLSearchParams(location.search).get("data") || "data.json";

// A "leaf cluster" is a person whose children have no children of their own
// (e.g. a cohort of students with no students of their own). Instead of
// giving each one its own full-size row - which makes trees with a few
// prolific advisors absurdly tall - its members are grouped into a compact
// grid by relationship type, anchored just to the right of the parent card
// (or "below", once rotated for portrait/fan orientation).
const MINI_CARD_WIDTH = 148;
const MINI_CARD_HEIGHT = 34;
const MINI_GAP_X = 10;
const MINI_GAP_Y = 7;
const MINI_GROUP_GAP_Y = 22;
const MINI_GROUP_LABEL_HEIGHT = 16;
const MINI_MAX_COLS = 6;
const LEAF_CLUSTER_PADDING = 20;

// Fan/radial mode reuses the landscape breadth-vs-angle proportions that
// every real radial tree layout uses (D3's own radial examples do the
// same) - rings near the center are inherently more cramped than rings
// further out, since the same angular slice covers less arc length at a
// smaller radius. A bigger inner radius and radius step buys more breathing
// room; it works best once a large tree has been narrowed down with the
// ancestor-isolate ("‹") control rather than shown in full.
const FAN_ANGLE_SPAN = 320; // degrees; leaves a gap so the circle doesn't fully close
const FAN_RADIUS_STEP = 220;
const FAN_INNER_RADIUS = 90;

// Cards are always drawn upright at a fixed pixel size (CARD_WIDTH x
// CARD_HEIGHT, MINI_CARD_WIDTH x MINI_CARD_HEIGHT) regardless of
// orientation - only the SPACING between adjacent siblings/generations
// changes. In landscape, siblings spread top-to-bottom (so spacing is
// based on the card's height) and generations spread left-to-right (based
// on its width). Portrait swaps which screen axis is which, so it needs
// spacing based on the *other* dimension, or wide cards would collide with
// their neighbors. Fan reuses the landscape numbers since its layout is
// angular, not pixel-aligned.
function breadthStep() {
  return state.orientation === "portrait" ? CARD_WIDTH + 40 : CARD_HEIGHT + 22;
}
function depthStep() {
  return state.orientation === "portrait" ? CARD_HEIGHT + 24 : CARD_WIDTH + 76;
}
function miniBreadthSize() {
  return state.orientation === "portrait" ? MINI_CARD_WIDTH : MINI_CARD_HEIGHT;
}
function miniDepthSize() {
  return state.orientation === "portrait" ? MINI_CARD_HEIGHT : MINI_CARD_WIDTH;
}

const state = {
  people: [],
  byId: new Map(),
  childrenByParent: new Map(),
  coAdvisorEdges: [], // [{studentId, advisorId}] for secondary (non-primary) parents
  collapsedDescendants: new Set(),
  viewRootId: null,
  visibleTypes: new Set([0, 1, 2, 3, 4]),
  orientation: "landscape", // "landscape" | "portrait" | "fan"
  lastNodePositions: new Map(), // id -> {x, y} in screen space, set on every render
};

let svg, zoomLayer, zoomBehavior;

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function relLabel(rel) {
  return RELATIONSHIP_LABELS[rel] ?? RELATIONSHIP_LABELS[0];
}
function relColor(rel) {
  return RELATIONSHIP_COLORS[rel] ?? RELATIONSHIP_COLORS[0];
}

// ---------- Parent field helpers (supports co-advisement) ----------
//
// `parent` is normally a single id or null, but may also be a list of ids
// for a co-advised person. The first id is treated as the primary advisor
// for tree structure/layout purposes; any others are drawn as secondary
// dashed links wherever both people happen to be visible.

function parentIdsOf(person) {
  const raw = person.parent;
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.filter((id) => id !== null && id !== undefined);
  return [raw];
}
function primaryParentId(person) {
  const ids = parentIdsOf(person);
  return ids.length > 0 ? ids[0] : null;
}
function secondaryParentIds(person) {
  return parentIdsOf(person).slice(1);
}

// ---------- Data indexing ----------

function buildIndex(people) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const childrenByParent = new Map();
  const coAdvisorEdges = [];
  for (const p of people) {
    const primary = primaryParentId(p);
    if (primary !== null && byId.has(primary)) {
      if (!childrenByParent.has(primary)) childrenByParent.set(primary, []);
      childrenByParent.get(primary).push(p);
    }
    for (const secondaryId of secondaryParentIds(p)) {
      if (byId.has(secondaryId)) {
        coAdvisorEdges.push({ studentId: p.id, advisorId: secondaryId });
      }
    }
  }
  for (const kids of childrenByParent.values()) {
    kids.sort((a, b) => a.name.localeCompare(b.name));
  }
  return { byId, childrenByParent, coAdvisorEdges };
}

// Every person with at least one childless child gets that subset grouped
// into a collapsible "cluster" sibling (see buildClusterNode) - identified
// by this synthetic id, which is what state.collapsedDescendants stores for
// it. Collapsed by default, independently of whatever else that parent has.
function clusterIdFor(personId) {
  return `${personId}::cluster`;
}

function isChildless(personId) {
  return !(state.childrenByParent.get(personId) || []).length;
}

// A childless person still gets their own standalone card - never folded
// into a cluster - if they're co-advised. Otherwise their co-advisor link
// would either vanish (when the cluster collapses, since only the cluster
// badge is left to point at) or have to weave through a crowded grid of
// unrelated students to reach them (when it's expanded).
function isClusterable(person) {
  return isChildless(person.id) && secondaryParentIds(person).length === 0;
}

// Every cluster starts collapsed, so terminal cohorts stay tucked away and
// branches that keep growing get visual priority when a tree is first
// opened - independent of whether that same parent also has children with
// descendants of their own.
function computeDefaultCollapsed() {
  const collapsed = new Set();
  for (const [pid, kids] of state.childrenByParent.entries()) {
    if (kids.some(isClusterable)) {
      collapsed.add(clusterIdFor(pid));
    }
  }
  return collapsed;
}

function isTrueRoot(person) {
  const primary = primaryParentId(person);
  return primary === null || !state.byId.has(primary);
}

function isVisibleType(person) {
  return state.visibleTypes.has(person.relationship ?? 0);
}

function countDescendants(id) {
  let count = 0;
  const visited = new Set();
  const stack = [...(state.childrenByParent.get(id) || [])];
  while (stack.length) {
    const kid = stack.pop();
    if (visited.has(kid.id)) continue; // guards against a cycle in malformed data
    visited.add(kid.id);
    count += 1;
    stack.push(...(state.childrenByParent.get(kid.id) || []));
  }
  return count;
}

function getAncestorChain(id) {
  // Returns [root, ..., primaryParentOf(id)] using primary parent links only.
  const chain = [];
  let current = state.byId.get(id);
  const seen = new Set();
  while (current) {
    const pid = primaryParentId(current);
    if (pid === null || !state.byId.has(pid) || seen.has(pid)) break;
    seen.add(pid);
    const parent = state.byId.get(pid);
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

// Splices through people whose relationship type is filtered out, so their
// visible descendants re-attach to the nearest visible ancestor.
function effectiveChildrenOf(id) {
  const out = [];
  const queue = [...(state.childrenByParent.get(id) || [])];
  const visited = new Set();
  while (queue.length) {
    const kid = queue.shift();
    if (visited.has(kid.id)) continue; // guards against a cycle in malformed data
    visited.add(kid.id);
    if (isVisibleType(kid)) {
      out.push(kid);
    } else {
      queue.push(...(state.childrenByParent.get(kid.id) || []));
    }
  }
  return out;
}

// Groups childless children into columns by relationship, then wraps each
// column into a compact grid so even a cluster of 100+ members stays roughly
// square instead of one very long line.
function buildLeafClusterLayout(kids) {
  const byRel = new Map();
  for (const k of kids) {
    const rel = k.relationship ?? 0;
    if (!byRel.has(rel)) byRel.set(rel, []);
    byRel.get(rel).push(k);
  }
  const groups = [...byRel.keys()]
    .sort((a, b) => a - b)
    .map((rel) => {
      const members = byRel.get(rel).sort((a, b) => a.name.localeCompare(b.name));
      const cols = Math.min(MINI_MAX_COLS, Math.max(2, Math.ceil(Math.sqrt(members.length))));
      const rows = Math.ceil(members.length / cols);
      const blockWidth = cols * (miniDepthSize() + MINI_GAP_X) - MINI_GAP_X;
      const blockHeight = MINI_GROUP_LABEL_HEIGHT + rows * (miniBreadthSize() + MINI_GAP_Y) - MINI_GAP_Y;
      return { relationship: rel, members, cols, rows, blockWidth, blockHeight };
    });
  const totalHeight = groups.reduce((s, g) => s + g.blockHeight, 0) + MINI_GROUP_GAP_Y * Math.max(0, groups.length - 1);
  const totalWidth = groups.reduce((m, g) => Math.max(m, g.blockWidth), 0);
  return { groups, totalHeight, totalWidth };
}

// A cluster is a synthetic sibling representing "this parent's childless
// children" as a single collapsible/expandable unit, sitting at the same
// depth as any brothers/sisters who DO have their own descendants (those
// stay as ordinary individual cards, built separately). Collapsed, it's a
// single badge card; expanded, it's the same compact relationship-grouped
// grid used everywhere else - anchored at its OWN position rather than one
// generation further out, so it reads as "more of this generation", not a
// new one.
function buildClusterNode(personId, childlessKids, depth) {
  const id = clusterIdFor(personId);
  const node = { id, isCluster: true, depth, hasRawChildren: false, children: [] };
  if (state.collapsedDescendants.has(id)) {
    node.collapsed = true;
    node.hiddenCount = childlessKids.length;
  } else {
    node.collapsed = false;
    node.leafCluster = buildLeafClusterLayout(childlessKids);
  }
  return node;
}

// `ancestorPath` guards against malformed data containing a parent cycle -
// without it, a cycle would recurse forever and hang the tab.
function buildNode(person, depth, ancestorPath = new Set()) {
  const node = { id: person.id, person, depth };
  const rawKids = state.childrenByParent.get(person.id) || [];
  node.hasRawChildren = rawKids.length > 0;

  if (node.hasRawChildren && state.collapsedDescendants.has(person.id)) {
    node.children = [];
    node.collapsed = true;
    node.hiddenCount = countDescendants(person.id);
    return node;
  }

  node.collapsed = false;
  const nextPath = new Set(ancestorPath).add(person.id);
  const effectiveKids = effectiveChildrenOf(person.id).filter((kid) => !nextPath.has(kid.id));
  const childless = effectiveKids.filter(isClusterable);
  const branching = effectiveKids.filter((k) => !isClusterable(k));

  node.children = branching.map((kid) => buildNode(kid, depth + 1, nextPath));
  if (childless.length > 0) {
    node.children.push(buildClusterNode(person.id, childless, depth + 1));
  }
  return node;
}

function effectiveTopLevel(rootsList, visited = new Set()) {
  const out = [];
  for (const r of rootsList) {
    if (visited.has(r.id)) continue; // guards against a cycle in malformed data
    visited.add(r.id);
    if (isVisibleType(r)) {
      out.push(r);
    } else {
      out.push(...effectiveTopLevel(state.childrenByParent.get(r.id) || [], visited));
    }
  }
  return out;
}

function buildForest() {
  if (state.viewRootId && state.byId.has(state.viewRootId)) {
    const focal = state.byId.get(state.viewRootId);
    return [buildNode(focal, 0)];
  }
  const trueRoots = state.people.filter(isTrueRoot).sort((a, b) => a.name.localeCompare(b.name));
  const visibleRoots = effectiveTopLevel(trueRoots);
  return visibleRoots.map((r) => buildNode(r, 0));
}

// ---------- Layout engine ----------
//
// Every node's position is computed in two abstract axes: "depth" (which
// generation it's in) and "breadth" (its cross-axis position, independent
// of orientation). This is a plain bottom-up-extent / top-down-position
// tree layout (not a Reingold-Tilford style layout) - every subtree
// reserves exactly the breadth its descendants need, INCLUDING the full
// footprint of any leaf-cluster grid hanging off of it, so nothing can ever
// overlap regardless of how deeply nested a large cluster is. Once every
// node has a (u, v) pair (u = depth axis pixels, v = breadth axis pixels),
// a single mapping function turns that into landscape/portrait/fan screen
// coordinates - see `mapToScreen`.

function computeExtents(node) {
  if (node.collapsed || !node.children || node.children.length === 0) {
    node.breadthExtent = node.leafCluster
      ? Math.max(breadthStep(), node.leafCluster.totalHeight + LEAF_CLUSTER_PADDING)
      : breadthStep();
    return node.breadthExtent;
  }
  let sum = 0;
  for (const child of node.children) {
    sum += computeExtents(child);
  }
  node.breadthExtent = Math.max(sum, breadthStep());
  return node.breadthExtent;
}

function assignPositions(node, breadthStart) {
  node.u = node.depth * depthStep();
  node.v = breadthStart + node.breadthExtent / 2;
  if (!node.collapsed && !node.leafCluster && node.children && node.children.length > 0) {
    let cursor = breadthStart;
    for (const child of node.children) {
      assignPositions(child, cursor);
      cursor += child.breadthExtent;
    }
  }
}

function layoutForest(forestRoots) {
  for (const root of forestRoots) computeExtents(root);
  let cursor = 0;
  for (const root of forestRoots) {
    assignPositions(root, cursor);
    cursor += root.breadthExtent;
  }
  return cursor; // total breadth spanned by the whole forest
}

function flattenTree(forestRoots) {
  const nodes = [];
  const links = [];
  function walk(node) {
    nodes.push(node);
    if (!node.collapsed && !node.leafCluster && node.children) {
      for (const child of node.children) {
        links.push({ parent: node, child });
        walk(child);
      }
    }
  }
  for (const root of forestRoots) walk(root);
  return { nodes, links };
}

// Computes screen-space positions for every member inside a leaf-cluster's
// grid, anchored at the cluster node's own (already-laid-out) position -
// the same depth as its branching siblings, not one generation further out,
// so an expanded cluster reads as "more of this generation" rather than a
// new one. Positions stay in the same abstract (u, v) space as everything
// else.
function computeLeafClusterPositions(node) {
  const lc = node.leafCluster;
  const baseU = node.u;
  const groupLabels = [];
  const members = [];
  let cursorV = node.v - lc.totalHeight / 2;

  for (const group of lc.groups) {
    groupLabels.push({ u: baseU, v: cursorV + MINI_GROUP_LABEL_HEIGHT - 4, relationship: group.relationship, count: group.members.length });
    const gridTop = cursorV + MINI_GROUP_LABEL_HEIGHT;
    for (let i = 0; i < group.members.length; i++) {
      const col = i % group.cols;
      const row = Math.floor(i / group.cols);
      members.push({
        person: group.members[i],
        u: baseU + col * (miniDepthSize() + MINI_GAP_X),
        v: gridTop + row * (miniBreadthSize() + MINI_GAP_Y) + miniBreadthSize() / 2,
        parentId: node.id,
      });
    }
    cursorV += group.blockHeight + MINI_GROUP_GAP_Y;
  }
  return { groupLabels, members };
}

// Converts an abstract (u, v) layout position into a screen (x, y) point,
// according to the current orientation. `totalV` (the whole forest's
// breadth span) is only used to normalize the fan's angle.
function mapToScreen(u, v, totalV) {
  switch (state.orientation) {
    case "portrait":
      return { x: v, y: u };
    case "fan": {
      const frac = totalV > 0 ? v / totalV : 0.5;
      const angleDeg = -FAN_ANGLE_SPAN / 2 + frac * FAN_ANGLE_SPAN;
      const angleRad = ((angleDeg - 90) * Math.PI) / 180;
      const radius = FAN_INNER_RADIUS + (u / depthStep()) * FAN_RADIUS_STEP;
      return { x: radius * Math.cos(angleRad), y: radius * Math.sin(angleRad) };
    }
    default:
      return { x: u, y: v };
  }
}

// A simple smooth curve between two already-mapped screen points. Fan mode
// just uses a straight line - true radial arcs are a nice-to-have but add
// real complexity for a first pass.
function linkPath(p0, p1) {
  if (state.orientation === "fan") {
    return `M${p0.x},${p0.y}L${p1.x},${p1.y}`;
  }
  if (state.orientation === "portrait") {
    const midY = (p0.y + p1.y) / 2;
    return `M${p0.x},${p0.y}C${p0.x},${midY} ${p1.x},${midY} ${p1.x},${p1.y}`;
  }
  const midX = (p0.x + p1.x) / 2;
  return `M${p0.x},${p0.y}C${midX},${p0.y} ${midX},${p1.y} ${p1.x},${p1.y}`;
}

// Co-advisor links need to read as clearly different from ordinary tree
// edges even when both people happen to land in the same generation (where
// a normal link would be nearly flat and easy to miss entirely). Bowing the
// curve out perpendicular to the straight line does that regardless of
// orientation or how close together the two points are.
function coAdvisorLinkPath(p0, p1) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy) || 1;
  const bow = Math.min(70, Math.max(28, dist * 0.3));
  const nx = -dy / dist;
  const ny = dx / dist;
  const midX = (p0.x + p1.x) / 2 + nx * bow;
  const midY = (p0.y + p1.y) / 2 + ny * bow;
  return `M${p0.x},${p0.y}Q${midX},${midY} ${p1.x},${p1.y}`;
}

// ---------- Rendering ----------

function render(opts = {}) {
  const forest = buildForest();

  document.getElementById("empty-state").classList.toggle("hidden", forest.length > 0);
  if (forest.length === 0) {
    zoomLayer.selectAll("*").remove();
    state.lastNodePositions.clear();
    updateHeaderSubtitle();
    return;
  }

  const totalV = layoutForest(forest);
  const { nodes: allNodes, links: allLinks } = flattenTree(forest);

  for (const n of allNodes) {
    const p = mapToScreen(n.u, n.v, totalV);
    n.sx = p.x;
    n.sy = p.y;
  }

  state.lastNodePositions.clear();
  for (const n of allNodes) {
    state.lastNodePositions.set(n.id, { x: n.sx, y: n.sy });
  }

  // Leaf-cluster grids: computed after the main layout so they can anchor
  // off each parent's final position. Every expanded cluster also gets a
  // small toggle floating just above its grid so it can be collapsed again
  // without needing a full card of its own.
  const miniGroupLabels = [];
  const miniMembers = [];
  const miniLinks = [];
  const clusterCollapseToggles = [];
  for (const n of allNodes) {
    if (!n.leafCluster) continue;
    const { groupLabels, members } = computeLeafClusterPositions(n);
    for (const g of groupLabels) {
      const p = mapToScreen(g.u, g.v, totalV);
      miniGroupLabels.push({ x: p.x, y: p.y, relationship: g.relationship, count: g.count });
    }
    for (const m of members) {
      const p = mapToScreen(m.u, m.v, totalV);
      miniMembers.push({ person: m.person, x: p.x, y: p.y });
      miniLinks.push({ id: m.person.id, p0: { x: n.sx, y: n.sy }, p1: p });
    }
    if (n.isCluster) {
      const topPoint = mapToScreen(n.u, n.v - n.leafCluster.totalHeight / 2 - 8, totalV);
      clusterCollapseToggles.push({ id: n.id, x: topPoint.x, y: topPoint.y });
    }
  }
  for (const m of miniMembers) {
    state.lastNodePositions.set(m.person.id, { x: m.x, y: m.y });
  }

  // A co-advisee can be completely absent from the current view - e.g. when
  // isolating on their secondary advisor's branch, since only primary
  // parent links are followed to build the tree. Rather than just dropping
  // the link, give them a small floating card stacked above whichever
  // visible co-advisor they're missing from, so the relationship stays
  // visible no matter which of a student's advisors you're focused on.
  const orphanedByAdvisor = new Map();
  for (const edge of state.coAdvisorEdges) {
    if (state.lastNodePositions.has(edge.studentId)) continue;
    const advisorPos = state.lastNodePositions.get(edge.advisorId);
    if (!advisorPos) continue;
    if (!orphanedByAdvisor.has(edge.advisorId)) orphanedByAdvisor.set(edge.advisorId, []);
    orphanedByAdvisor.get(edge.advisorId).push(edge.studentId);
  }
  for (const [advisorId, studentIds] of orphanedByAdvisor.entries()) {
    const advisorPos = state.lastNodePositions.get(advisorId);
    const totalH = studentIds.length * (MINI_CARD_HEIGHT + MINI_GAP_Y) - MINI_GAP_Y;
    let y = advisorPos.y - CARD_HEIGHT / 2 - 16 - totalH;
    for (const sid of studentIds) {
      const pos = { x: advisorPos.x, y };
      miniMembers.push({ person: state.byId.get(sid), x: pos.x, y: pos.y, isAuxiliary: true });
      state.lastNodePositions.set(sid, pos);
      y += MINI_CARD_HEIGHT + MINI_GAP_Y;
    }
  }

  // Co-advisor cross-links: only drawn when both ends are currently visible.
  const coAdvisorLinks = [];
  for (const edge of state.coAdvisorEdges) {
    const p0 = state.lastNodePositions.get(edge.studentId);
    const p1 = state.lastNodePositions.get(edge.advisorId);
    if (p0 && p1) {
      const student = state.byId.get(edge.studentId);
      const advisor = state.byId.get(edge.advisorId);
      coAdvisorLinks.push({
        id: `${edge.studentId}::${edge.advisorId}`,
        p0,
        p1,
        label: `${student.name} co-advised by ${advisor.name}`,
      });
    }
  }

  const searchQuery = (document.getElementById("search-input").value || "").trim().toLowerCase();

  // --- Links ---
  const linkSel = zoomLayer.selectAll("g.links").data([null]);
  const linkG = linkSel.enter().append("g").attr("class", "links").merge(linkSel);
  const linkPaths = linkG.selectAll("path.link").data(allLinks, (d) => d.child.id);
  linkPaths.exit().remove();
  linkPaths
    .enter()
    .append("path")
    .attr("class", "link")
    .merge(linkPaths)
    .attr("d", (d) => linkPath({ x: d.parent.sx, y: d.parent.sy }, { x: d.child.sx, y: d.child.sy }));

  const miniLinkPaths = linkG.selectAll("path.mini-link").data(miniLinks, (d) => d.id);
  miniLinkPaths.exit().remove();
  miniLinkPaths
    .enter()
    .append("path")
    .attr("class", "mini-link")
    .merge(miniLinkPaths)
    .attr("d", (d) => linkPath(d.p0, d.p1));

  const coLinkSel = linkG.selectAll("g.co-advisor-link").data(coAdvisorLinks, (d) => d.id);
  coLinkSel.exit().remove();
  const coLinkEnter = coLinkSel.enter().append("g").attr("class", "co-advisor-link");
  coLinkEnter.append("path");
  coLinkEnter.append("title");
  const allCoLinks = coLinkEnter.merge(coLinkSel);
  allCoLinks.select("path").attr("d", (d) => coAdvisorLinkPath(d.p0, d.p1));
  allCoLinks.select("title").text((d) => d.label);

  // --- Mini (leaf-cluster) group labels ---
  const labelSel = zoomLayer.selectAll("g.mini-labels").data([null]);
  const labelG = labelSel.enter().append("g").attr("class", "mini-labels").merge(labelSel);
  const labels = labelG.selectAll("text.mini-group-label").data(miniGroupLabels, (d, i) => `${d.relationship}-${d.x}-${d.y}-${i}`);
  labels.exit().remove();
  labels
    .enter()
    .append("text")
    .attr("class", "mini-group-label")
    .merge(labels)
    .attr("x", (d) => d.x)
    .attr("y", (d) => d.y)
    .text((d) => `${relLabel(d.relationship)} (${d.count})`);

  // --- Nodes ---
  const personNodes = allNodes.filter((d) => !d.isCluster);
  const collapsedClusterNodes = allNodes.filter((d) => d.isCluster && d.collapsed);

  const nodeSel = zoomLayer.selectAll("g.nodes").data([null]);
  const nodeG = nodeSel.enter().append("g").attr("class", "nodes").merge(nodeSel);
  const cards = nodeG.selectAll("g.node-card").data(personNodes, (d) => d.id);
  cards.exit().remove();

  const cardsEnter = cards.enter().append("g").attr("class", "node-card");
  buildCardSkeleton(cardsEnter);

  const allCards = cardsEnter.merge(cards);
  allCards.attr("transform", (d) => `translate(${d.sx - CARD_WIDTH / 2}, ${d.sy - CARD_HEIGHT / 2})`);
  allCards.classed("collapsed", (d) => !!d.collapsed);
  allCards.classed(
    "search-match",
    (d) => searchQuery.length > 0 && d.person.name.toLowerCase().includes(searchQuery)
  );
  updateCardContent(allCards);

  allCards.on("click", (event, d) => {
    if (event.defaultPrevented) return;
    openDetailPanel(d.person);
  });

  // --- Cluster cards (collapsed "N without further descendants" groups) ---
  const clusterCards = nodeG.selectAll("g.cluster-card").data(collapsedClusterNodes, (d) => d.id);
  clusterCards.exit().remove();
  const clusterCardsEnter = clusterCards.enter().append("g").attr("class", "cluster-card");
  buildClusterCardSkeleton(clusterCardsEnter);
  const allClusterCards = clusterCardsEnter.merge(clusterCards);
  allClusterCards.attr("transform", (d) => `translate(${d.sx - CARD_WIDTH / 2}, ${d.sy - CARD_HEIGHT / 2})`);
  updateClusterCardContent(allClusterCards);
  allClusterCards.on("click", (event, d) => {
    event.preventDefault();
    state.collapsedDescendants.delete(d.id);
    render();
  });

  // --- Cluster collapse toggles (float above an expanded cluster's grid) ---
  const clusterToggleSel = nodeG.selectAll("g.cluster-collapse-toggle").data(clusterCollapseToggles, (d) => d.id);
  clusterToggleSel.exit().remove();
  const clusterToggleEnter = clusterToggleSel.enter().append("g").attr("class", "toggle-btn cluster-collapse-toggle");
  clusterToggleEnter.append("circle").attr("r", TOGGLE_R);
  clusterToggleEnter.append("text").text("−");
  const allClusterToggles = clusterToggleEnter.merge(clusterToggleSel);
  allClusterToggles.attr("transform", (d) => `translate(${d.x}, ${d.y})`);
  allClusterToggles.on("click", (event, d) => {
    event.preventDefault();
    state.collapsedDescendants.add(d.id);
    render();
  });

  // --- Mini (leaf-cluster) member cards ---
  const miniSel = nodeG.selectAll("g.mini-card").data(miniMembers, (d) => d.person.id);
  miniSel.exit().remove();
  const miniEnter = miniSel.enter().append("g").attr("class", "mini-card");
  buildMiniCardSkeleton(miniEnter);
  const allMiniCards = miniEnter.merge(miniSel);
  allMiniCards.attr("transform", (d) => `translate(${d.x - MINI_CARD_WIDTH / 2}, ${d.y - MINI_CARD_HEIGHT / 2})`);
  allMiniCards.classed(
    "search-match",
    (d) => searchQuery.length > 0 && d.person.name.toLowerCase().includes(searchQuery)
  );
  allMiniCards.classed("auxiliary-mini", (d) => !!d.isAuxiliary);
  allMiniCards.select("circle.avatar-circle").attr("fill", (d) => relColor(d.person.relationship ?? 0));
  allMiniCards.select("text.avatar-initials").text((d) => initials(d.person.name));
  allMiniCards.select("text.node-name").text((d) => truncateName(d.person.name, 17));
  allMiniCards.on("click", (event, d) => {
    if (event.defaultPrevented) return;
    openDetailPanel(d.person);
  });

  const fitExtentNodes = allNodes
    .map((n) => ({ x: n.sx, y: n.sy }))
    .concat(miniMembers.map((m) => ({ x: m.x, y: m.y })));
  document.getElementById("zoom-fit").onclick = () => fitToView(fitExtentNodes, true);
  if (opts.refit) {
    fitToView(fitExtentNodes, opts.animate !== false);
  }

  updateHeaderSubtitle();
  updateBreadcrumb();
}

function buildMiniCardSkeleton(sel) {
  sel
    .append("rect")
    .attr("class", "card-bg")
    .attr("width", MINI_CARD_WIDTH)
    .attr("height", MINI_CARD_HEIGHT)
    .attr("rx", 8);
  sel
    .append("circle")
    .attr("class", "avatar-circle")
    .attr("cx", 8 + 11)
    .attr("cy", MINI_CARD_HEIGHT / 2)
    .attr("r", 11);
  sel
    .append("text")
    .attr("class", "avatar-initials")
    .attr("x", 8 + 11)
    .attr("y", MINI_CARD_HEIGHT / 2 + 1)
    .style("font-size", "9px");
  sel
    .append("text")
    .attr("class", "node-name")
    .attr("x", 8 + 22 + 8)
    .attr("y", MINI_CARD_HEIGHT / 2 + 4)
    .style("font-size", "11px");
}

function buildCardSkeleton(sel) {
  sel.append("rect").attr("class", "card-bg").attr("width", CARD_WIDTH).attr("height", CARD_HEIGHT).attr("rx", 10);
  sel
    .append("circle")
    .attr("class", "avatar-circle")
    .attr("cx", 12 + AVATAR_R)
    .attr("cy", CARD_HEIGHT / 2)
    .attr("r", AVATAR_R);
  sel
    .append("text")
    .attr("class", "avatar-initials")
    .attr("x", 12 + AVATAR_R)
    .attr("y", CARD_HEIGHT / 2 + 1);
  sel
    .append("text")
    .attr("class", "node-name")
    .attr("x", 12 + AVATAR_R * 2 + 10)
    .attr("y", CARD_HEIGHT / 2 - 6);
  sel
    .append("text")
    .attr("class", "node-meta")
    .attr("x", 12 + AVATAR_R * 2 + 10)
    .attr("y", CARD_HEIGHT / 2 + 12);

  const ancestorToggle = sel.append("g").attr("class", "toggle-btn ancestor-toggle");
  ancestorToggle.append("circle").attr("r", TOGGLE_R);
  ancestorToggle.append("text");

  const descendantToggle = sel.append("g").attr("class", "toggle-btn descendant-toggle");
  descendantToggle.append("circle").attr("r", TOGGLE_R);
  descendantToggle.append("text");

  const badge = sel.append("g").attr("class", "toggle-badge-group");
  badge.append("circle").attr("class", "toggle-badge").attr("r", 8);
  badge.append("text").attr("class", "toggle-badge-text");
}

// A collapsed cluster's card - same footprint as a person card, but
// visually distinct (dashed border, neutral avatar, no relationship
// color) since it represents a group, not an individual. The whole card is
// clickable to expand; there's no ancestor-toggle since a cluster isn't a
// person you could isolate on.
function buildClusterCardSkeleton(sel) {
  sel.append("rect").attr("class", "card-bg cluster-card-bg").attr("width", CARD_WIDTH).attr("height", CARD_HEIGHT).attr("rx", 10);
  sel
    .append("circle")
    .attr("class", "avatar-circle cluster-avatar")
    .attr("cx", 12 + AVATAR_R)
    .attr("cy", CARD_HEIGHT / 2)
    .attr("r", AVATAR_R);
  sel
    .append("text")
    .attr("class", "avatar-initials")
    .attr("x", 12 + AVATAR_R)
    .attr("y", CARD_HEIGHT / 2 + 1);
  sel
    .append("text")
    .attr("class", "node-name")
    .attr("x", 12 + AVATAR_R * 2 + 10)
    .attr("y", CARD_HEIGHT / 2 - 6);
  sel
    .append("text")
    .attr("class", "node-meta")
    .attr("x", 12 + AVATAR_R * 2 + 10)
    .attr("y", CARD_HEIGHT / 2 + 12)
    .text("no further descendants");

  const expandToggle = sel.append("g").attr("class", "toggle-btn cluster-expand-toggle");
  expandToggle.attr("transform", `translate(${CARD_WIDTH}, ${CARD_HEIGHT / 2})`);
  expandToggle.append("circle").attr("r", TOGGLE_R);
  expandToggle.append("text").text("+");
}

function updateClusterCardContent(sel) {
  sel.select("text.avatar-initials").text((d) => (d.hiddenCount > 99 ? "99+" : d.hiddenCount));
  sel.select("text.node-name").text((d) => `${d.hiddenCount} student${d.hiddenCount === 1 ? "" : "s"}`);
}

// Toggle buttons sit on the "incoming" (ancestor) and "outgoing"
// (descendant) edges of a card, which edge that is depends on which way
// generations flow in the current orientation.
function toggleLayout() {
  if (state.orientation === "portrait") {
    return {
      ancestor: { x: CARD_WIDTH / 2, y: 0, glyph: "‹", badgeDx: -TOGGLE_R * 1.6, badgeDy: -TOGGLE_R * 2 },
      descendant: { x: CARD_WIDTH / 2, y: CARD_HEIGHT, glyph: null, badgeDx: TOGGLE_R * 1.6, badgeDy: TOGGLE_R * 2 },
    };
  }
  return {
    ancestor: { x: 0, y: CARD_HEIGHT / 2, glyph: "‹", badgeDx: 0, badgeDy: 0 },
    descendant: { x: CARD_WIDTH, y: CARD_HEIGHT / 2, glyph: null, badgeDx: TOGGLE_R * 2, badgeDy: -TOGGLE_R * 1.6 },
  };
}

function updateCardContent(sel) {
  sel.select("circle.avatar-circle").attr("fill", (d) => relColor(d.person.relationship ?? 0));
  sel.select("text.avatar-initials").text((d) => initials(d.person.name));
  sel.select("text.node-name").text((d) => truncateName(d.person.name));
  sel.select("text.node-meta").text((d) => relLabel(d.person.relationship ?? 0));

  const layout = toggleLayout();

  sel
    .select(".ancestor-toggle")
    .attr("transform", `translate(${layout.ancestor.x}, ${layout.ancestor.y})`)
    .style("display", (d) => (primaryParentId(d.person) !== null && d.id !== state.viewRootId ? null : "none"))
    .on("click", (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      state.viewRootId = d.id;
      render({ refit: true });
    });
  sel.select(".ancestor-toggle text").text(layout.ancestor.glyph);

  sel
    .select(".descendant-toggle")
    .attr("transform", `translate(${layout.descendant.x}, ${layout.descendant.y})`)
    .style("display", (d) => (d.hasRawChildren ? null : "none"))
    .on("click", (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.collapsedDescendants.has(d.id)) {
        state.collapsedDescendants.delete(d.id);
      } else {
        state.collapsedDescendants.add(d.id);
      }
      render();
    });
  sel.select(".descendant-toggle text").text((d) => (d.collapsed ? "+" : "−"));

  sel
    .select(".toggle-badge-group")
    .attr("transform", (d) =>
      `translate(${layout.descendant.x + layout.descendant.badgeDx}, ${layout.descendant.y + layout.descendant.badgeDy})`
    )
    .style("display", (d) => (d.collapsed ? null : "none"));
  sel.select(".toggle-badge-text").text((d) => (d.hiddenCount > 99 ? "99+" : d.hiddenCount));
}

function truncateName(name, maxChars = 20) {
  return name.length > maxChars ? name.slice(0, maxChars - 1) + "…" : name;
}

function updateHeaderSubtitle() {
  const total = state.people.length;
  const visible = state.lastNodePositions.size;
  const el = document.getElementById("header-subtitle");
  if (state.viewRootId) {
    const focal = state.byId.get(state.viewRootId);
    el.textContent = focal ? `Focused on ${focal.name} – ${visible} shown` : "";
  } else {
    el.textContent = `${visible} of ${total} individuals shown`;
  }
}

// ---------- Breadcrumb (ancestor re-root trail) ----------

function updateBreadcrumb() {
  const bar = document.getElementById("breadcrumb");
  if (!state.viewRootId) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = "";

  const home = document.createElement("span");
  home.className = "crumb";
  home.textContent = "\u{1F3E0} Full Tree";
  home.onclick = () => {
    state.viewRootId = null;
    render({ refit: true });
  };
  bar.appendChild(home);

  const chain = getAncestorChain(state.viewRootId);
  for (const ancestor of chain) {
    bar.appendChild(sep());
    const crumb = document.createElement("span");
    crumb.className = "crumb";
    crumb.textContent = ancestor.name;
    crumb.onclick = () => {
      state.viewRootId = ancestor.id;
      render({ refit: true });
    };
    bar.appendChild(crumb);
  }

  bar.appendChild(sep());
  const current = document.createElement("span");
  current.className = "crumb current";
  current.textContent = state.byId.get(state.viewRootId)?.name || "";
  bar.appendChild(current);

  function sep() {
    const s = document.createElement("span");
    s.className = "crumb-sep";
    s.textContent = "›";
    return s;
  }
}

// ---------- Zoom / pan / fit ----------

function setupZoom() {
  svg = d3.select("#tree-svg");
  zoomLayer = svg.append("g").attr("class", "zoom-layer");
  zoomBehavior = d3
    .zoom()
    .scaleExtent([0.1, 2.5])
    .on("zoom", (event) => {
      zoomLayer.attr("transform", event.transform);
    });
  svg.call(zoomBehavior);
}

// Trees small enough to read at a glance are scaled to fit the viewport
// exactly. Trees too large for that (hundreds of nodes) settle on a
// comfortably legible zoom level instead of shrinking everything into an
// illegible sliver - the user pans/zooms or collapses branches from there,
// same as any large graph viewer.
const MIN_COMFORTABLE_SCALE = 0.6;

function fitToView(points, animate) {
  if (!points || points.length === 0) return;
  const container = document.getElementById("tree-container");
  const width = container.clientWidth;
  const height = container.clientHeight;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x - CARD_WIDTH / 2 - 20);
    maxX = Math.max(maxX, p.x + CARD_WIDTH / 2 + 20);
    minY = Math.min(minY, p.y - CARD_HEIGHT / 2 - 10);
    maxY = Math.max(maxY, p.y + CARD_HEIGHT / 2 + 10);
  }
  const boxWidth = Math.max(maxX - minX, 1);
  const boxHeight = Math.max(maxY - minY, 1);
  const naiveScale = Math.min(width / boxWidth, height / boxHeight, 1.1);

  let scale, cx, cy;
  if (naiveScale >= MIN_COMFORTABLE_SCALE) {
    scale = naiveScale;
    cx = minX + boxWidth / 2;
    cy = minY + boxHeight / 2;
  } else {
    scale = MIN_COMFORTABLE_SCALE;
    cx = minX + Math.min(boxWidth, width / scale) / 2;
    cy = minY + boxHeight / 2;
  }

  const tx = width / 2 - scale * cx;
  const ty = height / 2 - scale * cy;
  const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);

  const target = animate ? svg.transition().duration(400) : svg;
  target.call(zoomBehavior.transform, transform);
}

function focusOnNode(id) {
  const pos = state.lastNodePositions.get(id);
  if (!pos) return;
  const container = document.getElementById("tree-container");
  const width = container.clientWidth;
  const height = container.clientHeight;
  const currentScale = d3.zoomTransform(svg.node()).k;
  const scale = Math.max(currentScale, 0.6);
  const transform = d3.zoomIdentity.translate(width / 2 - scale * pos.x, height / 2 - scale * pos.y).scale(scale);
  svg.transition().duration(400).call(zoomBehavior.transform, transform);
}

// ---------- Search ----------

function setupSearch() {
  const input = document.getElementById("search-input");
  const resultsBox = document.getElementById("search-results");

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    renderCardHighlights();
    if (!q) {
      resultsBox.classList.add("hidden");
      resultsBox.innerHTML = "";
      return;
    }
    const matches = state.people
      .filter((p) => p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 30);

    resultsBox.innerHTML = "";
    if (matches.length === 0) {
      const div = document.createElement("div");
      div.className = "search-result-empty";
      div.textContent = "No matches.";
      resultsBox.appendChild(div);
    } else {
      for (const p of matches) {
        const div = document.createElement("div");
        div.className = "search-result-item";
        div.innerHTML = `<span class="result-name"></span><span class="result-meta"></span>`;
        div.querySelector(".result-name").textContent = p.name;
        div.querySelector(".result-meta").textContent = relLabel(p.relationship ?? 0);
        div.onclick = () => {
          resultsBox.classList.add("hidden");
          revealAndFocus(p.id);
        };
        resultsBox.appendChild(div);
      }
    }
    resultsBox.classList.remove("hidden");
  });

  document.addEventListener("click", (event) => {
    if (!document.getElementById("search-box").contains(event.target)) {
      resultsBox.classList.add("hidden");
    }
  });
}

function renderCardHighlights() {
  const q = (document.getElementById("search-input").value || "").trim().toLowerCase();
  d3.selectAll("g.node-card").classed(
    "search-match",
    (d) => q.length > 0 && d.person.name.toLowerCase().includes(q)
  );
  d3.selectAll("g.mini-card").classed(
    "search-match",
    (d) => q.length > 0 && d.person.name.toLowerCase().includes(q)
  );
}

// Expands any collapsed ancestors (and resets an unrelated re-root) so a
// person becomes visible, then pans/zooms to center on them.
function revealAndFocus(id) {
  const person = state.byId.get(id);
  if (!person) return;
  if (!isVisibleType(person)) {
    alert(`"${person.name}" is currently hidden by a filter (${relLabel(person.relationship ?? 0)}). Enable that filter to view them.`);
    return;
  }

  const chain = getAncestorChain(id); // [root ... primary parent]
  for (const ancestor of chain) {
    state.collapsedDescendants.delete(ancestor.id);
    state.collapsedDescendants.delete(clusterIdFor(ancestor.id));
  }
  const ownParent = primaryParentId(person);
  if (ownParent !== null) {
    state.collapsedDescendants.delete(clusterIdFor(ownParent));
  }

  if (state.viewRootId) {
    const chainIds = new Set(chain.map((a) => a.id));
    if (state.viewRootId !== id && !chainIds.has(state.viewRootId)) {
      state.viewRootId = null;
    }
  }

  render();
  focusOnNode(id);
}

// ---------- Filters ----------

function setupFilters() {
  const list = document.getElementById("filter-list");
  list.innerHTML = "";
  for (const rel of Object.keys(RELATIONSHIP_LABELS).map(Number)) {
    const row = document.createElement("label");
    row.className = "filter-row";
    const count = state.people.filter((p) => (p.relationship ?? 0) === rel).length;
    row.innerHTML = `
      <input type="checkbox" checked data-rel="${rel}">
      <span class="filter-swatch" style="background:${relColor(rel)}"></span>
      <span>${relLabel(rel)}</span>
      <span class="filter-count">${count}</span>
    `;
    row.querySelector("input").checked = state.visibleTypes.has(rel);
    row.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) state.visibleTypes.add(rel);
      else state.visibleTypes.delete(rel);
      render({ refit: true });
    });
    list.appendChild(row);
  }

  document.getElementById("filter-toggle").addEventListener("click", () => {
    const panel = document.getElementById("filter-panel");
    panel.classList.toggle("hidden");
    document.getElementById("filter-toggle").classList.toggle("active", !panel.classList.contains("hidden"));
  });

  document.getElementById("filter-all").addEventListener("click", () => {
    state.visibleTypes = new Set(Object.keys(RELATIONSHIP_LABELS).map(Number));
    list.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.checked = true));
    render({ refit: true });
  });
  document.getElementById("filter-none").addEventListener("click", () => {
    state.visibleTypes = new Set();
    list.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.checked = false));
    render({ refit: true });
  });
}

// ---------- Orientation ----------

function setupOrientation() {
  const buttons = document.querySelectorAll("#orientation-group button");
  buttons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.orientation === state.orientation);
    btn.addEventListener("click", () => {
      state.orientation = btn.dataset.orientation;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      render({ refit: true });
    });
  });
}

// ---------- Upload JSON ----------

function setupUpload() {
  const input = document.getElementById("upload-input");
  document.getElementById("upload-btn").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let people;
      try {
        people = JSON.parse(reader.result);
        if (!Array.isArray(people)) throw new Error("File must contain a JSON array of individuals.");
      } catch (e) {
        alert(`Could not load "${file.name}": ${e.message}`);
        input.value = "";
        return;
      }
      loadPeople(people, `Loaded ${people.length} individuals from ${file.name}.`);
      input.value = "";
    };
    reader.onerror = () => alert(`Could not read "${file.name}".`);
    reader.readAsText(file);
  });
}

function loadPeople(people, statusMessage) {
  state.people = people;
  const { byId, childrenByParent, coAdvisorEdges } = buildIndex(people);
  state.byId = byId;
  state.childrenByParent = childrenByParent;
  state.coAdvisorEdges = coAdvisorEdges;
  state.collapsedDescendants = computeDefaultCollapsed();
  state.viewRootId = null;
  setupFilters();
  render({ refit: true, animate: false });
  if (statusMessage) {
    const el = document.getElementById("header-subtitle");
    const original = el.textContent;
    el.textContent = statusMessage;
    setTimeout(() => {
      if (el.textContent === statusMessage) updateHeaderSubtitle();
    }, 3000);
  }
}

// ---------- Detail panel ----------

function openDetailPanel(person) {
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");
  const rel = person.relationship ?? 0;
  const advisors = parentIdsOf(person)
    .map((id) => state.byId.get(id))
    .filter(Boolean);
  const descendantCount = countDescendants(person.id);
  const childCount = (state.childrenByParent.get(person.id) || []).length;

  content.innerHTML = "";

  const avatar = document.createElement("div");
  avatar.className = "detail-avatar";
  avatar.style.background = relColor(rel);
  avatar.textContent = initials(person.name);
  content.appendChild(avatar);

  const name = document.createElement("div");
  name.className = "detail-name";
  name.textContent = person.name;
  content.appendChild(name);

  const idLine = document.createElement("div");
  idLine.className = "detail-id";
  idLine.textContent = person.id;
  content.appendChild(idLine);

  const badge = document.createElement("div");
  badge.className = "detail-badge";
  badge.style.background = relColor(rel);
  badge.textContent = relLabel(rel);
  content.appendChild(badge);

  const relSection = document.createElement("div");
  relSection.className = "detail-section";
  relSection.innerHTML = "<h3>Relationships</h3>";
  if (advisors.length === 0) {
    relSection.appendChild(detailRow("Advisor / parent", "— (root)"));
  } else {
    for (const advisor of advisors) {
      const label = advisors.length > 1 ? "Co-advisor" : "Advisor / parent";
      relSection.appendChild(detailRow(label, advisor.name));
    }
  }
  relSection.appendChild(detailRow("Direct students", String(childCount)));
  relSection.appendChild(detailRow("Total descendants", String(descendantCount)));
  for (const advisor of advisors) {
    if (state.lastNodePositions.has(advisor.id)) {
      const link = document.createElement("div");
      link.className = "detail-link-btn";
      link.textContent = `Go to ${advisor.name} →`;
      link.onclick = () => focusOnNode(advisor.id);
      relSection.appendChild(link);
    }
  }
  content.appendChild(relSection);

  const extraEntries = Object.entries(person.extra || {});
  if (extraEntries.length > 0) {
    const extraSection = document.createElement("div");
    extraSection.className = "detail-section";
    extraSection.innerHTML = "<h3>Additional info</h3>";
    for (const [key, value] of extraEntries) {
      extraSection.appendChild(detailRow(prettifyKey(key), String(value)));
    }
    content.appendChild(extraSection);
  }

  panel.classList.remove("hidden");
}

function detailRow(key, value) {
  const row = document.createElement("div");
  row.className = "detail-row";
  row.innerHTML = `<span class="detail-key"></span><span class="detail-value"></span>`;
  row.querySelector(".detail-key").textContent = key;
  row.querySelector(".detail-value").textContent = value;
  return row;
}

function prettifyKey(key) {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function setupDetailPanel() {
  document.getElementById("detail-close").addEventListener("click", () => {
    document.getElementById("detail-panel").classList.add("hidden");
  });
}

// ---------- Init ----------

function setupZoomControls() {
  document.getElementById("zoom-in").onclick = () => svg.transition().duration(150).call(zoomBehavior.scaleBy, 1.3);
  document.getElementById("zoom-out").onclick = () => svg.transition().duration(150).call(zoomBehavior.scaleBy, 1 / 1.3);
}

function setupViewButtons() {
  document.getElementById("reset-view").addEventListener("click", () => {
    state.viewRootId = null;
    render({ refit: true });
  });
  document.getElementById("expand-all").addEventListener("click", () => {
    state.collapsedDescendants.clear();
    render({ refit: true });
  });
}

function setupResize() {
  let timer = null;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => render({ refit: true, animate: false }), 200);
  });
}

async function init() {
  setupZoom();
  setupSearch();
  setupDetailPanel();
  setupZoomControls();
  setupViewButtons();
  setupOrientation();
  setupUpload();
  setupResize();

  let people;
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    people = await res.json();
  } catch (err) {
    document.getElementById("empty-state").classList.remove("hidden");
    document.getElementById("empty-state").textContent =
      `Could not load ${DATA_URL}. If you opened this file directly, run a local server instead (see README), or use "Upload JSON" above.`;
    console.error("Failed to load tree data:", err);
    return;
  }

  loadPeople(people);
}

init();
