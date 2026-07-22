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
const NODE_V_SPACING = CARD_HEIGHT + 22;
const NODE_H_SPACING = CARD_WIDTH + 76;
const AVATAR_R = 16;
const TOGGLE_R = 9;
const DATA_URL = new URLSearchParams(location.search).get("data") || "data.json";

// A "leaf cluster" is a person whose children have no children of their own
// (e.g. a cohort of students with no students of their own). Instead of
// giving each one its own full-size row - which makes trees with a few
// prolific advisors absurdly tall - its members are grouped into a compact
// grid by relationship type, anchored just to the right of the parent card.
const MINI_CARD_WIDTH = 148;
const MINI_CARD_HEIGHT = 34;
const MINI_GAP_X = 10;
const MINI_GAP_Y = 7;
const MINI_GROUP_GAP_Y = 22;
const MINI_GROUP_LABEL_HEIGHT = 16;
const MINI_MAX_COLS = 6;

const state = {
  people: [],
  byId: new Map(),
  childrenByParent: new Map(),
  collapsedDescendants: new Set(),
  viewRootId: null,
  visibleTypes: new Set([0, 1, 2, 3, 4]),
  lastNodePositions: new Map(), // id -> {x, y} in world space, set on every render
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

// ---------- Data indexing ----------

function buildIndex(people) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const childrenByParent = new Map();
  for (const p of people) {
    if (p.parent !== null && p.parent !== undefined && byId.has(p.parent)) {
      if (!childrenByParent.has(p.parent)) childrenByParent.set(p.parent, []);
      childrenByParent.get(p.parent).push(p);
    }
  }
  for (const kids of childrenByParent.values()) {
    kids.sort((a, b) => a.name.localeCompare(b.name));
  }
  return { byId, childrenByParent };
}

// Collapses every person whose children are all themselves childless, so
// large terminal cohorts start tucked away and branches that keep growing
// get visual priority when a tree is first opened.
function computeDefaultCollapsed() {
  const collapsed = new Set();
  for (const [pid, kids] of state.childrenByParent.entries()) {
    if (kids.length > 0 && kids.every((k) => !(state.childrenByParent.get(k.id) || []).length)) {
      collapsed.add(pid);
    }
  }
  return collapsed;
}

function isTrueRoot(person) {
  return person.parent === null || person.parent === undefined || !state.byId.has(person.parent);
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
  // Returns [root, ..., parentOfId] using the *true* (unfiltered) parent links.
  const chain = [];
  let current = state.byId.get(id);
  const seen = new Set();
  while (current && current.parent && state.byId.has(current.parent) && !seen.has(current.parent)) {
    seen.add(current.parent);
    const parent = state.byId.get(current.parent);
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

function isLeafClusterChildren(kids) {
  return kids.length > 0 && kids.every((k) => !(state.childrenByParent.get(k.id) || []).length);
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
      const blockWidth = cols * (MINI_CARD_WIDTH + MINI_GAP_X) - MINI_GAP_X;
      const blockHeight = MINI_GROUP_LABEL_HEIGHT + rows * (MINI_CARD_HEIGHT + MINI_GAP_Y) - MINI_GAP_Y;
      return { relationship: rel, members, cols, rows, blockWidth, blockHeight };
    });
  const totalHeight = groups.reduce((s, g) => s + g.blockHeight, 0) + MINI_GROUP_GAP_Y * Math.max(0, groups.length - 1);
  const totalWidth = groups.reduce((m, g) => Math.max(m, g.blockWidth), 0);
  return { groups, totalHeight, totalWidth };
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
  if (isLeafClusterChildren(effectiveKids)) {
    node.children = [];
    node.leafCluster = buildLeafClusterLayout(effectiveKids);
  } else {
    node.children = effectiveKids.map((kid) => buildNode(kid, depth + 1, nextPath));
  }
  return node;
}

function leafClusterVerticalUnits(d) {
  const lc = d.data.leafCluster;
  return lc ? Math.max(1, lc.totalHeight / NODE_V_SPACING + 0.5) : 1;
}

// Computes screen positions for every member inside a leaf-cluster's grid,
// anchored just to the right of the (already-laid-out) parent node.
function computeLeafClusterPositions(d) {
  const lc = d.data.leafCluster;
  const baseX = d.y + NODE_H_SPACING;
  const groupLabels = [];
  const members = [];
  let cursorY = d.x - lc.totalHeight / 2;

  for (const group of lc.groups) {
    groupLabels.push({ x: baseX, y: cursorY + MINI_GROUP_LABEL_HEIGHT - 4, relationship: group.relationship, count: group.members.length });
    const gridTop = cursorY + MINI_GROUP_LABEL_HEIGHT;
    for (let i = 0; i < group.members.length; i++) {
      const col = i % group.cols;
      const row = Math.floor(i / group.cols);
      members.push({
        person: group.members[i],
        x: baseX + col * (MINI_CARD_WIDTH + MINI_GAP_X),
        y: gridTop + row * (MINI_CARD_HEIGHT + MINI_GAP_Y),
        parentId: d.data.id,
      });
    }
    cursorY += group.blockHeight + MINI_GROUP_GAP_Y;
  }
  return { groupLabels, members };
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

  let dataRoot;
  if (forest.length === 1) {
    dataRoot = forest[0];
  } else {
    dataRoot = { id: "__forest_root__", synthetic: true, children: forest, depth: -1 };
  }

  const root = d3.hierarchy(dataRoot, (d) => d.children);
  const treeLayout = d3
    .tree()
    .nodeSize([NODE_V_SPACING, NODE_H_SPACING])
    .separation((a, b) => {
      const base = a.parent === b.parent ? 1 : 2;
      return (base * (leafClusterVerticalUnits(a) + leafClusterVerticalUnits(b))) / 2;
    });
  treeLayout(root);

  const allNodes = root.descendants().filter((d) => !d.data.synthetic);
  const allLinks = root.links().filter((d) => !d.source.data.synthetic);

  state.lastNodePositions.clear();
  for (const d of allNodes) {
    state.lastNodePositions.set(d.data.id, { x: d.y, y: d.x });
  }

  // Leaf-cluster grids: computed after the main layout so they can anchor
  // off each parent's final position.
  const miniGroupLabels = [];
  const miniMembers = [];
  const miniLinks = [];
  for (const d of allNodes) {
    if (!d.data.leafCluster) continue;
    const { groupLabels, members } = computeLeafClusterPositions(d);
    miniGroupLabels.push(...groupLabels);
    miniMembers.push(...members);
    for (const m of members) {
      miniLinks.push({ id: m.person.id, sx: d.y, sy: d.x, tx: m.x, ty: m.y + MINI_CARD_HEIGHT / 2 });
    }
  }
  for (const m of miniMembers) {
    state.lastNodePositions.set(m.person.id, { x: m.x + MINI_CARD_WIDTH / 2, y: m.y + MINI_CARD_HEIGHT / 2 });
  }

  const searchQuery = (document.getElementById("search-input").value || "").trim().toLowerCase();

  // --- Links ---
  const linkGen = d3
    .linkHorizontal()
    .x((d) => d.y)
    .y((d) => d.x);

  const linkSel = zoomLayer.selectAll("g.links").data([null]);
  const linkG = linkSel.enter().append("g").attr("class", "links").merge(linkSel);
  const linkPaths = linkG.selectAll("path.link").data(allLinks, (d) => d.target.data.id);
  linkPaths.exit().remove();
  linkPaths
    .enter()
    .append("path")
    .attr("class", "link")
    .merge(linkPaths)
    .attr("d", linkGen);

  const miniLinkGen = d3
    .linkHorizontal()
    .x((d) => d.x)
    .y((d) => d.y);
  const miniLinkPaths = linkG.selectAll("path.mini-link").data(miniLinks, (d) => d.id);
  miniLinkPaths.exit().remove();
  miniLinkPaths
    .enter()
    .append("path")
    .attr("class", "mini-link")
    .merge(miniLinkPaths)
    .attr("d", (d) => miniLinkGen({ source: { x: d.sx, y: d.sy }, target: { x: d.tx, y: d.ty } }));

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
  const nodeSel = zoomLayer.selectAll("g.nodes").data([null]);
  const nodeG = nodeSel.enter().append("g").attr("class", "nodes").merge(nodeSel);
  const cards = nodeG.selectAll("g.node-card").data(allNodes, (d) => d.data.id);
  cards.exit().remove();

  const cardsEnter = cards.enter().append("g").attr("class", "node-card");
  buildCardSkeleton(cardsEnter);

  const allCards = cardsEnter.merge(cards);
  allCards.attr("transform", (d) => `translate(${d.y - CARD_WIDTH / 2}, ${d.x - CARD_HEIGHT / 2})`);
  allCards.classed("collapsed", (d) => !!d.data.collapsed);
  allCards.classed(
    "search-match",
    (d) => searchQuery.length > 0 && d.data.person.name.toLowerCase().includes(searchQuery)
  );
  updateCardContent(allCards);

  allCards.on("click", (event, d) => {
    if (event.defaultPrevented) return;
    openDetailPanel(d.data.person);
  });

  // --- Mini (leaf-cluster) member cards ---
  const miniSel = nodeG.selectAll("g.mini-card").data(miniMembers, (d) => d.person.id);
  miniSel.exit().remove();
  const miniEnter = miniSel.enter().append("g").attr("class", "mini-card");
  buildMiniCardSkeleton(miniEnter);
  const allMiniCards = miniEnter.merge(miniSel);
  allMiniCards.attr("transform", (d) => `translate(${d.x}, ${d.y})`);
  allMiniCards.classed(
    "search-match",
    (d) => searchQuery.length > 0 && d.person.name.toLowerCase().includes(searchQuery)
  );
  allMiniCards.select("circle.avatar-circle").attr("fill", (d) => relColor(d.person.relationship ?? 0));
  allMiniCards.select("text.avatar-initials").text((d) => initials(d.person.name));
  allMiniCards.select("text.node-name").text((d) => truncateName(d.person.name, 17));
  allMiniCards.on("click", (event, d) => {
    if (event.defaultPrevented) return;
    openDetailPanel(d.person);
  });

  const fitExtentNodes = allNodes.concat(
    miniMembers.map((m) => ({ y: m.x + MINI_CARD_WIDTH / 2, x: m.y + MINI_CARD_HEIGHT / 2, mini: true }))
  );
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
  ancestorToggle.append("text").text("‹");

  const descendantToggle = sel.append("g").attr("class", "toggle-btn descendant-toggle");
  descendantToggle.append("circle").attr("r", TOGGLE_R);
  descendantToggle.append("text");

  const badge = sel.append("g").attr("class", "toggle-badge-group");
  badge.append("circle").attr("class", "toggle-badge").attr("r", 8);
  badge.append("text").attr("class", "toggle-badge-text");
}

function updateCardContent(sel) {
  sel.select("circle.avatar-circle").attr("fill", (d) => relColor(d.data.person.relationship ?? 0));
  sel.select("text.avatar-initials").text((d) => initials(d.data.person.name));
  sel.select("text.node-name").text((d) => truncateName(d.data.person.name));
  sel.select("text.node-meta").text((d) => relLabel(d.data.person.relationship ?? 0));

  sel
    .select(".ancestor-toggle")
    .attr("transform", `translate(0, ${CARD_HEIGHT / 2})`)
    .style("display", (d) => (d.data.person.parent && d.data.id !== state.viewRootId ? null : "none"))
    .on("click", (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      state.viewRootId = d.data.id;
      render({ refit: true });
    });

  sel
    .select(".descendant-toggle")
    .attr("transform", `translate(${CARD_WIDTH}, ${CARD_HEIGHT / 2})`)
    .style("display", (d) => (d.data.hasRawChildren ? null : "none"))
    .on("click", (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.collapsedDescendants.has(d.data.id)) {
        state.collapsedDescendants.delete(d.data.id);
      } else {
        state.collapsedDescendants.add(d.data.id);
      }
      render();
    });
  sel.select(".descendant-toggle text").text((d) => (d.data.collapsed ? "+" : "−"));

  sel
    .select(".toggle-badge-group")
    .attr("transform", `translate(${CARD_WIDTH + TOGGLE_R * 2}, ${CARD_HEIGHT / 2 - TOGGLE_R * 1.6})`)
    .style("display", (d) => (d.data.collapsed ? null : "none"));
  sel.select(".toggle-badge-text").text((d) => (d.data.hiddenCount > 99 ? "99+" : d.data.hiddenCount));
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
    .scaleExtent([0.15, 2.5])
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

function fitToView(nodes, animate) {
  if (!nodes || nodes.length === 0) return;
  const container = document.getElementById("tree-container");
  const width = container.clientWidth;
  const height = container.clientHeight;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const d of nodes) {
    minX = Math.min(minX, d.y - CARD_WIDTH / 2 - 20);
    maxX = Math.max(maxX, d.y + CARD_WIDTH / 2 + 20);
    minY = Math.min(minY, d.x - CARD_HEIGHT / 2 - 10);
    maxY = Math.max(maxY, d.x + CARD_HEIGHT / 2 + 10);
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
    (d) => q.length > 0 && d.data.person.name.toLowerCase().includes(q)
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

  const chain = getAncestorChain(id); // [root ... parent]
  for (const ancestor of chain) {
    state.collapsedDescendants.delete(ancestor.id);
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

// ---------- Detail panel ----------

function openDetailPanel(person) {
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");
  const rel = person.relationship ?? 0;
  const parent = person.parent ? state.byId.get(person.parent) : null;
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
  relSection.appendChild(detailRow("Advisor / parent", parent ? parent.name : "— (root)"));
  relSection.appendChild(detailRow("Direct students", String(childCount)));
  relSection.appendChild(detailRow("Total descendants", String(descendantCount)));
  if (parent && state.lastNodePositions.has(parent.id)) {
    const link = document.createElement("div");
    link.className = "detail-link-btn";
    link.textContent = `Go to ${parent.name} →`;
    link.onclick = () => focusOnNode(parent.id);
    relSection.appendChild(link);
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
  setupResize();

  let people;
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    people = await res.json();
  } catch (err) {
    document.getElementById("empty-state").classList.remove("hidden");
    document.getElementById("empty-state").textContent =
      `Could not load ${DATA_URL}. If you opened this file directly, run a local server instead (see README).`;
    console.error("Failed to load tree data:", err);
    return;
  }

  state.people = people;
  const { byId, childrenByParent } = buildIndex(people);
  state.byId = byId;
  state.childrenByParent = childrenByParent;
  state.collapsedDescendants = computeDefaultCollapsed();

  setupFilters();
  render({ refit: true, animate: false });
}

init();
