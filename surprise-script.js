/* Surprise Me — roll a real CONTRACT PROVIDER (+ category + type + where to go + a challenge ship), forever.
   Type / System / Alignment are all optional (blank = any). Complete jobs for a logged tally; a rented "ride" sticks a few jobs.
   Data: mission_providers.json + rental_ships.json. */
(() => {
  'use strict';
  const $ = (s, r=document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const rand = a => a[Math.floor(Math.random()*a.length)];
  const money = n => n.toLocaleString('en-US');
  const art = w => /^[aeiou]/i.test(String(w)) ? 'an' : 'a';
  const fmtClock = ms => { let s=Math.floor(ms/1000); const h=Math.floor(s/3600); s%=3600; const m=Math.floor(s/60), ss=s%60;
    return (h?`${h}:${String(m).padStart(2,'0')}`:`${m}`)+`:${String(ss).padStart(2,'0')}`; };
  const fmtTotal = ms => { const min=Math.round(ms/60000); return min<1?'<1m':min<60?`${min}m`:`${Math.floor(min/60)}h ${min%60}m`; };

  const SYSTEMS = ['Stanton', 'Nyx', 'Pyro'];
  const ICON = { 'ship-combat':'⚔', 'ground-combat':'⛨', 'mining':'⛏', 'hauling':'▤', 'salvage':'✂', 'investigation':'⌕' };
  const RIDE_JOBS = 3;
  const PROFIT_NOTE = `<div class="rt-note">Note: you might need to run this contract several times to make a profit if you're renting a ship.</div>`;

  const HUB = {
    'Area 18':     { sys:'Stanton', label:'Area18 · ArcCorp' },
    'Lorville':    { sys:'Stanton', label:'Lorville · Hurston' },
    'New Babbage': { sys:'Stanton', label:'New Babbage · microTech' },
    'Orison':      { sys:'Stanton', label:'Orison · Crusader' },
    'Levski':      { sys:'Nyx',     label:'Levski' },
  };
  const PLANET_HUB = { 'Hurston':'Lorville', 'Crusader':'Orison', 'ArcCorp':'Area 18', 'microTech':'New Babbage' };
  const NEAREST_STANTON = { 'Pyro': ['Area 18','Lorville','Orison','New Babbage'], 'Nyx': ['Orison','New Babbage','Lorville','Area 18'] };

  let PV, SHIPS, lastProv = null, ride = null;
  const selType = new Set();
  const selSys = new Set();      // blank = any system
  let align = null;              // null = any alignment
  let current = null, missionStart = 0, logExpanded = false;
  let stats = { count:0, totalMs:0, byMission:{}, seq:0 };

  // ---- controls ----
  function paintTypes() {
    $('#type-grid').innerHTML = Object.entries(PV.types).map(([id, t]) =>
      `<button class="type-card${selType.has(id)?' on':''}" data-type="${id}">
         <span class="tc-icon">${ICON[id]||'◇'}</span><span class="tc-label">${esc(t.name)}</span>
       </button>`).join('');
  }
  function paintSys() {
    $('#sys-grid').innerHTML = SYSTEMS.map(s =>
      `<button class="seg-btn${selSys.has(s)?' on':''}" data-sys="${s}">${s}</button>`).join('');
  }
  function paintAlign() {
    [...$('#align-row').children].forEach(x => x.classList.toggle('on', x.dataset.align === align));
  }
  function bind() {
    $('#type-grid').addEventListener('click', e => { const b = e.target.closest('[data-type]'); if(!b) return;
      const id = b.dataset.type; selType.has(id) ? selType.delete(id) : selType.add(id); paintTypes(); });
    $('#sys-grid').addEventListener('click', e => { const b = e.target.closest('[data-sys]'); if(!b) return;
      const s = b.dataset.sys; selSys.has(s) ? selSys.delete(s) : selSys.add(s); paintSys(); });   // no minimum — blank = any
    $('#align-row').addEventListener('click', e => { const b = e.target.closest('[data-align]'); if(!b) return;
      align = (align === b.dataset.align) ? null : b.dataset.align; paintAlign(); });               // click active to clear = any
    $('#roll').addEventListener('click', nextMission);
    $('#skip').addEventListener('click', nextMission);
    $('#result').addEventListener('click', e => { if (e.target.closest('#done')) completeMission(); });
    $('#stats').addEventListener('click', e => {
      if (e.target.id === 'stats-reset') resetStats();
      else if (e.target.id === 'log-toggle') { logExpanded = !logExpanded; renderStats(); }
    });
  }

  function pairsFor(p, useTypes) {
    const out = [];
    for (const [type, syss] of Object.entries(p.byType || {})) {
      if (!useTypes.includes(type)) continue;
      for (const s of syss) if (!selSys.size || selSys.has(s)) out.push({ type, sys: s });
    }
    return out;
  }

  // ---- rent resolution ----
  function citiesOf(key) {
    const s = SHIPS.ships[key];
    if (!s || !s.byLocation) return [];
    return Object.entries(s.byLocation).filter(([loc]) => HUB[loc]);
  }
  function pickRent(pool, sys, loc) {
    const homeHub = PLANET_HUB[loc];
    for (const key of pool) {
      const inSys = citiesOf(key).filter(([l]) => HUB[l].sys === sys);
      if (inSys.length) {
        inSys.sort((a,b) => ((b[0]===homeHub)-(a[0]===homeHub)) || a[1]-b[1]);
        const [l, price] = inSys[0];
        return { name: SHIPS.ships[key].name, loc: HUB[l].label, hubKey: l, price, jump: null };
      }
    }
    const order = NEAREST_STANTON[sys] || [];
    for (const key of pool) {
      const cs = citiesOf(key);
      if (!cs.length) continue;
      cs.sort((a,b) => { const ra = order.indexOf(a[0]), rb = order.indexOf(b[0]);
        return (ra<0?99:ra)-(rb<0?99:rb) || a[1]-b[1]; });
      const [l, price] = cs[0];
      return { name: SHIPS.ships[key].name, loc: HUB[l].label, hubKey: l, price, jump: HUB[l].sys };
    }
    return null;
  }
  function nearestPyroStation(loc) {
    const m = PV.pyroMap; if (!m || !m.bodies || !m.bodies[loc]) return loc;
    const b = m.bodies[loc]; let best = loc, bd = Infinity;
    for (const [name, s] of Object.entries(m.stations)) {
      const d = b.r*b.r + s.r*s.r - 2*b.r*s.r*Math.cos((b.a - s.a) * Math.PI/180);
      if (d < bd) { bd = d; best = name; }
    }
    return best;
  }
  function restockStation(loc, sys) {
    if (sys === 'Pyro') return (PV.pyroMap && PV.pyroMap.stations[loc]) ? loc : nearestPyroStation(loc);
    const t = PV.restockStations && PV.restockStations[sys];
    return (t && t[loc]) || loc;
  }
  function rentLine(r) {
    if (!r) return '';
    const tail = r.jump ? ` <span class="dim">— closest shop, a jump into ${esc(r.jump)}</span>` : '';
    return `<div class="rt-sub">Rent one <span class="dim">~${money(r.price)}/day</span> at <b>${esc(r.loc)}</b>${tail}.</div>`;
  }
  function pickChallengeShip(t, sys, loc, excludeKey) {
    const rentable = t.rentPool.filter(k => SHIPS.ships[k] && citiesOf(k).length);
    if (!rentable.length) return null;
    const localHub = PLANET_HUB[loc];
    const atLocal = localHub ? rentable.filter(k => (SHIPS.ships[k].byLocation||{})[localHub] != null) : [];
    const inSys = rentable.filter(k => citiesOf(k).some(([l]) => HUB[l].sys === sys));
    let pool = atLocal.length ? atLocal : (inSys.length ? inSys : rentable);
    if (excludeKey && pool.length > 1) { const p2 = pool.filter(k => k !== excludeKey); if (p2.length) pool = p2; }
    return rand(pool);
  }
  function vehicleLine(t, r, shipKey) {
    if (!t.vehicles || !r) return '';
    const fits = (PV.carrierFits && PV.carrierFits[shipKey]) || [];
    const candidates = t.vehicles.filter(v => fits.includes(v) && SHIPS.ships[v] && (SHIPS.ships[v].byLocation||{})[r.hubKey] != null);
    const choice = rand([null, ...candidates]);
    if (!choice) return '';
    const v = SHIPS.ships[choice];
    return `<div class="rt-sub">Add ${art(v.name)} <b>${esc(v.name)}</b> <span class="dim">(~${money(v.byLocation[r.hubKey])}/day, same hub)</span>.</div>`;
  }
  function newChallengeBlock(key, t, sys, loc) {
    const ship = SHIPS.ships[key];
    const r = pickRent([key], sys, loc);
    return `<div class="rent-tip">
        <div class="rt-line"><span class="rt-i">🎲</span> <b>Optional Challenge:</b> use ${art(ship.name)} <b>${esc(ship.name)}</b> or similar.</div>
        ${rentLine(r)}${vehicleLine(t, r, key)}
        ${PROFIT_NOTE}
      </div>`;
  }
  function reuseBlock() {
    return `<div class="rent-tip">
        <div class="rt-line"><span class="rt-i">🎲</span> <b>Still in your ${esc(ride.name)}</b> <span class="dim">— no need to re-rent.</span></div>
      </div>`;
  }
  function ladderBlock(p, sys, loc) {
    const opts = p.ladder.tiers.filter(x => x.ship && SHIPS.ships[x.ship]);
    if (!opts.length) return '';
    const pick = rand(opts);
    const ship = SHIPS.ships[pick.ship];
    return `<div class="rent-tip">
        <div class="rt-line"><span class="rt-i">🎲</span> <b>Optional Challenge:</b> fly a <b>tier ${pick.t}</b> contract in ${art(ship.name)} <b>${esc(ship.name)}</b>.</div>
        ${rentLine(pickRent([pick.ship], sys, loc))}
        ${PROFIT_NOTE}
      </div>`;
  }

  // ---- roll a mission into #result; returns {type, sys, provider, usesRide} or null ----
  function rollMission() {
    const useTypes = selType.size ? [...selType] : Object.keys(PV.types);
    const provs = Object.values(PV.providers).filter(p => (!align || p.path === align) && pairsFor(p, useTypes).length);

    const res = $('#result'); res.hidden = false;
    if (!provs.length) {
      res.innerHTML = `<div class="mcard empty">No providers match that combo.<br>Loosen a filter — type, system or alignment.</div>`;
      return null;
    }

    let pool = provs;
    if (pool.length > 1 && lastProv) { const nx = pool.filter(p => p.name !== lastProv); if (nx.length) pool = nx; }
    const p = rand(pool);
    lastProv = p.name;

    const { type: tId, sys } = rand(pairsFor(p, useTypes));
    const loc = rand(PV.locations[sys] || [sys]);
    const t = PV.types[tId];
    const legal = p.path !== 'illegal';

    const rs = restockStation(loc, sys);
    const restockTxt = (rs === loc) ? 'restock &amp; rearm here' : `restock &amp; rearm at ${esc(rs)}`;

    let cat = `<b>${esc(p.tab)}</b>`;
    if (p.altTab && (!p.altTabSys || p.altTabSys.includes(sys))) cat += ` or <b>${esc(p.altTab)}</b>`;
    const catClause = p.verify ? '' : ` from the ${cat} category`;

    let action = '', usesRide = false;
    if (p.ladder) {
      action = ladderBlock(p, sys, loc);
    } else if (ride && ride.type === tId && ride.used < RIDE_JOBS) {
      action = reuseBlock(); usesRide = true;
    } else {
      const key = pickChallengeShip(t, sys, loc, ride ? ride.key : null);
      if (key) { ride = { key, name: SHIPS.ships[key].name, type: tId, used: 0 };
        action = newChallengeBlock(key, t, sys, loc); usesRide = true; }
    }

    res.innerHTML = `<article class="mcard" style="--sys:var(--${sys.toLowerCase()});--align:${legal?'var(--legal)':'var(--illegal)'}">
        <div class="mcard-head">
          <div class="mcard-chips">
            <span class="chip sys-${esc(sys)}">${esc(sys)}</span>
            <span class="chip ${t.combat?'combat':'calm'}">${t.combat?'combat':'non-combat'}</span>
            <span class="chip ${legal?'legal':'illegal'}">${legal?'legal':'illegal'}</span>
          </div>
          <span class="mcard-timer">⏱ <b id="timer-val">0:00</b> <span class="dim">on this job</span></span>
        </div>
        <h3>${esc(t.name)}</h3>
        <ol class="msteps">
          <li>Travel to <b>${esc(loc)}</b> in <b>${esc(sys)}</b> System <span class="dim">· (${restockTxt})</span>.</li>
          <li>Open the Contracts Manager and pick up ${art(p.name)} <b>${esc(p.name)}</b> job${catClause}.</li>
        </ol>
        <p class="mnote">If that exact contract isn't listed, take the closest one in the same category — boards rotate.</p>
        ${p.note && (!p.noteSys || p.noteSys.includes(sys)) ? `<p class="mnote">${esc(p.note)}</p>` : ''}
        ${action}
        <button id="done" class="mcard-complete">✓ Mission complete</button>
      </article>`;
    res.querySelector('.mcard').animate?.([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'none'}], {duration:180, easing:'ease'});
    return { type: tId, sys, provider: p.name, usesRide };
  }

  // ---- lifecycle ----
  function nextMission() {
    const m = rollMission();
    if (!m) { current = null; missionStart = 0; $('#roll').hidden = false; $('#skip').hidden = true; return; }
    current = m; missionStart = Date.now(); tick();
    $('#roll').hidden = true; $('#skip').hidden = false;
  }
  function completeMission() {
    if (current && missionStart) {
      const ms = Date.now() - missionStart;
      stats.count++; stats.totalMs += ms;
      const key = current.type + '|' + (current.provider||'') + '|' + current.sys;
      const g = stats.byMission[key] || { type:current.type, prov:current.provider, sys:current.sys, count:0, totalMs:0, seq:0 };
      g.count++; g.totalMs += ms; g.seq = ++stats.seq;
      stats.byMission[key] = g;
      if (current.usesRide && ride) ride.used++;
      saveStats(); renderStats(true);
    }
    nextMission();
  }
  function tick() { const el = $('#timer-val'); if (el) el.textContent = missionStart ? fmtClock(Date.now() - missionStart) : '0:00'; }

  // ---- stats + log ----
  // one row per unique job (type + provider + system) with its count + total time, most-recent first
  function renderStats(flash) {
    const s = $('#stats');
    if (!stats.count) { s.hidden = true; return; }
    s.hidden = false;
    const groups = Object.values(stats.byMission).sort((a,b) => b.seq - a.seq), CAP = 12;
    const shown = logExpanded ? groups : groups.slice(0, CAP);
    const rows = shown.map(g => `<div class="log-row">
        <span class="log-x">${g.count>1?`×${g.count}`:''}</span>
        <span class="log-type">${ICON[g.type]||'◇'} ${esc(PV.types[g.type]?PV.types[g.type].name:g.type)}</span>
        <span class="log-prov">${esc(g.prov||'')}</span>
        <span class="log-sys sys-label sys-${esc(g.sys)}">${esc(g.sys)}</span>
        <span class="log-time">${fmtClock(g.totalMs)}</span>
      </div>`).join('');
    const more = groups.length > CAP
      ? `<button class="log-more" id="log-toggle">${logExpanded ? 'show less' : `+${groups.length-CAP} more`}</button>`
      : '';
    s.innerHTML = `<div class="stats-head"><b${flash?' class="pop"':''}>${stats.count}</b> mission${stats.count>1?'s':''} logged
        <span class="dim">· ${fmtTotal(stats.totalMs)} on the job</span>
        <button id="stats-reset" class="stats-reset" title="clear your tally">reset</button></div>
      ${rows ? `<div class="stats-log">${rows}${more}</div>` : ''}`;
  }
  function saveStats() { try { localStorage.setItem('smr_surprise_stats', JSON.stringify(stats)); } catch(e){} }
  function loadStats() {
    try {
      const j = JSON.parse(localStorage.getItem('smr_surprise_stats'));
      if (j && typeof j.count === 'number') {
        const st = { count:j.count, totalMs:j.totalMs||0, byMission:{}, seq:0 };
        if (j.byMission && typeof j.byMission === 'object') { st.byMission = j.byMission; st.seq = j.seq||0; }
        else if (Array.isArray(j.log)) {                       // migrate the older per-entry log format
          j.log.forEach(e => { const key = e.type+'|'+(e.prov||'')+'|'+e.sys;
            const g = st.byMission[key] || { type:e.type, prov:e.prov, sys:e.sys, count:0, totalMs:0, seq:0 };
            g.count++; g.totalMs += (e.ms||0); g.seq = ++st.seq; st.byMission[key] = g; });
        }
        return st;
      }
    } catch(e){}
    return { count:0, totalMs:0, byMission:{}, seq:0 };
  }
  function resetStats() { stats = { count:0, totalMs:0, byMission:{}, seq:0 }; saveStats(); renderStats(); }

  // ---- boot ----
  (async () => {
    try {
      [PV, SHIPS] = await Promise.all([
        (await fetch('mission_providers.json', {cache:'no-store'})).json(),
        (await fetch('rental_ships.json', {cache:'no-store'})).json(),
      ]);
    } catch (e) { $('#result').hidden=false; $('#result').innerHTML = '<div class="mcard empty">Couldn\'t load data (serve over http).</div>'; return; }
    stats = loadStats(); renderStats();
    paintTypes(); paintSys(); paintAlign(); bind();
    setInterval(tick, 1000);
  })();
})();
