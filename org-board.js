/* Org Campaign board page — renders the polar map + panels from the folded state.
 * Data: org_regions.json (what zones are) + org_board.json (where they sit).
 * State: OrgState demo store (localStorage event log) folded on every change.
 */
(function () {
  'use strict';

  const FILES = { regions: 'org_regions.json', board: 'org_board.json', providers: 'mission_providers.json', projects: 'org_projects.json', ships: 'purchase_ships.json', rentals: 'rental_ships.json', ranks: 'story_ranks.json', heroes: 'hero_adventures.json', extraShips: 'org_ships_extra.json' };

  const D = {};                 // loaded data files
  let store = null;
  let events = [];
  let state = null;             // folded state (null until campaign exists)
  let selected = null;          // selected zone id
  let infoView = null;          // left info panel: 'zone'|'members'|'fleet'|'projects'|'chronicle'|null
  let sysB = null, sysR = null; // board + regions defs for the campaign system

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const callsignKey = 'smr_org_callsign';
  // the normalized key IS the identity — same person on any device/browser
  const callsign = () => OrgState.normName(localStorage.getItem(callsignKey) || 'Anonymous') || 'anonymous';
  const callsignDisplay = () => OrgState.dispName(localStorage.getItem(callsignKey) || 'Anonymous');
  const disp = (k) => (state && state.members[k] && state.members[k].display) || k;
  const heroFor = (id) => (id && D.heroes && D.heroes.heroAdventures && D.heroes.heroAdventures[id]) || null;
  // no native confirm() — browsers let users suppress dialogs, and clicks then
  // die silently. First click arms the button, a second click within 3.5s fires.
  function armConfirm(btn, fn, label) {
    if (btn.dataset.armed) { fn(); return; }
    btn.dataset.armed = '1';
    const prev = btn.textContent;
    btn.textContent = label || 'click again to confirm';
    btn.classList.add('armed');
    setTimeout(() => {
      if (!btn.isConnected || !btn.dataset.armed) return;
      delete btn.dataset.armed;
      btn.textContent = prev;
      btn.classList.remove('armed');
    }, 3500);
  }
  const dayLabel = (d) => {
    const date = new Date(state.config.startedAt + d * 86400000);
    return `${date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })} (day ${d + 1})`;
  };

  // ── Boot ────────────────────────────────────────────────────────────────
  const NET_KEY = 'smr_org_net';
  let netMode = false;
  // identity is confirmed once PER CAMPAIGN — a stale callsign from some other
  // board never silently logs you into a new one
  let campPath = 'local';
  const whoOkKey = () => 'smr_org_who_ok:' + campPath;
  function setNetStatus(s) {
    const el = $('oh-net');
    if (!el) return;
    el.style.display = '';
    if (s === 'live') { el.textContent = '● synced'; el.className = 'sys-chip net-chip ok'; }
    else if (s === 'connecting') { el.textContent = '○ connecting…'; el.className = 'sys-chip net-chip'; }
    else if (s === 'offline') { el.textContent = '⨯ offline — reconnecting'; el.className = 'sys-chip net-chip bad'; }
    else { el.textContent = s; el.className = 'sys-chip net-chip'; }
  }
  async function init() {
    const [regions, board, providers, projects, ships, rentals, ranks, heroes, extraShips] = await Promise.all(
      [FILES.regions, FILES.board, FILES.providers, FILES.projects, FILES.ships, FILES.rentals, FILES.ranks, FILES.heroes, FILES.extraShips].map(f => fetch(f, { cache: 'no-store' }).then(r => r.json()))
    );
    // hulls that fly but aren't sold for aUEC join the roster at org valuations
    // (board fiction) so owners can pledge and the org can commission them
    const known = new Set((ships.ships || []).map(s => s.n));
    ships.ships = (ships.ships || []).concat(((extraShips && extraShips.ships) || []).filter(s => !known.has(s.n)));
    D.regions = regions; D.board = board; D.providers = providers; D.projects = projects; D.ships = ships; D.rentals = rentals; D.ranks = ranks; D.heroes = heroes;
    const netCode = localStorage.getItem(NET_KEY);
    if (netCode && window.OrgNet) {
      try {
        campPath = OrgNet.readCode(netCode).path;
        store = await OrgNet.createStore(netCode, { status: setNetStatus });
        netMode = true;
      } catch (err) {
        console.error('multiplayer join failed:', err);
        setNetStatus('⚠ join code failed — running local');
        store = OrgState.createDemoStore('v1');
      }
    } else {
      store = OrgState.createDemoStore('v1');
      setNetStatus('local demo');
    }
    document.body.classList.toggle('net-mode', netMode);
    store.subscribe(evts => { events = evts; refold(); });
    bindChrome();
  }

  let lastLogLen = -1;
  function refold() {
    state = OrgState.fold(D.regions, events, Date.now(),
      { projects: D.projects, ships: D.ships, rentals: D.rentals, ranks: D.ranks, heroes: D.heroes });
    if (!state) { showSetup(); return; }
    // a campaign exists: any setup/create/join-code screen is stale by
    // definition — close it no matter who acted last (heals boot races and
    // the two-founders-racing case)
    if (setupOpen) {
      setupOpen = false;
      modalSticky = false;
      closeModal();
    }
    // otherwise close open modals only when the newest event is OUR OWN action —
    // in a shared campaign, someone else's contract must not eat your open dialog.
    // And only when the log actually GREW: this runs on a 60s clock tick too,
    // which used to swallow a half-filled dialog mid-edit.
    const grew = events.length !== lastLogLen;
    lastLogLen = events.length;
    const lastMine = !events.length || OrgState.normName(events[events.length - 1].a) === callsign();
    if (grew && lastMine) {
      modalSticky = false;
      closeModal();
    }
    const meRec = state.members[callsign()];
    document.body.classList.toggle('spectator', !!(meRec && meRec.spectator));
    maybeSendReport();
    sysR = D.regions.systems[state.config.system];
    sysB = D.board.systems[state.config.system];
    $('org-head').style.display = '';
    $('org-main').style.display = '';
    try {
      renderHeader();
      renderMap();
      renderRide();
      renderMyContract();
      renderOffers();
      renderPushes();
      renderInfo();
      updateTabs();
    } catch (err) {
      console.error('render failed:', err);
    }
    if (!joinPrompted && (!state.members[callsign()] || !localStorage.getItem(whoOkKey())) &&
        !(state.season && state.season.over)) {
      joinPrompted = true;
      showJoin();
    } else if (!welcomeShown && state.members[callsign()] && localStorage.getItem(whoOkKey()) &&
        !(state.season && state.season.mustering)) {
      welcomeShown = true;
      if (!(state.season && state.season.over)) showWelcome();
    }
  }

  // ── Promotions earned — presented, never hunted ─────────────────────────
  function renderOffers() {
    const el = $('offers-card');
    const me = state.members[callsign()];
    const offers = (me && me.offers) || [];
    if (!offers.length || (state.season && state.season.over)) { el.style.display = 'none'; return; }
    el.style.display = '';
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const pendingRide = Object.values(state.requests || {}).some(r => r.by === callsign() && r.kind === 'ride' && r.status === 'pending');
    const iApprove = state.approvers.includes(callsign());
    el.innerHTML = `<div class="card-title">Promotions earned</div>` + offers.map(o =>
      `<div class="offer-row"><div class="of-head">🎖 <b>${esc(o.lineName)}</b> tier ${o.tier} — the org offers: <b>${esc(o.ride.name)}</b></div>` +
      `<div class="of-detail">~${fmtDay(o.ride.price)} aUEC/day · collect at ${esc(o.ride.city)} · unlock for ${fmtF(o.fee)} ORG funds${o.needsApproval ? ' · needs an approver' : ''}</div>` +
      `<div class="of-act">${o.needsApproval && !iApprove
        ? (pendingRide ? '<span class="proj-locks">sent for approval — pending</span>' : `<button class="btn btn-mini" data-offer-req="${o.line}:${o.tier}">Request unlock</button>`)
        : `<button class="btn btn-mini" data-offer="${o.line}:${o.tier}">Unlock</button>`}</div></div>`).join('');
    el.querySelectorAll('[data-offer]').forEach(b => b.addEventListener('click', () => {
      const [line, tier] = b.dataset.offer.split(':');
      store.append(OrgState.newEvent('ride.unlock', callsign(), { line, tier: +tier }));
    }));
    el.querySelectorAll('[data-offer-req]').forEach(b => b.addEventListener('click', () => {
      const [line, tier] = b.dataset.offerReq.split(':');
      store.append(OrgState.newEvent('request.create', callsign(), { reqId: 'q' + Date.now().toString(36), kind: 'ride', payload: { line, tier: +tier } }));
    }));
  }

  // ── Left info panel: one region, many views ─────────────────────────────
  function setInfo(view) {
    infoView = view === null ? null : (infoView === view ? null : view);
    if (infoView !== 'zone') selected = null;
    renderMap(); renderInfo(); updateTabs();
  }
  function updateTabs() {
    document.querySelectorAll('.oh-tabs [data-info]').forEach(b =>
      b.classList.toggle('active', infoView === b.dataset.info));
  }
  function renderInfo() {
    const el = $('panel');
    if (infoView === 'zone' && (!selected || !state.zones[selected])) infoView = null;
    if (!infoView) { el.style.display = 'none'; return; }
    el.style.display = '';
    const close = `<button class="panel-close" data-close-info title="Close">✕</button>`;
    if (infoView === 'zone') renderZoneInfo(el, close);
    else if (infoView === 'members') renderMembersInfo(el, close);
    else if (infoView === 'fleet') renderFleetInfo(el, close);
    else if (infoView === 'projects') renderProjectsInfo(el, close);
    else if (infoView === 'chronicle') renderChronicleInfo(el, close);
    else if (infoView === 'help') renderHelpInfo(el, close);
    else if (infoView === 'admin') renderAdminInfo(el, close);
    else if (infoView === 'pledge') renderPledgeInfo(el, close);
    const cb = el.querySelector('[data-close-info]');
    if (cb) cb.addEventListener('click', () => setInfo(null));
  }

  // ── Header ──────────────────────────────────────────────────────────────
  function renderHeader() {
    $('oh-name').textContent = state.config.name || 'Org Campaign';
    $('oh-sys').textContent = state.config.system;
    const ot = state.orgTier;
    if (ot) {
      $('oh-tier').textContent = `TIER ${ot.level} · ${ot.rank}`;
      $('oh-tier').title = `Org performance: ${ot.heldCount} zone${ot.heldCount === 1 ? '' : 's'} held.` +
        (ot.nextAt != null ? ` Next: ${ot.nextRank} bounties at ${ot.nextAt} zones held.` : ' Top tier — ERT cleared.');
    }
    const len = state.config.seasonDays;
    $('oh-tick').textContent = state.season && state.season.mustering
      ? `Mustering — ${len}-day season ready`
      : state.season && state.season.over
        ? `Season closed — Day ${state.season.daysPlayed} / ${len}`
        : `Day ${state.tick + 1} / ${len}`;
    const c = state.chest;
    const fmtFunds = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
    // hovering the stores explains what each one is, where it comes from, what it buys
    const TIP = {
      funds: 'ORG FUNDS — the campaign treasury. Not real aUEC: your own wallet is never touched.\n' +
        `Earned: ${OrgState.TUNING.FUNDS_PER_CONTRACT / 1000}k per submitted contract, ` +
        `${OrgState.TUNING.PUSH_FUNDS_BONUS / 1000}k for each Daily Objective Bonus, ` +
        `${OrgState.TUNING.HELD_FUNDS_PER_TICK / 1000}k a day from every planet the org holds.\n` +
        'Spent on: promotions, requisitions, commissioning hulls, and projects.',
      metals: 'METALS — ore hauled out of the belt and the rock.\n' +
        'Earned: 1 per mining contract you submit (mining needs an amber or green planet).\n' +
        'Spent on: projects — the flagship chain eats metals.',
      components: 'COMPONENTS — parts stripped off wrecks.\n' +
        'Earned: 1 per salvage contract you submit (salvage counts anywhere — no beachhead needed).\n' +
        'Spent on: projects.',
      supplies: 'SUPPLIES — cargo, fuel and provisions moved by the haulers.\n' +
        'Earned: 1 per hauling contract you submit. Answering a Director relief call pays ' +
        `${OrgState.TUNING.DISTRACT_REWARD.supplies} more; ignoring one costs ${OrgState.TUNING.DISTRACT_COST.supplies}.\n` +
        'Spent on: projects.',
      intel: 'INTEL — what the org learns by looking.\n' +
        `Earned: 1 per quick investigation you submit (missing person, short search), ${OrgState.TUNING.INTEL_DEEP_YIELD} for a long one ` +
        '(ASD site, research). Investigations are never assigned — run them on your own and log them.\n' +
        `Spent on: scouting the Director region by region (${OrgState.TUNING.INTEL_READ_COST} intel each, once a day per region), and on projects.`,
    };
    $('oh-chest').innerHTML =
      `<span class="mat treasury" title="${esc(TIP.funds)}">ORG FUNDS<b>${fmtFunds(c.funds)}</b></span>` +
      `<span class="mat" title="${esc(TIP.metals)}">MET<b>${c.metals}</b></span>` +
      `<span class="mat" title="${esc(TIP.components)}">CMP<b>${c.components}</b></span>` +
      `<span class="mat" title="${esc(TIP.supplies)}">SUP<b>${c.supplies}</b></span>` +
      `<span class="mat" title="${esc(TIP.intel)}">INT<b>${c.intel}</b></span>` +
      (state.canConvert ? `<button class="mat convert-btn" id="btn-convert" title="War Market — swap any material for another, 1:1">⇄</button>` : '');
    const cv = $('btn-convert');
    if (cv) cv.addEventListener('click', showConvertModal);
    const meRec2 = state.members[callsign()];
    $('oh-callsign').textContent = (disp(callsign()) !== callsign() ? disp(callsign()) : callsignDisplay()) +
      (meRec2 && meRec2.spectator ? ' · 👁 spectator' : '');
    const adminTab = document.querySelector('.oh-tabs [data-info="admin"]');
    if (adminTab) adminTab.style.display = state.approvers.includes(callsign()) ? '' : 'none';
  }

  // ── Map ─────────────────────────────────────────────────────────────────
  // The map is drawn by org-map.js — shared with the public battle map, so the
  // two can never drift apart. Here we add the war room's interactivity.
  function renderMap() {
    const svg = $('org-map');
    OrgMap.render(svg, {
      board: sysB, regions: D.regions, system: state.config.system,
      zones: state.zones, fronts: state.fronts,
      raided: ((state.director && state.director.active) || [])
        .filter(m => m.kind === 'raid').map(m => m.zone),
      selected,
    });
    svg.querySelectorAll('.zone').forEach(g =>
      g.addEventListener('click', () => {
        selected = (infoView === 'zone' && selected === g.dataset.zone) ? null : g.dataset.zone;
        infoView = selected ? 'zone' : null;
        renderMap(); renderInfo(); updateTabs();
      }));
  }

  // Crusader is both a region and the gas giant inside it — never print a bare
  // name where either could be meant. Regions get "space"; the capital planet
  // that shares its region's name gets "itself".
  const regionSpace = (rid) => `${(sysR.regions[rid] || {}).name || rid} space`;
  const zoneLabel = (rid, zid) => {
    const r = sysR.regions[rid];
    const zn = r && r.zones[zid] ? r.zones[zid].name : zid;
    return (r && zn === r.name) ? `${zn} itself` : zn;
  };
  // Either direction counts, and a bare "Crusader" reads as the gas giant —
  // the board never promises a cargo run to one specific rock exists.
  const haulDirFor = (rid) => `any run that starts or ends inside ${regionSpace(rid)}`;
  const typeWordOf = (t) => (D.providers.types[t] || {}).name || String(t).replace('-', ' ');
  // the three shares of a zone's control, in the order they are shown
  const BUCKETS = [
    { key: 'combat', label: 'Combat' },
    { key: 'supply', label: 'Supply' },
    { key: 'industry', label: 'Industry' },
  ];

  // ── Zone panel ──────────────────────────────────────────────────────────
  function renderZoneInfo(el, close) {
    const zid = selected, zs = state.zones[zid];
    const region = sysR.regions[zs.region];
    const def = region.zones[zid];
    const arch = D.regions.archetypes[def.archetype];
    const fr = state.fronts[zid];
    const frSameDay = fr && Math.floor((fr.at - state.config.startedAt) / 86400000) === state.tick;
    const canRemove = fr && (fr.by === callsign() || !frSameDay || zs.held);
    const capFull = !fr && Object.keys(state.fronts).length >= OrgState.TUNING.FRONT_CAP;
    const zonePushes = (state.pushes || []).filter(p2 => p2.zone === zid);

    // ── Control and its three shares ──────────────────────────────────────
    // One bar per share, each in its own colour — accent purple belongs to the
    // day's objectives and nothing else. Every number carries a %, because the
    // three shares add up to the Control figure above them: true all along, and
    // invisible while they read as bare counts ("15 / 20" in a game about
    // missions reads as fifteen of twenty missions — reported on day one).
    const controlBar = (() => {
      const segs = BUCKETS.map(b => {
        const cap = arch.recipe[b.key] || 0;
        const have = Math.min(zs.cats[b.key], cap);
        return { b, cap, have, full: cap > 0 && have >= cap };
      });
      const pen = Math.round(zs.penalty || 0);
      const earned = segs.reduce((n, s) => n + s.have, 0);
      const bars = segs.map(s =>
        `<div class="meter cb-${s.b.key}${s.full ? ' full' : ''}">` +
        `<div class="m-row"><span>${esc(s.b.label)}</span>` +
        `<b>${Math.round(s.have)}% of ${s.cap}%</b></div>` +
        `<div class="m-bar"><div class="m-fill cb-fill" style="width:${s.cap ? (s.have / s.cap) * 100 : 0}%"></div></div>` +
        `</div>`).join('');
      // the total is a NUMBER, not a fourth bar. A bar for the sum sitting on
      // top of bars for its parts is what made all four read as one list of
      // goals — the shares are the only thing anyone can act on.
      return `<div class="meter m-total"><div class="m-row">` +
        `<span>${esc(def.name)} control</span><b>${Math.round(zs.control)}%</b></div></div>` +
        bars +
        (pen > 0
          ? `<div class="cb-pen">⚠ −${pen}% raid damage · ${Math.round(earned)}% earned, ${Math.round(zs.control)}% held</div>`
          : '') +
        `<div class="cb-help">The three shares add up to control. A contract here is worth ` +
        `${OrgState.TUNING.BASE_GAIN}% to its share — ` +
        `${OrgState.TUNING.BASE_GAIN * OrgState.TUNING.ONSITE_MULT}% if you were on site.</div>`;
    })();
    const avail = Object.entries(region.availability)
      .map(([t, lv]) => `<span class="avail-chip ${lv}">${esc(t)}${lv === 'rare' ? ' ×1.5' : ''}</span>`)
      .join('');

    // The Director's demands are answer-or-lose, so they are never filed under
    // "bonus". They keep their own heading above it.
    const missionBlock = (() => {
      const threats = zonePushes.filter(p2 => p2.director);
      const bonus = zonePushes.filter(p2 => !p2.director);
      return (threats.length
        ? `<div class="card-title">⚠ Answer today</div>` + threats.map(buildPushRow).join('')
        : '') +
        (bonus.length
          ? `<div class="card-title">Bonus missions for the day</div>` +
            `<div class="pz-onsite">These missions count up to <b>+50%</b>.</div>` +
            bonus.map(buildPushRow).join('')
          : '');
    })();

    el.innerHTML =
      `<div class="zone-panel${zs.held ? ' held' : ''}">` +
      close +
      `<div class="pz-kicker"><span>${esc(def.kind)}</span>·<span>${esc(region.name)} region</span>·<span>${esc(arch.name)}</span></div>` +
      `<div class="pz-name">${esc(def.name)}${zs.held ? ' <span class="badge-held">HELD</span>' : ''}</div>` +
      `<div class="card-title cd-first">Resources</div>` +
      // the body's own description belongs with what the body IS, not down in
      // the control section where it read as a note about the meters. A body
      // with no ore and no note of its own falls back to the generic line;
      // where it has one, that one says more, so it stands alone.
      (def.ores
        ? `<div class="ore-chips">${def.ores.map(o => `<span class="ore-chip">${esc(o)}</span>`).join('')}</div>` +
          (def.note ? `<div class="pz-note">${esc(def.note)}</div>` : '') +
          (zs.control <= 0 ? `<div class="pz-gate">This planet is grey — locked to mining until a beachhead is established. Combat or supply work here turns it amber and opens it. (Salvage counts anywhere.)</div>` : '')
        : `<div class="pz-note">${esc(def.note || 'No mineable rock — its value is position and services.')}</div>`) +
      (() => {
        let out = '';
        const pw = def.power, rpw = region.regionPower;
        if (pw || rpw) out += `<div class="card-title">Captured grants</div>`;
        if (pw) out += `<div class="grant${zs.held ? ' on' : ''}"><b>${esc(pw.name)}</b>${zs.held ? ' <span class="grant-on">ACTIVE</span>' : ''}<div class="grant-text">${esc(pw.text)}</div></div>`;
        if (rpw) {
          const swept = Object.keys(region.zones).every(z => state.zones[z] && state.zones[z].held);
          out += `<div class="grant sweep${swept ? ' on' : ''}"><b>${esc(rpw.name)}</b> <span class="grant-scope">whole region</span>${swept ? ' <span class="grant-on">ACTIVE</span>' : ''}<div class="grant-text">${esc(rpw.text)}</div></div>`;
        }
        return out;
      })() +
      controlBar +
      ((() => {
        const h = heroFor(region.setPiece);
        if (!h) return '';
        const done = state.setPieces && state.setPieces[zs.region];
        const unlocked = state.spUnlocked && state.spUnlocked[zs.region];
        const od = state.orgDay;
        const sched = Object.entries(state.orgDays || {})
          .find(([d, o]) => +d > state.tick && o.region === zs.region);
        let body;
        if (done) {
          body = `<span class="sp-done">✓ run on day ${done.tick + 1}${(done.runs || 1) > 1 ? ` · ×${done.runs} runs` : ''} — ${done.participants.length} medal${done.participants.length === 1 ? '' : 's'} on the first.</span>` +
            (state.approvers.includes(callsign()) ? ` <button class="linklike" data-sp-record="${zs.region}">record another run</button>` : '');
        } else if (unlocked) {
          body = `<span class="sp-done">🔓 unlocked</span> — run it together! Your organizer records it in the objectives column.`;
        } else if (od && od.region === zs.region) {
          body = `📣 Org Day in progress — ${od.count} / ${od.target} contracts in ${esc(region.name)} space today unlock it.`;
        } else if (sched) {
          body = `📅 Org Day planned — ${esc(dayLabel(+sched[0]))} brings the org here.`;
        } else if (state.approvers.includes(callsign())) {
          body = `unlock it by setting up an Org Day. <button class="linklike" data-orgday="${zs.region}">📣 Call an Org Day here</button>`;
        } else {
          body = `unlock it by setting up an Org Day — your org leadership calls those.`;
        }
        return `<div class="pz-hero">🌟 Region set-piece: <b>${esc(h.name)}</b> — ${body}</div>`;
      })()) +
      (zonePushes.length
        ? missionBlock
        : (fr ? `<div class="pz-note">All of today's work here is claimed or done — more tomorrow.</div>` : '')) +
      `<div class="card-title">Region contract boards</div><div class="avail-grid">${avail}</div>` +
      (zs.held ? '' :
        (state.season && state.season.mustering)
          ? `<div class="panel-hint" style="margin-top:8px">The season hasn't started — front lines open with the gun.</div>`
          : fr
          ? (canRemove
            ? `<button class="btn" id="btn-front" data-front-act="remove">⚑ Pull off the front lines</button>`
            : `<button class="btn" disabled>🔒 Front held today — added by ${esc(disp(fr.by))}</button>`)
          : (capFull
            ? `<button class="btn" disabled>🔒 Front lines full (${OrgState.TUNING.FRONT_CAP} max)</button>`
            : `<button class="btn btn-primary" id="btn-front" data-front-act="add">⚑ Add this to the front lines</button>`)) +
      `</div>`;

    const bf = $('btn-front');
    if (bf) bf.addEventListener('click', () => {
      store.append(OrgState.newEvent(bf.dataset.frontAct === 'remove' ? 'front.remove' : 'front.add',
        callsign(), { zone: zid }));
    });
    const odBtn = el.querySelector('[data-orgday]');
    if (odBtn) odBtn.addEventListener('click', () => showOrgDayModal(odBtn.dataset.orgday));
    const spAgain = el.querySelector('[data-sp-record]');
    if (spAgain) spAgain.addEventListener('click', () => showSetPieceModal(spAgain.dataset.spRecord));
    bindClaimButtons(el);
  }

  // the leader picks the day — today or any open day ahead (real dates shown)
  function showOrgDayModal(regionId) {
    const rdef = sysR.regions[regionId];
    const h = heroFor(rdef.setPiece);
    const taken = state.orgDays || {};
    const opts = [];
    for (let d = state.tick; d < Math.min(state.tick + 14, state.config.seasonDays); d++) {
      if (taken[d]) continue;
      opts.push(`<option value="${d}">${d === state.tick ? `Today — day ${d + 1}` : dayLabel(d)}</option>`);
    }
    openModal(
      `<h2>📣 Call an Org Day — ${esc(rdef.name)} space</h2>` +
      `<div class="m-sub">The whole org points one direction for a day: ${OrgState.TUNING.ORGDAY_TARGET} contracts in ` +
      `${esc(rdef.name)} space before that day ends clear the path to <b>${esc(h ? h.name : 'its set-piece')}</b>.</div>` +
      (opts.length
        ? `<label class="f-label">Which day?</label><select class="f-input" id="od-day">${opts.join('')}</select>`
        : `<div class="panel-hint">No open days left in the season.</div>`) +
      `<div class="modal-actions"><button class="btn btn-ghost" id="od-cancel">Cancel</button>` +
      (opts.length ? `<button class="btn btn-primary" id="od-call">📣 Call it</button>` : '') +
      `</div>`
    );
    $('od-cancel').addEventListener('click', closeModal);
    const call = $('od-call');
    if (call) call.addEventListener('click', () => {
      store.append(OrgState.newEvent('orgday.declare', callsign(), { region: regionId, day: +$('od-day').value }));
    });
  }

  // ── Re-file a mis-logged contract (approvers only) ──────────────────────
  // Nothing is deleted: a correction is a new event pointing back at the old
  // one, and the whole board recomputes from the corrected log.
  const PUSH_KIND_FOR = { combat: 'take', supply: 'supply', industry: 'industry' };
  const pushIdFor = (tick, region, zone, ctype) => {
    const kind = PUSH_KIND_FOR[D.regions.typeBuckets[ctype]];
    return kind ? `p${tick}:${region}:${kind}:${zone}` : null;
  };

  function showFixModal(f) {
    const typeOf = (rid) => Object.entries(sysR.regions[rid].availability)
      .filter(([, lv]) => lv !== 'none').map(([t]) => t);
    openModal(
      `<h2>✎ Re-file this contract</h2>` +
      `<div class="m-sub"><b>${esc(disp(f.by))}</b> filed it on <b>day ${f.tick + 1}</b>` +
      `${f.crew > 1 ? ` with ${f.crew - 1} more aboard` : ''}. Put it where it actually happened — ` +
      `the meters, the war chest and everyone's record are recomputed from the fix. The credit stays theirs.</div>` +
      `<label class="f-label">Contract type</label><select class="f-select" id="fx-type"></select>` +
      `<label class="f-label">Region it was worked in</label><select class="f-select" id="fx-region">${
        Object.keys(sysR.regions).map(rid =>
          `<option value="${rid}" ${rid === f.region ? 'selected' : ''}>${esc(regionSpace(rid))}</option>`).join('')
      }</select>` +
      `<label class="f-label">Apply the gains to</label><select class="f-select" id="fx-zone"></select>` +
      `<div class="f-note" id="fx-warn" style="display:none"></div>` +
      `<div class="f-check" id="fx-onsite-wrap"><input type="checkbox" id="fx-onsite" ${f.onSite ? 'checked' : ''}>` +
      `<span id="fx-onsite-label">The contract itself happened at the zone (+50%)</span></div>` +
      `<div id="fx-haul-wrap" style="display:none">${haulPickerHtml('fx', f)}</div>` +
      `<div class="modal-actions"><button class="btn btn-ghost" id="fx-cancel">Cancel</button>` +
      `<button class="linklike danger" id="fx-strike">strike it from the record</button>` +
      `<button class="btn btn-primary" id="fx-save">✓ Re-file it</button></div>`
    );
    const selType = $('fx-type'), selRegion = $('fx-region'), selZone = $('fx-zone');
    const sync = () => {
      const rid = selRegion.value, keep = selType.value || f.ctype, zkeep = selZone.value || f.zone;
      selType.innerHTML = typeOf(rid).map(t =>
        `<option value="${t}">${esc(typeWordOf(t))}</option>`).join('');
      if ([...selType.options].some(o => o.value === keep)) selType.value = keep;
      selZone.innerHTML = Object.keys(sysR.regions[rid].zones).map(zid =>
        `<option value="${zid}">${esc(zoneLabel(rid, zid))}</option>`).join('');
      if ([...selZone.options].some(o => o.value === zkeep)) selZone.value = zkeep;
      detail();
    };
    const detail = () => {
      const rid = selRegion.value, zid = selZone.value, t = selType.value;
      const isInv = t === 'investigation', isSalv = t === 'salvage';
      const gated = t === 'mining' && state.zones[zid] && state.zones[zid].control <= 0;
      const warn = $('fx-warn');
      warn.innerHTML = isInv
        ? 'Investigation pays intel into the org stores — the zone is only for the record, and there is no on-site bonus.'
        : gated
          ? `⚠ ${esc(zoneLabel(rid, zid))} has no beachhead, so mining credited there counts for nothing. Pick a planet the org has already touched.`
          : '';
      warn.style.display = warn.innerHTML ? '' : 'none';
      $('fx-onsite-wrap').style.display = isInv || isSalv ? 'none' : '';
      $('fx-haul-wrap').style.display = isSalv ? '' : 'none';
      $('fx-onsite-label').textContent = `The contract itself happened at ${zoneLabel(rid, zid)} (+50%)`;
    };
    selRegion.addEventListener('change', sync);
    selType.addEventListener('change', detail);
    selZone.addEventListener('change', detail);
    sync();
    $('fx-cancel').addEventListener('click', closeModal);
    $('fx-strike').addEventListener('click', (e) => armConfirm(e.currentTarget,
      () => store.append(OrgState.newEvent('contract.amend', callsign(), { ref: f.ref, void: true })),
      'strike it — sure?'));
    $('fx-save').addEventListener('click', () => {
      const region = selRegion.value, zone = selZone.value, ctype = selType.value;
      const salv = ctype === 'salvage';
      store.append(OrgState.newEvent('contract.amend', callsign(), {
        ref: f.ref, region, zone, ctype,
        onSite: !salv && ctype !== 'investigation' && $('fx-onsite').checked,
        cmat: salv && $('fx-cmat').checked,
        rmc: salv && $('fx-rmc').checked,
        // the old objective tag cannot survive a move; re-point it at the one
        // this work actually belongs to, or clear it
        pushId: pushIdFor(f.tick, region, zone, ctype),
      }));
    });
  }

  // record a completed set-piece: who was there → surge + medals (honor system, like everything)
  function showSetPieceModal(regionId) {
    const rdef = sysR.regions[regionId];
    const h = heroFor(rdef.setPiece);
    if (!h) return;
    const me = callsign();
    const others = Object.keys(state.members).filter(n => n !== me).sort();
    const encore = !!(state.setPieces && state.setPieces[regionId]);
    openModal(
      `<h2>🌟 ${esc(h.name)}${encore ? ' — encore' : ''}</h2>` +
      `<div class="m-sub">${encore
        ? `Record another run for the chronicle — medals for everyone who was there. The control surge only fires on a season's first run.`
        : `Record the run for ${esc(rdef.name)} space. The region's front surges +${OrgState.TUNING.SETPIECE_SURGE}% control, and everyone who was there gets the medal.`}</div>` +
      `<label class="f-label">Who was there?</label>` +
      `<div class="sp-parts"><label class="f-check"><input type="checkbox" checked disabled> ${esc(disp(me))} (you)</label>` +
      others.map(n => `<label class="f-check"><input type="checkbox" data-part="${esc(n)}"> ${esc(disp(n))}</label>`).join('') + `</div>` +
      `<div class="modal-actions"><button class="btn btn-ghost" id="sp-cancel">Cancel</button>` +
      `<button class="btn btn-primary" id="sp-save">${encore ? 'Record the encore' : 'Record it — the front surges'}</button></div>`
    );
    $('sp-cancel').addEventListener('click', closeModal);
    $('sp-save').addEventListener('click', () => {
      const parts = [...document.querySelectorAll('#modal-root [data-part]')]
        .filter(cb => cb.checked).map(cb => cb.dataset.part);
      store.append(OrgState.newEvent('setpiece.done', me, { region: regionId, participants: parts }));
    });
  }

  // the maiden voyage: the flagship's first flight, all hands — recording it wins the season
  function showFinaleModal() {
    const me = callsign();
    const others = Object.keys(state.members).filter(n => n !== me).sort();
    openModal(
      `<h2>🏆 The maiden voyage</h2>` +
      `<div class="m-sub">Record the flagship's first flight. Everyone aboard gets the 🏆 Flagship Crew medal — ` +
      `and the season closes in triumph.</div>` +
      `<label class="f-label">Who was aboard?</label>` +
      `<div class="sp-parts"><label class="f-check"><input type="checkbox" checked disabled> ${esc(disp(me))} (you)</label>` +
      others.map(n => `<label class="f-check"><input type="checkbox" data-part="${esc(n)}" checked> ${esc(disp(n))}</label>`).join('') + `</div>` +
      `<div class="modal-actions"><button class="btn btn-ghost" id="fn-cancel">Cancel</button>` +
      `<button class="btn btn-primary" id="fn-save">🏆 Record the voyage — win the season</button></div>`
    );
    $('fn-cancel').addEventListener('click', closeModal);
    $('fn-save').addEventListener('click', () => {
      const parts = [...document.querySelectorAll('#modal-root [data-part]')]
        .filter(cb => cb.checked).map(cb => cb.dataset.part);
      store.append(OrgState.newEvent('finale.done', me, { participants: parts }));
    });
  }

  // ── Chronicle ───────────────────────────────────────────────────────────
  function renderChronicleInfo(el, close) {
    const lines = state.chronicle.slice(-40).reverse();
    el.innerHTML = close +
      `<div class="card-title ct-row">War log <span><button class="linklike" id="btn-copymap">copy map link</button> ` +
      `<button class="linklike" id="btn-copylog">copy for discord</button></span></div>` +
      `<div id="chronicle">` + (lines.map(c =>
        `<div class="chron-line k-${c.kind}"><span class="ct">D${c.tick + 1}</span>${esc(c.text)}</div>`
      ).join('') || '<div class="chron-line">Nothing yet — the war starts with the first contract.</div>') + `</div>`;
    el.querySelector('#btn-copymap').addEventListener('click', () => {
      const btn = el.querySelector('#btn-copymap');
      navigator.clipboard.writeText(buildMapLink()).then(() => {
        btn.textContent = 'copied ✓ — anyone can open it';
        setTimeout(() => { if (btn.isConnected) btn.textContent = 'copy map link'; }, 2200);
      }).catch(() => { btn.textContent = 'copy failed'; });
    });
    el.querySelector('#btn-copylog').addEventListener('click', () => {
      const btn = el.querySelector('#btn-copylog');
      navigator.clipboard.writeText(buildWarLog()).then(() => {
        btn.textContent = 'copied ✓';
        setTimeout(() => { btn.textContent = 'copy for discord'; }, 1600);
      }).catch(() => { btn.textContent = 'copy failed'; });
    });
  }

  // ── How to play (the full guide — the welcome modal is just the greeting) ──
  function renderHelpInfo(el, close) {
    const T = OrgState.TUNING;
    const days = state.config.seasonDays;
    const claimMin = Math.round(T.CLAIM_TTL_MS / 60000);
    const sec = (icon, title, body) =>
      `<div class="help-sec"><div class="help-h">${icon} ${title}</div>${body}</div>`;
    const p = (t) => `<div class="help-p">${t}</div>`;

    el.innerHTML = close + `<div class="card-title">How to play</div>` +
      `<div class="help-p help-intro">A season-long war for Stanton, fought with real contracts. ` +
      `The board is a game we play on top of Star Citizen — the missions are real, the map, money and ranks are ours.</div>` +

      sec('🏁', 'The goal',
        p(`The season runs ${days} days. Take ground, keep the HQ stores filled, and finish the org's grand project — ` +
          `<b>commissioning the Flagship</b>, then flying its <b>maiden voyage</b> with all hands aboard. That is the triumph, ` +
          `and it closes the season. The opposition is the <b>Director</b>: the system itself, and it hits back every day.`) +
        p(`No flagship? The season still earns its ending — hold most of the map and it's a <b>win</b>, hold real ground and it's a ` +
          `<b>foothold</b>, survive with anything and the org <b>endures</b>. Hold nothing and the Director keeps Stanton. ` +
          `Day ${days} closes the books either way: a final report, season honors, and a closing ceremony.`)) +

      sec('📅', 'How a day works',
        p(`<b>1.</b> Check the right column — the Director's demands and the front-line objectives.`) +
        p(`<b>2.</b> Click a planet that's being contested — the ⚑ marks.`) +
        p(`<b>3.</b> Claim a contract on the left panel, and use one of the ships you've been assigned to complete it.`) +
        p(`<b>4.</b> Run it in the game, as normal.`) +
        p(`<b>5.</b> Come back and <b>submit it</b>. The board updates for everyone.`) +
        p(`The day rolls one full day after the season started — same time of day, every day — and that's when the Director moves.`)) +

      sec('🗺', 'The map',
        p(`Every planet has a control meter, 0–100%. <b>Grey</b> planets are locked. ` +
          `At the first progress they turn <b style="color:#ffb454">amber</b> — a beachhead. At 100% they turn ` +
          `<b style="color:#3fb950">green</b> — secured, held, and paying the org daily.`) +
        p(`Click any planet to see its meter, its resources, why it matters, and the missions on it.`)) +

      sec('⚑', 'Front lines',
        p(`The org attacks up to <b>${T.FRONT_CAP} planets at a time</b> — the ⚑ marks. Anyone can add one while a slot is free; ` +
          `capturing a planet frees its slot.`) +
        p(`Contracts in a front-line region fill that planet's meter. Every planet needs a <b>mix</b> — combat, supply runs, industry — ` +
          `no single playstyle takes ground alone.`) +
        p(`Work anywhere else still counts, but only +${T.OFF_FRONT_GAIN}%. Fight where the flags are.`)) +

      sec('📋', 'Claims',
        p(`<b>Claim</b> a mission to reserve it — it leaves the pool for ${claimMin} minutes so nobody doubles up. ` +
          `It then sits in <b>Your contract</b> on the right; finish it in game and press <b>✓ Submit this contract</b> there, ` +
          `or return it. If you forget, it quietly returns itself.`) +
        p(`Claiming is optional. Anything you flew <b>without</b> claiming goes in through <b>＋ Submit other work</b> ` +
          `under the objectives — same credit, you just pick the region and planet yourself.`) +
        p(`<b>The on-site bonus:</b> if the contract actually happened at the planet you're crediting, tick the box ` +
          `before submitting — it's worth +50%. The board always asks and always takes your word for it; only tick it ` +
          `when it's true.`)) +

      sec('⛏', 'Mining',
        p(`Mining materials for your contract can only be gathered at <b style="color:#ffb454">amber</b> or ` +
          `<b style="color:#3fb950">green</b> planets — combat and supply work opens the beachhead first.`) +
        p(`Mind the noise: mining a contested planet draws the Director's attention there tomorrow.`)) +

      sec('🤖', 'The Director',
        p(`At every day roll the system strikes back — raids on your ground, relief calls, feints. Answer a raid's Defend ` +
          `contracts or the planet's meter slips ${T.RAID_PENALTY}%. It scales with how many of us played yesterday; quiet days, it rests.`) +
        p(`<b>Intel:</b> investigation contracts are never assigned — run them on your own and submit them. ` +
          `A quick case (missing person, a short search) pays 1 intel; a long one (ASD site, research) pays ` +
          `${T.INTEL_DEEP_YIELD}. Say which when you submit it.`) +
        p(`<b>Scouting:</b> spend <b>${T.INTEL_READ_COST} intel</b> to see what's coming in <b>one region</b> tomorrow — ` +
          `"quiet" is an answer too. Each region is its own look, once a day, so intel keeps its worth all season. ` +
          `Hold <b>Cellin</b> and Crusader space is watched for free; build the <b>Sensor Lattice</b> and every region ` +
          `costs 1 instead of 2.`)) +

      sec('🌟', 'Set-pieces & Org Days',
        p(`Every region carries one <b>set-piece op</b> from the Hero Adventures codex: Siege of Orison at Crusader, ` +
          `Hathor at Hurston, Yormandi at microTech, Hyperion at ArcCorp. They start <b>locked</b> — these ops take hours ` +
          `and their own unlock missions, so the org earns its way there.`) +
        p(`To clear the path, the <b>org leadership calls an 📣 Org Day</b> — today or a planned date ahead — from any planet ` +
          `panel in the region, or by letting the board pick. That day the whole org points one direction: ` +
          `<b>${T.ORGDAY_TARGET} contracts</b> in that region before the day ends. Fall short and it stays locked — ` +
          `call another Org Day when the org is ready. One Org Day per day.`) +
        p(`The Director fights the muster: expect <b>pickets</b> that stretch the path by ${T.ORGDAY_CONFRONT_ADD} more contracts, ` +
          `and a <b>feint</b> pulling for ${T.ORGDAY_DRAG_NEED} hauling contracts in another region before day's end — ignore it ` +
          `and the HQ stores bleed.`) +
        p(`Once unlocked, run it together. The organizer records it in the objectives column: the first run surges the region's ` +
          `front +${T.SETPIECE_SURGE}% control, and every run hands the 🌟 medal to everyone who was there. Encore runs are ` +
          `always welcome — the chronicle keeps score.`)) +

      sec('🚀', 'Your ships',
        p(`You never need to buy anything. <b>Ships assigned to you</b> (top right) lists everything you can use — ` +
          `rent at the named city for the shown price, fly, done.`) +
        p(`Promotions are automatic and you can see them coming: <b>Ships assigned to you</b> shows a <b>Working toward</b> ` +
          `bar for each trade you've started — "4 more mining → the org offers you a Prospector". It takes ` +
          `<b>${T.RIDE_THRESHOLD} contracts of that trade per step</b> (${T.RIDE_THRESHOLD}, then ${T.RIDE_THRESHOLD * 2}, ` +
          `then ${T.RIDE_THRESHOLD * 3}); your starting calling begins one step ahead. Fees come from ORG funds — ` +
          `the big ones need an approver's nod.`) +
        p(`<b>Missing a capability?</b> Nobody should watch a contract they can't fly. Fleet → <b>Requisition a ship</b> ` +
          `buys the <b>entry hull of any trade</b> from ORG funds — cargo space, a mining head, a salvage beam, whatever the org ` +
          `is short of. It's yours for the season, like any assigned ship; anything better still comes from flying the work.`) +
        p(`The catch: a rental hub only serves you while the org is <b>fighting in its region</b> — anywhere in Hurston space ` +
          `opens Lorville, ArcCorp space opens Area 18, Crusader space opens Orison, microTech space opens New Babbage ` +
          `(a moon counts — it's the whole region, not just the planet). Spread across Stanton and the motor pool widens; ` +
          `stay in one corner and you fly what that corner stocks.`) +
        p(`See a ship you'd like on another member? Open Fleet and click it — offer a <b>swap</b>, one of yours for it. They decide.`)) +

      sec('🛠', 'The fleet',
        p(`Own a hull you'd lend to the cause? Fleet → <b>add my ships</b> and tap every one you own — pledging is free. ` +
          `The org can then <b>commission</b> a pledged hull into service at its real price in ORG funds, and assign it to a member.`) +
        p(`It stays your ship: tap it again any time to take it back. Withdrawing one that's already in service pulls it from the ` +
          `fleet (the org's commissioning spend is gone), so it's a two-tap confirm.`) +
        p(`If a commissioned hull dies on ops, report it destroyed — the owner recovers it in-game via insurance as normal; ` +
          `the org pays a recommission bill. Salvage your own wreck and the bill halves.`)) +

      sec('💰', 'ORG funds',
        p(`Campaign money — not real aUEC, and your wallet is never touched. Every submitted contract pays the HQ stores, ` +
          `objectives pay a bonus, and every held planet pays daily. It's spent on promotions, requisitions, commissions and projects.`)) +

      sec('🏗', 'Projects & victory',
        p(`Projects are org-authored goals with real gates — funds, materials, and captured ground ("needs a planet with Quantanium"). ` +
          `Each grants the org a lasting board power. The final chain is Keel, Drive, Armor, <b>Commission the Flagship</b> — ` +
          `and then the whole org flies its <b>maiden voyage</b> together. That last flight is what wins the season.`)) +

      sec('📡', 'Sharing the war',
        p(`The war log copies to Discord in one click, and <b>copy map link</b> hands out a live picture of the map that anyone can ` +
          `open — no code, no account. If your organizer wired the channel up, the board posts each day's report there by itself.`)) +

      sec('🎖', 'Org tier',
        p(`Held planets raise the whole org's tier, I → VI. Higher tiers unlock harder contract asks — bounty ranks climb ` +
          `VLRT to ERT, and the top tiers open Gilly 7 and 8 as full org ops.`)) +

      sec('🤝', 'The one rule',
        p(`It's all honor system. Log what you actually flew. And every bonus or power here is <b>board-only</b> — ` +
          `it changes campaign math, never the real game.`));
  }

  // ── Admin — the leadership console (approvers only) ─────────────────────
  function renderAdminInfo(el, close) {
    if (!state.approvers.includes(callsign())) {
      el.innerHTML = close + `<div class="card-title">Admin</div>` +
        `<div class="panel-hint">This page is for the org leadership — approvers are marked ★ on the Members tab.</div>`;
      return;
    }
    const over = state.season && state.season.over;
    const sect = (title) => `<div class="card-title" style="margin-top:12px">${title}</div>`;
    const startDate = new Date(state.config.startedAt)
      .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

    // — Org Days —
    const odNow = state.orgDay;
    const planned = Object.entries(state.orgDays || {}).map(([d, o]) => [+d, o])
      .filter(([d]) => d > state.tick).sort((a, b) => a[0] - b[0]);
    const past = Object.entries(state.orgDays || {}).map(([d, o]) => [+d, o])
      .filter(([d]) => d < state.tick).sort((a, b) => b[0] - a[0]).slice(0, 5);
    const eligible = Object.keys(sysR.regions).filter(rid => sysR.regions[rid].setPiece &&
      !(state.setPieces && state.setPieces[rid]) && !(state.spUnlocked && state.spUnlocked[rid]));
    const openDays = [];
    for (let d = state.tick; d < Math.min(state.tick + 14, state.config.seasonDays); d++) {
      if (!(state.orgDays || {})[d]) openDays.push(d);
    }
    const odRows =
      `<div class="req-row"><span>Today</span><span class="mr-cal">${odNow
        ? `${esc(regionSpace(odNow.region))} — ${odNow.unlocked ? 'path cleared 🌟' : `${odNow.count} / ${odNow.target}`}`
        : 'no Org Day'}</span></div>` +
      planned.map(([d, o]) =>
        `<div class="req-row"><span>📅 ${esc(dayLabel(d))}</span><span class="req-act">${esc(regionSpace(o.region))} ` +
        `<button class="linklike danger" data-od-cancel="${d}">call off</button></span></div>`).join('') +
      (past.length ? past.map(([d, o]) =>
        `<div class="req-row"><span class="proj-locks">day ${d + 1} · ${esc(regionSpace(o.region))}</span>` +
        `<span class="proj-locks">${o.unlocked ? 'unlocked 🌟' : 'closed short'}</span></div>`).join('') : '');
    const odForm = over || state.season.mustering || !eligible.length || !openDays.length
      ? `<div class="panel-hint">${over ? 'Season closed.' : state.season.mustering ? 'The season hasn\'t started yet.' : !eligible.length ? 'Every set-piece is already unlocked or run.' : 'No open days left.'}</div>`
      : `<div class="adm-form"><select class="f-input" id="adm-od-region">${eligible.map(r =>
          `<option value="${r}">${esc(regionSpace(r))} — ${esc((heroFor(sysR.regions[r].setPiece) || {}).name || '?')}</option>`).join('')}</select>` +
        `<select class="f-input" id="adm-od-day">${openDays.map(d =>
          `<option value="${d}">${d === state.tick ? `Today — day ${d + 1}` : dayLabel(d)}</option>`).join('')}</select>` +
        `<button class="btn btn-mini" id="adm-od-call">📣 Call it</button></div>`;

    // — Set-pieces & the voyage —
    const spRows = Object.keys(sysR.regions).filter(rid => sysR.regions[rid].setPiece).map(rid => {
      const h = heroFor(sysR.regions[rid].setPiece);
      const done = state.setPieces && state.setPieces[rid];
      const unlocked = state.spUnlocked && state.spUnlocked[rid];
      let status;
      if (done) status = `<span class="sp-done">✓ run ×${done.runs || 1}</span> <button class="linklike" data-sp-record="${rid}">encore</button>`;
      else if (unlocked) status = `<span class="sp-done">🔓 unlocked</span> <button class="btn btn-mini" data-sp-record="${rid}">record the run</button>`;
      else status = `<span class="proj-locks">locked — needs an Org Day</span>`;
      return `<div class="req-row"><span>${esc(regionSpace(rid))} — <b>${esc(h ? h.name : '?')}</b></span>` +
        `<span class="req-act">${status}</span></div>`;
    }).join('');
    const voyageRow = state.victory
      ? `<div class="req-row"><span>🏆 Maiden voyage</span><span class="sp-done">flown — season won</span></div>`
      : state.finaleReady
        ? `<div class="req-row"><span>🏆 Maiden voyage</span><span class="req-act"><button class="btn btn-mini" id="adm-finale">record the voyage</button></span></div>`
        : '';

    // — Approvers —
    const appRows = state.approvers.map((n, idx) =>
      `<div class="req-row"><span>★ ${esc(disp(n))}${idx === 0 ? ' <span class="proj-locks">(founder)</span>' : ''}</span>` +
      (idx === 0 ? '' : `<button class="linklike danger" data-app-revoke="${esc(n)}">revoke</button>`) + `</div>`).join('');
    const nonApprovers = Object.keys(state.members).filter(n => !state.approvers.includes(n)).sort();
    const grantForm = nonApprovers.length
      ? `<div class="adm-form"><select class="f-input" id="adm-grant">${nonApprovers.map(n => `<option value="${esc(n)}">${esc(disp(n))}</option>`).join('')}</select>` +
        `<button class="btn btn-mini" id="adm-grant-btn">make approver</button></div>`
      : '';

    // — Front lines —
    const frontRows = Object.entries(state.fronts || {}).map(([zid, fr]) => {
      const zn = sysR.regions[state.zones[zid].region].zones[zid].name;
      const sameDay = Math.floor((fr.at - state.config.startedAt) / 86400000) === state.tick;
      const canRemove = fr.by === callsign() || !sameDay || state.zones[zid].held;
      return `<div class="req-row"><span>⚑ ${esc(zn)} <span class="proj-locks">by ${esc(disp(fr.by))}</span></span>` +
        (canRemove
          ? `<button class="linklike danger" data-front-pull="${zid}">pull off</button>`
          : `<span class="proj-locks">locked today</span>`) + `</div>`;
    }).join('') || `<div class="panel-hint">No front lines set.</div>`;

    // — Corrections: the log is append-only, so a mis-filed contract is fixed
    //   by re-filing it, never by deleting anything —
    const fileRows = (state.filed || []).slice().reverse().slice(0, 12).map(f => {
      const what = `${typeWordOf(f.ctype)} · ${zoneLabel(f.region, f.zone)}`;
      const tags = [`day ${f.tick + 1}`];
      if (f.onSite) tags.push('on-site');
      if (f.rmc) tags.push('RMC');
      if (f.cmat) tags.push('CMAT');
      if (f.crew > 1) tags.push(`${f.crew} aboard`);
      if (f.fixed) tags.push('corrected');
      return `<div class="req-row"><span>${f.struck ? '<s>' : ''}${esc(disp(f.by))} — ${esc(what)}${f.struck ? '</s>' : ''} ` +
        `<span class="proj-locks">${esc(tags.join(' · '))}${f.struck ? ' · struck' : ''}</span></span>` +
        `<span class="req-act">${f.struck
          ? `<button class="linklike" data-unstrike="${esc(f.ref)}">put it back</button>`
          : `<button class="linklike" data-fix="${esc(f.ref)}">re-file</button>`}</span></div>`;
    }).join('') || `<div class="panel-hint">No contracts filed yet.</div>`;

    const admCode = (() => {
      const raw = localStorage.getItem(NET_KEY) || '';
      try { const d = OrgNet.readCode(raw); return OrgNet.makeCode(d.cfg, d.path); } catch (e) { return raw; }
    })();
    const netSect = netMode
      ? sect('🔗 Multiplayer') +
        `<div class="panel-hint" style="font-size:12.5px">Anyone with this code plays on this board — share it in your org's Discord. ` +
        `New members open the campaign page and paste it.</div>` +
        `<div class="pl-row" style="margin-top:6px"><input class="f-input" id="adm-code" readonly value="${esc(admCode)}">` +
        `<button class="btn btn-mini" id="adm-code-copy">copy</button></div>` +
        `<div class="f-note" style="margin-top:6px"><a class="linklike" href="org-setup.html">Database rules &amp; organizer guide →</a> ` +
        `(current rules block, webhook how-to, fresh codes)</div>` +
        sect('📡 Battle reports') +
        (state.report
          ? `<div class="panel-hint" style="font-size:12.5px">✓ Wired to Discord (a confirmation was posted to the channel when it connected). ` +
            `Each day's digest posts when the first member opens the board after the day rolls — a silent channel means nobody's playing.</div>` +
            `<button class="linklike" id="adm-report-test">send a test post</button> ` +
            `<button class="linklike danger" id="adm-report-off">disconnect reports</button>`
          : `<div class="panel-hint" style="font-size:12.5px">Post a daily digest to your org's Discord: channel settings → Integrations → ` +
            `Webhooks → New Webhook → copy its URL and paste it here. Wiring sends a confirmation post to the channel — ` +
            `if Discord refuses the URL, nothing is saved. Visible to code-holders only, never the public web.</div>` +
            `<div class="pl-row" style="margin-top:6px"><input class="f-input" id="adm-report-url" placeholder="https://discord.com/api/webhooks/…">` +
            `<button class="btn btn-mini" id="adm-report-on">wire it</button></div>` +
            `<div class="f-note" id="adm-report-note"></div>`)
      : sect('🔗 Multiplayer') +
        `<div class="panel-hint" style="font-size:12.5px">This is the local demo — one browser only. ` +
        `<a class="linklike" href="org-setup.html">Set up your org's shared campaign →</a></div>`;
    el.innerHTML = close + `<div class="card-title">Admin — leadership console</div>` +
      `<div class="panel-hint" style="font-size:12.5px">${esc(state.config.name || 'Org Campaign')} · started ${esc(startDate)} · ` +
      `${state.config.seasonDays}-day season · seed ${esc(String(state.config.seed || '—'))}</div>` +
      netSect +
      sect('📣 Org Days') + odRows + odForm +
      sect('🌟 Set-pieces') + spRows + voyageRow +
      sect('★ Approvers') + appRows + grantForm +
      approvalsHtml() +
      sect('⚑ Front lines') + frontRows +
      sect('✎ Filed contracts') +
      `<div class="panel-hint" style="font-size:12.5px">Someone logged the wrong thing? Re-file it. ` +
      `The meters, the war chest and their record all recompute — the credit stays with whoever flew it, on the day they flew it.</div>` +
      fileRows;

    const repOn = el.querySelector('#adm-report-on');
    if (repOn) repOn.addEventListener('click', () => {
      const url = $('adm-report-url').value.trim();
      const note = $('adm-report-note');
      if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) {
        note.textContent = '⚠ That is not a Discord webhook URL — it starts with https://discord.com/api/webhooks/…';
        return;
      }
      // prove the pipe before saving anything: Discord must accept a post first
      repOn.disabled = true;
      repOn.textContent = 'testing…';
      note.textContent = '';
      postToDiscord(url,
        `📡 **${state.config.name || 'Org Campaign'}** — battle reports are now wired to this channel. ` +
        `Daily digests land here as each campaign day closes. (Connection test — it worked.)`)
        .then(() => {
          store.append(OrgState.newEvent('report.config', callsign(), { webhook: url }));
        })
        .catch(() => {
          repOn.disabled = false;
          repOn.textContent = 'wire it';
          note.textContent = '⚠ Discord refused that webhook — check the URL, or the webhook may have been deleted. Nothing was saved.';
        });
    });
    const repTest = el.querySelector('#adm-report-test');
    if (repTest) repTest.addEventListener('click', () => {
      repTest.textContent = 'sending…';
      postToDiscord(state.report.webhook, `📡 Test post — battle reports are wired to this channel and working.`)
        .then(() => { repTest.textContent = '✓ posted — check the channel'; })
        .catch(() => { repTest.textContent = '⚠ failed — the webhook may be deleted; reconnect it'; });
    });
    const repOff = el.querySelector('#adm-report-off');
    if (repOff) repOff.addEventListener('click', (e) => armConfirm(e.currentTarget, () =>
      store.append(OrgState.newEvent('report.config', callsign(), { clear: true })), 'disconnect — sure?'));
    const codeCopy = el.querySelector('#adm-code-copy');
    if (codeCopy) codeCopy.addEventListener('click', () => {
      navigator.clipboard.writeText($('adm-code').value).then(() => {
        codeCopy.textContent = 'copied ✓';
        setTimeout(() => { if (codeCopy.isConnected) codeCopy.textContent = 'copy'; }, 1600);
      }).catch(() => { $('adm-code').select(); });
    });
    const odCall = el.querySelector('#adm-od-call');
    if (odCall) odCall.addEventListener('click', () =>
      store.append(OrgState.newEvent('orgday.declare', callsign(), {
        region: $('adm-od-region').value, day: +$('adm-od-day').value,
      })));
    el.querySelectorAll('[data-od-cancel]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('orgday.cancel', callsign(), { day: +b.dataset.odCancel }))));
    el.querySelectorAll('[data-sp-record]').forEach(b => b.addEventListener('click', () =>
      showSetPieceModal(b.dataset.spRecord)));
    const fin = el.querySelector('#adm-finale');
    if (fin) fin.addEventListener('click', showFinaleModal);
    el.querySelectorAll('[data-app-revoke]').forEach(b => b.addEventListener('click', () =>
      armConfirm(b, () => store.append(OrgState.newEvent('role.approver', callsign(),
        { callsign: b.dataset.appRevoke, grant: false })), 'revoke — sure?')));
    const grantBtn = el.querySelector('#adm-grant-btn');
    if (grantBtn) grantBtn.addEventListener('click', () =>
      store.append(OrgState.newEvent('role.approver', callsign(), { callsign: $('adm-grant').value })));
    bindApprovalButtons(el);
    el.querySelectorAll('[data-front-pull]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('front.remove', callsign(), { zone: b.dataset.frontPull }))));
    el.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', () => {
      const f = (state.filed || []).find(x => x.ref === b.dataset.fix);
      if (f) showFixModal(f);
    }));
    el.querySelectorAll('[data-unstrike]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('contract.amend', callsign(), { ref: b.dataset.unstrike, void: false }))));
  }

  // ── Ships live OUTSIDE contracts — the Your Ship card + Fleet tab carry them
  const fmtDay = n => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);

  function renderRide() {
    const el = $('ride-card');
    const me = state.members[callsign()];
    if (!me) { el.style.display = 'none'; return; }
    el.style.display = '';
    const hangar = me.hangar || [];
    const rows = hangar.map(h => h.kind === 'hull'
      ? `<div class="ride-cur">🚀 <b>${esc(h.name)}</b> — ${esc(disp(h.owner) || 'org')}'s hull, org-assigned ` +
        `<button class="linklike danger" data-lost="${h.fleetId}">report destroyed</button></div>`
      : `<div class="ride-cur">🚀 <b>${esc(h.name)}</b>${h.city ? ` — rent ~${fmtDay(h.price)} aUEC/day at ${esc(h.city)}` : ''}</div>`
    ).join('');
    // what you're working toward, so a promotion is never a surprise
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const typeWords = { 'ship-combat': 'ship combat', 'ground-combat': 'ground combat',
      hauling: 'hauling', mining: 'mining', salvage: 'salvage', investigation: 'investigation' };
    const next = (me.nextRides || []).slice(0, 2).map(n => {
      const what = n.types.map(t => typeWords[t] || t).join(' or ');
      const art = /^[AEIOU8]/i.test(n.ride.name) ? 'an' : 'a';
      return `<div class="next-ride"><div class="nr-top">` +
        `<b>${n.left} more ${esc(what)}</b> → the org offers you ${art} <b>${esc(n.ride.name)}</b></div>` +
        `<div class="m-bar nr-bar"><div class="m-fill" style="width:${Math.round(n.have / n.need * 100)}%"></div></div>` +
        `<div class="nr-sub">${n.have} / ${n.need} ${esc(n.lineName)} contracts · unlock fee ${fmtF(n.fee)} ORG funds</div></div>`;
    }).join('');
    el.innerHTML = `<div class="card-title ct-row">Ships assigned to you <button class="linklike" id="ride-swap">swap ships</button></div>` +
      (rows || `<div class="ride-cur">No ships yet — promotions will assign them.</div>`) +
      (next ? `<div class="card-title" style="margin-top:10px">Working toward</div>` + next : '');
    $('ride-swap').addEventListener('click', () => setInfo('fleet'));
    el.querySelectorAll('[data-lost]').forEach(b => b.addEventListener('click', () =>
      armConfirm(b, () => store.append(OrgState.newEvent('fleet.lost', callsign(), { fleetId: +b.dataset.lost })),
        'destroyed — sure?')));
  }

  // ── Concrete contract roll ──────────────────────────────────────────────
  // One explicit ask per push step, Story-mode style: a rolled TYPE, a real
  // provider + category, and the region's hub. Deterministic per (push, step)
  // so every member sees the same instruction.
  function rollContract(p, index) {
    const rand = OrgState.rng(state.config.seed, p.id, 'roll', String(index));
    const type = p.types[Math.floor(rand() * p.types.length)];
    const provs = Object.values(D.providers.providers).filter(pr =>
      pr.path === 'legal' && pr.byType[type] && pr.byType[type].includes(state.config.system));
    const prov = provs.length ? provs[Math.floor(rand() * provs.length)] : null;
    const hub = sysR.regions[p.region].name;
    const restock = (D.providers.restockStations[state.config.system] || {})[hub];
    const haulDir = haulDirFor(p.region);
    // ship-combat difficulty follows the ORG TIER (collective performance):
    // BHG asks name the risk rank; Gilly rolls a tier, 7/8 = org ops at the top
    let rank = null, gillyTier = null;
    if (type === 'ship-combat' && state.orgTier && prov) {
      if (prov.ladder) {
        const allowed = (prov.ladder.tiers || []).map(t2 => t2.t);
        if (state.orgTier.gillyMax >= 7) allowed.push(7);
        if (state.orgTier.gillyMax >= 8) allowed.push(8);
        gillyTier = allowed[Math.floor(rand() * allowed.length)] || null;
      } else if (prov.name === 'Bounty Hunters Guild') {
        rank = state.orgTier.rank;
      }
    }
    return { type, typeName: (D.providers.types[type] || {}).name || type, prov, hub, restock, haulDir, rank, gillyTier };
  }

  function step2Text(rc) {
    if (!rc.prov) return `Take a ${esc(rc.typeName || rc.ctype || '')} contract off the board`;
    if (rc.gillyTier) {
      return `Take <b>Gilly Flight School</b>'s <b>Tier ${rc.gillyTier}</b> contract (<b>${esc(rc.prov.tab || rc.tab || 'Mercenary')}</b> category)` +
        (rc.gillyTier >= 7 ? ' — an org op, bring a crew' : '');
    }
    if (rc.rank) {
      return `Take a <b>${esc(rc.rank)}</b> bounty from <b>Bounty Hunters Guild</b> (<b>${esc(rc.prov.tab || rc.tab || 'Bounty Hunter')}</b> category)`;
    }
    const nm = rc.prov.name || rc.prov;
    return `Take a <b>${esc(nm)}</b> contract from the <b>${esc(rc.prov.tab || rc.tab || '')}</b> category${rc.type === 'hauling' && rc.haulDir ? ` — ${esc(rc.haulDir)}` : ''}`;
  }

  function repNote(rc) {
    if (rc.rank && rc.rank !== 'VLRT') return `<div class="pr-repnote">Risk tier locked for you? Run lower bounties to rep up to it.</div>`;
    if (rc.gillyTier && rc.gillyTier > 1) return `<div class="pr-repnote">Locked? Clear the lower Gilly tiers to unlock it.</div>`;
    return '';
  }

  // Required vs bonus, said out loud on every objective. Contract boards
  // randomise across a REGION, so that is the whole ask; the zone is only where
  // the credit lands. Read the zone as the requirement and you go hunting for a
  // contract that names the moon, find none, and conclude the day is stalled.
  function creditNote(rid, zid, submitting, ctype) {
    // salvage is the one trade with nothing to travel to: wrecks and panels turn
    // up where they turn up. Its bonus rides on the HAUL instead of the place.
    const bonus = ctype === 'salvage'
      ? ` Wrecks drift where they fall, so there is nothing to fly to — what pays extra is what you bring back.`
      : ` Work that happens there is worth +50%.`;
    return `<div class="pr-credit">★ Anywhere in <b>${esc(regionSpace(rid))}</b> counts — the credit lands on ` +
      `<b>${esc(zoneLabel(rid, zid))}</b> either way.` + (submitting ? '' : bonus) + `</div>`;
  }

  // Salvage asks what you brought back, never where you were. CMAT fills fast;
  // RMC is the long haul, so it takes the bonus — a flat one, because there is
  // no honest way to ask how many SCU came home.
  function haulPickerHtml(prefix, cur) {
    const on = (k) => (cur && cur[k] ? ' checked' : '');
    return `<div class="onsite-ask"><div class="oa-q">What did you bring back?</div>` +
      `<label class="f-check" style="margin:6px 0 0"><input type="checkbox" id="${prefix}-cmat"${on('cmat')}>` +
      `<span><b>CMAT</b> — the quick fill</span></label>` +
      `<label class="f-check" style="margin:6px 0 0"><input type="checkbox" id="${prefix}-rmc"${on('rmc')}>` +
      `<span><b>RMC</b> — the long haul, worth <b>+50% control</b> and an extra component</span></label>` +
      `<div class="f-note">Tick both if you filled up on both. Neither still banks the contract.</div></div>`;
  }
  const haulFrom = (prefix) => ({
    cmat: !!($(prefix + '-cmat') && $(prefix + '-cmat').checked) || undefined,
    rmc: !!($(prefix + '-rmc') && $(prefix + '-rmc').checked) || undefined,
  });

  // ── Today's objectives (derived pushes) ─────────────────────────────────
  function fmtLeft(ms) {
    if (ms <= 0) return 'expired';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  }

  function buildPushRow(p) {
    const region = sysR.regions[p.region];
    const claimed = p.claimed || 0;
    const myClaim = Object.values(state.claims || {}).some(c => c.by === callsign() && c.effective === 'active');
    const pips = Array.from({ length: p.count }, (_, i) =>
      `<span class="pip${i < p.done ? ' on' : i < p.done + claimed ? ' mid' : ''}"></span>`).join('');
    const slotsLeft = p.count - p.done - claimed;
    const attribution = p.director ? `${esc(p.faction)} likely behind it · ${esc(p.stake)} · ` : '';
    let roll = '';
    if (!p.completed) {
      const rc = rollContract(p, p.done);
      roll = `<div class="pr-roll"><span class="pr-rollnum">Contract ${p.done + 1} of ${p.count}</span> · <b>${esc(rc.typeName)}</b>` +
        `<div class="pr-steps">1 — Travel to <b>${esc(rc.hub)} space</b>${rc.restock ? ` <span class="pr-restock">(restock &amp; rearm at ${esc(rc.restock)})</span>` : ''}<br>` +
        `2 — ${step2Text(rc)}</div>` +
        repNote(rc) +
        (rc.type === 'mining' ? `<div class="mine-warn">⛏ Mining materials for your contract can only be gathered at <b>amber</b> or <b>green</b> planets.</div>` : '') +
        creditNote(p.region, p.zone, false, rc.type) +
        `</div>`;
    }
    // a finished objective is not a wall. Work credited to a front pays the
    // same 2% whether or not it carries an objective tag — only the +5% and
    // the funds bonus ride on the objective — but "✓ Complete" reads as
    // "closed for the day", and the way to log more is hidden in a side button.
    // Skipped once the bucket is at its ceiling: there the full bar and the
    // objective's absence tomorrow already say it.
    let more = '';
    if (p.completed && !p.director) {
      const zSt = state.zones[p.zone];
      const cap = D.regions.archetypes[region.zones[p.zone].archetype].recipe[p.bucket] || 0;
      const room = zSt ? Math.round(cap - Math.min(zSt.cats[p.bucket], cap)) : 0;
      if (room > 0) {
        more = `<div class="pr-more">Daily Objective Bonus complete — more ${esc(p.bucket)} at ` +
          `<b>${esc(zoneLabel(p.region, p.zone))}</b> still counts (${room}% to its ceiling). ` +
          `Log it with <button class="linklike" data-logmore="1">Submit other work</button>.</div>`;
      }
    }
    return `<div class="push-row k-${p.kind}${p.completed ? ' done' : ''}">` +
      `<div class="pr-top"><span class="pr-kind">${p.director ? '⚠ ' : ''}${p.label}</span>` +
      `<span class="pr-title">${esc(region.zones[p.zone].name)}</span>` +
      `<span class="pr-region">${esc(region.name)} space${p.carried ? ' · carried' : ''}</span></div>` +
      `<div class="pr-detail">${attribution}${p.scarce ? 'scarce ×1.5 · ' : ''}+${p.bonus}% ${p.bucket} when all ${p.count} land${p.types.includes('mining') && state.zones[p.zone] && !state.zones[p.zone].held ? ' · ⚠ mining hot ground draws raids' : ''} · ${fmtLeft(p.expiresAt - Date.now())}</div>` +
      roll +
      more +
      `<div class="pr-foot">${pips}${p.completed
        ? '<span class="pr-done">✓ Daily Objective Bonus</span>'
        : slotsLeft <= 0
          ? '<span class="pr-taken">all claimed — in progress</span>'
          : myClaim
            ? '<span class="pr-taken" title="Submit or return your active contract first">you have an active contract</span>'
            : `<button class="btn btn-mini" data-claim="${p.id}">Claim contract</button>`}</div>` +
      `</div>`;
  }

  function bindClaimButtons(container) {
    container.querySelectorAll('[data-logmore]').forEach(b =>
      b.addEventListener('click', () => showLogModal()));
    container.querySelectorAll('[data-claim]').forEach(b =>
      b.addEventListener('click', () => {
        const p = (state.pushes || []).find(x => x.id === b.dataset.claim);
        if (!p) return;
        const rc = rollContract(p, p.done + (p.claimed || 0));
        const claimId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        store.append(OrgState.newEvent('contract.claim', callsign(), {
          claimId, pushId: p.id, ctype: rc.type, region: p.region, zone: p.zone,
          roll: {
            typeName: rc.typeName, prov: rc.prov ? rc.prov.name : null, tab: rc.prov ? rc.prov.tab : null,
            hub: rc.hub, restock: rc.restock || null, dir: rc.type === 'hauling' ? rc.haulDir : null,
            rank: rc.rank || null, gillyTier: rc.gillyTier || null,
          },
        }));
      }));
  }

  function renderPushes() {
    const el = $('pushes-card');
    // mustering: the war waits for the starting gun
    if (state.season && state.season.mustering) {
      $('btn-log').style.display = 'none';
      const iApprove = state.approvers.includes(callsign());
      const members = Object.keys(state.members).length;
      const pledged = (state.fleet || []).length;
      el.innerHTML = `<div class="card-title">Mustering</div>` +
        `<div class="orgday"><div class="od-head">⚑ THE SEASON HASN'T STARTED</div>` +
        `<div class="od-line">${members} member${members === 1 ? '' : 's'} enlisted · ${pledged} hull${pledged === 1 ? '' : 's'} pledged · ` +
        `a ${state.config.seasonDays}-day season, armed and waiting.</div>` +
        (iApprove
          ? `<div class="mc-actions" style="margin-top:8px"><button class="btn btn-primary" id="btn-gun">🚀 Start the season — day 1 begins now</button></div>` +
            (netMode ? `<div class="panel-hint" style="margin-top:6px">Share the join code (Admin → 🔗 Multiplayer) so everyone's aboard before you fire.</div>` : '')
          : `<div class="panel-hint" style="margin-top:6px">Set your calling, pledge your ships, swap around — the war starts when leadership fires the gun.</div>`) +
        `</div>`;
      const gun = el.querySelector('#btn-gun');
      if (gun) gun.addEventListener('click', (e) => armConfirm(e.currentTarget,
        () => store.append(OrgState.newEvent('season.start', callsign(), {})), 'day 1 starts now — sure?'));
      return;
    }
    // season over: the objectives column becomes the close-out card
    if (state.season && state.season.over) {
      const e = state.season.ending;
      const iApprove = state.approvers.includes(callsign());
      $('btn-log').style.display = 'none';
      const nextBtn = state.nextSeason
        ? `<button class="btn btn-primary" id="btn-nextjoin">→ Move to the new season</button>`
        : netMode
          ? (iApprove ? `<button class="btn" id="btn-newseason-net">Call the next season</button>` : '')
          : `<button class="btn" id="btn-newseason">Start a new season</button>`;
      el.innerHTML = `<div class="card-title">Season closed</div>` +
        `<div class="ending tone-${e.tone}"><div class="ending-head">${e.icon} ${esc(e.title)}</div>` +
        `<div class="ending-line">${esc(e.line)}</div></div>` +
        (state.nextSeason ? `<div class="panel-hint" style="margin-top:8px">📣 ${esc(disp(state.nextSeason.by))} has called the next season — the org is moving camp.</div>` : '') +
        `<div class="mc-actions" style="margin-top:10px">` +
        `<button class="btn${state.nextSeason ? '' : ' btn-primary'}" id="btn-report">Read the final report</button>` +
        nextBtn + `</div>` +
        `<div class="panel-hint" style="margin-top:8px">The map and the war log stay up — the season's monument. Export the log to keep it forever.</div>`;
      el.querySelector('#btn-report').addEventListener('click', showFinalReport);
      const bNew = el.querySelector('#btn-newseason');
      if (bNew) bNew.addEventListener('click', (ev2) => armConfirm(ev2.currentTarget, startNewSeason, 'clears the demo — sure?'));
      const bNet = el.querySelector('#btn-newseason-net');
      if (bNet) bNet.addEventListener('click', (ev2) => armConfirm(ev2.currentTarget, callNextSeason, 'new code, fresh map — sure?'));
      const bJoin = el.querySelector('#btn-nextjoin');
      if (bJoin) bJoin.addEventListener('click', () => {
        localStorage.setItem(NET_KEY, state.nextSeason.code);
        localStorage.removeItem(WELCOME_KEY);
        location.reload();
      });
      return;
    }
    $('btn-log').style.display = '';
    // the Org Day rail: the maiden voyage, unlocked ops waiting to be recorded,
    // today's rally, every planned day ahead, or the invitation to call one
    const iApprove = state.approvers.includes(callsign());
    const heroNameFor = (rid) => {
      const h = heroFor(sysR.regions[rid].setPiece);
      return h ? h.name : 'the set-piece';
    };
    let odBlock = '';
    if (state.finaleReady && !state.victory) {
      odBlock += `<div class="orgday finale"><div class="od-head">🏆 THE FLAGSHIP IS BUILT</div>` +
        `<div class="od-line">One flight remains — the <b>maiden voyage</b>. Muster everyone and run it together.` +
        (iApprove
          ? ` <button class="btn btn-mini" id="btn-finale">✓ We flew it — record the voyage</button>`
          : ` Your organizer records the voyage once it's flown.`) +
        `</div></div>`;
    }
    odBlock += Object.keys(state.spUnlocked || {})
      .filter(rid => !(state.setPieces && state.setPieces[rid]))
      .map(rid => `<div class="orgday od-unlocked"><div class="od-line">🌟 <b>${esc(heroNameFor(rid))}</b> is unlocked — run it together!` +
        (iApprove
          ? ` <button class="btn btn-mini" data-sp-record="${rid}">✓ We ran it — record it</button>`
          : ` Your organizer records it once it's done.`) +
        `</div></div>`).join('');
    const od = state.orgDay;
    if (od && !od.unlocked && !(state.spUnlocked && state.spUnlocked[od.region])) {
      const rn = sysR.regions[od.region].name;
      odBlock += `<div class="orgday"><div class="od-head">📣 ORG DAY — ${esc(rn)} space</div>` +
        `<div class="od-line">${od.count} / ${od.target} contracts in ${esc(rn)} space today — clear the path to <b>${esc(heroNameFor(od.region))}</b>.</div>` +
        `<div class="m-bar od-bar"><div class="m-fill" style="width:${Math.min(100, od.count / od.target * 100)}%"></div></div>` +
        (od.extra ? `<div class="od-line od-threat">⚔ The Director threw pickets in the way — the path grew by ${od.extra}.</div>` : '') +
        (od.drag && !od.drag.met
          ? `<div class="od-line od-threat">⚠ Feint: ${od.drag.need - od.drag.done} hauling contract${od.drag.need - od.drag.done === 1 ? '' : 's'} in ${esc(sysR.regions[od.drag.region].name)} space before day's end, or the HQ stores bleed.</div>`
          : '') +
        (od.drag && od.drag.met ? `<div class="od-line">✓ The feint collapsed — the ${esc(sysR.regions[od.drag.region].name)} convoys got through.</div>` : '') +
        `</div>`;
    }
    const future = Object.entries(state.orgDays || {}).map(([d, o]) => [+d, o])
      .filter(([d]) => d > state.tick).sort((a, b) => a[0] - b[0]);
    for (const [d, o] of future) {
      odBlock += `<div class="orgday od-sched"><div class="od-head">📅 ORG DAY PLANNED — ${esc(dayLabel(d))}</div>` +
        `<div class="od-line">All wings to <b>${esc(sysR.regions[o.region].name)} space</b> — set by ${esc(disp(o.by))}.` +
        (iApprove ? ` <button class="linklike danger" data-od-cancel="${d}">call it off</button>` : '') +
        `</div></div>`;
    }
    if (!od && !future.length) {
      const eligible = Object.keys(sysR.regions).filter(rid => sysR.regions[rid].setPiece &&
        !(state.setPieces && state.setPieces[rid]) && !(state.spUnlocked && state.spUnlocked[rid]));
      if (iApprove && eligible.length) {
        odBlock += `<div class="orgday od-idle">📣 No Org Day planned — call one from a planet panel, or ` +
          `<button class="linklike" id="od-roll">let the board pick</button></div>`;
      }
    }
    const ps = state.pushes || [];
    const frontZones = Object.keys(state.fronts || {});
    // the right column carries the urgent stuff; each front planet carries its own missions
    const urgent = ps.filter(p => p.director || p.carried);
    const openAt = (z) => ps.filter(p => !p.director && p.zone === z && !p.completed)
      .reduce((n, p) => n + Math.max(0, p.count - p.done - (p.claimed || 0)), 0);
    let body;
    if (!urgent.length && !frontZones.length) {
      body = `<div class="panel-hint">Pick the front lines — select a zone and plant the ⚑ — and the planets start offering work.</div>`;
    } else {
      const frontSum = frontZones.map(z => {
        const zs2 = state.zones[z];
        if (!zs2) return '';
        const zn = sysR.regions[zs2.region].zones[z].name;
        const n = openAt(z);
        return `<div class="front-sum" data-zoom="${z}">⚑ <b>${esc(zn)}</b>` +
          `<span class="fs-open">${n ? `${n} contract${n === 1 ? '' : 's'} open — click to view` : 'all claimed or done today'}</span></div>`;
      }).join('');
      body = urgent.map(buildPushRow).join('') +
        (frontSum ? `<div class="card-title" style="margin-top:${urgent.length ? '12px' : '0'}">Front lines</div>${frontSum}` : '');
    }
    // Scouting: intel buys a look at ONE region's tomorrow, so it stays worth earning
    const dir = state.director;
    if (dir) {
      const scouted = dir.scouted || [];
      const rows = Object.entries(sysR.regions).map(([rid, r]) => {
        const cost = (dir.scoutCosts || {})[rid];
        if (scouted.includes(rid)) {
          const here = (dir.telegraph || []).filter(m => m.region === rid);
          const what = here.length
            ? here.map(m => m.kind === 'raid'
              ? `a strike on <b>${esc(zoneLabel(m.region, m.zone))}</b>`
              : `convoys going missing`).join(', and ')
            : 'quiet';
          return `<div class="scout-row done"><span>${esc(regionSpace(rid))}</span>` +
            `<span>${what}${cost === 0 ? ' <span class="proj-locks">· watched free</span>' : ''}</span></div>`;
        }
        return `<div class="scout-row"><span>${esc(regionSpace(rid))}</span>` +
          (state.chest.intel >= cost
            ? `<button class="btn btn-mini" data-scout="${rid}">Scout — ${cost} intel</button>`
            : `<span class="proj-locks">${cost} intel</span>`) + `</div>`;
      }).join('');
      // scouting has to end in an instruction, or it's just trivia
      const found = dir.telegraph || [];
      const raids = found.filter(m => m.kind === 'raid');
      body += `<div class="telegraph"><div class="tg-head">🛰 Scout the Director — tomorrow's move, one region at a time</div>` +
        rows +
        (found.length
          ? `<div class="tg-plan">⚔ <b>Tomorrow's orders:</b> ` +
            (raids.length
              ? `be in ${raids.map(m => esc(regionSpace(m.region))).join(' and ')} when the day rolls — ` +
                `${OrgState.TUNING.PUSH_COUNT} combat contracts there breaks the raid before it costs you ` +
                `${OrgState.TUNING.RAID_PENALTY}% control.`
              : `haulers wanted — answering the relief call pays the HQ stores instead of draining them.`) +
            `</div>`
          : '') +
        (scouted.length && !found.length
          ? `<div class="f-note" style="margin-top:4px">Nothing coming where you looked — spend tomorrow taking ground.</div>` : '') +
        (scouted.length ? '' : `<div class="f-note" style="margin-top:4px">Intel comes from investigation contracts — never assigned, run them on your own.</div>`) +
        `</div>`;
    }
    el.innerHTML = odBlock + `<div class="card-title">Today's objectives</div>${body}`;
    bindClaimButtons(el);
    el.querySelectorAll('[data-scout]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('intel.read', callsign(), { region: b.dataset.scout }))));
    const rollBtn = el.querySelector('#od-roll');
    if (rollBtn) rollBtn.addEventListener('click', () => {
      const eligible = Object.keys(sysR.regions).filter(rid => sysR.regions[rid].setPiece &&
        !(state.setPieces && state.setPieces[rid]) && !(state.spUnlocked && state.spUnlocked[rid])).sort();
      if (!eligible.length) return;
      const rand = OrgState.rng(state.config.seed, state.tick, 'orgday');
      showOrgDayModal(eligible[Math.floor(rand() * eligible.length)]);
    });
    el.querySelectorAll('[data-sp-record]').forEach(b => b.addEventListener('click', () =>
      showSetPieceModal(b.dataset.spRecord)));
    const fin = el.querySelector('#btn-finale');
    if (fin) fin.addEventListener('click', showFinaleModal);
    el.querySelectorAll('[data-od-cancel]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('orgday.cancel', callsign(), { day: +b.dataset.odCancel }))));
    el.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => {
      selected = b.dataset.zoom;
      infoView = 'zone';
      renderMap(); renderInfo(); updateTabs();
    }));
  }

  // Who else was on the contract: the war banks it once, but everyone who flew
  // it gets the personal credit — tallies, medals, promotion progress.
  function crewPickerHtml(id) {
    const others = Object.keys(state.members).filter(n => n !== callsign() && !state.members[n].spectator).sort();
    if (!others.length) return '';
    return `<label class="f-label">Anyone fly it with you?</label>` +
      `<div class="sp-parts" id="${id}">` +
      others.map(n => `<label class="f-check"><input type="checkbox" data-crew="${esc(n)}"> ${esc(disp(n))}</label>`).join('') +
      `</div><div class="f-note">They each get the contract on their record. The org still banks one contract.</div>`;
  }
  const crewFrom = (root) => [...root.querySelectorAll('[data-crew]')].filter(c => c.checked).map(c => c.dataset.crew);

  // ── Your contract (the active claim — persistent card, never a modal) ───
  let mcTimerHandle = null;
  function renderMyContract() {
    const el = $('my-contract');
    if (mcTimerHandle) { clearInterval(mcTimerHandle); mcTimerHandle = null; }
    if (state.season && state.season.over) { el.style.display = 'none'; return; }
    const found = Object.entries(state.claims || {}).find(([, c]) => c.by === callsign() && c.effective === 'active');
    if (!found) { el.style.display = 'none'; return; }
    const [cid, c] = found;
    el.style.display = '';
    const region = sysR.regions[c.region];
    const zoneName = region && region.zones[c.zone] ? region.zones[c.zone].name : c.zone;
    const roll = c.roll || {};
    // haulDir is re-derived, not read from the claim: a claim taken before the
    // wording was fixed would otherwise keep showing the old ambiguous line
    const rcLike = { prov: roll.prov ? { name: roll.prov, tab: roll.tab } : null, tab: roll.tab, typeName: roll.typeName, ctype: c.ctype, type: c.ctype, haulDir: haulDirFor(c.region), rank: roll.rank, gillyTier: roll.gillyTier };
    const steps =
      `1 — Travel to <b>${esc((roll.hub || (region ? region.name : '')) + ' space')}</b>${roll.restock ? ` <span class="pr-restock">(restock &amp; rearm at ${esc(roll.restock)})</span>` : ''}<br>` +
      `2 — ${step2Text(rcLike)}`;
    el.innerHTML =
      `<div class="card-title ct-row">Your contract <span class="mc-timer" id="mc-timer"></span></div>` +
      `<div class="mc-head"><b>${esc(roll.typeName || c.ctype)}</b> · ${esc(zoneName)} — ${esc(region ? region.name : c.region)} space</div>` +
      `<div class="pr-steps">${steps}</div>` +
      repNote(rcLike) +
      (c.ctype === 'mining' ? `<div class="mine-warn">⛏ Mining materials for your contract can only be gathered at <b>amber</b> or <b>green</b> planets.</div>` : '') +
      creditNote(c.region, c.zone, true, c.ctype) +
      (c.ctype === 'salvage'
        ? haulPickerHtml('mc')
        : `<div class="onsite-ask"><label class="f-check" style="margin:0"><input type="checkbox" id="mc-onsite">` +
          `<span>Tick if the contract itself happened <b>at ${esc(zoneName)}</b> — worth +50%.</span></label></div>`) +
      crewPickerHtml('mc-crew') +
      `<div class="mc-actions"><button class="btn btn-primary" id="mc-done">✓ Submit this contract</button>` +
      `<button class="btn btn-ghost" id="mc-return">↩ Return to pool</button></div>` +
      `<div class="f-note" id="mc-ttl"></div>`;
    const tick = () => {
      const t = $('mc-timer');
      if (!t) return;
      const ms = Date.now() - c.at;
      t.textContent = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
      const left = OrgState.TUNING.CLAIM_TTL_MS - ms;
      $('mc-ttl').textContent = left > 0
        ? `Auto-returns to the pool in ${Math.ceil(left / 60000)}m if not submitted.`
        : 'Timed out — it may be back in the pool, but signing off still counts.';
    };
    tick();
    mcTimerHandle = setInterval(tick, 1000);
    $('mc-done').addEventListener('click', () => {
      const haul = c.ctype === 'salvage' ? haulFrom('mc') : {};
      store.append(OrgState.newEvent('contract.done', callsign(), {
        region: c.region, zone: c.zone, ctype: c.ctype,
        onSite: ($('mc-onsite') && $('mc-onsite').checked) || undefined,
        cmat: haul.cmat, rmc: haul.rmc,
        crew: crewFrom($('my-contract')).length ? crewFrom($('my-contract')) : undefined,
        pushId: c.pushId || undefined, claimId: cid,
      }));
    });
    $('mc-return').addEventListener('click', () => {
      store.append(OrgState.newEvent('contract.abandon', callsign(), { claimId: cid }));
    });
  }

  // ── Log-a-contract modal (optionally prefilled by a push + its roll) ────
  function showLogModal(push, roll) {
    const regionOpts = push
      ? `<option value="${push.region}">${esc(regionSpace(push.region))}</option>`
      : Object.entries(sysR.regions)
        .map(([rid]) => `<option value="${rid}">${esc(regionSpace(rid))}</option>`).join('');
    const banner = push
      ? `<div class="push-banner">Counts toward: ${push.label} ${esc(zoneLabel(push.region, push.zone))} (${push.done}/${push.count})` +
        (roll ? `<br>The ask: <b>${esc(roll.typeName)}</b>${roll.prov ? ` — ${esc(roll.prov.name)}, ${esc(roll.prov.tab)} category, in ${esc(regionSpace(push.region))}` : ''}` : '') +
        `</div>`
      : '';
    openModal(
      `<h2>Submit other work</h2>` +
      `<div class="m-sub">For work you did <b>without claiming it here</b> — anything you flew on your own. (A contract you claimed is submitted from the <b>Your contract</b> card instead.) Work is asked per region; you choose where the gains land.</div>` +
      banner +
      `<label class="f-label">Region you worked in</label><select class="f-select" id="lc-region" ${push ? 'disabled' : ''}>${regionOpts}</select>` +
      `<label class="f-label">Contract type</label><select class="f-select" id="lc-type"></select>` +
      `<div class="f-note" id="lc-scarce" style="display:none">Scarce work in this region — worth ×1.5.</div>` +
      `<label class="f-label" id="lc-zone-label">Apply the gains to</label><select class="f-select" id="lc-zone"></select>` +
      `<div class="f-note" id="lc-mine-help" style="display:none"></div>` +
      `<div class="f-note" id="lc-inv-note" style="display:none"></div>` +
      `<div id="lc-deep-wrap" style="display:none"><label class="f-label">Which kind?</label>` +
      `<select class="f-select" id="lc-deep">` +
      `<option value="">Missing person, quick search — 1 intel</option>` +
      `<option value="1">ASD site, research, long investigation — ${OrgState.TUNING.INTEL_DEEP_YIELD} intel</option>` +
      `</select></div>` +
      `<div class="f-check" id="lc-onsite-wrap"><input type="checkbox" id="lc-onsite">` +
      `<span id="lc-onsite-label">The contract itself was at this zone (+50%)</span></div>` +
      `<div id="lc-haul-wrap" style="display:none">${haulPickerHtml('lc')}</div>` +
      crewPickerHtml('lc-crew') +
      `<div class="modal-actions"><button class="btn btn-ghost" id="lc-cancel">Cancel</button>` +
      `<button class="btn btn-primary" id="lc-save">✓ Submit it</button></div>`
    );

    const selRegion = $('lc-region'), selType = $('lc-type'), selZone = $('lc-zone');
    const sync = () => {
      const rid = selRegion.value, region = sysR.regions[rid];
      let types = Object.entries(region.availability).filter(([, lv]) => lv !== 'none');
      if (push) types = types.filter(([t]) => (roll ? t === roll.type : push.types.includes(t)));
      const keep = selType.value;
      selType.innerHTML = types.map(([t, lv]) =>
        `<option value="${t}">${esc(t.replace('-', ' '))}${lv === 'rare' ? ' (scarce)' : ''}</option>`).join('');
      if ([...selType.options].some(o => o.value === keep)) selType.value = keep;
      const zkeep = selZone.value;
      const zoneEntries = push
        ? [[push.zone, region.zones[push.zone]]]
        : Object.entries(region.zones);
      const isMining = selType.value === 'mining';
      selZone.innerHTML = zoneEntries.map(([zid, z]) => {
        const closed = isMining && state.zones[zid] && state.zones[zid].control <= 0;
        return `<option value="${zid}" ${closed ? 'disabled' : ''}>${esc(zoneLabel(rid, zid))}${closed ? ' — mining locked (no beachhead)' : ''}</option>`;
      }).join('');
      const help = $('lc-mine-help');
      if (help) {
        if (isMining && !push) {
          const open = Object.entries(region.zones).filter(([zid]) => state.zones[zid] && state.zones[zid].control > 0);
          help.innerHTML = open.length
            ? '⛏ Mining materials for your contract can only be gathered at <b>amber</b> or <b>green</b> planets. The contract names its ores — count it at one that bears them: ' +
              open.map(([zid, z]) => `<b>${esc(zoneLabel(rid, zid))}</b>${z.ores ? ' (' + z.ores.slice(0, 3).map(esc).join(', ') + ')' : ''}`).join(' · ')
            : `All of ${esc(region.name)} space is grey — locked to mining. Combat or supply work at a planet turns it amber and opens it.`;
          help.style.display = '';
        } else help.style.display = 'none';
      }
      const frontInRegion = Object.keys(state.fronts || {}).find(z2 => state.zones[z2] && state.zones[z2].region === rid);
      const def = push ? push.zone : (frontInRegion || zkeep);
      if (def && [...selZone.options].some(o => o.value === def)) selZone.value = def;
      if (push) selZone.disabled = true;
      syncDetail();
    };
    const syncDetail = () => {
      const rid = selRegion.value, t = selType.value, zid = selZone.value;
      $('lc-scarce').style.display = sysR.regions[rid].availability[t] === 'rare' ? '' : 'none';
      $('lc-deep-wrap').style.display = t === 'investigation' ? '' : 'none';
      const isInv = t === 'investigation', isSalv = t === 'salvage';
      const invNote = $('lc-inv-note');
      const note = isInv
        ? `Investigation pays intel into the org stores — there is no zone bonus, and the planet below is only for the record. ` +
          (sysR.regions[rid].investigationNote || '')
        : '';
      invNote.textContent = note;
      invNote.style.display = note ? '' : 'none';
      $('lc-zone-label').textContent = isInv ? 'Where you were working' : 'Apply the gains to';
      // always ask — the player knows where they were, the board doesn't.
      // Two trades are exempt: investigation pays flat intel the fold never
      // multiplies, and salvage has no place to be, so it is asked about its
      // haul instead.
      const wrap = $('lc-onsite-wrap'), box = $('lc-onsite');
      wrap.style.display = isInv || isSalv ? 'none' : '';
      if (isInv || isSalv) box.checked = false;
      $('lc-haul-wrap').style.display = isSalv ? '' : 'none';
      wrap.classList.remove('disabled');
      box.disabled = false;
      $('lc-onsite-label').textContent =
        `The contract itself happened at ${zoneLabel(rid, zid)} (+50%)`;
    };
    selRegion.addEventListener('change', sync);
    selType.addEventListener('change', sync);
    selZone.addEventListener('change', syncDetail);
    sync();

    $('lc-cancel').addEventListener('click', closeModal);
    $('lc-save').addEventListener('click', () => {
      const haul = selType.value === 'salvage' ? haulFrom('lc') : {};
      store.append(OrgState.newEvent('contract.done', callsign(), {
        region: selRegion.value, zone: selZone.value, ctype: selType.value,
        onSite: $('lc-onsite').checked || undefined,
        cmat: haul.cmat, rmc: haul.rmc,
        pushId: push ? push.id : undefined,
        deep: (selType.value === 'investigation' && $('lc-deep').value) ? true : undefined,
        crew: crewFrom($('modal-root')).length ? crewFrom($('modal-root')) : undefined,
      }));
      selected = selZone.value;
    });
  }

  // ── Projects (org-authored missions with capture gates) ─────────────────
  function renderProjectsInfo(el, close) {
    const list = state.projectList || [];
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const costStr = c => Object.entries(c).map(([k, v]) => k === 'funds' ? fmtF(v) + ' funds' : v + ' ' + k).join(' · ');
    const hiddenCount = list.filter(p => p.hidden).length;
    el.innerHTML = close + `<div class="card-title">Projects</div>` + list.filter(p => !p.hidden).map(p => {
      let status;
      if (p.done) status = `<span class="proj-done">✓ complete</span>`;
      else if (!p.locks.length) status = `<button class="btn btn-mini" data-project="${p.id}">Complete — ${costStr(p.cost)}</button>`;
      else status = `<span class="proj-locks">🔒 ${p.locks.map(esc).join(' · ')}</span>`;
      return `<div class="proj-row${p.done ? ' done' : ''}${p.victory ? ' final' : ''}">` +
        `<div class="proj-top"><span class="proj-tier t${p.tier}">T${p.tier}</span>` +
        `<span class="proj-name">${esc(p.name)}</span>` +
        (p.done ? '' : `<span class="proj-cost">${costStr(p.cost)}</span>`) + `</div>` +
        (p.grantText ? `<div class="proj-grant">${esc(p.grantText)}</div>` : '') +
        `<div class="proj-status">${status}</div></div>`;
    }).join('') +
      (hiddenCount ? `<div class="proj-hidden">🔒 ${hiddenCount} undisclosed project${hiddenCount > 1 ? 's' : ''} — they reveal as the org takes ground.</div>` : '');
    el.querySelectorAll('[data-project]').forEach(b => b.addEventListener('click', () => {
      store.append(OrgState.newEvent('project.complete', callsign(), { id: b.dataset.project }));
    }));
  }

  // ── Members: leaderboard + medals (all derived from the log) ────────────
  const MEDALS = [
    ['⚔', 'Vanguard — 25 combat contracts', (m, t) => t('ship-combat') + t('ground-combat') >= 25],
    ['🚚', 'Lifeline — 25 hauling contracts', (m, t) => t('hauling') >= 25],
    ['⛏', 'Prospector — 25 mining contracts', (m, t) => t('mining') >= 25],
    ['🔩', 'Breaker — 25 salvage contracts', (m, t) => t('salvage') >= 25],
    ['🛰', 'Spyglass — 10 investigations', (m, t) => t('investigation') >= 10],
    ['🎯', 'On-site Operator — 10 on-site banks', (m) => m.onSite >= 10],
    ['⚑', 'Objective Hound — 20 objective contracts', (m) => (m.pushed || 0) >= 20],
    ['🌟', 'Set-piece Veteran — ran a region set-piece op', (m) => (m.setPieces || 0) >= 1],
    ['🏆', 'Flagship Crew — aboard the maiden voyage', (m) => (m.finale || 0) >= 1],
  ];

  function renderMembersInfo(el, close) {
    const list = Object.entries(state.members).sort((a, b) => b[1].total - a[1].total);
    const iApprove = state.approvers.includes(callsign());
    el.innerHTML = close + `<div class="card-title">Members</div>` + (list.length
      ? list.map(([name, m], i) => {
        const t = (k) => (m.tallies[k] || 0);
        const medals = MEDALS.filter(([, , test]) => test(m, t))
          .map(([ic, title]) => `<span class="medal" title="${esc(title)}">${ic}</span>`).join('');
        const isApp = state.approvers.includes(name);
        const isSpec = !!m.spectator;
        const cal = m.calling && D.ranks && D.ranks.tracks[m.calling] ? D.ranks.tracks[m.calling].name : '';
        return `<div class="member-row"><span class="mr-rank">#${i + 1}</span>` +
          `<span class="mr-name">${esc(disp(name))}${isApp ? ' <span class="mr-star" title="approver">★</span>' : ''}` +
          `${isSpec ? ' <span title="spectator — eyes only">👁</span>' : ''}</span>` +
          (cal ? `<span class="mr-cal">${esc(cal)}</span>` : '') +
          `<span class="mr-medals">${medals}</span>` +
          (iApprove && !isApp && !isSpec ? `<button class="linklike" data-grant="${esc(name)}">make approver</button>` : '') +
          (iApprove && !isApp && !isSpec ? `<button class="linklike" data-spec="${esc(name)}">make spectator</button>` : '') +
          (iApprove && isSpec ? `<button class="linklike" data-unspec="${esc(name)}">make player</button>` : '') +
          `<span class="mr-total">${m.total}</span></div>`;
      }).join('')
      : '<div class="panel-hint">Nobody has joined yet.</div>');
    el.querySelectorAll('[data-grant]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('role.approver', callsign(), { callsign: b.dataset.grant }))));
    el.querySelectorAll('[data-spec]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('role.spectator', callsign(), { callsign: b.dataset.spec }))));
    el.querySelectorAll('[data-unspec]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('role.spectator', callsign(), { callsign: b.dataset.unspec, grant: false }))));
  }

  // ── Shareable war log (captain's-log ethos, Discord-ready) ──────────────
  function buildWarLog() {
    const c = state.chest;
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const lines = [];
    lines.push(`⚑ ${state.config.name || 'Org Campaign'} — Day ${Math.min(state.tick + 1, state.config.seasonDays)}/${state.config.seasonDays} · ${state.config.system} theater`);
    const fronts = Object.keys(state.fronts || {})
      .map(z => sysR.regions[state.zones[z].region].zones[z].name);
    if (fronts.length) lines.push(`Front lines: ${fronts.join(' · ')}`);
    const held = Object.entries(state.zones).filter(([, z]) => z.held)
      .map(([zid, z]) => sysR.regions[z.region].zones[zid].name);
    if (held.length) lines.push(`Held: ${held.join(' · ')}`);
    lines.push(`HQ stores: ${fmtF(c.funds)} ORG funds · ${c.metals} metals · ${c.components} components · ${c.supplies} supplies · ${c.intel} intel`);
    const top = Object.entries(state.members).sort((a, b) => b[1].total - a[1].total).slice(0, 3)
      .map(([n, m]) => `${n} (${m.total})`);
    if (top.length) lines.push(`Top contributors: ${top.join(' · ')}`);
    lines.push('────────────────');
    for (const cl of state.chronicle.slice(-30)) lines.push(`D${cl.tick + 1} · ${cl.text}`);
    return lines.join('\n');
  }

  // ── Daily battle report → the org's Discord ─────────────────────────────
  // Lazy, like the Director: the FIRST member whose board loads after a day
  // boundary claims a write-once marker in the database and posts that day's
  // digest. Nobody opens the board → nothing posts — silence IS the signal.
  const reportTried = {};
  function buildDailyReport(day) {
    const held = state.season.heldZones.map(z => sysR.regions[state.zones[z].region].zones[z].name);
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const lines = [];
    lines.push(`⚑ **${state.config.name || 'Org Campaign'}** — day ${day + 1} of ${state.config.seasonDays} closes`);
    lines.push(`Held: ${held.length ? held.join(' · ') : 'nothing yet'} · HQ stores: ${fmtF(state.chest.funds)} ORG funds`);
    const todays = state.chronicle.filter(c => c.tick === day).map(c => `• ${c.text}`);
    lines.push(todays.length ? todays.join('\n') : '• A quiet day — no contracts logged.');
    // whatever the org scouted goes in the post — that's what tomorrow's plan is made of
    const tg = (state.director && state.director.telegraph) || [];
    if (tg.length) {
      lines.push('🛰 **Scouted for tomorrow:** ' + tg.map(m => m.kind === 'raid'
        ? `a strike on ${zoneLabel(m.region, m.zone)} — ${OrgState.TUNING.PUSH_COUNT} combat contracts in ${regionSpace(m.region)} breaks it`
        : `convoys going missing in ${regionSpace(m.region)} — haulers wanted`).join(' · '));
    }
    let out = lines.join('\n');
    if (out.length > 1700) out = out.slice(0, 1680) + '\n… (full log in the war room)';
    return out + `\n🗺 The map right now: <${buildMapLink()}>`;
  }
  // a public snapshot link: the whole board state rides in the URL, so viewers
  // need no code, no account and never touch the org's database
  function buildMapLink() {
    const base = location.href.replace(/[^/]*$/, '') + 'campaignmap.html';
    const name = state.config.name ? '&n=' + encodeURIComponent(state.config.name) : '';
    return `${base}?${OrgMap.encodeState(state)}${name}`;
  }

  function postToDiscord(webhook, content) {
    // form-encoded payload_json avoids a CORS preflight — Discord accepts it
    return fetch(webhook, { method: 'POST', body: new URLSearchParams({ payload_json: JSON.stringify({ content }) }) })
      .then(r => { if (!r.ok) throw new Error('Discord answered ' + r.status); return r; });
  }
  function maybeSendReport() {
    if (!netMode || !state || !state.report || !store.claimOnce) return;
    if (!state.season || state.season.mustering) return;
    // the starting gun announces itself — instant proof the pipeline works
    if (state.tick === 0 && !state.season.over && !reportTried.start) {
      reportTried.start = true;
      store.claimOnce('start', { at: Date.now(), by: callsign() }).then(won => {
        if (!won) return;
        const members = Object.keys(state.members).length;
        const hulls = (state.fleet || []).filter(f => f.status !== 'withdrawn').length;
        postToDiscord(state.report.webhook,
          `🚀 **${state.config.name || 'Org Campaign'}** — the season begins! ` +
          `${state.config.seasonDays} days on the clock · ${members} enlisted · ${hulls} hull${hulls === 1 ? '' : 's'} pledged.\n` +
          `First battle report lands when day 1 closes. Good hunting.\n` +
          `🗺 Follow the war, no account needed: <${buildMapLink()}>`
        ).catch(err => console.error('kickoff post failed:', err));
      });
    }
    const target = state.season.over ? 'final' : (state.tick > 0 ? 'd' + (state.tick - 1) : null);
    if (!target || reportTried[target]) return;
    reportTried[target] = true;
    store.claimOnce(target, { at: Date.now(), by: callsign() }).then(won => {
      if (!won) return;
      const content = target === 'final'
        ? buildFinalReport()
        : buildDailyReport(state.tick - 1);
      postToDiscord(state.report.webhook, content).catch(err => console.error('battle report failed:', err));
    });
  }

  // ── Season close-out: the ending, the report, the ceremony, the reset ───
  // the closing ceremony: a region set-piece on ground the org actually took —
  // preferring one the org never got to fly this season
  function ceremonyFor() {
    const e = state.season.ending;
    const heldRegions = [...new Set(state.season.heldZones.map(z => state.zones[z].region))];
    const cands = heldRegions.map(rid => {
      const rdef = sysR.regions[rid];
      const h = heroFor(rdef.setPiece);
      return h ? { rid, name: h.name, region: rdef.name, flown: !!(state.setPieces && state.setPieces[rid]) } : null;
    }).filter(Boolean).sort((a, b) => (a.flown ? 1 : 0) - (b.flown ? 1 : 0));
    if (cands.length) {
      const c = cands[0];
      return `Close the season together: run <b>${esc(c.name)}</b> in ${esc(c.region)} space — ` +
        `the set-piece on ground you took${c.flown ? ', one more time for the chronicle' : ' — the one op the org never got to'}. ` +
        `Full briefing in the Hero Adventures codex.`;
    }
    if (e.tone === 'win') return 'Close the season together: bring every hull to Orison and fly the fleet in formation — the org\'s own review.';
    if (e.id === 'rout') return 'Regroup night: one last flight together, then the map resets. Next season the Director starts from zero too.';
    return 'Close the season together: one last org night on the ground you held — and pick next season\'s first front.';
  }

  function buildFinalReport() {
    const e = state.season.ending;
    const c = state.chest;
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const heldNames = state.season.heldZones.map(z => sysR.regions[state.zones[z].region].zones[z].name);
    const count = (re) => state.chronicle.filter(cl => re.test(cl.text)).length;
    const contracts = Object.values(state.members).reduce((n, m) => n + m.total, 0);
    const lines = [];
    lines.push(`${e.icon} ${e.title.toUpperCase()}`);
    lines.push(`${state.config.name || 'Org Campaign'} — season of ${state.config.seasonDays} days, ${state.config.system} theater`);
    lines.push(e.line.replace(/<[^>]+>/g, ''));
    lines.push('────────────────');
    lines.push(`Contracts flown: ${contracts} · Captures: ${count(/is taken — the org holds it/)} · Raids repelled: ${count(/stands — the pressure broke/)} · suffered: ${count(/went unanswered — control slips/)}`);
    lines.push(`Held at the close: ${heldNames.length ? heldNames.join(' · ') : 'nothing'}`);
    lines.push(`HQ stores at the close: ${fmtF(c.funds)} ORG funds · projects done: ${Object.keys(state.projectsDone).length}`);
    const top = Object.entries(state.members).sort((a, b) => b[1].total - a[1].total).slice(0, 3)
      .map(([n, m], i) => `${['🥇', '🥈', '🥉'][i]} ${n} (${m.total})`);
    if (top.length) lines.push(`Season honors: ${top.join(' · ')}`);
    lines.push('────────────────');
    lines.push(ceremonyFor().replace(/<[^>]+>/g, ''));
    lines.push(`🗺 The final map: <${buildMapLink()}>`);
    return lines.join('\n');
  }

  function showFinalReport() {
    const e = state.season.ending;
    const c = state.chest;
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const heldNames = state.season.heldZones.map(z => sysR.regions[state.zones[z].region].zones[z].name);
    const count = (re) => state.chronicle.filter(cl => re.test(cl.text)).length;
    const contracts = Object.values(state.members).reduce((n, m) => n + m.total, 0);
    const promotions = count(/is issued a /);
    const stat = (label, val) => `<div class="fr-stat"><b>${val}</b><span>${label}</span></div>`;
    const top = Object.entries(state.members).sort((a, b) => b[1].total - a[1].total).slice(0, 3);
    openModal(
      `<h2>${e.icon} ${esc(e.title)}</h2>` +
      `<div class="m-sub">${esc(state.config.name || 'Org Campaign')} — a season of ${state.config.seasonDays} days in the ${esc(state.config.system)} theater.</div>` +
      `<div class="ending tone-${e.tone}" style="margin-bottom:12px"><div class="ending-line">${esc(e.line)}</div></div>` +
      `<div class="fr-grid">` +
      stat('contracts flown', contracts) +
      stat('zones at the close', heldNames.length) +
      stat('raids repelled', count(/stands — the pressure broke/)) +
      stat('raids suffered', count(/went unanswered — control slips/)) +
      stat('projects done', Object.keys(state.projectsDone).length) +
      stat('promotions', promotions) +
      stat('ORG funds left', fmtF(c.funds)) +
      stat('days', state.season.daysPlayed) +
      `</div>` +
      (heldNames.length ? `<div class="f-note" style="margin-top:8px">Held at the close: <b>${heldNames.map(esc).join(' · ')}</b></div>` : '') +
      (top.length ? `<div class="card-title" style="margin-top:10px">Season honors</div>` +
        top.map(([n, m], i) => `<div class="req-row"><span>${['🥇', '🥈', '🥉'][i]} ${esc(disp(n))}</span><span class="mr-total">${m.total}</span></div>`).join('') : '') +
      `<div class="card-title" style="margin-top:10px">The closing ceremony</div>` +
      `<div class="help-p">${ceremonyFor()}</div>` +
      `<div class="modal-actions"><button class="btn btn-ghost" id="fr-close">Close</button>` +
      `<button class="btn" id="fr-copy">Copy for discord</button>` +
      (netMode ? '' : `<button class="btn btn-primary" id="fr-new">Start a new season</button>`) + `</div>`
    );
    $('fr-close').addEventListener('click', closeModal);
    $('fr-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(buildFinalReport()).then(() => {
        $('fr-copy').textContent = 'copied ✓';
        setTimeout(() => { const b = $('fr-copy'); if (b) b.textContent = 'Copy for discord'; }, 1600);
      }).catch(() => { $('fr-copy').textContent = 'copy failed'; });
    });
    const frNew = $('fr-new');
    if (frNew) frNew.addEventListener('click', (e) => armConfirm(e.currentTarget, startNewSeason, 'clears the demo — sure?'));
  }

  function startNewSeason() {
    localStorage.removeItem(WELCOME_KEY);
    store.clear();
  }

  // net mode: the log is append-only forever — a new season is a NEW campaign
  // path. Same database, fresh map; the old board stays up as the monument,
  // with a one-click pointer everyone can follow.
  function callNextSeason() {
    let code;
    try {
      const d = OrgNet.readCode(localStorage.getItem(NET_KEY));
      const path = 'campaigns/c' + Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => (b % 36).toString(36)).join('');
      code = OrgNet.makeCode(d.cfg, path);
    } catch (err) {
      console.error('could not derive the next-season code:', err);
      return;
    }
    store.append(OrgState.newEvent('season.next', callsign(), { code }));
    // give the push a beat to reach the database before we leave this campaign
    setTimeout(() => {
      localStorage.setItem(NET_KEY, code);
      localStorage.removeItem(WELCOME_KEY);
      location.reload();
    }, 800);
  }

  // ── Ship picker: a button per hull, grouped by manufacturer ─────────────
  const MFR = {
    AEGS: 'Aegis Dynamics', ANVL: 'Anvil Aerospace', ARGO: 'Argo Astronautics', BANU: 'Banu',
    CNOU: 'Consolidated Outland', CRUS: 'Crusader Industries', DRAK: 'Drake Interplanetary',
    ESPR: 'Esperia', GAMA: 'Gatac Manufacture', GREY: 'Greycat Industrial', GRIN: 'Greycat Industrial',
    KRIG: 'Kruger Intergalactic', MISC: 'MISC', MRAI: 'Mirai', ORIG: 'Origin Jumpworks',
    RSI: 'Roberts Space Industries', TMBL: 'Tumbril', XNAA: 'Aopoa (Xi’an)',
  };
  const mfrName = (code) => MFR[code] || code || 'Other';
  function shipGridHtml(gridId, marked, filterVal, locked) {
    const lk = locked || new Set();
    const fmtF = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const groups = {};
    for (const s of (D.ships.ships || [])) (groups[mfrName(s.m)] = groups[mfrName(s.m)] || []).push(s);
    const body = Object.keys(groups).sort().map(g =>
      `<div class="mfr-head" data-mfr="${esc(g.toLowerCase())}">${esc(g)}</div>` +
      groups[g].sort((a, b) => a.n.localeCompare(b.n)).map(s => {
        const on = marked.has(s.n) || lk.has(s.n);
        return `<button type="button" class="ship-tile${on ? ' added' : ''}" data-ship="${esc(s.n)}" data-mfr="${esc(g.toLowerCase())}"` +
          `${lk.has(s.n) ? ' title="commissioned into org service — withdrawing pulls it from the fleet"' : ''}>` +
          `<span class="st-n">${on ? '✓ ' : ''}${esc(s.n)}</span>` +
          `<span class="st-p">${lk.has(s.n) ? 'in service' : fmtF(s.p) + (s.v ? ' · org valuation' : '')}</span></button>`;
      }).join('')
    ).join('');
    return `<input class="f-input" id="${gridId}-filter" placeholder="Filter — ship or maker… e.g. Cutlass, Drake" value="${esc(filterVal || '')}">` +
      `<div class="ship-grid" id="${gridId}">${body}</div>`;
  }
  function bindShipGrid(root, gridId, onPick) {
    const applyFilter = () => {
      const q = root.querySelector('#' + gridId + '-filter').value.trim().toLowerCase();
      root.querySelectorAll('#' + gridId + ' .ship-tile').forEach(t => {
        t.style.display = !q || t.dataset.ship.toLowerCase().includes(q) || t.dataset.mfr.includes(q) ? '' : 'none';
      });
      root.querySelectorAll('#' + gridId + ' .mfr-head').forEach(h => {
        h.style.display = !q || h.dataset.mfr.includes(q) ||
          [...root.querySelectorAll(`#${gridId} .ship-tile[data-mfr="${h.dataset.mfr}"]`)].some(t => t.style.display !== 'none') ? '' : 'none';
      });
    };
    root.querySelector('#' + gridId + '-filter').addEventListener('input', applyFilter);
    applyFilter();
    root.querySelectorAll('#' + gridId + ' .ship-tile').forEach(t =>
      t.addEventListener('click', () => onPick(t.dataset.ship, t)));
  }

  // the pledge picker lives in the side panel — tap every hull you own
  let pledgeFilter = '';
  function renderPledgeInfo(el, close) {
    // each pledge re-renders the panel — keep the reader where they were
    const oldGrid = el.querySelector('#pl-grid');
    const keepGrid = oldGrid ? oldGrid.scrollTop : 0;
    const keepPanel = el.scrollTop;
    const me = callsign();
    const minePledged = new Set((state.fleet || []).filter(f => f.by === me && f.status === 'pledged').map(f => f.ship));
    const mineLocked = new Set((state.fleet || []).filter(f => f.by === me && f.status !== 'pledged' && f.status !== 'withdrawn').map(f => f.ship));
    el.innerHTML = close + `<div class="card-title">Add my ships</div>` +
      `<div class="panel-hint" style="font-size:12.5px">Tap a hull to pledge it to the org census — tap again to take it back. ` +
      `It's your ship, always: even a commissioned hull can be withdrawn (it leaves org service; the commissioning spend is gone).</div>` +
      (minePledged.size ? `<div class="f-note" style="margin:4px 0 6px">Pledged so far: <b>${[...minePledged].map(esc).join(' · ')}</b></div>` : '') +
      shipGridHtml('pl-grid', minePledged, pledgeFilter, mineLocked);
    el.querySelector('#pl-grid-filter').addEventListener('input', (e) => { pledgeFilter = e.target.value; });
    bindShipGrid(el, 'pl-grid', (ship, tile) => {
      if (mineLocked.has(ship)) {
        // pulling a hull out of service deserves a deliberate second tap
        if (!tile.dataset.armed) {
          tile.dataset.armed = '1';
          tile.classList.add('armed');
          tile.querySelector('.st-n').textContent = 'withdraw from service?';
          setTimeout(() => {
            if (tile.isConnected && tile.dataset.armed) {
              delete tile.dataset.armed;
              tile.classList.remove('armed');
              tile.querySelector('.st-n').textContent = '✓ ' + ship;
            }
          }, 3500);
          return;
        }
        store.append(OrgState.newEvent('fleet.unpledge', me, { ship }));
        return;
      }
      tile.disabled = true;
      store.append(OrgState.newEvent(minePledged.has(ship) ? 'fleet.unpledge' : 'fleet.pledge', me, { ship }));
    });
    el.querySelector('#pl-grid').scrollTop = keepGrid;
    el.scrollTop = keepPanel;
  }

  // ── Fleet: pledge census → commission at real prices → lost/recommission ─
  const BAND_NEEDS = {
    light: null, medium: 'needs a commission site (Fab Labs or Shipyards)',
    heavy: 'needs the Orison Shipyards', capital: 'needs Shipyards + the keel laid',
  };
  function renderFleetInfo(el, close) {
    const fleet = state.fleet || [];
    const cl = state.clearance || {};
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const strip = [['light', 'Light ≤2M'], ['medium', 'Medium ≤9M'], ['heavy', 'Heavy ≤20M'], ['capital', 'Capital']]
      .map(([id, label]) => `<span class="band${cl[id] ? ' ok' : ''}" title="${cl[id] ? 'cleared' : esc(BAND_NEEDS[id] || '')}">${cl[id] ? '✓' : '🔒'} ${label}</span>`).join('');
    // the fleet view shows what the org can actually FLY — who has what, right now
    const assignedTo = (id) => {
      const hit = Object.entries(state.members).find(([, m]) => m.rideOverride && m.rideOverride.fleetId === id);
      return hit ? hit[0] : null;
    };
    const me = callsign();
    const myPending = Object.values(state.proposals || {}).some(pr => pr.from === me && pr.status === 'pending');
    const rideRows = Object.entries(state.members).map(([name, m]) => {
      const chips = (m.hangar || []).map(h => {
        const tag = h.kind === 'hull' ? ' · hull' : '';
        if (name === me || h.kind === 'hull' || myPending) return `<span class="hangar-chip">${esc(h.name)}${tag}</span>`;
        return `<button class="hangar-chip swap" data-swap-with="${esc(name)}" data-swap-take="${esc(h.name)}" title="propose a swap for this ship">${esc(h.name)} ⇄</button>`;
      }).join('');
      return `<div class="req-row hangar-row"><span>${esc(disp(name))}${name === me ? ' (you)' : ''}</span><span class="mr-cal hangar-chips">${chips || '—'}</span></div>`;
    }).join('');

    // member↔member swap proposals — the counterparty decides, nothing is spent
    const props = Object.entries(state.proposals || {}).filter(([, pr]) => pr.status === 'pending');
    const propRows = props.map(([id, pr]) => {
      if (pr.to === me) {
        return `<div class="req-row"><span class="req-desc">${esc(disp(pr.from))} offers you their <b>${esc(pr.give)}</b> for your <b>${esc(pr.take)}</b></span>` +
          `<span class="req-act"><button class="btn btn-mini" data-swap-ok="${id}">Accept</button>` +
          `<button class="linklike danger" data-swap-no="${id}">decline</button></span></div>`;
      }
      if (pr.from === me) {
        return `<div class="req-row"><span class="req-desc">You offered ${esc(disp(pr.to))} your <b>${esc(pr.give)}</b> for their <b>${esc(pr.take)}</b></span>` +
          `<span class="proj-locks">waiting on ${esc(disp(pr.to))}</span></div>`;
      }
      return `<div class="req-row"><span class="req-desc">${esc(disp(pr.from))} ⇄ ${esc(disp(pr.to))} — ${esc(pr.give)} for ${esc(pr.take)}</span>` +
        `<span class="proj-locks">pending</span></div>`;
    }).join('');
    const ready = fleet.filter(f => f.status === 'ready');
    const lost = fleet.filter(f => f.status === 'lost');
    const pledgedCount = fleet.filter(f => f.status === 'pledged').length;

    const readyRows = ready.map(f => {
      const asg = assignedTo(f.id);
      const iApprove = state.approvers.includes(me);
      const pendAsg = Object.values(state.requests || {}).some(r =>
        r.kind === 'exchange' && r.status === 'pending' && r.payload.fleetId === f.id);
      let askBtn = '';
      if (!asg && asg !== me) {
        if (pendAsg) askBtn = `<span class="proj-locks">assignment pending</span>`;
        else askBtn = `<button class="linklike" data-askhull="${f.id}" data-askship="${esc(f.ship)}">${iApprove ? 'assign to me' : 'request assignment'}</button>`;
      }
      return `<div class="fleet-row"><div class="fr-top">` +
        `<span class="proj-tier">${esc(f.bandLabel || '?')}</span>` +
        `<span class="fr-ship">${esc(f.ship)}</span>` +
        `<span class="fr-owner">${esc(disp(f.by))}'s hull${asg ? ` · assigned to ${esc(disp(asg))}` : ''}</span></div>` +
        `<div class="fr-action"><span class="fleet-ready">${asg ? '◌ assigned' : '✓ available'}</span>${askBtn}` +
        `<button class="linklike danger" data-lost="${f.id}">report destroyed</button></div></div>`;
    }).join('');
    const lostRows = lost.map(f => {
      const bill = f.price != null ? Math.ceil(f.price * OrgState.TUNING.RECOMMISSION_FRAC) : null;
      const act = bill == null ? '<span class="proj-locks">price unknown</span>'
        : `<label class="f-check fr-salv"><input type="checkbox" data-salv="${f.id}"> salvaged the wreck (−50%)</label>` +
          `<button class="btn btn-mini" data-recommission="${f.id}">Recommission — ${fmtF(bill)}</button>`;
      return `<div class="fleet-row st-lost"><div class="fr-top"><span class="proj-tier">${esc(f.bandLabel || '?')}</span>` +
        `<span class="fr-ship">${esc(f.ship)}</span><span class="fr-owner">${esc(disp(f.by))}</span></div>` +
        `<div class="fr-action">${act}</div></div>`;
    }).join('');

    el.innerHTML = close + `<div class="card-title ct-row">Fleet <button class="linklike" id="btn-pledge">+ add my ships</button></div>` +
      `<div class="band-strip">${strip}</div>` +
      `<div class="card-title" style="margin-top:8px">Ships — who's assigned what</div>` +
      `<div class="panel-hint" style="font-size:12.5px;margin:-2px 0 4px">See a ship you'd like? Click it to offer a swap — you give one of yours, they decide.${myPending ? ' (You already have an offer out.)' : ''}</div>` +
      (rideRows || `<div class="panel-hint" style="font-size:13.5px">Nobody has a ride yet.</div>`) +
      (propRows ? `<div class="card-title" style="margin-top:10px">Swap offers</div>` + propRows : '') +
      `<div class="card-title" style="margin-top:10px">Commissioned hulls</div>` +
      (readyRows || `<div class="panel-hint" style="font-size:13.5px">No commissioned hulls yet — members fly their issued ships, listed above.</div>`) +
      (lostRows ? `<div class="card-title" style="margin-top:10px">Destroyed</div>` + lostRows : '') +
      `<div class="mc-actions" style="margin-top:12px"><button class="btn btn-primary" id="btn-commission">Commission a ship${pledgedCount ? ` — ${pledgedCount} in the census` : ''}</button>` +
      `<button class="btn" id="btn-requisition">Requisition a ship</button></div>` +
      approvalsHtml();
    el.querySelector('#btn-pledge').addEventListener('click', () => { pledgeFilter = ''; setInfo('pledge'); });
    el.querySelector('#btn-commission').addEventListener('click', showCommissionModal);
    el.querySelector('#btn-requisition').addEventListener('click', showRequisitionModal);
    el.querySelectorAll('[data-swap-with]').forEach(b => b.addEventListener('click', () =>
      showSwapModal(b.dataset.swapWith, b.dataset.swapTake)));
    el.querySelectorAll('[data-swap-ok]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('exchange.accept', callsign(), { reqId: b.dataset.swapOk }))));
    el.querySelectorAll('[data-swap-no]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('exchange.decline', callsign(), { reqId: b.dataset.swapNo }))));
    el.querySelectorAll('[data-askhull]').forEach(b => b.addEventListener('click', () => {
      const reqId = 'q' + Date.now().toString(36);
      store.append(OrgState.newEvent('request.create', callsign(), {
        reqId, kind: 'exchange', payload: { ship: b.dataset.askship, fleetId: +b.dataset.askhull },
      }));
      if (state.approvers.includes(callsign()))
        store.append(OrgState.newEvent('request.approve', callsign(), { reqId }));
    }));
    bindApprovalButtons(el);
    el.querySelectorAll('[data-lost]').forEach(b => b.addEventListener('click', () =>
      armConfirm(b, () => store.append(OrgState.newEvent('fleet.lost', callsign(), { fleetId: +b.dataset.lost })),
        'destroyed — sure?')));
    el.querySelectorAll('[data-recommission]').forEach(b => b.addEventListener('click', () => {
      const salv = el.querySelector(`[data-salv="${b.dataset.recommission}"]`);
      store.append(OrgState.newEvent('fleet.recommission', callsign(), {
        fleetId: +b.dataset.recommission, salvaged: (salv && salv.checked) || undefined,
      }));
    }));
  }

  // the request queue — shown under Fleet and on the Admin page alike
  function approvalsHtml() {
    const pend = Object.entries(state.requests || {}).filter(([, r]) => r.status === 'pending');
    if (!pend.length) return '';
    const iApprove = state.approvers.includes(callsign());
    const reqDesc = (r) => r.kind === 'commission'
      ? `commission ${esc((state.fleet[r.payload.fleetId] || {}).ship || '?')}`
      : r.kind === 'ride' ? `unlock a ${esc(r.payload.line)} tier-${r.payload.tier} ship`
        : `hull assignment — ${esc(r.payload.ship || '?')}`;
    return `<div class="card-title" style="margin-top:12px">Pending approvals</div>` + pend.map(([id, r]) =>
      `<div class="req-row"><span class="req-desc">${esc(disp(r.by))} — ${reqDesc(r)}</span>` +
      (iApprove
        ? `<span class="req-act"><button class="btn btn-mini" data-req-ok="${id}">Approve</button><button class="linklike danger" data-req-no="${id}">deny</button></span>`
        : '<span class="proj-locks">awaiting an approver</span>') +
      `</div>`).join('');
  }
  function bindApprovalButtons(el) {
    el.querySelectorAll('[data-req-ok]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('request.approve', callsign(), { reqId: b.dataset.reqOk }))));
    el.querySelectorAll('[data-req-no]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('request.deny', callsign(), { reqId: b.dataset.reqNo }))));
  }

  // Requisition — the entry hull of any trade, so an org is never stranded
  // without cargo space, a mining head or a salvage beam. Starters only.
  const TRADE_NEED = {
    bounty: '⚔ Ship combat', merc: '🚑 Medical &amp; ground support', hauler: '📦 Cargo space',
    miner: '⛏ Ship mining', salvager: '🔩 Salvage', explorer: '🛰 Exploration &amp; intel',
  };
  function showRequisitionModal() {
    const me = state.members[callsign()];
    const list = (me && me.requisitions) || [];
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const rows = list.map(r => {
      let act, where;
      if (r.have) { act = `<span class="fleet-ready">✓ you fly this</span>`; where = r.ship ? esc(r.ship) : esc(r.lineName); }
      else if (!r.ship) { act = `<span class="proj-locks">nothing rentable</span>`; where = esc(r.lineName); }
      else if (!r.ride) {
        // every hub that stocks it sits on ground the org hasn't touched yet
        const planets = r.where.map(rid => (sysR.regions[rid] && sysR.regions[rid].name) || rid);
        act = `<span class="proj-locks">🔒 locked</span>`;
        where = `${esc(r.ship)} · needs a beachhead in ${planets.map(esc).join(', ').replace(/, ([^,]*)$/, ' or $1')} space`;
      } else {
        where = `${esc(r.ride.name)} · rent at ${esc(r.ride.city)}`;
        act = state.chest.funds < r.fee
          ? `<span class="proj-locks">short ${fmtF(r.fee - state.chest.funds)} ORG funds</span>`
          : `<button class="btn btn-mini" data-req-line="${esc(r.line)}">Requisition — ${fmtF(r.fee)}</button>`;
      }
      return `<div class="fleet-row${r.have ? ' done' : ''}"><div class="fr-top">` +
        `<span class="fr-ship">${TRADE_NEED[r.line] || esc(r.lineName)}</span>` +
        `<span class="fr-owner">${where}</span></div>` +
        `<div class="fr-action">${act}</div></div>`;
    }).join('');
    const open = [...new Set(list.filter(r => r.ride).map(r => r.ride.city))];
    openModal(
      `<h2>Requisition a ship</h2>` +
      `<div class="m-sub">The org's motor pool — the <b>entry hull of any trade</b>, so no one is stuck watching a contract they ` +
      `can't fly. Paid from ORG funds; it stays yours for the season, like any assigned ship.</div>` +
      `<div class="f-note" style="margin-bottom:10px">A hub only serves you once the org is fighting in its region — ` +
      `<b>${open.length ? 'open now: ' + open.map(esc).join(' · ') : 'no hubs open yet — take ground first'}</b>. ` +
      `Spread across Stanton and the motor pool widens.</div>` +
      (rows || `<div class="panel-hint">Join the campaign first.</div>`) +
      `<div class="modal-actions"><button class="btn btn-ghost" id="rq-close">Close</button></div>`
    );
    $('rq-close').addEventListener('click', closeModal);
    document.querySelectorAll('#modal-root [data-req-line]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('ride.requisition', callsign(), { line: b.dataset.reqLine }))));
  }

  function showCommissionModal() {
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    const pledged = (state.fleet || []).filter(f => f.status === 'pledged');
    const rows = pledged.map(f => {
      const iApprove = state.approvers.includes(callsign());
      const pendComm = Object.values(state.requests || {}).some(r => r.kind === 'commission' && r.status === 'pending' && r.payload.fleetId === f.id);
      let act;
      if (f.price == null) act = '<span class="proj-locks">price unknown — cannot commission</span>';
      else if (!f.bandCleared) act = `<span class="proj-locks">🔒 ${esc(BAND_NEEDS[f.band] || 'clearance locked')}</span>`;
      else if (state.chest.funds < f.price) act = `<span class="proj-locks">short ${fmtF(f.price - state.chest.funds)} ORG funds</span>`;
      else if (iApprove) act = `<button class="btn btn-mini" data-commission="${f.id}">Commission — ${fmtF(f.price)}</button>`;
      else if (pendComm) act = '<span class="proj-locks">sent for approval — pending</span>';
      else act = `<button class="btn btn-mini" data-commreq="${f.id}">Request — ${fmtF(f.price)}</button>`;
      return `<div class="fleet-row"><div class="fr-top"><span class="proj-tier">${esc(f.bandLabel || '?')}</span>` +
        `<span class="fr-ship">${esc(f.ship)}</span><span class="fr-owner">${esc(disp(f.by))}</span></div>` +
        `<div class="fr-action">${act}</div></div>`;
    }).join('');
    openModal(
      `<h2>Commission a ship</h2>` +
      `<div class="m-sub">What the org can put into service right now, from the pledged census — paid in ORG funds at the hull's real price.</div>` +
      (rows || `<div class="panel-hint">The census is empty — pledge ships from the fleet tab first.</div>`) +
      `<div class="modal-actions"><button class="btn btn-ghost" id="cm-close">Close</button></div>`
    );
    $('cm-close').addEventListener('click', closeModal);
    document.querySelectorAll('#modal-root [data-commission]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('fleet.commission', callsign(), { fleetId: +b.dataset.commission }))));
    document.querySelectorAll('#modal-root [data-commreq]').forEach(b => b.addEventListener('click', () =>
      store.append(OrgState.newEvent('request.create', callsign(), {
        reqId: 'q' + Date.now().toString(36), kind: 'commission', payload: { fleetId: +b.dataset.commreq },
      }))));
  }

  function showSwapModal(withName, takeShip) {
    // member↔member trade: I give one of my rentals, I take one of theirs.
    // The other member accepts or declines — no approver, nothing is spent.
    const me = state.members[callsign()];
    const give = (me && me.hangar || []).filter(h => h.kind !== 'hull').map(h => h.name);
    if (!give.length) {
      openModal(
        `<h2>Offer a swap</h2>` +
        `<div class="m-sub">You have no rental ships to trade yet — earn a promotion first.</div>` +
        `<div class="modal-actions"><button class="btn btn-ghost" id="sw-cancel">Close</button></div>`);
      $('sw-cancel').addEventListener('click', closeModal);
      return;
    }
    openModal(
      `<h2>Offer a swap to ${esc(disp(withName))}</h2>` +
      `<div class="m-sub">You take their <b>${esc(takeShip)}</b> — pick which of your ships they get in return. ` +
      `${esc(disp(withName))} decides; if they accept, the trade applies to both hangars.</div>` +
      `<label class="f-label">Your ship to give</label>` +
      `<select class="f-input" id="sw-give">${give.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select>` +
      `<div class="modal-actions"><button class="btn btn-ghost" id="sw-cancel">Cancel</button>` +
      `<button class="btn btn-primary" id="sw-send">Send offer</button></div>`
    );
    $('sw-cancel').addEventListener('click', closeModal);
    $('sw-send').addEventListener('click', () => {
      store.append(OrgState.newEvent('exchange.propose', callsign(), {
        reqId: 'q' + Date.now().toString(36), to: withName, give: $('sw-give').value, take: takeShip,
      }));
    });
  }


  // ── War Market convert (ArcCorp held) ───────────────────────────────────
  function showConvertModal() {
    const MATS = [['metals', 'Metals'], ['components', 'Components'], ['supplies', 'Supplies']];
    const opts = (sel) => MATS.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('');
    openModal(
      `<h2>⇄ War Market</h2>` +
      `<div class="m-sub">ArcCorp is held — the org can swap materials 1:1 on the board.</div>` +
      `<label class="f-label">Give</label><select class="f-select" id="cv-from">${opts('metals')}</select>` +
      `<label class="f-label">Receive</label><select class="f-select" id="cv-to">${opts('supplies')}</select>` +
      `<label class="f-label">Amount</label><input class="f-input" id="cv-amt" type="number" min="1" value="1">` +
      `<div class="modal-actions"><button class="btn btn-ghost" id="cv-cancel">Cancel</button>` +
      `<button class="btn btn-primary" id="cv-save">Swap</button></div>`
    );
    $('cv-cancel').addEventListener('click', closeModal);
    $('cv-save').addEventListener('click', () => {
      const from = $('cv-from').value, to = $('cv-to').value, amount = Math.floor(+$('cv-amt').value);
      if (from === to || !(amount > 0) || state.chest[from] < amount) return;
      store.append(OrgState.newEvent('chest.convert', callsign(), { from, to, amount }));
    });
  }

  // ── Welcome / how-to (first visit + the ? button) ───────────────────────
  let welcomeShown = false;
  const WELCOME_KEY = 'smr_org_welcomed_v1';
  function showWelcome(force) {
    if (!state) return;
    if (!force && localStorage.getItem(WELCOME_KEY)) return;
    const me = state.members[callsign()];
    const hangar = (me && me.hangar || []).map(h => h.name);
    const held = Object.values(state.zones).filter(z => z.held).length;
    const fronts = Object.keys(state.fronts || {}).length;
    const fmtF = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
    openModal(
      `<h2>⚔ Welcome to the war room</h2>` +
      `<div class="m-sub">${esc(state.config.name || 'Org Campaign')} — Day ${state.tick + 1}/${state.config.seasonDays} · ${held} zone${held === 1 ? '' : 's'} held · ${fronts} front${fronts === 1 ? '' : 's'} open · ${fmtF(state.chest.funds)} ORG funds in the HQ stores.</div>` +
      (hangar.length ? `<div class="ride-cur" style="margin-bottom:12px">🚀 Ships assigned to you: <b>${hangar.map(esc).join('</b> · <b>')}</b>.</div>` : '') +
      `<div class="wl-list">` +
      `<div>🗺 <b>The map</b> — grey planets are locked, <b style="color:#ffb454">amber</b> have a beachhead (mining open), <b style="color:#3fb950">green</b> are secured. ⚑ marks the front lines.</div>` +
      `<div>📋 <b>Contracts</b> — click a ⚑ front-line planet to see and claim its missions, run them in-game, submit them. Work outside the front lines counts, but only a little.</div>` +
      `<div>🎖 <b>Promotions</b> — the more you do of a thing, the better ships the org offers you, automatically.</div>` +
      `<div>🛰 <b>Intel</b> — investigation contracts are never assigned; run them on your own and log them. Enough intel reveals the Director's next move.</div>` +
      `<div>ℹ <b>Information</b> — Members, Fleet, Projects and the War log live in the buttons up top. Click any planet for its details.</div>` +
      `</div>` +
      `<div class="f-note" style="margin-top:10px">The full guide lives under the <b>?</b> button in the header — rules, ships, money, victory.</div>` +
      `<div class="modal-actions"><button class="btn btn-primary" id="wl-ok">I understand — continue</button></div>`,
      true
    );
    $('wl-ok').addEventListener('click', () => {
      localStorage.setItem(WELCOME_KEY, '1');
      modalSticky = false;
      closeModal();
    });
  }

  // ── Startup (no campaign yet): 1 · JOIN with a code, 2 · SET UP a new one ─
  let setupOpen = false;
  function showSetup() {
    $('org-head').style.display = 'none';
    $('org-main').style.display = 'none';
    setupOpen = true;
    if (netMode) { showCreate(true); return; } // shared board, path empty → you're first in
    showStart();
  }

  function showStart() {
    openModal(
      `<h2>⚑ Org Campaign</h2>` +
      `<div class="m-sub">A cooperative war over the Stanton map, fought with real contracts — your whole org on one shared board.</div>` +
      `<button type="button" class="start-card" id="st-join"><span class="start-n">1</span><span class="start-body">` +
      `<b>Join with your org's code</b><br><span>Organizer or member — paste the join code. If the board is still empty, you set the campaign up; otherwise you enlist.</span></span></button>` +
      `<button type="button" class="start-card" id="st-create"><span class="start-n">2</span><span class="start-body">` +
      `<b>Try it solo</b><br><span>A demo campaign that lives in this browser — no code, no database. Good for kicking the tires.</span></span></button>` +
      `<div class="f-note" style="margin-top:12px">Leading an org and want a board of your own? The ` +
      `<a class="linklike" href="org-setup.html">ten-minute organizer guide</a> sets up your org's shared campaign and hands you the join code.</div>`,
      true
    );
    $('st-join').addEventListener('click', showJoinCode);
    $('st-create').addEventListener('click', () => showCreate(false));
  }

  function showJoinCode() {
    openModal(
      `<h2>1 · Join with your org's code</h2>` +
      `<div class="m-sub">Code and callsign together — when the board opens, we check whether you're already enlisted or new. ` +
      `If the board is still empty, you'll set the campaign up.</div>` +
      `<label class="f-label">Join code</label>` +
      `<input class="f-input" id="su-code" placeholder="SMR1~…">` +
      `<label class="f-label">Your callsign</label>` +
      `<input class="f-input" id="su-jn-name" placeholder="e.g. Rax" value="${esc(localStorage.getItem(callsignKey) || '')}">` +
      `<div class="f-note" id="su-code-note"></div>` +
      `<div class="modal-actions"><button class="btn btn-ghost" id="su-back">← Back</button>` +
      `<button class="btn btn-primary" id="su-join">Continue →</button></div>`,
      true
    );
    $('su-back').addEventListener('click', showStart);
    $('su-join').addEventListener('click', () => {
      const code = $('su-code').value.trim();
      const who = $('su-jn-name').value.trim();
      if (!code) { $('su-code-note').textContent = 'Paste the code first.'; return; }
      if (!who) { $('su-code-note').textContent = 'And your callsign — that name is your login on every device.'; $('su-jn-name').focus(); return; }
      try {
        if (!window.OrgNet) throw new Error('multiplayer module missing');
        OrgNet.readCode(code);
        localStorage.setItem(NET_KEY, code);
        localStorage.setItem(callsignKey, who);
        location.reload();
      } catch (err) {
        $('su-code-note').textContent = '⚠ That does not look like a valid join code — ask your organizer for a fresh one.';
      }
    });
  }

  function showCreate(firstIn) {
    openModal(
      (firstIn
        ? `<h2>You're first in — set up the campaign</h2>` +
          `<div class="m-sub">This board is shared: everyone with the join code lands here. Six quick steps and the war room opens for the whole org.</div>`
        : `<h2>2 · Solo demo campaign</h2>` +
          `<div class="m-sub">Six quick steps and the war room opens. This demo lives in this browser only — to play it with your org, ` +
          `the <a class="linklike" href="org-setup.html">organizer guide</a> builds you a shared board, then you come back through door 1 with the code.</div>`) +
      `<label class="f-label">1 · Name the campaign</label><input class="f-input" id="su-name" value="The Stanton Campaign">` +
      `<label class="f-label">2 · How many days will it last?</label>` +
      `<div class="seg-row" id="su-days">` +
      `<button type="button" class="seg-opt" data-days="7">7 — shakedown run</button>` +
      `<button type="button" class="seg-opt sel" data-days="28">28 — the full campaign</button>` +
      `<button type="button" class="seg-opt" data-days="42">42 — the long war</button>` +
      `</div>` +
      `<label class="f-label">3 · When does the season start?</label>` +
      `<div class="seg-row" id="su-staged">` +
      `<button type="button" class="seg-opt${netMode ? '' : ' sel'}" data-staged="0">The moment I create it</button>` +
      `<button type="button" class="seg-opt${netMode ? ' sel' : ''}" data-staged="1">Muster first — I fire the gun later</button>` +
      `</div>` +
      (netMode ? `<div class="f-note">Muster is the multiplayer move: share the join code, let everyone enlist and pledge, then start day 1 when the org is aboard.</div>` : '') +
      `<label class="f-label">4 · Your callsign</label><input class="f-input" id="su-callsign" placeholder="e.g. Rax" value="${esc(localStorage.getItem(callsignKey) || '')}">` +
      `<label class="f-label">5 · Your calling — sets your starting org ship only</label>` +
      `<div class="calling-grid" id="su-calling">${Object.entries((D.ranks && D.ranks.tracks) || {}).map(([k, t], i) =>
        `<button type="button" class="cal-tile${i === 0 ? ' sel' : ''}" data-cal="${k}">${esc(t.name)}</button>`).join('')}</div>` +
      `<div class="f-note"><b>This does not limit what you can do.</b> Anyone can take any contract — and the more you do of a thing, the better ships the org offers you, automatically.</div>` +
      `<label class="f-label">6 · Add the ships you own (optional) — tap each one</label>` +
      `<div class="f-note">Pledging is free — the org later spends ORG funds to commission hulls into service. You can add more any time from the fleet tab.</div>` +
      shipGridHtml('su-grid', new Set(), '') +
      `<div class="pledge-chips" id="su-chips"></div>` +
      `<div class="modal-actions">` +
      (firstIn ? '' : `<button class="btn btn-ghost" id="su-back">← Back</button>`) +
      `<button class="btn btn-primary" id="su-start">Create & open the war room →</button></div>`,
      true
    );
    const back = $('su-back');
    if (back) back.addEventListener('click', showStart);
    let seasonDays = 28;
    document.querySelectorAll('#su-days .seg-opt').forEach(b => b.addEventListener('click', () => {
      seasonDays = +b.dataset.days;
      document.querySelectorAll('#su-days .seg-opt').forEach(x => x.classList.toggle('sel', x === b));
    }));
    let staged = netMode;
    document.querySelectorAll('#su-staged .seg-opt').forEach(b => b.addEventListener('click', () => {
      staged = b.dataset.staged === '1';
      document.querySelectorAll('#su-staged .seg-opt').forEach(x => x.classList.toggle('sel', x === b));
    }));
    let calling = Object.keys((D.ranks && D.ranks.tracks) || {})[0] || null;
    document.querySelectorAll('#su-calling .cal-tile').forEach(b => b.addEventListener('click', () => {
      calling = b.dataset.cal;
      document.querySelectorAll('#su-calling .cal-tile').forEach(x => x.classList.toggle('sel', x === b));
    }));
    const pledges = [];
    const markTile = (ship, on) => {
      const t = document.querySelector(`#su-grid .ship-tile[data-ship="${CSS.escape(ship)}"]`);
      if (!t) return;
      t.classList.toggle('added', on);
      t.querySelector('.st-n').textContent = (on ? '✓ ' : '') + ship;
    };
    const drawChips = () => {
      $('su-chips').innerHTML = pledges.map((s, i) =>
        `<span class="pchip">${esc(s)} <button data-rm="${i}" type="button">✕</button></span>`).join('');
      $('su-chips').querySelectorAll('[data-rm]').forEach(b =>
        b.addEventListener('click', () => { const [gone] = pledges.splice(+b.dataset.rm, 1); markTile(gone, false); drawChips(); }));
    };
    bindShipGrid(document.getElementById('modal-root'), 'su-grid', (ship) => {
      const i = pledges.indexOf(ship);
      if (i >= 0) { pledges.splice(i, 1); markTile(ship, false); }
      else { pledges.push(ship); markTile(ship, true); }
      drawChips();
    });
    $('su-start').addEventListener('click', () => {
      const name = $('su-name').value.trim() || 'The Stanton Campaign';
      const cs = $('su-callsign').value.trim();
      if (!cs) { $('su-callsign').focus(); $('su-callsign').placeholder = 'your callsign first — e.g. Rax'; return; }
      localStorage.setItem(callsignKey, cs);
      localStorage.setItem(whoOkKey(), '1');
      const seed = Math.random().toString(36).slice(2, 10);
      store.append(OrgState.newEvent('campaign.create', cs, { name, system: 'Stanton', seed, mode: 'from-zero', seasonDays, staged: staged || undefined }));
      store.append(OrgState.newEvent('member.join', cs, { callsign: cs, calling }));
      pledges.forEach(sn => store.append(OrgState.newEvent('fleet.pledge', cs, { ship: sn })));
    });
  }

  // ── Join / log in (a campaign exists, this callsign isn't in it yet) ────
  // The callsign IS the login: type a name the campaign knows — from any
  // device or browser — and you're recognized. New names pick a calling and join.
  let joinPrompted = false;
  function showJoin() {
    const daysLeft = state.config.seasonDays - state.season.daysPlayed + 1;
    openModal(
      `<h2>⚑ ${esc(state.config.name || 'Org Campaign')}</h2>` +
      `<div class="m-sub">Day ${state.season.daysPlayed} of ${state.config.seasonDays} · ${Object.keys(state.members).length} member${Object.keys(state.members).length === 1 ? '' : 's'} enlisted. ` +
      `Type your callsign — if you've flown with us before, on any device, you're recognized by name.</div>` +
      `<label class="f-label">Your callsign</label>` +
      `<input class="f-input" id="jn-callsign" placeholder="e.g. Rax" value="${esc(localStorage.getItem(callsignKey) && callsignDisplay() !== 'Anonymous' ? callsignDisplay() : '')}">` +
      `<div id="jn-dyn"></div>` +
      `<div class="modal-actions"><button class="btn btn-primary" id="jn-go">Join the campaign →</button></div>`,
      true
    );
    let calling = Object.keys((D.ranks && D.ranks.tracks) || {})[0] || null;
    const update = () => {
      const key = OrgState.normName($('jn-callsign').value);
      const known = key && state.members[key];
      if (known) {
        $('jn-dyn').innerHTML = `<div class="f-note" style="margin-top:8px">👋 Welcome back, <b>${esc(known.display)}</b> — ` +
          `${known.total} contract${known.total === 1 ? '' : 's'} on the books.</div>`;
        $('jn-go').textContent = `Log in as ${known.display} →`;
      } else {
        $('jn-dyn').innerHTML =
          `<label class="f-label">Your calling — sets your starting org ship only</label>` +
          `<div class="calling-grid" id="jn-calling">${Object.entries((D.ranks && D.ranks.tracks) || {}).map(([k, t]) =>
            `<button type="button" class="cal-tile${k === calling ? ' sel' : ''}" data-cal="${k}">${esc(t.name)}</button>`).join('')}</div>` +
          `<div class="f-note"><b>This does not limit what you can do</b> — anyone takes any contract.</div>`;
        document.querySelectorAll('#jn-calling .cal-tile').forEach(b => b.addEventListener('click', () => {
          calling = b.dataset.cal;
          document.querySelectorAll('#jn-calling .cal-tile').forEach(x => x.classList.toggle('sel', x === b));
        }));
        $('jn-go').textContent = 'Join the campaign →';
      }
    };
    $('jn-callsign').addEventListener('input', update);
    update();
    $('jn-go').addEventListener('click', () => {
      const raw = $('jn-callsign').value.trim();
      if (!raw) { $('jn-callsign').focus(); return; }
      localStorage.setItem(callsignKey, raw);
      localStorage.setItem(whoOkKey(), '1');
      const key = OrgState.normName(raw);
      modalSticky = false;
      if (!state.members[key]) store.append(OrgState.newEvent('member.join', raw, { callsign: raw, calling }));
      else refold();
      closeModal();
    });
  }

  // ── Modal helpers / chrome ──────────────────────────────────────────────
  let modalSticky = false;
  function openModal(html, sticky) {
    modalSticky = !!sticky;
    $('modal-root').innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal">${html}</div></div>`;
    if (!sticky) $('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
  }
  function closeModal() { if (modalSticky) return; $('modal-root').innerHTML = ''; }

  function bindChrome() {
    $('btn-log').addEventListener('click', () => showLogModal());
    setInterval(() => { if (state) refold(); }, 60000);
    $('btn-export').addEventListener('click', () => {
      const blob = new Blob([store.exportLog()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'org-campaign-log.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $('import-file').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      f.text().then(txt => { try { store.importLog(txt); } catch (err) { alert('Not a campaign log: ' + err.message); } });
      e.target.value = '';
    });
    if (netMode) {
      $('btn-reset').style.display = 'none';
      $('btn-leave').style.display = '';
      $('btn-leave').addEventListener('click', (e) => armConfirm(e.currentTarget, () => {
        localStorage.removeItem(NET_KEY);
        location.reload();
      }, 'leave this campaign — sure?'));
    } else {
      $('btn-reset').addEventListener('click', (e) => armConfirm(e.currentTarget, () => store.clear(), 'erase the log — sure?'));
    }
    document.querySelectorAll('.oh-tabs [data-info]').forEach(b =>
      b.addEventListener('click', () => setInfo(b.dataset.info)));
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if ($('modal-root').innerHTML) closeModal();
      else if (infoView) setInfo(null);
    });
  }

  init();
})();
