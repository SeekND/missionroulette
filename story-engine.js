/* Mission Roulette — Story Mode beat engine
   Reads story_ranks.json + mission_providers.json + rental_ships.json + hero_adventures.json + purchase_ships.json
   Runs a solo roguelite session; state persists in localStorage. */
(() => {
  'use strict';

  const FILES = { ranks:'story_ranks.json', providers:'mission_providers.json', ships:'rental_ships.json', heroes:'hero_adventures.json', purchases:'purchase_ships.json' };
  const SHOP = { A18:'Area18 · ArcCorp', LOR:'Lorville · Hurston', ORI:'Orison · Crusader', LEV:'Levski · Nyx', RUIN:'Ruin Station · Pyro' };
  // open-ended graduation: a randomized appropriate ship to buy (all confirmed in purchase_ships.json)
  const GRADUATE = {
    bounty:   ['Redeemer', 'Vanguard Warden', 'Scorpius', 'Sabre', 'Hurricane', 'Ares Ion'],
    miner:    ['MOLE', 'Prospector'],
    hauler:   ['Caterpillar', 'Constellation Taurus', 'Freelancer MAX', 'Starlancer MAX', 'Hull C'],
    salvager: ['MOTH', 'Vulture', 'Reclaimer'],
    explorer: ['400i', 'Corsair', 'Constellation Aquila', '600i Explorer'],
    merc:     ['Starlancer TAC', 'Redeemer', 'Cutlass Steel', 'Vanguard Hoplite'],
  };
  // a fresh start (≠ home) is a city where a STARTER rents. At the 3 Stanton cities you can grab any starter; at Levski only the Cutter rents.
  const STARTER_AT = {
    'Area18 · ArcCorp': ['Aurora ES', 'Mustang Alpha', 'Cutter'],
    'Lorville · Hurston': ['Aurora ES', 'Mustang Alpha', 'Cutter'],
    'Orison · Crusader': ['Aurora ES', 'Mustang Alpha', 'Cutter'],
    'Levski · Nyx': ['Cutter'],
  };
  const STARTER_CITIES = Object.keys(STARTER_AT);
  // calling-appropriate armour, told at R1 (undersuit + helmet is the R0 starting kit)
  const ARMOUR = { bounty:'a flight suit (like the Tailwind) &amp; helmet', merc:'medium or heavy armour', miner:'heavy industrial armour', salvager:'heavy industrial armour', hauler:'heavy industrial armour', explorer:'light armour' };
  const LS_KEY = 'smr_run_v2';
  const TRACKS = ['bounty','miner','hauler','salvager','explorer','merc'];
  const ASP_TYPE = { bounty:'ship-combat', merc:'ground-combat', miner:'mining', hauler:'hauling', salvager:'salvage', explorer:'investigation' };
  // SOLO finale per calling — SOLOABLE heroes only (TSG & Valakkar need a crew, so they're out). null = graduate by buying your finisher.
  const FINALE_HERO = { bounty:'hero-vanduul-tech-smugglers', miner:'hero-rockcracker', explorer:'hero-hyperion', merc:'hero-siege-of-orison', hauler:null, salvager:null };
  // Gilly combat sims are a tier ladder (author 1-8). Bounty ranks author the tier (R1=2/R2=3/R3=6); any other calling flying a non-fighter takes the entry tier.
  const gillyTierFor = () => (rankInfo(run.cfg.primary, run.rank) || {}).gilly || 1;
  // BHG bounty risk tier: bounty ranks author it (R1 VLRT / R2 MRT / R3 HRT); any other calling dabbling in bounties sticks to the entry tier (their ship isn't a fighter).
  const bountyTierFor = () => (rankInfo(run.cfg.primary, run.rank) || {}).bountyTier || 'VLRT';
  // ship-tier difficulty: the contract must match the rank's SHIP (NOT "highest pay") and be REP-AWARE — take the tier you've unlocked; if the target is locked, grind lower tiers to unlock it. Ship-capped by design (each rank = a fixed ship).
  function difficultyNote(b) {
    const ship = run.ship, ri = rankInfo(run.cfg.primary, run.rank) || {};
    if (b.typeName === 'Ship Combat') {
      if (b.provider === 'Gilly Flight School')
        return `Take Gilly Flight School's <b>Tier ${gillyTierFor()}</b> contract — it's matched to your <b>${esc(ship)}</b>. Locked? Clear the lower tiers to unlock it.`;
      if (b.provider === 'Bounty Hunters Guild') {
        const tier = bountyTierFor();
        return tier === 'VLRT'
          ? `Stick to <b>VLRT</b> bounties — the entry risk tier; rep up before you chase tougher marks.`
          : `Aim for a <b>${esc(tier)}</b> bounty — if that risk tier isn't unlocked yet, run lower-tier bounties to rep up to it.`;
      }
      return `Pick a contract your <b>${esc(ship)}</b> can actually handle.`;
    }
    if (b.typeName === 'Hauling') {
      if (run.rank === 0) return `Make sure you have a <b>multi-tool</b> with a tractor-beam attachment to move the cargo.`;
      if (ri.haulScale) return `Aim for a <b>${esc(ri.haulScale)}</b> haul — if it's locked, run smaller-scale cargo to unlock it.`;
    }
    return '';   // ground combat needs no note — the player brings a gun, and the ship is irrelevant on foot
  }
  let ASP_LABEL = {};    // populated from story_ranks.json track names after load (single source of truth)
  const ASP_ICON = { bounty:'⚔', miner:'⛏', hauler:'▤', salvager:'✂', explorer:'⌕', merc:'⛨' };
  const MOD_LABEL = { pacifist:'Pacifist', 'off-grid':'Off-Grid', beggar:'Broke' };   // internal key 'beggar' kept; shown as 'Broke' ('beggar' wrongly implied begging for money)
  const modLabels = mods => (mods || []).map(m => MOD_LABEL[m] || m);
  const THRESHOLDS = { 0:3, 1:8, 2:8, 3:10, 4:1 };   // missions to clear each rank
  const RENT_BEATS = 8;
  const START_MONEY = 10000;

  let D = {};       // loaded data
  let run = null;   // active run state
  let aspSel = [];  // chosen aspirations in order — [0] = main, the rest secondary (max 3)
  let home = null;  // the player's home city (where their kit lives) — we start them elsewhere

  // ---------- utils ----------
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const rand = a => a[Math.floor(Math.random()*a.length)];
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const amp = s => String(s ?? '').replace(/\s*\+\s*/g, ' & ');   // "771,000 aUEC + blueprint" -> "… & blueprint" (reads better than +)
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const save = () => localStorage.setItem(LS_KEY, JSON.stringify(run));
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; } };

  const track    = a => D.ranks.tracks[a];
  const rankInfo = (a,r) => track(a).ranks.find(x => x.r === r);
  const shipCheapest = name => {
    const s = Object.values(D.ships.ships).find(s => s.name === name);
    if (!s || !s.byLocation) return null;
    const v = Object.values(s.byLocation); return v.length ? Math.min(...v) : null;
  };
  // Grim Hex has NO rental terminal → outlaws rent at the nearest lawful hub (Orison · Crusader; all starters rent there) then fly in
  const OUTLAW_RENT_HUB = 'Orison · Crusader';
  const CITY_KEY = { 'Area18 · ArcCorp':'Area 18', 'Lorville · Hurston':'Lorville', 'Orison · Crusader':'Orison', 'New Babbage · microTech':'New Babbage', 'Levski · Nyx':'Levski' };
  const shipRec = name => { const nm = s => String(s).toLowerCase().replace(/mk\s*i+/g,'').replace(/\s+/g,' ').trim(); const n = nm(name); return Object.values(D.ships.ships).find(x => nm(x.name) === n) || null; };
  const shipPriceAt = (name, cityLabel) => { const s = shipRec(name); const k = CITY_KEY[cityLabel]; return (s && s.byLocation && k && s.byLocation[k] != null) ? s.byLocation[k] : null; };
  const money = n => n.toLocaleString('en-US');
  const toolFor = m => {
    if (m.aspirations.includes('miner'))   return 'Strata — where & how to mine it';
    if (m.aspirations.includes('salvager'))return null;
    if (m.combat)                          return 'Hardpoint — loadout for your rental';
    return null;
  };

  // ---------- views ----------
  function show(id) { $$('.view').forEach(v => v.classList.toggle('active', v.id === id)); window.scrollTo(0,0); }

  // ---------- setup ----------
  function fillSetup() {
    // aspiration cards — tap main (first), then up to 2 more to blend in
    $('#asp-grid').innerHTML = TRACKS.map(a =>
      `<button class="asp-card" data-asp="${a}">
         <span class="asp-badge"></span>
         <span class="asp-icon">${ASP_ICON[a]||'◇'}</span>
         <span class="asp-name">${esc(ASP_LABEL[a]||a)}</span>
       </button>`).join('');
    $('#asp-grid').onclick = e => { const b = e.target.closest('[data-asp]'); if(!b) return;
      const a = b.dataset.asp, i = aspSel.indexOf(a);
      if (i >= 0) aspSel.splice(i,1); else if (aspSel.length < 3) aspSel.push(a);
      paintAsp(); };
    // path — single-select segment
    $('#path-row').onclick = e => { const b = e.target.closest('[data-path]'); if(!b) return;
      $$('#path-row .seg-opt').forEach(x => x.classList.toggle('on', x===b)); };
    // home — single-select (start rolls a DIFFERENT city so you don't have your stash)
    $('#home-row').onclick = e => { const b = e.target.closest('[data-home]'); if(!b) return;
      home = b.dataset.home; $$('#home-row .seg-btn').forEach(x => x.classList.toggle('on', x===b));
      const h = $('#home-hint'); if (h) h.classList.remove('warn'); };
    // modifiers — multi-select toggle cards
    $('#mods-row').onclick = e => { const b = e.target.closest('[data-mod]'); if(!b || b.classList.contains('disabled')) return; b.classList.toggle('on'); };

    $('#btn-start').onclick = beginSetup;
    $('#btn-begin').onclick = () => { run.started = true; save(); enterRun(); };
    $$('[data-target]').forEach(b => b.onclick = () => show(b.dataset.target));
    $('#btn-done').onclick   = onDone;
    $('#btn-died').onclick   = onDied;
    $('#btn-copy').onclick   = copyLog;
    $('#btn-reroll-run').onclick = () => { localStorage.removeItem(LS_KEY); run=null; aspSel=[]; home=null; paintAsp(); $$('#home-row .seg-btn').forEach(x=>x.classList.remove('on')); show('view-setup'); refreshResume(); };
    paintAsp();

    const saved = loadSaved();
    if (saved) { $('#resume-line').hidden = false; $('#btn-resume').onclick = () => { run = saved; run.started ? enterRun() : briefing(); }; }
  }
  function paintAsp() {
    $$('#asp-grid .asp-card').forEach(c => {
      const i = aspSel.indexOf(c.dataset.asp);
      c.classList.toggle('on', i >= 0);
      c.classList.toggle('main', i === 0);
      c.querySelector('.asp-badge').textContent = i === 0 ? 'Main' : i > 0 ? '2nd' : '';
    });
    const h = $('#asp-hint');
    if (h) { h.textContent = aspSel.length ? `${ASP_LABEL[aspSel[0]]} chosen` : 'tap your main calling, then up to 2 more'; h.classList.remove('warn'); }
    updateMods();
  }
  // Pacifist can't pair with a combat main (Fighter Pilot / Mercenary) — the calling AND its finale are combat, which would dead-end
  const COMBAT_MAIN = new Set(['bounty','merc']);
  function updateMods() {
    const pac = $('#mods-row [data-mod="pacifist"]'); if (!pac) return;
    const combatMain = COMBAT_MAIN.has(aspSel[0]);
    pac.classList.toggle('disabled', combatMain);
    if (combatMain) pac.classList.remove('on');
    pac.title = combatMain ? "Pacifist doesn't fit a combat calling — choose a peaceful main" : '';
  }
  function refreshResume(){ const s=loadSaved(); $('#resume-line').hidden = !s; }

  function beginSetup() {
    if (!aspSel.length) { const h=$('#asp-hint'); if(h){ h.textContent='pick a main calling first'; h.classList.add('warn'); } return; }
    if (!home) { const h=$('#home-hint'); if(h){ h.textContent='pick your home city first'; h.classList.add('warn'); } return; }
    const primary = aspSel[0];
    const secondary = [...new Set(aspSel.slice(1).filter(v => v !== primary))];
    const path = ($('#path-row .seg-opt.on') || {}).dataset?.path || 'lawful';
    const modifiers = $$('#mods-row .mod-card.on').map(b => b.dataset.mod);
    newRun({ primary, secondary, path, modifiers, home });
    briefing();
  }

  function startLocation(cfg) {
    const s = D.ranks.start, beg = cfg.modifiers.includes('beggar');
    if (beg) return rand(cfg.path === 'outlaw' ? s.beggarOutlaw : s.beggarLegal);
    if (cfg.path === 'outlaw') return 'Grim Hex';   // outlaws spawn at Grim Hex (never a home stash)
    const opts = STARTER_CITIES.filter(c => c !== cfg.home);   // start where a starter rents, but NOT your home (your kit lives there)
    return rand(opts.length ? opts : STARTER_CITIES);
  }
  const MEDBED_SHIPS = ['pisces rescue','cutlass red','apollo triage','apollo medivac','ursa medivac','medivac','triage'];
  const shipHasMedbed = name => { const n = String(name||'').toLowerCase(); return MEDBED_SHIPS.some(m => n.includes(m)); };
  const rankShip = (a,r) => { const l = ((rankInfo(a,r)||{}).ship||[]).filter(s => !String(s).startsWith('+')); return l.length ? rand(l) : null; };
  // slot-assembled character hook: "{Origin}, you {identity} — {motivation}{sideline}. {CityClause}, {closer}."
  function makeBackstory(cfg, startLoc) {
    const bs = D.ranks.backstory; if (!bs) return '';
    const origin   = rand(bs.origin || ['a drifter looking for a break']);
    const identity = rand((bs.identity && bs.identity[cfg.primary]) || ['scrape a living out here']);
    const motive   = rand(bs.motivation || ['just to keep the lights on']);
    const sides    = (cfg.secondary || []).map(a => (bs.side || {})[a]).filter(Boolean).slice(0, 2);
    const sideline = sides.length ? `, ${sides.length > 1 ? 'with sidelines ' + sides.join(' and ') : 'with a sideline ' + sides[0]}` : '';
    const loc      = String(startLoc || '').split(' · ')[0].replace(/\s*\([^)]*\)/g, '').trim() || 'the black';
    const cityClause = rand(bs.city || ['getting your start in {loc}']).replace('{loc}', loc);
    const beggar = (cfg.modifiers || []).includes('beggar');
    const key = (cfg.path === 'outlaw' ? 'outlaw' : 'lawful') + (beggar ? '-beggar' : '');
    const closer = rand((bs.closer && (bs.closer[key] || bs.closer.lawful)) || ['out here to make it']);
    return `${cap(origin)}, you ${identity} — ${motive}${sideline}. ${cap(cityClause)}, ${closer}.`;
  }

  function newRun(cfg) {
    const beg = cfg.modifiers.includes('beggar');
    const startLoc = startLocation(cfg);
    const ship = rand(STARTER_AT[startLoc] || ['Aurora ES', 'Mustang Alpha', 'Cutter']);   // at Levski that's the Cutter; elsewhere any starter
    run = {
      cfg, rank:0, counters:{}, ship,
      wallet: beg ? 0 : START_MONEY,
      log:[], currentBeat:null, alive:true, victory:false, started:false,
      startLoc, backstory: makeBackstory(cfg, startLoc), tool: (D.ranks.startTool||{})[cfg.primary] || { name:'a pistol' },
    };
    save();
  }

  // ---------- briefing ----------
  function briefing() {
    const c = run.cfg;
    const modTxt = c.modifiers.length ? ' · ' + modLabels(c.modifiers).join(' · ') : '';
    const medbed = shipHasMedbed(run.ship);
    const tool = run.tool || { name:'the right tool for your calling' };
    const outlaw = c.path === 'outlaw';
    const beggar = c.modifiers.includes('beggar');
    const secTools = (c.secondary || []).map(a => (D.ranks.startTool[a] || {}).name).filter(Boolean).join(' and ');
    const rentPrice = beggar ? null : shipPriceAt(run.ship, outlaw ? OUTLAW_RENT_HUB : run.startLoc);
    const priceStep = rentPrice ? ` <span class="dim">(~${money(rentPrice)}/day)</span>` : '';
    // real start steps: you must TRAVEL to your starting location. Grim Hex has no rental, so a non-beggar outlaw rents first at a lawful hub. Never "spawn" (spawn = death).
    let startSteps;
    if (beggar) {
      startSteps = `<li>Travel to <b>${esc(run.startLoc)}</b> — your starting location. You begin with <b>no ship and no credits</b>: work on foot or hitch a ride for your first aUEC, then rent your first ship. Bum a lift if you must, but never money.</li>`;
    } else if (outlaw) {
      startSteps =
        `<li>Rent your <b>${esc(run.ship)}</b> at <b>${esc(OUTLAW_RENT_HUB)}</b> first${priceStep} — <b>Grim Hex has no ship rental</b>.</li>` +
        `<li>Fly to <b>Grim Hex</b> — your starting location.</li>`;
    } else {
      startSteps = `<li>Travel to <b>${esc(run.startLoc)}</b> — your starting location — and rent your <b>${esc(run.ship)}</b> there${priceStep}.</li>`;
    }
    $('#briefing').innerHTML = `
      <p class="kicker">${esc(ASP_LABEL[c.primary])} · ${esc(c.path)}${esc(modTxt)}</p>
      <p class="backstory"><span id="bs-text">${esc(run.backstory || '')}</span> <button id="btn-reroll-bs" class="bs-reroll" type="button" title="Roll a new backstory" aria-label="Roll a new backstory">↻</button></p>
      <div class="brief-grid">
        <div><span class="k">Start at</span><span class="v">${esc(run.startLoc)}</span></div>
        <div><span class="k">${beggar ? 'First ship' : 'Rent first'}</span><span class="v">${esc(run.ship)}</span></div>
        <div><span class="k">Story wallet</span><span class="v">${run.wallet ? money(run.wallet)+' aUEC' : '0 — earn your first ship on foot'}</span></div>
      </div>
      <div class="prep">
        <b>The rules</b>
        <ul>
          <li><b>One life.</b> Respawning at a station or city ends your story. Call for help if you're incapacitated.</li>
          <li><b>Rented ships only.</b> Rent just the ship you're told to, when you're told. If it's destroyed or the rental lapses, <b>re-rent the same one</b> — don't upgrade until the story says so.</li>
          <li><b>Frozen wallet.</b> Note your real balance and don't touch it — or send it all to a friend so you can't be tempted. Spend only what this story earns.</li>
          <li><b>Advance by doing.</b> Clear each rank by completing its contracts. The story hands you the next step.</li>
        </ul>
        <b>Before you start</b>
        <ul>
          <li>Grab a simple <b>undersuit + helmet</b> and <b>${esc(tool.name)}</b>${tool.why?` <span class="dim">(${esc(tool.why)})</span>`:''}.</li>
          ${secTools ? `<li>Your secondary callings can surface too — also pack <b>${esc(secTools)}</b>.</li>` : ''}
          ${startSteps}
          <li>${medbed
            ? 'This ship has a <b>medbed</b> — set it as your respawn point now.'
            : 'Your starter has <b>no medbed</b>, so any death ends your story. Play carefully.'}</li>
          ${c.modifiers.includes('off-grid') ? '<li><b>Off-Grid:</b> no station repair / refuel / rearm — handle it yourself or lean on other players.</li>' : ''}
        </ul>
      </div>`;
    const rb = $('#btn-reroll-bs');
    if (rb) rb.onclick = () => { run.backstory = makeBackstory(run.cfg, run.startLoc); save(); const t = $('#bs-text'); if (t) t.textContent = run.backstory; };
    show('view-briefing');
  }

  // ---------- run loop ----------
  function enterRun() {
    if (!run.currentBeat) run.currentBeat = rollBeat();
    save(); renderRun(); show('view-run');
  }

  // restock station for a destination (same model as Surprise Me — nearest station from the Strata map)
  function nearestPyroStation(loc) {
    const m = D.providers.pyroMap; if (!m || !m.bodies || !m.bodies[loc]) return loc;
    const b = m.bodies[loc]; let best = loc, bd = Infinity;
    for (const [name, s] of Object.entries(m.stations)) {
      const d = b.r*b.r + s.r*s.r - 2*b.r*s.r*Math.cos((b.a - s.a) * Math.PI/180);
      if (d < bd) { bd = d; best = name; }
    }
    return best;
  }
  function restockStation(loc, sys) {
    const PV = D.providers;
    if (sys === 'Pyro') return (PV.pyroMap && PV.pyroMap.stations[loc]) ? loc : nearestPyroStation(loc);
    const t = PV.restockStations && PV.restockStations[sys];
    return (t && t[loc]) || loc;
  }

  // system reach ramps with rank — ease players in: R0–R1 stay in your STARTING system, then widen outward (Pyro added last). Only widen early if the calling has no local content.
  const SYS_ADD_ORDER = { Stanton: ['Stanton','Nyx','Pyro'], Nyx: ['Nyx','Stanton','Pyro'] };
  const SYS_REACH = { 0:1, 1:1, 2:2, 3:3, 4:3 };
  const startSystem = () => /nyx|levski/i.test(String((run && run.startLoc) || '')) ? 'Nyx' : 'Stanton';
  const allowedSystems = rank => (SYS_ADD_ORDER[startSystem()] || SYS_ADD_ORDER.Stanton).slice(0, SYS_REACH[rank] ?? 3);

  // roll a beat from the REAL provider data (same source as Surprise Me), gated by calling + path + pacifist + system reach
  function rollBeat() {
    const c = run.cfg;
    if (run.rank === 4) return { hero: true };
    const PV = D.providers;
    let types = run.rank === 0
      ? ['hauling']   // R0 = starter courier work anyone can do in an Aurora/Mustang/Cutter — you don't have your specialised ship yet
      : [...new Set([c.primary, ...(c.secondary||[])].map(a => ASP_TYPE[a]).filter(Boolean))];
    if (c.modifiers.includes('pacifist')) types = types.filter(t => PV.types[t] && !PV.types[t].combat);
    if (!types.length) types = ['hauling'];   // pacifist wiped a combat calling → peaceful courier work (setup also blocks this combo)
    const gather = pth => {
      const out = [];
      Object.values(PV.providers).forEach(p => { if (p.path !== pth) return;
        for (const [t, syss] of Object.entries(p.byType || {})) { if (!types.includes(t)) continue;
          for (const s of syss) out.push({ p, t, sys: s }); } });
      return out;
    };
    let pairs = gather(c.path === 'outlaw' ? 'illegal' : 'legal');
    if (!pairs.length && c.path === 'outlaw') pairs = gather('legal');   // outlaw with no illegal offer for this calling → clean work
    if (!pairs.length) { types = ['hauling']; pairs = gather('legal'); }  // ultimate fallback — hauling always has legal providers, so the story never dead-ends
    if (!pairs.length) return { empty: true };
    const reach = new Set(allowedSystems(run.rank));                       // stay near your start early; travel more as you rank up
    const inReach = pairs.filter(x => reach.has(x.sys));
    if (inReach.length) pairs = inReach;                                   // only widen early if the calling has nothing in reach (e.g. investigation is Stanton-only)
    if (pairs.length > 1 && run.lastProv) { const nx = pairs.filter(x => x.p.name !== run.lastProv); if (nx.length) pairs = nx; }
    const pick = rand(pairs);
    run.lastProv = pick.p.name;
    const loc = rand(PV.locations[pick.sys] || [pick.sys]);
    const t = PV.types[pick.t];
    return {
      hero: false, typeName: t.name, combat: !!t.combat, sys: pick.sys, loc,
      provider: pick.p.name, tab: pick.p.tab, altTab: pick.p.altTab || null, altTabSys: pick.p.altTabSys || null, verify: !!pick.p.verify,
      note: (pick.p.note && (!pick.p.noteSys || pick.p.noteSys.includes(pick.sys))) ? pick.p.note : null,
      restock: restockStation(loc, pick.sys),
    };
  }

  function onDone() {
    const b = run.currentBeat;
    if (b.hero) {
      run.victory = true;
      const tr = track(run.cfg.primary), h = FINALE_HERO[run.cfg.primary] && D.heroes.heroAdventures[FINALE_HERO[run.cfg.primary]];
      run.log.push({ t:'hero', text:`FINALE — ${h ? h.name : 'bought your ' + (tr.finisher?.name || 'own ship')}` });
      save(); return endRun();
    }
    if (b.rankup || b.empty) { run.currentBeat = rollBeat(); save(); return renderRun(); }   // acknowledged the rank-up / empty → next mission
    run.counters[run.rank] = (run.counters[run.rank]||0)+1;
    run.log.push({ t:'beat', text:`${b.typeName} · ${b.provider} · ${b.sys}` });
    const thr = THRESHOLDS[run.rank] ?? 10;
    if (run.counters[run.rank] >= thr) {
      run.rank++;
      run.ship = rankShip(run.cfg.primary, run.rank) || run.ship;
      run.log.push({ t:'rankup', text:`RANK UP → R${run.rank}` });
      run.currentBeat = { rankup:true };   // always a rent-the-ship beat; acknowledging it rolls the next (rollBeat returns the finale at R4)
      save(); return renderRun();
    }
    run.currentBeat = rollBeat(); save(); renderRun();
  }

  function onDied() {
    const outlaw = run.cfg.path === 'outlaw';
    if (outlaw && run.rank > 0) {   // wanted death → Klescher: drop a rank and continue
      run.rank = Math.max(0, run.rank-1);
      run.log.push({t:'klescher', text:'Died wanted → Klescher. Dropped a rank, story continues.'});
      run.currentBeat = rollBeat(); save(); return renderRun();
    }
    run.alive = false;
    run.log.push({t:'death', text:'Respawned at a station or city. That’s your story.'});
    save(); endRun();
  }

  // ---------- render ----------
  function renderRun() {
    const c = run.cfg, b = run.currentBeat;
    const thr = THRESHOLDS[run.rank] ?? 10, done = run.counters[run.rank]||0;
    const rankPips = [0,1,2,3,4].map(r =>
      `<span class="pip ${r<run.rank?'past':r===run.rank?'now':''}">R${r}</span>`).join('');
    $('#run-hud').innerHTML = `
      <div class="hud-top">
        <span class="who">${esc(ASP_LABEL[c.primary])}</span>
        <span class="ranks">${rankPips}</span>
      </div>
      <div class="hud-bot">
        <span>Flying: <b>${esc(run.ship)}</b></span>
        <span>${run.rank<4?`Progress: <b>${done}/${thr}</b> contracts`:'<b>Finale</b>'}</span>
      </div>`;

    const beat = $('#beat');
    if (b && b.hero) { beat.style.removeProperty('--sys'); renderFinale(); }
    else if (b && b.rankup) { beat.style.removeProperty('--sys'); renderRankup(); }
    else if (b && b.empty) {
      beat.style.removeProperty('--sys');
      beat.innerHTML = `<p>No contracts fit that combo — press <b>Done</b> for the next one.</p>`;
      $('#btn-done').textContent = '✓ Next contract';
    } else if (b) {
      beat.style.setProperty('--sys', `var(--${b.sys.toLowerCase()})`);
      const cat = b.verify ? '' : ` from the <b>${esc(b.tab)}</b>${b.altTab && (!b.altTabSys || b.altTabSys.includes(b.sys)) ? ` or <b>${esc(b.altTab)}</b>` : ''} category`;
      const restockTxt = b.restock === b.loc ? 'restock &amp; rearm here' : `restock &amp; rearm at ${esc(b.restock)}`;
      const art = /^[aeiou]/i.test(b.provider) ? 'an' : 'a';
      const diff = difficultyNote(b);
      // combat providers post BOTH ship & ground under one category, so name the type; non-combat providers ARE their category (Collection/Delivery/Mining…), so let the category speak
      const heading = b.combat ? b.typeName : b.tab;
      const typeWord = b.combat ? esc(b.typeName.toLowerCase()) + ' ' : '';
      beat.innerHTML = `
        <div class="beat-chips">
          <span class="chip sys-${esc(b.sys)}">${esc(b.sys)}</span>
          <span class="chip ${b.combat?'combat':'calm'}">${b.combat?'combat':'non-combat'}</span>
          <span class="chip ${c.path==='outlaw'?'illegal':'legal'}">${esc(c.path)}</span>
        </div>
        <h2>${esc(heading)}</h2>
        <ol class="beat-steps">
          <li>Travel to <b>${esc(b.loc)}</b> in <b>${esc(b.sys)}</b> System <span class="dim">· (${restockTxt})</span>.</li>
          <li>Open the Contracts Manager and take ${art} <b>${esc(b.provider)}</b> ${typeWord}contract${cat}.</li>
        </ol>
        <p class="beat-note">If that exact contract isn't listed, take the closest one in the same category — boards rotate.</p>
        ${diff ? `<p class="beat-diff">🎯 ${diff}</p>` : ''}
        ${b.note?`<p class="beat-note">${esc(b.note)}</p>`:''}
        <div class="beat-ship">🚀 Fly your <b>${esc(run.ship)}</b> <span class="dim">— your R${run.rank} rental</span>.</div>`;
      $('#btn-done').textContent = '✓ Done — next contract';
    }
    renderLog();
  }

  function renderFinale() {
    const c = run.cfg, tr = track(c.primary);
    const fin = (tr.finisher && tr.finisher.name) || 'own ship';
    const h = FINALE_HERO[c.primary] && D.heroes.heroAdventures[FINALE_HERO[c.primary]];
    if (h) {
      const solo = { 'yes':'Soloable', 'yes-hard':'Soloable — hard', 'yes-very-hard':'Soloable — very hard', 'yes-extremely-hard':'Soloable — brutal', 'no':'Needs a crew' }[h.soloable] || '—';
      const rep = (h.repRequirements && !/^null$|none/i.test(h.repRequirements))
        ? `<p class="beat-diff">🎯 Needs <b>${esc(h.repRequirements)}</b> standing — if you're short, run ${esc(h.missionSource||'their')} contracts to rep up to it first.</p>`
        : (h.prerequisites && !/^null$/i.test(h.prerequisites))
        ? `<p class="beat-diff">🎯 Unlock it first: <b>${esc(h.prerequisites)}</b>.</p>` : '';
      const crew = (h.soloable && h.soloable !== 'yes')
        ? `<p class="beat-crew">🤝 ${h.soloable==='no' ? 'This one needs a crew' : 'Brutal solo'} — rally a couple of org-mates or players from the server. Safer, and a lot more fun together.</p>` : '';
      $('#beat').innerHTML = `
        <span class="beat-kind hero">R4 · Your finale</span>
        <h2>${esc(h.name)}</h2>
        <div class="beat-rows">
          <div><span class="k">Where</span><span class="v">${esc(h.system)} · ${esc(h.location)}</span></div>
          <div><span class="k">Giver</span><span class="v">${esc(h.missionSource||'—')}</span></div>
          <div><span class="k">Solo</span><span class="v">${esc(solo)}</span></div>
          <div><span class="k">Reward</span><span class="v">${h.rewards ? esc(amp(h.rewards)) : '—'}</span></div>
        </div>
        ${rep}${crew}
        <div class="beat-ship">🚀 Fly your <b>${esc(run.ship)}</b> <span class="dim">— your R4 rental</span>.</div>
        <p class="dim">Pull it off without a full death and you've reached the top of your story.</p>`;
    } else {
      $('#beat').innerHTML = `
        <span class="beat-kind hero">R4 · Your finale</span>
        <h2>Top of the ladder</h2>
        <p class="rankup-lede">You've maxed the rental ladder in your <b>${esc(run.ship)}</b>. The finale is graduating — run top-tier contracts until you can buy a ship of your own.</p>
        <p class="dim">When you're ready, mark it done to close your story.</p>`;
    }
    $('#btn-done').textContent = '★ I made it';
  }

  function buyInfo(name) {
    const s = ((D.purchases && D.purchases.ships) || []).find(x => x.n.toLowerCase() === String(name).toLowerCase());
    return s ? { name: s.n, price: s.p, shop: SHOP[s.s[0]] || s.s[0] } : null;
  }
  const MAX_GRAD = 12000000;   // don't suggest a graduation ship over ~12M — anything pricier takes forever to raise (author: 27M is insane)
  function pickGraduateShip(a) {
    const list = (GRADUATE[a] || []).slice();
    while (list.length) { const nm = list.splice(Math.floor(Math.random()*list.length), 1)[0]; const info = buyInfo(nm); if (info && info.price <= MAX_GRAD) return info; }
    const fin = (track(a).finisher || {}).name, fi = fin ? buyInfo(fin) : null;
    return (fi && fi.price <= MAX_GRAD) ? fi : null;
  }
  // a rank-up is its own beat — go rent the new ship, and kit it in Hardpoint
  function rentHubFor(name) {
    const norm = s => String(s).toLowerCase().replace(/mk\s*i+/g,'').replace(/\s+/g,' ').trim();
    const n = norm(name);
    const LBL = { 'Area 18':{label:'Area18 · ArcCorp',sys:'Stanton'}, 'Lorville':{label:'Lorville · Hurston',sys:'Stanton'}, 'New Babbage':{label:'New Babbage · microTech',sys:'Stanton'}, 'Orison':{label:'Orison · Crusader',sys:'Stanton'}, 'Levski':{label:'Levski',sys:'Nyx'} };
    const s = Object.values(D.ships.ships).find(x => norm(x.name) === n);
    if (!s || !s.byLocation) return null;
    const cities = Object.keys(s.byLocation).filter(l => LBL[l]).sort((a,b) => s.byLocation[a] - s.byLocation[b]);
    if (!cities.length) return null;
    const c = cities[0];
    return { label: LBL[c].label, sys: LBL[c].sys, price: s.byLocation[c] };
  }
  function renderRankup() {
    const ship = run.ship, hub = rentHubFor(ship), art = /^[aeiou]/i.test(ship) ? 'an' : 'a';
    const price = hub && hub.price ? ` <span class="dim">(~${money(hub.price)}/day)</span>` : '';
    const where = hub
      ? `Head to <b>${esc(hub.label)}</b> in <b>${esc(hub.sys)}</b> and pick up the <b>${esc(ship)}</b>${price} — your ride for R${run.rank}.`
      : `Pick up ${art} <b>${esc(ship)}</b> at a ship-rental terminal — your ride for R${run.rank}.`;
    $('#beat').innerHTML = `
      <span class="beat-kind rankup">⬆ Rank up — R${run.rank}</span>
      <h2>Nice work — time to upgrade your ship.</h2>
      <p class="rankup-lede">${where}</p>
      <p class="rankup-help">Short on aUEC? Re-run a few contracts from your last rank — they're in your captain's log — until you can afford it.</p>
      ${run.rank === 1 && ARMOUR[run.cfg.primary] ? `<p class="rankup-help">🛡 ${hub ? `Since you're in <b>${esc(hub.label)}</b>, grab` : 'While you gear up, grab'} <b>${ARMOUR[run.cfg.primary]}</b> if you haven't yet.</p>` : ''}
      <div class="beat-ship">🔧 Check what weapon upgrades your rental can take in <a href="https://seeknd.github.io/Hardpoint/" target="_blank" rel="noopener">Hardpoint</a>.<br>
        <span class="dim">Remember to remove all your upgrades before your rental expires — or you'll lose them.</span></div>`;
    $('#btn-done').textContent = '✓ Got it →';
  }

  function renderLog() {
    $('#log').innerHTML = run.log.map(e => `<li class="lg lg-${e.t}">${esc(e.text)}</li>`).join('') || '<li class="dim">No contracts yet.</li>';
  }

  // ---------- end ----------
  function endRun() {
    const c = run.cfg, done = Object.values(run.counters).reduce((a,x)=>a+x,0);
    $('#end-title').textContent = run.victory ? '★ You made it' : '✝ Story over';
    let head;
    if (run.victory) {
      const hero = FINALE_HERO[c.primary] && D.heroes.heroAdventures[FINALE_HERO[c.primary]];
      const grad = pickGraduateShip(c.primary);
      const art = grad && /^[aeiou]/i.test(grad.name) ? 'an' : 'a';
      const finaleReplay = hero && (hero.rewardType||[]).includes('auec') ? ` — or re-run <b>${esc(hero.name)}</b> (it pays ${esc(amp(hero.rewards))})` : '';
      const survived = hero
        ? `You survived <b>${esc(hero.name)}</b>, but your adventure has only begun.`
        : `You've topped the ${esc(ASP_LABEL[c.primary])} ladder, but your adventure has only begun.`;
      head = `
        <p class="win">Congratulations. ${survived}</p>
        ${grad ? `<div class="grad">The next step of your adventure is owning your own ship. Consider buying ${art} <b>${esc(grad.name)}</b> at <b>${esc(grad.shop)}</b> for <b>~${money(grad.price)} aUEC</b>.<br>
          <span class="dim">Not enough yet? Re-run previous-rank contracts${finaleReplay} until you can afford it.</span></div>` : ''}`;
    } else {
      head = `<p class="lose">You reached <b>R${run.rank}</b> after <b>${done}</b> contracts.</p>`;
    }
    $('#end-body').innerHTML = `
      ${head}
      <div class="brief-grid">
        <div><span class="k">Calling</span><span class="v">${esc(ASP_LABEL[c.primary])}</span></div>
        <div><span class="k">Path</span><span class="v">${esc(c.path)}${c.modifiers.length?' · '+esc(modLabels(c.modifiers).join(', ')):''}</span></div>
        <div><span class="k">Rank reached</span><span class="v">R${run.rank}</span></div>
        <div><span class="k">Contracts done</span><span class="v">${done}</span></div>
      </div>
      <details class="log-wrap" open><summary>Captain's Log</summary><ol>${run.log.map(e=>`<li class="lg lg-${e.t}">${esc(e.text)}</li>`).join('')}</ol></details>`;
    show('view-end');
  }

  function copyLog() {
    const c = run.cfg;
    const head = `**Story Mode — ${ASP_LABEL[c.primary]} (${c.path}${c.modifiers.length?', '+modLabels(c.modifiers).join(', '):''})**\n`
      + (run.victory ? `Result: topped out — reached the finale and lived. The adventure continues.\n\n`
                     : `Result: died at R${run.rank}.\n\n`);
    const body = run.log.map((e,i)=>`${i+1}. ${e.text}`).join('\n');
    navigator.clipboard?.writeText(head+body).then(()=>{ const b=$('#btn-copy'); b.textContent='✅ Copied'; setTimeout(()=>b.textContent='📋 Copy log',1600); });
  }

  // ---------- boot ----------
  async function init() {
    try {
      const entries = await Promise.all(Object.entries(FILES).map(async ([k,f]) => [k, await (await fetch(f, {cache:'no-store'})).json()]));
      D = Object.fromEntries(entries);
    } catch (e) {
      document.body.innerHTML = `<div style="padding:40px;font-family:system-ui">Couldn't load data files (serve this over http, not file://). ${e}</div>`;
      return;
    }
    ASP_LABEL = Object.fromEntries(TRACKS.map(a => [a, (D.ranks.tracks[a]||{}).name || a]));
    fillSetup();
  }
  init();
})();
