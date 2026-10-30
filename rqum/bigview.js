// Big RQUM window: the same tabs as the small window, in a large window in the middle of the
// screen, easier to read: key figures on top, a sortable table on the left, the chosen row's
// card (with its graph open) on the right. Shared by the extension (panel.js) and the web page
// (app.js), which give it their data through opts.api.
//
// RQUM.bigView.open({
//   version, tabs: [[key, label]...], tab,
//   api: { allPlayers(), searchClan(q), players(ids) -> { id: player }, recent(), alliance(), clans() },
//   profileLink(id) -> <a>, renderOther(key, container): the tabs without a table layout,
//   onTab(key), onShrink(key), onClose()
// })
(() => {
  const { el } = RQUM;
  const TABLE_TABS = new Set(['search', 'recent', 'alliance', 'tgo', 'clans']); // 'search' is the Players tab
  const SEARCH_DEBOUNCE_MS = 300;
  const MAX_ROWS_WITH_STATS = 80; // players whose figures are fetched for the table
  const ROWS_AT_ONCE = 150;       // rows drawn at once, the next ones as you scroll

  let view = null; // the open window: { root, content, status, filter, tab, opts, refilter }

  const statOf = (p, k) => {
    const v = p?.stats?.[k]?.v;
    return typeof v === 'number' ? v : null;
  };
  const time = (iso) => (iso ? new Date(iso).getTime() || 0 : 0);

  // A figure; on hover its exact value and where it comes from ("Spy report · by Jio · 26 Oct, 11:05").
  function numCell(v, origin) {
    if (v == null) return el('span', 'rqum-big__none', '—');
    const span = el('span', 'rqum-big__num', RQUM.formatNumber(v));
    span.title = [RQUM.formatExact(v), origin].filter(Boolean).join('\n');
    return span;
  }
  // A player's stat with its origin.
  const statCell = (player, key) => numCell(statOf(player, key), player?.stats?.[key] ? RQUM.statOrigin(player.stats[key]) : null);
  const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function ageCell(iso, by) {
    if (!iso) return el('span', 'rqum-big__none', '—');
    const span = el('span', `rqum-card__age ${RQUM.ageClass(iso)}`, RQUM.formatAge(iso));
    span.title = [when(iso), by ? `by ${RQUM.cleanName(by)}` : null].filter(Boolean).join(' · ');
    return span;
  }

  function nameCell(id, name, { star = true, eye = false, clan = null, former = null } = {}) {
    const cell = el('span', 'rqum-big__name');
    if (star) cell.appendChild(RQUM.favStar(id, name));
    const tag = RQUM.clanTag(clan);
    if (tag) cell.appendChild(el('span', 'rqum-big__clan', tag));
    cell.appendChild(el('span', 'rqum-big__name-text', RQUM.cleanName(name) || `#${id}`));
    const renamed = RQUM.renamedTag(former);
    if (renamed) cell.appendChild(renamed);
    if (eye) {
      const img = el('img', 'rqum-list__badge');
      img.src = RQUM.assetUrl('icons/header-eye.png');
      img.alt = '';
      img.title = 'Plays with RQUM: their own stats are shared';
      cell.appendChild(img);
    }
    return cell;
  }

  // The 4 combat columns, coloured like the cards.
  const COMBAT_COLS = [
    ['total_offense', 'Off', 'offense'], ['total_defense', 'Def', 'defense'],
    ['spy_offense', 'Spy Off', 'spy-offense'], ['spy_defense', 'Spy Def', 'spy-defense'],
  ].map(([k, label, kind]) => ({
    label, num: true, kind, icon: kind, value: (r) => statOf(r.player, k),
    cell: (r) => {
      const cell = statCell(r.player, k);
      // Recent tab: the figure that changed stands out, with the change under it and the
      // previous value on hover.
      const change = r.change?.changes?.[k];
      if (!change) return cell;
      cell.classList.add('rqum-big__changed');
      const box = el('span', 'rqum-big__change-cell');
      box.appendChild(cell);
      if (typeof change.prev === 'number') {
        const d = change.v - change.prev;
        cell.title += `\nWas ${RQUM.formatExact(change.prev)}`;
        box.appendChild(el('span', `rqum-big__diff ${d >= 0 ? 'is-up' : 'is-down'}`, `${d >= 0 ? '+' : '−'}${RQUM.formatNumber(Math.abs(d))}`));
      } else {
        cell.title += '\nFirst time seen';
        box.appendChild(el('span', 'rqum-big__diff', 'new'));
      }
      return box;
    },
  }));

  // ---- Sortable table -------------------------------------------------------------------
  // cols: [{ label, value(row) -> number | string | null, cell(row) -> node, num, kind }].
  // A click on a header sorts on it (again: the other way); a click on a row picks it.
  // matches(row, words) decides what the filter box keeps (default: the name contains it).
  // expand(row) -> node: shown in a row unfolded right under the clicked one (click again: folds).
  function sortableTable(rows, cols, { sortCol = 0, desc = true, onPick, expand, matches = (r, words) => !words || (r.name || '').toLowerCase().includes(words) }) {
    const wrap = el('div', 'rqum-big__table-wrap');
    const tableEl = el('table', 'rqum-big__table');
    const head = el('tr');
    const body = el('tbody');
    let selected = null;
    let expanded = null;
    const unfolded = new Map(); // row -> its node, kept while sorting / filtering
    cols.forEach((c, i) => {
      const th = el('th', `${c.num ? 'is-num' : ''}${c.kind ? ` rqum-card__row--${c.kind}` : ''}`);
      if (c.value) {
        const b = el('button', 'rqum-big__sort', c.label);
        b.type = 'button';
        // The game's own icon for the 4 combat figures, as on the cards.
        if (c.icon) {
          const icon = el('img', 'rqum-big__th-icon');
          icon.src = RQUM.assetUrl(`icons/stats/${c.icon}.png`);
          icon.alt = '';
          b.prepend(icon);
        }
        b.addEventListener('click', () => {
          if (sortCol === i) desc = !desc;
          else { sortCol = i; desc = c.num !== false; }
          render();
        });
        th.appendChild(b);
      } else th.textContent = c.label;
      head.appendChild(th);
    });
    const thead = el('thead');
    thead.appendChild(head);
    tableEl.append(thead, body);
    wrap.appendChild(tableEl);

    const compare = (a, b) => {
      const col = cols[sortCol];
      const va = col.value(a);
      const vb = col.value(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // unknown last, either way
      if (vb == null) return -1;
      const d = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return desc ? -d : d;
    };
    function render() {
      head.querySelectorAll('th').forEach((th, i) => {
        th.classList.toggle('is-sorted', i === sortCol);
        th.dataset.dir = i === sortCol ? (desc ? '▼' : '▲') : '';
      });
      const words = (view?.filter || '').trim().toLowerCase();
      const shown = rows.filter((r) => matches(r, words)).sort(compare);
      body.replaceChildren();
      // A long list (every player) is drawn by pieces as you scroll: the first rows at once.
      for (const r of shown.slice(0, view?.rowLimit || ROWS_AT_ONCE)) {
        const tr = el('tr', r === selected ? 'is-selected' : '');
        for (const c of cols) {
          const td = el('td', `${c.num ? 'is-num' : ''}${c.kind ? ` rqum-card__row--${c.kind}` : ''}`);
          const content = c.cell(r);
          if (content instanceof Node) td.appendChild(content);
          else td.textContent = content ?? '';
          tr.appendChild(td);
        }
        tr.addEventListener('click', () => {
          selected = r;
          if (expand) {
            expanded = expanded === r ? null : r;
            render();
          } else body.querySelectorAll('tr').forEach((x) => x.classList.toggle('is-selected', x === tr));
          onPick(r);
        });
        body.appendChild(tr);
        if (expand && r === expanded) {
          if (!unfolded.has(r)) unfolded.set(r, expand(r));
          const more = el('tr', 'rqum-big__unfolded');
          const td = el('td');
          td.colSpan = cols.length;
          td.appendChild(unfolded.get(r));
          more.appendChild(td);
          body.appendChild(more);
          tr.classList.add('is-open');
        }
      }
      if (!shown.length || shown.length > (view?.rowLimit || ROWS_AT_ONCE)) {
        const tr = el('tr');
        const td = el('td', 'rqum-muted', !shown.length
          ? (rows.length ? 'Nothing matches the filter.' : 'Nothing yet.')
          : `${shown.length - (view?.rowLimit || ROWS_AT_ONCE)} more: scroll down, or narrow the list with the box above.`);
        td.colSpan = cols.length;
        tr.appendChild(td);
        body.appendChild(tr);
      }
      return shown;
    }
    // Near the bottom of the list: the next rows.
    wrap.addEventListener('scroll', () => {
      if (!view || wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 200) return;
      const limit = view.rowLimit || ROWS_AT_ONCE;
      if (rows.length <= limit) return;
      view.rowLimit = limit + ROWS_AT_ONCE;
      render();
    });
    const shown = render();
    if (view) view.refilter = render;
    return { wrap, first: shown[0], pick: (r) => { selected = r; render(); onPick(r); } };
  }

  // ---- Layout pieces ----------------------------------------------------------------------
  function summary(cards) {
    const box = el('div', 'rqum-big__cards');
    for (const [label, value, title] of cards) {
      const card = el('div', 'rqum-big__stat');
      card.append(el('div', 'rqum-big__stat-label', label), el('div', 'rqum-big__stat-value', value));
      if (title) card.title = title;
      box.appendChild(card);
    }
    return box;
  }

  function split() {
    const box = el('div', 'rqum-big__split');
    const left = el('div', 'rqum-big__left');
    const side = el('div', 'rqum-big__side');
    side.appendChild(el('p', 'rqum-muted', 'Pick a row to see its card and graph here.'));
    box.append(left, side);
    return { box, left, side };
  }

  // A card with its main graph opened at once (offense, else the first figure with a graph).
  function openGraph(card, preferred) {
    const line = card.querySelector(`.rqum-card__row--${preferred}.rqum-card__row--graph`) || card.querySelector('.rqum-card__row--graph');
    line?.click();
  }

  async function showPlayerSide(side, row, only) {
    let player = row.player;
    if (!player?.stats) {
      side.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
      try { player = (await view.opts.api.players([String(row.id)]))[row.id]; } catch (err) { return side.replaceChildren(el('p', 'rqum-muted', err.message)); }
    }
    if (!player) return side.replaceChildren(el('p', 'rqum-muted', `No intel on ${row.name || `#${row.id}`} yet.`));
    const card = RQUM.intelCard(player, only ? { only } : {});
    side.replaceChildren(card, view.opts.profileLink(row.id));
    openGraph(card, 'offense');
    if (matchMedia('(max-width: 760px)').matches) side.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Players' full figures for the table, by batches (the database takes a list of ids).
  async function withPlayers(rows) {
    const ids = [...new Set(rows.map((r) => String(r.id)))].slice(0, MAX_ROWS_WITH_STATS);
    const found = ids.length ? await view.opts.api.players(ids) : {};
    for (const r of rows) r.player = found[r.id] || r.player || null;
    return rows;
  }

  // ---- Tabs ---------------------------------------------------------------------------------
  const playerCols = (extra = []) => [
    { label: 'Player', num: false, value: (r) => r.name.toLowerCase(), cell: (r) => nameCell(r.id, r.name, { eye: r.player?.uses_rqum, clan: r.player?.stats?.clan?.v ?? r.clan, former: r.player?.stats?.former_name }) },
    ...extra,
    // The game's Overall rank, lowest first when sorted (sorting "high to low" puts #1 on top).
    { label: 'Rank', num: true, value: (r) => { const v = statOf(r.player, 'rank_overall'); return v == null ? null : -v; }, cell: (r) => {
      const v = statOf(r.player, 'rank_overall');
      if (v == null) return el('span', 'rqum-big__none', '—');
      const span = el('span', '', `#${v}`);
      span.title = RQUM.statOrigin(r.player.stats.rank_overall);
      return span;
    } },
    { label: 'Lv', num: true, value: (r) => statOf(r.player, 'level'), cell: (r) => statCell(r.player, 'level') },
    ...COMBAT_COLS,
  ];
  const updatedCol = { label: 'Updated', num: true, value: (r) => time(r.player?.updated_at) || null, cell: (r) => ageCell(r.player?.updated_at, r.player?.updated_by) };
  const gptCol = { label: 'Gold/turn', num: true, value: (r) => statOf(r.player, 'gold_per_turn'), cell: (r) => statCell(r.player, 'gold_per_turn') };
  // Players and RQUM tabs: the same columns.
  const memberCols = () => [...playerCols(), gptCol, updatedCol];

  // Players tab: every player of the database (loaded once per opening), filtered here by
  // name, id or clan tag as you type; a clan's full name ("golden") is looked up in the
  // database. "★ only" keeps the favourites.
  async function renderPlayers(content) {
    content.replaceChildren(el('p', 'rqum-muted', 'Loading every player…'));
    let players;
    try { view.allPlayers ??= await view.opts.api.allPlayers(); players = view.allPlayers; } catch (err) {
      return content.replaceChildren(el('p', 'rqum-muted', err.message));
    }
    if (view?.tab !== 'search') return;
    view.favs = await RQUM.favorites.all();
    const rows = (players || []).map((p) => ({ id: p.player_id, name: RQUM.cleanName(p.player_name) || '', player: p }));
    // Favourites not in the database (yet) still show.
    for (const [id, name] of Object.entries(view.favs)) if (!rows.some((r) => String(r.id) === id)) rows.push({ id, name, player: null });
    view.clanIds = view.clanIds || new Set();
    const bare = (s) => String(s ?? '').toLowerCase().replace(/[[\]\s]/g, '');
    const matches = (r, words) => {
      if (view.favOnly && view.favs[String(r.id)] === undefined) return false;
      if (!words) return true;
      return r.name.toLowerCase().includes(words) || String(r.id) === words
        || (bare(words) && bare(r.player?.stats?.clan?.v) === bare(words)) || view.clanIds.has(String(r.id));
    };
    const { box, left, side } = split();
    const t = sortableTable(rows, memberCols(), { sortCol: 7, desc: true, matches, onPick: (r) => showPlayerSide(side, r) });
    left.appendChild(t.wrap);
    const favButton = el('button', `rqum-big__btn${view.favOnly ? ' is-on' : ''}`, '★ Favourites only');
    favButton.type = 'button';
    favButton.addEventListener('click', async () => {
      view.favOnly = !view.favOnly;
      view.favs = await RQUM.favorites.all(); // stars changed since
      favButton.classList.toggle('is-on', view.favOnly);
      view.refilter?.();
    });
    const bar = el('div', 'rqum-big__toolbar');
    bar.append(favButton, el('span', 'rqum-muted', 'Type a player name or id, or a clan tag or name, in the box above. Tap ☆ to add a favourite.'));
    content.replaceChildren(summary([
      ['Players in the database', RQUM.formatExact(players.length)],
      ['Favourites', String(Object.keys(view.favs).length)],
      ['Updated in the last 24 h', String(rows.filter((r) => Date.now() - time(r.player?.updated_at) < 86400000).length)],
    ]), bar, box);
    if (t.first) t.pick(t.first);
  }

  // Players tab, as you type: a clan's full name is matched in the database.
  let clanTicket = 0;
  async function lookUpClan(q) {
    const ticket = ++clanTicket;
    let ids = new Set();
    if (q.trim().length >= 2) {
      try { ids = new Set((await view.opts.api.searchClan(q.trim())).map((c) => String(c.player_id))); } catch (_) { /* name / tag matches only */ }
    }
    if (ticket !== clanTicket || !view || view.tab !== 'search') return;
    view.clanIds = ids;
    view.refilter?.();
  }

  async function renderRecent(content) {
    content.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
    let rows;
    try {
      rows = (await view.opts.api.recent()).map((c) => ({ id: c.player_id, name: RQUM.cleanName(c.player_name) || '', clan: c.clan, change: c }));
      await withPlayers(rows);
    } catch (err) { return content.replaceChildren(el('p', 'rqum-muted', err.message)); }
    const { box, left, side } = split();
    // The figures that changed show their new value and the change, in their own column.
    const t = sortableTable(rows, playerCols([
      { label: 'When', num: true, value: (r) => time(r.change.changed_at), cell: (r) => ageCell(r.change.changed_at, r.change.changed_by) },
      { label: 'By', num: false, value: (r) => RQUM.cleanName(r.change.changed_by) || '', cell: (r) => RQUM.cleanName(r.change.changed_by) || '' },
    ]), { sortCol: 1, desc: true, onPick: (r) => showPlayerSide(side, r) });
    left.appendChild(t.wrap);
    const last = rows.reduce((m, r) => Math.max(m, time(r.change.changed_at)), 0);
    content.replaceChildren(summary([
      ['Players changed', String(rows.length)],
      ['Latest change', last ? `${RQUM.formatAge(new Date(last).toISOString())} ago` : '—'],
    ]), el('p', 'rqum-muted', 'Players whose Offense, Defense, Spy Offense or Spy Defense changed, in the last 60 days.'), box);
    if (t.first) t.pick(t.first);
  }

  // RQUM, or one clan's players (TGO tab): the same table and cards.
  async function renderAlliance(content, clan = null) {
    content.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
    let players;
    try { players = await (clan ? view.opts.api.clan(clan) : view.opts.api.alliance()); } catch (err) { return content.replaceChildren(el('p', 'rqum-muted', err.message)); }
    const rows = (players || []).map((p) => ({ id: p.player_id, name: RQUM.cleanName(p.player_name) || '', player: p }));
    const sum = (k) => rows.reduce((s, r) => s + (statOf(r.player, k) || 0), 0);
    const levels = rows.map((r) => statOf(r.player, 'level')).filter((v) => v != null);
    const { box, left, side } = split();
    const t = sortableTable(rows, memberCols(), { sortCol: 1, desc: true, onPick: (r) => showPlayerSide(side, r, RQUM.ALLIANCE_STATS) });
    left.appendChild(t.wrap);
    content.replaceChildren(summary([
      ['Members', String(rows.length)],
      // Only RQUM members use the plugin: not shown for another clan.
      ...(clan ? [] : [['Play with RQUM plugin', String(rows.filter((r) => r.player.uses_rqum).length)]]),
      ['Total offense', RQUM.formatNumber(sum('total_offense')), RQUM.formatExact(sum('total_offense'))],
      ['Average level', levels.length ? String(Math.round(levels.reduce((a, b) => a + b, 0) / levels.length)) : '—'],
    ]), box);
    if (t.first) t.pick(t.first);
  }

  async function renderClans(content) {
    content.replaceChildren(el('p', 'rqum-muted', 'Loading…'));
    let clans;
    try { clans = await view.opts.api.clans(); } catch (err) { return content.replaceChildren(el('p', 'rqum-muted', err.message)); }
    const rows = (clans || []).map((c) => ({ id: c.clan_id, name: `${c.tag || ''} ${c.name || ''}`.trim(), clan: c }));
    const v = (r, k) => {
      const s = r.clan.stats?.[k];
      return s && Number.isFinite(Number(s.v)) ? Number(s.v) : null;
    };
    // The combat figure that moved the most over 24 h.
    const biggest = (r) => ['offense', 'defense', 'spy_offense', 'spy_defense']
      .map((k) => RQUM.clanDayChange(r.clan, k)).filter((p) => p !== null)
      .reduce((m, p) => (m === null || Math.abs(p) > Math.abs(m) ? p : m), null);
    // On hover: the exact figure, then "Clan Rankings · by Jio · 26 Oct, 11:00".
    const origin = (s) => (s?.at ? ['Clan Rankings', s.by ? `by ${RQUM.cleanName(s.by)}` : null, when(s.at)].filter(Boolean).join(' · ') : 'Clan Rankings');
    const col = (label, k, kind) => ({ label, num: true, kind, value: (r) => v(r, k), cell: (r) => numCell(v(r, k), origin(r.clan.stats?.[k])) });
    const { box, left, side } = split();
    const t = sortableTable(rows, [
      { label: 'Clan', num: false, value: (r) => r.name.toLowerCase(), cell: (r) => el('span', 'rqum-big__name-text', r.name || `#${r.id}`) },
      { label: 'Members', num: true, value: (r) => r.clan.members ?? null, cell: (r) => numCell(r.clan.members ?? null) },
      col('Overall', 'overall'), col('Off', 'offense', 'offense'), col('Def', 'defense', 'defense'),
      col('Spy Off', 'spy_offense', 'spy-offense'), col('Spy Def', 'spy_defense', 'spy-defense'),
      { label: '24 h', num: true, value: (r) => { const p = biggest(r); return p === null ? null : Math.abs(p); }, cell: (r) => RQUM.changeSpan(biggest(r)) },
    ], {
      sortCol: 2,
      desc: true,
      // The clan's members unfold right under its row; its figures and graph on the right.
      expand: (r) => RQUM.clanMembers(r.clan.tag),
      onPick: (r) => {
        const card = RQUM.clanCard(r.clan);
        card.prepend(el('div', 'rqum-card__title', r.name || `#${r.id}`));
        side.replaceChildren(card);
        openGraph(card, 'offense');
      },
    });
    left.appendChild(t.wrap);
    const spikes = rows.filter((r) => { const p = biggest(r); return p !== null && Math.abs(p) >= 10; }).length;
    content.replaceChildren(summary([
      ['Clans', String(rows.length)],
      ['Players in clans', RQUM.formatNumber(rows.reduce((s, r) => s + (r.clan.members || 0), 0))],
      ['Big moves (24 h)', String(spikes), 'Clans whose offense, defense or spy figure changed by 10 % or more in 24 h'],
    ]), el('p', 'rqum-muted', 'From the game\'s Clan Rankings, read every hour. 24 h = the biggest change of the four combat figures.'), box);
    if (t.first) t.pick(t.first);
  }

  const RENDERERS = { search: renderPlayers, recent: renderRecent, alliance: renderAlliance, tgo: (content) => renderAlliance(content, 'TGO'), clans: renderClans };

  // ---- Window -------------------------------------------------------------------------------
  function showTab(key) {
    if (!view) return;
    // Another tab: the filter / search box starts empty (Refresh keeps it).
    if (view.tab !== key) { view.filter = ''; view.filterInput.value = ''; view.clanIds = new Set(); }
    view.tab = key;
    view.refilter = null;
    view.rowLimit = 0;
    view.opts.onTab?.(key);
    view.root.querySelectorAll('.rqum-big__tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === key));
    const search = key === 'search';
    view.filterInput.hidden = !TABLE_TABS.has(key);
    view.filterInput.placeholder = search ? 'Player name or id, clan tag or name' : 'Filter by name';
    view.content.classList.toggle('is-wide', !TABLE_TABS.has(key));
    view.status.textContent = '';
    if (RENDERERS[key]) RENDERERS[key](view.content);
    else {
      view.content.replaceChildren();
      view.opts.renderOther(key, view.content);
    }
  }

  function close(shrink = false) {
    if (!view) return;
    const { root, opts, tab, onKey, inline } = view;
    view = null;
    root.remove();
    if (inline) return; // a view placed in a page (mount) just goes
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.classList.remove('rqum-big-open');
    if (shrink) opts.onShrink?.(tab);
    else opts.onClose?.();
  }

  // The filter / search box: the Players tab also looks a clan's full name up.
  function wireFilter(filterInput) {
    let timer = null;
    filterInput.addEventListener('input', () => {
      if (!view) return;
      view.filter = filterInput.value;
      view.rowLimit = 0;
      view.refilter?.();
      if (view.tab === 'search') {
        clearTimeout(timer);
        timer = setTimeout(() => lookUpClan(filterInput.value), SEARCH_DEBOUNCE_MS);
      }
    });
  }

  // The big layout placed in a page instead of a window (the web page on a computer): the
  // same tabs, cards, tables and cards on the side. Goes when another view opens or with close().
  function mount(container, opts, tab = 'search') {
    close();
    const root = el('div', 'rqum-big rqum-big--inline');
    const box = el('div', 'rqum-big__box');
    const tabs = el('div', 'rqum-big__tabs');
    for (const [key, label] of opts.tabs || []) {
      const b = el('button', 'rqum-big__tab', label);
      b.type = 'button';
      b.dataset.tab = key;
      b.addEventListener('click', () => { if (view?.root === root) showTab(key); });
      tabs.appendChild(b);
    }
    const filterInput = el('input', 'rqum-big__filter');
    filterInput.type = 'search';
    filterInput.autocomplete = 'off';
    const refresh = el('button', 'rqum-big__btn', '⟳ Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', () => { if (view?.root === root) { view.allPlayers = null; showTab(view.tab); } });
    tabs.append(filterInput, refresh);
    const content = el('div', 'rqum-big__content');
    const status = el('div', 'rqum-big__status');
    box.append(tabs, content, status);
    root.appendChild(box);
    container.replaceChildren(root);
    view = { root, content, status, filter: '', filterInput, tab: null, opts, inline: true, refilter: null };
    wireFilter(filterInput);
    showTab(tab);
  }

  function open(opts) {
    close();
    const root = el('div', 'rqum-big');
    const box = el('div', 'rqum-big__box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'RQUM Intel');

    const bar = el('div', 'rqum-big__bar');
    const title = el('span', 'rqum-big__title', 'RQUM Intel');
    if (opts.version) title.appendChild(el('span', 'rqum-panel__version', `v${opts.version}`));
    const button = (text, label, onClick, cls = '') => {
      const b = el('button', `rqum-big__btn ${cls}`, text);
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', onClick);
      return b;
    };
    bar.append(title, ...(opts.barExtras || []), // the extension's 🏰 Fort alert
      button('⟳ Refresh', 'Refresh', () => { view.allPlayers = null; showTab(view.tab); }),
      button('⤡', 'Back to the small window', () => close(true)),
      button('×', 'Close', () => close(), 'rqum-big__btn--close'));

    const tabs = el('div', 'rqum-big__tabs');
    for (const [key, label] of opts.tabs) {
      const b = el('button', 'rqum-big__tab', label);
      b.type = 'button';
      b.dataset.tab = key;
      b.addEventListener('click', () => showTab(key));
      tabs.appendChild(b);
    }
    const filterInput = el('input', 'rqum-big__filter');
    filterInput.type = 'search';
    filterInput.autocomplete = 'off';
    tabs.appendChild(filterInput);

    const content = el('div', 'rqum-big__content');
    const status = el('div', 'rqum-big__status');
    box.append(bar, tabs, content, status);
    root.appendChild(box);
    // A click on the dark background closes; Escape too.
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);

    view = { root, content, status, filter: '', filterInput, tab: null, opts, onKey, refilter: null };
    wireFilter(filterInput);
    document.body.appendChild(root);
    document.documentElement.classList.add('rqum-big-open');
    const first = opts.tabs.some(([k]) => k === opts.tab) ? opts.tab : opts.tabs[0][0];
    showTab(first);
    if (first === 'search' && matchMedia('(hover: hover)').matches) filterInput.focus();
  }

  RQUM.bigView = { open, mount, close, isOpen: () => !!view && !view.inline, setStatus: (text) => { if (view) view.status.textContent = text; } };
})();
