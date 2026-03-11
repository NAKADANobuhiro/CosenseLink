/* ══════════════════════════════════════════════════════════
   cosense-graph.js — Cosense Graph Viewer (共用エンジン)
   依存: D3.js v7 (CDN または別途 <script> で読み込むこと)

   【他ページでの使用方法】
   方法 A: データファイルで window.COSENSE_DATA をセットする
     <script src="your-data.js"></script>  ← window.COSENSE_DATA = {...}
     <script src="js/cosense-graph.js"></script>
     → DOMContentLoaded 時に自動でグラフを初期化します

   方法 B: 任意のタイミングで initGraph(data) を直接呼ぶ
     <script src="js/cosense-graph.js"></script>
     <script>
       fetch('data/your-project.json')
         .then(r => r.json())
         .then(data => initGraph(data));
     </script>
══════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════
   ERROR HANDLING
══════════════════════════════════════════════════════════ */
const errorLog = [];
function logError(msg, err) {
  const line = `[ERROR] ${msg}${err ? '\n' + (err.stack || err.message || err) : ''}`;
  errorLog.push(line);
  console.error(line);
  showErrorOverlay(errorLog.join('\n\n'));
}
function logInfo(msg) {
  console.log('[INFO]', msg);
  const bar = document.getElementById('log-bar');
  bar.textContent = msg;
  bar.classList.add('show');
  clearTimeout(bar._t);
  bar._t = setTimeout(() => bar.classList.remove('show'), 4000);
}
function showErrorOverlay(text) {
  document.getElementById('error-log').textContent = text;
  document.getElementById('error-overlay').classList.add('show');
}
document.getElementById('error-dismiss').addEventListener('click', () => {
  document.getElementById('error-overlay').classList.remove('show');
});
window.addEventListener('error', e => {
  logError('未捕捉のエラー: ' + e.message, { stack: `${e.filename}:${e.lineno}:${e.colno}` });
});
window.addEventListener('unhandledrejection', e => {
  logError('未捕捉のPromiseエラー', e.reason);
});

/* ══════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════ */
let graphData  = null;
let simNodes   = [];
let simLinks   = [];
let simulation = null;
let zoomBeh    = null;
let transform  = d3.zoomIdentity;
let highlight  = { sel: null, nbrs: new Set() };
let maxDegree  = 1;
let navStack   = [];
let navHist    = [];
let eventCtrl  = null;

const canvas = document.getElementById('graph-canvas');
const ctx    = canvas.getContext('2d');

/* ══════════════════════════════════════════════════════════
   SCREEN
══════════════════════════════════════════════════════════ */
function showScreen(id) {
  document.getElementById('loading').style.display = id === 'loading' ? 'flex' : 'none';
  document.getElementById('app').classList.toggle('active', id === 'app');
}

/* ══════════════════════════════════════════════════════════
   GRAPH BUILD
══════════════════════════════════════════════════════════ */
function buildGraph(json) {
  try {
    const rawPages = Array.isArray(json) ? json : (json.pages || []);
    logInfo(`ページ数: ${rawPages.length} 件 — グラフを構築中...`);

    const titleByLower = new Map();
    rawPages.forEach(p => {
      if (p.title && !titleByLower.has(p.title.toLowerCase()))
        titleByLower.set(p.title.toLowerCase(), p.title);
    });

    const nodes = rawPages.map(p => {
      const lines = p.lines || [];
      // カテゴリ判定 (日付 > 映画 > 人物 の優先順)
      let category = 'default';
      if (/^\d{4}-\d{2}-\d{2}/.test(p.title)) {
        category = 'date';
      } else {
        for (const l of lines) {
          const text = typeof l === 'string' ? l : (l.text || '');
          if (text.startsWith('[映画]'))  { category = 'movie';  break; }
          if (text.startsWith('[人物]'))  { category = 'person'; break; }
        }
      }
      return {
        id: p.title, title: p.title,
        lines, linksLc: p.linksLc || [],
        views: p.views || 0, updated: p.updated || 0, degree: 0,
        category,
      };
    });

    const nodeById = new Map(nodes.map(n => [n.id, n]));

    // linksLc 補完: lines 本文の [ブラケット] を解析してエクスポート漏れを補う
    const LINK_SKIP = /^(https?:\/\/|\/|\*+\s|\/\s|-\s)/;
    nodes.forEach(node => {
      const seen = new Set(node.linksLc.map(l => l.toLowerCase()));
      const extra = [];
      (node.lines || []).slice(1).forEach(l => {       // 先頭行(タイトル行)はスキップ
        const text = typeof l === 'string' ? l : (l.text || '');
        const re = /\[([^\[\]]+)\]/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const inner = m[1].trim();
          if (!inner) continue;
          if (LINK_SKIP.test(inner)) continue;                        // URL・装飾記法はスキップ
          if (/\s+https?:\/\//.test(inner)) continue;                 // [タイトル URL] 形式はスキップ
          if (/^https?:\/\/\S+\s/.test(inner)) continue;              // [URL タイトル] 形式はスキップ
          if (inner.endsWith('.icon')) continue;                       // アイコン記法はスキップ
          const lc = inner.toLowerCase();
          if (!seen.has(lc) && titleByLower.has(lc)) {               // 存在するページのみ追加
            seen.add(lc);
            extra.push(inner);
          }
        }
      });
      if (extra.length > 0) node.linksLc = [...node.linksLc, ...extra];
    });

    // 1st pass: 全有向エッジを収集 "srcId\0tgtId"
    const directedSet = new Set();
    nodes.forEach(src => {
      (src.linksLc || []).forEach(raw => {
        const real = titleByLower.get(raw.toLowerCase());
        if (!real || real === src.id) return;
        if (nodeById.has(real)) directedSet.add(src.id + '\x00' + real);
      });
    });

    // 2nd pass: 無向ペアに集約し、双方向かどうかを判定
    const pairSet = new Set();
    const links   = [];
    directedSet.forEach(edge => {
      const sep   = edge.indexOf('\x00');
      const srcId = edge.slice(0, sep);
      const tgtId = edge.slice(sep + 1);
      const pairKey = [srcId, tgtId].sort().join('\x00');
      if (pairSet.has(pairKey)) return;
      pairSet.add(pairKey);
      const bidir = directedSet.has(srcId + '\x00' + tgtId) &&
                    directedSet.has(tgtId + '\x00' + srcId);
      links.push({ source: srcId, target: tgtId, bidirectional: bidir });
      nodeById.get(srcId).degree++;
      nodeById.get(tgtId).degree++;
    });

    const neighborMap = new Map();
    const backlinkMap = new Map();

    links.forEach(l => {
      const s = l.source, t = l.target;
      if (!neighborMap.has(s)) neighborMap.set(s, new Set());
      if (!neighborMap.has(t)) neighborMap.set(t, new Set());
      neighborMap.get(s).add(t);
      neighborMap.get(t).add(s);
    });

    nodes.forEach(src => {
      (src.linksLc || []).forEach(raw => {
        const real = titleByLower.get(raw.toLowerCase());
        if (!real || real === src.id) return;
        if (!backlinkMap.has(real)) backlinkMap.set(real, []);
        if (!backlinkMap.get(real).includes(src.id))
          backlinkMap.get(real).push(src.id);
      });
    });

    logInfo(`ノード: ${nodes.length}, エッジ: ${links.length}`);
    return {
      nodes, links, nodeById, neighborMap, backlinkMap,
      meta: { name: json.displayName || json.name || 'Cosense', projectId: json.name || '' },
    };
  } catch(err) {
    logError('グラフデータの構築中にエラー', err);
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════
   INIT GRAPH  ← 公開API: 他ページからも呼び出し可能
══════════════════════════════════════════════════════════ */
function initGraph(json) {
  try {
    if (simulation) simulation.stop();
    graphData = buildGraph(json);
    navStack = []; navHist = [];
    highlight = { sel: null, nbrs: new Set() };
    maxDegree = Math.max(...graphData.nodes.map(n => n.degree), 1);

    const projectUrl = graphData.meta.projectId
      ? `https://scrapbox.io/${graphData.meta.projectId}/`
      : null;
    document.getElementById('project-name').innerHTML = projectUrl
      ? `🕸️ <a href="${projectUrl}" target="_blank" rel="noopener">${graphData.meta.name}</a>`
      : `🕸️ ${graphData.meta.name}`;
    document.getElementById('stats').textContent =
      `${graphData.nodes.length} pages · ${graphData.links.length} links`;
    const exportedEl = document.getElementById('data-date');
    if (exportedEl && json.exported) {
      const ts = json.exported > 1e10 ? json.exported : json.exported * 1000;
      const d = new Date(ts);
      const dateStr = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
      exportedEl.textContent = dateStr;
    }

    closePanel();
    renderHistory();
    showScreen('app');

    requestAnimationFrame(() => {
      try {
        resizeCanvas();

        simNodes = graphData.nodes.map(d => ({ ...d }));
        simLinks = graphData.links.map(d => ({ source: d.source, target: d.target, bidirectional: d.bidirectional }));

        simulation = d3.forceSimulation(simNodes)
          .force('link', d3.forceLink(simLinks).id(d => d.id).distance(70).strength(0.4))
          .force('charge', d3.forceManyBody().strength(-120).distanceMax(260))
          .force('center', d3.forceCenter(canvas.width / 2, canvas.height / 2))
          .force('collision', d3.forceCollide().radius(d => 4 + d.degree / 2))
          .alphaDecay(0.025)
          .on('tick', draw)
          .on('end', () => logInfo('レイアウト完了'));

        zoomBeh = d3.zoom().scaleExtent([0.04, 12])
          .on('zoom', ev => { transform = ev.transform; draw(); });
        d3.select(canvas).call(zoomBeh);

        initPointerEvents();
        logInfo('グラフを表示しました');
      } catch(err) {
        logError('グラフの描画初期化中にエラー', err);
      }
    });
  } catch(err) {
    logError('グラフの初期化中にエラー', err);
    showScreen('app');
  }
}

/* ══════════════════════════════════════════════════════════
   CANVAS DRAW
══════════════════════════════════════════════════════════ */
function resizeCanvas() {
  canvas.width  = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}
window.addEventListener('resize', () => { resizeCanvas(); draw(); });

function rScale(deg) { return 3.5 + (deg / maxDegree) * 14; }

/* ノードカテゴリ別カラー */
const NODE_COLORS = {
  default: '#58a6ff',  // 通常 (青)
  date:    '#e3b341',  // 日付 (黄)
  movie:   '#d2a8ff',  // 映画 (紫)
  person:  '#adbac7',  // 人物 (グレー)
};

/* 矢印の頭を描く (ターゲットノード円周上に先端を合わせる) */
function drawArrowHead(sx, sy, tx, ty, tRadius) {
  const k    = transform.k;
  const len  = 8 / k;           // 矢印の長さ
  const ang  = Math.PI / 6;     // 矢羽角度 30°
  const dx   = tx - sx, dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-6) return;
  const ux = dx / dist, uy = dy / dist;
  // 先端をノード円周まで後退
  const tipX = tx - ux * (tRadius + 1 / k);
  const tipY = ty - uy * (tRadius + 1 / k);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - len * Math.cos(Math.atan2(uy, ux) - ang),
             tipY - len * Math.sin(Math.atan2(uy, ux) - ang));
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - len * Math.cos(Math.atan2(uy, ux) + ang),
             tipY - len * Math.sin(Math.atan2(uy, ux) + ang));
  ctx.stroke();
}

function draw() {
  try {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const hasSel = !!highlight.sel;
    const { sel, nbrs } = highlight;
    const k = transform.k;

    /* ── 非ハイライト線 ── */
    // 相互参照: 実線
    ctx.beginPath();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 0.8 / k;
    ctx.globalAlpha = hasSel ? 0.06 : 0.4;
    simLinks.forEach(l => {
      if (!l.bidirectional) return;
      const s = l.source, t = l.target;
      if (!s.x || !t.x) return;
      if (hasSel && (s.id === sel || t.id === sel)) return;
      ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y);
    });
    ctx.stroke();

    // 片側参照: 点線
    ctx.beginPath();
    ctx.setLineDash([4 / k, 4 / k]);
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 0.6 / k;
    ctx.globalAlpha = hasSel ? 0.05 : 0.28;
    simLinks.forEach(l => {
      if (l.bidirectional) return;
      const s = l.source, t = l.target;
      if (!s.x || !t.x) return;
      if (hasSel && (s.id === sel || t.id === sel)) return;
      ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // 片側参照: 矢印 (ズーム 0.3 以上で描画)
    if (k >= 0.3) {
      ctx.strokeStyle = '#30363d'; ctx.lineWidth = 0.6 / k;
      ctx.globalAlpha = hasSel ? 0.05 : 0.28;
      simLinks.forEach(l => {
        if (l.bidirectional) return;
        const s = l.source, t = l.target;
        if (!s.x || !t.x) return;
        if (hasSel && (s.id === sel || t.id === sel)) return;
        drawArrowHead(s.x, s.y, t.x, t.y, rScale(t.degree));
      });
    }

    /* ── ハイライト線 ── */
    if (hasSel) {
      // 相互参照: 実線 (青)
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.5 / k;
      ctx.globalAlpha = 0.85;
      simLinks.forEach(l => {
        if (!l.bidirectional) return;
        const s = l.source, t = l.target;
        if (!s.x || !t.x) return;
        if (s.id === sel || t.id === sel) { ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); }
      });
      ctx.stroke();

      // 片側参照: 点線 (青)
      ctx.beginPath();
      ctx.setLineDash([4 / k, 4 / k]);
      ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.2 / k;
      ctx.globalAlpha = 0.75;
      simLinks.forEach(l => {
        if (l.bidirectional) return;
        const s = l.source, t = l.target;
        if (!s.x || !t.x) return;
        if (s.id === sel || t.id === sel) { ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); }
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // 片側参照: 矢印 (青)
      ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.5 / k;
      ctx.globalAlpha = 0.85;
      simLinks.forEach(l => {
        if (l.bidirectional) return;
        const s = l.source, t = l.target;
        if (!s.x || !t.x) return;
        if (s.id === sel || t.id === sel)
          drawArrowHead(s.x, s.y, t.x, t.y, rScale(t.degree));
      });
    }

    /* ── ノード ── */
    ctx.globalAlpha = 1;
    simNodes.forEach(n => {
      if (!n.x) return;
      const r = rScale(n.degree);
      const isSel = n.id === sel, isNbr = nbrs.has(n.id);
      const catColor = NODE_COLORS[n.category] || NODE_COLORS.default;
      let color, alpha;
      if (!hasSel)    { color = catColor;   alpha = 0.85; }
      else if (isSel) { color = '#f78166';  alpha = 1; }
      else if (isNbr) { color = catColor;   alpha = 0.9; }
      else            { color = '#21262d';  alpha = 0.25; }
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      if (isSel) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / k; ctx.stroke();
      }
      const showLabel = isSel || isNbr || n.degree >= 8 || k >= 1.5;
      if (k >= 0.5 && showLabel) {
        ctx.globalAlpha = isSel ? 1 : (isNbr ? 0.9 : 0.65);
        const fs = Math.min(12, Math.max(8, r + 1));
        ctx.font = `${fs / k}px system-ui`;
        ctx.fillStyle = '#e6edf3';
        const lbl = n.title.length > 24 ? n.title.slice(0, 24) + '…' : n.title;
        ctx.fillText(lbl, n.x + r / k + 2, n.y + 4 / k);
      }
    });
    ctx.globalAlpha = 1; ctx.restore();
  } catch(err) {
    logError('描画中にエラー', err);
  }
}

/* ══════════════════════════════════════════════════════════
   POINTER EVENTS
══════════════════════════════════════════════════════════ */
function hitNode(cx, cy) {
  const wx = (cx - transform.x) / transform.k;
  const wy = (cy - transform.y) / transform.k;
  for (let i = simNodes.length - 1; i >= 0; i--) {
    const n = simNodes[i];
    if (!n.x) continue;
    const r = rScale(n.degree) + 5;
    const dx = wx - n.x, dy = wy - n.y;
    if (dx * dx + dy * dy <= r * r) return n;
  }
  return null;
}

function initPointerEvents() {
  if (eventCtrl) eventCtrl.abort();
  eventCtrl = new AbortController();
  const sig = { signal: eventCtrl.signal };
  let downNode = null, moved = false;
  canvas.addEventListener('pointerdown', e => {
    const r = canvas.getBoundingClientRect();
    downNode = hitNode(e.clientX - r.left, e.clientY - r.top);
    moved = false; canvas.classList.add('grabbing');
    console.log('[DBG] pointerdown  downNode=', downNode ? downNode.title : null,
      ' canvas:', canvas.width, 'x', canvas.height);
  }, sig);
  const tooltip = document.getElementById('node-tooltip');
  canvas.addEventListener('pointermove', e => {
    if (e.buttons > 0) { moved = true; tooltip.style.opacity = '0'; return; }
    const r = canvas.getBoundingClientRect();
    const hovered = hitNode(e.clientX - r.left, e.clientY - r.top);
    canvas.style.cursor = hovered ? 'pointer' : 'grab';
    if (hovered) {
      tooltip.textContent = hovered.title;
      tooltip.style.left = (e.clientX + 14) + 'px';
      tooltip.style.top  = (e.clientY - 8)  + 'px';
      tooltip.style.opacity = '1';
    } else {
      tooltip.style.opacity = '0';
    }
  }, sig);
  canvas.addEventListener('pointerleave', () => { tooltip.style.opacity = '0'; }, sig);
  canvas.addEventListener('pointerup', e => {
    canvas.classList.remove('grabbing');
    const r = canvas.getBoundingClientRect();
    const n = hitNode(e.clientX - r.left, e.clientY - r.top);
    console.log('[DBG] pointerup  moved=', moved, ' hitNode=', n ? n.title : null,
      ' downNode=', downNode ? downNode.title : null,
      ' match=', n === downNode);
    if (moved) { console.log('[DBG] → skipped (moved)'); return; }
    if (n && n === downNode) selectNode(n);
    else if (!n) clearSelection();
  }, sig);
}

/* ══════════════════════════════════════════════════════════
   SELECT / NAVIGATE
══════════════════════════════════════════════════════════ */
function selectNode(simNode) {
  console.log('[DBG] selectNode  id=', simNode.id, ' title=', simNode.title);
  try {
    const nbrs = graphData.neighborMap.get(simNode.id) || new Set();
    highlight = { sel: simNode.id, nbrs }; draw();
    const last = navStack[navStack.length - 1];
    if (!last || last.id !== simNode.id)
      navStack.push({ id: simNode.id, title: simNode.title });
    const hlast = navHist[navHist.length - 1];
    if (!hlast || hlast.id !== simNode.id)
      navHist = [...navHist.slice(-19), { id: simNode.id, title: simNode.title }];
    renderHistory();
    console.log('[DBG] calling openCard ...');
    openCard(simNode);
    console.log('[DBG] openCard done, panel open=',
      document.getElementById('side-panel').classList.contains('open'));
    flyTo(simNode);
  } catch(err) {
    console.error('[DBG] selectNode ERROR:', err);
    logError('ノード選択中にエラー', err);
  }
}

function flyTo(simNode) {
  if (!simNode.x) return;
  const W = canvas.width, H = canvas.height;
  const scale = Math.max(transform.k, 1.2);
  // 縦表示スマートフォンはパネルが下半分を覆うため、上半分の中央(H/4)に移動
  const isPortraitMobile = window.matchMedia(
    '(max-width: 600px) and (orientation: portrait)'
  ).matches;
  const targetY = isPortraitMobile ? H / 4 : H / 2;
  d3.select(canvas).transition().duration(600)
    .call(zoomBeh.transform, d3.zoomIdentity
      .translate(W / 2 - scale * simNode.x, targetY - scale * simNode.y)
      .scale(scale));
}

function clearSelection() {
  highlight = { sel: null, nbrs: new Set() }; draw();
  closePanel();
}

function navigateTo(titleRaw) {
  try {
    const t = titleRaw.trim();
    const n = simNodes.find(x => x.id === t) ||
              simNodes.find(x => x.id.toLowerCase() === t.toLowerCase());
    if (n) selectNode(n);
    else logInfo(`ページが見つかりません: ${t}`);
  } catch(err) {
    logError('ナビゲーション中にエラー', err);
  }
}

/* ══════════════════════════════════════════════════════════
   COSENSE MARKUP
══════════════════════════════════════════════════════════ */
function cosenseToHtml(text) {
  let s = escHtml(text);
  s = s.replace(/\[\*{3,}\s(.+?)\]/g, '<strong style="font-size:1.25em;color:#fff">$1</strong>');
  s = s.replace(/\[\*{2}\s(.+?)\]/g,  '<strong style="font-size:1.1em;color:#fff">$1</strong>');
  s = s.replace(/\[\*\s(.+?)\]/g,     '<strong>$1</strong>');
  s = s.replace(/\[\/\s(.+?)\]/g,     '<em>$1</em>');
  s = s.replace(/\[-\s(.+?)\]/g,      '<del>$1</del>');
  s = s.replace(/\[(https?:\/\/[^\[\]\s]+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\[\]\s]*)?)\]/gi,
    '<img src="$1" alt="">');
  s = s.replace(/\[(https?:\/\/(?:www\.youtube\.com|youtu\.be|vimeo\.com)[^\[\]\s]+)\]/g,
    '<a href="$1" target="_blank" rel="noopener">▶ 動画</a>');
  s = s.replace(/\[(https?:\/\/[^\[\]\s]+)\s+([^\[\]]+?)\]/g,
    '<a href="$1" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/\[([^\[\]]+?)\s+(https?:\/\/[^\[\]\s]+)\]/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\[(https?:\/\/[^\[\]\s]+)\]/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\[([^\[\]]+)\]/g,
    '<span class="ilink" data-link="$1">$1</span>');
  s = s.replace(/#(\S+)/g, (m, tag, offset, str) => {
    const before = str.slice(0, offset);
    if (before.lastIndexOf('<') > before.lastIndexOf('>')) return m;
    return `<span class="ilink" data-link="${tag}" style="color:var(--green)">#${tag}</span>`;
  });
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 裸の URL（ブラケット処理済みの href / リンクテキスト内は除外）
  s = s.replace(/(?<![=">])(https?:\/\/[^\s<>"[\]]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return s;
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

/* ══════════════════════════════════════════════════════════
   DOCUMENT PAGE
══════════════════════════════════════════════════════════ */
function buildCard(node) {
  console.log('[DBG] buildCard  node.id=', node.id, ' nodeById hit=', graphData.nodeById.has(node.id));
  const orig = graphData.nodeById.get(node.id) || node;
  const backlinks = graphData.backlinkMap.get(node.id) || [];
  console.log('[DBG] buildCard  orig.title=', orig.title, ' lines=', (orig.lines||[]).length,
    ' backlinks=', backlinks.length);
  const doc = document.createElement('div');
  doc.className = 'cosense-doc';

  // タイトル
  const titleEl = document.createElement('div');
  titleEl.className = 'doc-title';
  const projectId = graphData.meta && graphData.meta.projectId;
  if (projectId) {
    const titleLink = document.createElement('a');
    titleLink.href = `https://scrapbox.io/${projectId}/${encodeURIComponent(orig.title)}`;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener';
    titleLink.textContent = orig.title;
    titleLink.className = 'doc-title-link';
    titleEl.appendChild(titleLink);
  } else {
    titleEl.textContent = orig.title;
  }
  doc.appendChild(titleEl);

  // メタ情報
  const metaParts = [];
  if (orig.degree > 0)      metaParts.push(`🔗 ${orig.degree} リンク`);
  if (backlinks.length > 0) metaParts.push(`⬅ ${backlinks.length} バックリンク`);
  if (orig.views)           metaParts.push(`👁 ${orig.views}`);
  if (orig.updated)         metaParts.push(`🕐 ${fmtDate(orig.updated)}`);
  if (metaParts.length) {
    const meta = document.createElement('div');
    meta.className = 'doc-meta';
    meta.innerHTML = metaParts.map(s => `<span>${s}</span>`).join('');
    doc.appendChild(meta);
  }

  // 本文
  const body = document.createElement('div');
  body.className = 'doc-body';

  const rawLines = (orig.lines || []).slice(1);
  let idx = 0;
  while (idx < rawLines.length) {
    const l = rawLines[idx];
    const raw = typeof l === 'string' ? l : (l.text || '');
    idx++;
    if (!raw.trim()) {
      const em = document.createElement('div'); em.className = 'c-empty';
      body.appendChild(em); continue;
    }
    const tabMatch = raw.match(/^\t+/);
    const level = tabMatch ? tabMatch[0].length : 0;
    const text = raw.slice(level);
    // コードブロック
    if (/^code($|:)/i.test(text)) {
      const lang = text.replace(/^code:?/i, '').trim() || '';
      const codeLines = [];
      while (idx < rawLines.length) {
        const cl = rawLines[idx];
        const ct = typeof cl === 'string' ? cl : (cl.text || '');
        if (!ct.trim()) { codeLines.push(''); idx++; continue; }
        const clevel = (ct.match(/^\t+/) || [''])[0].length;
        if (clevel <= level) break;
        codeLines.push(ct.slice(level + 1)); idx++;
      }
      const wrap = document.createElement('div'); wrap.className = 'c-code-wrap';
      if (lang) {
        const codeTitle = document.createElement('div'); codeTitle.className = 'c-code-title';
        codeTitle.innerHTML = '<span style="color:#58a6ff">⌨</span> ' + escHtml(lang);
        wrap.appendChild(codeTitle);
      }
      const pre = document.createElement('pre');
      pre.textContent = codeLines.join('\n').replace(/\n+$/, '');
      wrap.appendChild(pre); body.appendChild(wrap); continue;
    }
    // 引用
    if (/^>\s/.test(text) || text === '>') {
      const q = document.createElement('div'); q.className = 'c-quote';
      q.innerHTML = cosenseToHtml(text.replace(/^>\s?/, ''));
      body.appendChild(q); continue;
    }
    // 通常行
    const lineDiv = document.createElement('div'); lineDiv.className = 'c-line';
    if (level > 0) {
      lineDiv.style.paddingLeft = (22 + (level - 1) * 22) + 'px';
      const b = document.createElement('span'); b.className = 'c-bullet';
      b.textContent = level === 1 ? '•' : level === 2 ? '◦' : '▸';
      lineDiv.appendChild(b);
    }
    const t = document.createElement('span'); t.className = 'c-text';
    t.innerHTML = cosenseToHtml(text);
    lineDiv.appendChild(t);
    body.appendChild(lineDiv);
  }
  if (!body.hasChildNodes()) {
    const p = document.createElement('p'); p.className = 'empty-hint'; p.textContent = '（本文なし）';
    body.appendChild(p);
  }
  body.addEventListener('click', e => {
    const link = e.target.dataset?.link || e.target.closest?.('[data-link]')?.dataset?.link;
    if (link) navigateTo(link);
  });
  doc.appendChild(body);

  // 出リンク
  const lcs = orig.linksLc || [];
  if (lcs.length) {
    const sec = document.createElement('div'); sec.className = 'doc-section';
    const lbl = document.createElement('div'); lbl.className = 'section-label';
    lbl.textContent = `出リンク (${lcs.length})`; sec.appendChild(lbl);
    const chips = document.createElement('div'); chips.className = 'chips';
    lcs.forEach(lc => {
      const exists = [...graphData.nodeById.keys()].some(k => k.toLowerCase() === lc.toLowerCase());
      const ch = document.createElement('span');
      ch.className = 'chip ' + (exists ? 'chip-link' : 'chip-dead');
      ch.textContent = lc; ch.title = lc;
      if (exists) ch.addEventListener('click', () => navigateTo(lc));
      chips.appendChild(ch);
    });
    sec.appendChild(chips); doc.appendChild(sec);
  }

  // バックリンク
  if (backlinks.length) {
    const sec = document.createElement('div'); sec.className = 'doc-section';
    const lbl = document.createElement('div'); lbl.className = 'section-label';
    lbl.textContent = `バックリンク (${backlinks.length})`; sec.appendChild(lbl);
    const chips = document.createElement('div'); chips.className = 'chips';
    backlinks.forEach(bl => {
      const ch = document.createElement('span');
      ch.className = 'chip chip-back'; ch.textContent = bl; ch.title = bl;
      ch.addEventListener('click', () => navigateTo(bl));
      chips.appendChild(ch);
    });
    sec.appendChild(chips); doc.appendChild(sec);
  }
  return doc;
}

/* ══════════════════════════════════════════════════════════
   PANEL
══════════════════════════════════════════════════════════ */
function openCard(simNode) {
  console.log('[DBG] openCard  title=', simNode.title);
  document.getElementById('panel-breadcrumb').textContent = simNode.title;
  document.getElementById('btn-back').disabled = navStack.length <= 1;
  document.getElementById('side-panel').classList.add('open');
  document.getElementById('legend').style.right = '474px';
  requestAnimationFrame(() => { resizeCanvas(); draw(); });
  const sp = document.getElementById('side-panel');
  const spRect = sp.getBoundingClientRect();
  console.log('[DBG] panel classList=', sp.className);
  console.log('[DBG] panel rect=', JSON.stringify({x:Math.round(spRect.x),y:Math.round(spRect.y),w:Math.round(spRect.width),h:Math.round(spRect.height)}));
  console.log('[DBG] panel computedDisplay=', getComputedStyle(sp).display,
    ' visibility=', getComputedStyle(sp).visibility,
    ' opacity=', getComputedStyle(sp).opacity);
  const main = document.getElementById('main');
  console.log('[DBG] #main rect=', JSON.stringify({w:Math.round(main.getBoundingClientRect().width),h:Math.round(main.getBoundingClientRect().height)}));

  const scroll = document.getElementById('panel-scroll');
  scroll.innerHTML = '';
  scroll.scrollTop = 0;
  try {
    const cardEl = buildCard(simNode);
    console.log('[DBG] buildCard returned, children=', cardEl.children.length);
    scroll.appendChild(cardEl);
    console.log('[DBG] scroll children=', scroll.children.length,
      ' scroll.offsetHeight=', scroll.offsetHeight,
      ' scroll.scrollHeight=', scroll.scrollHeight);
  } catch(err) {
    console.error('[DBG] buildCard ERROR:', err);
    logError('ドキュメントの構築中にエラー', err);
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:20px;color:#f85149;font-size:13px;';
    msg.textContent = 'エラー: ' + err.message;
    scroll.appendChild(msg);
  }
}
function closePanel() {
  document.getElementById('side-panel').classList.remove('open');
  document.getElementById('legend').style.right = '14px';
  requestAnimationFrame(() => { resizeCanvas(); draw(); });
  navStack = [];
  document.getElementById('panel-breadcrumb').textContent = '';
  document.getElementById('btn-back').disabled = true;
}
document.getElementById('btn-close').addEventListener('click', clearSelection);
document.getElementById('btn-back').addEventListener('click', () => {
  if (navStack.length <= 1) return;
  navStack.pop();
  const prev = navStack.pop();
  if (prev) navigateTo(prev.id);
});

/* ══════════════════════════════════════════════════════════
   HISTORY
══════════════════════════════════════════════════════════ */
function renderHistory() {
  const bar = document.getElementById('history-bar');
  bar.innerHTML = '';
  navHist.slice(-6).forEach((h, i, arr) => {
    const tag = document.createElement('span');
    tag.className = 'hist-tag' + (i === arr.length - 1 ? ' current' : '');
    tag.textContent = h.title; tag.title = h.title;
    tag.addEventListener('click', () => navigateTo(h.id));
    bar.appendChild(tag);
  });
}

/* ══════════════════════════════════════════════════════════
   SEARCH
══════════════════════════════════════════════════════════ */
const searchEl  = document.getElementById('search');
const searchRes = document.getElementById('search-results');
searchEl.addEventListener('input', () => {
  const q = searchEl.value.toLowerCase().trim();
  if (!q || !graphData) { searchRes.classList.remove('show'); return; }
  const hits = graphData.nodes
    .filter(n => n.title.toLowerCase().includes(q))
    .sort((a, b) => b.degree - a.degree).slice(0, 12);
  if (!hits.length) { searchRes.classList.remove('show'); return; }
  searchRes.innerHTML = '';
  hits.forEach(n => {
    const div = document.createElement('div'); div.className = 'sr-item';
    div.innerHTML = `<span style="color:var(--green);font-size:9px">●</span><span>${escHtml(n.title)}</span><span class="sr-deg">${n.degree}L</span>`;
    div.addEventListener('click', () => {
      navigateTo(n.id); searchEl.value = ''; searchRes.classList.remove('show');
    });
    searchRes.appendChild(div);
  });
  searchRes.classList.add('show');
});
document.addEventListener('click', e => {
  if (!document.getElementById('search-wrap').contains(e.target))
    searchRes.classList.remove('show');
});

/* ══════════════════════════════════════════════════════════
   AUTO START
   window.COSENSE_DATA がセットされていれば自動起動。
   非同期でデータを取得する場合は initGraph(data) を直接呼ぶこと。
══════════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  if (!window.COSENSE_DATA) {
    logError('データが見つかりません。データファイルを読み込むか initGraph(data) を呼び出してください。');
    return;
  }
  logInfo('データを読み込んでいます...');
  setTimeout(() => initGraph(window.COSENSE_DATA), 50);
});
