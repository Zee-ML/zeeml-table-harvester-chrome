/**
 * ZeeML Schema Intelligence & Welford/IQR Statistical Anomaly Engine
 * Reference Specification: https://zeeml.com/json-to-csv & https://zeeml.com/percentage-calculator
 *
 * Features:
 * - Deterministic column header deduplication & SQL identifier normalization
 * - Leading-zero ZIP/ID guard (^0\d+$), phone guard, and accounting negative support
 * - Welford's 1-pass online algorithm for numerically stable Mean (μ) and Std Dev (σ)
 * - Typed Float64Array percentiles (Median P50, Q1 P25, Q3 P75) + Hybrid Z-Score / Tukey IQR Outlier Detection
 */
(function (root) {
  'use strict';

  const CURRENCY_RE = /^[\s$€£¥₹₩₿]*([+-]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\([$\s€£¥₹]*\d[\d,]*(?:\.\d+)?\))[\s$€£¥₹%KMBTkmbt]*$/;
  const LEADING_ZERO_ID_RE = /^0\d+$/;
  const PHONE_OR_ID_RE = /^(?:\+?\d{1,3}[-.\s]\d{2,4}[-.\s]\d{3,4}(?:[-.\s]\d{2,4})?|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
  const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
  const BOOL_SET = new Set(['true', 'false', 'yes', 'no']);

  const MULTIPLIERS = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

  function deduplicateHeaders(rawHeaders, colCount) {
    const seen = new Map();
    const cleanHeaders = [];
    const sqlIdentifiers = [];

    for (let i = 0; i < colCount; i++) {
      let base = String((rawHeaders && rawHeaders[i]) ?? '').replace(/\s+/g, ' ').trim();
      if (!base) base = `column_${i + 1}`;

      const lowerKey = base.toLowerCase();
      const count = (seen.get(lowerKey) || 0) + 1;
      seen.set(lowerKey, count);
      const uniqueName = count === 1 ? base : `${base}_${count}`;
      cleanHeaders.push(uniqueName);

      let sqlId = uniqueName
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (!sqlId || /^\d/.test(sqlId)) sqlId = `col_${sqlId || (i + 1)}`;
      sqlIdentifiers.push(sqlId);
    }
    return { headers: cleanHeaders, sqlIdentifiers };
  }

  /**
   * Parses a string into a finite number and unit classification without corrupting
   * leading-zero ZIP codes (02138), phone numbers, or semantic version strings (1.2.3).
   */
  function parseNumericToken(rawVal) {
    if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
      return { isNumeric: true, value: rawVal, subtype: 'numeric' };
    }
    const str = String(rawVal ?? '').trim();
    if (!str || str.length > 42) return { isNumeric: false, value: null, subtype: null };

    // Protect leading-zero codes (e.g. ZIP "02138", badge "0042") except "0" or "0.xxx"
    if (LEADING_ZERO_ID_RE.test(str)) {
      return { isNumeric: false, value: null, subtype: 'identifier' };
    }
    if (PHONE_OR_ID_RE.test(str)) {
      return { isNumeric: false, value: null, subtype: 'identifier' };
    }
    if (!CURRENCY_RE.test(str)) {
      return { isNumeric: false, value: null, subtype: null };
    }

    let isPercent = str.includes('%');
    let isCurrency = /[$€£¥₹₩₿]/.test(str);
    let isAccountingNeg = /^\(.*\)$/.test(str);

    // Check compact multiplier suffix (K, M, B, T)
    const suffixMatch = str.match(/([KMBTkmbt])\s*%?$/);
    const mult = suffixMatch ? MULTIPLIERS[suffixMatch[1].toLowerCase()] || 1 : 1;

    const cleaned = str
      .replace(/[$€£¥₹₩₿,%\s()KMBTkmbt]/g, '')
      .trim();

    if (!cleaned || cleaned === '+' || cleaned === '-' || cleaned === '.') {
      return { isNumeric: false, value: null, subtype: null };
    }
    // Reject multi-dot version strings like 1.10.2
    if ((cleaned.match(/\./g) || []).length > 1) {
      return { isNumeric: false, value: null, subtype: null };
    }

    let num = Number(cleaned);
    if (!Number.isFinite(num)) {
      return { isNumeric: false, value: null, subtype: null };
    }
    if (isAccountingNeg && num > 0) num = -num;
    num *= mult;

    const subtype = isCurrency ? 'currency' : (isPercent ? 'percentage' : 'numeric');
    return { isNumeric: true, value: num, subtype };
  }

  function computeQuantile(sortedFloat64, q) {
    const n = sortedFloat64.length;
    if (n === 0) return 0;
    if (n === 1) return sortedFloat64[0];
    const pos = (n - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (base + 1 < n) {
      return sortedFloat64[base] + rest * (sortedFloat64[base + 1] - sortedFloat64[base]);
    }
    return sortedFloat64[base];
  }

  /**
   * Analyzes a 2D table (headers + rows) and computes per-column schema types,
   * Welford online statistics, IQR fences, and cell-level outlier coordinates.
   */
  function analyzeDatasetSchema(rawHeaders, rows, options = {}) {
    const cleanNumeric = Boolean(options.cleanNumeric);
    const rowCount = Array.isArray(rows) ? rows.length : 0;
    let maxRowCols = Array.isArray(rawHeaders) ? rawHeaders.length : 0;
    for (let r = 0; r < rowCount; r++) {
      const len = Array.isArray(rows[r]) ? rows[r].length : 0;
      if (len > maxRowCols) maxRowCols = len;
    }
    const colCount = maxRowCols;

    const { headers, sqlIdentifiers } = deduplicateHeaders(rawHeaders, colCount);
    const columnSchemas = [];
    const outlierCells = new Map(); // key: `${rowIndex}:${colIndex}` -> { zScore, value, reason }
    const outlierRows = new Set();

    // Normalized rows copy when cleanNumeric is enabled
    const processedRows = rows.map(r => {
      const rowArr = new Array(colCount);
      for (let c = 0; c < colCount; c++) {
        rowArr[c] = r && r[c] !== undefined && r[c] !== null ? String(r[c]).trim() : '';
      }
      return rowArr;
    });

    for (let c = 0; c < colCount; c++) {
      let nonNullCount = 0;
      let numericCount = 0;
      let currencyVotes = 0;
      let percentVotes = 0;
      let dateVotes = 0;
      let urlVotes = 0;
      let boolVotes = 0;

      // Welford online state
      let wCount = 0;
      let wMean = 0;
      let wM2 = 0;
      let minVal = Infinity;
      let maxVal = -Infinity;
      let sumVal = 0;

      const numericValues = [];
      const numericRowIndices = [];
      const freqMap = new Map();

      for (let r = 0; r < rowCount; r++) {
        const cell = processedRows[r][c];
        if (!cell) continue;
        nonNullCount++;

        freqMap.set(cell, (freqMap.get(cell) || 0) + 1);

        const parsed = parseNumericToken(cell);
        if (parsed.isNumeric) {
          numericCount++;
          if (parsed.subtype === 'currency') currencyVotes++;
          if (parsed.subtype === 'percentage') percentVotes++;

          const x = parsed.value;
          numericValues.push(x);
          numericRowIndices.push(r);

          wCount++;
          const delta = x - wMean;
          wMean += delta / wCount;
          const delta2 = x - wMean;
          wM2 += delta * delta2;

          if (x < minVal) minVal = x;
          if (x > maxVal) maxVal = x;
          sumVal += x;

          if (cleanNumeric) {
            processedRows[r][c] = String(Number(x.toFixed(6)));
          }
          continue;
        }

        if (ISO_DATE_RE.test(cell)) dateVotes++;
        else if (URL_RE.test(cell)) urlVotes++;
        else if (BOOL_SET.has(cell.toLowerCase())) boolVotes++;
      }

      const nullCount = rowCount - nonNullCount;
      const nullRatio = rowCount > 0 ? nullCount / rowCount : 0;
      const isMostlyNumeric = nonNullCount > 0 && (numericCount / nonNullCount) >= 0.7;

      let inferredType = 'text';
      let sqlType = 'TEXT';

      if (isMostlyNumeric) {
        if (currencyVotes >= numericCount * 0.4) inferredType = 'currency';
        else if (percentVotes >= numericCount * 0.4) inferredType = 'percentage';
        else inferredType = 'numeric';
        sqlType = 'NUMERIC';
      } else if (nonNullCount > 0 && dateVotes / nonNullCount >= 0.7) {
        inferredType = 'date';
        sqlType = 'TIMESTAMPTZ';
      } else if (nonNullCount > 0 && urlVotes / nonNullCount >= 0.7) {
        inferredType = 'url';
        sqlType = 'TEXT';
      } else if (nonNullCount > 0 && boolVotes / nonNullCount >= 0.8) {
        inferredType = 'boolean';
        sqlType = 'BOOLEAN';
      } else if (nonNullCount > 0 && freqMap.size <= Math.max(12, Math.floor(nonNullCount * 0.35))) {
        inferredType = 'categorical';
        sqlType = 'TEXT';
      }

      let stats = null;
      let colOutlierCount = 0;

      if (isMostlyNumeric && wCount > 0) {
        const variance = wCount > 1 ? wM2 / (wCount - 1) : 0;
        const stdDev = Math.sqrt(Math.max(0, variance));

        const sorted = Float64Array.from(numericValues).sort();
        const median = computeQuantile(sorted, 0.5);
        const q1 = computeQuantile(sorted, 0.25);
        const q3 = computeQuantile(sorted, 0.75);
        const iqr = q3 - q1;

        const lowerFence = q1 - 1.5 * iqr;
        const upperFence = q3 + 1.5 * iqr;

        // Flag outliers via Hybrid Z-Score (|z| >= 2.0) OR Tukey IQR fence (when wCount >= 4)
        if (wCount >= 4) {
          for (let i = 0; i < numericValues.length; i++) {
            const val = numericValues[i];
            const rIdx = numericRowIndices[i];
            const zScore = stdDev > 1e-9 ? Math.abs(val - wMean) / stdDev : 0;
            const iqrOutlier = iqr > 1e-9 && (val < lowerFence || val > upperFence);
            const ExtremeDeviationFromMedian = iqr <= 1e-9 && Math.abs(val - median) > Math.max(1, Math.abs(median) * 0.5);

            if (zScore >= 2.0 || iqrOutlier || ExtremeDeviationFromMedian) {
              colOutlierCount++;
              outlierRows.add(rIdx);
              outlierCells.set(`${rIdx}:${c}`, {
                value: val,
                zScore: Number(zScore.toFixed(2)),
                reason: zScore >= 2.0 ? `Z=${zScore.toFixed(2)}σ` : 'IQR Anomaly'
              });
            }
          }
        }

        stats = {
          count: wCount,
          min: Number(minVal.toFixed(4)),
          max: Number(maxVal.toFixed(4)),
          sum: Number(sumVal.toFixed(4)),
          mean: Number(wMean.toFixed(4)),
          median: Number(median.toFixed(4)),
          stdDev: Number(stdDev.toFixed(4)),
          q1: Number(q1.toFixed(4)),
          q3: Number(q3.toFixed(4)),
          iqr: Number(iqr.toFixed(4)),
          outlierCount: colOutlierCount
        };
      }

      const topCategories = Array.from(freqMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([val, count]) => ({ value: val.slice(0, 36), count }));

      columnSchemas.push({
        index: c,
        name: headers[c],
        sqlIdentifier: sqlIdentifiers[c],
        type: inferredType,
        sqlType,
        nonNullCount,
        nullCount,
        nullPercentage: Number((nullRatio * 100).toFixed(1)),
        uniqueCount: freqMap.size,
        topCategories,
        stats
      });
    }

    return {
      headers,
      sqlIdentifiers,
      rows: processedRows,
      rowCount,
      colCount,
      columns: columnSchemas,
      outlierCellCount: outlierCells.size,
      outlierRowIndices: Array.from(outlierRows).sort((a, b) => a - b),
      outlierMap: Object.fromEntries(outlierCells.entries())
    };
  }

  const api = {
    deduplicateHeaders,
    parseNumericToken,
    analyzeDatasetSchema
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ZeeMLSchemaIntelligence = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
