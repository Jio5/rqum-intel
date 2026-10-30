// Reads player stats from a game screenshot, in the browser, with Tesseract.js.
// Only pre-fills the Add form: the person checks the values before saving.
(() => {
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  // Tesseract reads dark text on a light background best, at a decent size. The image is
  // read again with other settings while one of the four figures, the name or the time is
  // missing: each pass fills what the previous ones did not (tested on test/fixtures/).
  const PASSES = [
    { width: 3200, mode: 'invert' },
    { width: 3200, mode: 'threshold' },
    { width: 2000, mode: 'invert' },
    { width: 4400, mode: 'threshold' },
  ];
  const MIN_SCALE = 0.75;
  const MAX_SCALE = 5;

  // Game labels (see src/content/parsers.js) -> stat key. Every column is recognised, even
  // the ones not kept (see KEPT), so that each value of a row lands under the right label.
  // For every stat the LAST match on the screenshot wins.
  const LABELS = [
    ['total_offense', /total\s*off?en[sc]e/gi],
    ['total_defense', /total\s*def?en[sc]e/gi],
    ['spy_offense', /spy\s*off?en[sc]e/gi],
    ['spy_defense', /spy\s*def?en[sc]e/gi],
    ['gold_on_hand', /\bgold(?:\s*on\s*hand)?\b/gi],
    ['army', /\barmy(?:\s*size)?\b/gi],
    ['population', /\bpopulation\b/gi],
    ['level', /\blevel\b/gi],
    [null, /\brace\b/gi],
    [null, /\bclass\b/gi],
    [null, /\bfort(?:ress)?(?:\s*hp)?\b/gi],
    [null, /\bclan\b/gi],
    [null, /\bgold\s*in\s*bank\b/gi], // Resources row: must not be read as gold on hand
    [null, /\bcitizens\b/gi],
  ];
  // A figure as shown by the game: 1,234,567 / 1 234 567 / 1.2M / 850k. "?" = hidden.
  // Grouped thousands first, so "890,000 12" stops at 890,000.
  const NUMBER = /(\d{1,3}(?:[,.' ]\d{3})+(?!\d)|\d+(?:[.,]\d+)?)\s?([kmb])?(?![a-z])/i;
  // One cell of a row of values ("119,620 1.46M", "35 Goblin", "1,335/1,850", "?").
  // No space inside a figure here: "368,877 410,662" are two cells, not one number.
  const CELL = /\?+|\d{1,3}(?:[,.']\d{3})+(?:\/[\d,.']+)?(?!\d)|\d+(?:[.,]\d+)?[kmb]?(?:\/[\d,.']+)?(?![a-z\d])|[a-z][\w'-]*/gi;
  // The attacker's own figures in a spy report's header ("Your Spy Offense: 458,432"),
  // at the start of a line or in the middle of it: never the target's.
  const MINE = /\byour\s*$/i;
  // "Intelligence Report: Golden", or else "Intel gathered successfully - Golden!".
  const REPORT_NAMES = [
    /intelligence\s+report\s*[:;]\s*(.+)$/i,
    /intel\s+gathered\s+successfully\s*[-–—]\s*(.+?)\s*!?$/i,
  ];
  // "DATE: Oct 22, 2026 12:37am" (the game's report header).
  const REPORT_DATE = /\bdate\b\W*([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([ap]\.?m)?/i;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  // What a screenshot fills in: only the four combat figures (with the target and the
  // report's time). The other columns are still read, to keep the values aligned.
  const KEPT = new Set(['total_offense', 'total_defense', 'spy_offense', 'spy_defense']);

  let workerPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the text reader (check the connection).'));
      document.head.appendChild(s);
    });
  }

  // Loaded on first use only (several MB): the rest of the page never waits for it.
  function getWorker() {
    workerPromise ??= (async () => {
      if (!window.Tesseract) await loadScript(TESSERACT_URL);
      return Tesseract.createWorker('eng');
    })().catch((err) => { workerPromise = null; throw err; });
    return workerPromise;
  }

  async function loadImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Otsu's method: the gray level that best separates text from background.
  function otsu(hist, count) {
    let total = 0;
    for (let k = 0; k < 256; k++) total += k * hist[k];
    let sumBack = 0, weightBack = 0, best = 0, threshold = 128;
    for (let k = 0; k < 256; k++) {
      weightBack += hist[k];
      if (!weightBack) continue;
      const weightFore = count - weightBack;
      if (!weightFore) break;
      sumBack += k * hist[k];
      const between = weightBack * weightFore * (sumBack / weightBack - (total - sumBack) / weightFore) ** 2;
      if (between > best) { best = between; threshold = k; }
    }
    return threshold;
  }

  // Grayscale, resized to `width`, made dark-on-light (the game's theme is light-on-dark):
  // 'invert' keeps the gray levels, 'threshold' turns it into pure black and white, which
  // helps with light text on the coloured cards (red offense, blue defense).
  function prepare(img, { width, mode }) {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, width / img.naturalWidth));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = pixels.data;
    const hist = new Array(256).fill(0);
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      d[i] = g;
      hist[g]++;
      sum += g;
    }
    const count = d.length / 4;
    const dark = sum / count < 128;
    const t = mode === 'threshold' ? otsu(hist, count) : 0;
    for (let i = 0; i < d.length; i += 4) {
      let g = d[i];
      if (mode === 'threshold') g = (dark ? g > t : g < t) ? 0 : 255;
      else if (dark) g = 255 - g;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas;
  }

  // First figure in a piece of text, or null ("?" and text-only values give null).
  function firstNumber(text) {
    const m = String(text).match(NUMBER);
    return m ? RQUM.parseAmount(`${m[1]}${m[2] || ''}`) : null;
  }

  // Every label of a line, left to right: [{ key, start, end }]. "Total Defense" is one
  // label (the longest match wins where two overlap).
  function labelsIn(line) {
    const found = [];
    for (const [key, re] of LABELS) {
      for (const m of line.matchAll(re)) {
        const mine = MINE.test(line.slice(0, m.index));
        found.push({ key: mine ? null : key, start: m.index, end: m.index + m[0].length });
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    return found.filter((f, i) => !found.slice(0, i).some((g) => f.start < g.end));
  }

  // A cell of a values row -> number, or null (hidden "?", or a word like "Goblin").
  function cellValue(cell) {
    if (!/^\d/.test(cell)) return null;
    return RQUM.parseAmount(cell.split('/')[0]);
  }

  // Three layouts, as the game shows them:
  //   "Total Defense 890,000"                    label and value on one line
  //   "Total Defense" / "890,000"                value on the next line
  //   "TOTAL OFFENSE TOTAL DEFENSE" / "119,620 1.46M"   a row of labels, then a row of values
  function statsFromText(text) {
    const lines = text.split('\n')
      .map((l) => l.replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const stats = {};
    const keep = (key, value) => { if (KEPT.has(key) && value !== null && value !== undefined) stats[key] = value; };

    lines.forEach((line, i) => {
      const labels = labelsIn(line);
      if (!labels.length) return;
      // The text after each label, up to the next one.
      const segments = labels.map((l, j) => line.slice(l.end, labels[j + 1] ? labels[j + 1].start : undefined));
      const sameLine = segments.map((s) => (/^\W*\?/.test(s) ? null : firstNumber(s)));

      if (sameLine.some((v) => v !== null)) {
        labels.forEach((l, j) => keep(l.key, sameLine[j]));
        return;
      }
      const next = lines[i + 1] || '';
      if (labelsIn(next).length) return; // the next line is labels again, not values
      if (labels.length === 1 && !segments[0].trim()) return keep(labels[0].key, firstNumber(next));
      // A header row: one column per label, and one per word the OCR did not recognise as
      // a label ("cass" for CLASS), so that the values below still line up.
      const columns = [];
      let pos = 0;
      for (const l of labels) {
        (line.slice(pos, l.start).match(/[a-z]{2,}/gi) || []).forEach(() => columns.push(null));
        columns.push(l.key);
        pos = l.end;
      }
      (line.slice(pos).match(/[a-z]{2,}/gi) || []).forEach(() => columns.push(null));
      const cells = next.match(CELL) || [];
      if (cells.length === columns.length) columns.forEach((key, j) => keep(key, cellValue(cells[j])));
    });
    return stats;
  }

  // The target's name (the OCR may give it in capitals: the search ignores case).
  function playerFromText(text) {
    const lines = text.split('\n').map((l) => l.trim());
    for (const re of REPORT_NAMES) {
      for (const line of lines) {
        const m = line.match(re);
        const name = m && m[1].replace(/[^\w .'-]+$/, '').trim();
        if (name) return name;
      }
    }
    return null;
  }

  // The report's own date, read as local time; null when absent or in the future.
  function dateFromText(text) {
    const m = text.match(REPORT_DATE);
    if (!m) return null;
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    // A misread time ("12:77am") gives no date rather than a wrong one.
    if (month < 0 || Number(m[5]) > 59 || Number(m[4]) > (m[6] ? 12 : 23) || Number(m[2]) > 31) return null;
    let hours = Number(m[4]) % 12;
    if (!m[6]) hours = Number(m[4]); // 24-hour clock
    else if (/^p/i.test(m[6])) hours += 12;
    const date = new Date(Number(m[3]), month, Number(m[2]), hours, Number(m[5]));
    return Number.isNaN(date.getTime()) || date > new Date() ? null : date;
  }

  // -> { stats: { key: number }, player: name or null, seenAt: Date or null, text: what was read }
  // Each pass only fills what the earlier ones left empty.
  RQUM.readScreenshot = async (file, onProgress = () => {}) => {
    onProgress('Loading the text reader…');
    const worker = await getWorker();
    const img = await loadImage(file);
    const result = { stats: {}, player: null, seenAt: null, text: '' };
    const complete = () => KEPT.size === Object.keys(result.stats).length && result.player && result.seenAt;
    for (const [n, pass] of PASSES.entries()) {
      onProgress(n ? `Reading the screenshot again (pass ${n + 1} of ${PASSES.length})…` : 'Reading the screenshot…');
      const { data } = await worker.recognize(prepare(img, pass));
      result.stats = { ...statsFromText(data.text), ...result.stats };
      result.player ??= playerFromText(data.text);
      result.seenAt ??= dateFromText(data.text);
      result.text ||= data.text;
      if (complete()) break;
    }
    return result;
  };
  // For tests.
  RQUM.statsFromText = statsFromText;
  RQUM.playerFromText = playerFromText;
  RQUM.dateFromText = dateFromText;
})();
