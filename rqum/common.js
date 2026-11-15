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
  signedInHere ??= RQUM.send('getStatus').then(async (res) => {
    const name = res.ok ? res.data.signedIn : null;
    const link = document.querySelector('.game-header .user-name');
    const playing = link ? RQUM.parsers.playerName(link) : null;
    if (!name) return { ok: false, name: null, playing, reason: 'signed-out' };
    if (playing && nameKey(playing) !== nameKey(name)) {
      // Renamed in the game? The database moves the key to the new name, else refuses it.
      const again = await RQUM.send('relogin', { name: playing });
      if (again.ok) return { ok: true, name: again.data.name, playing };
      return { ok: false, name, playing, reason: 'other-player' };
    }
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
RQUM.SOURCE_LABELS = { profile: 'profile', recon: 'spy report', attack: 'attack report', defense: 'defense report', list: 'player list', rankings: 'rankings', manual: 'manual entry', self: 'their own RQUM', caught: 'spy caught', protection: 'gold protection (tick)', computed: 'plundered ÷ lost' };

// Stats shown first in a card, in this order; any other stat follows.
const STAT_ORDER = [
  // The ranks right after the main figures: a member's card has more stats than
  // CARD_MAX_STATS, and ranks placed at the end were cut off.
  'level', 'total_offense', 'total_defense', 'spy_offense', 'spy_defense', 'gold_per_turn',
  'rank_overall', 'rank_offense', 'rank_defense', 'rank_level', 'rank_gold_stolen', 'rank_net_worth',
  'rank_attack_wins', 'rank_total_kills', 'rank_defense_wins', 'rank_fort_damage', 'rank_richest', 'rank_gold_spent',
  'wealth', 'gold_plundered', 'gold_lost', 'gold_ratio', 'units_killed', 'units_lost', 'kd_ratio', 'attack_wins', 'sabotages', 'assassin_kills',
  'gold_on_hand', 'army', 'population', 'fort_pct', 'clan',
];
// Stats with an hourly history (supabase/schema.sql, rqum_history): a tap shows their graph.
RQUM.ALLIANCE_STATS = [
  'level', 'total_offense', 'total_defense', 'spy_offense', 'spy_defense', 'wealth', 'gold_per_turn', 'gold_plundered',
  'gold_lost', 'gold_ratio', 'units_killed', 'units_lost', 'kd_ratio', 'attack_wins', 'sabotages', 'assassin_kills',
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
  kd_ratio: 'K/D Ratio', gold_plundered: 'Total Gold Plundered', gold_lost: 'Total Gold Loss', gold_ratio: 'Gold Ratio', gold_per_turn: 'Gold per Turn',
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
// Used by the floating panel and every list; the same card wherever it is opened.
// Gold ratio (gold plundered ÷ gold lost) worked out from the two figures when both are known,
// so it shows for every player, RQUM or not; the newer of the two dates it.
RQUM.withGoldRatio = (stats = {}) => {
  const pl = Number(stats.gold_plundered?.v);
  const lo = Number(stats.gold_lost?.v);
  if (!(pl > 0 && lo > 0)) return stats;
  const at = [stats.gold_plundered.at, stats.gold_lost.at].filter(Boolean).sort().pop();
  if (stats.gold_ratio?.at && at && stats.gold_ratio.at >= at) return stats;
  return { ...stats, gold_ratio: { ...stats.gold_plundered, v: Math.round(pl / lo * 100) / 100, at, src: 'computed' } };
};

// My own figures (offense, defense), for the ratios of a player's card:
// in the game, my player's line in the database (kept 5 minutes); the web page replaces it.
let myFiguresCache = null;
RQUM.myFigures = async () => {
  if (myFiguresCache && Date.now() - myFiguresCache.at < 5 * 60000) return myFiguresCache.stats;
  const me = RQUM.parsers?.myPlayerId?.(document);
  if (!me || !RQUM.send) return null;
  const res = await RQUM.send('getIntel', { playerIds: [String(me)] }).catch(() => null);
  const stats = res?.ok ? res.data?.[me]?.stats || null : null;
  myFiguresCache = { at: Date.now(), stats, id: String(me) };
  return stats;
};

// A player's card: my ratios with them, both ways. Attack: my offense ÷ their defense (above 1, I
// win); Defense: their offense ÷ my defense (below 1, they lose against me). Their figure may be a floor ("> X": a ratio at most). Not on my own card.
function ratioLine(card, player) {
  const box = el('div', 'rqum-card__ratios');
  box.hidden = true;
  card.appendChild(box);
  RQUM.myFigures().then((mine) => {
    if (!mine || String(player.player_id) === myFiguresCache?.id) return box.remove();
    const st = player.stats || {};
    const val = (o, k) => {
      const fl = RQUM.floorOf?.(o, k);
      if (fl) return { v: fl.v, floor: true };
      return typeof o?.[k]?.v === 'number' ? { v: o[k].v, floor: false } : null;
    };
    const chip = (label, a, b, good, title) => {
      const c = el('span', 'rqum-card__ratio');
      if (!a || !b || !b.v) {
        c.append(`${label} ?`);
        c.title = `${title}: not known`;
        return c;
      }
      const r = a.v / b.v;
      // A floor on their side: my ratio is at most this (Attack) or at least this (Defense).
      const approx = (a.floor || b.floor) ? (good === 'high' ? '≤' : '≥') : '×';
      const ok = good === 'high' ? r > 1 : r < 1;
      c.append(`${label} `, el('strong', ok ? 'is-win' : 'is-loss', `${approx}${r < 10 ? r.toFixed(2) : r.toFixed(1)}`));
      c.title = `${title}: ${RQUM.formatExact(a.v)} ÷ ${RQUM.formatExact(b.v)}${ok ? (good === 'high' ? ' (you win)' : ' (they lose)') : (good === 'high' ? ' (you lose)' : ' (they win)')}${a.floor || b.floor ? ' — one figure is only a minimum' : ''}`;
      return c;
    };
    box.append(
      chip('⚔️ Atk', val(mine, 'total_offense'), val(st, 'total_defense'), 'high', 'My offense ÷ their defense'),
      chip('🛡️ Def', val(st, 'total_offense'), val(mine, 'total_defense'), 'low', 'Their offense ÷ my defense'),
    );
    box.hidden = false;
  }, () => box.remove());
}

RQUM.intelCard = (player, options = {}) => {
  const card = el('div', 'rqum-card');
  card.appendChild(el('div', 'rqum-card__title', RQUM.withClan(player.player_name || `#${player.player_id}`, player.stats?.clan?.v)));
  const renamed = RQUM.renamedTag(player.stats?.former_name, true);
  if (renamed) card.appendChild(renamed);
  const identity = identityLine(player.stats || {});
  if (identity) card.appendChild(identity);
  card.appendChild(el('div', 'rqum-card__head',
    `Updated ${RQUM.formatAge(player.updated_at)} ago${player.updated_by ? ` by ${player.updated_by}` : ''}`));
  ratioLine(card, player);
  battleFold(card, player.player_id);

  // The same card everywhere (RQUM, Players, Ranking, big window...): options.only is ignored.
  const order = STAT_ORDER;
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  const stats = withFloors(RQUM.withGoldRatio(player.stats || {}));
  // Ignored stats saved by an older version stay hidden.
  const entries = Object.entries(stats)
    .filter(([k, st]) => showRank(k, st))
    .filter(([k]) => !RQUM.parsers.IGNORED_STATS.has(k) && !k.startsWith('fort_hp') && !k.startsWith('former_') && !CARD_TOP.has(k) && !REPORT_FOLDS.some(([, keys]) => keys.includes(k))
)
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
  reportFolds(card, player.stats || {});
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
  ['gold_ratio', '⚖️ Gold ratio', 'gold plundered ÷ gold lost', 'Gold plundered ÷ gold lost to attacks this season (the game\'s Daily Summary).', 2],
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
    const value = (p) => Number(RQUM.withGoldRatio(p.stats || {})[key]?.v) || 0;
    const fmt = (v) => (decimals ? v.toFixed(decimals) : RQUM.formatNumber(v));
    // Gold ratio: the two figures it is worked out from.
    const calc = (p) => (key === 'gold_ratio' && p.stats?.gold_plundered && p.stats?.gold_lost
      ? `\n${RQUM.formatExact(Number(p.stats.gold_plundered.v))} plundered ÷ ${RQUM.formatExact(Number(p.stats.gold_lost.v))} lost` : '');
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
        step.title = `${decimals ? fmt(value(p)) : RQUM.formatExact(value(p))} ${unit}${calc(p)}\n${statOrigin(RQUM.withGoldRatio(p.stats || {})[key])}`;
      }
      step.appendChild(el('span', 'rqum-podium__block', String(place)));
      podium.appendChild(step);
    }
    const list = el('ol', 'rqum-ranking__list');
    ranked.slice(3).forEach((p, i) => {
      const row = el('li', 'rqum-ranking__row');
      row.append(el('span', 'rqum-ranking__place', `${i + 4}`), el('span', 'rqum-list__name', name(p)),
        el('span', 'rqum-ranking__value', fmt(value(p))), diff(p));
      row.title = `${decimals ? fmt(value(p)) : RQUM.formatExact(value(p))} ${unit}${calc(p)}\n${statOrigin(RQUM.withGoldRatio(p.stats || {})[key])}`;
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

// ---- Hit List tab ------------------------------------------------------------------
// The game's Hit List (read from the clan page by a member's extension and shared through the
// database, with the game's own figures) and the targets added in RQUM by hand, in one list.
// RQUM.hitListGame(doc) reads the clan page -> entries; RQUM.hitListView(data, opts) draws.

// The game's clan page (/clan, its Hit List tab) -> [{ id, name, level, game, added, by, tot,
// attackers, intel }].
RQUM.hitListGame = (doc) => {
  const txt = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();
  const idOf = (a) => (String(a?.getAttribute('href') || '').match(/\/game\/player\/(\d+)/) || [])[1];
  const num = (n) => Number(String(n?.querySelector('[data-full]')?.getAttribute('data-full') || txt(n)).replace(/[^\d]/g, '')) || 0;
  const out = [];
  for (const row of doc.querySelectorAll('.hitlist-entries .hitlist-row')) {
    const link = row.querySelector('.hitlist-target-name');
    const id = idOf(link);
    if (!id) continue;
    const tot = { attacks: 0, wins: 0, gold: 0, killed: 0, ops: 0, opsWon: 0 };
    let added = '';
    let by = '';
    // "12W / 12 hits", "27.23M gold", "682 kills", "11W / 11 spy ops", then when it was added.
    row.querySelectorAll('.hitlist-stats .hitlist-stat').forEach((st) => {
      const label = txt(st.querySelector('.hitlist-stat-label')).toLowerCase();
      const v = [...st.querySelectorAll('.hitlist-stat-value')].map(num);
      if (!v.length) { added = txt(st.querySelector('.hitlist-stat-label')); by = (st.querySelector('[title]')?.getAttribute('title') || '').replace(/^by\s+/i, ''); return; }
      if (label === 'hits') { tot.wins = v[0]; tot.attacks = v[1] ?? v[0]; } else if (label === 'gold') tot.gold = v[0];
      else if (label === 'kills') tot.killed = v[0]; else if (label === 'spy ops') { tot.opsWon = v[0]; tot.ops = v[1] ?? v[0]; }
    });
    // Two tables: "Attackers who hit …" (rows with an Attacker cell) and "Spies who hit …" (Spy).
    const attackers = [...row.querySelectorAll('.hitlist-detail-table tbody tr')].filter((tr) => tr.querySelector('td[data-label="Attacker"]')).map((tr) => {
      const cell = (l) => tr.querySelector(`td[data-label="${l}"]`);
      const wl = [...(cell('W/L')?.querySelectorAll('span') || [])].map(num);
      return { id: idOf(cell('Attacker')?.querySelector('a')), name: txt(cell('Attacker')), attacks: num(cell('Attacks')), wins: wl[0] || 0, losses: wl[1] || 0,
        killed: num(cell('Kills')), gold: num(cell('Gold Stolen')), xp: num(cell('XP Gained')), fort: num(cell('Fort Dmg')), last: txt(cell('Last Hit')) };
    });
    const spies = [...row.querySelectorAll('.hitlist-detail-table tbody tr')].filter((tr) => tr.querySelector('td[data-label="Spy"]')).map((tr) => {
      const cell = (l) => tr.querySelector(`td[data-label="${l}"]`);
      const wl = [...(cell('W/L')?.querySelectorAll('span') || [])].map(num);
      return { id: idOf(cell('Spy')?.querySelector('a')), name: txt(cell('Spy')), ops: num(cell('Ops')), wins: wl[0] || 0, losses: wl[1] || 0, recon: num(cell('Recon')),
        sabotage: num(cell('Sabotage')), assassin: num(cell('Assassin.')), killed: num(cell('Kills')), fort: num(cell('Fort Dmg')), last: txt(cell('Last Op')) };
    });
    out.push({ id, name: txt(link), level: txt(row.querySelector('.hitlist-level')), game: true, added, by, tot, attackers, spies,
      intel: row.querySelector('.hitlist-actions a[href*="/intel/"]')?.getAttribute('href') || null });
  }
  return out;
};

// data: { game: entries | null (RQUM.hitListGame), gameAt: when the game's list was read,
//         rqum: rows of rqum_hitlist, members: rows of rqum_war_clan, me: rqum_me, known: { id: player } }.
// opts: { big, external (web page), pick(id, name), profileHref(id), gameHref(path), search(query) -> rows,
//         add(id, name, note), remove(id), reload(), error(message) }.
RQUM.hitListView = (data, opts) => {
  const members = data.members || [];
  const myName = String(data.me?.name || '').toLowerCase();
  const leader = !!data.me?.officer;
  const known = data.known || {};
  const hourOf = (iso) => new Date(iso).toISOString().slice(0, 13);
  const zero = () => ({ attacks: 0, wins: 0, gold: 0, killed: 0, ops: 0, opsWon: 0 });
  const entries = new Map((data.game || []).map((e) => [String(e.id), { ...e, id: String(e.id), attackers: [...(e.attackers || [])] }]));

  // An RQUM target: a member's hits on it since an hour, from their hourly figures.
  function since(m, id, from) {
    const out = { ...zero(), last: null };
    for (const [h, v] of Object.entries(m.stats?.attacked?.[id]?.hours || {})) {
      if (h < from) continue;
      out.attacks += v.attacks || 0; out.wins += v.wins || 0; out.gold += v.gold || 0; out.killed += v.killed || 0;
      if (v.attacks && (!out.last || h > out.last)) out.last = h;
    }
    for (const [h, v] of Object.entries(m.stats?.spies?.[id]?.hours || {})) {
      if (h < from) continue;
      out.opsWon += (v.reconWon || 0) + (v.opsWon || 0);
      out.ops += (v.reconWon || 0) + (v.opsWon || 0) + (v.reconLost || 0) + (v.opsLost || 0);
    }
    return out;
  }
  for (const t of data.rqum || []) {
    const id = String(t.target_id);
    const mine = { rqum: true, note: t.note, rqumBy: t.added_by, removable: leader || String(t.added_by || '').toLowerCase() === myName };
    const e = entries.get(id);
    // Also on the game's list: the game's figures, RQUM's note and ✕.
    if (e) { Object.assign(e, mine); continue; }
    const from = hourOf(t.added_at);
    const rows = members.map((m) => ({ m, s: since(m, id, from) })).filter((r) => r.s.attacks || r.s.ops);
    const tot = rows.reduce((a, { s }) => { for (const k of Object.keys(a)) a[k] += s[k]; return a; }, zero());
    entries.set(id, { id, name: t.target_name || `#${id}`, game: false, ...mine, added: `${RQUM.formatAge(t.added_at)} ago`, by: t.added_by, tot,
      attackers: rows.map(({ m, s }) => ({ id: String(m.player_id), name: m.name, attacks: s.attacks, wins: s.wins, losses: s.attacks - s.wins, killed: s.killed, gold: s.gold,
        ops: `${s.opsWon} / ${s.ops}`, last: s.last ? `${RQUM.formatAge(`${s.last}:00:00Z`)} ago` : '—', readAgo: RQUM.formatAge(m.updated_at) })) });
  }
  const targets = [...entries.values()].sort((a, b) => b.tot.gold - a.tot.gold);
  targets.forEach((t) => t.attackers.sort((a, b) => b.gold - a.gold || b.attacks - a.attacks));

  const wrap = el('div', `rqum-hit${opts.big ? ' rqum-hit--big' : ''}`);
  const head = el('div', 'rqum-hit__head');
  const reload = el('button', 'rqum-link-btn', '🔄');
  reload.type = 'button';
  reload.title = 'Read again';
  reload.addEventListener('click', () => opts.reload());
  head.append(el('strong', '', `🎯 Hit List · ${targets.length} target${targets.length === 1 ? '' : 's'}`), reload);
  const manage = el('a', '', 'Game\'s list →');
  manage.href = opts.gameHref('/clan#hitlist');
  manage.title = 'The game\'s Hit List (its targets are added and removed there)';
  if (opts.external) { manage.target = '_blank'; manage.rel = 'noopener'; }
  head.appendChild(manage);
  wrap.appendChild(head);
  if (!data.game) wrap.appendChild(el('p', 'rqum-muted', 'The game\'s Hit List is not known yet (a member opens this tab in the game): RQUM\'s targets only.'));
  else if (data.gameAt) wrap.appendChild(el('p', 'rqum-muted rqum-hit__read', `Game's list read ${RQUM.formatAge(data.gameAt)} ago${data.gameBy ? ` by ${data.gameBy}` : ''}.`));

  // Add a target in RQUM: a name, then a player of the database.
  const add = el('form', 'rqum-hit__add');
  const input = el('input');
  input.placeholder = 'Add a target in RQUM: player name';
  input.autocomplete = 'off';
  const note = el('input', 'rqum-hit__note');
  note.placeholder = 'Note (optional)';
  note.maxLength = 200;
  const found = el('ul', 'rqum-list rqum-hit__found');
  let ticket = 0;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const query = input.value.trim();
      const mine = ++ticket;
      found.replaceChildren();
      if (query.length < 2) return;
      const rows = await opts.search(query).catch(() => []);
      if (mine !== ticket) return;
      for (const p of (rows || []).slice(0, 8)) {
        const li = el('li', 'rqum-list__item');
        const b = el('button', 'rqum-link-btn', RQUM.withClan(p.player_name || `#${p.player_id}`, p.clan));
        b.type = 'button';
        b.addEventListener('click', async () => {
          try { await opts.add(p.player_id, p.player_name, note.value); } catch (err) { return opts.error(err.message); }
          RQUM.toast?.(`🎯 ${p.player_name} added to the Hit List`);
          opts.reload();
        });
        li.appendChild(b);
        found.appendChild(li);
      }
      if (!found.children.length) found.appendChild(el('li', 'rqum-muted', 'Nobody found in the RQUM database.'));
    }, 300);
  });
  add.addEventListener('submit', (e) => e.preventDefault());
  add.append(input, note);
  wrap.append(add, found);

  if (opts.big && targets.length) wrap.appendChild(hitOverview(targets, members));
  if (!targets.length) wrap.appendChild(el('p', 'rqum-muted', 'No target yet: add one above (or on the game\'s clan page).'));

  // Sort: the clan's figures on them, or the target's own (RQUM database); remembered.
  const statOf = (t, k) => known[t.id]?.stats?.[k]?.v;
  const levelOf = (t) => statOf(t, 'level') ?? (Number(String(t.level || '').replace(/\D/g, '')) || null);
  const HIT_SORTS = [
    ['gold', '💰 Gold stolen', (t) => t.tot.gold],
    ['attacks', '⚔️ Attacks', (t) => t.tot.attacks],
    ['wins', '🏆 Attacks won', (t) => t.tot.wins],
    ['killed', '☠️ Kills', (t) => t.tot.killed],
    ['ops', '🕵️ Spy operations', (t) => t.tot.ops],
    ['onhand', '🪙 Gold on hand', (t) => statOf(t, 'gold_on_hand')],
    ['defense', '🛡️ Defense (lowest first)', (t) => statOf(t, 'total_defense'), true],
    ['level', '⭐ Level', levelOf],
    ['name', '🔤 Name', (t) => String(t.name || '').toLowerCase(), true],
    ['order', '🎮 Game\'s order', null],
  ];
  const SORT_KEY = 'rqumHitListSort';
  let sortBy = 'gold';
  try { sortBy = localStorage.getItem(SORT_KEY) || 'gold'; } catch (_) { /* storage off */ }
  if (!HIT_SORTS.some(([k]) => k === sortBy)) sortBy = 'gold';
  const gameOrder = [...entries.keys()];
  const list = el('div', 'rqum-hit__list');
  if (targets.length > 1) {
    const bar = el('label', 'rqum-hit__sort', 'Sort by ');
    const select = el('select');
    for (const [k, label] of HIT_SORTS) {
      const o = el('option', '', label);
      o.value = k;
      select.appendChild(o);
    }
    select.value = sortBy;
    select.addEventListener('change', () => {
      sortBy = select.value;
      try { localStorage.setItem(SORT_KEY, sortBy); } catch (_) { /* storage off */ }
      drawList();
    });
    bar.appendChild(select);
    wrap.appendChild(bar);
  }
  wrap.appendChild(list);

  // Unknown values last, whatever the direction; ties: most gold stolen first.
  function sorted() {
    const [, , get, asc] = HIT_SORTS.find(([k]) => k === sortBy);
    if (!get) return [...targets].sort((x, y) => gameOrder.indexOf(x.id) - gameOrder.indexOf(y.id));
    const none = (v) => v == null || v === '';
    return [...targets].sort((x, y) => {
      const a = get(x);
      const b = get(y);
      if (none(a) || none(b)) return none(a) - none(b) || y.tot.gold - x.tot.gold;
      const d = typeof a === 'string' ? a.localeCompare(b) : a - b;
      return (asc ? d : -d) || y.tot.gold - x.tot.gold;
    });
  }

  drawList();
  function drawList() {
  list.replaceChildren();
  for (const t of sorted()) {
    const st = known[t.id]?.stats || {};
    const item = el('details', 'rqum-hit__item');
    const sum = el('summary', 'rqum-hit__sum');
    const who = el('span', 'rqum-hit__name rqum-link-btn', RQUM.withClan(t.name, st.clan?.v));
    who.title = 'RQUM card';
    who.addEventListener('click', (e) => { e.preventDefault(); opts.pick(t.id, t.name); });
    const src = el('span', 'rqum-hit__src', t.game && t.rqum ? '🎮+RQUM' : t.game ? '🎮' : 'RQUM');
    src.title = t.game ? 'On the game\'s Hit List (its figures)' : 'Added in RQUM (the clan\'s hits since then, from the members\' RQUM)';
    const level = t.level || (st.level?.v ? `Lvl ${st.level.v}` : '');
    const meta = el('span', 'rqum-muted rqum-hit__meta', [level, t.added].filter(Boolean).join(' · '));
    meta.title = [t.by ? `Added by ${t.by}` : '', t.rqumBy && t.rqumBy !== t.by ? `in RQUM by ${t.rqumBy}` : ''].filter(Boolean).join(', ');
    const acts = el('span', 'rqum-hit__acts');
    const profile = el('a', 'rqum-btn rqum-btn--inline', 'Profile');
    profile.href = opts.profileHref(t.id);
    acts.appendChild(profile);
    if (t.intel) {
      const a = el('a', 'rqum-btn rqum-btn--inline', 'Intel');
      a.href = opts.gameHref(new URL(t.intel, 'https://x').pathname);
      acts.appendChild(a);
    }
    // On the web page the game opens in another tab.
    if (opts.external) acts.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
    if (t.removable) {
      const rm = el('button', 'rqum-btn rqum-btn--inline', '✕');
      rm.type = 'button';
      rm.title = t.game ? 'Remove from RQUM\'s list (the game\'s list is changed on the clan page)' : 'Remove from the Hit List';
      rm.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!confirm(`Remove ${t.name} from RQUM's Hit List?`)) return;
        try { await opts.remove(t.id); } catch (err) { return opts.error(err.message); }
        opts.reload();
      });
      acts.appendChild(rm);
    }
    const chips = el('span', 'rqum-hit__stats');
    for (const [text, title] of [
      [`⚔️ ${t.tot.wins}W / ${t.tot.attacks}`, 'Clan attacks won / total'],
      [`💰 ${RQUM.formatNumber(t.tot.gold)}`, `Gold stolen by the clan: ${RQUM.formatExact(t.tot.gold)}`],
      [`☠️ ${RQUM.formatNumber(t.tot.killed)}`, 'Units killed by the clan'],
      [`🕵️ ${t.tot.opsWon}W / ${t.tot.ops}`, 'Clan spy operations won / total'],
    ]) {
      const c = el('span', 'rqum-hit__chip', text);
      c.title = title;
      chips.appendChild(c);
    }
    sum.append(who, src, meta, acts, chips);
    if (t.note) sum.appendChild(el('span', 'rqum-hit__notetext', `📝 ${t.note}`));
    item.appendChild(sum);
    const tables = [];
    if (t.attackers.length) {
      const cols = t.game
        ? [['Attacker'], ['Attacks', 'attacks'], ['W/L'], ['Kills', 'killed'], ['Gold', 'gold'], ['XP', 'xp'], ['Fort', 'fort'], ['Last hit', 'last']]
        : [['Attacker'], ['Attacks', 'attacks'], ['W/L'], ['Kills', 'killed'], ['Gold', 'gold'], ['Spy ops', 'ops'], ['Last hit', 'last']];
      const table = el('table', 'rqum-hit__table');
      const tr0 = el('tr');
      cols.forEach(([h]) => tr0.appendChild(el('th', '', h)));
      table.appendChild(el('thead')).appendChild(tr0);
      const tb = table.appendChild(el('tbody'));
      for (const a of t.attackers) {
        const tr = el('tr');
        for (const [h, k] of cols) {
          const td = el('td');
          if (h === 'Attacker') {
            const b = el('button', 'rqum-link-btn', a.name || '?');
            b.type = 'button';
            if (a.readAgo) b.title = `Their figures read ${a.readAgo} ago`;
            if (a.id) b.addEventListener('click', () => opts.pick(a.id, a.name));
            td.appendChild(b);
          } else if (h === 'W/L') td.textContent = `${a.wins} / ${a.losses}`;
          else {
            const v = a[k];
            td.textContent = typeof v === 'number' ? RQUM.formatNumber(v) : v ?? '';
            if (typeof v === 'number' && v >= 1e4) td.title = RQUM.formatExact(v);
          }
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      tables.push(['Attackers', table]);
    }
    // The game's "Spies who hit …".
    if (t.spies?.length) {
      const cols = [['Spy'], ['Ops', 'ops'], ['W/L'], ['Recon', 'recon'], ['Sabotage', 'sabotage'], ['Assassin.', 'assassin'], ['Kills', 'killed'], ['Fort', 'fort'], ['Last op', 'last']];
      const table = el('table', 'rqum-hit__table');
      const tr0 = el('tr');
      cols.forEach(([h]) => tr0.appendChild(el('th', '', h)));
      table.appendChild(el('thead')).appendChild(tr0);
      const tb = table.appendChild(el('tbody'));
      for (const a of t.spies) {
        const tr = el('tr');
        for (const [h, k] of cols) {
          const td = el('td');
          if (h === 'Spy') {
            const b = el('button', 'rqum-link-btn', a.name || '?');
            b.type = 'button';
            if (a.id) b.addEventListener('click', () => opts.pick(a.id, a.name));
            td.appendChild(b);
          } else if (h === 'W/L') td.textContent = `${a.wins} / ${a.losses}`;
          else td.textContent = typeof a[k] === 'number' ? RQUM.formatNumber(a[k]) : a[k] ?? '';
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      tables.push(['Spies', table]);
    }
    for (const [title, table] of tables) {
      const scroll = el('div', 'rqum-hit__scroll');
      if (tables.length > 1) scroll.appendChild(el('div', 'rqum-hit__chart-title', title));
      scroll.appendChild(table);
      item.appendChild(scroll);
    }
    if (!tables.length) item.appendChild(el('p', 'rqum-muted rqum-hit__none', 'No hit by the clan yet.'));
    list.appendChild(item);
  }
  }
  wrap.appendChild(el('p', 'rqum-muted', 'RQUM targets: hits counted from each member\'s Battle Logs and spy logs read by their RQUM (Stats tab), to the hour, since the target was added.'));
  return wrap;
};

// Big window: totals, the clan's gold from the targets over 30 days, best targets and hitters.
function hitOverview(all, members) {
  const zero = () => ({ attacks: 0, wins: 0, gold: 0, killed: 0, ops: 0, opsWon: 0 });
  const box = el('div', 'rqum-hit__overview');
  const tot = all.reduce((a, t) => { for (const k of Object.keys(a)) a[k] += t.tot[k]; return a; }, zero());
  const tiles = el('div', 'rqum-hit__tiles');
  for (const [label, value, title] of [
    ['Targets', String(all.length), `${all.filter((t) => t.game).length} from the game, ${all.filter((t) => !t.game).length} added in RQUM`],
    ['Attacks', `${tot.wins}W / ${tot.attacks}`, 'Clan attacks on the targets, won / total'],
    ['Gold stolen', RQUM.formatNumber(tot.gold), RQUM.formatExact(tot.gold)],
    ['Kills', RQUM.formatNumber(tot.killed), 'Units killed on the targets'],
    ['Spy ops', `${tot.opsWon}W / ${tot.ops}`, 'Spy operations on the targets, won / total'],
    ['Win rate', tot.attacks ? `${Math.round((tot.wins / tot.attacks) * 100)}%` : '—', 'Attacks won ÷ attacks'],
  ]) {
    const tile = el('div', 'rqum-hit__tile');
    tile.title = title;
    tile.append(el('span', 'rqum-hit__tile-label', label), el('strong', '', value));
    tiles.appendChild(tile);
  }
  box.appendChild(tiles);
  // The chart and the two rankings over a period: Day (24 h), Week, Month (30 days) or the
  // Season, from the members' hourly figures (members with RQUM); remembered.
  const PERIODS = [['day', 'Day', 'last 24 hours', () => 1], ['week', 'Week', 'last 7 days', () => 7],
    ['month', 'Month', 'last 30 days', () => 30], ['season', 'Season', 'this season', daysSinceSeason]];
  const PERIOD_KEY = 'rqumHitListPeriod';
  let period = 'month';
  try { period = localStorage.getItem(PERIOD_KEY) || 'month'; } catch (_) { /* storage off */ }
  if (!PERIODS.some(([k]) => k === period)) period = 'month';
  const tabs = el('div', 'rqum-hit__periods');
  const view = el('div');
  for (const [k, label, , days] of PERIODS) {
    const b = el('button', 'rqum-hit__period', label);
    b.type = 'button';
    b.dataset.p = k;
    b.title = k === 'season' ? `Since ${SEASON_START.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : `Last ${Math.round(days())} day${days() > 1 ? 's' : ''}`;
    b.addEventListener('click', () => {
      period = k;
      try { localStorage.setItem(PERIOD_KEY, k); } catch (_) { /* storage off */ }
      drawPeriod();
    });
    tabs.appendChild(b);
  }
  // Where the figures come from, for everyone reading the window.
  const about = el('details', 'rqum-hit__about');
  about.appendChild(el('summary', '', 'ℹ️ Where do these figures come from?'));
  for (const line of [
    "🎮 Game targets: the list's figures (attacks, gold, kills, spy ops) are the game's own Hit List, counted since the target was added to it, by every clan member (RQUM or not).",
    "RQUM targets (added in RQUM only): counted from the Battle Logs and spy logs of the members who play with RQUM, since the target was added.",
    "🎯 Most gold given: each target's gold as shown in its line (the period buttons do not change it: the game gives no history).",
    "🏆 Best hitters: the attackers tables of the targets added up. The game counts each attacker's gold over all time, so it can be higher than the targets' totals.",
    "💰 The chart and its Day / Week / Month / Season: the only figures over time, read from the Battle Logs of the members with RQUM (members without RQUM are missing).",
  ]) about.appendChild(el('p', '', line));
  box.append(tabs, view, about);
  const ids = new Set(all.map((t) => t.id));
  const nameOf = Object.fromEntries(all.map((t) => [t.id, t.name]));
  function drawPeriod() {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.p === period));
    const [, , label, days] = PERIODS.find(([k]) => k === period);
    const fromHour = new Date(Date.now() - days() * 86400000).toISOString().slice(0, 13);
    const perHour = {};
    for (const m of members) {
      for (const [pid, p] of Object.entries(m.stats?.attacked || {})) {
        if (!ids.has(pid)) continue;
        for (const [h, v] of Object.entries(p.hours || {})) {
          if (h < fromHour || !v.gold) continue;
          perHour[h] = (perHour[h] || 0) + v.gold;
        }
      }
    }
    let run = 0;
    const series = Object.keys(perHour).sort().map((h) => ({ hour: `${h}:00:00Z`, v: (run += perHour[h]) }));
    const chart = el('div', 'rqum-hit__chart');
    chart.append(el('div', 'rqum-hit__chart-title', `💰 Gold taken from the targets, ${label} (added up, members with RQUM)`), RQUM.historyChart(series));
    const top = (o, name) => Object.entries(o).map(([k, v]) => ({ name: name(k), v })).filter((r) => r.v).sort((a, b) => b.v - a.v).slice(0, 10);
    // The rankings: the same figures as the list (the game's for its targets, since added; RQUM's
    // for RQUM-only targets), whatever the period (the game gives no history).
    const given = {};
    const hitters = {};
    for (const t of all) {
      given[t.id] = t.tot.gold;
      for (const a of t.attackers) { const who = RQUM.cleanName(a.name) || '?'; hitters[who] = (hitters[who] || 0) + (a.gold || 0); }
    }
    const two = el('div', 'rqum-hit__two');
    two.append(
      bars('🎯 Most gold given (top 10 targets, since added)', top(given, (id) => nameOf[id] || `#${id}`)),
      bars('🏆 Best hitters (gold on the targets, as in the list)', top(hitters, (n) => n)),
    );
    view.replaceChildren(chart, two);
  }
  // Bars: the targets that gave the most gold, the members who took the most.
  const bars = (title, rows) => {
    const b = el('div', 'rqum-hit__bars');
    b.appendChild(el('div', 'rqum-hit__chart-title', title));
    const max = Math.max(1, ...rows.map((r) => r.v));
    for (const r of rows) {
      const line = el('div', 'rqum-hit__bar');
      const track = el('span', 'rqum-hit__bar-track');
      const fill = el('span', 'rqum-hit__bar-fill');
      fill.style.width = `${Math.max(2, (r.v / max) * 100)}%`;
      track.appendChild(fill);
      line.title = `${r.name}: ${RQUM.formatExact(r.v)}`;
      line.append(el('span', 'rqum-hit__bar-name', r.name), track, el('span', 'rqum-hit__bar-v', RQUM.formatNumber(r.v)));
      b.appendChild(line);
    }
    if (!rows.length) b.appendChild(el('p', 'rqum-muted', 'Nothing yet.'));
    return b;
  };
  drawPeriod();
  return box;
}

// ---- 24h tab: the last 24 hours or today (since midnight) --------------------------------
// From the members' war statistics (rqum_war_clan: each member's Battle Logs and spy logs read
// by their RQUM, by the hour): gold plundered / lost, units killed / lost in battle, units
// assassinated (by me / on me), fort damage dealt / taken. One member or the whole clan; TGO only.
// data: { members: rows of rqum_war_clan, tgo: Set of TGO player ids, me: my name }.
const DAILY_METRICS = [
  ['plundered', '💰 Gold plundered', '#facc15', 'Gold looted in attacks'],
  ['goldLost', '🩸 Gold lost', '#ef4444', 'Gold looted by the attacks on us'],
  ['killed', '☠️ Units killed', '#22c55e', 'Enemy units killed in battle (attacking and defending)'],
  ['lost', '💀 Units lost', '#ef4444', 'Our units lost in battle (attacking and defending)'],
  ['assassinated', '🗡️ Units assassinated', '#a855f7', 'Enemy units killed by our assassinations'],
  ['assassinatedMe', '🩻 Units assassinated on {us}', '#ef4444', 'Our units killed by enemy assassinations (anonymous: never "TGO only")'],
  ['sabotages', '💥 Sabotages done', '#f59e0b', 'Our successful sabotages'],
  ['sabotagedMe', '🔥 Sabotages on {us}', '#ef4444', 'Enemy sabotages that got through (anonymous: never "TGO only")'],
  ['fortDealt', '🏰 Fort damage dealt', '#22c55e', 'Damage to the forts we attacked (from the battle reports)'],
  ['fortTaken', '🧱 Fort damage taken', '#ef4444', 'Damage to our forts (from the battle reports)'],
];
const DAILY_KEY = 'rqumDailyView';
RQUM.dailyView = (data) => {
  let state = { range: '24h', who: '', tgo: false, metric: 'plundered' };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(DAILY_KEY) || '{}') }; } catch (_) { /* storage off */ }
  const members = [...(data.members || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (state.who && !members.some((m) => String(m.player_id) === state.who)) state.who = '';
  const wrap = el('div', 'rqum-daily');
  const bar = el('div', 'rqum-daily__bar');
  const range = el('div', 'rqum-hit__periods');
  for (const [k, label, title] of [['24h', 'Last 24h', 'The last 24 hours, hour by hour'], ['today', 'Today', 'Since midnight (your time)']]) {
    const b = el('button', 'rqum-hit__period', label);
    b.type = 'button';
    b.dataset.r = k;
    b.title = title;
    b.addEventListener('click', () => { state.range = k; draw(); });
    range.appendChild(b);
  }
  const who = el('select', 'rqum-daily__who');
  who.appendChild(new Option('👥 Whole clan', ''));
  for (const m of members) who.appendChild(new Option(m.name || `#${m.player_id}`, String(m.player_id)));
  who.addEventListener('change', () => { state.who = who.value; draw(); });
  const tgo = el('label', 'rqum-daily__tgo');
  const tgoBox = el('input');
  tgoBox.type = 'checkbox';
  tgoBox.addEventListener('change', () => { state.tgo = tgoBox.checked; draw(); });
  tgo.append(tgoBox, ' TGO only');
  tgo.title = 'Only the battles and spy operations with TGO players';
  bar.append(range, who, tgo);
  const view = el('div');
  wrap.append(bar, view);
  wrap.appendChild(el('p', 'rqum-muted rqum-daily__note', 'From each member\'s Battle Logs and spy logs, read by their RQUM (every 30 min while the game is open), to the hour: members without RQUM are missing. Fort damage and the units assassinated on us are counted from RQUM 1.1.5 on; the latter are anonymous in the game, so never "TGO only".'));

  function draw() {
    try { localStorage.setItem(DAILY_KEY, JSON.stringify(state)); } catch (_) { /* storage off */ }
    range.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.r === state.range));
    who.value = state.who;
    tgoBox.checked = state.tgo;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const from = (state.range === 'today' ? midnight : new Date(Date.now() - 24 * 3600000)).toISOString().slice(0, 13);
    const ok = (pid) => !state.tgo || data.tgo?.has(String(pid));
    const chosen = state.who ? members.filter((m) => String(m.player_id) === state.who) : members;
    const totals = Object.fromEntries(DAILY_METRICS.map(([k]) => [k, 0]));
    const perHour = {}; // metric -> hour -> value
    const perMember = {}; // metric -> member name -> value
    const put = (k, h, v, m) => {
      if (!v) return;
      totals[k] += v;
      ((perHour[k] ??= {})[h] = (perHour[k][h] || 0) + v);
      const name = m.name || `#${m.player_id}`;
      ((perMember[k] ??= {})[name] = (perMember[k][name] || 0) + v);
    };
    for (const m of chosen) {
      for (const [pid, p] of Object.entries(m.stats?.attacked || {})) {
        if (!ok(pid)) continue;
        for (const [h, v] of Object.entries(p.hours || {})) {
          if (h < from) continue;
          put('plundered', h, v.gold, m); put('killed', h, v.killed, m); put('lost', h, v.lost, m);
          put('assassinated', h, v.assassinated, m); put('sabotages', h, v.sabotages, m); put('fortDealt', h, v.fort, m);
        }
      }
      // Their attacks on us: "killed" = our units they killed, "lost" = theirs we killed.
      for (const [pid, p] of Object.entries(m.stats?.attackers || {})) {
        if (!ok(pid)) continue;
        for (const [h, v] of Object.entries(p.hours || {})) {
          if (h < from) continue;
          put('goldLost', h, v.gold, m); put('lost', h, v.killed, m); put('killed', h, v.lost, m); put('fortTaken', h, v.fort, m);
        }
      }
      if (!state.tgo) {
        for (const [h, v] of Object.entries(m.stats?.anonIn?.hours || {})) {
          if (h >= from) { put('assassinatedMe', h, v.assassinated, m); put('sabotagedMe', h, v.sabotages, m); }
        }
      }
    }
    // "on us" for the whole clan, "on me" for my own figures, "on Krijkes" for another member.
    const mine = chosen.length === 1 && String(chosen[0].name || '').toLowerCase() === String(data.me || '').toLowerCase();
    const named = (s) => s.replace('{us}', !state.who ? 'us' : mine ? 'me' : (chosen[0]?.name || 'them'));
    const tiles = el('div', 'rqum-hit__tiles');
    for (const [k, rawTileLabel, color, title] of DAILY_METRICS) {
      const label = named(rawTileLabel);
      const t = el('button', `rqum-hit__tile rqum-daily__tile${k === state.metric ? ' is-on' : ''}`);
      t.type = 'button';
      t.title = `${title}: ${RQUM.formatExact(totals[k])}`;
      const v = el('strong', '', state.tgo && (k === 'assassinatedMe' || k === 'sabotagedMe') ? '?' : RQUM.formatNumber(totals[k]));
      v.style.color = color;
      t.append(el('span', 'rqum-hit__tile-label', label), v);
      t.addEventListener('click', () => { state.metric = k; draw(); });
      tiles.appendChild(t);
    }
    const [, rawLabel] = DAILY_METRICS.find(([k]) => k === state.metric);
    const label = named(rawLabel);
    // The chosen figure hour by hour, added up from the start of the range.
    const hours = [];
    for (let t = new Date(`${from}:00:00Z`).getTime(); t <= Date.now(); t += 3600000) hours.push(new Date(t).toISOString().slice(0, 13));
    let run = 0;
    const series = hours.map((h) => ({ hour: `${h}:00:00Z`, v: (run += perHour[state.metric]?.[h] || 0) }));
    const chart = el('div', 'rqum-hit__chart');
    chart.append(el('div', 'rqum-hit__chart-title', `${label}, added up hour by hour`), RQUM.historyChart(series));
    const parts = [tiles, chart];
    // Whole clan: who made it.
    if (!state.who) {
      const rows = Object.entries(perMember[state.metric] || {}).map(([name, v]) => ({ name, v })).sort((a, b) => b.v - a.v);
      const bars = el('div', 'rqum-hit__bars');
      bars.appendChild(el('div', 'rqum-hit__chart-title', `${label}, by member`));
      const max = Math.max(1, ...rows.map((r) => r.v));
      for (const r of rows) {
        const line = el('div', 'rqum-hit__bar');
        const track = el('span', 'rqum-hit__bar-track');
        const fill = el('span', 'rqum-hit__bar-fill');
        fill.style.width = `${Math.max(2, (r.v / max) * 100)}%`;
        track.appendChild(fill);
        line.title = `${r.name}: ${RQUM.formatExact(r.v)}`;
        line.append(el('span', 'rqum-hit__bar-name', r.name), track, el('span', 'rqum-hit__bar-v', RQUM.formatNumber(r.v)));
        bars.appendChild(line);
      }
      if (!rows.length) bars.appendChild(el('p', 'rqum-muted', 'Nothing in this period.'));
      parts.push(bars);
    } else {
      const m = chosen[0];
      if (m?.updated_at) parts.push(el('p', 'rqum-muted rqum-daily__note', `${m.name}'s logs read ${RQUM.formatAge(m.updated_at)} ago.`));
    }
    view.replaceChildren(...parts);
  }
  draw();
  return wrap;
};

// ---- Mass tab: which TGO player a group attack would hurt most --------------------------------
// For each TGO player known to RQUM: the RQUM members in range (10 levels either way), those whose
// offense beats their defense (ratio), those whose spy offense beats their spy defense
// (assassinate, sabotage: once a day each), and the units a mass would kill: every member in
// range making their 5 attacks (10 turns) and one assassination, by the game's own formulas,
// capped at 5 % of their army and 1,269 units a day (all attackers and assassinations together).
// The game's formulas (its in-game assistant, Nov 2026):
//   attacker wins: losses = pool × 0.01 × dominance × turn bonus × protection ÷ 3.17,
//     dominance = 1 + 4 (r − 1) ÷ (r + 3), r = offense ÷ defense, turn bonus = 1 + 0.01 (turns − 1),
//     protection 0.05 (fort full), 0.10 (half), 0.25 (fort at 0);
//   attacker loses, closeness above 0.6: 0.003 × (closeness − 0.6) ÷ 0.4 × turn bonus × protection;
//   assassination: 6 to 11 units (a big spy academy: a % of the category, up to 100), × 80 %.
// pool: the target's army (defense, workers, offense, spies; not the untrained citizens).
const MASS_TURNS = 10;
const MASS_ATTACKS = 5;
const MASS_ASSASSIN = 8.5 * 0.8; // average of 6–11 units, at the base 80 % intensity
// The game's tables (its in-game assistant, Nov 2026): a sabotage with a Siege Workshop hits the
// fort for at least this share of its maximum HP; an assassination with a Spy Academy kills at
// least this share of the chosen category (level 1: none).
const MASS_SABO_PCT = [0, 0.10, 0.11, 0.13, 0.14, 0.16, 0.18, 0.21, 0.24, 0.27, 0.30];
const MASS_ACADEMY_PCT = [0, 0, 0.0004, 0.0007, 0.0011, 0.0015, 0.0015, 0.0015, 0.0015, 0.0015, 0.0015];
const MASS_INTENSITY = 0.8; // 80 %, + the member's Dexterity − the target's Vigilance (not known: 0)
const MASS_DAY_CAP = 1269;
const MASS_SABO = (400 + 750) / 2; // a sabotage's fort damage without a siege workshop
function massProtection(fortPct) {
  if (typeof fortPct !== 'number') return 0.05;
  const f = Math.max(0, Math.min(100, fortPct)) / 100;
  // Between the game's three points (full 0.05, half 0.10, empty 0.25), in straight lines.
  return f >= 0.5 ? 0.10 - (f - 0.5) * 0.10 : 0.25 - f * 0.30;
}
function massLossShare(off, def, protection) {
  const turnBonus = 1 + 0.01 * (MASS_TURNS - 1);
  if (off > def) {
    const r = off / def;
    const dominance = 1 + (4 * (r - 1)) / (r + 3);
    return (0.01 * dominance * turnBonus * protection) / 3.17;
  }
  const closeness = off / def;
  return closeness > 0.6 ? 0.003 * ((closeness - 0.6) / 0.4) * turnBonus * protection : 0;
}
// data: { targets: TGO rows (rqum_clan), members: RQUM rows (rqum_alliance) }; opts.pick(id, name).
RQUM.massView = (data, opts = {}) => {
  const num = (st, k) => (typeof st?.[k]?.v === 'number' ? st[k].v : null);
  // A figure, or its floor when newer and above it ("> X" after a failed attack / spy operation).
  const fig = (st, k) => {
    const fl = RQUM.floorOf?.(st, k);
    return fl ? { v: fl.v, floor: true } : num(st, k) != null ? { v: num(st, k), floor: false } : null;
  };
  const members = (data.members || []).map((m) => ({ id: String(m.player_id), name: m.player_name, level: num(m.stats, 'level'), off: num(m.stats, 'total_offense'), spy: num(m.stats, 'spy_offense'), siege: num(m.stats, 'siege_bonus') || 0, workshop: num(m.stats, 'siege_workshop') || 0, academy: num(m.stats, 'spy_academy') || 0, turns: num(m.stats, 'turns'), war: null }));
  // Each member's war statistics (rqum_war_clan): what they already did to a target in 24 h.
  const warOf = new Map((data.war || []).map((w) => [String(w.player_id), w.stats || {}]));
  members.forEach((m) => { m.war = warOf.get(m.id) || null; });
  const from24 = new Date(Date.now() - 24 * 3600000).toISOString().slice(0, 13);
  const dayOf = (m, tid) => {
    const out = { attacks: 0, killed: 0, assassinations: 0, assassinated: 0, sabotages: 0 };
    for (const [h, v] of Object.entries(m.war?.attacked?.[tid]?.hours || {})) {
      if (h < from24) continue;
      for (const k of Object.keys(out)) out[k] += v[k] || 0;
    }
    return out;
  };
  const rows = (data.targets || []).map((t) => {
    const st = t.stats || {};
    const tid = String(t.player_id);
    const level = num(st, 'level');
    const def = fig(st, 'total_defense');
    const sdef = fig(st, 'spy_defense');
    // The loss pool: the units of their last spy report (defense, workers, offense, spies), else
    // their army. By category too, for the assassinations.
    const cats = {};
    for (const u of Array.isArray(st.report_army?.v) ? st.report_army.v : []) {
      if (typeof u.quantity === 'number') cats[u.type || '?'] = (cats[u.type || '?'] || 0) + u.quantity;
    }
    const pool = Object.values(cats).reduce((s, q) => s + q, 0);
    const army = pool || num(st, 'army');
    const fortMax = num(st, 'fort_max');
    const protection = massProtection(num(st, 'fort_pct'));
    const inRange = members.filter((m) => level != null && m.level != null && Math.abs(m.level - level) <= 10);
    // Already done in 24 h by each member (their logs): attacks used, assassination / sabotage used,
    // and when everything is back (each attack's slot frees 24 h after it, to the second from their
    // last battles; a spy operation to the hour).
    const done = { attacks: 0, killed: 0, sabotages: 0 };
    const now = Date.now();
    let readyAt = now;
    const attackers = inRange.map((m) => {
      const day = dayOf(m, tid);
      done.attacks += day.attacks; done.killed += day.killed + day.assassinated; done.sabotages += day.sabotages;
      let back = now;
      for (const ev of m.war?.attacked?.[tid]?.recent || []) {
        const at = Date.parse(ev.at);
        if (at > now - 24 * 3600000) back = Math.max(back, at + 24 * 3600000);
      }
      for (const [h, v] of Object.entries(m.war?.attacked?.[tid]?.hours || {})) {
        if (h >= from24 && (v.assassinations || v.sabotages)) back = Math.max(back, Date.parse(`${h}:00:00Z`) + 25 * 3600000);
      }
      readyAt = Math.max(readyAt, back);
      // Attacks left now: 5 a day on a target, and the turns they have (10 an attack) when known.
      const left = Math.max(0, MASS_ATTACKS - day.attacks);
      const attacks = m.turns != null ? Math.min(left, Math.floor(m.turns / MASS_TURNS)) : left;
      // A floor: their defense is above it, so beating it is not sure.
      const beats = def && m.off != null ? m.off > def.v : null;
      const spyOk = sdef && m.spy != null ? m.spy > sdef.v : null;
      return { ...m, day, back, attacks, ratio: def && m.off != null ? m.off / def.v : null, beats, sure: beats && !def.floor,
        spyOk, canAssassinate: spyOk && !day.assassinations, canSabotage: spyOk && !day.sabotages };
    }).sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
    const winners = attackers.filter((a) => a.beats);
    const spies = attackers.filter((a) => a.spyOk);
    const biggestCat = Math.max(0, ...Object.values(cats));
    // Each assassin on the category where they kill the most: max(6–11, their Spy Academy's % of
    // that category), at most 100, × 80 % intensity.
    const assassinKills = (a) => Math.min(100, Math.max(8.5, Math.floor(biggestCat * (MASS_ACADEMY_PCT[a.academy] || 0)))) * MASS_INTENSITY;
    const fullCap = army ? Math.min(MASS_DAY_CAP, army * 0.05) : MASS_DAY_CAP;

    // One mass: attacks per member (attacksOf), who assassinates / sabotages, what was already done.
    // Played hit by hit in the best order, kept as the plan (steps): 1. the sabotages, biggest Siege
    // Workshops first (each next one does less); 2. the attacks that win, ordered below; 3. the
    // assassinations (they do not depend on the fort). (The Discord bot's /mass does the same:
    // supabase/functions/rqum-discord/mass.ts, keep both in step.)
    function simulate(attacksOf, assassins, saboteurs, before) {
      const steps = [];
      let hp = fortMax ? fortMax * ((num(st, 'fort_pct') ?? 100) / 100) : null;
      const startHp = hp;
      if (hp != null) {
        [...saboteurs].sort((a, b) => b.workshop - a.workshop).forEach((a, i) => {
          const dmg = Math.min(2000, Math.max(MASS_SABO, (MASS_SABO_PCT[a.workshop] || 0) * fortMax)) / (1 + before.sabotages + i);
          steps.push({ who: a.name, act: 'sabotage', n: 1, from: hp, to: Math.max(0, hp - dmg), kills: 0 });
          hp = Math.max(0, hp - dmg);
        });
      } else saboteurs.forEach((a) => steps.push({ who: a.name, act: 'sabotage', n: 1, kills: 0 }));
      const afterSabo = hp;
      let fromAttacks = 0;
      if (def && army) {
        // The fort damage of an attack stops growing at offense ÷ defense = 2, the units it kills keep
        // growing with the ratio (dominance) and with the protection (the fort going down). So first
        // those who hit the fort hard for the units they kill (ratio near 2), the biggest ratios last,
        // once the fort is down. (Without the fort's maximum HP the order changes nothing.)
        const fortHit = (a) => Math.min(2, a.off / def.v) * (1 + a.siege / 100);
        const killShare = (a) => massLossShare(a.off, def.v, 1) || 1e-9;
        // Not the attacks lost in advance (offense not above their defense): they kill almost nothing
        // and cost the attacker units and turns (their sabotage / assassination still count).
        const order = attackers.filter((a) => a.off != null && a.beats !== false && attacksOf(a) > 0)
          .sort((a, b) => (hp != null ? fortHit(b) / killShare(b) - fortHit(a) / killShare(a) : 0) || b.off - a.off);
        let hits = before.attacks;
        for (const a of order) {
          const r = a.off / def.v;
          const step = { who: a.name, act: 'attack', n: attacksOf(a), from: hp, kills: 0, wins: a.beats };
          for (let k = 0; k < attacksOf(a); k++) {
            const prot = hp != null ? massProtection((hp / fortMax) * 100) : protection;
            let kill = massLossShare(a.off, def.v, prot) * army;
            if (a.beats && hp === 0) kill += 0.0005 * army; // a fort at 0 HP: 0.05 % of the army more
            step.kills += kill;
            if (hp != null) hp = Math.max(0, hp - Math.floor(10 * MASS_TURNS * Math.min(2, r) * (1 + a.siege / 100)) * Math.max(0.5, 1 / (1 + 0.15 * hits)));
            hits += 1;
          }
          step.to = hp;
          fromAttacks += step.kills;
          steps.push(step);
        }
      }
      let fromAssassins = 0;
      for (const a of assassins) {
        const k = assassinKills(a);
        fromAssassins += k;
        steps.push({ who: a.name, act: 'assassinate', n: 1, kills: k });
      }
      // Their daily cap, less what we already killed of theirs in 24 h (others' kills are not known).
      const cap = Math.max(0, fullCap - before.killed);
      const fortSim = fortMax && def && army ? { startHp, afterSabo, endHp: hp, saboteurs: saboteurs.length } : null;
      return { fortSim, steps, fromAttacks, fromAssassins, assassins: assassins.length, cap, total: Math.min(cap, fromAttacks + fromAssassins), capped: fromAttacks + fromAssassins > cap };
    }
    // Full: everyone with their 5 attacks, assassination and sabotage (once the last 24 h are over).
    const full = simulate(() => MASS_ATTACKS, spies, spies, { attacks: 0, killed: 0, sabotages: 0 });
    // Now: the attacks each one has left (and their turns), what is left of the cap.
    const nowSim = simulate((a) => a.attacks, attackers.filter((a) => a.canAssassinate), attackers.filter((a) => a.canSabotage), done);
    // How old their figures are: the defense's sighting (the report the mass relies on).
    const seen = st.total_defense?.at || st.report_army?.at || null;
    return { t, st, level, def, sdef, army, protection, fortMax, inRange, attackers, winners, spies, done, fullCap, seen, readyAt, full, now: nowSim, total: full.total };
  }).sort((a, b) => b.total - a.total || b.winners.length - a.winners.length);

  const wrap = el('div', 'rqum-mass');
  wrap.appendChild(el('p', 'rqum-muted rqum-mass__intro', `TGO players known to RQUM: who among us can hit them, and the units a mass would kill: Now (the attacks each member has left) and Best (everyone with ${MASS_ATTACKS} attacks of ${MASS_TURNS} turns, an assassination and a sabotage, and from when). Click a line for the details.`));
  const table = el('table', 'rqum-mass__table');
  const head = el('tr');
  for (const [h, title] of [['Target'], ['Def', 'Their defense ("> X": only a minimum is known)'], ['Attack', 'Members whose offense beats their defense / members in range (10 levels)'], ['Ratio', 'Best offense ÷ defense among us'], ['🗡️ / 💥', 'Members who can still assassinate / sabotage them today (spy offense above their spy defense; once a day each)'], ['Now', 'Units a mass right now would kill: the attacks each member has left (capped: 5 % of their army, 1,269 a day, less what we already killed)'], ['Best', 'Units a mass in the best conditions would kill: everyone with their 5 attacks, assassination and sabotage, and when that is possible']]) {
    const th = el('th', '', h);
    if (title) th.title = title;
    head.appendChild(th);
  }
  table.appendChild(el('thead')).appendChild(head);
  const body = table.appendChild(el('tbody'));
  const short = (v) => RQUM.formatNumber(v);
  for (const r of rows) {
    const tr = el('tr', 'rqum-mass__row');
    const name = el('td', 'rqum-mass__name');
    const b = el('button', 'rqum-link-btn', r.t.player_name || `#${r.t.player_id}`);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); opts.pick?.(String(r.t.player_id), r.t.player_name); });
    name.append(b, el('span', 'rqum-muted', r.level != null ? ` Lv ${r.level}` : ''));
    const def = el('td', '', r.def ? `${r.def.floor ? '> ' : ''}${short(r.def.v)}` : '?');
    if (!r.def) def.title = 'Defense not known to RQUM: spy them first';
    // Older than 24 h: in orange, spy them again before the mass.
    if (r.seen) {
      const old = Date.now() - Date.parse(r.seen) > 24 * 3600000;
      def.appendChild(el('span', `rqum-mass__age${old ? ' is-old' : ''}`, ` ${RQUM.formatAge(r.seen)}`));
      def.title = `Seen ${RQUM.formatAge(r.seen)} ago${old ? ': spy them again before the mass' : ''}`;
    }
    const atk = el('td', r.winners.length ? 'is-win' : '', r.def ? `${r.winners.length} / ${r.inRange.length}` : `? / ${r.inRange.length}`);
    atk.title = r.winners.map((a) => `${a.name}: ×${a.ratio.toFixed(2)}${a.sure ? '' : ' (their defense may be higher)'}`).join('\n') || 'Nobody beats their defense';
    const best = el('td', '', r.attackers[0]?.ratio ? `×${r.attackers[0].ratio.toFixed(2)}` : '—');
    const spy = el('td', '', r.sdef ? `${r.attackers.filter((a) => a.canAssassinate).length} / ${r.attackers.filter((a) => a.canSabotage).length}` : '?');
    spy.title = r.sdef ? (r.spies.map((a) => `${a.name}${a.canAssassinate ? '' : ' (assassination used today)'}${a.canSabotage ? '' : ' (sabotage used today)'}`).join('\n') || 'Nobody beats their spy defense') : 'Spy defense not known to RQUM';
    // A mass's estimate: units, "≈" at their daily cap; its detail on hover.
    const killCell = (m, label) => {
      const td = el('td', 'rqum-mass__kills', r.army && r.def ? `${m.capped ? '≈' : ''}${Math.round(m.total)}` : '?');
      td.title = r.army && r.def
        ? `${label}\nAttacks: ${Math.round(m.fromAttacks)} · assassinations: ${Math.round(m.fromAssassins)} (${m.assassins} assassin${m.assassins === 1 ? '' : 's'})\nCap: ${Math.round(m.cap)} (5 % of ${RQUM.formatExact(r.army)} units, at most ${MASS_DAY_CAP}${m.cap < r.fullCap ? `, less ${Math.round(r.fullCap - m.cap)} we already killed in 24 h` : ''})${m.capped ? ': reached' : ''}\n${m.fortSim ? `Fort: ${Math.round(m.fortSim.startHp)} → ${Math.round(m.fortSim.afterSabo)} HP after ${m.fortSim.saboteurs} sabotage${m.fortSim.saboteurs === 1 ? '' : 's'} → ${Math.round(m.fortSim.endHp)} / ${RQUM.formatExact(r.fortMax)} HP after the attacks (protection ${r.protection.toFixed(2)} → ${massProtection((m.fortSim.endHp / r.fortMax) * 100).toFixed(2)})` : `Fort protection used: ${r.protection.toFixed(2)} (their fort's maximum HP is not known: spy them or open their profile)`}`
        : (r.def ? 'Their army is not known to RQUM' : 'Their defense is not known to RQUM');
      // How close to their daily cap (the goal of a mass: reach it), as a gauge.
      if (r.army && r.def) {
        const pct = m.cap ? Math.min(100, ((m.fromAttacks + m.fromAssassins) / m.cap) * 100) : 100;
        const gauge = el('span', `rqum-mass__gauge${pct >= 100 ? ' is-full' : pct >= 70 ? ' is-near' : ''}`);
        const fill = el('span', 'rqum-mass__gauge-fill');
        fill.style.width = `${pct}%`;
        gauge.appendChild(fill);
        td.append(gauge, el('span', 'rqum-mass__gauge-text', m.cap ? `${Math.round(pct)} % of cap (${Math.round(m.cap)})` : 'cap reached today'));
      }
      return td;
    };
    const readyLabel = r.readyAt > Date.now() + 60000
      ? new Date(r.readyAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : 'now';
    const nowCell = killCell(r.now, `Now: each member's attacks left (5 a day on a target, and their turns), the assassinations and sabotages not used today${r.done.attacks ? `\nAlready today: ${r.done.attacks} of our attacks${r.done.sabotages ? `, ${r.done.sabotages} sabotage${r.done.sabotages === 1 ? '' : 's'}` : ''} on them` : ''}`);
    const bestCell = killCell(r.full, `Best: everyone in range with their 5 attacks, assassination and sabotage, possible ${readyLabel === 'now' ? 'now' : `from ${readyLabel}`} (enough turns assumed)`);
    bestCell.appendChild(el('span', 'rqum-mass__ready', readyLabel === 'now' ? ' now' : ` ${readyLabel}`));
    tr.append(name, def, atk, best, spy, nowCell, bestCell);
    // Details: every member in range.
    const det = el('tr', 'rqum-mass__detail');
    det.hidden = true;
    const cell = el('td');
    cell.colSpan = 7;
    // What this target's estimate lacks, and how to get it.
    const missing = [];
    const old = r.seen && Date.now() - Date.parse(r.seen) > 24 * 3600000;
    if (!r.def) missing.push('their defense (spy them)');
    else if (r.def.floor) missing.push('their real defense: only a minimum is known (spy them)');
    else if (old) missing.push(`fresh figures: seen ${RQUM.formatAge(r.seen)} ago (spy them again)`);
    if (!r.sdef) missing.push('their spy defense (spy them): assassinations and sabotages not counted');
    if (!Array.isArray(r.st.report_army?.v)) missing.push(r.army ? 'their units by category (a spy report): the profile\'s army is used, assassinations at the base 6–11' : 'their units (a spy report)');
    if (!r.fortMax) missing.push('their fort\'s maximum HP (a spy report or their profile): the fort is not played hit by hit, the order changes nothing');
    const noOff = r.inRange.filter((m) => m.off == null).map((m) => m.name);
    if (noOff.length) missing.push(`the offense of ${noOff.join(', ')} (their RQUM has not sent it)`);
    const noLogs = r.inRange.filter((m) => !m.war).map((m) => m.name);
    if (noLogs.length) missing.push(`the logs of ${noLogs.join(', ')} (their attacks of today are not known)`);
    if (missing.length) {
      const box = el('div', 'rqum-mass__missing');
      box.appendChild(el('strong', '', '🔎 To be more precise on this target:'));
      const ul = el('ul');
      for (const m of missing) ul.appendChild(el('li', '', m));
      box.appendChild(ul);
      cell.appendChild(box);
      const warn = el('span', 'rqum-mass__warn', `⚠️ ${missing.length}`);
      warn.title = `To be more precise on this target:\n• ${missing.join('\n• ')}\n(click the line)`;
      name.appendChild(warn);
    }
    if (!r.inRange.length) cell.appendChild(el('p', 'rqum-muted', 'Nobody of ours in range (10 levels).'));
    else {
      const t2 = el('table', 'rqum-hit__table');
      const h2 = el('tr');
      ['Member', 'Lv', 'Offense', 'Ratio', 'Wins?', 'Attacks left', 'Spy'].forEach((h) => h2.appendChild(el('th', '', h)));
      t2.appendChild(el('thead')).appendChild(h2);
      const b2 = t2.appendChild(el('tbody'));
      for (const a of r.attackers) {
        const row = el('tr');
        row.append(el('td', '', a.name), el('td', '', a.level ?? '?'), el('td', '', a.off != null ? short(a.off) : '?'),
          el('td', '', a.ratio ? `×${a.ratio.toFixed(2)}` : '?'),
          el('td', a.beats ? 'is-win' : a.beats === false ? 'is-loss' : '', a.beats == null ? '?' : a.beats ? (a.sure ? '✓' : '✓?') : '✗'),
          el('td', '', `${a.attacks}${a.day.attacks ? ` (${a.day.attacks} used, all back ${new Date(a.back).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})` : ''}${a.turns != null && a.turns < MASS_TURNS * MASS_ATTACKS ? ` · ${a.turns} turns` : ''}`),
          el('td', a.spyOk ? 'is-win' : '', a.spyOk == null ? '?' : a.spyOk ? `${a.canAssassinate ? '🗡️' : '·'}${a.canSabotage ? '💥' : '·'}` : '✗'));
        b2.appendChild(row);
      }
      cell.appendChild(t2);
      // The best order of each mass, step by step (sabotages, attacks, assassinations).
      for (const [label, m] of [[`📋 Order: mass now (${Math.round(r.now.total)} units)`, r.now], [`📋 Order: best mass, ${readyLabel === 'now' ? 'now' : `from ${readyLabel}`} (${Math.round(r.full.total)} units)`, r.full]]) {
        const plan = el('details', 'rqum-mass__plan');
        plan.appendChild(el('summary', '', label));
        if (!r.fortMax) plan.appendChild(el('p', 'rqum-muted rqum-mass__plan-end', 'Their fort\'s maximum HP is not known (spy them or open their profile): the order of the attacks changes nothing here. With it, the attackers who hit the fort hard for the units they kill go first and the biggest ratios last, once the fort is down.'));
        const ol = el('ol');
        let sum = 0;
        let capShown = false;
        for (const st2 of m.steps) {
          const fort = st2.from != null && st2.to != null ? ` · fort ${Math.round(st2.from)} → ${Math.round(st2.to)} HP` : '';
          const what = st2.act === 'sabotage' ? '💥 sabotage' : st2.act === 'assassinate' ? '🗡️ assassinate (biggest unit category)' : `⚔️ attack ×${st2.n}${st2.wins === false ? ' (loses)' : ''}`;
          sum += st2.kills;
          const li = el('li', '', `${st2.who}: ${what}${fort}${st2.kills ? ` · ~${Math.round(st2.kills)} killed · cap ${Math.min(100, Math.round((sum / Math.max(1, m.cap)) * 100))} %` : ''}`);
          if (!capShown && sum > m.cap) {
            li.appendChild(el('span', 'rqum-mass__cap', ` (cap of ${Math.round(m.cap)} reached: the next hits kill about 1 unit per type)`));
            capShown = true;
          }
          ol.appendChild(li);
        }
        if (!m.steps.length) ol.appendChild(el('li', 'rqum-muted', 'Nothing possible.'));
        plan.appendChild(ol);
        const reach = m.fromAttacks + m.fromAssassins;
        plan.appendChild(el('p', `rqum-mass__plan-end${reach >= m.cap ? ' is-full' : ''}`, reach >= m.cap
          ? `🎯 Their daily cap (${Math.round(m.cap)} units) is reached.`
          : `${Math.round(m.cap - reach)} units short of their daily cap (${Math.round(m.cap)}): ${Math.round((reach / Math.max(1, m.cap)) * 100)} % of it.`));
        cell.appendChild(plan);
      }
    }
    det.appendChild(cell);
    tr.addEventListener('click', () => { det.hidden = !det.hidden; });
    body.append(tr, det);
  }
  if (!rows.length) body.appendChild(el('tr')).appendChild(el('td', 'rqum-muted', 'No TGO player known to RQUM yet.'));
  const scroll = el('div', 'rqum-hit__scroll');
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  const about = el('details', 'rqum-hit__about');
  about.appendChild(el('summary', '', 'ℹ️ How is it worked out?'));
  for (const line of [
    'Only the attacks that win are in the masses (offense strictly above their defense): a lost attack kills almost nothing and costs the attacker units and turns. Such a member still counts for their sabotage and assassination.',
    'Columns. Def: their defense ("> X": only a minimum is known) and how old it is (orange past 24 h: spy them again). Attack: members whose offense beats it / members in range (10 levels either way). Ratio: the best offense ÷ defense among us. 🗡️ / 💥: members who can still assassinate / sabotage them today (spy offense strictly above their spy defense; once a day each, per member).',
    'Now: a mass right away. Each member makes the attacks they have left (5 a day on one target, less those of the last 24 h, from their logs; and only as many as their turns allow, 10 an attack), the assassinations and sabotages not used today; their cap is what is left of it after the units we already killed in 24 h; our hits of the last 24 h already wear their fort.',
    'Best: everyone in range with their 5 attacks, assassination and sabotage, their full cap and a fresh fort, from the time shown (24 h after our last hit on them; enough turns assumed). It is the column the list is sorted by.',
    `Kills per attack (the game's formula): units × 0.01 × dominance × turn bonus (10 turns: 1.09) × fort protection ÷ 3.17, dominance = 1 + 4 (r − 1) ÷ (r + 3) with r = offense ÷ defense. A lost attack still kills a little when the offense is above 60 % of the defense.`,
    `Fort protection: 0.05 with a full fort, 0.10 at half, 0.25 at 0 HP (in straight lines between): the lower their fort, the more each attack kills. With their fort's maximum HP (a spy report or their profile), the mass is played hit by hit. Each attack hits the fort for 10 × turns × min(2, offense ÷ defense) × (1 + the member's Siege Workshop bonus), less after each hit on it in 24 h (÷ (1 + 0.15 × hits), at least half); a fort at 0 HP adds 0.05 % of their units per won attack. Without the maximum HP, the fort stays as it is now.`,
    `Assassination: the most of 6 to 11 units and the assassin's Spy Academy share of the target's biggest unit category (level 2: 0.04 %, 3: 0.07 %, 4: 0.11 %, 5+: 0.15 %; from their last spy report), at most 100, × 80 % intensity (Dexterity and Vigilance not known). Sabotage kills no unit: it hits the fort for the most of 400–750 and the saboteur's Siege Workshop share of its maximum HP (level 1: 10 % … 10: 30 %), ÷ (1 + the sabotages before in 24 h), at most 2,000, and blocks the next tick's income.`,
    `Cap: a defender loses at most 5 % of their units and ${MASS_DAY_CAP} in 24 h, all attacks and assassinations together: the goal of a mass is to reach it. The gauge shows how close each mass gets (orange from 70 %, green when reached; "≈": reached). Losses others gave them today are not known: their cap may be reached sooner.`,
    '📋 Order (under each target): the sabotages first, biggest Siege Workshops first (each next one does less); then the attacks, first those who hit the fort hard for the units they kill (an attack\'s fort damage stops growing at a ratio of 2, its kills do not), the biggest ratios last, once the fort is down and their protection up; the assassinations last (they do not depend on the fort). Each step shows the fort and the share of their cap reached. Without their fort\'s maximum HP the order changes nothing.',
    'To be more precise: a fresh spy report on them (their defense, spy defense, units, fort and its maximum HP: each target lists what it lacks under its line); every member playing with RQUM and opening the game now and then (their offense, turns, buildings and logs reach the database by themselves); our members\' Dexterity (not read yet). Never known: their Vigilance, the losses and fort hits other clans gave them today, the exact protection between the game\'s three points.',
    'Figures from RQUM: their defense, spy defense, fort and units from spy reports and profiles; our offense, spy offense, turns, Siege Workshop and Spy Academy from each member\'s own RQUM (every hour); what we did in 24 h from each member\'s Battle Logs and spy logs (every 30 minutes). The units counted are those of their last spy report (their army when there is none).',
  ]) about.appendChild(el('p', '', line));
  wrap.appendChild(about);
  return wrap;
};

// ---- Active Time tab: when players play ------------------------------------------------------
// Every action RQUM knows with its hour, from the members' war statistics (rqum_war_clan):
// an enemy's attacks on any member (their activity), a member's own attacks, assassinations,
// sabotages and spy operations (theirs). Shown in my own time: a list with a 24-hour strip per
// player (darker = more actions), a click opens their week × hour heatmap and their usual hours.
// data: { members: rows of rqum_war_clan, tgo: Set of TGO ids, clan: Set of RQUM member ids }.
const ACTIVE_KEY = 'rqumActiveView';
RQUM.activeView = (data, opts = {}) => {
  let state = { who: 'tgo', days: 30, q: '' };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(ACTIVE_KEY) || '{}') }; } catch (_) { /* storage off */ }
  // player id -> { name, hours: { "2026-11-15T18": n } }
  const players = new Map();
  const add = (id, name, h, n) => {
    if (!n) return;
    const p = players.get(id) || { id, name, hours: {} };
    if (name) p.name = name;
    p.hours[h] = (p.hours[h] || 0) + n;
    players.set(id, p);
  };
  for (const m of data.members || []) {
    const me = String(m.player_id);
    for (const [pid, p] of Object.entries(m.stats?.attackers || {})) {
      if (pid.startsWith('name:')) continue;
      for (const [h, v] of Object.entries(p.hours || {})) add(pid, p.name, h, v.attacks || 0);
    }
    for (const p of Object.values(m.stats?.attacked || {})) {
      for (const [h, v] of Object.entries(p.hours || {})) add(me, m.name, h, (v.attacks || 0) + (v.assassinations || 0) + (v.sabotages || 0));
    }
    // Spy operations: mine (recons, sabotages, assassinations) for me; their spies, caught (their
    // name is known) for them.
    for (const [pid, p] of Object.entries(m.stats?.spies || {})) {
      for (const [h, v] of Object.entries(p.hours || {})) {
        add(me, m.name, h, (v.reconWon || 0) + (v.reconLost || 0) + (v.opsWon || 0) + (v.opsLost || 0));
        if (!pid.startsWith('name:')) add(pid, p.name, h, (v.caught || 0) + (v.spiedMe || 0));
      }
    }
  }
  const wrap = el('div', 'rqum-active');
  const bar = el('div', 'rqum-daily__bar');
  const who = el('select');
  for (const [k, label] of [['tgo', 'TGO'], ['clan', 'RQUM members'], ['all', 'Everyone known']]) who.appendChild(new Option(label, k));
  who.addEventListener('change', () => { state.who = who.value; draw(); });
  const days = el('select');
  for (const d of [7, 30, 90]) days.appendChild(new Option(`Last ${d} days`, String(d)));
  days.addEventListener('change', () => { state.days = Number(days.value); draw(); });
  const search = el('input');
  search.placeholder = 'Search a player';
  search.addEventListener('input', () => { state.q = search.value; draw(); });
  bar.append(who, days, search);
  const legend = el('div', 'rqum-active__hours');
  for (let h = 0; h < 24; h++) legend.appendChild(el('span', '', h % 3 === 0 ? String(h) : ''));
  const list = el('div', 'rqum-active__list');
  const detail = el('div', 'rqum-active__detail');
  wrap.append(bar, detail, list);
  wrap.appendChild(el('p', 'rqum-muted rqum-daily__note', 'Hours in your own time. From the members\' Battle Logs and spy logs read by their RQUM: an enemy\'s activity is their attacks on us and their spies we caught (a spy who gets through is anonymous; what they do to other clans is not seen), a member\'s is their own attacks and spy operations. The more actions, the darker. A few actions say little: the number of actions is shown on each line.'));

  // One player's actions over the period: by hour of the day (24) and by weekday × hour (7 × 24).
  function profile(p) {
    const from = new Date(Date.now() - state.days * 86400000).toISOString().slice(0, 13);
    const byHour = new Array(24).fill(0);
    const byDay = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let total = 0;
    let last = null;
    for (const [h, n] of Object.entries(p.hours)) {
      if (h < from) continue;
      const d = new Date(`${h}:00:00Z`);
      byHour[d.getHours()] += n;
      byDay[(d.getDay() + 6) % 7][d.getHours()] += n;
      total += n;
      if (!last || h > last) last = h;
    }
    return { byHour, byDay, total, last };
  }
  // Their usual hours: the hours holding most of their actions, as ranges ("18:00–23:00").
  function usual(byHour) {
    const total = byHour.reduce((a, b) => a + b, 0);
    if (!total) return '';
    const sorted = byHour.map((n, h) => [h, n]).sort((a, b) => b[1] - a[1]);
    const keep = new Set();
    let sum = 0;
    for (const [h, n] of sorted) { if (sum >= total * 0.7 || !n) break; keep.add(h); sum += n; }
    // A single quiet hour between two busy ones is part of the same stretch.
    for (let h = 0; h < 24; h++) if (!keep.has(h) && keep.has((h + 23) % 24) && keep.has((h + 1) % 24)) keep.add(h);
    // Runs of kept hours; one running past midnight joins its two ends.
    const segs = [];
    let start = null;
    for (let h = 0; h <= 24; h++) {
      const on = h < 24 && keep.has(h);
      if (on && start == null) start = h;
      if (!on && start != null) { segs.push([start, h]); start = null; }
    }
    if (segs.length > 1 && segs[0][0] === 0 && segs[segs.length - 1][1] === 24) segs[segs.length - 1][1] = 24 + segs.shift()[1];
    const t = (h) => `${String(h % 24).padStart(2, '0')}:00`;
    return segs.map(([a, b]) => `${t(a)}–${t(b)}`).join(', ');
  }
  const shade = (n, max) => (n ? `rgba(212,162,76,${(0.15 + 0.85 * (n / max)).toFixed(2)})` : 'rgba(255,255,255,.04)');

  function showDetail(p) {
    const pr = profile(p);
    const max = Math.max(1, ...pr.byDay.flat());
    const box = el('div', 'rqum-active__card');
    const close = el('button', 'rqum-link-btn', '✕');
    close.type = 'button';
    close.addEventListener('click', () => detail.replaceChildren());
    const name = el('button', 'rqum-link-btn rqum-active__name', p.name || `#${p.id}`);
    name.type = 'button';
    name.addEventListener('click', () => opts.pick?.(p.id, p.name));
    const head = el('div', 'rqum-active__head');
    head.append(name, el('span', 'rqum-muted', ` ${pr.total} action${pr.total === 1 ? '' : 's'}${pr.last ? ` · last ${RQUM.formatAge(`${pr.last}:00:00Z`)} ago` : ''}`), close);
    box.appendChild(head);
    if (pr.total) box.appendChild(el('p', 'rqum-active__usual', `🕒 Usually active: ${usual(pr.byHour)}`));
    const grid = el('div', 'rqum-active__grid');
    grid.appendChild(el('span'));
    for (let h = 0; h < 24; h++) grid.appendChild(el('span', 'rqum-active__hlabel', h % 3 === 0 ? String(h) : ''));
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d, i) => {
      grid.appendChild(el('span', 'rqum-active__dlabel', d));
      for (let h = 0; h < 24; h++) {
        const n = pr.byDay[i][h];
        const c = el('span', 'rqum-active__cell');
        c.style.background = shade(n, max);
        c.title = `${d} ${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00: ${n} action${n === 1 ? '' : 's'}`;
        grid.appendChild(c);
      }
    });
    box.appendChild(grid);
    detail.replaceChildren(box);
  }

  function draw() {
    try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(state)); } catch (_) { /* storage off */ }
    who.value = state.who;
    days.value = String(state.days);
    if (search.value !== state.q) search.value = state.q;
    const q = state.q.trim().toLowerCase();
    const rows = [...players.values()]
      .filter((p) => state.who === 'all' || (state.who === 'tgo' ? data.tgo?.has(p.id) : data.clan?.has(p.id)))
      .filter((p) => !q || String(p.name || '').toLowerCase().includes(q))
      .map((p) => ({ p, pr: profile(p) }))
      .filter((r) => r.pr.total)
      .sort((a, b) => b.pr.total - a.pr.total);
    list.replaceChildren(el('div', 'rqum-active__row rqum-active__legend'));
    list.firstChild.append(el('span'), legend.cloneNode(true), el('span'));
    for (const { p, pr } of rows) {
      const row = el('div', 'rqum-active__row');
      const max = Math.max(1, ...pr.byHour);
      const strip = el('span', 'rqum-active__strip');
      pr.byHour.forEach((n, h) => {
        const c = el('span', 'rqum-active__cell');
        c.style.background = shade(n, max);
        c.title = `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00: ${n} action${n === 1 ? '' : 's'}`;
        strip.appendChild(c);
      });
      const name = el('span', 'rqum-active__label', p.name || `#${p.id}`);
      name.title = `Usually active: ${usual(pr.byHour)}`;
      row.append(name, strip, el('span', 'rqum-active__count', String(pr.total)));
      row.addEventListener('click', () => showDetail(p));
      list.appendChild(row);
    }
    if (!rows.length) list.appendChild(el('p', 'rqum-muted', 'No action known for these players in this period.'));
  }
  draw();
  return wrap;
};

// ---- War Room tab: the TGO tally of the day, records, who gets farmed ------------------------
// From the members' war statistics (rqum_war_clan: each member's Battle Logs and spy logs read by
// their RQUM, by the hour; their best single battles). Days are the viewer's own days.
// data: { members: rows of rqum_war_clan, tgo: Set of TGO ids, clan: Set of RQUM member ids }.
const WAR_KEY = 'rqumWarRoom2';
RQUM.warRoomView = (data, opts = {}) => {
  let state = { part: 'tally', tgo: true, days: 1 };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(WAR_KEY) || '{}') }; } catch (_) { /* storage off */ }
  const members = data.members || [];
  const isTgo = (pid) => data.tgo?.has(String(pid));
  const localDay = (h) => {
    const d = new Date(`${h}:00:00Z`);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const todayKey = localDay(new Date().toISOString().slice(0, 13));
  const n = (v) => RQUM.formatNumber(Math.round(v || 0));
  const x = (v) => RQUM.formatExact(Math.round(v || 0));
  const name = (m) => m.name || `#${m.player_id}`;
  const bars = (title, rows, fmt = n) => {
    const b = el('div', 'rqum-hit__bars');
    b.appendChild(el('div', 'rqum-hit__chart-title', title));
    const max = Math.max(1, ...rows.map((r) => r.v));
    for (const r of rows) {
      const line = el('div', 'rqum-hit__bar');
      const track = el('span', 'rqum-hit__bar-track');
      const fill = el('span', 'rqum-hit__bar-fill');
      fill.style.width = `${Math.max(2, (r.v / max) * 100)}%`;
      track.appendChild(fill);
      line.title = r.title || `${r.name}: ${x(r.v)}`;
      line.append(el('span', 'rqum-hit__bar-name', r.name), track, el('span', 'rqum-hit__bar-v', fmt(r.v)));
      b.appendChild(line);
    }
    if (!rows.length) b.appendChild(el('p', 'rqum-muted', 'Nothing yet.'));
    return b;
  };
  const tiles = (items) => {
    const t = el('div', 'rqum-hit__tiles');
    for (const [label, value, title, color] of items) {
      const tile = el('div', 'rqum-hit__tile');
      tile.title = title || '';
      const v = el('strong', '', value);
      if (color) v.style.color = color;
      tile.append(el('span', 'rqum-hit__tile-label', label), v);
      t.appendChild(tile);
    }
    return t;
  };

  // Each member's figures by local day: what they did (attacked) and what they took (attackers).
  // opponent filter: TGO only or everyone.
  function byDay(m, onlyTgo) {
    const days = {};
    const day = (d) => (days[d] ??= { attacks: 0, wins: 0, gold: 0, killed: 0, lost: 0, assassinated: 0, sabotages: 0, hitsIn: 0, goldLost: 0, lostIn: 0, killedIn: 0 });
    for (const [pid, p] of Object.entries(m.stats?.attacked || {})) {
      if (onlyTgo && !isTgo(pid)) continue;
      for (const [h, v] of Object.entries(p.hours || {})) {
        const o = day(localDay(h));
        o.attacks += v.attacks || 0; o.wins += v.wins || 0; o.gold += v.gold || 0; o.killed += v.killed || 0; o.lost += v.lost || 0;
        o.assassinated += v.assassinated || 0; o.sabotages += v.sabotages || 0;
      }
    }
    // Their attacks on us: "killed" = our units they killed, "lost" = theirs we killed defending.
    for (const [pid, p] of Object.entries(m.stats?.attackers || {})) {
      if (onlyTgo && !isTgo(pid)) continue;
      for (const [h, v] of Object.entries(p.hours || {})) {
        const o = day(localDay(h));
        o.hitsIn += v.attacks || 0; o.goldLost += v.gold || 0; o.lostIn += v.killed || 0; o.killedIn += v.lost || 0;
      }
    }
    return days;
  }

  const wrap = el('div', 'rqum-war-room');
  // The parts and the periods as the Ranking tab's buttons.
  const bar = el('div', 'rqum-war-room__bar');
  const parts = el('div', 'rqum-ranking__tabs');
  for (const [k, label] of [['tally', '⚔️ TGO today'], ['bounties', '🎯 Bounties'], ['records', '🏆 Records'], ['farmed', '🌾 Farmed']]) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.p = k;
    b.addEventListener('click', () => { state.part = k; draw(); });
    parts.appendChild(b);
  }
  const tgoBox = el('input');
  tgoBox.type = 'checkbox';
  tgoBox.addEventListener('change', () => { state.tgo = tgoBox.checked; draw(); });
  const tgoLabel = el('label', 'rqum-daily__tgo');
  tgoLabel.append(tgoBox, ' TGO only');
  const days = el('div', 'rqum-ranking__tabs rqum-war-room__days');
  for (const [d, label] of [[1, '1 day'], [7, '7 days'], [30, '30 days'], [0, 'All time']]) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.d = String(d);
    b.title = d ? `The last ${d === 1 ? '24 hours' : `${d} days`}` : 'Everything RQUM has read';
    b.addEventListener('click', () => { state.days = d; draw(); });
    days.appendChild(b);
  }
  bar.append(parts, days, tgoLabel);
  const view = el('div');
  wrap.append(bar, view);
  wrap.appendChild(el('p', 'rqum-muted rqum-daily__note', 'From each member\'s Battle Logs and spy logs, read by their RQUM (every 30 min while the game is open): members without RQUM are missing. Days are your own days (midnight to midnight).'));

  // ⚔️ The TGO tally of the day, the days before as a chart, and today's members.
  function tally() {
    const perDay = {};
    const today = [];
    for (const m of members) {
      const d = byDay(m, true);
      for (const [k, o] of Object.entries(d)) {
        const t = (perDay[k] ??= { attacks: 0, wins: 0, gold: 0, killed: 0, lost: 0, assassinated: 0, sabotages: 0, hitsIn: 0, goldLost: 0, lostIn: 0, killedIn: 0 });
        for (const f of Object.keys(t)) t[f] += o[f];
      }
      if (d[todayKey]) today.push({ m, o: d[todayKey] });
    }
    const t = perDay[todayKey] || { attacks: 0, wins: 0, gold: 0, killed: 0, lost: 0, assassinated: 0, sabotages: 0, hitsIn: 0, goldLost: 0, lostIn: 0, killedIn: 0 };
    const kills = t.killed + t.killedIn + t.assassinated;
    const losses = t.lost + t.lostIn;
    const out = [el('div', 'rqum-hit__chart-title', `⚔️ Against TGO today (${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })})`)];
    out.push(tiles([
      ['Attacks', `${t.wins}W / ${t.attacks}`, 'Our attacks on TGO, won / total'],
      ['TGO units killed', n(kills), `${x(t.killed)} in our attacks, ${x(t.killedIn)} defending, ${x(t.assassinated)} assassinated`, '#22c55e'],
      ['Our units lost', n(losses), `${x(t.lost)} in our attacks, ${x(t.lostIn)} in theirs`, '#ef4444'],
      ['K/D', losses ? (kills / losses).toFixed(2) : kills ? '∞' : '—', 'TGO units killed ÷ our units lost', kills >= losses ? '#22c55e' : '#ef4444'],
      ['Gold taken', n(t.gold), `Gold we looted from TGO: ${x(t.gold)}`, '#facc15'],
      ['Gold lost', n(t.goldLost), `Gold TGO looted from us: ${x(t.goldLost)}`, '#ef4444'],
      ['Their attacks', String(t.hitsIn), 'TGO attacks on us today'],
      ['Sabotages', String(t.sabotages), 'Our successful sabotages on TGO today'],
    ]));
    // Day by day: TGO units killed (our attacks, defending, assassinations), the last 30 days.
    let run = 0;
    const keys = Object.keys(perDay).sort().slice(-30);
    const series = keys.map((k) => ({ hour: `${k}T12:00:00`, v: (run += perDay[k].killed + perDay[k].killedIn + perDay[k].assassinated) }));
    const chart = el('div', 'rqum-hit__chart');
    chart.append(el('div', 'rqum-hit__chart-title', 'TGO units killed, day by day (added up)'), RQUM.historyChart(series));
    out.push(chart);
    out.push(bars('🏅 Today against TGO: units killed by member', today.map(({ m, o }) => ({ name: name(m), v: o.killed + o.killedIn + o.assassinated, title: `${name(m)}: ${x(o.killed)} in attacks, ${x(o.killedIn)} defending, ${x(o.assassinated)} assassinated; ${o.wins}W / ${o.attacks} attacks, ${x(o.gold)} gold` })).filter((r) => r.v).sort((a, b) => b.v - a.v)));
    return out;
  }

  // 🎯 Bounties: running ones (live ranking, time left) and the last ones; a leader or the admin
  // sets one (a player, 6 / 12 / 24 h, a note) and may cancel a running one.
  function bounties() {
    const out = [];
    if (data.canSet && opts.bountyCreate) {
      const form = el('form', 'rqum-hit__add');
      const input = el('input');
      input.placeholder = 'Set a bounty: player name';
      input.autocomplete = 'off';
      const hours = el('select');
      for (const h of [6, 12, 24]) hours.appendChild(new Option(`${h} h`, String(h)));
      hours.value = '12';
      const note = el('input', 'rqum-hit__note');
      note.placeholder = 'Note (optional)';
      note.maxLength = 200;
      const found = el('ul', 'rqum-list rqum-hit__found');
      let ticket = 0;
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const q = input.value.trim();
          const mine = ++ticket;
          found.replaceChildren();
          if (q.length < 2) return;
          const rows = await opts.search(q).catch(() => []);
          if (mine !== ticket) return;
          for (const p of (rows || []).slice(0, 8)) {
            const li = el('li', 'rqum-list__item');
            const b = el('button', 'rqum-link-btn', RQUM.withClan(p.player_name || `#${p.player_id}`, p.clan));
            b.type = 'button';
            b.addEventListener('click', async () => {
              if (!confirm(`Set a ${hours.value} h bounty on ${p.player_name}? It is announced on Discord.`)) return;
              try { await opts.bountyCreate(p.player_id, p.player_name, Number(hours.value), note.value); } catch (err) { return opts.error?.(err.message); }
              RQUM.toast?.(`🎯 Bounty on ${p.player_name} for ${hours.value} h`);
              opts.reload?.();
            });
            li.appendChild(b);
            found.appendChild(li);
          }
          if (!found.children.length) found.appendChild(el('li', 'rqum-muted', 'Nobody found in the RQUM database.'));
        }, 300);
      });
      form.addEventListener('submit', (e) => e.preventDefault());
      form.append(input, hours, note);
      out.push(form, found);
    }
    const list = data.bounties || [];
    if (!list.length) out.push(el('p', 'rqum-muted', data.canSet ? 'No bounty yet: set one above.' : 'No bounty yet: the leaders set them.'));
    for (const b of list) {
      const box = el('div', `rqum-bounty${b.ended ? ' is-ended' : ''}`);
      const head = el('div', 'rqum-bounty__head');
      const who = el('strong', '', `🎯 ${b.target_name || `#${b.target_id}`}`);
      const left = Date.parse(b.ends_at) - Date.now();
      const time = b.ended
        ? `ended ${new Date(b.ends_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
        : left > 0 ? `${Math.floor(left / 3600000)}h${String(Math.floor((left % 3600000) / 60000)).padStart(2, '0')} left` : 'ending (final ranking soon)';
      head.append(who, el('span', 'rqum-muted', ` · ${time} · set by ${b.created_by || '?'}`));
      if (!b.ended && data.canSet && opts.bountyCancel) {
        const x = el('button', 'rqum-link-btn', '✕');
        x.type = 'button';
        x.title = 'Cancel this bounty';
        x.addEventListener('click', async () => {
          if (!confirm(`Cancel the bounty on ${b.target_name}?`)) return;
          try { await opts.bountyCancel(b.id); } catch (err) { return opts.error?.(err.message); }
          opts.reload?.();
        });
        head.appendChild(x);
      }
      box.appendChild(head);
      if (b.note) box.appendChild(el('div', 'rqum-hit__notetext', `📝 ${b.note}`));
      const res = Array.isArray(b.results) ? b.results : [];
      if (!res.length) box.appendChild(el('p', 'rqum-muted', 'No hit yet (members\' logs are read every 30 minutes).'));
      else {
        const t = el('table', 'rqum-hit__table');
        const h = el('tr');
        ['', 'Member', 'Killed', 'Gold', 'Attacks'].forEach((c) => h.appendChild(el('th', '', c)));
        t.appendChild(el('thead')).appendChild(h);
        const tb = t.appendChild(el('tbody'));
        res.forEach((r, i) => {
          const tr = el('tr');
          tr.append(el('td', '', ['🥇', '🥈', '🥉'][i] || String(i + 1)), el('td', '', r.name || `#${r.player_id}`), el('td', '', n(r.killed)), el('td', '', n(r.gold)), el('td', '', `${r.wins ?? 0}W / ${r.attacks ?? 0}`));
          tb.appendChild(tr);
        });
        box.appendChild(t);
      }
      out.push(box);
    }
    out.push(el('p', 'rqum-muted rqum-daily__note', 'Most units killed wins (then gold), from the members\' Battle Logs read by their RQUM, to the hour. Announced on Discord when it starts and when it ends (about 35 minutes after, once everyone\'s last hits are read).'));
    return out;
  }

  // 🏆 Records: the best day of each member (K/D, gold, kills) and the best single battles.
  function records() {
    const from = state.days ? new Date(Date.now() - state.days * 86400000) : null;
    const fromKey = from ? `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}` : '';
    const dayRec = { kd: [], gold: [], kills: [] };
    const battleRec = { kills: [], gold: [] };
    for (const m of members) {
      for (const [k, o] of Object.entries(byDay(m, state.tgo))) {
        if (k < fromKey) continue;
        const kills = o.killed + o.killedIn;
        const losses = o.lost + o.lostIn;
        const label = new Date(`${k}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        // A K/D needs some fighting to mean something: 5 attacks or more that day.
        if (o.attacks >= 5) dayRec.kd.push({ name: `${name(m)} · ${label}`, v: losses ? kills / losses : kills, title: `${name(m)}, ${label}: ${x(kills)} killed / ${x(losses)} lost in ${o.attacks} attacks` });
        dayRec.gold.push({ name: `${name(m)} · ${label}`, v: o.gold, title: `${name(m)}, ${label}: ${x(o.gold)} gold in ${o.attacks} attacks` });
        dayRec.kills.push({ name: `${name(m)} · ${label}`, v: kills, title: `${name(m)}, ${label}: ${x(kills)} units killed` });
      }
      // Single battles: the last ones kept with each opponent (their 10 latest), and the best ones
      // kept since 1.2.1 (stats.best, from 1.3.0).
      const seen = new Set();
      const consider = (pid, pname, ev) => {
        if (!ev?.at || (state.tgo && !isTgo(pid)) || (from && Date.parse(ev.at) < from.getTime())) return;
        const key = `${pid}|${ev.at}`;
        if (seen.has(key)) return;
        seen.add(key);
        const when = new Date(ev.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        battleRec.kills.push({ name: `${name(m)} → ${pname}`, v: ev.killed || 0, title: `${name(m)} attacked ${pname} on ${when}: ${x(ev.killed)} units killed, ${x(ev.gold)} gold` });
        battleRec.gold.push({ name: `${name(m)} → ${pname}`, v: ev.gold || 0, title: `${name(m)} attacked ${pname} on ${when}: ${x(ev.gold)} gold, ${x(ev.killed)} units killed` });
      };
      for (const [pid, p] of Object.entries(m.stats?.attacked || {})) for (const ev of p.recent || []) consider(pid, p.name || `#${pid}`, ev);
      for (const b of Object.values(m.stats?.best || {})) consider(b.player, b.name || `#${b.player}`, b);
    }
    const top = (list) => list.filter((r) => r.v).sort((a, b) => b.v - a.v).slice(0, 10);
    const two = el('div', 'rqum-hit__two');
    two.append(
      bars('📈 Best K/D in a day (5 attacks or more)', top(dayRec.kd), (v) => v.toFixed(2)),
      bars('💰 Most gold stolen in a day', top(dayRec.gold)),
      bars('☠️ Most units killed in a day', top(dayRec.kills)),
      bars('⚔️ Most kills in a single battle', top(battleRec.kills)),
      bars('🪙 Most gold in a single battle', top(battleRec.gold)),
    );
    return [two, el('p', 'rqum-muted rqum-daily__note', 'Single battles: each member\'s latest battles with each opponent, and their best battles kept by RQUM from 1.3.0 on.')];
  }

  // 🌾 Farmed: the members attacked the most and by whom; the players we farm the most.
  function farmed() {
    const from = state.days ? new Date(Date.now() - state.days * 86400000).toISOString().slice(0, 13) : '';
    const victims = [];
    const farmedByUs = {};
    for (const m of members) {
      const by = {};
      let hits = 0;
      let gold = 0;
      let lost = 0;
      for (const [pid, p] of Object.entries(m.stats?.attackers || {})) {
        if (state.tgo && !isTgo(pid)) continue;
        for (const [h, v] of Object.entries(p.hours || {})) {
          if (h < from) continue;
          hits += v.attacks || 0; gold += v.gold || 0; lost += v.killed || 0;
          const o = (by[pid] ??= { name: p.name || `#${pid}`, hits: 0, gold: 0 });
          o.hits += v.attacks || 0; o.gold += v.gold || 0;
        }
      }
      if (hits) {
        const worst = Object.values(by).sort((a, b) => b.hits - a.hits).slice(0, 3);
        victims.push({ name: name(m), v: hits, title: `${name(m)}: ${hits} attacks taken, ${x(gold)} gold lost, ${x(lost)} units lost\nBy: ${worst.map((w) => `${w.name} (${w.hits}, ${n(w.gold)} gold)`).join(', ')}` });
      }
      for (const [pid, p] of Object.entries(m.stats?.attacked || {})) {
        if (state.tgo && !isTgo(pid)) continue;
        for (const [h, v] of Object.entries(p.hours || {})) {
          if (h < from) continue;
          const o = (farmedByUs[pid] ??= { name: p.name || `#${pid}`, v: 0, gold: 0, by: {} });
          o.v += v.attacks || 0; o.gold += v.gold || 0;
          o.by[name(m)] = (o.by[name(m)] || 0) + (v.attacks || 0);
        }
      }
    }
    const ours = Object.values(farmedByUs).filter((r) => r.v).sort((a, b) => b.v - a.v).slice(0, 15)
      .map((r) => ({ name: r.name, v: r.v, title: `${r.name}: ${r.v} of our attacks, ${x(r.gold)} gold\nBy: ${Object.entries(r.by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => `${k} (${c})`).join(', ')}` }));
    const two = el('div', 'rqum-hit__two');
    two.append(
      bars('🌾 Our members farmed the most (attacks taken; hover: by whom)', victims.sort((a, b) => b.v - a.v).slice(0, 15), (v) => String(v)),
      bars('🚜 The players we farm the most (our attacks; hover: by whom)', ours, (v) => String(v)),
    );
    return [two];
  }

  function draw() {
    try { localStorage.setItem(WAR_KEY, JSON.stringify(state)); } catch (_) { /* storage off */ }
    parts.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.p === state.part));
    days.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.d === String(state.days)));
    tgoBox.checked = state.tgo;
    // The TGO tally is always TGO and today; the bounties have their own times.
    tgoLabel.hidden = state.part === 'tally' || state.part === 'bounties';
    days.hidden = state.part === 'tally' || state.part === 'bounties';
    view.replaceChildren(...(state.part === 'tally' ? tally() : state.part === 'bounties' ? bounties() : state.part === 'records' ? records() : farmed()));
  }
  draw();
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
const FLOORS = { total_defense: 'total_defense_floor', spy_defense: 'spy_defense_floor', total_offense: 'total_offense_floor' };

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
  const what = stat.src === 'attack' ? 'An attack failed with' : stat.src === 'defense' ? 'They won an attack against a defense of' : 'A spy operation failed with';
  span.title = `${what} ${RQUM.formatExact(stat.v)}: it is higher than that`
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
// opts.compact (a player's card): K / M / B with two decimals, short labels, no sub-lines.
RQUM.battleTotals = (att = {}, def = {}, spy = null) => {
  // One compact table, both ways: what I did to them, what they did to me. Hover a value for
  // its detail. (Their successful spy operations are anonymous in my log: not known.)
  att = att || {};
  def = def || {};
  spy = spy || {};
  const n = (v) => {
    v = v || 0;
    const a = Math.abs(v);
    for (const [d, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (+(a / d).toFixed(2) >= 1 && a >= 1e4) return `${(v / d).toFixed(2)}${u}`;
    return RQUM.formatExact(v);
  };
  const x = (v) => RQUM.formatExact(v || 0);
  const wl = (w, l) => { const s = el('span'); s.append(el('span', 'is-win', `${x(w)}W`), ' · ', el('span', 'is-loss', `${x(l)}L`)); return s; };
  const cell = (value, title, cls) => {
    const td = el('td', cls || '');
    td.append(value);
    if (title) td.title = title;
    return td;
  };
  const myAtk = att.attacks || 0;
  const theirAtk = def.attacks || 0;
  const theirWins = def.wins || 0; // their attacks that broke through
  const net = (att.gold || 0) - (def.gold || 0);
  const killedByMe = (att.killed || 0) + (def.lost || 0);
  const killedByThem = (def.killed || 0) + (att.lost || 0);
  const unknown = 'Not known: a successful spy operation on you is anonymous in your spy log';
  const rows = [
    ['⚔️ Attacks', cell(wl(att.wins, myAtk - (att.wins || 0)), `My attacks on them: ${x(myAtk)} (won · lost)`),
      cell(wl(theirWins, theirAtk - theirWins), `Their attacks on me: ${x(theirAtk)} (won · lost, from their side)`)],
    ['💰 Gold', cell(`+${n(att.gold)}`, `Gold I looted from them: ${x(att.gold)}`, 'is-win'),
      cell(`−${n(def.gold)}`, `Gold they looted from me: ${x(def.gold)}`, 'is-loss')],
    ['☠️ Units killed', cell(n(killedByMe), `${x(killedByMe)} of their units killed: ${x(att.killed)} in my attacks, ${x(def.lost)} defending`),
      cell(n(killedByThem), `${x(killedByThem)} of my units killed: ${x(def.killed)} in their attacks, ${x(att.lost)} in my attacks`)],
    ['🗡️ Assassinated', cell(n(att.assassinated), `${x(att.assassinated)} units assassinated in ${x(att.assassinations)} successful assassination${att.assassinations === 1 ? '' : 's'}`),
      cell('?', unknown, 'rqum-bt__unknown')],
    ['💥 Sabotages', cell(x(att.sabotages), `${x(att.sabotages)} successful sabotage${att.sabotages === 1 ? '' : 's'} on them`),
      cell('?', unknown, 'rqum-bt__unknown')],
    ['🕵️ Spies', cell(wl(spy.reconWon, spy.reconLost), `My recons on them (won · lost); other operations ${x(spy.opsWon)}W · ${x(spy.opsLost)}L`),
      cell(`${x(spy.caught)} caught`, `Their spies caught by my defense: ${x(spy.caught)} (${x(spy.spiedMe)} got through, anonymous)`)],
  ];
  const table = el('table', 'rqum-bt');
  const head = el('tr');
  head.append(el('th', ''), el('th', '', 'Me → them'), el('th', '', 'Them → me'));
  table.appendChild(el('thead')).appendChild(head);
  const body = table.appendChild(el('tbody'));
  for (const [label, mine, theirs] of rows) {
    const tr = el('tr');
    tr.append(el('th', '', label), mine, theirs);
    body.appendChild(tr);
  }
  const foot = el('tr', 'rqum-bt__net');
  foot.append(el('th', '', '📊 Net gold'), cell(`${net >= 0 ? '+' : '−'}${n(Math.abs(net))}`, `Gold I looted − gold they looted: ${net >= 0 ? '+' : '−'}${x(Math.abs(net))}`, net >= 0 ? 'is-win' : 'is-loss'));
  foot.lastChild.colSpan = 2;
  body.appendChild(foot);
  return table;
};

// ---- A player's card: my battles with them (the profile page's Battle totals) -----------------
// Only what my RQUM already read from my Battle Logs and spy logs (stats.js, kept in this
// browser): nothing is read from the game here. Shown only when there was a battle either way;
// not on the web page (no logs there). A fold under the card's header, open; the summary keeps
// the W / L when folded (remembered for every card).
const BT_FOLD_KEY = 'rqumCardBattlesFolded';
function battleFold(card, id) {
  if (id == null || !RQUM.warStats?.load) return;
  const box = el('details', 'rqum-card__bt');
  box.hidden = true;
  card.appendChild(box);
  RQUM.warStats.load().then((stats) => {
    const att = stats?.attacked?.[id];
    const def = stats?.attackers?.[id];
    const spy = stats?.spies?.[id];
    if (!att?.attacks && !def?.attacks && !spy) return box.remove();
    let folded = false;
    try { folded = localStorage.getItem(BT_FOLD_KEY) === '1'; } catch (_) { /* storage off */ }
    box.open = !folded;
    const n = (v) => RQUM.formatExact(v || 0);
    const sum = el('summary', 'rqum-card__bt-sum', '⚔️ My battles with them');
    const short = el('span', 'rqum-card__bt-short');
    if (att?.attacks) short.append(el('span', 'is-win', `${n(att.wins)}W`), '·', el('span', 'is-loss', `${n(att.attacks - (att.wins || 0))}L`));
    if (def?.attacks) short.append(att?.attacks ? ' / ' : '', '🛡️ ', el('span', 'is-win', `${n(def.attacks - (def.wins || 0))}W`), '·', el('span', 'is-loss', `${n(def.wins)}L`));
    sum.appendChild(short);
    box.append(sum, RQUM.battleTotals(att, def, spy || {}));
    if (stats.updatedAt) box.appendChild(el('div', 'rqum-card__bt-note', `From your Battle Logs and spy logs, read ${RQUM.formatAge(stats.updatedAt)} ago`));
    box.addEventListener('toggle', () => { try { localStorage.setItem(BT_FOLD_KEY, box.open ? '0' : '1'); } catch (_) { /* storage off */ } });
    box.hidden = false;
  }, () => box.remove());
}

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

// The game's bell: how many notifications are unread (its own /api/notifications, read only;
// marking them read is a separate call RQUM never makes). 0 when it cannot be read.
RQUM.unreadNotifications = async () => {
  try {
    const res = await fetch('/api/notifications', { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) return 0;
    const d = await res.json();
    const byCat = d?.unread_by_category;
    if (byCat && typeof byCat === 'object') return Object.values(byCat).reduce((n, v) => n + (Number(v) || 0), 0);
    return Number(d?.unread_notifications) || 0;
  } catch (_) { return 0; }
};
