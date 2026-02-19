// ═══════════════════════════════════════════════════════════════════
// NodeFlow v2 — DOM + Offline-First Rewrite
// ═══════════════════════════════════════════════════════════════════

// ═══ CONFIG ═══
const SUPABASE_URL = 'https://qsphmbquuruguemgdiym.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-uS8PtHTOvoVc5-MZrkvrA_Wbt5ljBz';
const MAP_ID = 'default';
const DB_NAME = 'nodeflow';
const DB_VERSION = 1;

// ═══ CONSTANTS ═══
const COLORS = ['#7c6fef','#ef6f8a','#6fefb2','#efcf6f','#6fb8ef','#ef8f6f','#b86fef','#6fefd4'];
const STATUSES = {
  none:  { label:'\u2014', bg:'transparent',   fg:'#555' },
  todo:  { label:'\u25CB', bg:'#3a2d2d',       fg:'#ef6f8a' },
  doing: { label:'\u25D0', bg:'#3a3520',       fg:'#efcf6f' },
  done:  { label:'\u25CF', bg:'#1e3a2a',       fg:'#6fefb2' }
};
const BASE_RADIUS = 160;
const DEPTH_FALLOFF = 0.85;
const MIN_RADIUS = 80;
const SIBLING_PAD = 0.15;

// ═══ STATE ═══
let pages = [], activePageId = null, nextNodeId = 1, nextPageId = 1;
let pan = { x: 0, y: 0 }, zoom = 1;
let selectedNode = null, hoveredNode = null, draggingNode = null;
let panning = false, panStart = { x: 0, y: 0 }, dragOffset = { x: 0, y: 0 };
let contextNodeId = null, editingNode = null, newNodePending = null, openNoteId = null;
let nodeMap = {};
let isMobile = window.innerWidth <= 768;

// Touch state
let longPressTimer = null, touchMoved = false, lastTouchDist = 0, lastTouchMid = null;
let touchStartTime = 0, singleTouchNode = null;

// DOM element pools
const nodeElements = new Map(); // nodeId -> HTMLElement
const edgeElements = new Map(); // "from-to" -> SVGLineElement

// DOM refs
const graphView = document.getElementById('graphView');
const graphWorld = document.getElementById('graphWorld');
const edgeLayer = document.getElementById('edgeLayer');
const nodeLayer = document.getElementById('nodeLayer');

// ═══════════════════════════════════════════════════════════════════
// PHASE 2: DATA LAYER — IndexedDB + Sync Queue
// ═══════════════════════════════════════════════════════════════════

class Store {
  constructor() {
    this.db = null;
    this._ready = this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('maps'))
          db.createObjectStore('maps', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('syncQueue'))
          db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('snapshots'))
          db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  async ready() { await this._ready; }

  async _tx(store, mode, fn) {
    const tx = this.db.transaction(store, mode);
    const os = tx.objectStore(store);
    return new Promise((resolve, reject) => {
      const result = fn(os);
      if (result && result.onsuccess !== undefined) {
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      }
    });
  }

  async saveMap(data) {
    return this._tx('maps', 'readwrite', os => os.put({ id: MAP_ID, data }));
  }

  async loadMap() {
    const row = await this._tx('maps', 'readonly', os => os.get(MAP_ID));
    return row?.data || null;
  }

  async enqueueSync(data) {
    return this._tx('syncQueue', 'readwrite', os =>
      os.add({ data, ts: Date.now() })
    );
  }

  async drainSyncQueue() {
    const items = await this._tx('syncQueue', 'readonly', os => os.getAll());
    return items || [];
  }

  async clearSyncItem(id) {
    return this._tx('syncQueue', 'readwrite', os => os.delete(id));
  }

  async pushSnapshot(data) {
    await this._tx('snapshots', 'readwrite', os => os.add({ data, ts: Date.now() }));
    // Keep only last 20
    const all = await this._tx('snapshots', 'readonly', os => os.getAll());
    if (all && all.length > 20) {
      const toDelete = all.slice(0, all.length - 20);
      for (const item of toDelete) {
        await this._tx('snapshots', 'readwrite', os => os.delete(item.id));
      }
    }
  }

  async getSnapshots() {
    return (await this._tx('snapshots', 'readonly', os => os.getAll())) || [];
  }
}

const store = new Store();

// Dirty / save management
let _dirtyTimer = null;
let _lastSnapshotTime = 0;

function markDirty(immediate) {
  if (immediate) {
    clearTimeout(_dirtyTimer);
    _persistNow();
    return;
  }
  if (_dirtyTimer) return;
  _dirtyTimer = setTimeout(() => {
    _dirtyTimer = null;
    _persistNow();
  }, 100);
}

async function _persistNow() {
  const data = getAll();
  try {
    await store.ready();
    await store.saveMap(data);
    await store.enqueueSync(data);
    // Snapshot throttle: 1 per 30s
    const now = Date.now();
    if (now - _lastSnapshotTime > 30000) {
      _lastSnapshotTime = now;
      await store.pushSnapshot(data);
    }
  } catch (e) { /* IndexedDB failure — data still in memory */ }
  syncUI('saving');
  _replayQueue();
}

// Cloud sync
let supa = null, cloudOK = false;

async function initCloud() {
  try {
    supa = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    cloudOK = true;
  } catch { cloudOK = false; }
}

async function cloudSave(data) {
  if (!cloudOK) return false;
  try {
    const { error } = await supa.from('maps').upsert(
      { id: MAP_ID, data, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
    if (error) throw error;
    return true;
  } catch { return false; }
}

async function cloudLoad() {
  if (!cloudOK) return null;
  try {
    const { data, error } = await supa.from('maps').select('data').eq('id', MAP_ID).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data?.data || null;
  } catch { return null; }
}

async function _replayQueue() {
  if (!navigator.onLine || !cloudOK) { syncUI('error'); return; }
  try {
    await store.ready();
    const items = await store.drainSyncQueue();
    if (!items.length) { syncUI('saved'); return; }
    // Only need to push the latest
    const latest = items[items.length - 1];
    const ok = await cloudSave(latest.data);
    if (ok) {
      for (const item of items) {
        await store.clearSyncItem(item.id);
      }
      syncUI('saved');
    } else {
      syncUI('error');
    }
  } catch { syncUI('error'); }
}

// Periodic sync retry
setInterval(_replayQueue, 30000);
window.addEventListener('online', () => _replayQueue());

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function cp() { return pages.find(p => p.id === activePageId); }
function cn() { return cp()?.nodes || []; }
function ce() { return cp()?.edges || []; }
function rnm() { nodeMap = {}; cn().forEach(n => nodeMap[n.id] = n); }

function getDepth(nodeId) {
  let d = 0, cur = nodeId;
  const edges = ce();
  for (let i = 0; i < 20; i++) {
    const p = edges.find(e => e.to === cur);
    if (!p) break;
    d++; cur = p.from;
  }
  return d;
}

function getChildren(nodeId) {
  return ce().filter(e => e.from === nodeId).map(e => nodeMap[e.to]).filter(Boolean);
}

function getParentId(nodeId) {
  const e = ce().find(e => e.to === nodeId);
  return e ? e.from : null;
}

function getAncestorPath(nodeId) {
  const path = [];
  let cur = nodeId;
  for (let i = 0; i < 20; i++) {
    const pid = getParentId(cur);
    if (!pid) break;
    path.unshift(nodeMap[pid]);
    cur = pid;
  }
  return path;
}

function isCollapsedAncestor(nodeId) {
  let cur = getParentId(nodeId);
  while (cur) {
    if (nodeMap[cur]?.collapsed) return true;
    cur = getParentId(cur);
  }
  return false;
}

function getVisibleNodes() { return cn().filter(n => !isCollapsedAncestor(n.id)); }
function getVisibleEdges() {
  const vis = new Set(getVisibleNodes().map(n => n.id));
  return ce().filter(e => vis.has(e.from) && vis.has(e.to));
}

// ═══════════════════════════════════════════════════════════════════
// NODE CRUD
// ═══════════════════════════════════════════════════════════════════

function createNode(label, wx, wy, parentId, isRoot) {
  const page = cp(); if (!page) return null;
  const id = nextNodeId++;
  const pc = parentId ? ((nodeMap[parentId] || {}).color || '#7c6fef') : '#7c6fef';
  const node = {
    id, label, x: wx, y: wy, isRoot: !!isRoot,
    color: isRoot ? '#7c6fef' : pc,
    notes: '', status: 'none', collapsed: false,
    manualPosition: false
  };
  page.nodes.push(node);
  if (parentId != null) page.edges.push({ from: parentId, to: id });
  rnm();
  markDirty();
  renderSidebar();
  return id;
}

function deleteNode(id) {
  const page = cp(); if (!page) return;
  const node = nodeMap[id]; if (!node || node.isRoot) return;
  const del = new Set(), q = [id];
  while (q.length) {
    const c = q.shift(); del.add(c);
    page.edges.filter(e => e.from === c).forEach(e => q.push(e.to));
  }
  page.nodes = page.nodes.filter(n => !del.has(n.id));
  page.edges = page.edges.filter(e => !del.has(e.from) && !del.has(e.to));
  if (selectedNode === id) selectedNode = null;
  // Clean up DOM elements for deleted nodes
  for (const did of del) {
    const el = nodeElements.get(did);
    if (el) { el.remove(); nodeElements.delete(did); }
  }
  rnm();
  markDirty(true); // immediate save for destructive ops
  renderSidebar();
  layoutPage();
  renderGraph();
}

function addChild(pid) {
  const p = nodeMap[pid]; if (!p) return;
  if (p.collapsed) { p.collapsed = false; }
  const id = createNode('', p.x, p.y, pid);
  selectedNode = id;
  newNodePending = id;
  layoutPage();
  renderGraph();
  startEdit(id);
  return id;
}

function addNodeAtCenter() {
  const rect = graphView.getBoundingClientRect();
  const wx = (rect.width / 2 - pan.x) / zoom;
  const wy = (rect.height / 2 - pan.y) / zoom;
  const id = createNode('', wx + (Math.random() - 0.5) * 40, wy + (Math.random() - 0.5) * 40, null, false);
  selectedNode = id;
  newNodePending = id;
  layoutPage();
  renderGraph();
  startEdit(id);
}

function cancelNewNode() {
  if (newNodePending) { deleteNode(newNodePending); newNodePending = null; }
}

function toggleCollapse(id) {
  const n = nodeMap[id]; if (!n) return;
  if (getChildren(id).length === 0) return;
  n.collapsed = !n.collapsed;
  markDirty();
  layoutPage();
  renderGraph();
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 3: RADIAL TREE LAYOUT
// ═══════════════════════════════════════════════════════════════════

const _subtreeCache = new Map();

function subtreeSize(nodeId) {
  if (_subtreeCache.has(nodeId)) return _subtreeCache.get(nodeId);
  const node = nodeMap[nodeId];
  if (!node || node.collapsed) { _subtreeCache.set(nodeId, 1); return 1; }
  const children = getChildren(nodeId);
  let s = 1;
  for (const c of children) s += subtreeSize(c.id);
  _subtreeCache.set(nodeId, s);
  return s;
}

function layoutRadialTree(rootId, cx, cy) {
  const root = nodeMap[rootId]; if (!root) return;
  if (!root.manualPosition) { root.x = cx; root.y = cy; }

  function layoutChildren(parentId, parentX, parentY, startAngle, endAngle, depth) {
    const parent = nodeMap[parentId]; if (!parent || parent.collapsed) return;
    const children = getChildren(parentId);
    if (!children.length) return;

    const radius = Math.max(MIN_RADIUS, BASE_RADIUS * Math.pow(DEPTH_FALLOFF, depth));
    const totalWeight = children.reduce((s, c) => s + subtreeSize(c.id), 0);
    const availableAngle = endAngle - startAngle;
    // Reserve padding between siblings
    const totalPad = Math.max(0, children.length - 1) * SIBLING_PAD;
    const usableAngle = Math.max(availableAngle - totalPad, 0.1);

    let angle = startAngle;
    for (const child of children) {
      const weight = subtreeSize(child.id);
      const slice = (weight / totalWeight) * usableAngle;
      const midAngle = angle + slice / 2;

      if (!child.manualPosition) {
        child.x = parentX + Math.cos(midAngle) * radius;
        child.y = parentY + Math.sin(midAngle) * radius;
      }

      // Children of this child get a subsector
      layoutChildren(child.id, child.x, child.y, midAngle - slice / 2, midAngle + slice / 2, depth + 1);
      angle += slice + SIBLING_PAD;
    }
  }

  // Full circle for root's children
  layoutChildren(rootId, root.manualPosition ? root.x : cx, root.manualPosition ? root.y : cy, 0, Math.PI * 2, 0);
}

function layoutPage() {
  _subtreeCache.clear();
  const nodes = cn(), edges = ce();
  if (!nodes.length) return;

  // Find roots (nodes with no parent)
  const hasParent = new Set(edges.map(e => e.to));
  const roots = nodes.filter(n => !hasParent.has(n.id));
  const orphans = []; // non-root nodes without parents shouldn't exist, but handle gracefully

  if (roots.length === 0) return;

  // Layout each root tree side by side
  // First pass: compute subtree sizes to space roots
  const rootSizes = roots.map(r => subtreeSize(r.id));
  const totalSize = rootSizes.reduce((a, b) => a + b, 0);

  if (roots.length === 1) {
    // Single root: center it
    const r = roots[0];
    const cx = r.manualPosition ? r.x : 0;
    const cy = r.manualPosition ? r.y : 0;
    layoutRadialTree(r.id, cx, cy);
  } else {
    // Multiple roots: spread horizontally
    let xOffset = 0;
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      const spread = rootSizes[i] * 80;
      const cx = xOffset + spread / 2;
      layoutRadialTree(r.id, cx, 0);
      xOffset += spread + 100;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 4: DOM RENDERING
// ═══════════════════════════════════════════════════════════════════

function updateWorldTransform() {
  graphWorld.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
  document.getElementById('zoomText').textContent = Math.round(zoom * 100) + '%';
}

function syncNodeElements(visibleNodes) {
  const visibleIds = new Set(visibleNodes.map(n => n.id));
  const edges = getVisibleEdges();

  // Remove elements for nodes no longer visible
  for (const [id, el] of nodeElements) {
    if (!visibleIds.has(id)) {
      el.remove();
      nodeElements.delete(id);
    }
  }

  for (const node of visibleNodes) {
    let el = nodeElements.get(node.id);
    const isNew = !el;

    if (isNew) {
      el = document.createElement('div');
      el.className = 'nf-node';
      el.dataset.nid = node.id;

      // Dot
      const dot = document.createElement('div');
      dot.className = 'nf-dot';
      el.appendChild(dot);

      // Note indicator (inside dot)
      const noteInd = document.createElement('div');
      noteInd.className = 'nf-note-ind';
      noteInd.style.display = 'none';
      dot.appendChild(noteInd);

      // Label
      const label = document.createElement('div');
      label.className = 'nf-label';
      el.appendChild(label);

      // Progress bar
      const prog = document.createElement('div');
      prog.className = 'nf-progress';
      const progFill = document.createElement('div');
      progFill.className = 'nf-progress-fill';
      prog.appendChild(progFill);
      el.appendChild(prog);

      // Collapse button (added dynamically)
      const colBtn = document.createElement('div');
      colBtn.className = 'nf-collapse-btn';
      colBtn.style.display = 'none';
      el.appendChild(colBtn);

      // Add button
      const addBtn = document.createElement('div');
      addBtn.className = 'nf-add-btn';
      addBtn.textContent = '+';
      el.appendChild(addBtn);

      nodeLayer.appendChild(el);
      nodeElements.set(node.id, el);
    }

    // Update position
    el.style.setProperty('--nx', node.x + 'px');
    el.style.setProperty('--ny', node.y + 'px');
    el.style.setProperty('--nc', node.color || '#7c6fef');

    // Update classes
    const cls = ['nf-node'];
    if (node.isRoot) cls.push('root');
    if (selectedNode === node.id) cls.push('selected');
    if (hoveredNode === node.id) cls.push('hovered');
    if (draggingNode === node.id) cls.push('dragging');
    // Dim: selected exists and this isn't selected or connected
    if (selectedNode && selectedNode !== node.id) {
      const isConn = edges.some(e =>
        (e.from === selectedNode && e.to === node.id) ||
        (e.to === selectedNode && e.from === node.id)
      );
      if (!isConn) cls.push('dim');
    }
    el.className = cls.join(' ');

    // Dot color + status
    const dot = el.querySelector('.nf-dot');
    const opacity = (selectedNode === node.id || hoveredNode === node.id) ? '' : 'bb';
    dot.style.background = (node.color || '#7c6fef') + opacity;
    dot.className = 'nf-dot' + (node.status && node.status !== 'none' ? ' status-' + node.status : '');

    // Note indicator
    const noteInd = dot.querySelector('.nf-note-ind');
    noteInd.style.display = (node.notes && node.notes.length > 0) ? 'block' : 'none';

    // Label
    const label = el.querySelector('.nf-label');
    if (editingNode === node.id) {
      label.style.display = 'none';
    } else {
      label.style.display = '';
      label.textContent = node.label || 'Untitled';
    }

    // Collapse button
    const children = getChildren(node.id);
    const colBtn = el.querySelector('.nf-collapse-btn');
    if (children.length > 0) {
      colBtn.style.display = 'flex';
      colBtn.textContent = node.collapsed ? children.length.toString() : '\u2212';
      colBtn.classList.toggle('collapsed', !!node.collapsed);
    } else {
      colBtn.style.display = 'none';
    }

    // Progress bar
    const prog = el.querySelector('.nf-progress');
    const progFill = el.querySelector('.nf-progress-fill');
    if (children.length > 0 && children.some(c => c.status && c.status !== 'none')) {
      const done = children.filter(c => c.status === 'done').length;
      const total = children.filter(c => c.status !== 'none').length;
      if (total > 0) {
        prog.style.display = 'block';
        progFill.style.width = Math.round((done / total) * 100) + '%';
      } else {
        prog.style.display = 'none';
      }
    } else {
      prog.style.display = 'none';
    }
  }
}

function syncEdgeElements(visibleEdges) {
  const visibleKeys = new Set(visibleEdges.map(e => e.from + '-' + e.to));

  // Remove stale edges
  for (const [key, line] of edgeElements) {
    if (!visibleKeys.has(key)) {
      line.remove();
      edgeElements.delete(key);
    }
  }

  for (const edge of visibleEdges) {
    const key = edge.from + '-' + edge.to;
    const from = nodeMap[edge.from], to = nodeMap[edge.to];
    if (!from || !to) continue;

    let line = edgeElements.get(key);
    if (!line) {
      line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      edgeLayer.appendChild(line);
      edgeElements.set(key, line);
    }

    line.setAttribute('x1', from.x);
    line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x);
    line.setAttribute('y2', to.y);

    // Highlight if connected to selected
    const hl = selectedNode && (edge.from === selectedNode || edge.to === selectedNode);
    line.classList.toggle('hl', hl);
  }
}

function renderGraph() {
  const visibleNodes = getVisibleNodes();
  const visibleEdges = getVisibleEdges();
  syncNodeElements(visibleNodes);
  syncEdgeElements(visibleEdges);
  updateWorldTransform();
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 5: INPUT HANDLING
// ═══════════════════════════════════════════════════════════════════

// Utility: find which node element (or sub-element) was targeted
function nodeIdFromEvent(e) {
  const el = e.target.closest('.nf-node');
  return el ? parseInt(el.dataset.nid) : null;
}

// --- Mouse ---
graphView.addEventListener('mousedown', e => {
  if (isMobile) return;
  hideContext(); hideTemplates();
  if (e.button === 2) return;

  // Check if clicking on toolbar/status/template elements
  if (e.target.closest('.graph-toolbar') || e.target.closest('.graph-status') ||
      e.target.closest('.template-dropdown') || e.target.closest('.hamburger')) return;

  const nid = nodeIdFromEvent(e);

  // Check collapse button
  if (e.target.closest('.nf-collapse-btn')) {
    const id = nodeIdFromEvent(e);
    if (id != null) toggleCollapse(id);
    return;
  }

  // Check add button
  if (e.target.closest('.nf-add-btn')) {
    const id = nodeIdFromEvent(e);
    if (id != null) addChild(id);
    return;
  }

  if (nid != null) {
    selectedNode = nid;
    draggingNode = nid;
    const node = nodeMap[nid];
    // Calculate offset from mouse to node's screen position
    const worldX = node.x * zoom + pan.x;
    const worldY = node.y * zoom + pan.y;
    const rect = graphView.getBoundingClientRect();
    dragOffset = { x: e.clientX - rect.left - worldX, y: e.clientY - rect.top - worldY };
    graphView.classList.add('grabbing');
  } else {
    selectedNode = null;
    panning = true;
    panStart = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    graphView.classList.add('grabbing');
  }
  renderGraph();
});

graphView.addEventListener('mousemove', e => {
  if (isMobile) return;

  if (draggingNode) {
    const node = nodeMap[draggingNode]; if (!node) return;
    const rect = graphView.getBoundingClientRect();
    const sx = e.clientX - rect.left - dragOffset.x;
    const sy = e.clientY - rect.top - dragOffset.y;
    node.x = (sx - pan.x) / zoom;
    node.y = (sy - pan.y) / zoom;
    node.manualPosition = true;
    markDirty();
    renderGraph();
  } else if (panning) {
    pan.x = e.clientX - panStart.x;
    pan.y = e.clientY - panStart.y;
    updateWorldTransform();
  } else {
    // Hover detection
    const nid = nodeIdFromEvent(e);
    if (nid !== hoveredNode) {
      hoveredNode = nid;
      renderGraph();
    }
    graphView.style.cursor = nid ? 'pointer' : 'grab';
  }
});

graphView.addEventListener('mouseup', () => {
  if (isMobile) return;
  if (draggingNode) {
    draggingNode = null;
    markDirty();
    renderGraph();
  }
  panning = false;
  graphView.classList.remove('grabbing');
});

graphView.addEventListener('dblclick', e => {
  if (isMobile) return;
  if (e.target.closest('.graph-toolbar') || e.target.closest('.graph-status') ||
      e.target.closest('.template-dropdown')) return;

  const nid = nodeIdFromEvent(e);
  if (nid != null) {
    openNote(nid);
  } else {
    const rect = graphView.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = (sx - pan.x) / zoom, wy = (sy - pan.y) / zoom;
    const id = createNode('', wx, wy, null, false);
    selectedNode = id;
    newNodePending = id;
    layoutPage();
    renderGraph();
    startEdit(id);
  }
});

graphView.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (isMobile) return;
  const nid = nodeIdFromEvent(e);
  if (nid != null) showContext(nid, e.clientX, e.clientY);
});

graphView.addEventListener('wheel', e => {
  e.preventDefault();
  const old = zoom;
  zoom = Math.max(0.15, Math.min(4, zoom * (e.deltaY > 0 ? 0.93 : 1.07)));
  const rect = graphView.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  pan.x = mx - (mx - pan.x) * (zoom / old);
  pan.y = my - (my - pan.y) * (zoom / old);
  updateWorldTransform();
}, { passive: false });

// --- Touch ---
graphView.addEventListener('touchstart', e => {
  // Don't intercept touches on toolbar/overlays
  if (e.target.closest('.graph-toolbar') || e.target.closest('.graph-status') ||
      e.target.closest('.template-dropdown') || e.target.closest('.hamburger')) return;
  e.preventDefault();
  hideContext(); hideTemplates();
  const rect = graphView.getBoundingClientRect();

  if (e.touches.length === 2) {
    clearTimeout(longPressTimer);
    const t = e.touches;
    lastTouchDist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    lastTouchMid = { x: (t[0].clientX + t[1].clientX) / 2 - rect.left, y: (t[0].clientY + t[1].clientY) / 2 - rect.top };
    return;
  }

  touchMoved = false;
  touchStartTime = Date.now();

  // Check collapse button
  if (e.target.closest('.nf-collapse-btn')) {
    const id = nodeIdFromEvent(e);
    if (id != null) toggleCollapse(id);
    return;
  }

  const nid = nodeIdFromEvent(e);
  singleTouchNode = nid != null ? nodeMap[nid] : null;

  if (nid != null) {
    selectedNode = nid;
    draggingNode = nid;
    const node = nodeMap[nid];
    const worldX = node.x * zoom + pan.x;
    const worldY = node.y * zoom + pan.y;
    dragOffset = { x: e.touches[0].clientX - rect.left - worldX, y: e.touches[0].clientY - rect.top - worldY };
    longPressTimer = setTimeout(() => {
      if (!touchMoved) {
        draggingNode = null;
        showContext(nid, e.touches[0].clientX, e.touches[0].clientY);
      }
    }, 500);
  } else {
    selectedNode = null;
    panning = true;
    panStart = { x: e.touches[0].clientX - pan.x, y: e.touches[0].clientY - pan.y };
  }
  renderGraph();
}, { passive: false });

graphView.addEventListener('touchmove', e => {
  if (e.target.closest('.graph-toolbar') || e.target.closest('.graph-status') ||
      e.target.closest('.template-dropdown')) return;
  e.preventDefault();
  const rect = graphView.getBoundingClientRect();

  if (e.touches.length === 2) {
    clearTimeout(longPressTimer);
    const t = e.touches;
    const dist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = { x: (t[0].clientX + t[1].clientX) / 2 - rect.left, y: (t[0].clientY + t[1].clientY) / 2 - rect.top };
    if (lastTouchDist > 0) {
      const old = zoom;
      zoom = Math.max(0.15, Math.min(4, zoom * (dist / lastTouchDist)));
      pan.x = mid.x - (mid.x - pan.x) * (zoom / old);
      pan.y = mid.y - (mid.y - pan.y) * (zoom / old);
    }
    lastTouchDist = dist;
    lastTouchMid = mid;
    updateWorldTransform();
    return;
  }

  touchMoved = true;
  clearTimeout(longPressTimer);

  if (draggingNode) {
    const node = nodeMap[draggingNode]; if (!node) return;
    const sx = e.touches[0].clientX - rect.left - dragOffset.x;
    const sy = e.touches[0].clientY - rect.top - dragOffset.y;
    node.x = (sx - pan.x) / zoom;
    node.y = (sy - pan.y) / zoom;
    node.manualPosition = true;
    markDirty();
    renderGraph();
  } else if (panning) {
    pan.x = e.touches[0].clientX - panStart.x;
    pan.y = e.touches[0].clientY - panStart.y;
    updateWorldTransform();
  }
}, { passive: false });

graphView.addEventListener('touchend', e => {
  if (e.target.closest('.graph-toolbar') || e.target.closest('.graph-status') ||
      e.target.closest('.template-dropdown')) return;
  e.preventDefault();
  clearTimeout(longPressTimer);
  lastTouchDist = 0;
  lastTouchMid = null;

  if (draggingNode) {
    draggingNode = null;
    markDirty();
    renderGraph();
  }
  panning = false;

  // Tap detection (double-tap to open note)
  if (!touchMoved && singleTouchNode && (Date.now() - touchStartTime < 300)) {
    if (singleTouchNode.id === selectedNode && singleTouchNode._lastTap && Date.now() - singleTouchNode._lastTap < 400) {
      openNote(singleTouchNode.id);
      singleTouchNode._lastTap = 0;
    } else {
      singleTouchNode._lastTap = Date.now();
    }
  } else if (!touchMoved && !singleTouchNode && (Date.now() - touchStartTime < 300)) {
    selectedNode = null;
    renderGraph();
  }
  singleTouchNode = null;
}, { passive: false });

// --- Keyboard ---
document.addEventListener('keydown', e => {
  if (openNoteId) {
    if (e.key === 'Escape') { closeNote(); e.preventDefault(); }
    return;
  }
  if (editingNode) {
    if (e.key === 'Escape') { cancelNewNode(); stopEdit(false); e.preventDefault(); }
    if (e.key === 'Enter') { stopEdit(true); e.preventDefault(); }
    if (e.key === 'Tab') { e.preventDefault(); stopEdit(true); if (selectedNode) addChild(selectedNode); }
    return;
  }
  if (e.key === 'Escape') { selectedNode = null; hideContext(); hideTemplates(); renderGraph(); }
  if (e.key === 'Enter' && selectedNode) { openNote(selectedNode); e.preventDefault(); }
  if (e.key === 'F2' && selectedNode) { startEdit(selectedNode); e.preventDefault(); }
  if (e.key === 'Tab' && selectedNode) { e.preventDefault(); addChild(selectedNode); }
  if (e.key === 'Delete' && selectedNode) { deleteNode(selectedNode); }
  if (e.key === ' ' && selectedNode) { e.preventDefault(); toggleCollapse(selectedNode); }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    if (!selectedNode) {
      const r = cn().find(n => n.isRoot) || cn()[0];
      if (r) { selectedNode = r.id; panToNode(r.id); }
      return;
    }
    const t = findDir(selectedNode, e.key);
    if (t) { selectedNode = t.id; panToNode(t.id); }
  }
});

function findDir(fid, dir) {
  const from = nodeMap[fid]; if (!from) return null;
  const angles = { ArrowRight: 0, ArrowDown: Math.PI / 2, ArrowLeft: Math.PI, ArrowUp: -Math.PI / 2 };
  const ta = angles[dir];
  let best = null, bs = Infinity;
  getVisibleNodes().forEach(n => {
    if (n.id === fid) return;
    const dx = n.x - from.x, dy = n.y - from.y, dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;
    let ad = Math.atan2(dy, dx) - ta;
    while (ad > Math.PI) ad -= 2 * Math.PI;
    while (ad < -Math.PI) ad += 2 * Math.PI;
    if (Math.abs(ad) > Math.PI / 2) return;
    const s = Math.abs(ad) * 300 + dist;
    if (s < bs) { bs = s; best = n; }
  });
  return best;
}

// Pan animation
let panTarget = null, panAnimId = null;

function panToNode(id) {
  const n = nodeMap[id]; if (!n) return;
  const rect = graphView.getBoundingClientRect();
  const tx = rect.width / 2 - n.x * zoom;
  const ty = rect.height / 2 - n.y * zoom;
  panTarget = { tx, ty, sx: pan.x, sy: pan.y, t0: performance.now(), dur: 250 };
  if (!panAnimId) panAnimId = requestAnimationFrame(animatePan);
}

function animatePan() {
  if (!panTarget) { panAnimId = null; return; }
  const t = Math.min(1, (performance.now() - panTarget.t0) / panTarget.dur);
  const ease = 1 - Math.pow(1 - t, 3);
  pan.x = panTarget.sx + (panTarget.tx - panTarget.sx) * ease;
  pan.y = panTarget.sy + (panTarget.ty - panTarget.sy) * ease;
  updateWorldTransform();
  renderGraph();
  if (t >= 1) { panTarget = null; panAnimId = null; }
  else panAnimId = requestAnimationFrame(animatePan);
}

// ═══════════════════════════════════════════════════════════════════
// EDIT OVERLAY
// ═══════════════════════════════════════════════════════════════════

function startEdit(id) {
  const node = nodeMap[id]; if (!node) return;
  editingNode = id;
  const ov = document.getElementById('editOverlay');
  const inp = document.getElementById('editInput');

  // Position relative to node's screen location
  const screenX = node.x * zoom + pan.x;
  const screenY = node.y * zoom + pan.y;
  const rect = graphView.getBoundingClientRect();
  const dotR = node.isRoot ? 11 : 7;

  let left = rect.left + screenX - 90;
  let top = rect.top + screenY + dotR * zoom + 10;
  if (left < 8) left = 8;
  if (left + 180 > window.innerWidth) left = window.innerWidth - 188;
  if (top + 40 > window.innerHeight) top = rect.top + screenY - dotR * zoom - 40;

  ov.style.left = left + 'px';
  ov.style.top = top + 'px';
  ov.classList.add('show');
  inp.value = node.label;
  inp.focus();
  inp.select();
  renderGraph();
}

function stopEdit(save) {
  if (!editingNode) return;
  const node = nodeMap[editingNode];
  if (node && save) {
    const val = document.getElementById('editInput').value.trim();
    if (val) {
      node.label = val;
      newNodePending = null;
    } else if (newNodePending === editingNode) {
      cancelNewNode();
    } else {
      node.label = node.label || 'Untitled';
    }
    markDirty();
    renderSidebar();
  }
  editingNode = null;
  document.getElementById('editOverlay').classList.remove('show');
  renderGraph();
}

document.getElementById('editInput').addEventListener('blur', () => {
  if (editingNode) {
    const val = document.getElementById('editInput').value.trim();
    if (!val && newNodePending === editingNode) {
      cancelNewNode();
      editingNode = null;
      document.getElementById('editOverlay').classList.remove('show');
      renderGraph();
    } else {
      stopEdit(true);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
// CONTEXT MENU
// ═══════════════════════════════════════════════════════════════════

function showContext(nodeId, cx, cy) {
  contextNodeId = nodeId;
  selectedNode = nodeId;
  const menu = document.getElementById('contextMenu');
  let left = cx, top = cy;
  if (left + 170 > window.innerWidth) left = window.innerWidth - 178;
  if (top + 280 > window.innerHeight) top = window.innerHeight - 288;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.classList.add('show');
  renderGraph();
}

function hideContext() {
  document.getElementById('contextMenu').classList.remove('show');
  contextNodeId = null;
}

// Context menu action delegation
document.getElementById('contextMenu').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !contextNodeId) return;
  const a = btn.dataset.action;
  if (a === 'open') openNote(contextNodeId);
  if (a === 'rename') startEdit(contextNodeId);
  if (a === 'addChild') addChild(contextNodeId);
  if (a === 'collapse') toggleCollapse(contextNodeId);
  if (a === 'delete') deleteNode(contextNodeId);
  hideContext();
});

document.addEventListener('click', e => {
  if (!document.getElementById('contextMenu').contains(e.target)) hideContext();
});

// Status dots in context menu
(function () {
  const row = document.getElementById('ctxStatusRow');
  Object.entries(STATUSES).forEach(([key, s]) => {
    const d = document.createElement('div');
    d.className = 'ctx-status-dot';
    d.style.background = s.bg || '#2a2b30';
    d.style.color = s.fg;
    d.textContent = s.label;
    d.onclick = () => {
      if (contextNodeId && nodeMap[contextNodeId]) {
        nodeMap[contextNodeId].status = key;
        markDirty();
        renderGraph();
      }
      hideContext();
    };
    row.appendChild(d);
  });
  const c = document.getElementById('colorDots');
  COLORS.forEach(color => {
    const d = document.createElement('div');
    d.className = 'color-dot';
    d.style.background = color;
    d.onclick = () => {
      if (contextNodeId && nodeMap[contextNodeId]) {
        nodeMap[contextNodeId].color = color;
        markDirty();
        renderGraph();
      }
      hideContext();
    };
    c.appendChild(d);
  });
})();

// ═══════════════════════════════════════════════════════════════════
// NOTE VIEW
// ═══════════════════════════════════════════════════════════════════

function openNote(id) {
  const n = nodeMap[id]; if (!n) return;
  openNoteId = id;
  selectedNode = id;
  document.getElementById('noteTitleInput').value = n.label;
  document.getElementById('noteBody').value = n.notes || '';
  document.getElementById('noteColorDot').style.background = n.color || '#7c6fef';
  refreshNoteView();
  document.getElementById('noteView').classList.add('show');
  setTimeout(() => document.getElementById('noteBody').focus(), 100);
}

function refreshNoteView() {
  if (!openNoteId) return;
  const n = nodeMap[openNoteId]; if (!n) return;

  // Status buttons
  document.querySelectorAll('.note-status-bar .status-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.s === n.status);
  });

  // Breadcrumb
  const bc = document.getElementById('noteBreadcrumb');
  bc.innerHTML = '';
  const path = getAncestorPath(openNoteId);
  path.forEach(anc => {
    const s = document.createElement('span');
    s.textContent = anc.label || 'Untitled';
    s.onclick = () => openNote(anc.id);
    bc.appendChild(s);
    const sep = document.createElement('em');
    sep.textContent = ' \u203A ';
    bc.appendChild(sep);
  });
  const cur = document.createElement('span');
  cur.textContent = n.label || 'Untitled';
  cur.style.color = '#c4c4c8';
  cur.style.cursor = 'default';
  bc.appendChild(cur);

  // Subtasks
  const children = getChildren(openNoteId);
  const stDiv = document.getElementById('noteSubtasks');
  const stList = document.getElementById('subtaskList');
  if (children.length > 0) {
    stDiv.style.display = 'block';
    stList.innerHTML = '';
    function renderSubtree(parentId, depth) {
      getChildren(parentId).forEach(child => {
        const item = document.createElement('div');
        item.className = 'subtask-item';
        item.style.paddingLeft = (depth * 20) + 'px';
        const dot = document.createElement('div');
        dot.className = 'subtask-dot';
        dot.style.background = child.color || '#7c6fef';
        const label = document.createElement('span');
        label.className = 'subtask-label';
        label.textContent = child.label || 'Untitled';
        item.appendChild(dot);
        item.appendChild(label);
        if (child.status && child.status !== 'none') {
          const st = document.createElement('span');
          st.className = 'subtask-status';
          st.style.background = STATUSES[child.status].bg;
          st.style.color = STATUSES[child.status].fg;
          st.textContent = child.status.toUpperCase();
          item.appendChild(st);
        }
        const subChildren = getChildren(child.id);
        if (subChildren.length > 0) {
          const cnt = document.createElement('span');
          cnt.style.cssText = 'font-size:9px;color:#555;margin-left:4px';
          cnt.textContent = '(' + subChildren.length + ')';
          item.appendChild(cnt);
        }
        item.onclick = () => openNote(child.id);
        stList.appendChild(item);
        if (subChildren.length > 0) renderSubtree(child.id, depth + 1);
      });
    }
    renderSubtree(openNoteId, 0);
  } else {
    stDiv.style.display = 'none';
  }

  updateNoteMeta();
}

function closeNote() {
  if (!openNoteId) return;
  openNoteId = null;
  document.getElementById('noteView').classList.remove('show');
  renderGraph();
}

function setNoteStatus(s) {
  const n = nodeMap[openNoteId]; if (!n) return;
  n.status = s;
  markDirty();
  refreshNoteView();
  renderGraph();
}

function onNoteTitleChange() {
  const n = nodeMap[openNoteId]; if (!n) return;
  n.label = document.getElementById('noteTitleInput').value || 'Untitled';
  markDirty();
  renderSidebar();
}

function onNoteBodyChange() {
  const n = nodeMap[openNoteId]; if (!n) return;
  n.notes = document.getElementById('noteBody').value;
  markDirty();
  updateNoteMeta();
}

function updateNoteMeta() {
  const n = nodeMap[openNoteId]; if (!n) return;
  const words = (n.notes || '').trim().split(/\s+/).filter(w => w).length;
  document.getElementById('noteMeta').textContent = words + ' words \u00B7 ' + (n.notes || '').length + ' chars';
}

// Note view event listeners
document.getElementById('noteBackBtn').addEventListener('click', closeNote);
document.getElementById('noteTitleInput').addEventListener('input', onNoteTitleChange);
document.getElementById('noteBody').addEventListener('input', onNoteBodyChange);
document.getElementById('noteStatusBar').addEventListener('click', e => {
  const btn = e.target.closest('.status-btn');
  if (btn) setNoteStatus(btn.dataset.s);
});
document.getElementById('addSubtaskBtn').addEventListener('click', () => {
  if (openNoteId) { addChild(openNoteId); refreshNoteView(); }
});

// ═══════════════════════════════════════════════════════════════════
// PHASE 6: FEATURE PARITY
// ═══════════════════════════════════════════════════════════════════

// ── Templates ──
const TEMPLATES = [
  { name: 'Meeting Notes', desc: 'Attendees, Action Items, Decisions',
    build: (cx, cy) => { const r = createNode('Meeting Notes', cx, cy, null, true); createNode('Attendees', cx - 120, cy - 80, r); createNode('Action Items', cx + 120, cy - 80, r); createNode('Decisions', cx, cy + 100, r); createNode('Follow-ups', cx + 120, cy + 100, r); } },
  { name: 'Project Tracker', desc: 'Tasks, Timeline, Resources, Risks',
    build: (cx, cy) => { const r = createNode('Project Name', cx, cy, null, true); createNode('Tasks', cx - 140, cy - 60, r); createNode('Timeline', cx + 140, cy - 60, r); createNode('Resources', cx - 140, cy + 80, r); createNode('Risks', cx + 140, cy + 80, r); } },
  { name: 'Personnel Tracker', desc: 'Roster, Training, Awards, Leave',
    build: (cx, cy) => { const r = createNode('Personnel', cx, cy, null, true); createNode('Roster', cx - 130, cy - 70, r); createNode('Training', cx + 130, cy - 70, r); createNode('Awards', cx - 130, cy + 90, r); createNode('Leave', cx + 130, cy + 90, r); } },
  { name: 'Additional Duties', desc: 'Duty categories with assigned personnel',
    build: (cx, cy) => { const r = createNode('Additional Duties', cx, cy, null, true); const d1 = createNode('DTS', cx - 160, cy - 40, r); const d2 = createNode('AO', cx + 160, cy - 40, r); createNode('PKA Rep', cx - 240, cy - 100, d1); createNode('PKB Rep', cx - 160, cy - 120, d1); createNode('PKC Rep', cx + 80, cy - 100, d2); createNode('Facility Manager', cx - 60, cy + 100, r); createNode('Fitness Program', cx + 160, cy + 80, r); } },
  { name: 'Weekly Plan', desc: 'Mon-Fri with priorities',
    build: (cx, cy) => { const r = createNode('This Week', cx, cy, null, true); ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].forEach((d, i) => { createNode(d, cx - 200 + i * 100, cy + 100, r); }); } },
  { name: 'Blank', desc: 'Just a root node',
    build: (cx, cy) => { createNode('Untitled', cx, cy, null, true); } }
];

function toggleTemplates() {
  document.getElementById('templateDropdown').classList.toggle('show');
}
function hideTemplates() {
  document.getElementById('templateDropdown').classList.remove('show');
}

(function () {
  const dd = document.getElementById('templateDropdown');
  TEMPLATES.forEach(tmpl => {
    const btn = document.createElement('button');
    btn.innerHTML = '<strong>' + tmpl.name + '</strong><div class="tmpl-desc">' + tmpl.desc + '</div>';
    btn.onclick = () => {
      hideTemplates();
      const id = nextPageId++;
      pages.push({ id, name: tmpl.name, nodes: [], edges: [] });
      activePageId = id;
      selectedNode = null; hoveredNode = null;
      pan = { x: 0, y: 0 }; zoom = 1;
      rnm();
      clearDOMPools();
      const rect = graphView.getBoundingClientRect();
      const wx = (rect.width / 2 - pan.x) / zoom;
      const wy = (rect.height / 2 - pan.y) / zoom;
      tmpl.build(wx, wy);
      rnm();
      renderSidebar();
      layoutPage();
      fitView();
      markDirty();
      if (isMobile) closeSidebar();
    };
    dd.appendChild(btn);
  });
})();

// ── Toolbar ──
document.getElementById('addTaskBtn').addEventListener('click', addNodeAtCenter);
document.getElementById('tmplBtn').addEventListener('click', toggleTemplates);
document.getElementById('fitBtn').addEventListener('click', fitView);
document.getElementById('relayoutBtn').addEventListener('click', () => {
  // Clear all manual positions and re-layout
  cn().forEach(n => { n.manualPosition = false; });
  layoutPage();
  renderGraph();
});
document.getElementById('clearBtn').addEventListener('click', clearPage);

function fitView() {
  const nodes = getVisibleNodes();
  if (!nodes.length) return;
  const rect = graphView.getBoundingClientRect();
  const pad = isMobile ? 60 : 100;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const mnx = Math.min(...xs), mxx = Math.max(...xs);
  const mny = Math.min(...ys), mxy = Math.max(...ys);
  const w = mxx - mnx || 400, h = mxy - mny || 400;
  zoom = Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h, 2);
  pan.x = rect.width / 2 - ((mnx + mxx) / 2) * zoom;
  pan.y = rect.height / 2 - ((mny + mxy) / 2) * zoom;
  renderGraph();
}

// ── Pages ──
function addPage(name) {
  const id = nextPageId++;
  pages.push({ id, name: name || 'New Page', nodes: [], edges: [] });
  switchPage(id);
  const rect = graphView.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  createNode(pages.find(p => p.id === id).name, (cx - pan.x) / zoom, (cy - pan.y) / zoom, null, true);
  layoutPage();
  renderSidebar();
  renderGraph();
  markDirty();
  if (isMobile) closeSidebar();
  return id;
}

function switchPage(id) {
  if (openNoteId) closeNote();
  stopEdit(false);
  activePageId = id;
  selectedNode = null; hoveredNode = null;
  pan = { x: 0, y: 0 }; zoom = 1;
  rnm();
  clearDOMPools();
  renderSidebar();
  layoutPage();
  fitView();
  if (isMobile) closeSidebar();
}

function deletePage(id) {
  if (pages.length <= 1) return;
  pages = pages.filter(p => p.id !== id);
  if (activePageId === id) switchPage(pages[0].id);
  renderSidebar();
  markDirty();
}

function renamePage(id, name) {
  const p = pages.find(p => p.id === id); if (!p) return;
  p.name = name;
  const root = p.nodes.find(n => n.isRoot);
  if (root) root.label = name;
  markDirty();
  renderSidebar();
  renderGraph();
}

function clearPage() {
  const page = cp();
  if (!page || !confirm('Clear all nodes?')) return;
  page.nodes = [];
  page.edges = [];
  clearDOMPools();
  const rect = graphView.getBoundingClientRect();
  createNode(page.name, (rect.width / 2 - pan.x) / zoom, (rect.height / 2 - pan.y) / zoom, null, true);
  selectedNode = null;
  rnm();
  markDirty();
  layoutPage();
  renderSidebar();
  renderGraph();
}

function clearDOMPools() {
  for (const [, el] of nodeElements) el.remove();
  nodeElements.clear();
  for (const [, el] of edgeElements) el.remove();
  edgeElements.clear();
}

// ── Sidebar ──
let renamingPageId = null;

function renderSidebar() {
  const list = document.getElementById('pagesList');
  list.innerHTML = '';
  pages.forEach(page => {
    const item = document.createElement('div');
    item.className = 'page-item' + (page.id === activePageId ? ' active' : '');
    if (renamingPageId === page.id) {
      const inp = document.createElement('input');
      inp.className = 'page-rename-input';
      inp.value = page.name;
      inp.onblur = () => { renamingPageId = null; renamePage(page.id, inp.value || 'Untitled'); };
      inp.onkeydown = e => {
        if (e.key === 'Enter') inp.blur();
        if (e.key === 'Escape') { renamingPageId = null; renderSidebar(); }
      };
      item.appendChild(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 10);
    } else {
      const ns = document.createElement('span');
      ns.className = 'page-name';
      ns.textContent = page.name;
      ns.ondblclick = e => { e.stopPropagation(); renamingPageId = page.id; renderSidebar(); };
      const ct = document.createElement('span');
      ct.className = 'page-count';
      ct.textContent = page.nodes.length;
      item.appendChild(ns);
      item.appendChild(ct);
      if (pages.length > 1) {
        const dl = document.createElement('span');
        dl.className = 'page-delete';
        dl.textContent = '\u2715';
        dl.onclick = e => { e.stopPropagation(); deletePage(page.id); };
        item.appendChild(dl);
      }
      item.onclick = () => { if (page.id !== activePageId) switchPage(page.id); };
    }
    list.appendChild(item);
  });
}

// ── Sidebar buttons ──
document.getElementById('addPageBtn').addEventListener('click', () => addPage());
document.getElementById('sidebarCloseBtn').addEventListener('click', closeSidebar);
document.getElementById('sidebarOverlay').addEventListener('click', closeSidebar);
document.getElementById('hamburgerBtn').addEventListener('click', openSidebar);
document.getElementById('exportBtn').addEventListener('click', exportAll);
document.getElementById('loadBtn').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('mdBtn').addEventListener('click', exportMarkdown);
document.getElementById('fileInput').addEventListener('change', handleFileLoad);

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
}

// ── Search ──
const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', () => handleSearch(searchInput.value));
searchInput.addEventListener('focus', () => handleSearch(searchInput.value));

function handleSearch(query) {
  const c = document.getElementById('searchResults');
  if (!query.trim()) { c.classList.remove('show'); c.innerHTML = ''; return; }
  const q = query.toLowerCase(), results = [];
  pages.forEach(page => page.nodes.forEach(node => {
    const lm = (node.label || '').toLowerCase().includes(q);
    const nm = (node.notes || '').toLowerCase().includes(q);
    if (lm || nm) results.push({ node, page, nm });
  }));
  if (!results.length) {
    c.innerHTML = '<div style="padding:12px 16px;font-size:12px;color:#555">No results</div>';
    c.classList.add('show');
    return;
  }
  c.innerHTML = '';
  results.slice(0, 20).forEach(r => {
    const item = document.createElement('div');
    item.className = 'search-result';
    const lb = document.createElement('span');
    lb.className = 'sr-label';
    lb.textContent = r.node.label || 'Untitled';
    const pg = document.createElement('span');
    pg.className = 'sr-page';
    pg.textContent = r.page.name;
    item.appendChild(lb);
    item.appendChild(pg);
    if (r.nm && r.node.notes) {
      const pv = document.createElement('span');
      pv.className = 'sr-preview';
      const idx = r.node.notes.toLowerCase().indexOf(q);
      pv.textContent = '...' + r.node.notes.substring(Math.max(0, idx - 20), idx + 40) + '...';
      item.appendChild(pv);
    }
    item.onclick = () => {
      if (r.page.id !== activePageId) switchPage(r.page.id);
      selectedNode = r.node.id;
      panToNode(r.node.id);
      c.classList.remove('show');
      searchInput.value = '';
      if (isMobile) closeSidebar();
    };
    c.appendChild(item);
  });
  c.classList.add('show');
}

document.addEventListener('click', e => {
  if (!document.querySelector('.search-box').contains(e.target) &&
      !document.getElementById('searchResults').contains(e.target))
    document.getElementById('searchResults').classList.remove('show');
  if (!document.getElementById('templateDropdown').contains(e.target) &&
      !document.getElementById('tmplBtn')?.contains(e.target))
    hideTemplates();
});

// ── Export / Import ──
function getAll() {
  return {
    pages: pages.map(p => ({
      id: p.id, name: p.name,
      nodes: p.nodes.map(n => ({
        id: n.id, label: n.label, x: n.x, y: n.y,
        isRoot: n.isRoot, color: n.color,
        notes: n.notes || '', status: n.status || 'none',
        collapsed: !!n.collapsed
      })),
      edges: p.edges
    })),
    activePageId, nextNodeId, nextPageId
  };
}

function loadAll(d) {
  pages = (d.pages || []).map(p => ({
    ...p,
    nodes: p.nodes.map(n => ({
      ...n,
      notes: n.notes || '',
      status: n.status || 'none',
      collapsed: !!n.collapsed,
      manualPosition: false
    }))
  }));
  nextNodeId = d.nextNodeId || 1;
  nextPageId = d.nextPageId || 1;
  activePageId = d.activePageId || (pages[0]?.id);
  selectedNode = null; editingNode = null; openNoteId = null;
  rnm();
  clearDOMPools();
  renderSidebar();
}

function exportAll() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(getAll(), null, 2)], { type: 'application/json' }));
  a.download = 'nodeflow-backup.json';
  a.click();
  showToast('Saved');
}

function handleFileLoad(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      loadAll(JSON.parse(ev.target.result));
      layoutPage();
      fitView();
      markDirty();
      showToast('Loaded');
    } catch { showToast('Invalid file'); }
  };
  r.readAsText(f);
  e.target.value = '';
}

function exportMarkdown() {
  const page = cp();
  if (!page) { showToast('No page'); return; }
  const root = page.nodes.find(n => n.isRoot);
  let md = '# ' + page.name + '\n\n';

  function walk(nodeId, depth) {
    const node = nodeMap[nodeId]; if (!node) return;
    const indent = '  '.repeat(depth);
    const statusTag = node.status && node.status !== 'none' ? ' [' + node.status.toUpperCase() + ']' : '';
    if (node.isRoot) {
      md += node.notes ? node.notes + '\n\n' : '';
    } else {
      md += indent + '- **' + node.label + '**' + statusTag + '\n';
      if (node.notes) { node.notes.split('\n').forEach(line => { md += indent + '  ' + line + '\n'; }); }
    }
    const children = getChildren(nodeId);
    children.forEach(c => walk(c.id, node.isRoot ? 0 : depth + 1));
  }

  if (root) walk(root.id, 0);
  const rooted = new Set();
  function markRooted(id) { rooted.add(id); getChildren(id).forEach(c => markRooted(c.id)); }
  if (root) markRooted(root.id);
  page.nodes.filter(n => !rooted.has(n.id)).forEach(n => {
    md += '\n- **' + n.label + '**' + (n.status && n.status !== 'none' ? ' [' + n.status.toUpperCase() + ']' : '') + '\n';
    if (n.notes) n.notes.split('\n').forEach(line => { md += '  ' + line + '\n'; });
  });

  navigator.clipboard.writeText(md).then(() => showToast('Markdown copied!')).catch(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = page.name + '.md';
    a.click();
    showToast('Downloaded as .md');
  });
}

// ── UI Helpers ──
function syncUI(s) {
  const el = document.getElementById('syncStatus');
  if (s === 'saving') { el.textContent = '\u27F3 saving...'; el.style.color = '#666'; }
  if (s === 'saved') { el.textContent = '\u2601 synced'; el.style.color = '#6fefb2'; }
  if (s === 'error') { el.textContent = '\u26A0 offline'; el.style.color = '#ef6f8a'; }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

// ── Resize ──
window.addEventListener('resize', () => {
  isMobile = window.innerWidth <= 768;
  renderGraph();
});

// ── Service Worker ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════

async function boot() {
  await store.ready();
  await initCloud();

  // Try IndexedDB first
  let data = await store.loadMap();

  if (!data) {
    // Migration from localStorage
    try {
      const raw = localStorage.getItem('nodeflow-v2');
      if (raw) {
        data = JSON.parse(raw);
        showToast('Migrated from local storage');
        // Clean up old key after successful migration
        localStorage.removeItem('nodeflow-v2');
      }
    } catch { /* ignore parse errors */ }
  }

  // Check cloud for newer data
  const cloud = await cloudLoad();
  if (cloud?.pages?.length) {
    if (!data?.pages?.length) {
      data = cloud;
      showToast('Loaded from cloud');
    }
    // If both exist, cloud wins (could add timestamp comparison)
  }

  if (data?.pages?.length) {
    loadAll(data);
  } else {
    addPage('My Notes');
  }

  layoutPage();
  fitView();
  syncUI('saved');

  // Initial persist to IndexedDB
  await store.saveMap(getAll());
}

boot();
