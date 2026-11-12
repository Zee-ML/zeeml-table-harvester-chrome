/**
 * ZeeML Smart Table, Grid & JSON-to-CSV Studio — Popup Controller
 * Windowed Virtual Grid (50 rows/page) + Welford/IQR Telemetry + 5-Format Export Studio
 */
(function () {
  'use strict';

  const PAGE_SIZE = 50;

  const state = {
    pageTitle: 'Webpage Dataset',
    pageUrl: 'https://zeeml.com/json-to-csv',
    elapsedMs: 0,
    datasets: [],
    selectedDatasetIdx: 0,
    cleanNumeric: true,
    extractLinks: false,
    outliersOnly: false,
    currentPage: 0,
    activeFormat: 'csv',
    analyzed: null
  };

  const els = {
    scanSummary: document.getElementById('zml-scan-summary'),
    datasetSelect: document.getElementById('zml-dataset-select'),
    rescanBtn: document.getElementById('zml-rescan-btn'),
    toggleCleanNum: document.getElementById('zml-toggle-clean-num'),
    toggleLinks: document.getElementById('zml-toggle-links'),
    toggleOutliersOnly: document.getElementById('zml-toggle-outliers-only'),
    outlierFilterLabel: document.getElementById('zml-outlier-filter-label'),
    tabs: Array.from(document.querySelectorAll('.zml-tab')),
    panels: {
      grid: document.getElementById('zml-panel-grid'),
      telemetry: document.getElementById('zml-panel-telemetry'),
      export: document.getElementById('zml-panel-export')
    },
    gridDimensions: document.getElementById('zml-grid-dimensions'),
    prevPageBtn: document.getElementById('zml-prev-page'),
    nextPageBtn: document.getElementById('zml-next-page'),
    pageIndicator: document.getElementById('zml-page-indicator'),
    previewThead: document.getElementById('zml-preview-thead'),
    previewTbody: document.getElementById('zml-preview-tbody'),
    telemetryList: document.getElementById('zml-telemetry-list'),
    formatBtns: Array.from(document.querySelectorAll('.zml-fmt-btn')),
    exportPreview: document.getElementById('zml-export-preview'),
    quickCopyCsvBtn: document.getElementById('zml-quick-copy-csv'),
    downloadActiveBtn: document.getElementById('zml-download-active'),
    copyAiPackBtn: document.getElementById('zml-copy-ai-pack')
  };

  function getFallbackSampleDataset() {
    return {
      pageTitle: 'ZeeML Sample Financial & Performance Matrix',
      pageUrl: 'https://zeeml.com/json-to-csv',
      elapsedMs: 1.8,
      datasets: [
        {
          id: 'sample-1',
          sourceType: 'html-table',
          badge: 'Demo Table',
          label: 'SaaS Quarterly Revenue & Churn Telemetry (Demo)',
          headers: ['Segment', 'Q1 Revenue', 'Q2 Revenue', 'YoY Growth', 'Account ZIP'],
          rows: [
            ['Enterprise Core', '$142,500', '$168,200', '+18.0%', '02138'],
            ['Mid-Market AI', '$88,400', '$96,100', '+8.7%', '10001'],
            ['Developer Pro', '$64,200', '$71,500', '+11.4%', '94107'],
            ['Academic Labs', '$39,800', '$44,900', '+12.8%', '02139'],
            ['Anomaly Spike', '$985,000', '$1,120,000', '+94.5%', '07030'],
            ['Starter Self-Serve', '$29,100', '$31,400', '+7.9%', '78701']
          ]
        }
      ]
    };
  }

  async function scanActiveTab() {
    els.scanSummary.textContent = 'Scanning DOM tables, CSS Grids & JSON state...';
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.scripting) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id && tab.url && !/^(?:chrome|edge|about|chrome-extension):/i.test(tab.url)) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['engines/dom-harvester.js']
          });
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (extractLinksFlag) => {
              return window.ZeeMLDomHarvester.harvestAllPageDatasets({
                extractLinks: extractLinksFlag
              });
            },
            args: [state.extractLinks]
          });
          const res = results && results[0] && results[0].result;
          if (res && Array.isArray(res.datasets) && res.datasets.length > 0) {
            state.pageTitle = res.pageTitle;
            state.pageUrl = res.pageUrl;
            state.elapsedMs = res.elapsedMs;
            state.datasets = res.datasets;
            state.selectedDatasetIdx = 0;
            state.currentPage = 0;
            renderDatasetSelector();
            recomputeAndRender();
            return;
          }
        }
      }
    } catch (_) {
      // Fallback to demo dataset on restricted browser tabs (e.g. chrome://newtab)
    }

    const demo = getFallbackSampleDataset();
    state.pageTitle = demo.pageTitle;
    state.pageUrl = demo.pageUrl;
    state.elapsedMs = demo.elapsedMs;
    state.datasets = demo.datasets;
    state.selectedDatasetIdx = 0;
    state.currentPage = 0;
    renderDatasetSelector();
    recomputeAndRender();
  }

  function renderDatasetSelector() {
    els.datasetSelect.textContent = '';
    state.datasets.forEach((ds, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = `[${ds.badge}] ${ds.label} (${ds.rows.length}×${ds.headers.length})`;
      els.datasetSelect.appendChild(opt);
    });
    els.datasetSelect.value = String(state.selectedDatasetIdx);
    els.scanSummary.textContent = `Detected ${state.datasets.length} dataset(s) in ${state.elapsedMs}ms`;
  }

  function recomputeAndRender() {
    const ds = state.datasets[state.selectedDatasetIdx];
    if (!ds) return;

    state.analyzed = window.ZeeMLSchemaIntelligence.analyzeDatasetSchema(
      ds.headers,
      ds.rows,
      { cleanNumeric: state.cleanNumeric }
    );

    els.outlierFilterLabel.textContent = `Outliers Only (${state.analyzed.outlierCellCount})`;
    renderWindowedGrid();
    renderTelemetryCards();
    renderExportPayload();
  }

  function renderWindowedGrid() {
    const analyzed = state.analyzed;
    if (!analyzed) return;

    // Header row
    const trHead = document.createElement('tr');
    analyzed.columns.forEach(col => {
      const th = document.createElement('th');
      th.textContent = col.name;
      const tag = document.createElement('span');
      tag.className = 'zml-type-tag';
      tag.textContent = col.type.slice(0, 4);
      th.appendChild(tag);
      trHead.appendChild(th);
    });
    els.previewThead.textContent = '';
    els.previewThead.appendChild(trHead);

    // Filter rows if outliersOnly is checked
    const rowIndices = state.outliersOnly
      ? analyzed.outlierRowIndices
      : analyzed.rows.map((_, idx) => idx);

    const totalFiltered = rowIndices.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
    if (state.currentPage >= totalPages) state.currentPage = totalPages - 1;

    const start = state.currentPage * PAGE_SIZE;
    const pageIndices = rowIndices.slice(start, start + PAGE_SIZE);

    const frag = document.createDocumentFragment();
    for (const rIdx of pageIndices) {
      const row = analyzed.rows[rIdx];
      const tr = document.createElement('tr');
      for (let c = 0; c < analyzed.colCount; c++) {
        const td = document.createElement('td');
        const val = row[c] ?? '';
        td.textContent = val;
        const outlierInfo = analyzed.outlierMap[`${rIdx}:${c}`];
        if (outlierInfo) {
          td.className = 'zml-cell-outlier';
          td.title = `Statistical Anomaly (${outlierInfo.reason})`;
        } else if (val.length > 24) {
          td.title = val;
        }
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }

    els.previewTbody.textContent = '';
    els.previewTbody.appendChild(frag);

    els.gridDimensions.textContent = `${totalFiltered} of ${analyzed.rowCount} rows × ${analyzed.colCount} cols • ${analyzed.outlierCellCount} anomaly cells`;
    els.pageIndicator.textContent = `Page ${state.currentPage + 1} / ${totalPages}`;
    els.prevPageBtn.disabled = state.currentPage <= 0;
    els.nextPageBtn.disabled = state.currentPage + 1 >= totalPages;
  }

  function renderTelemetryCards() {
    const analyzed = state.analyzed;
    if (!analyzed) return;

    const frag = document.createDocumentFragment();
    analyzed.columns.forEach(col => {
      const card = document.createElement('div');
      card.className = 'zml-stat-card';

      const hdr = document.createElement('div');
      hdr.className = 'zml-stat-hdr';
      const titleSpan = document.createElement('span');
      titleSpan.textContent = `${col.name} (${col.type.toUpperCase()})`;
      const metaSpan = document.createElement('span');
      metaSpan.textContent = `${100 - col.nullPercentage}% filled • ${col.uniqueCount} unique`;
      hdr.appendChild(titleSpan);
      hdr.appendChild(metaSpan);

      const metrics = document.createElement('div');
      metrics.className = 'zml-stat-metrics';
      if (col.stats) {
        metrics.textContent = `Mean(μ): ${col.stats.mean} | Median: ${col.stats.median} | StdDev(σ): ${col.stats.stdDev} | Min..Max: [${col.stats.min} .. ${col.stats.max}] | Sum: ${col.stats.sum} | Outliers: ${col.stats.outlierCount}`;
      } else {
        const topStr = col.topCategories.map(t => `${t.value} (${t.count})`).join(', ');
        metrics.textContent = topStr ? `Top Values: ${topStr}` : 'No non-empty values';
      }

      card.appendChild(hdr);
      card.appendChild(metrics);
      frag.appendChild(card);
    });

    els.telemetryList.textContent = '';
    els.telemetryList.appendChild(frag);
  }

  function renderExportPayload() {
    if (!state.analyzed) return;
    const ds = state.datasets[state.selectedDatasetIdx];
    const exported = window.ZeeMLFormatExporter.exportDataset(state.analyzed, state.activeFormat, {
      pageTitle: ds ? ds.label : state.pageTitle,
      pageUrl: state.pageUrl,
      tableName: ds ? ds.label : 'zeeml_dataset'
    });
    els.exportPreview.value = exported.content;
  }

  function flashButtonFeedback(btn, message) {
    const orig = btn.textContent;
    btn.textContent = message;
    setTimeout(() => {
      btn.textContent = orig;
    }, 1400);
  }

  // Event Listeners
  els.datasetSelect.addEventListener('change', (e) => {
    state.selectedDatasetIdx = parseInt(e.target.value, 10) || 0;
    state.currentPage = 0;
    recomputeAndRender();
  });

  els.rescanBtn.addEventListener('click', () => scanActiveTab());

  els.toggleCleanNum.addEventListener('change', (e) => {
    state.cleanNumeric = e.target.checked;
    recomputeAndRender();
  });

  els.toggleLinks.addEventListener('change', (e) => {
    state.extractLinks = e.target.checked;
    scanActiveTab();
  });

  els.toggleOutliersOnly.addEventListener('change', (e) => {
    state.outliersOnly = e.target.checked;
    state.currentPage = 0;
    renderWindowedGrid();
  });

  els.prevPageBtn.addEventListener('click', () => {
    if (state.currentPage > 0) {
      state.currentPage--;
      renderWindowedGrid();
    }
  });

  els.nextPageBtn.addEventListener('click', () => {
    state.currentPage++;
    renderWindowedGrid();
  });

  els.tabs.forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const targetTab = tabBtn.getAttribute('data-tab');
      els.tabs.forEach(b => {
        const active = b === tabBtn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      Object.entries(els.panels).forEach(([key, panel]) => {
        panel.classList.toggle('is-active', key === targetTab);
      });
    });
  });

  els.formatBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeFormat = btn.getAttribute('data-format');
      els.formatBtns.forEach(b => b.classList.toggle('is-selected', b === btn));
      renderExportPayload();
    });
  });

  els.quickCopyCsvBtn.addEventListener('click', async () => {
    if (!state.analyzed) return;
    const csv = window.ZeeMLFormatExporter.toCsv(state.analyzed);
    await navigator.clipboard.writeText(csv);
    flashButtonFeedback(els.quickCopyCsvBtn, '✓ Clean CSV Copied!');
  });

  els.copyAiPackBtn.addEventListener('click', async () => {
    if (!state.analyzed) return;
    const ds = state.datasets[state.selectedDatasetIdx];
    const pack = window.ZeeMLFormatExporter.toAiPromptPack(state.analyzed, {
      pageTitle: ds ? ds.label : state.pageTitle,
      pageUrl: state.pageUrl
    });
    await navigator.clipboard.writeText(pack);
    flashButtonFeedback(els.copyAiPackBtn, '✓ AI Context Copied!');
  });

  els.downloadActiveBtn.addEventListener('click', () => {
    if (!state.analyzed) return;
    const ds = state.datasets[state.selectedDatasetIdx];
    const exported = window.ZeeMLFormatExporter.exportDataset(state.analyzed, state.activeFormat, {
      pageTitle: ds ? ds.label : state.pageTitle,
      pageUrl: state.pageUrl,
      tableName: ds ? ds.label : 'zeeml_dataset'
    });
    const blob = new Blob([exported.content], { type: exported.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug = (ds ? ds.label : 'zeeml-dataset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'zeeml-dataset';
    a.href = url;
    a.download = `${slug}.${exported.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    flashButtonFeedback(els.downloadActiveBtn, '✓ Downloaded!');
  });

  scanActiveTab();
})();
