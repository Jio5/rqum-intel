// Collects every player stat visible on a darkthronegame.com page.
// Selectors come from the DarkThrone Enhancer extension (DarkThrone\darkthrone-extension),
// which reads the same pages. Each source returns "observations":
//   { player_id, player_name, observed_at, source, stats: { key: value } }
// Only values actually shown are included: hidden figures ("?") are left out, so a
// partial capture never erases what an earlier one revealed.
(() => {
  // Only a profile link itself: not /game/player/{id}/friends and other sub-pages.
  const PLAYER_HREF = /\/game\/player\/(\d+)\/?(?:[?#]|$)/;
  // Elements injected or reworked by DarkThrone Enhancer (qal-*, and the dashboard rows
  // .dash-qa-row: the game's Quick Attack, which Enhancer rewrites, and Enhancer's own
  // lists built with the same classes). Not read as game data.
  const FOREIGN = '[id^="qal-"], [class*="qal-"], .dash-qa-row';

  // Stats never stored, whatever the page shows them on.
  // (Race and class are kept: shown at the top of the card, a change stands out.)
  const IGNORED_STATS = new Set(['fort_hp', 'fortress', 'clan_tag']);

  // List columns worth keeping, by header label -> stat key (same keys as the profile).
  const LIST_COLUMNS = {
    level: 'level',
    gold: 'gold_on_hand',
    'gold on hand': 'gold_on_hand',
    army: 'army',
    'army size': 'army',
    population: 'population',
    clan: 'clan',
  };
  // Row attributes holding exact values (Attack page: data-gold="287967").
  // data-fort: the fort's health in % (fort_pct, the Fort alert of the RQUM window).
  const ROW_ATTRIBUTES = { 'data-level': 'level', 'data-gold': 'gold_on_hand', 'data-fort': 'fort_pct' };
  // Leaderboard card title -> stat key (global, all-time view only).
  // Leaderboard card title -> rank key: Global, Combat and Economy categories (All-Time).
  const RANK_CARDS = {
    'overall power': 'rank_overall', offense: 'rank_offense', defense: 'rank_defense', level: 'rank_level',
    'attack wins': 'rank_attack_wins', 'total kills': 'rank_total_kills', 'defense wins': 'rank_defense_wins',
    'gold stolen': 'rank_gold_stolen', 'fort damage': 'rank_fort_damage',
    'richest banked': 'rank_richest', 'net worth': 'rank_net_worth', 'gold spent': 'rank_gold_spent',
  };
  const rankCardKey = (card) => RANK_CARDS[txt(card.querySelector('h3, .card-header')).replace(/[^\p{L} ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase()];

  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  function playerIdFromUrl(url) {
    const m = String(url || '').match(PLAYER_HREF);
    return m ? m[1] : null;
  }

  // The logged-in player (header link): never stored as a target.
  // On a phone the header's name link may be missing: then my own profile ("(You)"), a link
  // marked "(You)", or the id seen last time in this browser.
  function myPlayerId(doc) {
    const MY_ID_KEY = 'rqumMyPlayerId';
    let id = playerIdFromUrl(doc.querySelector('.game-header .user-name, a.user-name')?.getAttribute('href'));
    if (!id && /\(You\)/i.test(txt(doc.querySelector('.profile-title h2')))) id = playerIdFromUrl(doc.location?.pathname || '');
    if (!id) id = playerIdFromUrl([...doc.querySelectorAll('a[href*="/game/player/"]')].find((a) => /\(You\)/i.test(txt(a)))?.getAttribute('href'));
    try {
      if (id) localStorage.setItem(MY_ID_KEY, id);
      else id = localStorage.getItem(MY_ID_KEY) || null;
    } catch (_) { /* storage blocked */ }
    return id;
  }

  // A player link's text without avatar placeholder, clan badge and "(You)", nor the marks
  // shown after names: the game's gold protection badge after a tick ("🛡 12,345"), its 🎯,
  // or what other scripts add.
  function playerName(link) {
    if (!link) return null;
    const clone = link.cloneNode(true);
    clone.querySelectorAll('img, .player-avatar-placeholder-sm, .clan-badge, .friend-badge, .gold-protection-badge, [data-dtg-defense], [data-dtg-clan], [class*="dtg-"]').forEach((n) => n.remove());
    return txt(clone).replace(/\s*\(You\)$/, '')
      .replace(/\s*🛡.*$/u, '') // the gold badge, its figure and countdown
      .replace(/^[👤▾▸▼►\s]+/u, '') // the header's icon, a menu's arrow ("▾ Rage")
      .replace(/[\s🎯️]+$/u, '')
      .slice(0, 60) || null;
  }

  function normKey(k) {
    return String(k).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  // Exact value of a stat element: the game puts full numbers in data-full
  // (e.g. "1.2M" displayed, data-full="1234567"). null = hidden / unknown.
  function valueOf(el) {
    if (!el || el.classList.contains('stat-hidden')) return null;
    const full = el.matches('[data-full]') ? el : el.querySelector('[data-full]');
    return parseValue(full ? full.getAttribute('data-full') : txt(el));
  }

  function parseValue(raw) {
    raw = String(raw ?? '').trim();
    const compact = raw.replace(/[\s,]/g, '');
    if (/^-?\d+(?:\.\d+)?$/.test(compact)) return Number(compact);
    if (!raw || /^[?—-]+$|^unknown$|^hidden$/i.test(raw)) return null;
    return raw.slice(0, 80);
  }

  function put(stats, key, value) {
    key = normKey(key);
    // fort_hp_69_4: a profile label holding the fort's % ("Fort HP 69.4%"); fort_pct keeps it.
    if (!key || IGNORED_STATS.has(key) || key.startsWith('fort_hp') || value === null || value === undefined || key in stats) return;
    stats[key] = value;
  }

  function observation(id, name, source, stats, observedAt = null) {
    return { player_id: id, player_name: name, observed_at: observedAt, source, stats };
  }

  // ---- Player profile: /game/player/{id} -----------------------------------
  // Only .profile-stats-table: the page header also has .stats-cell (my own gold...).
  function fromProfile(doc, loc) {
    const page = doc.querySelector('.player-profile-page');
    const id = playerIdFromUrl(loc.pathname);
    if (!page || !id) return [];

    const stats = {};
    page.querySelectorAll('.profile-stats-table .stats-cell').forEach((cell) => {
      const label = txt(cell.querySelector('.stat-label'));
      if (!label || /^alignment$/i.test(label)) return; // a slider, not a value
      put(stats, label, valueOf(cell.querySelector('.stat-value')) ?? parseValue(txt(cell).replace(label, '')));
    });
    page.querySelectorAll('.rank-display .rank-item').forEach((item) => {
      const label = txt(item.querySelector('.rank-label'));
      const m = txt(item.querySelector('.rank-value')).match(/#(\d+)/);
      if (label && m) put(stats, `rank ${label}`, Number(m[1]));
    });
    // "Fort HP 0 / 1,850 (0%)": only the % is kept.
    const fort = parseValue(txt(page.querySelector('.fort-hp-bar [data-pf-pct]')));
    if (typeof fort === 'number') put(stats, 'fort_pct', fort);
    return [observation(id, txt(page.querySelector('.profile-title h2')).slice(0, 60) || null, 'profile', stats)];
  }

  // ---- Spy report: /game/spy/log/{id} --------------------------------------
  // Sections (.intel-section > h3) of .intel-item label/value pairs. Sabotage /
  // assassination reports reuse the page without figures: they yield no stats.
  // ---- Spy caught: /game/spy/log/{id}, an enemy op we repelled -------------
  // "Spy Caught: Deadly": the report names the enemy (.report-caught-spy) and gives
  // "Attacker's spy offense: 111,012" in its header, plus their level.
  function fromCaughtSpy(doc) {
    const page = doc.querySelector('.intel-report-page');
    const box = page?.querySelector('.report-caught-spy');
    if (!box) return [];
    const link = box.querySelector('a[href*="/game/player/"]');
    const id = playerIdFromUrl(link?.getAttribute('href'));
    if (!id) return [];
    const stats = {};
    page.querySelectorAll('.report-meta span').forEach((span) => {
      const m = txt(span).match(/^attacker'?s spy offense:\s*(.+)$/i);
      if (m) put(stats, 'spy_offense', parseValue(m[1]));
    });
    const level = txt(box).match(/\blevel\s+(\d+)/i);
    if (level) put(stats, 'level', Number(level[1]));
    return [observation(id, playerName(link), 'caught', stats, page.querySelector('.report-meta time')?.getAttribute('datetime'))];
  }

  // Spy report sections kept as tables, by title -> stat key.
  const REPORT_TABLES = {
    army_composition: 'report_army', armory_inventory: 'report_armory',
    buildings: 'report_buildings', battle_upgrades: 'report_upgrades',
  };

  function fromSpyReport(doc) {
    const page = [...doc.querySelectorAll('.intel-report-page')].find((p) => !p.matches(FOREIGN) && p.querySelector('.intel-sections'));
    if (!page) return [];
    const link = page.querySelector('.report-actions a[href*="/game/player/"]');
    const id = playerIdFromUrl(link?.getAttribute('href'));
    if (!id) return [];

    const stats = {};
    page.querySelectorAll('.intel-section').forEach((section) => {
      const title = txt(section.querySelector(':scope > h3'));
      section.querySelectorAll('.intel-item').forEach((item) => {
        const label = txt(item.querySelector('.intel-label'));
        // Same label in two sections: keep both, prefixed by the section.
        put(stats, normKey(label) in stats ? `${title} ${label}` : label, valueOf(item.querySelector('.intel-value')));
      });
    });

    // The rest of the report, kept whole (shown in fold-out sections of the intel card):
    // its header, the profile values not kept as stats, and each table / grid as rows.
    const info = {};
    page.querySelectorAll('.report-meta span').forEach((span) => {
      const label = txt(span.querySelector('strong')).replace(/:$/, '');
      if (!label || span.querySelector('time')) return;
      const value = parseValue(txt(span).slice(txt(span.querySelector('strong')).length));
      if (value !== null) info[normKey(label)] = value;
    });
    page.querySelectorAll('.intel-item').forEach((item) => {
      const key = normKey(txt(item.querySelector('.intel-label')));
      if (IGNORED_STATS.has(key) || key === 'race' || key === 'class') info[key] = valueOf(item.querySelector('.intel-value'));
    });
    // Only on a report that revealed something (not a caught spy's report, which has a header too).
    if (Object.keys(info).length && Object.keys(stats).length) stats.report_info = info;
    page.querySelectorAll('.intel-section').forEach((section) => {
      const key = REPORT_TABLES[normKey(txt(section.querySelector(':scope > h3')))];
      if (!key) return;
      const rows = [];
      const heads = [...section.querySelectorAll('thead th')].map((th) => normKey(txt(th)));
      section.querySelectorAll('tbody tr').forEach((tr) => {
        const row = {};
        tr.querySelectorAll('td').forEach((td, i) => {
          const tier = td.querySelector('.tier-badge');
          if (tier) row.tier = txt(tier);
          const copy = td.cloneNode(true);
          copy.querySelector('.tier-badge')?.remove();
          row[heads[i] || `col${i}`] = valueOf(copy);
        });
        rows.push(row);
      });
      section.querySelectorAll('.building-item').forEach((b) => {
        rows.push({ building: txt(b.querySelector('.building-name')), level: parseValue(txt(b.querySelector('.building-level')).replace(/^level\s*/i, '')) });
      });
      if (rows.length) stats[key] = rows;
    });

    const name = playerName(link);
    return [observation(id, name && !/profile|view|attack|spy|message/i.test(name) ? name : null, 'recon', stats,
      page.querySelector('.report-meta time')?.getAttribute('datetime'))];
  }

  // ---- Failed spy operation: /game/spy right after it ---------------------------
  // "Your spies failed to gather intelligence on X": X's spy defense is above my spy offense
  // ("Your Spy Stats" box), kept as a floor. X's id: the newest Failure of Recent Operations.
  function fromFailedSpy(doc) {
    const box = doc.querySelector('.spy-result-card.result-failure');
    if (!box) return [];
    const name = txt(box.querySelector('.result-message strong'));
    const mine = [...doc.querySelectorAll('.stat-item')].find((s) => /^spy offense$/i.test(txt(s.querySelector('.stat-label'))));
    const offense = valueOf(mine?.querySelector('.stat-value'));
    if (!name || typeof offense !== 'number') return [];
    const row = [...doc.querySelectorAll('tr')].find((tr) => /failure|failed/i.test(txt(tr.querySelector('.badge')))
      && playerName(tr.querySelector('a[href*="/game/player/"]')) === name);
    const id = playerIdFromUrl(row?.querySelector('a[href*="/game/player/"]')?.getAttribute('href'));
    return id ? [observation(id, name, 'recon', { spy_defense_floor: offense })] : [];
  }

  // ---- Battle report: /game/attack/log/{id} --------------------------------
  // Both sides show their offense / defense when visible: keep the opponent's.
  function fromBattleReport(doc) {
    const report = doc.querySelector('.battle-report');
    if (!report) return [];
    const at = report.querySelector('.battle-time time')?.getAttribute('datetime');
    const out = [];
    // The banner is the viewer's outcome: on my defense report, "Defeat" = the attacker won.
    const lost = !!report.querySelector('.result-banner.defeat');
    const me = myPlayerId(doc);
    const meDefending = !!me && playerIdFromUrl(report.querySelector('.combatant.defender .combatant-name a')?.getAttribute('href')) === me;
    for (const side of ['attacker', 'defender']) {
      const link = report.querySelector(`.combatant.${side} .combatant-name a`);
      const id = playerIdFromUrl(link?.getAttribute('href'));
      if (!id) continue;
      const stat = (kind) => valueOf(report.querySelector(`.combatant.${side} .combatant-stat.${kind} .stat-value`));
      const stats = {};
      put(stats, 'total_offense', stat('offense'));
      put(stats, 'total_defense', stat('defense'));
      // A lost attack hides the defense, but it was higher than the attacker's offense: kept
      // as a floor (shown "> X" when above the last known defense).
      if (side === 'defender' && !meDefending && lost && !('total_defense' in stats)) {
        const offense = valueOf(report.querySelector('.combatant.attacker .combatant-stat.offense .stat-value'));
        if (typeof offense === 'number') stats.total_defense_floor = offense;
      }
      // Someone who won an attack on me: their offense was higher than my defense then (a floor,
      // when the report hides their offense).
      if (side === 'attacker' && meDefending && lost && !('total_offense' in stats)) {
        const defense = valueOf(report.querySelector('.combatant.defender .combatant-stat.defense .stat-value'));
        if (typeof defense === 'number') stats.total_offense_floor = defense;
      }
      out.push(observation(id, playerName(link), side === 'defender' ? 'attack' : 'defense', stats, at));
    }
    return out;
  }

  // ---- Any table listing players (Attack, Intelligence, ...) ---------------
  // Event logs (battle logs, a profile's Battle History...) are skipped: their
  // "Gold" column is gold stolen in that battle, not the player's gold.
  const EVENT_COLUMNS = /^(date|when|time|result|outcome)$/;

  function fromTables(doc) {
    const out = [];
    doc.querySelectorAll('table').forEach((table) => {
      if (table.closest(FOREIGN) || table.closest('.ranking-card')) return;
      if (table.matches('.battle-logs-table, .spy-logs-table')) return;
      const headRow = table.querySelector('thead tr') || table.querySelector('tr');
      const labels = [...(headRow?.children || [])].map((th) => txt(th).replace(/[⇅↑↓]/g, '').trim().toLowerCase());
      if (labels.some((l) => EVENT_COLUMNS.test(l))) return;
      const columns = labels.map((l) => LIST_COLUMNS[l] || null);

      table.querySelectorAll('tbody tr').forEach((tr) => {
        const link = tr.querySelector('a[href*="/game/player/"]');
        const id = playerIdFromUrl(link?.getAttribute('href'));
        if (!id) return;
        const stats = {};
        for (const [attr, key] of Object.entries(ROW_ATTRIBUTES)) {
          if (tr.hasAttribute(attr)) put(stats, key, parseValue(tr.getAttribute(attr)));
        }
        [...tr.children].forEach((td, i) => {
          if (columns[i]) put(stats, columns[i], td.hasAttribute('data-army') ? parseValue(td.getAttribute('data-army')) : valueOf(td));
        });
        out.push(observation(id, playerName(link), 'list', stats));
      });
    });
    return out;
  }

  // ---- Gold protection badges (Attack list, ~10 s after each tick) ---------
  // "🛡 12,345 · 8s": the gold that player just received at the tick, i.e. their gold per tick.
  function fromProtectionBadges(doc) {
    const out = [];
    doc.querySelectorAll('tr[data-target-id] .gold-protection-badge').forEach((badge) => {
      const tr = badge.closest('tr[data-target-id]');
      // The badge is "🛡 12,345 · 8s" or abbreviated "🛡 6.21M · 8s": the exact figure when the
      // game gives it (data-full), else the shown one; never the countdown (its own span).
      const full = badge.querySelector('[data-full]')?.getAttribute('data-full');
      const copy = badge.cloneNode(true);
      copy.querySelectorAll('.gold-protection-badge-secs').forEach((s) => s.remove());
      const shown = txt(copy).replace(/·?\s*\d+\s*s\b/g, '').match(/(\d[\d,]*(?:\.\d+)?)\s*([KMB])?\b/i);
      const amount = full ? Number(full.replace(/,/g, ''))
        : shown ? Number(shown[1].replace(/,/g, '')) * ({ K: 1e3, M: 1e6, B: 1e9 }[(shown[2] || '').toUpperCase()] || 1) : 0;
      const link = tr.querySelector('a[href*="/game/player/"]');
      if (amount > 0) out.push(observation(tr.getAttribute('data-target-id'), playerName(link), 'protection', { gold_per_turn: Math.round(amount) }));
    });
    return out;
  }

  // ---- Leaderboards: /game/leaderboards (global, all-time) -----------------
  function fromRankings(doc) {
    const page = doc.querySelector('.rankings-extended-page');
    if (!page) return [];
    const period = txt(page.querySelector('.period-btn.active')).toLowerCase();
    if (!/all-time/.test(period)) return []; // "Today" ranks are not the real ones

    const out = [];
    page.querySelectorAll('.ranking-card').forEach((card) => {
      const key = rankCardKey(card);
      if (!key) return;
      card.querySelectorAll('tbody tr').forEach((tr) => {
        const link = tr.querySelector('a[href*="/game/player/"]');
        const id = playerIdFromUrl(link?.getAttribute('href'));
        const rank = txt(tr.querySelector('.rank-col')).match(/#(\d+)/);
        if (id && rank) out.push(observation(id, playerName(link), 'rankings', { [key]: Number(rank[1]) }));
      });
    });
    return out;
  }

  // ---- Overall rank shown by DarkThrone Enhancer on the Attack list ("👑#8") ---------
  // Enhancer puts each row's game rank in data-qal-rank: the game's own Overall rank.
  function fromEnhancerRanks(doc) {
    const out = [];
    doc.querySelectorAll('tr[data-target-id][data-qal-rank]').forEach((tr) => {
      const rank = Number(tr.getAttribute('data-qal-rank'));
      if (rank > 0) out.push(observation(tr.getAttribute('data-target-id'), null, 'rankings', { rank_overall: rank }));
    });
    return out;
  }

  // All observations of the page, without the logged-in player and without empty ones.
  // Same player + same source + same date are merged (first value of a stat wins);
  // anything else stays separate so each value keeps its own date.
  function collectObservations(doc, loc) {
    const me = myPlayerId(doc);
    const merged = new Map();
    const sources = [fromCaughtSpy(doc), fromSpyReport(doc), fromFailedSpy(doc), fromBattleReport(doc), fromProfile(doc, loc), fromTables(doc), fromRankings(doc), fromEnhancerRanks(doc), fromProtectionBadges(doc)];
    for (const obs of sources.flat()) {
      if (obs.player_id === me || !Object.keys(obs.stats).length) continue;
      const key = `${obs.player_id}|${obs.source}|${obs.observed_at || ''}`;
      const cur = merged.get(key);
      if (!cur) { merged.set(key, { ...obs, key, stats: { ...obs.stats } }); continue; }
      cur.player_name ??= obs.player_name;
      for (const [k, v] of Object.entries(obs.stats)) if (!(k in cur.stats)) cur.stats[k] = v;
    }
    const capturedBy = playerName(doc.querySelector('.game-header .user-name'));
    return [...merged.values()].map((o) => ({ ...o, captured_by: capturedBy }));
  }

  // ---- My own stats (Alliance tab) -------------------------------------------
  // The logged-in player's own figures, shared with the alliance (pref shareOwnStats):
  // level from the game header, the dashboard (/game: Combat Power, level badge, Wealth
  // tile, Economy's "Gold Per Tick"), the Battle Logs' Casualty Summary, the season's Daily Summary (gold plundered),
  // Offense from the Attack page's "Your Stats", and my own profile page.
  // Same keys as other players' stats ("Gold Plundered" on a profile -> gold_plundered).
  const OWN_LABELS = [
    [/^(total\s*)?off(ense)?$/i, 'total_offense'],
    [/^(total\s*)?def(ense)?$/i, 'total_defense'],
    [/^spy\s*off(ense)?$/i, 'spy_offense'],
    [/^spy\s*def(ense)?$/i, 'spy_defense'],
    [/^(level|lvl)$/i, 'level'],
    [/^wealth$/i, 'wealth'],
    [/^gold\s*per\s*(tick|turn)$/i, 'gold_per_turn'],
    [/^(total\s*)?(gold\s*)?plundered$/i, 'gold_plundered'],
    [/^(total\s*)?gold\s*lo(st|ss)$/i, 'gold_lost'],
    [/^units\s*lost$/i, 'units_lost'],
    [/^units\s*killed$/i, 'units_killed'],
    [/^k\s*\/?\s*d(\s*ratio)?\s*:?$/i, 'kd_ratio'],
  ];
  // Boxes about another player, or not from the game.
  const NOT_MINE = `${FOREIGN}, .player-profile-page, .intel-report-page, .battle-report, table, .rqum-panel`;

  // "1.22M" / "850k" / "Lvl 35" -> number; exact data-full values are preferred by valueOf.
  function ownNumber(value) {
    if (typeof value === 'number') return value;
    const s = String(value ?? '').replace(/,/g, '').trim();
    const short = s.match(/^(\d+(?:\.\d+)?)\s*([kmb])$/i);
    if (short) return Math.round(Number(short[1]) * { k: 1e3, m: 1e6, b: 1e9 }[short[2].toLowerCase()]);
    const lvl = s.match(/^lvl\.?\s*(\d+)$/i);
    return lvl ? Number(lvl[1]) : null;
  }

  // -> one observation (source 'self') or null. options.live: doc is the page on screen, which
  // other extensions may have changed (see the Daily Summary below).
  function collectOwnStats(doc, loc, options = {}) {
    const me = myPlayerId(doc);
    if (!me) return null;
    const stats = {};
    const read = (label, valueEl) => {
      const key = OWN_LABELS.find(([re]) => re.test(label))?.[1];
      if (!key || key in stats) return;
      const value = ownNumber(valueOf(valueEl));
      if (value !== null) stats[key] = value;
    };
    // Game header: level on every page.
    doc.querySelectorAll('.game-header .stat-item').forEach((item) => {
      if (/^level$/i.test(txt(item.querySelector('.stat-label')))) read('level', item.querySelector('.stat-value'));
    });
    // Dashboard (/game): "Combat Power" boxes (Offense, Defense, Spy Offense, Spy Defense),
    // the level badge and the stat tiles (Wealth...); Attack page: "Your Stats";
    // Battle Logs (/game/battle-logs): "Casualty Summary" (Units Lost / Killed, K/D Ratio).
    const BOXES = [
      ['.combat-power-box', '.power-label', '.power-value'],
      ['.level-badge', '.level-label', '.level-number'],
      ['.dashboard-stat-box', '.dashboard-stat-label', '.dashboard-stat-value'],
      ['.economy-primary', '.economy-big-label', '.economy-big-value'],
      ['.stat-item', '.stat-label', '.stat-value'],
      ['.casualty-stat', '.casualty-label', '.casualty-value'],
      ['.casualty-ratio', '.ratio-label', '.ratio-value'],
    ];
    for (const [boxSel, labelSel, valueSel] of BOXES) {
      doc.querySelectorAll(boxSel).forEach((box) => {
        if (box.closest('.game-header') || box.closest(NOT_MINE)) return;
        read(txt(box.querySelector(labelSel)), box.querySelector(valueSel));
      });
    }
    // Dashboard's Fort Status: "100%".
    const fort = doc.querySelector('.fort-status-display [data-dash-pct]');
    const fortPct = fort && !fort.closest(NOT_MINE) ? parseValue(txt(fort).replace('%', '')) : null;
    if (typeof fortPct === 'number') stats.fort_pct = fortPct;
    // Battle Logs' Combat Stats: "Attack Wins 456 / 488" -> 456 attacks won (of 488).
    doc.querySelectorAll('.combat-stat').forEach((box) => {
      if (box.closest(NOT_MINE) || !/^attack wins$/i.test(txt(box.querySelector('.combat-label')))) return;
      const value = box.querySelector('.combat-value')?.cloneNode(true);
      value?.querySelectorAll('.combat-total').forEach((n) => n.remove());
      const wins = Number(txt(value).replace(/[^\d]/g, ''));
      if (txt(value) && Number.isFinite(wins) && !('attack_wins' in stats)) stats.attack_wins = wins;
    });
    // Daily Summary (/game/summary?period=season), "This Season" view only: the other periods
    // give the gold plundered / lost over a day / week / month, not the season's.
    // Never from the page on screen: DarkThrone Enhancer rewrites these figures in place with
    // its own totals (applyAggregateToRefs). Only the copy capture.js fetches from the server.
    if (!options.live && /season/i.test(txt(doc.querySelector('.summary-period-tab.active')))) {
      for (const tr of doc.querySelectorAll('table tr')) {
        if (tr.closest(FOREIGN) || !tr.cells?.[1]) continue;
        const label = txt(tr.cells[0]);
        if (/^plundered from enemies/i.test(label)) read('gold plundered', tr.cells[1]);
        else if (/^lost to enemy attacks/i.test(label)) read('gold lost', tr.cells[1]); // shown "−135.05M": kept positive
      }
      // Gold ratio: gold plundered ÷ gold lost this season (2 decimals).
      if (stats.gold_plundered > 0 && stats.gold_lost > 0) stats.gold_ratio = Math.round(stats.gold_plundered / stats.gold_lost * 100) / 100;
    }
    // My own profile: level, gold, army, population, clan.
    if (playerIdFromUrl(loc.pathname) === me) {
      for (const [k, v] of Object.entries(fromProfile(doc, loc)[0]?.stats || {})) if (!(k in stats)) stats[k] = v;
    }
    // My game ranks, under each card of the global leaderboards (All-Time view):
    // "Your rank: #21 / 879".
    // (In the top 10 there is no such line: my rank is my row of the card.)
    const rankings = doc.querySelector('.rankings-extended-page');
    if (rankings && /all-time/i.test(txt(rankings.querySelector('.period-btn.active')))) {
      rankings.querySelectorAll('.ranking-card').forEach((card) => {
        const key = rankCardKey(card);
        if (!key || key in stats) return;
        const footer = txt(card.querySelector('.your-rank-footer')).match(/#\s*([\d,]+)/);
        const row = [...card.querySelectorAll('tbody tr')].find((tr) => playerIdFromUrl(tr.querySelector('a[href*="/game/player/"]')?.getAttribute('href')) === me);
        const rank = footer ? footer[1] : txt(row?.querySelector('.rank-col')).match(/#(\d+)/)?.[1];
        if (rank) stats[key] = Number(String(rank).replace(/,/g, ''));
      });
    }
    if (!Object.keys(stats).length) return null;
    const name = playerName(doc.querySelector('.game-header .user-name'));
    return { player_id: me, player_name: name, observed_at: null, source: 'self', captured_by: name, stats };
  }

  // ---- My outgoing spy log, filtered: /game/spy/log?tab=outgoing&operation=...&result=success
  // -> { total: N of "Showing 1-20 of N operations", ops: [{ id, units }] newest first,
  //      next: true when a next page exists }. units: "6 units assassinated" (assassinations).
  function collectSpyLogPage(doc) {
    const total = Number((txt(doc.querySelector('.results-info')).match(/of\s+([\d,]+)/i) || [])[1]?.replace(/,/g, ''));
    const ops = [];
    doc.querySelectorAll('.spy-logs-table tbody tr').forEach((tr) => {
      const link = tr.querySelector('a[href*="/game/spy/log/"]');
      const id = Number((String(link?.getAttribute('href') || '').match(/\/game\/spy\/log\/(\d+)/) || [])[1]);
      if (!id) return;
      const units = (`${link.getAttribute('title') || ''} ${txt(link)}`.match(/([\d,]+)\s+units?/i) || [])[1];
      ops.push({ id, units: units ? Number(units.replace(/,/g, '')) : 0 });
    });
    const next = [...doc.querySelectorAll('.pagination a')].some((a) => /next/i.test(txt(a)));
    return { total: Number.isFinite(total) ? total : null, ops, next };
  }

  // ---- Clan rankings: /game/clan-rankings/{tab} -----------------------------
  // One tab = one figure for every clan: the podium (top 3) then the list. Only the tabs
  // that are figures; Wars, Hitlist and Announcements are not. Most tabs are per-member
  // averages ("Overall (avg)"...). The Clan Level tab also gives each clan's XP: kept as "xp".
  const CLAN_TABS = {
    overall: 'overall', attack: 'offense', defense: 'defense', 'spy-offense': 'spy_offense',
    'spy-defense': 'spy_defense', members: 'members', level: 'level', warfare: 'warfare', treasury: 'treasury',
  };
  RQUM.CLAN_TAB_STATS = CLAN_TABS; // tab of /game/clan-rankings/{tab} -> figure (capture.js)

  // A figure in an element: its exact data-full, else "12", "1.2M", "Level 12", "3,400 XP".
  function figureIn(el) {
    if (!el) return null;
    const full = el.matches('[data-full]') ? el : el.querySelector('[data-full]');
    if (full) return parseValue(full.getAttribute('data-full'));
    const m = txt(el).match(/(\d[\d,]*(?:\.\d+)?)\s*([kmb])?(?![\w])/i);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return m[2] ? Math.round(n * { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()]) : n;
  }

  // -> [{ stat, label, clans: [{ clan_id, tag, name, members, value }] }] (one per figure:
  // the tab's, plus "xp" on the Clan Level tab), or [].
  function collectClanRankings(doc, loc) {
    const page = doc.querySelector('.clan-rankings-page');
    if (!page) return [];
    const tab = (String(loc.pathname).match(/\/game\/clan-rankings\/?([\w-]*)/) || [])[1] || 'overall';
    const stat = CLAN_TABS[tab];
    if (!stat) return [];
    const label = txt(page.querySelector('.ranking-type-btn.active .type-label')) || tab;
    const main = [];
    const xp = [];
    // link: the clan's <a href=".../clan/{id}">; nameEl holds "[TAG] Name"; figureEls: the
    // elements that may hold its figures (score first), infoEl: "12 members".
    const add = (link, tagEl, nameEl, figureEls, infoEl) => {
      const id = (String(link?.getAttribute('href') || '').match(/\/clan\/(\d+)/) || [])[1];
      if (!id) return;
      const tag = txt(tagEl) || null;
      let mainFigure = null;
      let xpFigure = null;
      if (stat === 'level') {
        // The Clan Level tab shows both in one text: "Lvl 13 (44,475 XP)".
        const text = figureEls.filter(Boolean).map(txt).join(' ');
        const lvl = text.match(/\b(?:lv|lvl|level)\.?\s*(\d+)/i);
        const exp = text.match(/(\d[\d,]*(?:\.\d+)?)\s*([kmb])?\s*xp\b/i);
        if (lvl) mainFigure = { value: Number(lvl[1]) };
        if (exp) {
          const n = Number(exp[1].replace(/,/g, ''));
          xpFigure = { value: exp[2] ? Math.round(n * { k: 1e3, m: 1e6, b: 1e9 }[exp[2].toLowerCase()]) : n };
        }
      } else {
        mainFigure = figureEls.filter(Boolean)
          .map((el) => ({ text: txt(el), value: figureIn(el) }))
          .find((f) => typeof f.value === 'number' && !/members?\b/i.test(f.text)) || null;
      }
      const base = {
        clan_id: id, tag,
        name: txt(nameEl).replace(tag || '', '').trim() || null,
        members: Number((txt(infoEl).match(/(\d+)\s+members?/i) || [])[1]) || null,
      };
      if (mainFigure) main.push({ ...base, value: mainFigure.value });
      if (xpFigure) xp.push({ ...base, value: xpFigure.value });
    };
    page.querySelectorAll('.podium-spot a.podium-player').forEach((a) => {
      add(a, a.querySelector('.podium-clan-tag'), a.querySelector('.podium-name'),
        [a.querySelector('.podium-score'), a.querySelector('.podium-info')], a.querySelector('.podium-info'));
    });
    page.querySelectorAll('.ranking-row').forEach((row) => {
      const link = row.querySelector('a[href*="/clan/"]');
      const badges = [...row.querySelectorAll('.ranking-stats .stat-badge')];
      add(link, row.querySelector('.clan-tag-inline'), link,
        badges.length ? badges : [row.querySelector('.ranking-stats .stat-value')], row.querySelector('.player-details'));
    });
    const out = [];
    if (main.length) out.push({ stat, label, clans: main });
    if (xp.length) out.push({ stat: 'xp', label: 'Clan XP', clans: xp });
    return out;
  }

  RQUM.parsers = { FOREIGN, IGNORED_STATS, playerIdFromUrl, myPlayerId, playerName, collectObservations, collectOwnStats, collectClanRankings, collectSpyLogPage };
})();
