/* Org campaign state — event log + deterministic fold.
 *
 * The campaign IS its event log. Only human actions are stored; everything else
 * (meters, chest, tallies, chronicle, and later the Director's moves) is DERIVED
 * by folding the log with a pure function — so every client computes identical
 * state from the same log, and there is nothing to referee.
 *
 * Storage is pluggable: createDemoStore (localStorage) now, the Firebase adapter
 * later implements the same {append, subscribe, exportLog, importLog} surface.
 *
 * Event shape: { t: epoch-ms, a: actor, k: kind, p: payload }
 * Kinds (v1):
 *   campaign.create { name, system, seed, mode, seasonDays }
 *   member.join     { callsign }
 *   target.set      { region, zone }
 *   contract.done   { region, zone, ctype, onSite?, pushId? }
 *   fleet.pledge       { ship }
 *   fleet.commission   { fleetId }
 *   fleet.lost         { fleetId, note? }
 *   fleet.recommission { fleetId, salvaged? }
 *   contract.claim     { claimId, pushId?, ctype, region, zone, roll? }
 *   contract.abandon   { claimId }
 *   project.complete   { id }
 *   chest.convert      { from, to, amount }
 */

(function () {
  'use strict';

  // ── Tuning ──────────────────────────────────────────────────────────────
  const TUNING = {
    BASE_GAIN: 2,            // control % per completed contract, before multipliers
    ONSITE_MULT: 1.5,        // mission landed on the target zone (self-reported)
    PUSH_BONUS: 5,           // banked when a push completes in-window
    PUSH_COUNT: 3,           // contracts to complete a push
    RAID_PENALTY: 10,        // control lost when a raid goes unanswered
    DISTRACT_REWARD: { supplies: 4, intel: 1 },  // answering a relief call
    DISTRACT_COST: { supplies: 3 },              // ignoring one (floored at 0)
    INTEL_TELEGRAPH: 3,      // chest intel needed to preview tomorrow's move
    CAPTURE: 100,            // control needed to hold a zone
    DAY_MS: 86400000,        // one campaign tick
    MATERIAL_PER_CONTRACT: 1,
    FUNDS_PER_CONTRACT: 50000,   // ORG funds (campaign fiction) per banked contract
    PUSH_FUNDS_BONUS: 100000,    // treasury bonus when a push completes
    HELD_FUNDS_PER_TICK: 25000,  // every held zone funds the treasury daily
    HEAT_RAID_MULT: 3,           // mining a contested zone triples next-day raid weight on it
    CLAIM_TTL_MS: 90 * 60000,    // a claimed contract auto-returns to the pool after this
    RECOMMISSION_FRAC: 0.25,     // recommission a lost hull at this fraction of its price
    RIDE_THRESHOLD: 10,          // contracts in a line's types per promotion tier (10, then 20, then 30)
    FRONT_CAP: 3,                // simultaneous front-line zones
    OFF_FRONT_GAIN: 1,           // flat control for work outside the front lines — no bonuses
    SETPIECE_SURGE: 10,          // control surge when the org runs a region's set-piece op (first run only)
    ORGDAY_TARGET: 9,            // contracts in the region on an Org Day to unlock its set-piece
    ORGDAY_CONFRONT_AT: 3,       // Org Day contract count that triggers the Director's confrontation…
    ORGDAY_CONFRONT_ADD: 3,      // …which extends the path by this many contracts
    ORGDAY_DRAG_AT: 6,           // Org Day contract count that triggers the drag-away feint…
    ORGDAY_DRAG_NEED: 2,         // …demanding this many hauling contracts in another region by day's end
    ORGDAY_DRAG_PENALTY: 100000, // ORG funds bled if the feint goes unanswered
    RIDE_FEE_DAYS: 10,           // unlock fee = 10 × the ride's 1-day rental price
    APPROVAL_LIMIT: 1000000,     // spends above this need an approver (or be one) — tier-2 rides flow solo, the big toys get a nod
    SALVAGE_DISCOUNT: 0.5,       // "I salvaged my wreck" halves the recommission bill
  };

  // fleet clearance bands by real hull price (ORG funds = real aUEC prices)
  const BANDS = [
    { id: 'light',   label: 'Light',   max: 2000000 },
    { id: 'medium',  label: 'Medium',  max: 9000000 },
    { id: 'heavy',   label: 'Heavy',   max: 20000000 },
    { id: 'capital', label: 'Capital', max: Infinity },
  ];
  const bandFor = (price) => BANDS.find(b => price <= b.max);

  // industry contracts feed the war chest in these buckets
  const CHEST_BUCKET = { mining: 'metals', salvage: 'components', hauling: 'supplies', investigation: 'intel' };

  // push kinds → the meter bucket they demand and pay their bonus into.
  // org kinds are offered from targets; defend/relief are the Director's demands.
  const PUSH_KIND = {
    take:     { bucket: 'combat',   label: 'Take',    types: ['ship-combat', 'ground-combat'], org: true },
    supply:   { bucket: 'supply',   label: 'Supply',  types: ['hauling'], org: true },
    industry: { bucket: 'industry', label: 'Develop', types: ['mining', 'salvage'], org: true },
    defend:   { bucket: 'combat',   label: 'Defend',  types: ['ship-combat', 'ground-combat'] },
    relief:   { bucket: 'supply',   label: 'Relief',  types: ['hauling'] },
  };
  const PUSH_ID_RE = /^p(\d+):([a-z0-9_]+):(take|supply|industry|defend|relief):([a-z0-9_]+)$/;

  // ride lines — a line's contracts advance its ladder; the ladders themselves
  // come from story_ranks.json tracks (R1+), reused verbatim
  const LINE_TYPES = {
    bounty: ['ship-combat'], merc: ['ground-combat'], miner: ['mining'],
    hauler: ['hauling'], salvager: ['salvage'], explorer: ['investigation'],
  };
  const TYPE_LINE = {};
  for (const [ln, ts] of Object.entries(LINE_TYPES)) for (const t of ts) TYPE_LINE[t] = ln;
  const STANTON_RENT_CITIES = ['Area 18', 'Lorville', 'Orison', 'New Babbage'];
  // org-campaign ladder overrides (story_ranks stays untouched for Story Mode)
  const RIDE_LADDER_OVERRIDES = {
    salvager: { 1: ['Salvation'], 2: ['Fortune'], 3: ['MOTH'], 4: ['MOTH'] },
  };

  // ORG TIER — collective performance (zones held) gates the difficulty the
  // board asks for: bounty risk ranks, and Gilly 7/8 as org ops at the top
  const ORG_TIERS = [
    { held: 0, level: 'I',   rank: 'VLRT', gillyMax: 6 },
    { held: 1, level: 'II',  rank: 'LRT',  gillyMax: 6 },
    { held: 2, level: 'III', rank: 'MRT',  gillyMax: 6 },
    { held: 4, level: 'IV',  rank: 'HRT',  gillyMax: 6 },
    { held: 6, level: 'V',   rank: 'VHRT', gillyMax: 7 },
    { held: 9, level: 'VI',  rank: 'ERT',  gillyMax: 8 },
  ];

  // ── Deterministic RNG (seed string → PRNG in [0,1)) ─────────────────────
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // rng('seed', tick, 'raid') — same parts, same stream, on every client
  function rng(...parts) { return mulberry32(xmur3(parts.join(':'))()); }

  // ── Region-data helpers ─────────────────────────────────────────────────
  function sysDef(regions, system) { return regions.systems[system]; }

  function findZone(regions, system, zoneId) {
    const sys = sysDef(regions, system);
    if (!sys) return null;
    for (const [rid, r] of Object.entries(sys.regions)) {
      if (r.zones[zoneId]) return { regionId: rid, region: r, zone: r.zones[zoneId] };
    }
    return null;
  }

  // Types that can occur AT a zone (gates the on-site bonus). Salvage never can.
  function zoneOnSiteTypes(regions, system, regionId, zoneId) {
    const sys = sysDef(regions, system);
    const region = sys && sys.regions[regionId];
    if (!region || !region.zones[zoneId]) return [];
    const z = region.zones[zoneId];
    const base = z.onSite
      ? z.onSite
      : Object.keys(region.availability).filter(t => region.availability[t] !== 'none');
    return base.filter(t => t !== 'salvage');
  }

  function availabilityMult(regions, system, regionId, ctype) {
    const sys = sysDef(regions, system);
    const region = sys && sys.regions[regionId];
    const level = region && region.availability[ctype];
    if (!level) return 0;
    const def = regions.availabilityLevels[level];
    return def ? def.multiplier : 0;
  }

  // ── The fold ────────────────────────────────────────────────────────────
  // Pure: (regionsData, events, now) → state. Chronological single pass with
  // tick boundaries processed between events (held-zone yields land per tick).
  // callsign identity: trim + collapse spaces for display, lowercase for the key
  const dispName = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
  const normName = (s) => dispName(s).toLowerCase();

  function fold(regions, events, now, projects, ships, rentals, ranks, heroes) {
    // data-bag call style: fold(regions, events, now, {projects, ships, rentals, ranks, heroes})
    if (projects && (projects.ships || projects.rentals || projects.ranks)) {
      const bag = projects;
      ships = bag.ships || ships; rentals = bag.rentals || rentals; ranks = bag.ranks || ranks;
      heroes = bag.heroes || heroes;
      projects = bag.projects || null;
    }
    const heroName = (id) => (id && heroes && heroes.heroAdventures && heroes.heroAdventures[id] && heroes.heroAdventures[id].name) || 'the set-piece';
    const shipPrice = (name) => {
      if (!ships || !Array.isArray(ships.ships)) return null;
      const hit = ships.ships.find(s => s.n === name);
      return hit ? hit.p : null;
    };
    // resolve a ladder ship name to its rental entry — tolerant: case/punctuation
    // and "Mk I"-style marks are ignored ("Aurora LN" ↔ "Aurora Mk I LN")
    const rentByName = (name) => {
      if (!rentals || !rentals.ships) return null;
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/mk[iv0-9]+/g, '');
      const target = norm(name);
      let loose = null;
      for (const [key, s] of Object.entries(rentals.ships)) {
        const n2 = norm(s.name || '');
        if (n2 === target) return { key, ...s };
        if (!loose && (n2.includes(target) || target.includes(n2))) loose = { key, ...s };
      }
      return loose;
    };
    const rideCandidates = (line, tier) => {
      const track = ranks && ranks.tracks && ranks.tracks[line];
      if (!track) return [];
      const tryRank = (r) => {
        const over = RIDE_LADDER_OVERRIDES[line] && RIDE_LADDER_OVERRIDES[line][r];
        const rk = (track.ranks || []).find(x => x.r === r);
        const names = (over || ((rk && rk.ship) || [])).filter(n => !String(n).startsWith('+'));
        return names.map(n => {
          const rent = rentByName(n);
          if (!rent) return null;
          const locs = Object.entries(rent.byLocation || {}).filter(([c]) => STANTON_RENT_CITIES.includes(c));
          if (!locs.length) return null;
          locs.sort((a, b) => a[1] - b[1]);
          return { name: rent.name, city: locs[0][0], price: locs[0][1] };
        }).filter(Boolean);
      };
      // a rank with nothing rentable in Stanton borrows the next rank up, then down
      return tryRank(tier).length ? tryRank(tier) : (tryRank(tier + 1).length ? tryRank(tier + 1) : tryRank(tier - 1));
    };
    // ONE rolled ship per (member, line, tier) — never a menu
    const rideFor = (callsignName, line, tier) => {
      const cands = rideCandidates(line, tier);
      if (!cands.length) return null;
      const rand = rng(config.seed, 'ride', callsignName, line, String(tier));
      return cands[Math.floor(rand() * cands.length)];
    };
    const rideFee = (ride) => ride ? Math.ceil(ride.price * TUNING.RIDE_FEE_DAYS) : null;
    // one identity per person across every device: names fold to a normalized
    // key (Carlit0 = carlit0 = CARLIT0); the first-typed spelling is kept for display
    const normEvent = (e) => {
      const p0 = e.p || {};
      const p = Object.assign({}, p0);
      if (e.k === 'member.join' && p.callsign != null) p.display = p.display || dispName(p.callsign);
      if (p.callsign != null) p.callsign = normName(p.callsign);
      if (p.to != null) p.to = normName(p.to);
      if (Array.isArray(p.participants)) p.participants = p.participants.map(normName);
      return Object.assign({}, e, { a: normName(e.a), p });
    };
    // net logs carry a push key (_k) — a total, clock-skew-proof tie-break shared
    // by every client; local logs fall back to insertion order
    const sorted = events
      .map((e, i) => ({ e: normEvent(e), i }))
      .sort((a, b) => (a.e.t - b.e.t) ||
        (a.e._k && b.e._k ? (a.e._k < b.e._k ? -1 : a.e._k > b.e._k ? 1 : 0) : 0) ||
        (a.i - b.i))
      .map(x => x.e);

    const create = sorted.find(e => e.k === 'campaign.create');
    if (!create) return null;
    const config = Object.assign({ system: 'Stanton', seasonDays: 28 }, create.p, { startedAt: create.t });
    config.seasonDays = Math.max(3, Math.min(60, Math.round(+config.seasonDays) || 28));
    const sys = sysDef(regions, config.system);
    if (!sys) return null;

    const state = {
      config, now,
      tick: 0,
      zones: {},           // zoneId → {region, control, held, cats, penalty}
      regions: {},         // regionId → {target}
      chest: { metals: 0, components: 0, supplies: 0, intel: 0, funds: 0 },
      members: {},         // callsign → {joined, total, onSite, tallies}
      fleet: [],           // {id, ship, by, status}
      chronicle: [],       // {t, tick, kind, text}
      activeByTick: {},    // tick → count of distinct contributors
      skipped: 0,          // events that referenced unknown things (forward-compat)
      projectsDone: {},    // projectId → {at, by}
      victory: null,       // {at, project} once the season is won
      claims: {},          // claimId → {by, at, pushId, ctype, region, zone, roll, status}
      approvers: [],       // callsigns who may approve big spends (creator is first)
      requests: {},        // reqId → {by, at, kind, payload, status}
      proposals: {},       // reqId → {from, to, give, take, status} — member↔member ship swaps
      swaps: [],           // applied access transfers: {from, to, ship}
      setPieces: {},       // regionId → {at, tick, by, participants, hero, zone, runs} — surge fires on the first run
      spUnlocked: {},      // regionId → true once an Org Day cleared the path to its set-piece
      finaleReady: null,   // {at, project} — the flagship is built; the maiden voyage remains
      nextSeason: null,    // {code, by, at} — a closed campaign pointing at its successor
      spectators: {},      // callsign key → true — invited eyes; their gameplay events don't fold
      report: null,        // {by, at, webhook} — daily battle-report wiring (approver-set)
    };

    state.fronts = {};   // zone → {by, at} — the declared front lines (intent to capture)
    for (const [rid, r] of Object.entries(sys.regions)) {
      state.regions[rid] = {};
      for (const zid of Object.keys(r.zones)) {
        state.zones[zid] = { region: rid, control: 0, held: false, cats: { combat: 0, supply: 0, industry: 0 }, penalty: 0 };
      }
    }

    const tickOf = (t) => config.startedAt == null ? 0 : Math.max(0, Math.floor((t - config.startedAt) / TUNING.DAY_MS));
    const chron = (t, kind, text) => state.chronicle.push({ t, tick: tickOf(t), kind, text });
    const activeSets = {};
    const pushTally = {};   // pushId → qualifying completions
    const heatSets = {};    // tick → Set of contested zones that took industry work
    const orgDayByTick = {}; // tick → {region, by, at, count, unlocked} — the day's rally

    // ── Powers (board-only effects of held zones / swept regions) ─────────
    function activeEffects() {
      const fx = [];
      for (const [rid, r] of Object.entries(sys.regions)) {
        let all = true;
        for (const [zid, zdef] of Object.entries(r.zones)) {
          const held = state.zones[zid] && state.zones[zid].held;
          if (!held) all = false;
          if (held && zdef.power) fx.push({ zone: zid, region: rid, effect: zdef.power.effect });
        }
        if (all && r.regionPower) fx.push({ region: rid, sweep: true, effect: r.regionPower.effect });
      }
      for (const pid of Object.keys(state.projectsDone)) {
        const proj = projects && projects.projects && projects.projects[pid];
        if (proj && proj.grant && proj.grant.effect) fx.push({ project: pid, effect: proj.grant.effect });
      }
      return fx;
    }
    const gainMultFor = (ctype, bucket, regionId) => {
      let m = 1;
      for (const f of activeEffects()) {
        const g = f.effect.gainMult;
        if (!g) continue;
        if (g.type && g.type !== ctype) continue;
        if (g.bucket && g.bucket !== bucket) continue;
        if (g.scope === 'region' && g.region !== regionId) continue;
        m *= g.mult;
      }
      return m;
    };
    const pushNeeded = (pkind, regionId) => {
      if (pkind === 'defend') {
        for (const f of activeEffects()) {
          const d = f.effect.defendCount;
          if (d && d.region === regionId) return d.count;
        }
      }
      return TUNING.PUSH_COUNT;
    };
    const hasFx = (key) => activeEffects().some(f => f.effect[key]);
    const raidPenaltyFor = (regionId) => {
      let p = TUNING.RAID_PENALTY;
      for (const f of activeEffects()) {
        if (!f.effect.raidPenaltyMult) continue;
        if (f.sweep && f.region === regionId) p *= f.effect.raidPenaltyMult;
        if (f.project) p *= f.effect.raidPenaltyMult;
      }
      return p;
    };
    const oreHeld = (ore) => {
      for (const r of Object.values(sys.regions))
        for (const [zid, zdef] of Object.entries(r.zones))
          if (state.zones[zid] && state.zones[zid].held && (zdef.ores || []).includes(ore)) return true;
      return false;
    };
    const projectCost = (proj) => {
      let mult = 1;
      for (const f of activeEffects()) {
        const d = f.effect.projectDiscount;
        if (d && (d.site === 'any' || (proj.site && d.site === proj.site))) mult *= d.mult;
      }
      const out = {};
      for (const [k, v] of Object.entries(proj.cost || {})) out[k] = Math.ceil(v * mult);
      return out;
    };
    const bandClearedNow = (bandId) => {
      if (bandId === 'light') return true;
      const sites = activeEffects().filter(f => f.effect.commissionSite).map(f => f.effect.commissionSite);
      if (bandId === 'medium') return sites.length > 0;
      if (bandId === 'heavy') return sites.includes('capital');
      return sites.includes('capital') && !!state.projectsDone['flagship-keel'];
    };
    const applyCommission = (fleetId, t) => {
      const f = state.fleet[fleetId];
      if (!f || f.status !== 'pledged') return false;
      const price = shipPrice(f.ship);
      if (price == null) return false;
      const band = bandFor(price);
      if (!bandClearedNow(band.id)) return false;
      if (state.chest.funds < price) return false;
      state.chest.funds -= price;
      f.status = 'ready';
      chron(t, 'fleet', `The org commissions ${dispR(f.by)}'s ${f.ship} — the ${band.label.toLowerCase()} wing grows.`);
      return true;
    };

    function recompute(zid) {
      const z = state.zones[zid];
      const zoneDef = sys.regions[z.region].zones[zid];
      const recipe = regions.archetypes[zoneDef.archetype].recipe;
      const filled =
        Math.min(z.cats.combat, recipe.combat) +
        Math.min(z.cats.supply, recipe.supply) +
        Math.min(z.cats.industry, recipe.industry);
      const control = Math.max(0, Math.min(TUNING.CAPTURE, filled - z.penalty));
      const wasHeld = z.held;
      z.control = control;
      z.held = control >= TUNING.CAPTURE;
      return { wasHeld, isHeld: z.held };
    }

    // ── Season endings (graded — the flagship is the grand slam, not the only exit)
    function evalEnding() {
      const held = Object.values(state.zones).filter(z => z.held).length;
      if (state.victory) return {
        id: 'triumph', tone: 'win', icon: '🏆', title: 'Triumph — the flagship flies',
        line: 'The org built its own capital ship out of a season of contracts — and flew its maiden voyage with all hands. Nothing left to prove.',
      };
      if (state.finaleReady) return {
        id: 'built', tone: 'win', icon: '🏗', title: 'The flagship waits — voyage unflown',
        line: 'Built, armed, ready — but the maiden voyage never mustered. The yard holds her for next season.',
      };
      if (held >= 9) return {
        id: 'dominion', tone: 'win', icon: '👑', title: 'Dominion — Stanton is held',
        line: `${held} zones under org colors at the close. No flagship — but nobody doubts who runs this system.`,
      };
      if (held >= 4) return {
        id: 'foothold', tone: 'honor', icon: '⚑', title: 'Foothold — real ground held',
        line: `${held} zones held at the close. Not the map, not the flagship — but a campaign worth building on.`,
      };
      if (held >= 1) return {
        id: 'survival', tone: 'honor', icon: '🛡', title: 'Survival — the org endures',
        line: `The Director pushed all season, and the org still flies its colors over ${held} zone${held === 1 ? '' : 's'}.`,
      };
      return {
        id: 'rout', tone: 'loss', icon: '💀', title: 'Rout — driven from the map',
        line: 'Nothing held at the close. The Director keeps Stanton — this time.',
      };
    }

    // ── The Director ──────────────────────────────────────────────────────
    // Moves are DERIVED at tick boundaries from (seed, tick, state, yesterday's
    // turnout) — never stored. Its demands are defend/relief pushes scored by
    // the same pushTally machinery as org pushes.
    const faction = (sys.directorFaction && sys.directorFaction.name) || 'Hostile elements';
    const dirMoves = [];

    // pure planner — used for the real move and for the intel telegraph preview
    function planDirector(k, actives) {
      if (!actives) return [];
      const ap = actives >= 8 ? 3 : actives >= 4 ? 2 : 1;
      const rand = rng(config.seed, k, 'director');
      const plans = [];
      // raid pool: anywhere the org has presence; held zones draw the most heat
      const pool = Object.entries(state.zones)
        .filter(([, z]) => z.control > 0)
        .flatMap(([zid, z]) => {
          let w = z.held ? 3 : z.control >= 50 ? 2 : 1;
          if (!z.held && heatSets[k - 1] && heatSets[k - 1].has(zid)) w *= TUNING.HEAT_RAID_MULT;
          return Array(w).fill(zid);
        });
      const raids = Math.min(ap === 3 ? 2 : 1, pool.length ? ap : 0);
      const hit = new Set();
      for (let i = 0; i < raids; i++) {
        const zid = pool[Math.floor(rand() * pool.length)];
        if (hit.has(zid)) continue;
        hit.add(zid);
        plans.push({ kind: 'raid', region: state.zones[zid].region, zone: zid });
      }
      // distraction: a relief call away from the org's focus regions
      if (ap >= 2 || plans.length === 0) {
        const focusRegions = new Set(Object.keys(state.fronts)
          .map(z => state.zones[z] && state.zones[z].region).filter(Boolean));
        let away = Object.keys(sys.regions).filter(rid =>
          !focusRegions.has(rid) && sys.regions[rid].availability.hauling !== 'none');
        if (!away.length) away = Object.keys(sys.regions).filter(rid => sys.regions[rid].availability.hauling !== 'none');
        if (away.length) {
          const rid = away[Math.floor(rand() * away.length)];
          plans.push({ kind: 'distract', region: rid, zone: sys.regions[rid].anchor });
        }
      }
      return plans;
    }

    function generateDirector(k) {
      const actives = (activeSets[k - 1] && activeSets[k - 1].size) || 0;
      for (const plan of planDirector(k, actives)) {
        const pkind = plan.kind === 'raid' ? 'defend' : 'relief';
        const move = {
          tick: k, kind: plan.kind, region: plan.region, zone: plan.zone,
          pushId: `p${k}:${plan.region}:${pkind}:${plan.zone}`,
          deadline: config.startedAt + (k + 1) * TUNING.DAY_MS, status: 'pending',
        };
        dirMoves.push(move);
        const zn = sys.regions[plan.region].zones[plan.zone].name;
        const rn = sys.regions[plan.region].name;
        const t = config.startedAt + k * TUNING.DAY_MS;
        if (plan.kind === 'raid') {
          chron(t, 'threat', `⚠ Pressure is mounting on ${zn} — ${faction} are likely behind it. ${TUNING.PUSH_COUNT} combat contracts in ${rn} space before day's end will break it.`);
        } else {
          chron(t, 'threat', `⚠ A relief call from ${rn}: convoys are going missing — likely ${faction} work. ${TUNING.PUSH_COUNT} hauling contracts there would shore it up.`);
        }
      }
    }

    function resolveDirector(k) {
      for (const move of dirMoves) {
        if (move.tick !== k || move.status !== 'pending') continue;
        const pkind = move.kind === 'raid' ? 'defend' : 'relief';
        const answered = (pushTally[move.pushId] || 0) >= pushNeeded(pkind, move.region);
        const zn = sys.regions[move.region].zones[move.zone].name;
        const rn = sys.regions[move.region].name;
        if (move.kind === 'raid') {
          if (answered) {
            move.status = 'repelled';
            chron(move.deadline, 'repelled', `${zn} stands — the pressure broke against a wall of contracts.`);
          } else {
            move.status = 'suffered';
            const z = state.zones[move.zone];
            const penalty = raidPenaltyFor(move.region);
            z.penalty += penalty;
            const { wasHeld, isHeld } = recompute(move.zone);
            chron(move.deadline, 'lost', `The threat at ${zn} went unanswered — control slips (−${penalty}%).`);
            if (wasHeld && !isHeld) chron(move.deadline, 'lost', `${zn} slips from the org's grip.`);
          }
        } else {
          if (answered) {
            move.status = 'answered';
            for (const [mat, amt] of Object.entries(TUNING.DISTRACT_REWARD)) state.chest[mat] += amt;
            chron(move.deadline, 'answered', `Relief reached ${rn} — the convoys got through. The HQ stores grow.`);
          } else {
            move.status = 'ignored';
            if (hasFx('distractImmune')) {
              chron(move.deadline, 'answered', `The ${rn} relief call lapsed — Cold Storage absorbed the loss.`);
            } else {
              for (const [mat, amt] of Object.entries(TUNING.DISTRACT_COST)) state.chest[mat] = Math.max(0, state.chest[mat] - amt);
              chron(move.deadline, 'lost', `The ${rn} relief call went unanswered — the HQ stores bleed.`);
            }
          }
        }
      }
    }

    // process tick boundaries up to (not beyond) time `until`:
    // resolve the closing day's threats, pay held yields, derive the new day's moves.
    // The loop stops at the season's end — an early flagship triumph ends it too.
    // a STAGED campaign musters first: the clock is unarmed until leadership
    // fires season.start — that moment becomes day 1 for everyone
    let nextBoundary = null, seasonEndMs = null;
    const armClock = (t0) => {
      config.startedAt = t0;
      nextBoundary = t0 + TUNING.DAY_MS;
      seasonEndMs = t0 + config.seasonDays * TUNING.DAY_MS;
    };
    if (config.staged) config.startedAt = null; else armClock(create.t);
    function advanceTicks(until) {
      if (nextBoundary == null) return;
      while (nextBoundary <= until && nextBoundary <= seasonEndMs && !state.victory) {
        const closing = Math.round((nextBoundary - config.startedAt) / TUNING.DAY_MS) - 1;
        resolveDirector(closing);
        // daily incomes: every held zone funds the treasury; powers add materials
        const fx = activeEffects();
        const incomeBonus = fx.filter(f => f.sweep && f.effect.incomeBonus)
          .reduce((n, f) => n + f.effect.incomeBonus, 0);
        for (const z of Object.values(state.zones)) if (z.held) state.chest.funds += TUNING.HELD_FUNDS_PER_TICK;
        for (const f of fx) {
          if (!f.effect.income) continue;
          for (const [mat, amt] of Object.entries(f.effect.income)) {
            state.chest[mat] += amt + (mat !== 'funds' && !f.sweep ? incomeBonus : 0);
          }
        }
        const od = orgDayByTick[closing];
        if (od && od.drag && !od.drag.met) {
          state.chest.funds = Math.max(0, state.chest.funds - TUNING.ORGDAY_DRAG_PENALTY);
          chron(nextBoundary - 1, 'lost',
            `The ${sys.regions[od.drag.region].name} convoys went unanswered while the org mustered — the HQ stores bleed.`);
        }
        if (od && !od.unlocked && !state.spUnlocked[od.region]) {
          chron(nextBoundary - 1, 'target',
            `The Org Day closes short — ${heroName(sys.regions[od.region].setPiece)} stays locked. Call another when the org is ready.`);
        }
        if (closing + 1 < config.seasonDays) {
          generateDirector(closing + 1);
        } else {
          const e = evalEnding();
          chron(seasonEndMs - 1, 'end', `The season closes. ${e.icon} ${e.title}.`);
        }
        nextBoundary += TUNING.DAY_MS;
      }
    }
    // once the season is closed, the board is a monument — gameplay events freeze
    const seasonClosedAt = (t) => seasonEndMs != null && (t >= seasonEndMs || (state.victory && t > state.victory.at));
    // while mustering, only enlistment folds — the war waits for the gun
    const MUSTER_OK = { 'campaign.create': 1, 'member.join': 1, 'fleet.pledge': 1, 'fleet.unpledge': 1, 'role.approver': 1, 'season.start': 1 };

    const member = (name, t) => {
      if (!state.members[name]) {
        state.members[name] = { joined: t, display: name, total: 0, onSite: 0, pushed: 0, setPieces: 0, finale: 0, tallies: {}, calling: null, lineTiers: {}, rideOverride: null };
      }
      return state.members[name];
    };
    // pretty name for the chronicle — the key is lowercase, people aren't
    const dispR = (k) => (state.members[k] && state.members[k].display) || k;
    // promotion threshold: the calling line got tier 1 free at join
    const rideNeeded = (m0, line, tier) => (tier - (line === m0.calling ? 1 : 0)) * TUNING.RIDE_THRESHOLD;
    const lineCount = (m0, line) => LINE_TYPES[line].reduce((n, t2) => n + (m0.tallies[t2] || 0), 0);
    // every rental ship a member can use: all unlocked tiers of every line,
    // adjusted by the swap ledger (access trades between members)
    const hangarShips = (name) => {
      const m0 = state.members[name];
      if (!m0) return [];
      const out = [];
      for (const [line, tier] of Object.entries(m0.lineTiers)) {
        for (let t2 = 1; t2 <= tier; t2++) {
          const r = rideFor(name, line, t2);
          if (r && !out.includes(r.name)) out.push(r.name);
        }
      }
      for (const s of state.swaps) {
        if (s.from === name) {
          const i = out.indexOf(s.ship);
          if (i >= 0) out.splice(i, 1);
        }
        if (s.to === name && !out.includes(s.ship)) out.push(s.ship);
      }
      return out;
    };
    const applyRideUnlock = (name, line, tier, t, requisition) => {
      const m0 = state.members[name];
      if (!m0 || !LINE_TYPES[line]) return false;
      if (tier !== (m0.lineTiers[line] || 0) + 1 || tier > 4) return false;
      // a requisition buys the ENTRY hull of a trade the org can't otherwise
      // fly — it skips the contract threshold, never the bill, and never
      // reaches past tier 1 (the promotion ladder above it is untouched)
      if (requisition ? tier !== 1 : lineCount(m0, line) < rideNeeded(m0, line, tier)) return false;
      const ride = rideFor(name, line, tier);
      const fee = rideFee(ride);
      if (!ride || fee == null || state.chest.funds < fee) return false;
      state.chest.funds -= fee;
      m0.lineTiers[line] = tier;
      chron(t, 'fleet', requisition
        ? `${dispR(name)} requisitions a ${ride.name} — collect it at ${ride.city}.`
        : `${dispR(name)} is issued a ${ride.name} — collect it at ${ride.city}.`);
      return true;
    };

    for (const ev of sorted) {
      if (ev.t > now) break;
      advanceTicks(ev.t);
      if (ev.k !== 'campaign.create' && ev.k !== 'season.next' && seasonClosedAt(ev.t)) { state.skipped++; continue; }
      if (config.startedAt == null && !MUSTER_OK[ev.k]) { state.skipped++; continue; }
      // spectators watch — nothing they do folds (defense in depth behind the UI)
      if (state.spectators[ev.a] && ev.k !== 'member.join') { state.skipped++; continue; }
      const p = ev.p || {};

      switch (ev.k) {
        case 'campaign.create':
          if (!state.approvers.includes(ev.a)) state.approvers.push(ev.a);
          chron(ev.t, 'start', config.staged
            ? `Campaign "${config.name || 'Unnamed'}" musters — join up, pledge ships. The season starts when leadership fires the gun.`
            : `Campaign "${config.name || 'Unnamed'}" opens — the ${config.system} theater.`);
          break;

        case 'season.start': {
          // the starting gun: this very moment becomes day 1
          if (!config.staged || config.startedAt != null || !state.approvers.includes(ev.a)) { state.skipped++; break; }
          armClock(ev.t);
          chron(ev.t, 'start', `🚀 The season begins — ${config.seasonDays} days on the clock. Good hunting.`);
          break;
        }

        case 'season.next': {
          // the org moves camp: a closed campaign points everyone at its successor
          if (!state.approvers.includes(ev.a) || !p.code || state.nextSeason) { state.skipped++; break; }
          if (!seasonClosedAt(ev.t)) { state.skipped++; break; }
          state.nextSeason = { code: String(p.code), by: ev.a, at: ev.t };
          chron(ev.t, 'end', `A new season is called — the org moves camp. One click in the war room takes you there.`);
          break;
        }

        case 'member.join': {
          const name = p.callsign || ev.a;
          const m0 = member(name, ev.t);
          if (p.display && m0.display === name) m0.display = p.display; // first-typed spelling wins
          if (p.calling && LINE_TYPES[p.calling] && !m0.calling) {
            m0.calling = p.calling;
            m0.lineTiers[p.calling] = 1;
            const issued = rideFor(name, p.calling, 1);
            chron(ev.t, 'join', issued
              ? `${m0.display} joins the campaign — the org issues their ${issued.name} (collect at ${issued.city}).`
              : `${m0.display} joins the campaign.`);
          } else {
            chron(ev.t, 'join', `${m0.display} joins the campaign.`);
          }
          break;
        }

        case 'role.approver': {
          if (!state.approvers.includes(ev.a) || !p.callsign) { state.skipped++; break; }
          if (p.grant === false) {
            if (p.callsign === state.approvers[0]) { state.skipped++; break; } // creator stays
            if (state.approvers.includes(p.callsign)) chron(ev.t, 'join', `${dispR(p.callsign)} is no longer an approver.`);
            state.approvers = state.approvers.filter(x => x !== p.callsign);
          } else if (!state.approvers.includes(p.callsign)) {
            state.approvers.push(p.callsign);
            chron(ev.t, 'join', `${dispR(p.callsign)} is now an approver.`);
          }
          break;
        }

        case 'role.spectator': {
          // approver-only: flip an invited member to eyes-only and back.
          // Approvers (and the founder) can't be spectated — demote them first.
          if (!state.approvers.includes(ev.a) || !p.callsign || !state.members[p.callsign]) { state.skipped++; break; }
          if (p.grant === false) {
            if (!state.spectators[p.callsign]) { state.skipped++; break; }
            delete state.spectators[p.callsign];
            chron(ev.t, 'join', `${dispR(p.callsign)} returns to active duty.`);
          } else {
            if (state.approvers.includes(p.callsign) || state.spectators[p.callsign]) { state.skipped++; break; }
            state.spectators[p.callsign] = true;
            chron(ev.t, 'join', `${dispR(p.callsign)} is now a spectator — eyes only.`);
          }
          break;
        }

        case 'report.config': {
          // approver-only: wire (or cut) the daily battle report. The webhook
          // lives in the shared log — visible to code-holders, never the public.
          if (!state.approvers.includes(ev.a)) { state.skipped++; break; }
          if (p.clear) {
            if (!state.report) { state.skipped++; break; }
            state.report = null;
            chron(ev.t, 'start', 'Battle reports disconnected.');
            break;
          }
          const hook = String(p.webhook || '');
          if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(hook)) { state.skipped++; break; }
          state.report = { by: ev.a, at: ev.t, webhook: hook };
          chron(ev.t, 'start', 'Daily battle reports wired to the org\'s Discord.');
          break;
        }

        case 'ride.unlock': {
          const m0 = state.members[ev.a];
          if (!m0) { state.skipped++; break; }
          const ride = rideFor(ev.a, p.line, p.tier);
          const fee = rideFee(ride);
          if (fee != null && fee > TUNING.APPROVAL_LIMIT && !state.approvers.includes(ev.a)) { state.skipped++; break; }
          if (!applyRideUnlock(ev.a, p.line, p.tier, ev.t)) state.skipped++;
          break;
        }

        case 'ride.requisition': {
          // any member, any trade's entry hull, paid from ORG funds. No capture
          // gate and no contract threshold: this is the floor that stops an org
          // stalling because nobody owns a cargo hold or a mining head.
          if (!state.members[ev.a]) { state.skipped++; break; }
          if (!applyRideUnlock(ev.a, p.line, 1, ev.t, true)) state.skipped++;
          break;
        }

        case 'exchange.propose': {
          // a trade: I give one of my ships, I take one of yours — you decide
          const { reqId, to, give, take } = p;
          if (!reqId || state.proposals[reqId] || !to || to === ev.a || !state.members[to]) { state.skipped++; break; }
          if (Object.values(state.proposals).some(pr => pr.from === ev.a && pr.status === 'pending')) { state.skipped++; break; }
          if (!hangarShips(ev.a).includes(give) || !hangarShips(to).includes(take)) { state.skipped++; break; }
          state.proposals[reqId] = { from: ev.a, to, give, take, at: ev.t, status: 'pending' };
          break;
        }

        case 'exchange.accept':
        case 'exchange.decline': {
          const pr = state.proposals[p.reqId];
          if (!pr || pr.status !== 'pending' || pr.to !== ev.a) { state.skipped++; break; }
          if (ev.k === 'exchange.decline') { pr.status = 'declined'; break; }
          if (!hangarShips(pr.from).includes(pr.give) || !hangarShips(pr.to).includes(pr.take)) {
            pr.status = 'declined';
            state.skipped++;
            break;
          }
          state.swaps.push({ from: pr.from, to: pr.to, ship: pr.give });
          state.swaps.push({ from: pr.to, to: pr.from, ship: pr.take });
          pr.status = 'accepted';
          chron(ev.t, 'fleet', `${dispR(pr.from)} and ${dispR(pr.to)} swap ships — ${pr.give} for ${pr.take}.`);
          break;
        }

        case 'request.create': {
          if (!p.reqId || state.requests[p.reqId] || !['ride', 'exchange', 'commission'].includes(p.kind)) { state.skipped++; break; }
          if (Object.values(state.requests).some(r => r.by === ev.a && r.kind === p.kind && r.status === 'pending')) { state.skipped++; break; }
          state.requests[p.reqId] = { by: ev.a, at: ev.t, kind: p.kind, payload: p.payload || {}, status: 'pending' };
          break;
        }

        case 'request.approve':
        case 'request.deny': {
          const r = state.requests[p.reqId];
          if (!r || r.status !== 'pending' || !state.approvers.includes(ev.a)) { state.skipped++; break; }
          if (ev.k === 'request.deny') { r.status = 'denied'; r.decidedBy = ev.a; break; }
          let ok = false;
          if (r.kind === 'commission') ok = applyCommission(r.payload.fleetId, ev.t);
          else if (r.kind === 'ride') ok = applyRideUnlock(r.by, r.payload.line, r.payload.tier, ev.t);
          else if (r.kind === 'exchange' && r.payload.ship && state.members[r.by]) {
            // a hull assignment must point at a hull that's actually in service
            const fx = r.payload.fleetId != null ? state.fleet[r.payload.fleetId] : null;
            if (r.payload.fleetId != null && (!fx || fx.status !== 'ready')) { state.skipped++; break; }
            state.members[r.by].rideOverride = { ship: r.payload.ship, fleetId: r.payload.fleetId != null ? r.payload.fleetId : null };
            chron(ev.t, 'fleet', `${dispR(r.by)}'s exchange is approved — they now fly a ${r.payload.ship}.`);
            ok = true;
          }
          if (ok) { r.status = 'approved'; r.decidedBy = ev.a; } else state.skipped++;
          break;
        }

        case 'target.set':   // legacy alias for front.add
        case 'front.add': {
          const zid = p.zone;
          if (!state.zones[zid] || state.zones[zid].held) { state.skipped++; break; }
          if (state.fronts[zid]) break; // no-op
          if (Object.keys(state.fronts).length >= TUNING.FRONT_CAP) { state.skipped++; break; }
          state.fronts[zid] = { by: ev.a, at: ev.t };
          const zn = sys.regions[state.zones[zid].region].zones[zid].name;
          chron(ev.t, 'target', `${dispR(ev.a)} adds ${zn} to the front lines.`);
          break;
        }

        case 'front.remove': {
          const f2 = state.fronts[p.zone];
          if (!f2) { state.skipped++; break; }
          // the adder may pull it same-day; anyone may after the day rolls or once held
          const sameDay = tickOf(f2.at) === tickOf(ev.t);
          if (sameDay && f2.by !== ev.a && !state.zones[p.zone].held) { state.skipped++; break; }
          delete state.fronts[p.zone];
          const zn2 = sys.regions[state.zones[p.zone].region].zones[p.zone].name;
          chron(ev.t, 'target', `${dispR(ev.a)} pulls ${zn2} off the front lines.`);
          break;
        }

        case 'orgday.declare': {
          // the org leader rallies everyone at one region — today or a planned day
          const rdef = sys.regions[p.region];
          const tk = tickOf(ev.t);
          const day = p.day == null ? tk : p.day;
          if (!rdef || !rdef.setPiece || !state.approvers.includes(ev.a)) { state.skipped++; break; }
          if (state.setPieces[p.region] || state.spUnlocked[p.region]) { state.skipped++; break; }
          if (!Number.isInteger(day) || day < tk || day >= config.seasonDays) { state.skipped++; break; }
          if (orgDayByTick[day]) { state.skipped++; break; }   // one Org Day per day
          orgDayByTick[day] = { region: p.region, by: ev.a, at: ev.t, count: 0, unlocked: false };
          chron(ev.t, 'target', day === tk
            ? `📣 ${dispR(ev.a)} calls an Org Day — all wings to ${rdef.name} space. ` +
              `${TUNING.ORGDAY_TARGET} contracts there today clear the path to ${heroName(rdef.setPiece)}.`
            : `📣 ${dispR(ev.a)} schedules an Org Day — all wings to ${rdef.name} space on day ${day + 1}. ` +
              `${TUNING.ORGDAY_TARGET} contracts there that day clear the path to ${heroName(rdef.setPiece)}.`);
          break;
        }

        case 'orgday.cancel': {
          // leadership may call off a PLANNED day — a running day stands
          const d = p.day;
          if (!state.approvers.includes(ev.a) || !Number.isInteger(d) ||
              !orgDayByTick[d] || d <= tickOf(ev.t)) { state.skipped++; break; }
          chron(ev.t, 'target', `The day-${d + 1} Org Day (${sys.regions[orgDayByTick[d].region].name} space) is called off.`);
          delete orgDayByTick[d];
          break;
        }

        case 'setpiece.done': {
          // the org ran a region's set-piece op together — once per season, and
          // only after an Org Day cleared the path to it.
          // Surge lands on the region's front zone (else its closest-to-taken zone):
          // fill the recipe buckets toward their caps, then heal raid scars.
          const rdef = sys.regions[p.region];
          const spId = rdef && rdef.setPiece;
          if (!spId || !state.approvers.includes(ev.a)) { state.skipped++; break; }
          if (!state.spUnlocked[p.region]) { state.skipped++; break; }
          const parts = [...new Set([ev.a].concat(Array.isArray(p.participants) ? p.participants : []))]
            .filter(n => state.members[n]);
          const prior = state.setPieces[p.region];
          if (prior) {
            // encore runs: medals and glory — the surge only fires once a season
            prior.runs = (prior.runs || 1) + 1;
            for (const n of parts) member(n, ev.t).setPieces++;
            chron(ev.t, 'push', `🌟 The org runs ${heroName(spId)} again — the legend grows.`);
            break;
          }
          const zonesIn = Object.keys(rdef.zones).filter(z => state.zones[z]);
          const frontIn = zonesIn.filter(z => state.fronts[z]);
          const pickFrom = frontIn.length ? frontIn : zonesIn.filter(z => !state.zones[z].held);
          let target = null, best = -1;
          for (const z of pickFrom) if (state.zones[z].control > best) { best = state.zones[z].control; target = z; }
          const hn = heroName(spId);
          if (target) {
            const zdef = rdef.zones[target];
            const recipe = regions.archetypes[zdef.archetype].recipe;
            let left = TUNING.SETPIECE_SURGE;
            for (const b of ['combat', 'supply', 'industry']) {
              const add = Math.min(Math.max(0, recipe[b] - state.zones[target].cats[b]), left);
              state.zones[target].cats[b] += add;
              left -= add;
              if (!left) break;
            }
            if (left && state.zones[target].penalty > 0) {
              const heal = Math.min(left, state.zones[target].penalty);
              state.zones[target].penalty -= heal;
              left -= heal;
            }
            const { wasHeld, isHeld } = recompute(target);
            const zn3 = rdef.zones[target].name;
            chron(ev.t, 'push', `🌟 The org runs ${hn} — ${zn3} surges +${TUNING.SETPIECE_SURGE - left}% control.`);
            if (!wasHeld && isHeld) {
              chron(ev.t, 'capture', `${zn3} is taken — the org holds it.`);
              delete state.fronts[target];
            }
          } else {
            chron(ev.t, 'push', `🌟 The org runs ${hn} — ${rdef.name} space is already swept; the story goes in the log.`);
          }
          for (const n of parts) member(n, ev.t).setPieces++;
          state.setPieces[p.region] = { at: ev.t, tick: tickOf(ev.t), by: ev.a, participants: parts, hero: spId, zone: target, runs: 1 };
          break;
        }

        case 'finale.done': {
          // the maiden voyage: the flagship's first flight, all hands — season won
          if (!state.finaleReady || state.victory || !state.approvers.includes(ev.a)) { state.skipped++; break; }
          const parts = [...new Set([ev.a].concat(Array.isArray(p.participants) ? p.participants : []))]
            .filter(n => state.members[n]);
          for (const n of parts) member(n, ev.t).finale++;
          state.victory = { at: ev.t, project: state.finaleReady.project, voyage: parts };
          chron(ev.t, 'victory', `🏆 The maiden voyage flies — ${parts.length} aboard. The season is won.`);
          break;
        }

        case 'contract.done': {
          const hit = state.zones[p.zone];
          const bucket = regions.typeBuckets[p.ctype];
          if (!hit || hit.region !== p.region || !bucket) { state.skipped++; break; }
          const mult = availabilityMult(regions, config.system, p.region, p.ctype);
          if (mult === 0) { state.skipped++; break; }

          const onSiteOk = !!p.onSite && zoneOnSiteTypes(regions, config.system, p.region, p.zone).includes(p.ctype);
          // mining follows the front: control credit only at contested zones.
          // salvage is exempt — it lives at Lagrange points nobody controls.
          const industryGated = p.ctype === 'mining' && hit.control <= 0;
          // off-front work counts flat +1, no bonuses; the Director's demands
          // (defend/relief) always count in full wherever they point
          const pm = p.pushId ? PUSH_ID_RE.exec(p.pushId) : null;
          const pmValid = !!(pm && +pm[1] === tickOf(ev.t) && pm[2] === p.region && pm[4] === p.zone &&
            PUSH_KIND[pm[3]].bucket === bucket);
          const directorWork = pmValid && !PUSH_KIND[pm[3]].org;
          const onFront = !!state.fronts[p.zone] || directorWork;
          const gain = onFront
            ? TUNING.BASE_GAIN * mult * (onSiteOk ? TUNING.ONSITE_MULT : 1) * gainMultFor(p.ctype, bucket, p.region)
            : TUNING.OFF_FRONT_GAIN;

          if (bucket === 'intel') {
            state.chest.intel += TUNING.MATERIAL_PER_CONTRACT;
          } else if (!industryGated) {
            hit.cats[bucket] += gain;
            // mining hot ground draws tomorrow's raids
            if (p.ctype === 'mining' && !hit.held) {
              (heatSets[tickOf(ev.t)] = heatSets[tickOf(ev.t)] || new Set()).add(p.zone);
            }
          }
          state.chest.funds += TUNING.FUNDS_PER_CONTRACT;

          // push scoring: a tagged completion must match the push's tick, region,
          // zone and bucket; the Nth one banks the completion bonus
          if (pmValid && bucket !== 'intel' && !industryGated) {
            const needed = pushNeeded(pm[3], p.region);
            const n = (pushTally[p.pushId] = (pushTally[p.pushId] || 0) + 1);
            if (n === needed) {
              hit.cats[bucket] += TUNING.PUSH_BONUS;
              state.chest.funds += TUNING.PUSH_FUNDS_BONUS;
              chron(ev.t, 'push', `Objective complete — ${PUSH_KIND[pm[3]].label} ${sys.regions[p.region].zones[p.zone].name}: +${TUNING.PUSH_BONUS}% ${bucket}.`);
            }
          }
          if (CHEST_BUCKET[p.ctype] && bucket !== 'intel') {
            state.chest[CHEST_BUCKET[p.ctype]] += TUNING.MATERIAL_PER_CONTRACT;
          }

          const m = member(ev.a, ev.t);
          m.total++;
          m.tallies[p.ctype] = (m.tallies[p.ctype] || 0) + 1;
          if (onSiteOk && onFront) m.onSite++;
          if (p.pushId) m.pushed++;
          if (p.claimId && state.claims[p.claimId] && state.claims[p.claimId].by === ev.a &&
              state.claims[p.claimId].status === 'active') {
            state.claims[p.claimId].status = 'done';
            state.claims[p.claimId].doneAt = ev.t;
          }
          (activeSets[tickOf(ev.t)] = activeSets[tickOf(ev.t)] || new Set()).add(ev.a);

          // an Org Day counts every mission flown in its region, whatever the type —
          // and the Director fights the muster: a confrontation extends the path,
          // and a drag-away feint tries to pull wings off to another region
          const od2 = orgDayByTick[tickOf(ev.t)];
          if (od2 && od2.drag && !od2.drag.met && od2.drag.region === p.region && p.ctype === 'hauling') {
            od2.drag.done++;
            if (od2.drag.done >= od2.drag.need) {
              od2.drag.met = true;
              chron(ev.t, 'answered', `The ${sys.regions[od2.drag.region].name} convoys got through — the feint collapses.`);
            }
          }
          if (od2 && od2.region === p.region && !state.spUnlocked[p.region]) {
            od2.count++;
            if (od2.count === TUNING.ORGDAY_CONFRONT_AT) {
              od2.extra = (od2.extra || 0) + TUNING.ORGDAY_CONFRONT_ADD;
              chron(ev.t, 'threat', `⚔ Pickets are massing over ${sys.regions[p.region].name} space — ${faction} are likely behind it. ` +
                `The path to ${heroName(sys.regions[p.region].setPiece)} needs ${TUNING.ORGDAY_CONFRONT_ADD} more contracts.`);
            }
            if (od2.count === TUNING.ORGDAY_DRAG_AT && !od2.drag) {
              const randD = rng(config.seed, tickOf(ev.t), 'orgday-drag');
              const others = Object.keys(sys.regions).filter(r => r !== p.region && sys.regions[r].availability.hauling !== 'none');
              if (others.length) {
                od2.drag = { region: others[Math.floor(randD() * others.length)], need: TUNING.ORGDAY_DRAG_NEED, done: 0, met: false };
                chron(ev.t, 'threat', `⚠ Convoys are going missing out in ${sys.regions[od2.drag.region].name} space — likely ${faction} work, ` +
                  `timed to pull the org apart. ${TUNING.ORGDAY_DRAG_NEED} hauling contracts there before day's end, or the HQ stores bleed.`);
              }
            }
            if (od2.count === TUNING.ORGDAY_TARGET + (od2.extra || 0)) {
              od2.unlocked = true;
              state.spUnlocked[p.region] = true;
              chron(ev.t, 'push', `🌟 The path is clear — ${heroName(sys.regions[p.region].setPiece)} is unlocked. Run it together; your organizer records it once it's done.`);
              // a plan for a now-open path is moot — free those days up
              for (const [d, o] of Object.entries(orgDayByTick))
                if (+d > tickOf(ev.t) && o.region === p.region) delete orgDayByTick[d];
            }
          }

          const { wasHeld, isHeld } = recompute(p.zone);
          const zn = sys.regions[p.region].zones[p.zone].name;
          if (!wasHeld && isHeld) {
            chron(ev.t, 'capture', `${zn} is taken — the org holds it.`);
            delete state.fronts[p.zone]; // captured: the front slot frees itself
          }
          if (wasHeld && !isHeld) chron(ev.t, 'lost', `${zn} slips from the org's grip.`);
          break;
        }

        case 'fleet.pledge': {
          state.fleet.push({ id: state.fleet.length, ship: p.ship, by: ev.a, status: 'pledged' });
          chron(ev.t, 'fleet', `${dispR(ev.a)} pledges a ${p.ship} to the org census.`);
          break;
        }

        case 'fleet.unpledge': {
          // it's the owner's real ship — they can take it back at ANY stage.
          // A commissioned hull leaves service (assignments clear, the org's
          // commissioning spend is not refunded). Entries are marked withdrawn,
          // never removed — hull ids stay stable forever.
          const f = state.fleet.find(x => x.by === ev.a && x.ship === p.ship && x.status !== 'withdrawn');
          if (!f) { state.skipped++; break; }
          const inService = f.status !== 'pledged';
          f.status = 'withdrawn';
          for (const m of Object.values(state.members)) {
            if (m.rideOverride && m.rideOverride.fleetId === f.id) m.rideOverride = null;
          }
          chron(ev.t, 'fleet', inService
            ? `${dispR(ev.a)} withdraws their ${p.ship} — the hull leaves org service.`
            : `${dispR(ev.a)} withdraws their ${p.ship} from the census.`);
          break;
        }

        case 'fleet.commission': {
          // commissioning spends real prices — approvers only; others file a request
          if (!state.approvers.includes(ev.a)) { state.skipped++; break; }
          if (!applyCommission(p.fleetId, ev.t)) state.skipped++;
          break;
        }

        case 'fleet.lost': {
          const f = state.fleet[p.fleetId];
          if (!f || f.status !== 'ready') { state.skipped++; break; }
          f.status = 'lost';
          chron(ev.t, 'fleet', `${dispR(f.by)}'s ${f.ship} is lost${p.note ? ' — ' + p.note : ''}. Clearance suspended until recommissioned.`);
          break;
        }

        case 'contract.claim': {
          // one active (unexpired) claim per member; claimed slots leave the pool
          if (!p.claimId || state.claims[p.claimId]) { state.skipped++; break; }
          const mine = Object.values(state.claims).some(c =>
            c.by === ev.a && c.status === 'active' && ev.t - c.at <= TUNING.CLAIM_TTL_MS);
          if (mine) { state.skipped++; break; }
          state.claims[p.claimId] = {
            by: ev.a, at: ev.t, pushId: p.pushId || null, ctype: p.ctype,
            region: p.region, zone: p.zone, roll: p.roll || null, status: 'active',
          };
          break;
        }

        case 'contract.abandon': {
          const c = state.claims[p.claimId];
          if (!c || c.status !== 'active' || c.by !== ev.a) { state.skipped++; break; }
          c.status = 'returned';
          break;
        }

        case 'project.complete': {
          const proj = projects && projects.projects && projects.projects[p.id];
          if (!proj || state.projectsDone[p.id]) { state.skipped++; break; }
          if (proj.after && !state.projectsDone[proj.after]) { state.skipped++; break; }
          if (proj.site && !activeEffects().some(f => f.effect.commissionSite === proj.site)) { state.skipped++; break; }
          if (proj.needsOres && !proj.needsOres.every(oreHeld)) { state.skipped++; break; }
          const cost = projectCost(proj);
          if (Object.entries(cost).some(([k, v]) => (state.chest[k] || 0) < v)) { state.skipped++; break; }
          for (const [k, v] of Object.entries(cost)) state.chest[k] -= v;
          state.projectsDone[p.id] = { at: ev.t, by: ev.a };
          chron(ev.t, 'project', `Project complete — ${proj.name}.`);
          if (proj.grant && proj.grant.victory) {
            state.finaleReady = { at: ev.t, project: p.id };
            chron(ev.t, 'victory', `🏆 ${proj.grant.text}`);
            chron(ev.t, 'victory', `One flight remains — the maiden voyage. All hands aboard, and the season is won.`);
          }
          break;
        }

        case 'chest.convert': {
          const MATS = ['metals', 'components', 'supplies'];
          const ok = hasFx('convert') && MATS.includes(p.from) && MATS.includes(p.to) &&
            p.from !== p.to && Number.isFinite(p.amount) && p.amount > 0 && state.chest[p.from] >= p.amount;
          if (!ok) { state.skipped++; break; }
          state.chest[p.from] -= p.amount;
          state.chest[p.to] += p.amount;
          break;
        }

        case 'fleet.recommission': {
          const f = state.fleet[p.fleetId];
          if (!f || f.status !== 'lost') { state.skipped++; break; }
          const price = shipPrice(f.ship);
          if (price == null) { state.skipped++; break; }
          let bill = Math.ceil(price * TUNING.RECOMMISSION_FRAC);
          if (p.salvaged) bill = Math.ceil(bill * TUNING.SALVAGE_DISCOUNT);
          if (state.chest.funds < bill) { state.skipped++; break; }
          state.chest.funds -= bill;
          f.status = 'ready';
          chron(ev.t, 'fleet', `${dispR(f.by)}'s ${f.ship} returns to the line${p.salvaged ? ' — the wreck salvage cut the bill' : ''}.`);
          break;
        }

        default:
          state.skipped++;
      }
    }

    advanceTicks(now);
    state.tick = tickOf(now);
    for (const [tk, set] of Object.entries(activeSets)) state.activeByTick[tk] = set.size;

    // director exposure: today's pending threats become pushes, ahead of org offers
    const activeMoves = dirMoves.filter(m => m.tick === state.tick && m.status === 'pending');
    const threatPushes = activeMoves.map(m => {
      const pkind = m.kind === 'raid' ? 'defend' : 'relief';
      const def = PUSH_KIND[pkind];
      const region = sys.regions[m.region];
      const types = def.types.filter(t => region.availability[t] && region.availability[t] !== 'none');
      const tallied = pushTally[m.pushId] || 0;
      const needed = pushNeeded(pkind, m.region);
      return {
        id: m.pushId, kind: pkind, label: def.label, bucket: def.bucket,
        region: m.region, zone: m.zone, types, count: needed,
        done: Math.min(tallied, needed), completed: tallied >= needed,
        scarce: false, bonus: TUNING.PUSH_BONUS, expiresAt: m.deadline,
        director: true, faction,
        stake: m.kind === 'raid' ? `−${TUNING.RAID_PENALTY}% control if ignored` : 'the war chest bleeds if ignored',
      };
    });
    const mustering = config.startedAt == null;
    const seasonOver = !mustering && (now >= seasonEndMs || !!state.victory);
    state.pushes = seasonOver || mustering ? [] : threatPushes.concat(derivePushes(regions, sys, config, state, state.tick, pushTally));
    const odNow = orgDayByTick[state.tick];
    state.orgDay = !seasonOver && !mustering && odNow
      ? Object.assign({ target: TUNING.ORGDAY_TARGET + (odNow.extra || 0) }, odNow)
      : null;
    state.orgDays = {};
    for (const [d, o] of Object.entries(orgDayByTick)) state.orgDays[d] = { region: o.region, by: o.by, count: o.count, unlocked: o.unlocked };
    state.season = {
      over: seasonOver,
      mustering,
      endsAt: seasonEndMs,
      daysPlayed: mustering ? 0 : Math.min(state.tick + 1, config.seasonDays),
      ending: seasonOver ? evalEnding() : null,
      heldZones: Object.entries(state.zones).filter(([, z]) => z.held).map(([id]) => id),
    };
    // effective claim status (expiry is derived, never written) + per-push claimed slots
    for (const c of Object.values(state.claims)) {
      c.effective = c.status === 'active' && now - c.at > TUNING.CLAIM_TTL_MS ? 'expired' : c.status;
    }
    for (const p2 of state.pushes) {
      p2.claimed = Object.values(state.claims).filter(c => c.pushId === p2.id && c.effective === 'active').length;
    }
    state.powers = [];
    for (const [rid, r] of Object.entries(sys.regions)) {
      for (const [zid, zdef] of Object.entries(r.zones)) {
        if (zdef.power) state.powers.push({ zone: zid, region: rid, name: zdef.power.name, text: zdef.power.text, active: state.zones[zid].held });
      }
      if (r.regionPower) {
        const swept = Object.keys(r.zones).every(z => state.zones[z] && state.zones[z].held);
        state.powers.push({ region: rid, sweep: true, name: r.regionPower.name, text: r.regionPower.text, active: swept });
      }
    }
    state.canConvert = hasFx('convert');
    // org tier from held-zone count
    {
      const heldCount = Object.values(state.zones).filter(z => z.held).length;
      let cur = ORG_TIERS[0];
      for (const t2 of ORG_TIERS) if (heldCount >= t2.held) cur = t2;
      const idx = ORG_TIERS.indexOf(cur);
      const next = ORG_TIERS[idx + 1] || null;
      state.orgTier = {
        level: cur.level, rank: cur.rank, gillyMax: cur.gillyMax, heldCount,
        nextAt: next ? next.held : null, nextRank: next ? next.rank : null,
      };
    }
    // per-member rides + auto promotion offers (presented, never hunted)
    for (const [name, m3] of Object.entries(state.members)) {
      m3.spectator = !!state.spectators[name];
      m3.rides = {};
      m3.offers = [];
      for (const [line, tier] of Object.entries(m3.lineTiers)) {
        if (tier > 0) m3.rides[line] = rideFor(name, line, tier);
      }
      for (const line of Object.keys(LINE_TYPES)) {
        const next = (m3.lineTiers[line] || 0) + 1;
        if (next > 4) continue;
        if (lineCount(m3, line) < rideNeeded(m3, line, next)) continue;
        const ride = rideFor(name, line, next);
        const fee = rideFee(ride);
        if (!ride || fee == null) continue;
        m3.offers.push({
          line, lineName: (ranks && ranks.tracks && ranks.tracks[line] && ranks.tracks[line].name) || line,
          tier: next, ride, fee, needsApproval: fee > TUNING.APPROVAL_LIMIT,
        });
      }
      // entry hulls this member could requisition — every trade they can't fly yet
      m3.requisitions = [];
      for (const line of Object.keys(LINE_TYPES)) {
        const have = m3.lineTiers[line] || 0;
        const ride = have ? null : rideFor(name, line, 1);
        const fee = rideFee(ride);
        m3.requisitions.push({
          line, lineName: (ranks && ranks.tracks && ranks.tracks[line] && ranks.tracks[line].name) || line,
          have: have > 0, ride, fee,
        });
      }
      // the hangar: every ship this member can use right now
      m3.hangar = hangarShips(name).map(n => {
        const rent = rentByName(n);
        const locs = rent
          ? Object.entries(rent.byLocation || {}).filter(([c]) => STANTON_RENT_CITIES.includes(c)).sort((a, b) => a[1] - b[1])
          : [];
        return { name: n, kind: 'rental', city: locs.length ? locs[0][0] : null, price: locs.length ? locs[0][1] : null };
      });
      if (m3.rideOverride && m3.rideOverride.ship) {
        const f4 = m3.rideOverride.fleetId != null ? state.fleet[m3.rideOverride.fleetId] : null;
        m3.hangar.push({
          name: m3.rideOverride.ship, kind: f4 ? 'hull' : 'rental',
          fleetId: f4 ? f4.id : null, owner: f4 ? f4.by : null,
        });
      }
    }
    state.clearance = {};
    for (const b of BANDS) state.clearance[b.id] = bandClearedNow(b.id);
    for (const f of state.fleet) {
      f.price = shipPrice(f.ship);
      const band = f.price != null ? bandFor(f.price) : null;
      f.band = band ? band.id : null;
      f.bandLabel = band ? band.label : null;
      f.bandCleared = band ? state.clearance[band.id] : false;
    }
    state.projectList = [];
    if (projects && projects.projects) {
      for (const [pid, proj] of Object.entries(projects.projects)) {
        const cost = projectCost(proj);
        const locks = [];
        if (!state.projectsDone[pid]) {
          if (proj.after && !state.projectsDone[proj.after]) locks.push(`after: ${projects.projects[proj.after].name}`);
          if (proj.site && !activeEffects().some(f => f.effect.commissionSite === proj.site))
            locks.push(proj.site === 'capital' ? 'needs the Orison Shipyards (hold Crusader)' : 'needs the Fab Labs (hold microTech)');
          if (proj.needsOres) for (const o of proj.needsOres) if (!oreHeld(o)) locks.push(`needs a held zone bearing ${o}`);
          for (const [k, v] of Object.entries(cost)) if ((state.chest[k] || 0) < v) {
            const miss = v - (state.chest[k] || 0);
            const disp = k === 'funds'
              ? (miss >= 1e6 ? (miss / 1e6).toFixed(1) + 'M' : Math.round(miss / 1000) + 'k') + ' ORG funds'
              : miss + ' ' + k;
            locks.push(`short ${disp}`);
          }
        }
        // progressive reveal: the flagship chain (tier 3) is always visible — it is the
        // season's point. Tier-2 projects surface once the org takes relevant ground.
        let hidden = false;
        if (proj.tier === 2 && !state.projectsDone[pid]) {
          const anyT1 = Object.keys(state.projectsDone).some(d => projects.projects[d] && projects.projects[d].tier === 1);
          const siteUp = proj.site ? activeEffects().some(f => f.effect.commissionSite === proj.site) : false;
          const oreUp = (proj.needsOres || []).some(oreHeld);
          hidden = !(anyT1 || siteUp || oreUp);
        }
        state.projectList.push({
          id: pid, name: proj.name, tier: proj.tier, site: proj.site || null, cost,
          grantText: (proj.grant && proj.grant.text) || '', victory: !!(proj.grant && proj.grant.victory),
          done: !!state.projectsDone[pid], locks, hidden,
        });
      }
    }
    state.director = {
      faction,
      active: activeMoves.map(m => ({ kind: m.kind, region: m.region, zone: m.zone, pushId: m.pushId, deadline: m.deadline })),
      telegraph: (state.chest.intel >= TUNING.INTEL_TELEGRAPH || hasFx('telegraphFree'))
        ? planDirector(state.tick + 1, Math.max(
            (activeSets[state.tick] && activeSets[state.tick].size) || 0,
            (activeSets[state.tick - 1] && activeSets[state.tick - 1].size) || 0))
          .map(pl => ({ kind: pl.kind, region: pl.region, zone: pl.zone }))
        : null,
    };
    return state;
  }

  // ── Push derivation ─────────────────────────────────────────────────────
  // Pure: today's offered objectives = f(targets, board state, tick). Nothing
  // stored — completions reference the deterministic push id. A push is only
  // offered for buckets the target zone still needs, so the board asks for
  // exactly the mix its recipe is missing.
  function derivePushes(regions, sys, config, state, tickIndex, pushTally) {
    const pushes = [];
    const fronted = Object.entries(state.fronts).sort((a, b) => b[1].at - a[1].at);
    for (const [zid] of fronted) {
      const z = state.zones[zid];
      if (!z || z.held) continue;
      const rid = z.region;
      const region = sys.regions[rid];
      const recipe = regions.archetypes[region.zones[zid].archetype].recipe;
      for (const [kind, def] of Object.entries(PUSH_KIND)) {
        if (!def.org) continue;
        if (Math.min(z.cats[def.bucket], recipe[def.bucket]) >= recipe[def.bucket]) continue;
        let types = def.types.filter(t => region.availability[t] && region.availability[t] !== 'none');
        // mining needs a beachhead first; salvage (Lagrange work) flows regardless
        if (kind === 'industry' && z.control <= 0) types = types.filter(t => t !== 'mining');
        if (!types.length) continue;
        const id = `p${tickIndex}:${rid}:${kind}:${zid}`;
        const tallied = pushTally[id] || 0;
        pushes.push({
          id, kind, label: def.label, bucket: def.bucket, region: rid, zone: zid, types,
          count: TUNING.PUSH_COUNT, done: Math.min(tallied, TUNING.PUSH_COUNT),
          completed: tallied >= TUNING.PUSH_COUNT,
          scarce: types.every(t => region.availability[t] === 'rare'),
          bonus: TUNING.PUSH_BONUS,
          expiresAt: config.startedAt + (tickIndex + 1) * TUNING.DAY_MS,
        });
        if (pushes.length >= 9) break;
      }
      if (pushes.length >= 9) break;
    }
    // progressed pushes survive a front change — banked work keeps its bonus chance
    const have = new Set(pushes.map(p => p.id));
    for (const [pid, n] of Object.entries(pushTally)) {
      if (!n) continue;
      const m = PUSH_ID_RE.exec(pid);
      if (!m || +m[1] !== tickIndex || have.has(pid)) continue;
      const def = PUSH_KIND[m[3]];
      if (!def || !def.org) continue;
      const region = sys.regions[m[2]];
      if (!region || !region.zones[m[4]]) continue;
      const z = state.zones[m[4]];
      let types = def.types.filter(t => region.availability[t] && region.availability[t] !== 'none');
      if (m[3] === 'industry' && (!z || z.control <= 0)) types = types.filter(t => t !== 'mining');
      pushes.push({
        id: pid, kind: m[3], label: def.label, bucket: def.bucket, region: m[2], zone: m[4],
        types, count: TUNING.PUSH_COUNT, done: Math.min(n, TUNING.PUSH_COUNT),
        completed: n >= TUNING.PUSH_COUNT, scarce: false, bonus: TUNING.PUSH_BONUS,
        expiresAt: config.startedAt + (tickIndex + 1) * TUNING.DAY_MS, carried: true,
      });
    }
    return pushes;
  }

  // ── Event construction ──────────────────────────────────────────────────
  function newEvent(kind, actor, payload, t) {
    return { t: t == null ? Date.now() : t, a: actor, k: kind, p: payload || {} };
  }

  // ── Demo store (localStorage) — same surface the Firebase adapter will have
  function createDemoStore(id) {
    const KEY = 'smr_org_demo_' + (id || 'demo');
    const canPersist = typeof localStorage !== 'undefined';
    let events = [];
    if (canPersist) {
      try { events = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { events = []; }
    }
    const subs = [];
    const persist = () => { if (canPersist) localStorage.setItem(KEY, JSON.stringify(events)); };
    const notify = () => subs.forEach(cb => cb(events.slice()));
    return {
      append(ev) { events.push(ev); persist(); notify(); return ev; },
      subscribe(cb) { subs.push(cb); cb(events.slice()); return () => subs.splice(subs.indexOf(cb), 1); },
      exportLog() { return JSON.stringify({ format: 'smr-org-log', v: 1, events }, null, 0); },
      importLog(str) {
        const data = JSON.parse(str);
        if (data.format !== 'smr-org-log' || !Array.isArray(data.events)) throw new Error('Not a campaign log');
        events = data.events; persist(); notify();
      },
      clear() { events = []; persist(); notify(); },
      size() { return events.length; },
    };
  }

  const OrgState = {
    TUNING, fold, newEvent, createDemoStore, rng, normName, dispName,
    LINE_TYPES, TYPE_LINE,
    helpers: { zoneOnSiteTypes, availabilityMult, findZone },
  };

  if (typeof window !== 'undefined') window.OrgState = OrgState;
  if (typeof module !== 'undefined' && module.exports) module.exports = OrgState;
})();
