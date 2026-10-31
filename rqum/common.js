// Shared helpers for RQUM content scripts (loaded first).
globalThis.RQUM = globalThis.RQUM || {};

RQUM.send = (type, payload = {}) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(res || { ok: false, error: 'No response' });
      });
    } catch (err) {
      // Happens when the extension was reloaded while the page stayed open.
      resolve({ ok: false, error: String(err?.message || err) });
    }
  });

// Nothing of RQUM runs on a page (capture, eye buttons, green buttons...) until the member
// is signed in (in-game name + personal key, RQUM window) AND that name is the player
// logged in to the game here. Asked once per page. -> { ok, name, playing, reason }
// Names are compared on their letters and digits only, as the database does: "👤 Jom" is Jom.
const nameKey = (name) => String(name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
let signedInHere = null;
RQUM.whenSignedIn = () => {
  signedInHere ??= RQUM.send('getStatus').then((res) => {
    const name = res.ok ? res.data.signedIn : null;
    const link = document.querySelector('.game-header .user-name');
    const playing = link ? RQUM.parsers.playerName(link) : null;
    if (!name) return { ok: false, name: null, playing, reason: 'signed-out' };
    if (playing && nameKey(playing) !== nameKey(name)) return { ok: false, name, playing, reason: 'other-player' };
    return { ok: true, name, playing };
  });
  return signedInHere;
};

RQUM.getConfig = async () => {
  const { rqumConfig } = await chrome.storage.local.get('rqumConfig');
  return { captureEnabled: true, shareOwnStats: true, greenAttack: true, compactAttack: true, hideClanRecent: false, fortAlert: true, tierCosts: true, eyeButtons: true, attackFilters: true, ffaMarks: true, gearCheck: true, dashboardPlus: true, voteInBar: true, dashAttackList: true, dashAssassinate: true, mercReminder: true, summaryHistory: true, buildingCosts: true, profileTiles: true, battleTotals: true, collapseCards: true, resultWindow: true, ...rqumConfig };
};

// Fort alert (option fortAlert, on by default): the clan's members, me included, whose fort is at
// or under THEIR threshold: the one they set for their own fort, else the alliance's (the admin
// sets it). Readings older than FORT_MAX_AGE_H are left out (repaired since?).
// players: rows of rqum_alliance; shared: rqum_member_settings ({ fort_alliance, fort: { id: pct } })
// -> [{ id, name, pct, at, max }], lowest fort first.
RQUM.FORT_THRESHOLD = 25; // when the alliance's cannot be read
const FORT_MAX_AGE_H = 24;
// A member of the clan: in the [RQUM] clan, or using RQUM (rows of rqum_alliance).
RQUM.isClanMember = (p) => !!p.uses_rqum || RQUM.clanTag(p.stats?.clan?.v).toUpperCase() === '[RQUM]';
RQUM.lowForts = (players, shared) => players
  .map((p) => ({ p, max: Number(shared?.fort?.[p.player_id]) || Number(shared?.fort_alliance) || RQUM.FORT_THRESHOLD }))
  .filter(({ p, max }) => {
    const fort = p.stats?.fort_pct;
    return RQUM.isClanMember(p) && typeof fort?.v === 'number' && fort.v <= max
      && Date.now() - new Date(fort.at).getTime() < FORT_MAX_AGE_H * 3600000;
  })
  .map(({ p, max }) => ({ id: p.player_id, name: RQUM.cleanName(p.player_name) || `#${p.player_id}`, pct: p.stats.fort_pct.v, at: p.stats.fort_pct.at, max }))
  .sort((a, b) => a.pct - b.pct);
// "Fort at or under the alert threshold:\nKrijkes 32% ≤ 40% (2h ago)\nJio 45% ≤ 50% (10m ago)"
RQUM.lowFortsText = (low) => ['Fort at or under the alert threshold:',
  ...low.map((f) => `${f.name} ${f.pct}% ≤ ${f.max}% (${RQUM.formatAge(f.at)} ago)`)].join('\n');

// Favourite players, kept in this browser: chrome.storage in the extension, localStorage on
// the web page. -> { "<id>": "<name>" }
const FAVORITES_KEY = 'rqumFavorites';
RQUM.favorites = {
  async all() {
    try {
      if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(FAVORITES_KEY))[FAVORITES_KEY] || {};
      return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '{}');
    } catch (_) { return {}; }
  },
  // -> true when the player is now a favourite.
  async toggle(id, name) {
    const all = await RQUM.favorites.all();
    if (all[id] !== undefined) delete all[id];
    else all[id] = name || `#${id}`;
    try {
      if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [FAVORITES_KEY]: all });
      else localStorage.setItem(FAVORITES_KEY, JSON.stringify(all));
    } catch (_) { /* private mode: kept for this visit only */ }
    return all[id] !== undefined;
  },
};

// ☆ / ★ in a player row: a tap adds or removes the favourite (without opening the row).
RQUM.favStar = (id, name) => {
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'rqum-fav';
  const show = (on) => {
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('is-on', on);
    star.title = on ? 'Remove from favourites' : 'Add to favourites';
  };
  show(false);
  RQUM.favorites.all().then((all) => show(all[id] !== undefined));
  star.addEventListener('click', async (e) => {
    e.stopPropagation();
    show(await RQUM.favorites.toggle(String(id), name));
  });
  return star;
};

// Search tab, empty box: the favourites, by name. playerItem(id, name, meta) makes a row.
RQUM.favoritesList = async (playerItem) => {
  const all = Object.entries(await RQUM.favorites.all())
    .sort(([, a], [, b]) => String(a).localeCompare(String(b)));
  const box = document.createElement('div');
  const title = document.createElement('p');
  title.className = 'rqum-muted';
  title.textContent = all.length ? '★ Favourites' : 'Type a player name or id, or a clan tag or name. Tap ☆ next to a player to add a favourite.';
  const list = document.createElement('ul');
  list.className = 'rqum-list';
  for (const [id, name] of all) list.appendChild(playerItem(id, name, 'favourite'));
  box.append(title, list);
  return box;
};

// Clan search results (rqum_search_clan rows): one folding row per clan, its players inside.
RQUM.clanGroups = (rows, playerItem) => {
  const clans = new Map();
  for (const r of rows) {
    if (!clans.has(r.clan_tag)) clans.set(r.clan_tag, { name: r.clan_name, players: [] });
    clans.get(r.clan_tag).players.push(r);
  }
  return [...clans].map(([tag, clan]) => {
    const item = document.createElement('li');
    item.className = 'rqum-list__item rqum-clan-result';
    const row = document.createElement('div');
    row.className = 'rqum-list__row';
    const name = document.createElement('span');
    name.className = 'rqum-list__name';
    name.textContent = `🛡️ ${tag}${clan.name ? ` ${clan.name}` : ''}`;
    const meta = document.createElement('span');
    meta.className = 'rqum-list__meta';
    meta.textContent = `${clan.players.length} known player${clan.players.length === 1 ? '' : 's'}`;
    row.append(name, meta);
    const list = document.createElement('ul');
    list.className = 'rqum-list rqum-list__detail';
    list.hidden = clans.size > 1; // a single clan opens at once
    for (const p of clan.players) {
      const age = p.updated_at ? ` · ${RQUM.formatAge(p.updated_at)} ago` : '';
      list.appendChild(playerItem(p.player_id, p.player_name, `${p.level != null ? `Lv ${p.level}` : 'Lv ?'}${age}`, tag));
    }
    row.addEventListener('click', () => { list.hidden = !list.hidden; });
    item.append(row, list);
    return item;
  });
};

RQUM.toast = (text, isError = false, durationMs = 3500) => {
  const el = document.createElement('div');
  el.className = `rqum-toast${isError ? ' rqum-toast--error' : ''}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
};

// Exact figure ("1,234,567"): for form fields and tooltips.
RQUM.formatExact = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? '?'));
// Display: from 1 million on, in M / B like the game ("1.31M", "1.14B"); below, exact.
RQUM.formatNumber = (v) => {
  if (typeof v !== 'number') return RQUM.formatExact(v);
  const millions = +(v / 1e6).toFixed(2);
  if (Math.abs(millions) >= 1000) return `${+(v / 1e9).toFixed(2)}B`; // 999,999,999 -> 1B, not 1000M
  if (Math.abs(v) >= 1e6) return `${millions}M`;
  return RQUM.formatExact(v);
};

// Gold typed by a member: "5M", "800k", "1.2B", "1 234 567" -> a number, NaN if not one.
RQUM.parseGold = (text) => {
  const m = String(text).trim().replace(/[\s, ]/g, '').toLowerCase().match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  return m ? Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1)) : NaN;
};

// How fresh a stat is: under 6 h green, 6 to 12 h orange, over 12 h red (rqum.css).
const AGE_FRESH_HOURS = 6;
const AGE_STALE_HOURS = 12;
RQUM.ageClass = (iso) => {
  const hours = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (!(hours < AGE_STALE_HOURS)) return 'rqum-age--old'; // also when the date is unknown
  return hours < AGE_FRESH_HOURS ? 'rqum-age--fresh' : 'rqum-age--aging';
};

// "👤 Vorlayn" -> "Vorlayn": the game's default-avatar placeholder can stick to a captured name.
RQUM.cleanName = (name) => String(name ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim() || name;

// Renamed in the game (stats.former_name, set by the database): "✏️ was Deadly" next to the
// name. Lists show it for RENAMED_DAYS; the intel card (always: true) keeps it.
const RENAMED_DAYS = 7;
RQUM.renamedTag = (former, always = false) => {
  if (!former?.v) return null;
  const days = (Date.now() - new Date(former.at).getTime()) / 86400000;
  if (!always && !(days < RENAMED_DAYS)) return null;
  const tag = el('span', 'rqum-renamed', `✏️ was ${RQUM.cleanName(former.v)}`);
  tag.title = `Renamed in the game: was "${RQUM.cleanName(former.v)}" (name change seen ${RQUM.formatAge(former.at)} ago)`;
  return tag;
};

// Recent tab line (rqum_recent_changes): "2h ago · Def · by JT", "all 4" when every combat stat changed.
const CHANGE_LABELS = { total_offense: 'Off', total_defense: 'Def', spy_offense: 'Spy Off', spy_defense: 'Spy Def' };
// "Def 511K (+62K)", "Off 2.03M (−730), Spy Def 110K (+13.4K)"; a first sighting has no change.
// p.changes (rqum_recent_changes): { stat: { v, prev } }.
RQUM.changeWhat = (p) => {
  const stats = (p.changed_stats || []).filter((k) => CHANGE_LABELS[k]);
  return stats.map((k) => {
    const c = p.changes?.[k];
    if (typeof c?.v !== 'number') return CHANGE_LABELS[k];
    const diff = typeof c.prev === 'number' ? c.v - c.prev : null;
    const signed = diff === null ? '' : ` (${diff >= 0 ? '+' : '−'}${RQUM.formatNumber(Math.abs(diff))})`;
    return `${CHANGE_LABELS[k]} ${RQUM.formatNumber(c.v)}${signed}`;
  }).join(', ');
};

// Recent tab, small window: the age and who in the row ("2h ago · by JT"), and under it one
// chip per figure that changed, in the game's colours with its icon: "🛡 Def 1.53M −2.35K".
const CHANGE_KINDS = { total_offense: 'offense', total_defense: 'defense', spy_offense: 'spy-offense', spy_defense: 'spy-defense' };
RQUM.changeAge = (p) => [`${RQUM.formatAge(p.changed_at)} ago`, p.changed_by ? `by ${RQUM.cleanName(p.changed_by)}` : null].filter(Boolean).join(' · ');
RQUM.changeChips = (p) => {
  const box = el('div', 'rqum-chips');
  for (const k of Object.keys(CHANGE_LABELS)) {
    if (!(p.changed_stats || []).includes(k)) continue;
    const c = p.changes?.[k];
    const chip = el('span', `rqum-chip rqum-card__row--${CHANGE_KINDS[k]}`);
    const icon = el('img', 'rqum-chip__icon');
    icon.src = RQUM.assetUrl(`icons/stats/${CHANGE_KINDS[k]}.png`);
    icon.alt = '';
    chip.append(icon, `${CHANGE_LABELS[k]} ${typeof c?.v === 'number' ? RQUM.formatNumber(c.v) : ''}`);
    if (typeof c?.v === 'number' && typeof c.prev === 'number') {
      const d = c.v - c.prev;
      chip.appendChild(el('span', `rqum-chip__diff ${d >= 0 ? 'is-up' : 'is-down'}`, `${d >= 0 ? '+' : '−'}${RQUM.formatNumber(Math.abs(d))}`));
      chip.title = `${RQUM.formatExact(c.prev)} → ${RQUM.formatExact(c.v)}`;
    } else if (typeof c?.v === 'number') chip.title = `${RQUM.formatExact(c.v)}, first time seen`;
    box.appendChild(chip);
  }
  return box;
};

// The game's Overall rank known for a player ("#21"), from the leaderboards, a profile, the
// Attack list (DarkThrone Enhancer's 👑) or, for a member, their own leaderboards page.
RQUM.rankText = (stats) => (typeof stats?.rank_overall?.v === 'number' ? `#${stats.rank_overall.v}` : null);

// The clan tag shown before a name ("[TGO] Tripinhas"); none for "No Clan" / "None".
RQUM.clanTag = (clan) => String(clan ?? '').match(/\[[^\]]+\]/)?.[0] || '';
RQUM.withClan = (name, clan) => {
  const tag = RQUM.clanTag(clan);
  name = RQUM.cleanName(name); // without the avatar icon ("👤 Jom")
  return tag ? `${tag} ${name}` : name;
};
RQUM.changeMeta = (p) => [`${RQUM.formatAge(p.changed_at)} ago`, RQUM.changeWhat(p) || null, p.changed_by ? `by ${RQUM.cleanName(p.changed_by)}` : null]
  .filter(Boolean).join(' · ');

RQUM.formatAge = (iso) => {
  const minutes = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
};

// attack: seen in a battle report of someone who attacked this player; defense: in the
// report of someone this player attacked.
RQUM.SOURCE_LABELS = { profile: 'profile', recon: 'spy report', attack: 'attack report', defense: 'defense report', list: 'player list', rankings: 'rankings', manual: 'manual entry', self: 'their own RQUM', caught: 'spy caught', protection: 'gold protection (tick)' };

// Stats shown first in a card, in this order; any other stat follows.
const STAT_ORDER = [
  'level', 'total_offense', 'total_defense', 'spy_offense', 'spy_defense', 'wealth', 'gold_per_turn', 'gold_plundered',
  'gold_lost', 'units_killed', 'units_lost', 'kd_ratio', 'attack_wins', 'sabotages', 'assassin_kills',
  'gold_on_hand', 'army', 'population', 'fort_pct', 'clan',
  'rank_overall', 'rank_offense', 'rank_defense', 'rank_level', 'rank_gold_stolen', 'rank_net_worth',
  'rank_attack_wins', 'rank_total_kills', 'rank_defense_wins', 'rank_fort_damage', 'rank_richest', 'rank_gold_spent',
];
// Stats with an hourly history (supabase/schema.sql, rqum_history): a tap shows their graph.
RQUM.ALLIANCE_STATS = [
  'level', 'total_offense', 'total_defense', 'spy_offense', 'spy_defense', 'wealth', 'gold_per_turn', 'gold_plundered',
  'gold_lost', 'units_killed', 'units_lost', 'kd_ratio', 'attack_wins', 'sabotages', 'assassin_kills',
];
// What the Alliance tab shows of each member (above); all of them have a graph.
// The game's ranks have their graph too (one point an hour for members, when seen for others).
RQUM.RANK_STATS = ['rank_overall', 'rank_offense', 'rank_defense', 'rank_level', 'rank_gold_stolen', 'rank_net_worth',
  'rank_attack_wins', 'rank_total_kills', 'rank_defense_wins', 'rank_fort_damage', 'rank_richest', 'rank_gold_spent'];
RQUM.HISTORY_STATS = new Set([...RQUM.ALLIANCE_STATS, ...RQUM.RANK_STATS]);
// Current game season: the "S" period of the graphs starts here. Update it each new season.
const SEASON_START = new Date(2026, 9, 1); // 1 October 2026, local time
const daysSinceSeason = () => Math.max(1, Math.ceil((Date.now() - SEASON_START.getTime()) / 86400000));
// Graph periods: label -> number of days (the season's is computed when clicked).
const HISTORY_PERIODS = [['6h', () => 6 / 24], ['12h', () => 12 / 24], ['1d', () => 1], ['7d', () => 7], ['1m', () => 30], ['S', daysSinceSeason]];
const HISTORY_DEFAULT_PERIOD = '7d';

// -> [{ hour, v }] oldest first. The extension asks background.js; the web page replaces it.
// A clan's figure (Clans tab), same shape; also replaced by the web page.
RQUM.fetchClanHistory = async (clanId, stat, days) => {
  const res = await RQUM.send('getClanHistory', { clanId, stat, days });
  if (!res.ok) throw new Error(res.error);
  return res.data || [];
};

RQUM.deleteHistoryPoint = async (point) => {
  const res = await RQUM.send('deleteHistoryPoint', point);
  if (!res.ok) throw new Error(res.error);
  return res.data;
};

RQUM.fetchHistory = async (playerId, stat, days) => {
  const res = await RQUM.send('getHistory', { playerId, stat, days });
  if (!res.ok) throw new Error(res.error);
  return res.data || [];
};
const CARD_MAX_STATS = 18;
// Labels that "key with spaces" would get wrong.
const STAT_LABELS = {
  kd_ratio: 'K/D Ratio', gold_plundered: 'Total Gold Plundered', gold_lost: 'Total Gold Loss', gold_per_turn: 'Gold per Turn',
  sabotages: 'Sabotages', assassin_kills: 'Units Assassinated', attack_wins: 'Attack Wins', fort_pct: 'Fort',
};
// The 4 combat stats get the game's colours (rqum.css) and the game's own icons
// (copies of darkthronegame.com/images/icons/sidebar/hntc/hntc-*-icon.png in icons/stats).
const STAT_STYLES = {
  total_offense: 'offense',
  total_defense: 'defense',
  spy_offense: 'spy-offense',
  spy_defense: 'spy-defense',
};

// Extension file URL in the extension; plain relative path on the web page (web/), whose
// build copies src/icons next to it.
RQUM.assetUrl = (path) => (globalThis.chrome?.runtime?.id ? chrome.runtime.getURL(path) : path);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
RQUM.el = el;

// Shown at the top of the card instead of as rows: race and class (with their bonus), and the
// clan (already before the name); the fort's % is not shown.
const CARD_TOP = new Set(['race', 'class', 'clan', 'fort_pct']);
// The bonus each race and class gives (the game's Race & Class page).
const RACE_BONUS = {
  human: '+6% income', goblin: '+6% defense', undead: '+6% offense', elf: '+6% spy',
  giants: '+6% offense', ents: '+6% defense', dwarves: '+6% income', halflings: '+6% spy',
};
// A profile says "Dwarf" where the Race & Class page says "Dwarves": both forms.
Object.assign(RACE_BONUS, { humans: RACE_BONUS.human, goblins: RACE_BONUS.goblin, elves: RACE_BONUS.elf, giant: RACE_BONUS.giants,
  ent: RACE_BONUS.ents, dwarf: RACE_BONUS.dwarves, halfling: RACE_BONUS.halflings });
const CLASS_BONUS = { fighter: '+4% offense', cleric: '+4% defense', thief: '+4% income', assassin: '+4% spy' };
// "🧬 Undead (+5% offense) · ⚔️ Fighter (+5% offense)", and "✏️ was Human" in orange after
// a race, class or clan that changed (stats.former_*, set by the database).
function identityLine(stats) {
  const race = stats.race?.v ?? stats.report_info?.v?.race;
  const cls = stats.class?.v ?? stats.report_info?.v?.class;
  const changes = ['race', 'class', 'clan'].map((k) => [k, stats[`former_${k}`]]).filter(([, f]) => f?.v != null);
  if (!race && !cls && !changes.length) return null;
  const line = el('div', 'rqum-card__identity');
  const part = (icon, value, bonus, key) => {
    if (!value) return;
    if (line.childElementCount) line.append(' · ');
    const span = el('span', 'rqum-card__ident', `${icon} ${value}`);
    if (bonus) span.appendChild(el('span', 'rqum-card__bonus', ` (${bonus})`));
    line.appendChild(span);
    const former = stats[`former_${key}`];
    if (former?.v != null) line.appendChild(changedTag(key, former));
  };
  part('🧬', race, RACE_BONUS[String(race).toLowerCase()], 'race');
  part('🎓', cls, CLASS_BONUS[String(cls).toLowerCase()], 'class');
  // The clan is in the title: only its change is said here.
  if (stats.former_clan?.v != null) {
    if (line.childElementCount) line.append(' · ');
    line.appendChild(changedTag('clan', stats.former_clan));
  }
  return line;
}
function changedTag(key, former) {
  const was = String(former.v || '').trim() || 'no clan';
  const tag = el('span', 'rqum-renamed', `✏️ ${key === 'clan' ? 'clan ' : ''}was ${was}`);
  tag.title = `${key[0].toUpperCase()}${key.slice(1)} changed in the game: was "${was}" (change seen ${RQUM.formatAge(former.at)} ago)`;
  return tag;
}

// Latest known stats of one player (a row from rqum_get_players), each with its own age.
// Used by the floating panel. options.only: the stats to show, in that order.
RQUM.intelCard = (player, options = {}) => {
  const card = el('div', 'rqum-card');
  card.appendChild(el('div', 'rqum-card__title', RQUM.withClan(player.player_name || `#${player.player_id}`, player.stats?.clan?.v)));
  const renamed = RQUM.renamedTag(player.stats?.former_name, true);
  if (renamed) card.appendChild(renamed);
  const identity = identityLine(player.stats || {});
  if (identity) card.appendChild(identity);
  card.appendChild(el('div', 'rqum-card__head',
    `Updated ${RQUM.formatAge(player.updated_at)} ago${player.updated_by ? ` by ${player.updated_by}` : ''}`));

  const order = options.only || STAT_ORDER;
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  const stats = withFloors(player.stats || {});
  // Ignored stats saved by an older version stay hidden.
  const entries = Object.entries(stats)
    .filter(([k, st]) => showRank(k, st))
    .filter(([k]) => !RQUM.parsers.IGNORED_STATS.has(k) && !k.startsWith('fort_hp') && !k.startsWith('former_') && !CARD_TOP.has(k) && !REPORT_FOLDS.some(([, keys]) => keys.includes(k))
      && (!options.only || options.only.includes(k)))
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, CARD_MAX_STATS);
  if (!entries.length) card.appendChild(el('div', 'rqum-card__empty', 'No stats yet'));

  for (const [key, stat] of entries) {
    const kind = STAT_STYLES[key];
    const line = el('div', `rqum-card__row${kind ? ` rqum-card__row--${kind}` : ''}`);
    const origin = statOrigin(stat);
    line.title = origin; // mouse hover
    // Touch screens have no hover: a tap shows the same origin under the row (tap again to hide).
    line.tabIndex = 0;
    line.setAttribute('role', 'button');
    line.setAttribute('aria-expanded', 'false');
    // The detail: where the value comes from, and the graph of its evolution when it has one.
    const detail = el('div', `rqum-card__detail${kind ? ` rqum-card__row--${kind}` : ''}`);
    detail.appendChild(el('div', '', origin));
    detail.hidden = true;
    const hasGraph = RQUM.HISTORY_STATS.has(key) && player.player_id != null;
    if (hasGraph) line.classList.add('rqum-card__row--graph');
    const toggle = () => {
      detail.hidden = !detail.hidden;
      line.setAttribute('aria-expanded', String(!detail.hidden));
      if (!detail.hidden && hasGraph && !detail.querySelector('.rqum-chart')) {
        detail.appendChild(historyPanel((days) => RQUM.fetchHistory(player.player_id, key, days),
          (hour) => RQUM.deleteHistoryPoint({ playerId: player.player_id, stat: key, hour })));
      }
    };
    line.addEventListener('click', toggle);
    line.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    const label = el('span', 'rqum-card__label', STAT_LABELS[key] || key.replace(/_/g, ' '));
    if (kind) {
      const icon = el('img', 'rqum-card__icon');
      icon.src = RQUM.assetUrl(`icons/stats/${kind}.png`);
      icon.alt = '';
      label.prepend(icon);
    }
    line.append(
      label,
      stat.floor ? floorSpan(stat) : key === 'fort_pct' ? el('span', 'rqum-card__value', `${stat.v}%`) : valueSpan(stat.v),
      el('span', `rqum-card__age ${RQUM.ageClass(stat.at)}`, RQUM.formatAge(stat.at)),
    );
    card.append(line, detail);
  }
  if (!options.only) reportFolds(card, player.stats || {});
  return card;
};

// The rest of the last spy report, each part folded under its title: what a Full
// Reconnaissance shows besides the combat stats.
const REPORT_FOLDS = [
  ['🕵️ Spy report', ['report_info']],
  ['💰 Resources', ['gold_in_bank', 'citizens']],
  ['🪖 Army composition', ['report_army']],
  ['⚒️ Armory', ['report_armory']],
  ['🏰 Buildings', ['report_buildings']],
  ['⚙️ Battle upgrades', ['report_upgrades']],
];
const REPORT_INFO_LABELS = {
  operation: 'Operation', your_spy_offense: 'Spy offense of the spy', target_spy_defense: 'Their spy defense',
  race: 'Race', class: 'Class', fort_hp: 'Fort HP',
};
const REPORT_COLUMNS = ['tier', 'unit', 'item', 'upgrade', 'building', 'type', 'category', 'quantity', 'level', 'bonus', 'total'];
// Short forms so the tables fit the window; the full words show on hover.
const REPORT_HEADS = { quantity: 'Qty', bonus: 'Bns', total: 'Tot', category: 'Cat', level: 'Lvl' };
const REPORT_WORDS = [
  [/^Battle Upgrades - /, ''], [/Spy Offense/g, 'SO'], [/Spy Defense/g, 'SD'],
  [/Offensive Military|Offense/g, 'Off'], [/Defensive Military|Defense/g, 'Def'],
  [/Weapons/g, 'Wpn'], [/Armor/g, 'Arm'], [/Workers/g, 'Work'],
];
const shortWords = (text) => REPORT_WORDS.reduce((t, [re, to]) => t.replace(re, to), String(text));

function reportFolds(card, stats) {
  for (const [title, keys] of REPORT_FOLDS) {
    const present = keys.filter((k) => stats[k]?.v != null);
    if (!present.length) continue;
    const fold = el('details', 'rqum-fold');
    const at = stats[present[0]].at;
    const summary = el('summary', 'rqum-fold__title', title);
    summary.appendChild(el('span', `rqum-card__age ${RQUM.ageClass(at)}`, RQUM.formatAge(at)));
    summary.title = statOrigin(stats[present[0]]);
    fold.appendChild(summary);
    for (const key of present) {
      const v = stats[key].v;
      if (Array.isArray(v)) fold.appendChild(reportTable(v));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) fold.appendChild(foldRow(REPORT_INFO_LABELS[k] || k.replace(/_/g, ' '), x));
      } else fold.appendChild(foldRow(STAT_LABELS[key] || key.replace(/_/g, ' '), v));
    }
    card.appendChild(fold);
  }
}

function foldRow(label, value) {
  const row = el('div', 'rqum-fold__row');
  row.append(el('span', 'rqum-card__label', label), valueSpan(value));
  return row;
}

// Rows of one report table: same columns for every row, in a readable order.
function reportTable(rows) {
  const cols = REPORT_COLUMNS.filter((c) => rows.some((r) => r[c] != null))
    .concat(Object.keys(rows[0] || {}).filter((c) => !REPORT_COLUMNS.includes(c)));
  const table = el('table', 'rqum-fold__table');
  const head = el('tr');
  for (const c of cols) {
    const th = el('th', '', c === 'tier' ? '' : REPORT_HEADS[c] || c);
    if (REPORT_HEADS[c]) th.title = c;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const r of rows) {
    const tr = el('tr');
    for (const c of cols) {
      const v = r[c];
      const short = v == null ? '' : typeof v === 'number' ? RQUM.formatNumber(v) : (c === 'type' || c === 'category') ? shortWords(v) : String(v);
      const td = el('td', typeof v === 'number' ? 'is-num' : '', short);
      const full = typeof v === 'number' ? RQUM.formatExact(v) : String(v ?? '');
      if (short !== full) td.title = full;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  return table;
}

// A card value; when shortened (1.31M), the exact figure shows on hover.
function valueSpan(v) {
  const span = el('span', 'rqum-card__value', RQUM.formatNumber(v));
  if (span.textContent !== RQUM.formatExact(v)) span.title = RQUM.formatExact(v);
  return span;
}

// ---- Alliance tab (rows from rqum_alliance) ---------------------------------------
// Members, highest level first; a tap opens their Level / Off / Def / SO / SD / Wealth /
// Gold Plundered, each with its graph. profileLink(id) -> <a> to their game profile.
RQUM.allianceList = (players, profileLink) => {
  if (!players.length) {
    return el('p', 'rqum-muted', 'No member yet: members appear once they play with RQUM 0.7.7 or later.');
  }
  const level = (p) => Number(p.stats?.level?.v) || 0;
  const list = el('ul', 'rqum-list');
  for (const p of [...players].sort((a, b) => level(b) - level(a) || String(a.player_name).localeCompare(String(b.player_name)))) {
    const item = el('li', 'rqum-list__item');
    const row = el('div', 'rqum-list__row');
    const name = el('span', 'rqum-list__name', RQUM.withClan(p.player_name || `#${p.player_id}`, p.stats?.clan?.v));
    const renamed = RQUM.renamedTag(p.stats?.former_name);
    if (renamed) name.appendChild(renamed);
    if (p.uses_rqum) {
      const eye = el('img', 'rqum-list__badge');
      eye.src = RQUM.assetUrl('icons/header-eye.png');
      eye.alt = '';
      eye.title = 'Plays with RQUM: their own stats are shared';
      name.appendChild(eye);
    }
    const meta = [RQUM.rankText(p.stats), level(p) ? `Lv ${level(p)}` : null, p.updated_at ? `${RQUM.formatAge(p.updated_at)} ago` : null].filter(Boolean).join(' · ');
    row.append(name, el('span', 'rqum-list__meta', meta));
    const detail = el('div', 'rqum-list__detail');
    detail.hidden = true;
    row.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      if (detail.hidden || detail.childElementCount) return;
      detail.append(RQUM.intelCard(p, { only: RQUM.ALLIANCE_STATS }), profileLink(p.player_id));
    });
    item.append(row, detail);
    list.appendChild(item);
  }
  const wrap = el('div');
  wrap.append(el('p', 'rqum-muted', 'Tap a member, then a value to see its graph.'), list);
  return wrap;
};

// ---- Ranking tab (rows from rqum_alliance) -----------------------------------------
// Members ranked on one figure, a sub-tab per category, the top three on a podium, each
// value with its change over the last 24 h.
// [stat, sub-tab, unit (hover text), note under the list, decimals].
const RANKINGS = [
  ['assassin_kills', '🗡️ Assassinations', 'units assassinated', 'Total units assassinated since each member installed RQUM 0.7.12.'],
  ['sabotages', '💥 Sabotages', 'successful sabotages', 'Total successful sabotages since each member installed RQUM 0.7.12.'],
  ['units_killed', '⚔️ Units killed', 'units killed in battles', 'Units killed in attacks and defenses (the game\'s Battle Logs); assassinations not counted.'],
  ['attack_wins', '🏹 Attack wins', 'attacks won', 'Attacks won (the game\'s Battle Logs), read from RQUM 0.7.17 on.'],
  ['kd_ratio', '📈 Best K/D', 'K/D ratio', 'Units killed ÷ units lost in battles (the game\'s Battle Logs).', 2],
  ['gold_plundered', '💰 Gold plundered', 'gold plundered this season', 'Gold plundered this season (the game\'s Daily Summary).'],
];
RQUM.RANKING_STATS = RANKINGS.map(([k]) => k);
// rqum_day_before rows [{ player_id, stat, v }] -> { id: { stat: v } }.
RQUM.dayBeforeMap = (rows) => {
  const out = {};
  for (const r of rows || []) (out[r.player_id] ??= {})[r.stat] = Number(r.v);
  return out;
};
let rankingTab = RANKINGS[0][0];
// dayBefore: { "<player id>": { "<stat>": value about 24 h ago } } (rqum_day_before).
RQUM.rankingView = (players, dayBefore = {}) => {
  const wrap = el('div', 'rqum-ranking');
  const tabs = el('div', 'rqum-ranking__tabs');
  const content = el('div');
  const show = (key) => {
    rankingTab = key;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.key === key));
    const [, , unit, note, decimals = 0] = RANKINGS.find(([k]) => k === key);
    const value = (p) => Number(p.stats?.[key]?.v) || 0;
    const fmt = (v) => (decimals ? v.toFixed(decimals) : RQUM.formatNumber(v));
    // "+12" since about 24 h ago; nothing when there is no figure that old.
    const diff = (p) => {
      const before = Number(dayBefore[p.player_id]?.[key]);
      const span = el('span', 'rqum-ranking__diff');
      if (!Number.isFinite(before) || dayBefore[p.player_id]?.[key] == null) return span;
      const d = +(value(p) - before).toFixed(decimals);
      span.textContent = d > 0 ? `+${fmt(d)}` : d < 0 ? `−${fmt(-d)}` : '±0';
      span.classList.add(d > 0 ? 'is-up' : d < 0 ? 'is-down' : 'is-flat');
      span.title = `Change over the last 24 h (was ${decimals ? before.toFixed(decimals) : RQUM.formatExact(before)})`;
      return span;
    };
    const ranked = players.filter((p) => value(p) > 0)
      .sort((a, b) => value(b) - value(a) || String(a.player_name).localeCompare(String(b.player_name)));
    if (!ranked.length) {
      content.replaceChildren(el('p', 'rqum-muted', 'Nobody yet: figures come from members playing with RQUM.'));
      return;
    }
    const name = (p) => RQUM.withClan(p.player_name || `#${p.player_id}`, p.stats?.clan?.v);
    // Podium: 2nd, 1st, 3rd side by side, the winner in the middle and highest.
    const podium = el('div', 'rqum-podium');
    for (const place of [2, 1, 3]) {
      const p = ranked[place - 1];
      const step = el('div', `rqum-podium__step rqum-podium__step--${place}`);
      if (p) {
        step.append(
          el('span', 'rqum-podium__medal', ['🥇', '🥈', '🥉'][place - 1]),
          el('span', 'rqum-podium__name', name(p)),
          el('span', 'rqum-podium__value', fmt(value(p))),
          diff(p),
        );
        step.title = `${decimals ? fmt(value(p)) : RQUM.formatExact(value(p))} ${unit}\n${statOrigin(p.stats[key])}`;
      }
      step.appendChild(el('span', 'rqum-podium__block', String(place)));
      podium.appendChild(step);
    }
    const list = el('ol', 'rqum-ranking__list');
    ranked.slice(3).forEach((p, i) => {
      const row = el('li', 'rqum-ranking__row');
      row.append(el('span', 'rqum-ranking__place', `${i + 4}`), el('span', 'rqum-list__name', name(p)),
        el('span', 'rqum-ranking__value', fmt(value(p))), diff(p));
      row.title = `${decimals ? fmt(value(p)) : RQUM.formatExact(value(p))} ${unit}\n${statOrigin(p.stats[key])}`;
      list.appendChild(row);
    });
    content.replaceChildren(podium, list, el('p', 'rqum-muted', `${note} +/− = change over the last 24 h.`));
  };
  for (const [key, label] of RANKINGS) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.key = key;
    b.addEventListener('click', () => show(key));
    tabs.appendChild(b);
  }
  wrap.append(tabs, content);
  show(rankingTab);
  return wrap;
};

// ---- FFA tab ----------------------------------------------------------------------
const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// The FFA tab: the members who let RQUM members attack them while they hold at least some
// gold (their ⚙ Settings), me included. opts.open = [{ player_id, player_name, stats,
// min_gold, is_me }] (RQUM.ffaOpenRows), the most gold on hand first. (rows: no longer used.)
RQUM.ffaView = (rows, opts) => {
  const wrap = el('div', 'rqum-ffa');
  const open = opts.open || [];
  wrap.appendChild(el('p', 'rqum-muted', 'Members RQUM members may attack while they hold at least the gold shown (set yours in ⚙ Settings: an amount, or 3x your GPT). ✓: they hold it, as last seen. They then appear in your Attack list whatever its filters.'));
  if (!open.length) wrap.appendChild(el('p', 'rqum-muted', 'Nobody is open right now.'));
  else wrap.appendChild(ffaList(open, opts));
  return wrap;
};

function ffaList(rows, opts) {
  const list = el('ul', 'rqum-list');
  for (const r of rows) {
    const item = el('li', 'rqum-list__item');
    const row = el('div', 'rqum-list__row');
    const v = (k) => r.stats?.[k]?.v;
    // Members open from some gold (no until): their gold on hand, ✓ when it is enough.
    const gold = typeof v('gold_on_hand') === 'number' && !r.until
      ? `holds ${RQUM.formatNumber(v('gold_on_hand'))}${v('gold_on_hand') >= r.min_gold ? ' ✓' : ''}` : null;
    const meta = [v('level') ? `Lv ${v('level')}` : null, r.min_gold > 0 ? `from ${RQUM.formatNumber(r.min_gold)} gold` : r.until ? null : 'any gold',
      gold, r.until ? `until ${clock(r.until)}` : null].filter(Boolean).join(' · ');
    const name = el('span', 'rqum-list__name', RQUM.withClan(r.player_name || `#${r.player_id}`, r.stats?.clan?.v));
    const renamed = RQUM.renamedTag(r.stats?.former_name);
    if (renamed) name.appendChild(renamed);
    if (r.is_me) name.appendChild(el('span', 'rqum-muted', ' (you)'));
    row.append(name, el('span', 'rqum-list__meta', meta));
    if (opts.add) {
      const remove = el('button', 'rqum-link-btn', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', async (e) => {
        e.stopPropagation();
        const res = await opts.add(r.player_name, 0, 0);
        if (res.ok) opts.reload();
      });
      row.appendChild(remove);
    }
    const detail = el('div', 'rqum-list__detail');
    detail.hidden = true;
    row.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      if (detail.hidden || detail.childElementCount) return;
      detail.append(RQUM.intelCard({ player_id: r.player_id, player_name: r.player_name, stats: r.stats },
        { only: ['level', 'total_offense', 'total_defense', 'spy_offense', 'spy_defense', 'gold_on_hand', 'gold_per_turn', 'army'] }),
        opts.profileLink(r.player_id));
    });
    item.append(row, detail);
    list.appendChild(item);
  }
  return list;
}

// opts.open of RQUM.ffaView: the members open from some gold (rqum_member_settings'
// attack_gold) with their stats (rows of rqum_alliance), me ({ id } or { name }) marked is_me.
RQUM.ffaOpenRows = (attackGold, players, me = {}) => players
  .filter((p) => attackGold?.[p.player_id] != null)
  .map((p) => ({ player_id: p.player_id, player_name: RQUM.cleanName(p.player_name), stats: p.stats, min_gold: Number(attackGold[p.player_id]) || 0,
    is_me: String(p.player_id) === String(me.id ?? '') || Boolean(me.name && nameKey(p.player_name) === nameKey(me.name)) }))
  .sort((a, b) => (b.stats?.gold_on_hand?.v || 0) - (a.stats?.gold_on_hand?.v || 0));

// ---- Clans tab (rows from rqum_clans_list) -----------------------------------------
// [key, default label, style of the matching player stat]. The label shown is the game's
// own tab name when captured ("Overall (avg)", "Attack"...).
const CLAN_STATS = [
  ['overall', 'Overall'], ['offense', 'Offense', 'offense'], ['defense', 'Defense', 'defense'],
  ['spy_offense', 'Spy Offense', 'spy-offense'], ['spy_defense', 'Spy Defense', 'spy-defense'],
  ['level', 'Clan Level'], ['xp', 'Clan XP'], ['warfare', 'Warfare'], ['treasury', 'Treasury'], ['members', 'Members'],
];
// A change over 24 h at least this big is a spike (highlighted).
const CLAN_SPIKE_PCT = 10;

// % change over 24 h, or null when there is no value a day earlier.
function dayChange(clan, key) {
  const now = Number(clan.stats?.[key]?.v);
  const before = Number(clan.day_before?.[key]);
  if (!Number.isFinite(now) || !Number.isFinite(before) || !before) return null;
  return ((now - before) / before) * 100;
}

function changeSpan(pct) {
  if (pct === null) return el('span', 'rqum-change rqum-change--none', '—');
  const text = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct) < 10 ? Math.abs(pct).toFixed(1) : Math.round(Math.abs(pct))}%`;
  const span = el('span', `rqum-change${pct >= 0 ? ' is-up' : ' is-down'}${Math.abs(pct) >= CLAN_SPIKE_PCT ? ' is-spike' : ''}`, text);
  span.title = 'Change over 24 hours';
  return span;
}

// One clan: each figure with its 24 h change; a tap shows its graph.
function clanCard(clan) {
  const card = el('div', 'rqum-card');
  card.appendChild(el('div', 'rqum-card__head', `${clan.members ? `${clan.members} members · ` : ''}updated ${RQUM.formatAge(clan.updated_at)} ago`));
  for (const [key, fallback, kind] of CLAN_STATS) {
    const stat = clan.stats?.[key];
    if (!stat) continue;
    const line = el('div', `rqum-card__row rqum-card__row--graph${kind ? ` rqum-card__row--${kind}` : ''}`);
    line.tabIndex = 0;
    line.setAttribute('role', 'button');
    line.setAttribute('aria-expanded', 'false');
    const label = el('span', 'rqum-card__label rqum-card__label--as-is', stat.label || fallback);
    if (kind) {
      const icon = el('img', 'rqum-card__icon');
      icon.src = RQUM.assetUrl(`icons/stats/${kind}.png`);
      icon.alt = '';
      label.prepend(icon);
    }
    line.append(label, valueSpan(Number(stat.v)), changeSpan(dayChange(clan, key)));
    const detail = el('div', `rqum-card__detail${kind ? ` rqum-card__row--${kind}` : ''}`);
    detail.hidden = true;
    const toggle = () => {
      detail.hidden = !detail.hidden;
      line.setAttribute('aria-expanded', String(!detail.hidden));
      if (!detail.hidden && !detail.childElementCount) {
        detail.appendChild(historyPanel((days) => RQUM.fetchClanHistory(clan.clan_id, key, days),
          (hour) => RQUM.deleteHistoryPoint({ clanId: clan.clan_id, stat: key, hour })));
      }
    };
    line.addEventListener('click', toggle);
    line.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    card.append(line, detail);
  }
  return card;
}

// The known members of a clan (rqum_search_clan rows), and one player's full figures. The
// extension asks background.js; the web page replaces both.
RQUM.fetchClanMembers = async (tag) => {
  const res = await RQUM.send('searchClan', { query: tag });
  if (!res.ok) throw new Error(res.error);
  return res.data || [];
};
RQUM.fetchPlayer = async (id) => {
  const res = await RQUM.send('getIntel', { playerIds: [String(id)] });
  if (!res.ok) throw new Error(res.error);
  return res.data[id] || null;
};

// A clan's members, highest level first; a tap on one opens their card.
RQUM.clanMembers = (tag) => {
  const box = el('div', 'rqum-clan-members');
  box.appendChild(el('h4', 'rqum-section-title', `Members of ${tag || 'this clan'}`));
  const list = el('ul', 'rqum-list');
  list.appendChild(el('li', 'rqum-muted', 'Loading the members…'));
  box.appendChild(list);
  if (!tag) { list.replaceChildren(el('li', 'rqum-muted', 'No clan tag known.')); return box; }
  RQUM.fetchClanMembers(tag).then((rows) => {
    const members = rows.filter((r) => RQUM.clanTag(r.clan_tag).toUpperCase() === RQUM.clanTag(tag).toUpperCase());
    list.replaceChildren();
    if (!members.length) return list.appendChild(el('li', 'rqum-muted', 'No member known yet: they appear as RQUM sees their profile or the clan page.'));
    for (const m of members) {
      const item = el('li', 'rqum-list__item');
      const row = el('div', 'rqum-list__row');
      row.append(RQUM.favStar(m.player_id, m.player_name), el('span', 'rqum-list__name', RQUM.withClan(m.player_name || `#${m.player_id}`, tag)),
        el('span', 'rqum-list__meta', [m.level != null ? `Lv ${m.level}` : null, m.updated_at ? `${RQUM.formatAge(m.updated_at)} ago` : null].filter(Boolean).join(' · ')));
      const detail = el('div', 'rqum-list__detail');
      detail.hidden = true;
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        detail.hidden = !detail.hidden;
        if (detail.hidden || detail.childElementCount) return;
        detail.appendChild(el('p', 'rqum-muted', 'Loading…'));
        try {
          const player = await RQUM.fetchPlayer(m.player_id);
          detail.replaceChildren(player ? RQUM.intelCard(player) : el('p', 'rqum-muted', 'No stats yet.'));
        } catch (err) { detail.replaceChildren(el('p', 'rqum-muted', err.message)); }
      });
      item.append(row, detail);
      list.appendChild(item);
    }
  }).catch((err) => list.replaceChildren(el('li', 'rqum-muted', err.message)));
  box.addEventListener('click', (e) => e.stopPropagation());
  return box;
};

// Also used by the big window (bigview.js).
RQUM.clanCard = clanCard;
RQUM.clanDayChange = dayChange;
RQUM.changeSpan = changeSpan;

// Every clan, strongest overall first. Each row shows the biggest 24 h change among the
// four combat figures, highlighted when it is a spike.
RQUM.clanList = (clans) => {
  if (!clans.length) {
    return el('p', 'rqum-muted', 'No clan yet: open the game\'s Clan Rankings once, or wait for the hourly reading (RQUM 0.7.12 or later).');
  }
  const list = el('ul', 'rqum-list');
  for (const clan of clans) {
    const item = el('li', 'rqum-list__item');
    const row = el('div', 'rqum-list__row');
    const name = el('span', 'rqum-list__name', `${clan.tag ? `${clan.tag} ` : ''}${clan.name || `#${clan.clan_id}`}`);
    // The combat figure that moved the most over 24 h.
    let biggest = null;
    for (const [key, fallback] of CLAN_STATS.slice(1, 5)) {
      const pct = dayChange(clan, key);
      if (pct !== null && (!biggest || Math.abs(pct) > Math.abs(biggest.pct))) biggest = { pct, label: fallback.replace('Offense', 'Off').replace('Defense', 'Def') };
    }
    const meta = el('span', 'rqum-list__meta');
    if (biggest) meta.append(`${biggest.label} `, changeSpan(biggest.pct));
    else meta.textContent = clan.members ? `${clan.members} members` : '';
    row.append(name, meta);
    const detail = el('div', 'rqum-list__detail');
    detail.hidden = true;
    row.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      if (!detail.hidden && !detail.childElementCount) detail.append(clanCard(clan), RQUM.clanMembers(clan.tag));
    });
    item.append(row, detail);
    list.appendChild(item);
  }
  const wrap = el('div');
  wrap.append(el('p', 'rqum-muted', `From the game's Clan Rankings, read every hour. ▲▼ = change over 24 h, highlighted from ${CLAN_SPIKE_PCT} %. Tap a clan for its figures and members, then a figure for its graph.`), list);
  return wrap;
};

// ---- Graphs (like the game's Daily Summary charts) ---------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART = { w: 300, h: 96, top: 8, bottom: 16, left: 2, right: 2 };

function svg(tag, attrs = {}, className) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (className) node.setAttribute('class', className);
  return node;
}

const shortDate = (d) => d.toLocaleString('en-GB', { day: 'numeric', month: 'short' });
const pointDate = (d) => d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// Axis labels, shorter still: M / B as everywhere, and k from 10,000.
function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e4 && a < 1e6) return `${+(v / 1e3).toFixed(1)}k`;
  return RQUM.formatNumber(v);
}

// Line + area + points over time; points are placed by their real time (a gap with no
// sighting is a longer straight segment, not squeezed away).
// Moving over the graph (or tapping it) shows the nearest point.
// onDelete(hour): a click on a point deletes it (after a confirmation).
RQUM.historyChart = (rows, onDelete = null) => {
  const pts = rows.map((r) => ({ t: new Date(r.hour).getTime(), v: Number(r.v), hour: r.hour }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  const wrap = el('div', 'rqum-chart');
  if (pts.length < 2) {
    wrap.appendChild(el('p', 'rqum-muted', pts.length
      ? `Only one point so far (${pointDate(new Date(pts[0].t))}): the graph fills in as the stat is seen again.`
      : 'No history yet: the graph fills in as the stat is seen.'));
    return wrap;
  }
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  let lo = Math.min(...pts.map((p) => p.v));
  let hi = Math.max(...pts.map((p) => p.v));
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const x = (t) => CHART.left + ((t - t0) / (t1 - t0)) * (CHART.w - CHART.left - CHART.right);
  const y = (v) => CHART.top + (1 - (v - lo) / (hi - lo)) * (CHART.h - CHART.top - CHART.bottom);
  const base = CHART.h - CHART.bottom;

  const chart = svg('svg', { viewBox: `0 0 ${CHART.w} ${CHART.h}`, role: 'img' }, 'rqum-chart__svg');
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  chart.append(
    svg('line', { x1: 0, y1: base, x2: CHART.w, y2: base }, 'rqum-chart__axis'),
    svg('path', { d: `${line}L${x(t1).toFixed(1)},${base}L${x(t0).toFixed(1)},${base}Z` }, 'rqum-chart__area'),
    svg('path', { d: line, 'vector-effect': 'non-scaling-stroke' }, 'rqum-chart__line'),
  );
  if (pts.length <= 60) {
    for (const p of pts) chart.appendChild(svg('circle', { cx: x(p.t), cy: y(p.v), r: 1.8 }, 'rqum-chart__dot'));
  }
  const cursor = svg('circle', { r: 3.2, cx: -10, cy: -10 }, 'rqum-chart__cursor');
  chart.appendChild(cursor);

  const values = pts.map((p) => p.v);
  const [vMin, vMax] = [Math.min(...values), Math.max(...values)];
  // Close values ("1.31M – 1.31M" says nothing): then the exact figures.
  const range = compact(vMin) === compact(vMax) && vMin !== vMax
    ? `${RQUM.formatExact(vMin)} – ${RQUM.formatExact(vMax)}`
    : `${compact(vMin)} – ${compact(vMax)}`;
  const labels = el('div', 'rqum-chart__labels');
  // Under two days, the hours ("26 Oct, 14:00"): the day alone would read the same at both ends.
  const edge = (t) => (t1 - t0 < 2 * 86400000 ? pointDate(new Date(t)) : shortDate(new Date(t)));
  labels.append(el('span', '', edge(t0)), el('span', '', range), el('span', '', edge(t1)));
  const readout = el('div', 'rqum-chart__readout', `${pts.length} points · hover or tap the graph${onDelete ? ' · click a point to delete it' : ''}`);

  // A bubble next to the nearest point: its date and exact value.
  const plot = el('div', 'rqum-chart__plot');
  const tip = el('div', 'rqum-chart__tip');
  tip.hidden = true;
  const nearest = (clientX) => {
    const box = chart.getBoundingClientRect();
    const t = t0 + ((clientX - box.left) / box.width) * (t1 - t0);
    return pts.reduce((best, q) => (Math.abs(q.t - t) < Math.abs(best.t - t) ? q : best));
  };
  const show = (clientX) => {
    const box = chart.getBoundingClientRect();
    const p = nearest(clientX);
    cursor.setAttribute('cx', x(p.t));
    cursor.setAttribute('cy', y(p.v));
    tip.replaceChildren(el('div', 'rqum-chart__tip-date', pointDate(new Date(p.t))), el('div', 'rqum-chart__tip-value', RQUM.formatExact(p.v)));
    tip.hidden = false;
    const scale = box.width / CHART.w;
    const px = x(p.t) * scale;
    // Kept inside the graph: flipped to the left of the point near the right edge.
    tip.style.left = `${Math.round(px)}px`;
    tip.style.top = `${Math.round(y(p.v) * scale)}px`;
    tip.classList.toggle('is-left', px > box.width / 2);
  };
  chart.addEventListener('pointermove', (e) => show(e.clientX));
  // A wrong point: deleted for everyone, once confirmed.
  if (onDelete) chart.addEventListener('click', async (e) => {
    const p = nearest(e.clientX);
    if (!confirm(`Delete the point of ${pointDate(new Date(p.t))} (${RQUM.formatExact(p.v)}) for everyone?`)) return;
    try { await onDelete(p.hour); } catch (err) { alert(String(err?.message || err)); }
  });
  chart.addEventListener('pointerdown', (e) => show(e.clientX));
  chart.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return; // a finger lifting keeps the bubble
    tip.hidden = true;
    cursor.setAttribute('cx', -10);
  });
  // The card row toggles on click: a tap on the graph must not close it.
  wrap.addEventListener('click', (e) => e.stopPropagation());
  plot.append(chart, tip);
  wrap.append(readout, plot, labels);
  return wrap;
};

// The graph of one stat with its period buttons (1 day, 7 days, 1 month, season).
// fetchRows(days) -> [{ hour, v }]: a player's stat, or a clan's (Clans tab).
// deleteRow(hour): deletes one point (a click on it), then the graph is read again; leaders and
// the admin only (asked once: this member's leader rank, or the admin key in this browser).
let canDeletePoints = null;
const mayDeletePoints = () => (canDeletePoints ??= (async () => {
  try {
    const [me, admin] = await Promise.all([RQUM.send('me'), RQUM.send('isAdmin')]);
    return Boolean(me?.data?.officer || admin?.data);
  } catch { return false; }
})());
function historyPanel(fetchRows, deleteRow = null) {
  const panel = el('div', 'rqum-chart-panel');
  const periods = el('div', 'rqum-chart__periods');
  const holder = el('div');
  let ticket = 0;
  const load = async (label) => {
    const mine = ++ticket;
    const days = HISTORY_PERIODS.find(([l]) => l === label)[1]();
    periods.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.period === label));
    holder.replaceChildren(el('p', 'rqum-muted', 'Loading the graph…'));
    try {
      // The database counts in whole days: under a day, the last day is asked and cut here.
      // One point per hour: the hour before the period is kept too (the change from it).
      let rows = await fetchRows(Math.max(1, Math.ceil(days)));
      if (days < 1) {
        const from = Date.now() - days * 86400000 - 3600000;
        rows = rows.filter((r) => new Date(r.hour).getTime() >= from);
      }
      const onDelete = deleteRow && (await mayDeletePoints()) && (async (hour) => { await deleteRow(hour); load(label); });
      if (mine === ticket) holder.replaceChildren(RQUM.historyChart(rows, onDelete));
    } catch (err) {
      if (mine === ticket) holder.replaceChildren(el('p', 'rqum-muted', String(err?.message || err)));
    }
  };
  for (const [label] of HISTORY_PERIODS) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.period = label;
    if (label === 'S') b.title = `Season, since ${SEASON_START.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
    b.addEventListener('click', (e) => { e.stopPropagation(); load(label); });
    periods.appendChild(b);
  }
  panel.addEventListener('click', (e) => e.stopPropagation());
  panel.append(periods, holder);
  load(HISTORY_DEFAULT_PERIOD);
  return panel;
}

// The game ranks on a card: an enemy's Overall rank and only the top 10s of the other
// leaderboards; a member's own ranks (read from their leaderboards pages) for Overall,
// Offense, Defense, Gold Stolen and Net Worth.
const MEMBER_RANKS = new Set(['rank_overall', 'rank_offense', 'rank_defense', 'rank_gold_stolen', 'rank_net_worth']);
function showRank(key, stat) {
  if (!key.startsWith('rank_')) return true;
  if (key === 'rank_overall') return true;
  if (stat?.src === 'self') return MEMBER_RANKS.has(key);
  return typeof stat?.v === 'number' && stat.v <= 10;
}

// A failed attack (or spy operation) shows the target's figure was above the attacker's: a
// floor, saved as <stat>_floor. When it is newer and higher than the last known value it is
// shown instead, as "> X"; a real value seen later takes over again.
const FLOORS = { total_defense: 'total_defense_floor', spy_defense: 'spy_defense_floor' };

// The floor of a figure when it is shown instead of it (newer, and above the figure), else null.
RQUM.floorOf = (stats, key) => {
  const floor = stats?.[FLOORS[key]];
  if (typeof floor?.v !== 'number') return null;
  const known = stats[key];
  const newer = !known?.at || new Date(floor.at) >= new Date(known.at);
  return newer && !(Number(known?.v) >= floor.v) ? floor : null;
};

function withFloors(stats) {
  const out = { ...stats };
  for (const [key, floorKey] of Object.entries(FLOORS)) {
    const floor = stats[floorKey];
    delete out[floorKey];
    if (typeof floor?.v !== 'number') continue;
    const known = stats[key];
    const newer = !known?.at || new Date(floor.at) >= new Date(known.at);
    if (newer && !(Number(known?.v) >= floor.v)) out[key] = { ...floor, floor: true, known };
  }
  return out;
}

function floorSpan(stat) {
  const span = el('span', 'rqum-card__value rqum-card__value--floor', `> ${RQUM.formatNumber(stat.v)}`);
  const what = stat.src === 'attack' ? 'An attack' : 'A spy operation';
  span.title = `${what} failed with ${RQUM.formatExact(stat.v)}: it is higher than that`
    + (stat.known ? ` (last known: ${RQUM.formatExact(stat.known.v)}, ${RQUM.formatAge(stat.known.at)} ago)` : '');
  return span;
}

// "Spy report · by Jio · 22 Oct, 00:37" (in the viewer's own time zone).
RQUM.statOrigin = (stat) => statOrigin(stat);
function statOrigin(stat) {
  const source = RQUM.SOURCE_LABELS[stat.src] || stat.src || 'unknown source';
  const when = stat.at && !Number.isNaN(new Date(stat.at).getTime())
    ? new Date(stat.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;
  return [source.charAt(0).toUpperCase() + source.slice(1), stat.by ? `by ${stat.by}` : null, when].filter(Boolean).join(' · ');
}

// ---- Leaderboards tab (rows from rqum_players_table) -------------------------------------
// The game's global leaderboards rebuilt from every player RQUM knows, one category at a
// time: rank, player (clan tag), figure and its age. Only the players whose figure is known
// are ranked (the count says how many); a minimum ("> X") is not a figure. 100 rows at a
// time; the box filters by name or clan; my row and the alliance's are marked.
// opts: { myName, pick(id, name) }
// [figure, label, the game's own rank for it]. A player whose game rank is known (the
// leaderboards' top 10, a profile's ranks: rank_*, under 3 days old) is placed at that rank;
// the places left are filled with the known figures, highest first. "Overall" has no figure:
// game ranks only.
const LEADERBOARDS = [
  ['rank_overall', 'Overall', 'rank_overall'], ['level', 'Level', 'rank_level'],
  ['total_offense', 'Offense', 'rank_offense'], ['total_defense', 'Defense', 'rank_defense'],
  ['spy_offense', 'Spy Off'], ['spy_defense', 'Spy Def'], ['gold_per_turn', 'Gold/turn'],
];
const GAME_RANK_MAX_AGE_MS = 3 * 24 * 3600e3;

// Players in leaderboard order: [{ p, rank, game }], game = placed by the game's own rank.
function leaderboardOrder(players, key, rankKey) {
  const gameRank = (p) => {
    const r = p.stats?.[rankKey];
    return rankKey && typeof r?.v === 'number' && Date.now() - new Date(r.at).getTime() < GAME_RANK_MAX_AGE_MS ? r : null;
  };
  // One player per game rank: the most recently seen one.
  const fixed = new Map();
  for (const p of players) {
    const r = gameRank(p);
    if (!r) continue;
    const other = fixed.get(r.v);
    if (!other || new Date(r.at) > new Date(gameRank(other).at)) fixed.set(r.v, p);
  }
  const placed = new Set(fixed.values());
  const value = (p) => p.stats?.[key]?.v;
  const rest = key === rankKey ? [] : players.filter((p) => !placed.has(p) && typeof value(p) === 'number')
    .sort((a, b) => value(b) - value(a) || String(a.player_name).localeCompare(String(b.player_name)));
  const out = [];
  const lastFixed = Math.max(0, ...fixed.keys());
  for (let rank = 1; rank <= lastFixed || rest.length; rank++) {
    if (fixed.has(rank)) out.push({ p: fixed.get(rank), rank, game: true });
    else if (rest.length) out.push({ p: rest.shift(), rank, game: false });
  }
  return out;
}
let leaderboardTab = LEADERBOARDS[0][0];
const LEADERBOARD_PAGE = 100;

RQUM.leaderboardView = (players, opts = {}) => {
  const wrap = el('div', 'rqum-lb');
  const tabs = el('div', 'rqum-ranking__tabs');
  const search = el('input', 'rqum-lb__search');
  search.type = 'search';
  search.placeholder = 'Filter: name or clan tag';
  const content = el('div');
  const me = String(opts.myName ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const isMe = (p) => me && String(p.player_name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === me;
  let shown = LEADERBOARD_PAGE;

  const show = () => {
    const key = leaderboardTab;
    const rankKey = LEADERBOARDS.find(([k]) => k === key)?.[2];
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.key === key));
    // Ranked among every known player; the filter only hides rows.
    const ranked = leaderboardOrder(players, key, rankKey);
    const q = search.value.trim().toLowerCase();
    const rows = ranked.filter(({ p }) => !q || String(p.player_name ?? '').toLowerCase().includes(q)
      || String(p.stats?.clan?.v ?? '').toLowerCase().includes(q));
    const mine = ranked.find(({ p }) => isMe(p));
    const kind = STAT_STYLES[key];
    const table = el('table', 'rqum-lb__table');
    for (const { p, rank, game } of rows.slice(0, shown)) {
      // The figure, else (a game rank without a known figure) a dash; the age of what is shown.
      const s = key === rankKey ? null : p.stats[key];
      const shownStat = s || p.stats[rankKey];
      const tr = el('tr', `${isMe(p) ? 'is-me' : ''} ${/\[RQUM\]/i.test(String(p.stats?.clan?.v ?? '')) ? 'is-ally' : ''}`.trim());
      const name = el('td', 'rqum-lb__name', RQUM.withClan(RQUM.cleanName(p.player_name) || `#${p.player_id}`, p.stats?.clan?.v));
      const renamed = RQUM.renamedTag(p.stats?.former_name);
      if (renamed) name.appendChild(renamed);
      const v = el('td', `rqum-lb__value${kind ? ` rqum-card__row--${kind}` : ''}`, s ? RQUM.formatNumber(s.v) : '—');
      v.title = s ? `${RQUM.formatExact(s.v)} · ${statOrigin(s)}` : 'Figure unknown: placed by its rank in the game';
      const r = el('td', `rqum-lb__rank${game ? ' is-game' : ''}`, `#${rank}`);
      r.title = game ? `The game's own rank (${statOrigin(p.stats[rankKey])})` : 'Placed by its known figure among the players RQUM knows';
      tr.append(r, name, v, el('td', `rqum-card__age ${RQUM.ageClass(shownStat.at)}`, RQUM.formatAge(shownStat.at)));
      if (opts.pick) tr.addEventListener('click', () => opts.pick(p.player_id, p.player_name));
      table.appendChild(tr);
    }
    const gameCount = ranked.filter((x) => x.game).length;
    const head = `${ranked.length} of ${players.length} known players`
      + (gameCount ? ` · ${gameCount} by their game rank (gold #)` : '')
      + (mine ? ` · you: #${mine.rank}` : '');
    content.replaceChildren(el('p', 'rqum-muted', head), table);
    if (rows.length > shown) {
      const more = el('button', 'rqum-btn rqum-lb__more', `Show more (${rows.length - shown} left)`);
      more.type = 'button';
      more.addEventListener('click', () => { shown += LEADERBOARD_PAGE; show(); });
      content.appendChild(more);
    }
    if (!rows.length) content.appendChild(el('p', 'rqum-muted', 'Nobody matches.'));
  };

  for (const [key, label] of LEADERBOARDS) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.key = key;
    b.addEventListener('click', () => { leaderboardTab = key; shown = LEADERBOARD_PAGE; show(); });
    tabs.appendChild(b);
  }
  search.addEventListener('input', () => { shown = LEADERBOARD_PAGE; show(); });
  wrap.append(tabs, search, content);
  show();
  return wrap;
};

// ---- Accent colour (⚙ Settings): the "gold" of RQUM's own window, tabs and lists ---------
// Kept with the prefs (accentColor, "#rrggbb"); applied as --rqum-accent, which rqum.css uses
// on RQUM's elements only. Follows a change made in another tab at once.
RQUM.DEFAULT_ACCENT = '#d4af37';
RQUM.applyAccent = (color) => {
  const ok = /^#[0-9a-f]{6}$/i.test(String(color ?? ''));
  document.documentElement.style.setProperty('--rqum-accent', ok ? color : RQUM.DEFAULT_ACCENT);
};
if (globalThis.chrome?.storage?.local && globalThis.chrome?.runtime?.id) {
  RQUM.getConfig().then((c) => RQUM.applyAccent(c.accentColor)).catch(() => {});
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.rqumConfig) RQUM.applyAccent(changes.rqumConfig.newValue?.accentColor);
  });
}

// ---- Battle totals with one player (from DarkThrone Enhancer): my Stats readings (stats.js) as
//      tiles. att: my figures on them (stats.attacked[id]), def: theirs on me (stats.attackers[id]),
//      spy: the spy operations both ways (stats.spies[id]). Profile page and Stats tab card. ----
RQUM.battleTotals = (att = {}, def = {}, spy = null) => {
  const n = (v) => RQUM.formatExact(v || 0);
  const wl = (w, l) => { const s = el('span'); s.append(el('span', 'is-win', `${n(w)}W`), ' · ', el('span', 'is-loss', `${n(l)}L`)); return s; };
  const tile = (label, value, sub, cls) => {
    const t = el('div', 'rqum-bt__tile');
    const v = el('div', `rqum-bt__value ${cls || ''}`);
    v.append(value);
    t.append(el('div', 'rqum-bt__label', label), v);
    if (sub) t.appendChild(el('div', 'rqum-bt__sub', sub));
    return t;
  };
  const myAtk = att.attacks || 0;
  const theirAtk = def.attacks || 0;
  const net = (att.gold || 0) - (def.gold || 0);
  const grid = el('div', 'rqum-bt');
  grid.append(
    tile('⚔️ My attacks', wl(att.wins, myAtk - (att.wins || 0)), `${n(myAtk)} total`),
    tile('💰 Gold I looted', `+${n(att.gold)}`, '', 'is-win'),
    tile('🛡️ Their attacks on me', wl(theirAtk - (def.wins || 0), def.wins), `${n(theirAtk)} total (their wins · losses)`),
    tile('🩸 Gold they looted', `−${n(def.gold)}`, '', 'is-loss'),
    tile('📊 Net gold', `${net >= 0 ? '+' : '−'}${n(Math.abs(net))}`, '', net >= 0 ? 'is-win' : 'is-loss'),
  );
  if (spy) {
    const ops = (spy.opsWon || 0) + (spy.opsLost || 0);
    grid.append(
      tile('🕵️ My spies', wl(spy.reconWon, spy.reconLost), ops ? `sabotage / assassinate: ${n(spy.opsWon)}W · ${n(spy.opsLost)}L` : 'recons'),
      tile('👁️ Their spies caught', n(spy.caught), `${n(spy.spiedMe)} got through`),
    );
  }
  return grid;
};

// ---- Stats tab (stats.js): my war statistics --------------------------------------------
// Two tables: the players I attacked (attacks, wins, gold plundered, units killed, and my
// assassinations / units assassinated / sabotages on them) and the players who attacked me
// (attacks, their wins, gold they took, my units they killed). Click a column title to sort.
// opts: { update(onPage) -> Promise<stats>, pick(id, name) }
// [key, short title, full title (hover)]: short titles keep the tables narrow.
const WAR_TABLES = [
  ['attacked', '⚔️ I attacked', [
    ['attacks', 'Atk', 'Attacks'], ['wins', 'Won', 'Attacks won'], ['gold', 'Gold', 'Gold plundered'], ['killed', 'Kills', 'Units killed in attacks'],
    ['assassinations', 'Assn', 'Assassinations'], ['assassinated', 'Assn units', 'Units assassinated'], ['sabotages', 'Sabo', 'Sabotages'],
  ]],
  ['attackers', '🛡️ Attacked me', [
    ['attacks', 'Atk', 'Their attacks on me'], ['wins', 'Won', 'Their attacks won'], ['gold', 'Gold', 'Gold they took'],
    ['killed', 'My losses', 'My units they killed'], ['lost', 'Kills', 'Units I killed defending'],
  ]],
];

let warTab = 'attacked';
let warScope = 'me'; // 'me', 'clan' (every member's statistics added up) or 'm:<player id>' (one member's)

// Every member's statistics (rqum_war_clan rows) added up into one, as if one player.
function mergeWarStats(rows) {
  const out = { attacked: {}, attackers: {}, daily: {}, members: rows.length };
  const NUM = ['attacks', 'wins', 'gold', 'killed', 'lost', 'assassinations', 'assassinated', 'sabotages'];
  for (const r of rows) {
    const by = RQUM.cleanName(r.name);
    for (const key of ['attacked', 'attackers']) {
      for (const [id, p] of Object.entries(r.stats?.[key] || {})) {
        const q = out[key][id] ??= { name: p.name, recent: [], days: {} };
        for (const k of NUM) q[k] = (q[k] || 0) + (p[k] || 0);
        q.recent = [...q.recent, ...(p.recent || []).map((b) => ({ ...b, by }))].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 10);
        for (const [h, g] of Object.entries(p.days || {})) q.days[h] = (q.days[h] || 0) + g;
        for (const [h, f] of Object.entries(p.hours || {})) {
          const t = (q.hours ??= {})[h] ??= {};
          for (const [k, v] of Object.entries(f)) t[k] = (t[k] || 0) + v;
        }
      }
    }
    for (const [feed, byHour] of Object.entries(r.stats?.daily || {})) {
      const into = out.daily[feed] ??= {};
      for (const [h, d] of Object.entries(byHour)) {
        const t = into[h] ??= { attacks: 0, gold: 0, killed: 0 };
        t.attacks += d.attacks; t.gold += d.gold; t.killed += d.killed;
      }
    }
  }
  return out;
}

// The last battles with one player (Stats tab ▸), newest first.
function battleList(p, key) {
  const list = (p.recent || []);
  if (!list.length) return [el('p', 'rqum-muted', 'No battle date known yet (assassinations and sabotages only).')];
  const mine = key === 'attacked';
  const clan = list.some((b) => b.by);
  // No percentage widths: inside the main table they make Chrome stretch it to 1,000,000 px.
  const cols = [...(clan ? [['Member']] : []), ['When'], ['Result'],
    [mine ? 'Gold' : 'Gold taken', 18, 1], [mine ? 'Kills' : 'My losses', 14, 1], [mine ? 'My losses' : 'Kills', 14, 1]];
  const table = el('table', 'rqum-war__battles');
  const head = el('tr');
  cols.forEach(([h, , num]) => head.appendChild(el('th', num ? 'is-num' : '', h)));
  table.append(head);
  for (const b of list) {
    const tr = el('tr');
    const when = new Date(b.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (clan) tr.appendChild(el('td', '', b.by || ''));
    tr.append(el('td', '', when), el('td', b.won ? 'is-win' : 'is-loss', b.won ? 'Win' : 'Loss'),
      el('td', 'is-num', b.gold ? RQUM.formatNumber(b.gold) : '—'), el('td', 'is-num', RQUM.formatExact(b.killed || 0)),
      el('td', 'is-num', RQUM.formatExact(b.lost || 0)));
    table.appendChild(tr);
  }
  return [table];
}
let warQuery = ''; // the Stats tab's search
let warHidden = {}; // table -> hidden column keys (⚙), kept in this browser
globalThis.chrome?.storage?.local?.get('rqumWarHidden').then((r) => { warHidden = r.rqumWarHidden || {}; }).catch(() => {});

RQUM.warStatsView = (stats, opts) => {
  const wrap = el('div', 'rqum-war');
  const top = el('div', 'rqum-war__top');
  const note = el('span', 'rqum-muted', stats?.updatedAt ? `Updated ${RQUM.formatAge(stats.updatedAt)} ago` : 'First reading: your whole history, page by page…');
  // ⟳ Update: a small button next to ⚙ (on top until the first reading).
  const go = el('button', 'rqum-war__gear rqum-war__update', '⟳');
  go.type = 'button';
  go.title = 'Update: read the new reports';
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const fresh = await opts.update((feed, page, last) => { note.textContent = `Reading ${feed} reports, page ${page} / ${last}…`; });
      wrap.replaceWith(RQUM.warStatsView(fresh, opts));
    } catch (err) {
      note.textContent = err.message;
      go.disabled = false;
    }
  });
  // 👤 a menu: my statistics (default) or one member's, among those who sent theirs; 👥 the
  // whole clan's (every member's, added up).
  const clanRows = opts.clan ? (opts.clanRows ??= opts.clan().catch(() => [])) : Promise.resolve([]);
  const scope = el('div', 'rqum-ranking__tabs rqum-war__scope');
  const who = el('select', `rqum-war__who${warScope !== 'clan' ? ' is-active' : ''}`);
  // "Whole clan" on: the menu shows "👤 Who?" so that choosing Me is a change too.
  if (warScope === 'clan') { const o = el('option', '', '👤 Who?'); o.value = ''; o.hidden = true; who.appendChild(o); }
  const meOption = el('option', '', '👤 Me');
  meOption.value = 'me';
  who.appendChild(meOption);
  const myId = String(RQUM.parsers?.myPlayerId?.(document) ?? '');
  clanRows.then((rows) => {
    rows.filter((r) => String(r.player_id) !== myId)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }))
      .forEach((r) => { const o = el('option', '', `👤 ${RQUM.cleanName(r.name)}`); o.value = `m:${r.player_id}`; who.appendChild(o); });
    who.value = warScope === 'clan' ? '' : warScope;
    if (who.value !== warScope && warScope !== 'clan') who.value = 'me';
  });
  who.addEventListener('change', () => { warScope = who.value; wrap.replaceWith(RQUM.warStatsView(stats, opts)); });
  const all = el('button', warScope === 'clan' ? 'is-active' : '', '👥 Whole clan');
  all.type = 'button';
  all.addEventListener('click', () => { warScope = 'clan'; wrap.replaceWith(RQUM.warStatsView(stats, opts)); });
  scope.append(who, all);
  top.append(note);
  if (!stats) top.prepend(go);
  wrap.append(top);
  if (opts.clan) wrap.appendChild(scope);
  if (!stats) return wrap;
  // Reports read against the totals the game shows ("of 488 battles"): any gap is said.
  const LABELS = { outgoing: 'attacks', incoming: 'attacks on me', assassinate: 'assassinations', sabotage: 'sabotages', spyOut: 'my spy ops', spyIn: 'spy ops on me (the anonymous ones not counted)' };
  const check = Object.entries(stats.expected || {}).map(([f, n]) => {
    const got = stats.read?.[f] || 0;
    return `${LABELS[f] || f}: ${got}${got === n ? ' ✓' : ` of ${n}`}`;
  });
  if (check.length) top.appendChild(el('span', 'rqum-muted', `· Reports read — ${check.join(' · ')}`));

  // Two sub-tabs (players I attacked / who attacked me), and ⚙ to choose the columns shown
  // (kept in this browser, per table).
  const tabs = el('div', 'rqum-ranking__tabs rqum-war__tabs');
  const gear = el('button', 'rqum-war__gear', '⚙');
  gear.type = 'button';
  gear.title = 'Choose the figures shown';
  const picker = el('div', 'rqum-war__picker');
  picker.hidden = true;
  gear.addEventListener('click', () => { picker.hidden = !picker.hidden; });
  const content = el('div');
  // "Whole clan": "We attacked" / "Attacked us".
  const CLAN_TITLES = { attacked: '⚔️ We attacked', attackers: '🛡️ Attacked us' };
  for (const [key, title] of WAR_TABLES) {
    const b = el('button', '', warScope === 'clan' ? CLAN_TITLES[key] : title);
    b.type = 'button';
    b.dataset.key = key;
    b.addEventListener('click', () => { warTab = key; show(); });
    tabs.appendChild(b);
  }
  tabs.append(go, gear);
  wrap.append(tabs, picker, content);

  const hidden = (key) => new Set(warHidden[key] || []);
  const saveHidden = () => globalThis.chrome?.storage?.local?.set({ rqumWarHidden: warHidden })?.catch?.(() => {});

  // The figures shown: mine, or the clan's (loaded once); the clan tags of the players.
  let data = stats;
  let clanTags = {};
  async function loadExtras() {
    if (warScope === 'clan' && opts.clan) {
      content.replaceChildren(el('p', 'rqum-muted', 'Loading the clan…'));
      const rows = await clanRows;
      data = mergeWarStats(rows);
      note.textContent = `${rows.length} member${rows.length === 1 ? '' : 's'} with RQUM ${rows.length ? '(their figures as of their last Stats reading)' : ''}`;
    } else if (warScope.startsWith('m:') && opts.clan) {
      content.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
      const row = (await clanRows).find((r) => `m:${r.player_id}` === warScope);
      if (!row) { warScope = 'me'; return; }
      data = { ...row.stats, attacked: row.stats?.attacked || {}, attackers: row.stats?.attackers || {} };
      const memberName = RQUM.cleanName(row.name);
      // "⚔️ Rage attacked" / "🛡️ Attacked Rage".
      const titles = { attacked: `⚔️ ${memberName} attacked`, attackers: `🛡️ Attacked ${memberName}` };
      tabs.querySelectorAll('button[data-key]').forEach((b) => { b.textContent = titles[b.dataset.key] || b.textContent; });
      note.textContent = `${memberName}'s figures, as of their last Stats reading (${RQUM.formatAge(row.updated_at)} ago)`;
    }
    const ids = [...new Set(['attacked', 'attackers'].flatMap((k) => Object.keys(data[k] || {})))].filter((id) => /^\d+$/.test(id));
    clanTags = opts.clanOf ? await opts.clanOf(ids).catch(() => ({})) : {};
  }

  function show() {
    if (!WAR_TABLES.some(([k]) => k === warTab)) warTab = WAR_TABLES[0][0];
    gear.hidden = false;
    const [key, , allCols] = WAR_TABLES.find(([k]) => k === warTab) || WAR_TABLES[0];
    tabs.querySelectorAll('button[data-key]').forEach((b) => b.classList.toggle('is-active', b.dataset.key === key));
    // The column picker of this table.
    picker.replaceChildren(...allCols.map(([k, , full]) => {
      const label = el('label', 'rqum-war__pick');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = !hidden(key).has(k);
      box.addEventListener('change', () => {
        const h = hidden(key);
        if (box.checked) h.delete(k); else h.add(k);
        warHidden[key] = [...h];
        saveHidden();
        drawTable();
      });
      label.append(box, ` ${full}`);
      return label;
    }));
    const rows = Object.entries(data[key] || {}).map(([id, p]) => ({ id, ...p }))
      .filter((p) => allCols.some(([k]) => p[k]));
    let sortKey = allCols.find(([k]) => k === 'gold') ? 'gold' : allCols[0][0];
    const table = el('table', 'rqum-war__table');
    // 🔍 Filter by name or clan tag (kept when the sub-tab changes).
    const search = el('input', 'rqum-lb__search rqum-war__search');
    search.type = 'search';
    search.placeholder = 'Search: name or clan tag';
    search.value = warQuery;
    search.addEventListener('input', () => { warQuery = search.value; drawTable(); });
    const count = el('p', 'rqum-muted');
    function drawTable() {
      const q = warQuery.trim().toLowerCase();
      const shown = q ? rows.filter((p) => `${p.name || ''} ${clanTags[p.id] || ''}`.toLowerCase().includes(q)) : rows;
      count.textContent = q ? `${shown.length} of ${rows.length} players` : `${rows.length} player${rows.length === 1 ? '' : 's'}`;
      const cols = allCols.filter(([k]) => !hidden(key).has(k));
      if (!cols.some(([k]) => k === sortKey) && cols.length) sortKey = cols[0][0];
      rows.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0) || String(a.name).localeCompare(String(b.name)));
      const head = el('tr');
      head.appendChild(el('th', '', 'Player'));
      for (const [k, label, full] of cols) {
        const th = el('th', `is-num${k === sortKey ? ' is-sorted' : ''}`, label);
        th.title = `${full} (click: sort)`;
        th.addEventListener('click', () => { sortKey = k; drawTable(); });
        head.appendChild(th);
      }
      const sum = el('tr', 'rqum-war__total');
      sum.appendChild(el('td', '', 'Total'));
      for (const [k] of cols) sum.appendChild(el('td', 'is-num', RQUM.formatNumber(shown.reduce((t, p) => t + (p[k] || 0), 0))));
      const body = shown.flatMap((p) => {
        const tr = el('tr');
        // In the small window, names cut after 5 characters ("Charm…"), whole on hover.
        const full = p.name || `#${p.id}`;
        const short = opts.compact && [...full].length > 5 ? `${[...full].slice(0, 5).join('')}…` : full;
        // The clan tag before the name, as in the other tabs ("[TGO] Charm…").
        const name = el('td', 'rqum-war__name', RQUM.withClan(short, clanTags[p.id]));
        name.title = RQUM.withClan(full, clanTags[p.id]);
        // ▸: the last 10 battles with this player, and the gold over time.
        const fold = el('button', 'rqum-war__fold', '▸');
        fold.type = 'button';
        fold.title = 'Last battles with this player';
        name.prepend(fold);
        tr.appendChild(name);
        for (const [k] of cols) {
          const td = el('td', 'is-num', p[k] ? RQUM.formatNumber(p[k]) : '');
          if (p[k] && td.textContent !== RQUM.formatExact(p[k])) td.title = RQUM.formatExact(p[k]);
          tr.appendChild(td);
        }
        const detail = el('tr', 'rqum-war__detail');
        detail.hidden = true;
        const cell = el('td');
        cell.colSpan = cols.length + 1;
        detail.appendChild(cell);
        fold.addEventListener('click', (e) => {
          e.stopPropagation();
          detail.hidden = !detail.hidden;
          fold.textContent = detail.hidden ? '▸' : '▾';
          if (!detail.hidden && !cell.childElementCount) cell.append(...battleList(p, key));
        });
        tr.addEventListener('click', () => select(p, key, tr));
        if (selected?.id === p.id && selected.key === key) tr.classList.add('is-selected');
        return [tr, detail];
      });
      table.replaceChildren(head, sum, ...body);
    }
    drawTable();
    const scroll = el('div', 'rqum-war__scroll');
    scroll.appendChild(table);
    const layout = el('div', `rqum-war__layout${opts.compact ? ' is-compact' : ''}`);
    const left = el('div', 'rqum-war__left');
    left.append(...(rows.length ? [search, count, scroll] : [el('p', 'rqum-muted', 'Nobody.')]));
    layout.append(left, side);
    content.replaceChildren(layout);
    // The first player of the table is chosen at first, and when the sub-tab changes; in the
    // small window nobody until a player is clicked (the card and its graph take room there).
    if (opts.compact && selected?.key !== key) { selected = null; side.replaceChildren(); }
    else if ((!selected || selected.key !== key) && rows[0]) select(rows[0], key, table.querySelector('tr:nth-child(3)'));
    else paintSide();
  }

  // ---- The side panel: the chosen player, a graph of the figure chosen ----------------
  const side = el('div', 'rqum-war__side');
  let selected = null;
  let sideStat = 'gold';
  const SIDE_STATS = {
    attacked: [['gold', '💰 Gold'], ['attacks', '⚔️ Attacks'], ['killed', '💀 Kills'], ['lost', '🩸 Losses'], ['assassinated', '🗡️ Assassinated'], ['sabotages', '💥 Sabotages']],
    attackers: [['gold', '💰 Gold taken'], ['attacks', '⚔️ Attacks'], ['killed', '🩸 My losses'], ['lost', '💀 Kills']],
  };
  function select(p, key, tr) {
    selected = { ...p, key };
    content.querySelectorAll('.rqum-war__table tr.is-selected').forEach((r) => r.classList.remove('is-selected'));
    tr?.classList.add('is-selected');
    paintSide();
  }
  // Same look as the RQUM tab's card: one line per figure (label, value); a tap on a line opens
  // its graph (added up over time) right under it.
  function paintSide() {
    if (!selected) { side.replaceChildren(); return; }
    const choices = SIDE_STATS[selected.key] || SIDE_STATS.attacked;
    if (sideStat !== null && !choices.some(([k]) => k === sideStat)) sideStat = choices[0][0];
    const card = el('div', 'rqum-card');
    card.appendChild(el('div', 'rqum-card__title', RQUM.withClan(selected.name || `#${selected.id}`, clanTags[selected.id])));
    const last = selected.recent?.[0]?.at;
    card.appendChild(el('div', 'rqum-card__head', last ? `Last battle ${RQUM.formatAge(last)} ago` : ' '));
    // Battle totals with them (both ways) on top of the card.
    card.appendChild(RQUM.battleTotals(data.attacked?.[selected.id], data.attackers?.[selected.id], data.spies?.[selected.id] || null));
    for (const [k, label] of choices) {
      const line = el('div', 'rqum-card__row rqum-card__row--graph');
      line.tabIndex = 0;
      line.append(el('span', 'rqum-card__label', label), el('span', 'rqum-card__value', RQUM.formatNumber(selected[k] || 0)), el('span', 'rqum-card__age', ''));
      const detail = el('div', 'rqum-card__detail');
      detail.hidden = k !== sideStat;
      if (!detail.hidden) {
        let total = 0;
        const series = Object.keys(selected.hours || {}).sort()
          .map((h) => ({ hour: `${h}:00:00Z`, v: (total += selected.hours[h][k] || 0) }));
        detail.append(el('div', '', `${label}, added up over time`), RQUM.historyChart(series));
      }
      line.addEventListener('click', () => { sideStat = k === sideStat ? null : k; paintSide(); });
      card.append(line, detail);
    }
    const profile = el('a', 'rqum-war__side-link', 'Open card →');
    profile.href = '#';
    profile.addEventListener('click', (e) => { e.preventDefault(); opts.pick?.(selected.id, selected.name); });
    card.appendChild(profile);
    side.replaceChildren(card);
  }

  loadExtras().then(show, show);
  return wrap;
};
