/**
 * ZeeML 5-Format Data Export Studio
 * Reference Specification: https://zeeml.com/json-to-csv
 *
 * Formats Supported:
 * 1. RFC-4180 CSV (with Context-Aware Formula Injection Guard + optional UTF-8 BOM)
 * 2. JSON (Records Array, Columnar Arrays, or Relational Schema Bundle)
 * 3. GitHub Markdown Table (with type-aware column alignment :--- / ---:)
 * 4. SQL DDL + Batched INSERT statements (quoted identifiers, 500 rows/batch)
 * 5. AI Prompt Context Pack (Dimensions + Schema & Welford/IQR Digest + Outliers + Markdown Table)
 */
(function (root) {
  'use strict';

  const DANGEROUS_FORMULA_PREFIX_RE = /^[=+\-@]/;
  const VALID_SIGNED_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i;

  /**
   * Neutralizes Spreadsheet Formula Injection (DDE / =CMD|...) while keeping
   * legitimate negative numbers (-14.2, -500) intact as numbers.
   */
  function guardFormulaInjection(valStr) {
    const str = String(valStr ?? '');
    if (!str) return '';
    const trimmed = str.trimStart();
    if (DANGEROUS_FORMULA_PREFIX_RE.test(trimmed) && !VALID_SIGNED_NUMBER_RE.test(trimmed)) {
      return `'${str}`;
    }
    if (/^[\t\r]/.test(str)) {
      return `'${str}`;
    }
    return str;
  }

  function escapeCsvCell(rawVal, safeFormulas = true) {
    const str = safeFormulas ? guardFormulaInjection(rawVal) : String(rawVal ?? '');
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function toCsv(analyzed, options = {}) {
    const includeBom = options.includeBom !== false;
    const safeFormulas = options.safeFormulas !== false;
    const delimiter = options.delimiter || ',';

    const lines = [];
    lines.push(analyzed.headers.map(h => escapeCsvCell(h, safeFormulas)).join(delimiter));
    for (const row of analyzed.rows) {
      lines.push(row.map(cell => escapeCsvCell(cell, safeFormulas)).join(delimiter));
    }
    const body = lines.join('\r\n');
    return includeBom ? `\uFEFF${body}` : body;
  }

  function coerceValueBySchema(cellStr, colSchema) {
    if (cellStr === '' || cellStr === null || cellStr === undefined) return null;
    if (!colSchema) return cellStr;
    if (colSchema.type === 'numeric' || colSchema.type === 'currency' || colSchema.type === 'percentage') {
      const cleaned = String(cellStr).replace(/[$€£¥₹₩₿,%\s]/g, '');
      const num = Number(cleaned);
      if (Number.isFinite(num)) return num;
    }
    if (colSchema.type === 'boolean') {
      const low = String(cellStr).toLowerCase();
      if (low === 'true' || low === 'yes') return true;
      if (low === 'false' || low === 'no') return false;
    }
    return cellStr;
  }

  function toJson(analyzed, options = {}) {
    const mode = options.jsonMode || 'records'; // 'records' | 'columnar' | 'schema-bundle'
    const typed = options.typed !== false;

    if (mode === 'columnar') {
      const cols = Object.create(null);
      analyzed.columns.forEach((col, cIdx) => {
        Object.defineProperty(cols, col.name, {
          value: analyzed.rows.map(r => (typed ? coerceValueBySchema(r[cIdx], col) : r[cIdx])),
          enumerable: true,
          configurable: true,
          writable: true
        });
      });
      return JSON.stringify(cols, null, 2);
    }

    const records = analyzed.rows.map(row => {
      const obj = Object.create(null);
      analyzed.columns.forEach((col, cIdx) => {
        Object.defineProperty(obj, col.name, {
          value: typed ? coerceValueBySchema(row[cIdx], col) : row[cIdx],
          enumerable: true,
          configurable: true,
          writable: true
        });
      });
      return obj;
    });

    if (mode === 'schema-bundle') {
      return JSON.stringify({
        generator: 'ZeeML Smart Table & JSON-to-CSV Studio (https://zeeml.com/json-to-csv)',
        rowCount: analyzed.rowCount,
        columnCount: analyzed.colCount,
        outlierCount: analyzed.outlierCellCount,
        schema: analyzed.columns.map(c => ({
          name: c.name,
          type: c.type,
          nullPercentage: c.nullPercentage,
          uniqueCount: c.uniqueCount,
          stats: c.stats
        })),
        data: records
      }, null, 2);
    }

    return JSON.stringify(records, null, 2);
  }

  function escapeMarkdownCell(val) {
    return String(val ?? '')
      .replace(/\r?\n/g, ' ')
      .replace(/\|/g, '\\|')
      .trim();
  }

  function toMarkdownTable(analyzed, options = {}) {
    const maxRows = options.maxRows || analyzed.rows.length;
    const sliceRows = analyzed.rows.slice(0, maxRows);

    const headerRow = `| ${analyzed.headers.map(escapeMarkdownCell).join(' | ')} |`;
    const alignRow = `| ${analyzed.columns.map(col => {
      const isNum = col.type === 'numeric' || col.type === 'currency' || col.type === 'percentage';
      return isNum ? '---:' : ':---';
    }).join(' | ')} |`;

    const bodyRows = sliceRows.map(row => `| ${row.map(escapeMarkdownCell).join(' | ')} |`);
    return [headerRow, alignRow, ...bodyRows].join('\n');
  }

  function escapeSqlLiteral(cellStr, colSchema) {
    if (cellStr === '' || cellStr === null || cellStr === undefined) return 'NULL';
    if (colSchema && colSchema.sqlType === 'NUMERIC') {
      const cleaned = String(cellStr).replace(/[$€£¥₹₩₿,%\s]/g, '');
      const num = Number(cleaned);
      if (Number.isFinite(num)) return String(num);
    }
    if (colSchema && colSchema.sqlType === 'BOOLEAN') {
      const low = String(cellStr).toLowerCase();
      if (low === 'true' || low === 'yes') return 'TRUE';
      if (low === 'false' || low === 'no') return 'FALSE';
    }
    return `'${String(cellStr).replace(/'/g, "''")}'`;
  }

  function toSql(analyzed, options = {}) {
    const rawTableName = String(options.tableName || 'zeeml_harvested_dataset')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'zeeml_harvested_dataset';

    const quotedCols = analyzed.columns.map(c => `"${c.sqlIdentifier}"`);
    const colDefs = analyzed.columns.map(c => `  "${c.sqlIdentifier}" ${c.sqlType}`);

    const statements = [
      `-- Generated by ZeeML Smart Table & JSON-to-CSV Studio (https://zeeml.com/json-to-csv)`,
      `CREATE TABLE IF NOT EXISTS "${rawTableName}" (\n${colDefs.join(',\n')}\n);`
    ];

    const batchSize = 500;
    for (let i = 0; i < analyzed.rows.length; i += batchSize) {
      const batch = analyzed.rows.slice(i, i + batchSize);
      const valueTuples = batch.map(row => {
        const vals = analyzed.columns.map((col, cIdx) => escapeSqlLiteral(row[cIdx], col));
        return `  (${vals.join(', ')})`;
      });
      statements.push(
        `\nINSERT INTO "${rawTableName}" (${quotedCols.join(', ')})\nVALUES\n${valueTuples.join(',\n')};`
      );
    }

    return statements.join('\n');
  }

  function toAiPromptPack(analyzed, options = {}) {
    const title = options.pageTitle || 'Extracted Webpage Dataset';
    const sourceUrl = options.pageUrl || 'https://zeeml.com/json-to-csv';
    const maxPreviewRows = options.maxRows || Math.min(analyzed.rowCount, 150);

    const schemaLines = analyzed.columns.map(col => {
      if (col.stats) {
        return `- **${col.name}** (\`${col.type}\`): Mean=${col.stats.mean}, Median=${col.stats.median}, StdDev(σ)=${col.stats.stdDev}, Range=[${col.stats.min} .. ${col.stats.max}], Sum=${col.stats.sum}, Outliers=${col.stats.outlierCount}`;
      }
      const topVals = col.topCategories.map(t => `"${t.value}" (${t.count})`).join(', ');
      return `- **${col.name}** (\`${col.type}\`): ${col.uniqueCount} unique values, ${col.nullPercentage}% null${topVals ? `, Top=[${topVals}]` : ''}`;
    });

    const outlierSummary = [];
    for (const [key, meta] of Object.entries(analyzed.outlierMap || {})) {
      const [rIdx, cIdx] = key.split(':').map(Number);
      const colName = analyzed.headers[cIdx] || `Col ${cIdx + 1}`;
      outlierSummary.push(`- Row ${rIdx + 1}, Column **${colName}**: \`${meta.value}\` (${meta.reason})`);
      if (outlierSummary.length >= 12) break;
    }

    const mdTable = toMarkdownTable(analyzed, { maxRows: maxPreviewRows });

    return [
      `# AI Data Context Pack — ${title}`,
      `> Harvested via **ZeeML Smart Table, Grid & JSON-to-CSV Studio** (https://zeeml.com/json-to-csv)`,
      `> Source Context: ${sourceUrl} | Dimensions: ${analyzed.rowCount} rows × ${analyzed.colCount} columns | Statistical Anomalies Flagged: ${analyzed.outlierCellCount}`,
      ``,
      `## 1. Inferred Column Schema & Statistical Telemetry`,
      ...schemaLines,
      ``,
      ...(outlierSummary.length > 0 ? [
        `## 2. Flagged Statistical Outliers (|Z| >= 2.0σ or Tukey IQR Fence)`,
        ...outlierSummary,
        ``
      ] : []),
      `## ${outlierSummary.length > 0 ? '3' : '2'}. Structured Dataset (${maxPreviewRows < analyzed.rowCount ? `First ${maxPreviewRows} of ${analyzed.rowCount} rows` : `All ${analyzed.rowCount} rows`})`,
      mdTable
    ].join('\n');
  }

  function exportDataset(analyzed, format, options = {}) {
    switch (format) {
      case 'csv':
        return { content: toCsv(analyzed, options), mime: 'text/csv;charset=utf-8', ext: 'csv' };
      case 'json':
        return { content: toJson(analyzed, options), mime: 'application/json;charset=utf-8', ext: 'json' };
      case 'markdown':
        return { content: toMarkdownTable(analyzed, options), mime: 'text/markdown;charset=utf-8', ext: 'md' };
      case 'sql':
        return { content: toSql(analyzed, options), mime: 'application/sql;charset=utf-8', ext: 'sql' };
      case 'ai-prompt':
        return { content: toAiPromptPack(analyzed, options), mime: 'text/markdown;charset=utf-8', ext: 'prompt.md' };
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  const api = {
    guardFormulaInjection,
    escapeCsvCell,
    toCsv,
    toJson,
    toMarkdownTable,
    toSql,
    toAiPromptPack,
    exportDataset
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ZeeMLFormatExporter = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
