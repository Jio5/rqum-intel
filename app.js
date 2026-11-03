// RQUM Intel web page: read-only view of the RQUM database, for any browser (phones included).
// Calls the same Supabase functions as the extension. Unlike the extension, the access key
// is NOT built in: each person types it once and it stays in this browser's localStorage,
// so the page itself holds no secret and its link can circulate safely.
(() => {
  const CONFIG = {
    supabaseUrl: 'https://gtmujmovynsawiypirey.supabase.co',
    anonKey: 'sb_publishable_wNTLsZD9OSCXD4sbOcxtRw_RrRN7h_1', // public "publishable" key
  };
  const GAME_URL = 'https://darkthronegame.com';
  const KEY_STORAGE = 'rqumAccessKey';
  const TAB_STORAGE = 'rqumWebTab';
  const SEARCH_DEBOUNCE_MS = 300;
  const RECENT_LIMIT = 50;
  const { el } = RQUM;
  const $ = (id) => document.getElementById(id);

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode: kept for this visit only */ } },
    remove: (k) => { try { localStorage.removeItem(k); } catch (_) { /* nothing stored */ } },
  };

  let accessKey = store.get(KEY_STORAGE);

  class KeyRefused extends Error {}

  async function rpc(fn, args = {}, key = accessKey) {
    const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: CONFIG.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: key, ...args }),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error page */ }
    if (res.status === 401 || res.status === 403) {
      const refused = new KeyRefused('Access refused: wrong or revoked personal key');
      // "This key belongs to another player" / "Unknown or revoked personal key" at sign-in.
      if (fn === 'rqum_member_login' && json?.message) refused.serverMessage = json.message;
      throw refused;
    }
    if (!res.ok) throw new Error(json?.message || `Supabase HTTP ${res.status}`);
    return json;
  }

  // A key changed on the database side logs everyone out instead of showing errors forever.
  async function call(fn, args) {
    try {
      return await rpc(fn, args);
    } catch (err) {
      if (err instanceof KeyRefused) showLogin(err.message);
      else setStatus(err.message, true);
      throw err;
    }
  }

  function setStatus(text, isError = false) {
    $('status').textContent = text;
    $('status').classList.toggle('error', isError);
  }

  // ---- Tabs ------------------------------------------------------------------

  // A player row that expands into its intel card on tap.
  // clan: shown before the name ("[TGO] Tripinhas"); sub: a second line in the row.
  function playerItem(id, name, meta, clan, sub) {
    const item = el('li', 'rqum-list__item');
    const row = el('div', 'rqum-list__row');
    row.append(RQUM.favStar(id, name), el('span', 'rqum-list__name', RQUM.withClan(name || `#${id}`, clan)), el('span', 'rqum-list__meta', meta));
    if (sub) row.appendChild(sub);
    const detail = el('div', 'rqum-list__detail');
    detail.hidden = true;
    row.addEventListener('click', async () => {
      detail.hidden = !detail.hidden;
      if (detail.hidden || detail.childElementCount) return;
      detail.appendChild(el('p', 'rqum-muted', 'Loading…'));
      let rows;
      try { rows = await call('rqum_get_players', { p_player_ids: [Number(id)] }); } catch (err) {
        detail.replaceChildren(el('p', 'rqum-muted', err.message));
        return;
      }
      detail.replaceChildren(rows?.[0] ? RQUM.intelCard(rows[0]) : el('p', 'rqum-muted', 'No stats yet.'));
      const link = el('a', '', 'Open in the game →');
      link.href = `${GAME_URL}/game/player/${id}`;
      link.target = '_blank';
      link.rel = 'noopener';
      detail.appendChild(link);
    });
    item.append(row, detail);
    return item;
  }

  // Players tab (phones): the favourites, then every player of the database; typing searches
  // players and clans.
  function renderSearchTab(body) {
    const input = el('input');
    input.type = 'search';
    input.placeholder = 'Player name or id, clan tag or name';
    input.autocomplete = 'off';
    const list = el('ul', 'rqum-list');
    const favorites = el('div');
    const everyone = el('div');
    body.append(input, favorites, everyone, list);
    const showFavorites = async () => favorites.replaceChildren(await RQUM.favoritesList(playerItem));
    showFavorites();
    showEveryone(everyone);

    let timer = null;
    let latest = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const query = input.value.trim();
        const ticket = ++latest;
        favorites.hidden = !!query;
        everyone.hidden = !!query;
        if (!query) { list.replaceChildren(); return showFavorites(); }
        let players, clans;
        try {
          [players, clans] = await Promise.all([
            call('rqum_search_players', { p_query: query }),
            call('rqum_search_clan', { p_query: query }).catch(() => []),
          ]);
        } catch (_) { return; }
        if (ticket !== latest) return; // a newer search already answered
        list.replaceChildren(...RQUM.clanGroups(clans || [], playerItem));
        if (!players.length && !clans?.length) list.appendChild(el('li', 'rqum-muted', 'No player or clan found.'));
        for (const p of players) {
          const meta = p.updated_at ? `${p.stat_count} stats · ${RQUM.formatAge(p.updated_at)} ago` : 'no stats';
          list.appendChild(playerItem(p.player_id, p.player_name, meta, p.clan));
        }
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  // Players tab (phones), search box empty: every player of the database, most recently
  // updated first, by pages of 100 ("Show more").
  const EVERYONE_PAGE = 100;
  async function showEveryone(box) {
    box.replaceChildren(el('p', 'rqum-muted', 'Loading every player…'));
    let players;
    try { players = await call('rqum_players_table', { p_limit: 3000 }) || []; } catch (err) {
      box.replaceChildren(el('p', 'rqum-muted', err.message));
      return;
    }
    const list = el('ul', 'rqum-list');
    const more = el('button', 'more-button');
    more.type = 'button';
    let shown = 0;
    const page = () => {
      for (const p of players.slice(shown, shown + EVERYONE_PAGE)) {
        const level = p.stats?.level?.v;
        const meta = [level != null ? `Lv ${level}` : null, p.updated_at ? `${RQUM.formatAge(p.updated_at)} ago` : null].filter(Boolean).join(' · ');
        list.appendChild(playerItem(p.player_id, p.player_name, meta, p.stats?.clan?.v));
      }
      shown = Math.min(shown + EVERYONE_PAGE, players.length);
      more.textContent = `Show more (${players.length - shown} left)`;
      more.hidden = shown >= players.length;
    };
    more.addEventListener('click', page);
    page();
    box.replaceChildren(el('h3', 'section-title', `All players (${RQUM.formatExact(players.length)}), most recently updated first`), list, more);
  }

  async function renderRecentTab(body) {
    body.appendChild(el('p', 'rqum-muted', 'Loading…'));
    let players;
    // Only players whose offense / defense / spy figures changed (not mere re-sightings).
    try { players = await call('rqum_recent_changes', { p_limit: RECENT_LIMIT }); } catch (err) {
      body.replaceChildren(el('p', 'rqum-muted', err.message));
      return;
    }
    body.replaceChildren();
    if (!players.length) return body.appendChild(el('p', 'rqum-muted', 'No combat stat changed in the last 60 days.'));
    const list = el('ul', 'rqum-list');
    for (const p of players) list.appendChild(playerItem(p.player_id, p.player_name, RQUM.changeAge(p), p.clan, RQUM.changeChips(p)));
    body.append(el('p', 'rqum-muted', 'Players whose Offense, Defense, Spy Offense or Spy Defense changed.'), list);
  }

  // ---- Alliance tab --------------------------------------------------------------

  // Graphs on cards (common.js) read the history straight from Supabase here.
  RQUM.fetchClanHistory = (clanId, stat, days) =>
    call('rqum_get_clan_history', { p_clan_id: Number(clanId), p_stat: stat, p_days: days }).then((rows) => rows || []);

  async function renderClansTab(body) {
    body.appendChild(el('p', 'rqum-muted', 'Loading…'));
    let clans;
    try { clans = await call('rqum_clans_list'); } catch (err) {
      body.replaceChildren(el('p', 'rqum-muted', err.message));
      return;
    }
    body.replaceChildren(RQUM.clanList(clans || []));
  }

  // A clan's members and one player's figures (Clans tab), straight from Supabase here.
  RQUM.fetchClanMembers = (tag) => call('rqum_search_clan', { p_query: tag }).then((rows) => rows || []);
  RQUM.fetchPlayer = (id) => call('rqum_get_players', { p_player_ids: [Number(id)] }).then((rows) => rows?.[0] || null);

  // A wrong point of a graph (a player's, or a clan's with clanId).
  RQUM.deleteHistoryPoint = ({ playerId, clanId, stat, hour }) => (clanId
    ? call('rqum_delete_clan_history_point', { p_clan_id: Number(clanId), p_stat: stat, p_hour: hour })
    : call('rqum_delete_history_point', { p_player_id: Number(playerId), p_stat: stat, p_hour: hour }));

  RQUM.fetchHistory = (playerId, stat, days) =>
    call('rqum_get_history', { p_player_id: Number(playerId), p_stat: stat, p_days: days }).then((rows) => rows || []);

  // RQUM, or one clan's players (TGO tab): the same list.
  async function renderAllianceTab(body, clan = null) {
    body.appendChild(el('p', 'rqum-muted', 'Loading…'));
    let players;
    try { players = await (clan ? call('rqum_clan', { p_clan: clan }) : call('rqum_alliance')); } catch (err) {
      body.replaceChildren(el('p', 'rqum-muted', err.message));
      return;
    }
    body.replaceChildren(RQUM.allianceList(players || [], (id) => {
      const link = el('a', '', 'Open in the game →');
      link.href = `${GAME_URL}/game/player/${id}`;
      link.target = '_blank';
      link.rel = 'noopener';
      return link;
    }));
  }

  // ---- Add tab: manual entry ---------------------------------------------------

  const NAME_STORAGE = 'rqumWebName';
  // Stats offered in the form, with the same keys the extension captures.
  const MANUAL_FIELDS = [
    ['total_offense', 'Total offense'], ['total_defense', 'Total defense'],
    ['spy_offense', 'Spy offense'], ['spy_defense', 'Spy defense'],
    ['wealth', 'Wealth'], ['gold_plundered', 'Gold plundered'],
    ['gold_on_hand', 'Gold on hand'], ['army', 'Army'], ['population', 'Population'],
    ['level', 'Level'], ['clan', 'Clan', 'text'],
  ];

  // "1 234 567", "1,234,567", "1.234.567" -> 1234567; "1.2M", "1,2m", "850k" -> 1200000, 850000.
  // null = not a number.
  function parseAmount(raw) {
    const s = String(raw).trim().replace(/\s/g, '');
    const short = s.match(/^(\d+(?:[.,]\d+)?)([kmb])$/i);
    if (short) {
      const mult = { k: 1e3, m: 1e6, b: 1e9 }[short[2].toLowerCase()];
      return Math.round(Number(short[1].replace(',', '.')) * mult);
    }
    return /^\d+([.,']\d{3})*$/.test(s) ? Number(s.replace(/[.,']/g, '')) : null;
  }
  RQUM.parseAmount = parseAmount; // also used by ocr.js

  // Value for <input type="datetime-local"> in local time.
  function localDateTime(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function field(labelText, input) {
    const label = el('label', 'field');
    label.append(el('span', 'field__label', labelText), input);
    return label;
  }

  function renderAddTab(body) {
    let target = null; // { id, name, isNew }

    // 1. Player: picked from the database, or a new one by id (from /game/player/{id}).
    const pickInput = el('input');
    pickInput.type = 'search';
    pickInput.placeholder = 'Player name or id';
    pickInput.autocomplete = 'off';
    const picks = el('ul', 'rqum-list');
    const picked = el('div', 'picked');
    const newName = el('input');
    newName.placeholder = 'Player name (optional)';
    const newNameField = field('Name of this new player', newName);
    newNameField.hidden = true;
    const current = el('div', 'current');

    function choose(player) {
      target = player;
      picks.replaceChildren();
      pickInput.hidden = true;
      picked.replaceChildren(el('strong', '', RQUM.cleanName(player.name) || `#${player.id}`), el('span', 'rqum-muted', ` #${player.id}`));
      const change = el('button', 'link', 'Change');
      change.type = 'button';
      change.addEventListener('click', () => {
        target = null;
        picked.replaceChildren();
        current.replaceChildren();
        newNameField.hidden = true;
        pickInput.hidden = false;
        pickInput.value = '';
        pickInput.focus();
      });
      picked.appendChild(change);
      newNameField.hidden = !player.isNew;
      current.replaceChildren();
      if (!player.isNew) {
        // What the database knows now, for comparison.
        call('rqum_get_players', { p_player_ids: [Number(player.id)] })
          .then((rows) => { if (target === player && rows?.[0]) current.replaceChildren(RQUM.intelCard(rows[0])); })
          .catch(() => {});
      }
    }

    let timer = null;
    let latest = 0;
    pickInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const query = pickInput.value.trim();
        const ticket = ++latest;
        if (!query) return picks.replaceChildren();
        let players;
        try { players = await call('rqum_search_players', { p_query: query, p_limit: 8 }); } catch (_) { return; }
        if (ticket !== latest) return;
        picks.replaceChildren();
        for (const p of players) {
          const li = el('li', 'rqum-list__item');
          const row = el('div', 'rqum-list__row');
          row.append(el('span', 'rqum-list__name', RQUM.cleanName(p.player_name) || `#${p.player_id}`), el('span', 'rqum-list__meta', `#${p.player_id}`));
          row.addEventListener('click', () => choose({ id: String(p.player_id), name: p.player_name, isNew: false }));
          li.appendChild(row);
          picks.appendChild(li);
        }
        if (/^\d+$/.test(query) && !players.some((p) => String(p.player_id) === query)) {
          const li = el('li', 'rqum-list__item');
          const row = el('div', 'rqum-list__row');
          row.append(el('span', 'rqum-list__name', `New player #${query}`), el('span', 'rqum-list__meta', 'not in the database yet'));
          row.addEventListener('click', () => choose({ id: query, name: null, isNew: true }));
          li.appendChild(row);
          picks.appendChild(li);
        } else if (!players.length) {
          picks.appendChild(el('li', 'rqum-muted', 'No player found. For a new player, type their id (the number in their profile address).'));
        }
      }, SEARCH_DEBOUNCE_MS);
    });

    // 2. Stats: empty fields are not sent.
    const inputs = {};
    const statFields = el('div', 'stat-fields');
    for (const [key, label, type] of MANUAL_FIELDS) {
      const input = el('input');
      input.name = key;
      if (type !== 'text') input.inputMode = 'decimal';
      input.autocomplete = 'off';
      inputs[key] = input;
      statFields.appendChild(field(label, input));
    }

    // Optional: pre-fill the stats from a screenshot (ocr.js). Nothing is saved until "Save".
    const shotInput = el('input');
    shotInput.type = 'file';
    shotInput.accept = 'image/*';
    shotInput.hidden = true;
    const shotButton = el('button', 'secondary', '📷 Read a screenshot');
    shotButton.type = 'button';
    shotButton.addEventListener('click', () => shotInput.click());
    const shotMessage = el('p', 'hint');
    const shotText = el('details', 'ocr-text');
    shotText.hidden = true;

    shotInput.addEventListener('change', async () => {
      const file = shotInput.files[0];
      shotInput.value = ''; // the same file can be picked again
      if (!file) return;
      shotButton.disabled = true;
      shotText.hidden = true;
      Object.values(inputs).forEach((i) => i.classList.remove('from-ocr'));
      try {
        const { stats, player, seenAt, text } = await RQUM.readScreenshot(file, (step) => { shotMessage.textContent = step; });
        const found = Object.entries(stats).filter(([key]) => inputs[key]);
        for (const [key, value] of found) {
          inputs[key].value = RQUM.formatExact(value); // never rounded: this is what gets saved
          inputs[key].classList.add('from-ocr');
        }
        // The report's own date: an old report must not count as fresh intel.
        when.classList.toggle('from-ocr', !!seenAt);
        if (seenAt) when.value = localDateTime(seenAt);
        // The target's name starts the player search (still to be picked in the list).
        if (player && !target) {
          pickInput.value = player;
          pickInput.dispatchEvent(new Event('input'));
        }
        const notes = [];
        if (player && !target) notes.push(`player "${player}" searched above, pick them in the list`);
        notes.push(seenAt ? 'date taken from the report' : 'report time not read: check "Seen on" below');
        shotMessage.textContent = (found.length
          ? `Read ${found.length} stat${found.length > 1 ? 's' : ''} (highlighted). Check them against the screenshot before saving.`
          : 'No stats found on this screenshot. A sharper, uncropped capture of the stats may work better.')
          + (notes.length ? ` (${notes.join('; ')}.)` : '');
        shotText.replaceChildren(el('summary', '', 'Text read'), el('pre', '', text.trim() || '(nothing)'));
        shotText.hidden = false;
      } catch (err) {
        shotMessage.textContent = String(err?.message || err);
      } finally {
        shotButton.disabled = false;
      }
    });

    // 3. When the stats were seen (older intel keeps its own date) and by whom.
    const when = el('input');
    when.type = 'datetime-local';
    when.value = localDateTime(new Date());
    when.max = when.value;
    const who = el('input');
    who.placeholder = 'Your in-game name';
    who.value = store.get(NAME_STORAGE) || '';
    who.autocomplete = 'nickname';

    const submit = el('button', 'primary', 'Save');
    submit.type = 'submit';
    const message = el('p', 'form-message');
    message.setAttribute('role', 'status');

    const form = el('form', 'add-form');
    form.noValidate = true;
    form.append(
      el('h2', '', 'Player'), pickInput, picks, picked, newNameField, current,
      el('h2', '', 'Stats'), shotButton, shotInput, shotMessage, shotText,
      el('p', 'hint', 'Fill only what you know. 1.2M, 850k and 1 234 567 all work.'), statFields,
      el('h2', '', 'Details'), field('Seen on', when), field('Entered by', who),
      submit, message,
    );
    body.appendChild(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fail = (text) => { message.textContent = text; message.className = 'form-message error'; };
      if (!target) return fail('Pick a player first.');

      const stats = {};
      for (const [key, label, type] of MANUAL_FIELDS) {
        const raw = inputs[key].value.trim();
        if (!raw) continue;
        if (type === 'text') { stats[key] = raw.slice(0, 80); continue; }
        const value = parseAmount(raw);
        if (value === null) return fail(`${label}: "${raw}" is not a number.`);
        stats[key] = value;
      }
      if (!Object.keys(stats).length) return fail('Fill at least one stat.');

      const seen = when.value ? new Date(when.value) : new Date();
      if (Number.isNaN(seen.getTime())) return fail('Invalid date.');
      const by = who.value.trim();
      if (!by) return fail('Enter your in-game name.');
      store.set(NAME_STORAGE, by);

      submit.disabled = true;
      message.textContent = 'Saving…';
      message.className = 'form-message';
      try {
        const res = await call('rqum_submit_stats', { p_players: [{
          player_id: target.id,
          player_name: target.isNew ? newName.value.trim() || null : target.name,
          observed_at: seen.toISOString(),
          source: 'manual',
          captured_by: by,
          stats,
        }] });
        Object.values(inputs).forEach((i) => { i.value = ''; i.classList.remove('from-ocr'); });
        shotText.hidden = true;
        shotMessage.textContent = '';
        message.textContent = res?.changed
          ? `Saved for ${target.name || newName.value.trim() || `#${target.id}`}.`
          : 'Nothing changed: the database already had these values, or newer ones.';
        if (target.isNew) target = { ...target, name: newName.value.trim() || null, isNew: false };
        choose(target); // refreshes the card with what was just saved
      } catch (err) {
        fail(err.message);
      } finally {
        submit.disabled = false;
      }
    });
  }

  // ---- Ranking tab ----------------------------------------------------------------
  async function renderRankingTab(body) {
    body.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
    let players;
    try { players = await call('rqum_alliance'); } catch (err) {
      body.replaceChildren(el('p', 'rqum-muted', err.message));
      return;
    }
    // Their figures 24 h ago, for the change shown next to each value (none if it fails).
    const before = await rpc('rqum_day_before', { p_player_ids: (players || []).map((p) => p.player_id), p_stats: RQUM.RANKING_STATS }).catch(() => []);
    body.replaceChildren(RQUM.rankingView(players || [], RQUM.dayBeforeMap(before)));
  }

  // ---- Leaderboards tab ----------------------------------------------------------------
  async function renderLeaderboardTab(body) {
    body.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
    let players;
    try { players = await call('rqum_players_table', { p_limit: 3000 }); } catch (err) {
      body.replaceChildren(el('p', 'rqum-muted', err.message));
      return;
    }
    body.replaceChildren(RQUM.leaderboardView(players || [], {}));
  }

  // ---- Hit List tab (RQUM.hitListView): the game's list as a member's extension last read it,
  // and RQUM's own targets. A name opens its card on top.
  async function renderHitListTab(body) {
    body.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
    let list;
    try { list = await call('rqum_hitlist'); } catch (err) {
      body.replaceChildren(el('p', 'rqum-muted', err.message));
      return;
    }
    const [game, members, me] = await Promise.all(['rqum_hitlist_game', 'rqum_war_clan', 'rqum_me'].map((fn) => rpc(fn).catch(() => null)));
    const ids = [...new Set([...(game?.entries || []).map((e) => Number(e.id)), ...(list || []).map((t) => Number(t.target_id))])];
    const rows = ids.length ? await call('rqum_get_players', { p_player_ids: ids }).catch(() => []) : [];
    const known = Object.fromEntries((rows || []).map((p) => [String(p.player_id), p]));
    const card = el('div', 'rqum-hit__card');
    const pick = async (id) => {
      card.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
      const p = (await call('rqum_get_players', { p_player_ids: [Number(id)] }).catch(() => []))?.[0];
      const close = el('button', 'rqum-link-btn', '✕ Close');
      close.type = 'button';
      close.addEventListener('click', () => card.replaceChildren());
      card.replaceChildren(close, p ? RQUM.intelCard(p) : el('p', 'rqum-muted', 'No stats yet.'));
      card.scrollIntoView({ block: 'nearest' });
    };
    body.replaceChildren(card, RQUM.hitListView(
      { game: game?.entries || null, gameAt: game?.saved_at, gameBy: game?.saved_by, rqum: list || [], members: members || [], me, known },
      {
        big: WIDE.matches,
        external: true,
        pick,
        profileHref: (id) => `${GAME_URL}/game/player/${id}`,
        gameHref: (path) => `${GAME_URL}${path}`,
        search: (q) => call('rqum_search_players', { p_query: q }),
        add: (id, name, note) => call('rqum_hitlist_add', { p_target_id: Number(id), p_name: name || null, p_note: note || null }),
        remove: (id) => call('rqum_hitlist_remove', { p_target_id: Number(id) }),
        reload: () => renderHitListTab(body),
        error: (m) => setStatus(m, true),
      },
    ));
  }

  // ---- FFA tab -----------------------------------------------------------------------
  async function renderFfaTab(body) {
    body.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
    let rows;
    try { rows = await call('rqum_ffa_list'); } catch (err) {
      body.replaceChildren(el('p', 'rqum-muted', err.message));
      return;
    }
    // Members open from some gold (their ⚙ Settings in the extension), me left out.
    const [shared, players, me] = await Promise.all(['rqum_member_settings', 'rqum_alliance', 'rqum_me'].map((fn) => rpc(fn).catch(() => null)));
    body.replaceChildren(RQUM.ffaView(rows || [], {
      open: shared && players ? RQUM.ffaOpenRows(shared.attack_gold, players, { name: me?.name }) : [],
      // No id nor name needed: the database takes the personal key's owner.
      set: async (hours, minGold) => {
        try { await call('rqum_ffa_set', { p_player_id: null, p_name: null, p_hours: hours, p_min_gold: minGold || 0 }); return { ok: true }; }
        catch (err) { return { ok: false, error: err.message }; }
      },
      reload: () => renderFfaTab(body),
      profileLink: (id) => {
        const link = el('a', '', 'Open in the game →');
        link.href = `${GAME_URL}/game/player/${id}`;
        link.target = '_blank';
        link.rel = 'noopener';
        return link;
      },
    }));
  }

  // ---- My entries tab: my manual entries, each correctable --------------------------
  // Shown only to members who entered stats by hand (with their personal key). Only an entry
  // that is still the player's latest value can be corrected; the date stays the same.
  async function renderMineTab(body) {
    body.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
    let rows;
    try { rows = await call('rqum_my_manual', { p_limit: 100 }); } catch (err) {
      body.replaceChildren(el('p', 'rqum-muted', err.message));
      return;
    }
    if (!rows?.length) {
      body.replaceChildren(el('p', 'rqum-muted', 'No manual entry of yours is the latest value of a player any more.'));
      return;
    }
    const labels = Object.fromEntries(MANUAL_FIELDS.map(([k, l]) => [k, l]));
    const list = el('ul', 'rqum-list mine-list');
    for (const r of rows) {
      const item = el('li', 'rqum-list__item mine-row');
      const what = el('div', 'mine-what');
      what.append(el('strong', '', RQUM.cleanName(r.player_name) || `#${r.player_id}`), el('span', '', ` · ${labels[r.stat] || r.stat.replace(/_/g, ' ')}`),
        el('span', 'rqum-list__meta', ` · ${RQUM.formatAge(r.at)} ago`));
      const form = el('form', 'mine-edit');
      const input = el('input');
      input.value = typeof r.v === 'number' ? RQUM.formatExact(r.v) : String(r.v ?? '');
      input.setAttribute('aria-label', `${labels[r.stat] || r.stat} of ${r.player_name}`);
      const save = el('button', 'primary', 'Fix');
      save.type = 'submit';
      const note = el('span', 'form-message');
      form.append(input, save, note);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = typeof r.v === 'number' ? parseAmount(input.value) : input.value.trim().slice(0, 80);
        if (value === null || value === '') { note.textContent = 'Not a number'; note.className = 'form-message error'; return; }
        save.disabled = true;
        try {
          await call('rqum_manual_fix', { p_player_id: r.player_id, p_stat: r.stat, p_value: value });
          r.v = value;
          input.value = typeof value === 'number' ? RQUM.formatExact(value) : value;
          note.textContent = 'Fixed';
          note.className = 'form-message';
        } catch (err) {
          note.textContent = err.message;
          note.className = 'form-message error';
        } finally {
          save.disabled = false;
        }
      });
      item.append(what, form);
      list.appendChild(item);
    }
    body.replaceChildren(el('p', 'rqum-muted', 'Your manual entries that are still the latest value: correct a mistake, the date stays the same.'), list);
  }

  const TABS = { search: renderSearchTab, recent: renderRecentTab, alliance: renderAllianceTab, tgo: (body) => renderAllianceTab(body, 'TGO'), ranking: renderRankingTab, clans: renderClansTab, add: renderAddTab, mine: renderMineTab, ffa: renderFfaTab, leaderboards: renderLeaderboardTab, hitlist: renderHitListTab };

  // A computer shows the big layout (as the extension's ⤢ window) right in the page, every
  // tab; a phone shows the small window's layout, one tab at a time.
  const WIDE = matchMedia('(min-width: 900px)');

  function showTab(tab) {
    if (!TABS[tab]) tab = 'search';
    store.set(TAB_STORAGE, tab);
    const body = $('body');
    const wide = WIDE.matches;
    document.body.classList.toggle('is-wide', wide);
    document.querySelector('.tabs').hidden = wide;
    $('status').hidden = wide;
    setStatus('');
    if (wide) {
      RQUM.bigView.mount(body, { ...bigOptions(), tab }, tab);
      return;
    }
    RQUM.bigView.close(); // the big layout, if it was shown
    document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    body.replaceChildren();
    TABS[tab](body);
  }

  // ---- Access key --------------------------------------------------------------

  function showLogin(error = '') {
    accessKey = null;
    store.remove(KEY_STORAGE);
    $('app').hidden = true;
    $('logout').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = error;
  }

  function showApp() {
    // The admin sees who uses the web page too (Admin tab of the extension: "+ Web").
    call('rqum_web_hello', {}).catch(() => {});
    // "My entries" only for members who entered stats by hand.
    $('mine-tab').hidden = true;
    call('rqum_my_manual', { p_limit: 1 }).then((rows) => { $('mine-tab').hidden = !rows?.length; }).catch(() => {});
    $('login').hidden = true;
    $('app').hidden = false;
    $('logout').hidden = false;
    showTab(store.get(TAB_STORAGE));
  }

  $('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('key').value.trim();
    const button = $('login').querySelector('button');
    button.disabled = true;
    $('login-error').textContent = '';
    try {
      // The personal key must belong to that in-game name (same check as the extension).
      await rpc('rqum_member_login', { p_name: $('name').value.trim() }, key);
      accessKey = key;
      store.set(KEY_STORAGE, key);
      $('key').value = '';
      showApp();
    } catch (err) {
      $('login-error').textContent = err instanceof KeyRefused ? (err.serverMessage || 'Wrong name or personal key.') : err.message;
    } finally {
      button.disabled = false;
    }
  });

  // ---- Big window (rqum/bigview.js): the same tabs, larger, for easier reading ------------
  // The data and links of the big layout (the ⤢ window, and the Players tab in the page).
  function bigOptions() {
    const gameLink = (id) => {
      const link = el('a', '', 'Open in the game →');
      link.href = `${GAME_URL}/game/player/${id}`;
      link.target = '_blank';
      link.rel = 'noopener';
      return link;
    };
    const tabs = [...document.querySelectorAll('.tabs button[data-tab]')].filter((b) => !b.hidden).map((b) => [b.dataset.tab, b.textContent]);
    return {
      tabs,
      tab: store.get(TAB_STORAGE) || 'search',
      api: {
        allPlayers: () => call('rqum_players_table', { p_limit: 3000 }),
        searchClan: (q) => call('rqum_search_clan', { p_query: q }),
        players: async (ids) => Object.fromEntries((await call('rqum_get_players', { p_player_ids: ids.map(Number) }) || []).map((p) => [String(p.player_id), p])),
        recent: () => call('rqum_recent_changes', { p_limit: 100 }),
        alliance: () => call('rqum_alliance'),
        clan: (clan) => call('rqum_clan', { p_clan: clan }),
        clans: () => call('rqum_clans_list'),
      },
      profileLink: gameLink,
      renderOther: (key, container) => TABS[key](container),
      onTab: (key) => store.set(TAB_STORAGE, key),
      onShrink: (key) => showTab(key),
      onClose: () => showTab(store.get(TAB_STORAGE)),
    };
  }
  // Phones: ⤢ opens the big window over the page.
  const openBig = () => RQUM.bigView.open(bigOptions());

  $('logout').addEventListener('click', () => showLogin());

  // Main colour (the gold by default), kept in this browser like the extension's ⚙ option:
  // the whole page is RQUM's, so the page's own --color-gold follows it too.
  const ACCENT_STORAGE = 'rqumWebAccent';
  const applyAccent = (color) => {
    const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color : RQUM.DEFAULT_ACCENT;
    RQUM.applyAccent(c);
    document.documentElement.style.setProperty('--color-gold', c);
    $('accent').value = c;
  };
  applyAccent(store.get(ACCENT_STORAGE));
  $('accent').addEventListener('input', (e) => applyAccent(e.target.value));
  $('accent').addEventListener('change', (e) => store.set(ACCENT_STORAGE, e.target.value));
  $('accent').addEventListener('dblclick', () => { store.remove(ACCENT_STORAGE); applyAccent(null); });
  $('expand').addEventListener('click', openBig);
  document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  // Turning a tablet, resizing a window: the layout that fits.
  WIDE.addEventListener('change', () => { if (!$('app').hidden) showTab(store.get(TAB_STORAGE)); });

  if (accessKey) showApp();
  else showLogin();
})();
