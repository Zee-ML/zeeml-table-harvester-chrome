# ZeeML Smart Table, Grid & JSON-to-CSV Studio (Chrome Extension - Manifest V3)

> **Install from Chrome Web Store:** [ZeeML Smart Table, Grid & JSON-to-CSV Studio (`pdgelpgfjakiikgihmdbgngkhejlkibn`)](https://chromewebstore.google.com/detail/zeeml-smart-table-grid-js/pdgelpgfjakiikgihmdbgngkhejlkibn)
> **Official Web Workbench:** [https://zeeml.com/json-to-csv](https://zeeml.com/json-to-csv)
> **Companion Quantitative Calculators:** [Percentage & Margin Calculator (`zeeml.com/percentage-calculator`)](https://zeeml.com/percentage-calculator) • [Lexical Density Counter (`zeeml.com/word-counter`)](https://zeeml.com/word-counter) • [All ZeeML Utilities (`zeeml.com/tools`)](https://zeeml.com/tools)

**ZeeML Smart Table, Grid & JSON-to-CSV Studio** is a zero-dependency, 100% client-side Manifest V3 Chromium extension that extracts classic HTML `<table>` elements, modern CSS Flexbox/Grid repeating card layouts, and embedded page JSON (`application/ld+json`, `__NEXT_DATA__`) into clean **RFC-4180 CSV**, **JSON**, **GitHub Markdown Tables**, **SQL (`CREATE TABLE + INSERT`)**, and **AI Prompt Context Packs**.

---

## ✨ Key Engineering Capabilities

1. **Tri-Modal DOM & State Harvesting (`dom-harvester.js`):**
   - **HTML `<table>` Matrix Normalization:** Expands merged `colspan` and `rowspan` cells into strict rectangular grids and optionally extracts embedded `<a href>` URLs as dedicated columns.
   - **Zero-Reflow $O(N)$ CSS Grid & Card Detector:** Discovers repeating Flexbox/Grid card lists (`[role="grid"]`, product cards, pricing tiers) using single-pass depth-2 structural signature hashing capped at a hard **45ms time budget**.
   - **Recursive Root Traversal:** Inspects open Shadow DOM roots (`el.shadowRoot`) and accessible same-origin `<iframe>` documents.
   - **Structured JSON State Harvester:** Automatically flattens nested `application/ld+json` and hydration JSON arrays into relational columns.

2. **Local Schema Inference & Welford/IQR Anomaly Telemetry (`schema-intelligence.js`):**
   - Automatically classifies columns (`Currency`, `Percentage`, `Numeric`, `ISO Date`, `URL`, `Boolean`, `Categorical`).
   - **Leading-Zero & Identifier Protection:** Preserves leading-zero ZIP codes (`02138`), phone numbers, and UUIDs without corrupting them into floats.
   - **Welford's 1-Pass Online Algorithm + Tukey IQR Fence:** Computes numerically stable `Mean (μ)`, `Median (P50)`, `Std Dev (σ)`, `Min..Max`, and `Sum`, flagging statistical anomalies where $\lvert z\rvert \ge 2.0$ **or** outside $[Q_1 - 1.5\cdot\text{IQR},\; Q_3 + 1.5\cdot\text{IQR}]$.

3. **5-Format Export Studio (`format-exporter.js`):**
   - **RFC-4180 CSV:** Includes UTF-8 BOM for Excel and a **Context-Aware Formula Injection Guard** that neutralizes spreadsheet DDE payloads (`=CMD|...`) while keeping negative numbers (`-14.2%`) numeric.
   - **JSON:** Records array, columnar arrays, or full schema + telemetry bundle.
   - **GitHub Markdown Table:** Auto-aligns numeric columns right (`---:`) and text columns left (`:---`).
   - **SQL (`CREATE TABLE` + Batched `INSERT INTO`):** Quotes SQL identifiers and deduplicates colliding column names (`price`, `price_2`).
   - **AI Prompt Context Pack:** Generates a structured Markdown prompt combining dataset dimensions, inferred column schemas, Welford/IQR statistical summaries, flagged anomalies, and the cleaned table.

---

## 🔒 Privacy & Least-Privilege Architecture

- **100% Local Execution:** All DOM parsing, schema inference, and file generation run locally inside your browser. Zero webpage data is ever transmitted to any external server.
- **Minimal Permissions:** Uses only `activeTab`, `scripting`, `contextMenus`, and `storage`—invoked strictly when you click the toolbar icon (`Alt+Shift+T`) or select **"Harvest Table, Grid or JSON with ZeeML"** from the context menu.

---

## 🔗 Official ZeeML Web Workbenches

- **JSON to CSV Relational Flattener:** [https://zeeml.com/json-to-csv](https://zeeml.com/json-to-csv)
- **Percentage, Margin & Delta Calculator:** [https://zeeml.com/percentage-calculator](https://zeeml.com/percentage-calculator)
- **Global CGPA & GPA Scale Calculator:** [https://zeeml.com/cgpa-calculator](https://zeeml.com/cgpa-calculator)
- **AI Text Humanizer & Cadence Rebalancer:** [https://zeeml.com/ai-humanizer](https://zeeml.com/ai-humanizer)
- **Word Counter & Lexical Density Studio:** [https://zeeml.com/word-counter](https://zeeml.com/word-counter)
- **Complete Tool Directory:** [https://zeeml.com/tools](https://zeeml.com/tools)

## 📄 License

Released under the [MIT License](./LICENSE). Maintained by **[@Zee-ML](https://github.com/Zee-ML)** ([https://zeeml.com](https://zeeml.com)).
