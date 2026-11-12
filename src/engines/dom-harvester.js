/**
 * ZeeML Tri-Modal DOM, CSS Grid & JSON State Harvester
 * Reference Specification: https://zeeml.com/json-to-csv
 *
 * Performance & Security Hardening:
 * - Zero getComputedStyle() / Zero getBoundingClientRect() forced reflows
 * - O(N) single-pass structural signature hashing for repeating Flexbox/Grid cards
 * - Hard 45ms time budget (performance.now()) on heuristic grid discovery
 * - Recursive Open Shadow DOM (el.shadowRoot) and same-origin <iframe> traversal
 * - 2D colspan/rowspan matrix expansion for HTML <table> elements
 * - Self-contained Shadow-DOM Quick-Export Toast for MV3 Context Menu actions
 */
(function (root) {
  'use strict';

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'HEAD', 'META', 'LINK', 'BR', 'HR', 'TEMPLATE'
  ]);

  function isElementFastVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    if (typeof el.checkVisibility === 'function') {
      try {
        return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: false });
      } catch (_) {}
    }
    return el.offsetParent !== null || el.tagName === 'BODY' || el.tagName === 'HTML';
  }

  function cleanCellText(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    const junk = clone.querySelectorAll ? clone.querySelectorAll('script, style, noscript, svg, [aria-hidden="true"]') : [];
    for (let i = 0; i < junk.length; i++) junk[i].remove();
    return String(clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function collectDocumentRoots(rootDoc, roots = [], depth = 0) {
    if (!rootDoc || depth > 4) return roots;
    roots.push(rootDoc);

    const allEls = rootDoc.querySelectorAll ? rootDoc.querySelectorAll('*') : [];
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      if (el.shadowRoot) {
        collectDocumentRoots(el.shadowRoot, roots, depth + 1);
      }
      if (el.tagName === 'IFRAME') {
        try {
          if (el.contentDocument) {
            collectDocumentRoots(el.contentDocument, roots, depth + 1);
          }
        } catch (_) {
          // Cross-origin iframe; ignore safely
        }
      }
    }
    return roots;
  }

  /**
   * Mode 1: Matrix-Normalized HTML <table> Extractor (expands colspan & rowspan)
   */
  function parseHtmlTableElement(tableEl, index, options = {}) {
    const extractLinks = Boolean(options.extractLinks);
    const trList = Array.from(tableEl.querySelectorAll('tr')).filter(
      tr => tr.closest('table') === tableEl
    );
    if (trList.length < 2) return null;

    const grid = [];
    const linkGrid = [];
    let maxCols = 0;

    for (let r = 0; r < trList.length; r++) {
      if (!grid[r]) grid[r] = [];
      if (!linkGrid[r]) linkGrid[r] = [];
      const cells = Array.from(trList[r].children).filter(
        c => c.tagName === 'TD' || c.tagName === 'TH'
      );

      let cCursor = 0;
      for (const cell of cells) {
        while (grid[r][cCursor] !== undefined) cCursor++;

        const text = cleanCellText(cell);
        const anchor = extractLinks && cell.querySelector ? cell.querySelector('a[href]') : null;
        const href = anchor && anchor.href && !anchor.href.startsWith('javascript:') ? anchor.href : '';

        const colspan = Math.min(20, Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1));
        const rowspan = Math.min(50, Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1));

        for (let dr = 0; dr < rowspan; dr++) {
          const targetR = r + dr;
          if (!grid[targetR]) grid[targetR] = [];
          if (!linkGrid[targetR]) linkGrid[targetR] = [];
          for (let dc = 0; dc < colspan; dc++) {
            const targetC = cCursor + dc;
            grid[targetR][targetC] = dr === 0 && dc === 0 ? text : (dr > 0 && dc === 0 ? text : '');
            linkGrid[targetR][targetC] = dr === 0 && dc === 0 ? href : '';
            if (targetC + 1 > maxCols) maxCols = targetC + 1;
          }
        }
        cCursor += colspan;
      }
    }

    if (maxCols < 2 || grid.length < 2) return null;

    // Normalize row lengths and drop completely empty rows
    const nonEmptyRows = [];
    const nonEmptyLinks = [];
    for (let r = 0; r < grid.length; r++) {
      const row = new Array(maxCols);
      const lRow = new Array(maxCols);
      let hasVal = false;
      for (let c = 0; c < maxCols; c++) {
        const v = grid[r][c] !== undefined ? String(grid[r][c]).trim() : '';
        row[c] = v;
        lRow[c] = linkGrid[r][c] || '';
        if (v !== '') hasVal = true;
      }
      if (hasVal) {
        nonEmptyRows.push(row);
        nonEmptyLinks.push(lRow);
      }
    }

    if (nonEmptyRows.length < 2) return null;

    const hasTheadOrTh = Boolean(tableEl.querySelector('thead, tr:first-child > th'));
    const rawHeaders = hasTheadOrTh
      ? nonEmptyRows[0]
      : nonEmptyRows[0].map((v, i) => (v && v.length <= 42 && !/^\d+$/.test(v) ? v : `Column ${i + 1}`));
    const bodyStart = hasTheadOrTh || rawHeaders === nonEmptyRows[0] ? 1 : 0;
    let dataRows = nonEmptyRows.slice(bodyStart);
    const dataLinks = nonEmptyLinks.slice(bodyStart);

    if (dataRows.length === 0) return null;

    // Append extracted URL columns if requested and present
    const finalHeaders = [...rawHeaders];
    if (extractLinks) {
      for (let c = 0; c < maxCols; c++) {
        const hasAnyHref = dataLinks.some(lr => Boolean(lr[c]));
        if (hasAnyHref) {
          finalHeaders.push(`${rawHeaders[c] || `Column_${c + 1}`}_url`);
          dataRows = dataRows.map((r, rIdx) => [...r, dataLinks[rIdx][c] || '']);
        }
      }
    }

    const captionEl = tableEl.querySelector('caption');
    const ariaLabel = tableEl.getAttribute('aria-label') || tableEl.id || '';
    const label = cleanCellText(captionEl) || ariaLabel || `HTML Table #${index + 1}`;

    return {
      id: `html-table-${index + 1}`,
      sourceType: 'html-table',
      badge: 'HTML <table>',
      label: label.slice(0, 68),
      headers: finalHeaders,
      rows: dataRows
    };
  }

  /**
   * Mode 2: Zero-Reflow O(N) Structural Hash Clustering for CSS Flexbox/Grid Card Lists
   */
  function childStructuralSignature(el) {
    if (!el || SKIP_TAGS.has(el.tagName)) return '';
    const classes = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).sort().join('.')
      : '';
    const childTags = [];
    const ch = el.children || [];
    for (let i = 0; i < Math.min(ch.length, 8); i++) {
      if (!SKIP_TAGS.has(ch[i].tagName)) {
        childTags.push(ch[i].tagName);
      }
    }
    if (childTags.length === 0) return '';
    return `${el.tagName}.${classes}>[${childTags.join(',')}]`;
  }

  function extractLeafFieldsFromCard(cardEl) {
    const fields = [];
    const seenTexts = new Set();

    function walk(node, pathPrefix, depth) {
      if (!node || depth > 4 || fields.length >= 16) return;
      if (SKIP_TAGS.has(node.tagName)) return;

      const ch = node.children || [];
      if (ch.length === 0) {
        const txt = cleanCellText(node);
        if (txt && txt.length <= 240 && !seenTexts.has(txt)) {
          seenTexts.add(txt);
          const cls = typeof node.className === 'string'
            ? node.className.trim().split(/\s+/)[0] || ''
            : '';
          const fieldKey = (node.getAttribute('data-field') || node.getAttribute('itemprop') || cls || `${pathPrefix}_${node.tagName.toLowerCase()}`)
            .replace(/[^a-zA-Z0-9_-]/g, '')
            .slice(0, 32) || `field_${fields.length + 1}`;
          fields.push({ key: fieldKey, value: txt });
        }
        if (node.tagName === 'A' && node.href && !node.href.startsWith('javascript:')) {
          fields.push({ key: 'link_url', value: node.href });
        }
        return;
      }

      for (let i = 0; i < ch.length; i++) {
        walk(ch[i], `${pathPrefix}_${ch[i].tagName.toLowerCase()}`, depth + 1);
      }
    }

    walk(cardEl, 'card', 0);
    return fields;
  }

  function discoverRepeatingGridDatasets(roots, timeBudgetMs = 45) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const datasets = [];
    let inspectedContainers = 0;

    for (const rootNode of roots) {
      const candidates = rootNode.querySelectorAll
        ? rootNode.querySelectorAll('[role="grid"], [role="table"], ul, ol, section, main, div')
        : [];

      for (let i = 0; i < candidates.length; i++) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - t0 > timeBudgetMs || inspectedContainers > 2500 || datasets.length >= 6) {
          return datasets;
        }

        const parent = candidates[i];
        if (parent.closest && parent.closest('table, nav, header, footer')) continue;
        const children = parent.children;
        if (!children || children.length < 4 || children.length > 500) continue;
        if (!isElementFastVisible(parent)) continue;

        inspectedContainers++;

        // Group children by O(1) structural signature
        const sigBuckets = new Map();
        for (let c = 0; c < children.length; c++) {
          const sig = childStructuralSignature(children[c]);
          if (!sig) continue;
          let bucket = sigBuckets.get(sig);
          if (!bucket) {
            bucket = [];
            sigBuckets.set(sig, bucket);
          }
          bucket.push(children[c]);
        }

        for (const [, cards] of sigBuckets.entries()) {
          if (cards.length < 4 || cards.length < children.length * 0.6) continue;

          const cardRecords = cards.map(extractLeafFieldsFromCard).filter(f => f.length >= 2);
          if (cardRecords.length < 4) continue;

          // Collect canonical column keys
          const colKeys = [];
          const colKeySet = new Set();
          for (const rec of cardRecords) {
            for (const f of rec) {
              if (!colKeySet.has(f.key) && colKeys.length < 14) {
                colKeySet.add(f.key);
                colKeys.push(f.key);
              }
            }
          }
          if (colKeys.length < 2) continue;

          const rows = cardRecords.map(rec => {
            const map = new Map();
            for (const f of rec) {
              if (!map.has(f.key)) map.set(f.key, f.value);
            }
            return colKeys.map(k => map.get(k) || '');
          });

          const sectionHeading = parent.closest('section')?.querySelector('h1, h2, h3');
          const label = cleanCellText(sectionHeading) || parent.getAttribute('aria-label') || parent.id || `Repeating Card Grid (${rows.length} items)`;

          datasets.push({
            id: `css-grid-${datasets.length + 1}`,
            sourceType: 'css-grid',
            badge: 'CSS Grid / Cards',
            label: label.slice(0, 68),
            headers: colKeys,
            rows
          });
          break;
        }
      }
    }

    return datasets;
  }

  /**
   * Mode 3: Structured JSON State Harvester (JSON-LD, __NEXT_DATA__, <pre> JSON arrays)
   */
  function flattenJsonObject(obj, prefix = '', out = {}, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 3) return out;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('@') && k !== '@type') continue;
      const key = prefix ? `${prefix}_${k}` : k;
      if (v === null || v === undefined) {
        out[key] = '';
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[key] = String(v);
      } else if (Array.isArray(v)) {
        if (v.every(item => typeof item === 'string' || typeof item === 'number')) {
          out[key] = v.slice(0, 10).join('; ');
        } else if (v.length > 0 && typeof v[0] === 'object') {
          flattenJsonObject(v[0], key, out, depth + 1);
        }
      } else if (typeof v === 'object') {
        flattenJsonObject(v, key, out, depth + 1);
      }
    }
    return out;
  }

  function findLargestObjectArrays(node, found = [], labelPrefix = 'JSON', depth = 0) {
    if (!node || depth > 5 || found.length >= 6) return found;
    if (Array.isArray(node)) {
      const objItems = node.filter(item => item && typeof item === 'object' && !Array.isArray(item));
      if (objItems.length >= 2) {
        found.push({ label: labelPrefix, items: objItems.slice(0, 1000) });
      }
      return found;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        findLargestObjectArrays(v, found, k, depth + 1);
      }
    }
    return found;
  }

  function harvestEmbeddedJsonDatasets(roots) {
    const datasets = [];
    for (const rootNode of roots) {
      const scripts = rootNode.querySelectorAll
        ? rootNode.querySelectorAll('script[type="application/ld+json"], script#__NEXT_DATA__, script[type="application/json"], pre')
        : [];

      for (let i = 0; i < scripts.length && datasets.length < 5; i++) {
        const el = scripts[i];
        const raw = (el.textContent || '').trim();
        if (raw.length < 25 || raw.length > 1500000) continue;
        if (!raw.startsWith('{') && !raw.startsWith('[')) continue;

        try {
          const parsed = JSON.parse(raw);
          const candidateArrays = findLargestObjectArrays(
            parsed,
            [],
            el.id || (el.tagName === 'PRE' ? 'Preformatted JSON' : 'Structured JSON State')
          );

          for (const cand of candidateArrays) {
            const flatRecords = cand.items.map(item => flattenJsonObject(item));
            const keySet = new Set();
            for (const rec of flatRecords) {
              Object.keys(rec).forEach(k => {
                if (keySet.size < 24) keySet.add(k);
              });
            }
            const headers = Array.from(keySet);
            if (headers.length < 2) continue;
            const rows = flatRecords.map(rec => headers.map(h => rec[h] ?? ''));
            datasets.push({
              id: `json-state-${datasets.length + 1}`,
              sourceType: 'json-state',
              badge: 'JSON Payload',
              label: `JSON: ${cand.label} (${rows.length} records)`.slice(0, 68),
              headers,
              rows
            });
          }
        } catch (_) {}
      }
    }
    return datasets;
  }

  /**
   * Master Entry Point: Harvests all tables, CSS grids, and JSON payloads on the page.
   */
  function harvestAllPageDatasets(options = {}) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return { datasets: [], elapsedMs: 0 };

    const roots = collectDocumentRoots(doc);
    const datasets = [];

    // 1. Classic HTML <table> elements across all roots
    let tableIdx = 0;
    for (const r of roots) {
      const tables = r.querySelectorAll ? r.querySelectorAll('table') : [];
      for (let i = 0; i < tables.length; i++) {
        const parsed = parseHtmlTableElement(tables[i], tableIdx++, options);
        if (parsed) datasets.push(parsed);
      }
    }

    // 2. Heuristic CSS Grid / Flexbox repeating cards (45ms time budget)
    const gridSets = discoverRepeatingGridDatasets(roots, 45);
    datasets.push(...gridSets);

    // 3. Embedded JSON-LD / Hydration payloads
    const jsonSets = harvestEmbeddedJsonDatasets(roots);
    datasets.push(...jsonSets);

    // Sort by data richness (rowCount * colCount descending, prioritizing HTML tables)
    datasets.sort((a, b) => {
      const scoreA = a.rows.length * a.headers.length * (a.sourceType === 'html-table' ? 1.5 : 1);
      const scoreB = b.rows.length * b.headers.length * (b.sourceType === 'html-table' ? 1.5 : 1);
      return scoreB - scoreA;
    });

    const elapsedMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) * 10) / 10;
    return {
      pageTitle: doc.title || 'Webpage Dataset',
      pageUrl: doc.location ? doc.location.href : '',
      elapsedMs,
      datasets
    };
  }

  /**
   * Self-Contained In-Page Shadow-DOM Quick-Export Toast (Triggered via Context Menu)
   */
  function showQuickExportToast() {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('zml-harvester-toast-host');
    if (existing) existing.remove();

    const harvested = harvestAllPageDatasets({ extractLinks: false });
    const host = document.createElement('div');
    host.id = 'zml-harvester-toast-host';
    host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });

    const topDs = harvested.datasets[0];
    const hasData = Boolean(topDs);

    let csvPayload = '';
    let jsonPayload = '';
    if (hasData && root.ZeeMLSchemaIntelligence && root.ZeeMLFormatExporter) {
      const analyzed = root.ZeeMLSchemaIntelligence.analyzeDatasetSchema(topDs.headers, topDs.rows, { cleanNumeric: true });
      csvPayload = root.ZeeMLFormatExporter.toCsv(analyzed);
      jsonPayload = root.ZeeMLFormatExporter.toJson(analyzed);
    }

    shadow.innerHTML = `
      <style>
        .zml-toast {
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: #0b1324;
          color: #f8fafc;
          border: 1px solid #10b981;
          border-radius: 12px;
          padding: 14px 16px;
          width: 340px;
          box-shadow: 0 16px 36px rgba(0,0,0,0.55);
        }
        .zml-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .zml-title { font-size: 13px; font-weight: 700; color: #6ee7b7; }
        .zml-close { background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 16px; }
        .zml-meta { font-size: 12px; color: #cbd5e1; margin-bottom: 10px; }
        .zml-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .zml-btn {
          background: #10b981; color: #042f2e; border: none; border-radius: 6px;
          padding: 6px 10px; font-size: 11.5px; font-weight: 700; cursor: pointer; text-decoration: none;
        }
        .zml-btn-sec { background: #1e293b; color: #e2e8f0; }
      </style>
      <div class="zml-toast">
        <div class="zml-hdr">
          <span class="zml-title">⚡ ZeeML Table &amp; JSON Harvester</span>
          <button class="zml-close" id="zml-close-btn" aria-label="Close">×</button>
        </div>
        <div class="zml-meta">
          ${hasData
            ? `Detected <strong>${harvested.datasets.length}</strong> dataset(s) in ${harvested.elapsedMs}ms.<br/>Top: <strong>${topDs.label}</strong> (${topDs.rows.length}×${topDs.headers.length})`
            : `No structured tables or repeating grids detected on this view.`}
        </div>
        <div class="zml-actions">
          ${hasData ? `
            <button class="zml-btn" id="zml-copy-csv">Copy Clean CSV</button>
            <button class="zml-btn zml-btn-sec" id="zml-copy-json">Copy JSON</button>
          ` : ''}
          <a class="zml-btn zml-btn-sec" href="https://zeeml.com/json-to-csv" target="_blank" rel="noopener noreferrer">Open ZeeML Workbench ↗</a>
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);

    shadow.getElementById('zml-close-btn').addEventListener('click', () => host.remove());
    if (hasData) {
      const csvBtn = shadow.getElementById('zml-copy-csv');
      csvBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(csvPayload);
        csvBtn.textContent = '✓ CSV Copied!';
      });
      const jsonBtn = shadow.getElementById('zml-copy-json');
      jsonBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(jsonPayload);
        jsonBtn.textContent = '✓ JSON Copied!';
      });
    }
    setTimeout(() => {
      if (host.isConnected) host.remove();
    }, 12000);
  }

  const api = {
    parseHtmlTableElement,
    discoverRepeatingGridDatasets,
    harvestEmbeddedJsonDatasets,
    harvestAllPageDatasets,
    showQuickExportToast
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ZeeMLDomHarvester = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
