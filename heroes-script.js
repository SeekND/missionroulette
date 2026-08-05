/* Hero Adventures codex — stat cards grouped by system; tap one to open the full detail overlay.
   Only player-facing fields are shown; internal notes (authorNotes, TODO, sourceNotes) never appear. */
(async () => {
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const isTodo = v => v == null || (typeof v === 'string' && (/^\s*(todo|tbd)/i.test(v) || !v.trim()));
  const SOLO = { 'yes':'Soloable', 'yes-hard':'Solo: hard', 'yes-very-hard':'Solo: very hard', 'yes-extremely-hard':'Solo: extreme', 'no':'Group only' };
  const SOLO_CLS = { 'yes':'ok', 'yes-hard':'warn', 'yes-very-hard':'warn', 'yes-extremely-hard':'bad', 'no':'bad' };
  const CAT = { 'combat-fps':'FPS combat', 'combat-ship':'Ship combat', 'combat-boss':'Boss fight', 'industrial':'Mining', 'mixed':'Mixed op', 'collection-combat':'Collection run' };
  const SYS_ORDER = ['Stanton', 'Nyx', 'Pyro'];  // 4 · 3 · 2
  const rank = { active:0, upcoming:1, disabled:2 };
  const shortTime = d => { const m = String(d).match(/~?\s*[\d]+(?:[.–\-][\d]+)?\s*(?:h|hr|hour|min|m)\b/i); return m ? m[0].replace(/\s+/g,'').replace(/hour|hr/i,'h') : d; };

  const codex = document.getElementById('codex');
  const back = document.getElementById('detail');
  let data;
  try { data = await (await fetch('hero_adventures.json', {cache:'no-store'})).json(); }
  catch (e) { codex.innerHTML = '<p>Couldn\'t load the codex data.</p>'; return; }

  const byId = data.heroAdventures || {};
  const groups = {};
  for (const [id, h] of Object.entries(byId)) (groups[h.system] ||= []).push([id, h]);
  for (const g of Object.values(groups)) g.sort((a, b) => (rank[a[1].status] ?? 1) - (rank[b[1].status] ?? 1)); // active first, upcoming last

  const cardHTML = ([id, h]) => {
    const players = h.players && h.players.recommended != null ? h.players.recommended : '—';
    const time = !isTodo(h.duration) ? shortTime(h.duration) : '—';
    const solo = h.soloable ? `<span class="hbadge ${SOLO_CLS[h.soloable] || ''}">${esc(SOLO[h.soloable] || h.soloable)}</span>` : '';
    const status = (h.status && h.status !== 'active') ? `<span class="chip ${h.status}">${esc(h.status)}</span>` : '';
    return `<button class="hcard" data-id="${esc(id)}">
      <div class="hcard-head"><h3>${esc(h.name)}</h3>${status}</div>
      <div class="hcard-stats">
        <div class="stat"><b>${esc(players)}</b><span>players</span></div>
        <div class="stat-div"></div>
        <div class="stat"><b>${esc(time)}</b><span>time</span></div>
      </div>
      <div class="hcard-foot"><span class="hcard-kind">${esc(CAT[h.category] || h.category || '')}</span>${solo}</div>
    </button>`;
  };

  codex.innerHTML = SYS_ORDER.filter(s => groups[s]).map(s =>
    `<section class="codex-group g-${s}">
       <h2 class="sys-label sys-${s}">${s}</h2>
       <div class="codex-row">${groups[s].map(cardHTML).join('')}</div>
     </section>`
  ).join('');

  // ---- detail overlay ----
  function openDetail(h) {
    const chips = [`<span class="chip sys-${esc(h.system)}">${esc(h.system)}</span>`];
    if (h.status) chips.push(`<span class="chip ${h.status}">${esc(h.status)}</span>`);
    if (h.soloable) chips.push(`<span class="chip">${esc(SOLO[h.soloable] || h.soloable)}</span>`);
    if (h.players && h.players.recommended != null) chips.push(`<span class="chip">${esc(h.players.recommended)} recommended</span>`);
    if (h.mode) chips.push(`<span class="chip">${h.mode === 'both' ? 'ship + on-foot' : esc(h.mode)}</span>`);
    if (h.pvpRisk) chips.push(`<span class="chip bad">PvP risk</span>`);

    const rows = [];
    const row = (k, v) => { if (!isTodo(v)) rows.push(`<div><span class="k">${k}</span><span>${esc(v)}</span></div>`); };
    row('Where', h.location);
    const gate = (!isTodo(h.repRequirements) && h.repRequirements) || (!isTodo(h.prerequisites) && h.prerequisites) || 'Open to all';
    row('Gate', gate);
    if (h.buyIn) row('Buy-in', Number(h.buyIn).toLocaleString('en-US') + ' aUEC');
    row('Reward', h.rewards);
    row('Ships', h.shipsRequired);
    if (h.ammoWarning) row('Heads-up', 'Bring extra ammo — no restock mid-mission');
    row('Time', h.duration);
    if (!isTodo(h.schedule)) row('When', h.schedule);

    let steps = '';
    if (Array.isArray(h.steps) && h.steps.length)
      steps = `<div class="detail-steps"><h4>How to do it</h4><ol>${h.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>`;
    let tools = '';
    if (Array.isArray(h.tools) && h.tools.length)
      tools = `<p class="detail-tools">Helpers: ${h.tools.map(t => esc(t)).join(' · ')}</p>`;

    back.innerHTML = `<div class="detail-panel g-${esc(h.system)}" role="dialog" aria-modal="true" aria-label="${esc(h.name)}">
      <button class="detail-close" aria-label="Close">✕</button>
      <h2>${esc(h.name)}</h2>
      <p class="detail-kind">${esc(CAT[h.category] || '')}</p>
      <div class="chips">${chips.join('')}</div>
      <div class="detail-facts">${rows.join('')}</div>
      ${steps}${tools}
    </div>`;
    back.hidden = false;
    document.body.style.overflow = 'hidden';
    back.querySelector('.detail-close').focus();
  }
  function close() { back.hidden = true; back.innerHTML = ''; document.body.style.overflow = ''; }

  codex.addEventListener('click', e => { const b = e.target.closest('.hcard'); if (b) openDetail(byId[b.dataset.id]); });
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('.detail-close')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !back.hidden) close(); });
})();
