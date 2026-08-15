/* Shared campaign map — drawn identically for the war room and the public
 * battle map. The war room feeds it live folded state; the public page feeds it
 * a state decoded from the URL, so a spectator needs no code and no database.
 *
 * Link format (deliberately short enough for Discord):
 *   campaignmap.html?S12.28-yl100-dm55a-ce20f&n=The%20Stanton%20Campaign
 *   ^ system + day.total, then one segment per zone: <code><percent><flags>
 *     flags: a = under attack   f = front line   (100% = held)
 *   Zones at 0% with no flags are left out.
 */
(function () {
  'use strict';

  const SYS_CODE = { Stanton: 'S', Pyro: 'P', Nyx: 'N' };
  const SYS_NAME = { S: 'Stanton', P: 'Pyro', N: 'Nyx' };
  // stable two-letter codes — never renumber these, old links must keep working
  const ZONE_CODE = {
    hurston: 'hu', aberdeen: 'ab', arial: 'ar', ita: 'it', magda: 'mg',
    crusader: 'cr', cellin: 'ce', daymar: 'dm', yela: 'yl',
    arccorp: 'ac', lyria: 'ly', wala: 'wa',
    microtech: 'mt', calliope: 'ca', clio: 'cl', euterpe: 'eu',
  };
  const CODE_ZONE = {};
  for (const [z, c] of Object.entries(ZONE_CODE)) CODE_ZONE[c] = z;

  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function lerpColor(a, b, t) {
    const pa = [1, 3, 5].map(i => parseInt(a.substr(i, 2), 16));
    const pb = [1, 3, 5].map(i => parseInt(b.substr(i, 2), 16));
    const m = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.max(0, Math.min(1, t))));
    return '#' + m.map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function geometry(board) {
    const cfg = board.config;
    const spacing = 1000 * cfg.ring_scale / 100 / (cfg.maxRing + 0.5);
    const edgeR = 1000 * cfg.edge_scale / 100;
    const toXY = (angle, radius) => ({
      x: 500 + Math.cos((angle - 90) * Math.PI / 180) * radius,
      y: 500 + Math.sin((angle - 90) * Math.PI / 180) * radius,
    });
    const pos = {};
    for (const [zid, z] of Object.entries(board.zones)) {
      if (z.parent) continue;
      pos[zid] = toXY(z.angle, z.edge ? edgeR : z.ring * spacing);
    }
    for (const [zid, z] of Object.entries(board.zones)) {
      if (!z.parent) continue;
      const p = pos[z.parent];
      const off = toXY(z.moonAngle, z.moonDist * spacing);
      pos[zid] = { x: p.x + (off.x - 500), y: p.y + (off.y - 500), parent: z.parent };
    }
    return { spacing, edgeR, toXY, pos };
  }

  // zoneId → its definition, across every region of a system
  function zoneDefs(regions, system) {
    const out = {};
    const sys = regions.systems[system];
    if (!sys) return out;
    for (const r of Object.values(sys.regions)) {
      for (const [zid, def] of Object.entries(r.zones)) out[zid] = def;
    }
    return out;
  }

  /* render(svg, {board, regions, system, zones, fronts, raided, selected})
   * zones: {zoneId: {control, held}} — anything missing counts as untouched. */
  function render(svg, o) {
    const board = o.board;
    const defs = zoneDefs(o.regions, o.system);
    const { spacing, edgeR, toXY, pos } = geometry(board);
    const cfg = board.config;
    const zones = o.zones || {};
    const fronts = o.fronts || {};
    const raided = o.raided instanceof Set ? o.raided : new Set(o.raided || []);
    const out = [];

    // orbit rings
    for (let r = 1; r <= cfg.maxRing; r++) out.push(`<circle class="org-ring" cx="500" cy="500" r="${(r * spacing).toFixed(1)}"/>`);
    // belts
    for (const b of Object.values(board.belts || {})) {
      const r = (b.belt_radius != null ? b.belt_radius : b.ring) * spacing;
      out.push(`<circle class="org-belt" cx="500" cy="500" r="${r.toFixed(1)}"/>`);
    }
    // star
    out.push(`<circle cx="500" cy="500" r="7" fill="#d8b56a" opacity=".85"/>`);

    // gates — sealed in the Stanton-only demo season
    for (const g of Object.values(board.gates || {})) {
      const p = toXY(g.angle, g.edge ? edgeR : g.ring * spacing);
      out.push(`<g class="org-gate" opacity=".35">` +
        `<rect x="${p.x - 6}" y="${p.y - 6}" width="12" height="12" transform="rotate(45 ${p.x} ${p.y})"/>` +
        `<text x="${p.x}" y="${p.y - 12}" text-anchor="middle">${esc(g.name)} · sealed</text></g>`);
    }
    // landmarks — labels start below; a measured post-pass moves each to a free side
    for (const l of Object.values(board.landmarks || {})) {
      const p = toXY(l.angle, l.edge ? edgeR : l.ring * spacing);
      out.push(`<g class="org-landmark${l.ref ? ' ref' : ''}"><rect x="${p.x - 3}" y="${p.y - 3}" width="6" height="6"/>` +
        `<text data-px="${p.x}" data-py="${p.y}" x="${p.x}" y="${p.y + 14}" text-anchor="middle">${esc(l.name)}</text></g>`);
    }

    // satellite tethers under markers
    for (const [zid, z] of Object.entries(board.zones)) {
      if (!z.parent) continue;
      const a = pos[z.parent], b = pos[zid];
      out.push(`<line class="org-tether" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
    }

    // zones
    for (const [zid, zb] of Object.entries(board.zones)) {
      const def = defs[zid];
      if (!def) continue;
      const zs = zones[zid] || { control: 0, held: false };
      const control = Math.max(0, Math.min(100, zs.control || 0));
      const held = !!zs.held || control >= 100;
      const p = pos[zid];
      const isPlanet = !zb.parent && !zb.station;
      const r = isPlanet ? 20 : (zb.station ? 9 : 11);
      // the state color language: grey = locked · amber = beachhead (mining open) · green = secured
      const fill = held ? '#3fb950' : control > 0 ? lerpColor('#4a3a1a', '#ffb454', control / 100) : '#232838';
      const cls = 'zone' + (held ? ' held' : '') + (o.selected === zid ? ' selected' : '') + (raided.has(zid) ? ' raided' : '');
      let marker;
      if (zb.station) {
        marker = `<rect class="z-marker" x="${p.x - r}" y="${p.y - r}" width="${r * 2}" height="${r * 2}" fill="${fill}" transform="rotate(45 ${p.x} ${p.y})"/>`;
      } else {
        marker = `<circle class="z-marker" cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}"/>`;
      }
      const deco = (zb.hasRing ? `<circle class="z-ring-deco" cx="${p.x}" cy="${p.y}" r="${r + 6}"/>` : '') +
        (raided.has(zid) ? `<circle class="z-threat" cx="${p.x}" cy="${p.y}" r="${r + 13}"/>` : '');
      const sel = `<circle class="z-sel" cx="${p.x}" cy="${p.y}" r="${r + 9}"/>`;
      const pct = held ? 'HELD' : (control > 0 ? Math.round(control) + '%' : '');
      const marks = (fronts[zid] ? '<tspan class="tsp-front"> ⚑</tspan>' : '') +
        (raided.has(zid) ? '<tspan class="tsp-threat"> ⚠</tspan>' : '');
      // planets label above; satellites label radially away from their parent so families fan out
      let lx = p.x, ly = p.y - r - 8, anchor = 'middle', labelCls = 'z-label', pctX = p.x, pctY = p.y + r + 16, pctAnchor = 'middle';
      if (zb.parent) {
        const pp = pos[zb.parent];
        const dx = p.x - pp.x, dy = p.y - pp.y, len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        lx = p.x + ux * (r + 13);
        ly = p.y + uy * (r + 13) + (uy > 0.3 ? 10 : (uy < -0.3 ? -2 : 4));
        anchor = ux > 0.35 ? 'start' : (ux < -0.35 ? 'end' : 'middle');
        labelCls = 'z-label sat';
        pctX = lx; pctY = ly + 13; pctAnchor = anchor;
      }
      out.push(`<g class="${cls}" data-zone="${zid}">${deco}${sel}${marker}` +
        `<text class="${labelCls}" x="${lx}" y="${ly}" text-anchor="${anchor}">${esc(def.name)}${marks}</text>` +
        (pct ? `<text class="z-pct" x="${pctX}" y="${pctY}" text-anchor="${pctAnchor}">${pct}</text>` : '') +
        `</g>`);
    }

    // legend — the color language, taught on the map itself
    out.push(`<g class="map-legend">` +
      `<circle cx="24" cy="974" r="7" fill="#232838" stroke="#2e3447"/><text x="37" y="978">locked</text>` +
      `<circle cx="112" cy="974" r="7" fill="#ffb454"/><text x="125" y="978">beachhead — mining open</text>` +
      `<circle cx="352" cy="974" r="7" fill="#3fb950"/><text x="365" y="978">secured</text></g>`);

    svg.innerHTML = out.join('');
    placeLandmarkLabels(svg);
  }

  // Measured label placement: try below / above / right / left of the marker and
  // keep the first side that doesn't overlap any existing label or marker box.
  function placeLandmarkLabels(svg) {
    const overlap = (a, b) =>
      Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 &&
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;
    const obstacles = [];
    svg.querySelectorAll('.zone text, .zone .z-marker, .org-gate text, .org-landmark rect').forEach(el =>
      obstacles.push(el.getBBox()));
    for (const t of svg.querySelectorAll('.org-landmark text')) {
      const px = parseFloat(t.dataset.px), py = parseFloat(t.dataset.py);
      const candidates = [
        { x: px, y: py + 14, a: 'middle' },
        { x: px, y: py - 8, a: 'middle' },
        { x: px + 7, y: py + 3.5, a: 'start' },
        { x: px - 7, y: py + 3.5, a: 'end' },
        { x: px, y: py + 26, a: 'middle' },
        { x: px, y: py - 20, a: 'middle' },
        { x: px + 17, y: py + 3.5, a: 'start' },
        { x: px - 17, y: py + 3.5, a: 'end' },
        { x: px + 9, y: py + 15, a: 'start' },
        { x: px - 9, y: py + 15, a: 'end' },
        { x: px + 9, y: py - 10, a: 'start' },
        { x: px - 9, y: py - 10, a: 'end' },
        { x: px + 9, y: py + 27, a: 'start' },
        { x: px - 9, y: py + 27, a: 'end' },
      ];
      let placed = null, leastBad = null, leastArea = Infinity;
      for (const c of candidates) {
        t.setAttribute('x', c.x); t.setAttribute('y', c.y); t.setAttribute('text-anchor', c.a);
        const box = t.getBBox();
        let bad = 0;
        for (const o of obstacles) {
          if (overlap(box, o)) bad += Math.min(box.x + box.width, o.x + o.width) - Math.max(box.x, o.x);
        }
        if (bad === 0) { placed = c; break; }
        if (bad < leastArea) { leastArea = bad; leastBad = c; }
      }
      const c = placed || leastBad;
      t.setAttribute('x', c.x); t.setAttribute('y', c.y); t.setAttribute('text-anchor', c.a);
      obstacles.push(t.getBBox());
    }
  }

  // ── The share link ──────────────────────────────────────────────────────
  // encodeState(state) → "S12.28-yl100-dm55a" (war room side)
  function encodeState(state) {
    const sys = SYS_CODE[state.config.system] || 'S';
    const day = state.season && state.season.mustering ? 0 : Math.min(state.tick + 1, state.config.seasonDays);
    const parts = [`${sys}${day}.${state.config.seasonDays}`];
    const raided = new Set(((state.director && state.director.active) || [])
      .filter(m => m.kind === 'raid').map(m => m.zone));
    for (const [zid, z] of Object.entries(state.zones)) {
      const code = ZONE_CODE[zid];
      if (!code) continue;
      const pct = Math.round(Math.max(0, Math.min(100, z.control || 0)));
      const flags = (raided.has(zid) ? 'a' : '') + (state.fronts && state.fronts[zid] ? 'f' : '');
      if (!pct && !flags) continue;
      parts.push(code + pct + flags);
    }
    return parts.join('-');
  }

  // decodeState("S12.28-yl100-dm55a") → {system, day, days, zones, fronts, raided}
  function decodeState(str) {
    const segs = String(str || '').trim().split('-').filter(Boolean);
    if (!segs.length) return null;
    const head = /^([SPN])(\d+)\.(\d+)$/i.exec(segs[0]);
    if (!head) return null;
    const outZones = {}, fronts = {}, raided = [];
    for (const seg of segs.slice(1)) {
      const m = /^([a-z]{2})(\d{1,3})([af]*)$/i.exec(seg);
      if (!m) continue;
      const zid = CODE_ZONE[m[1].toLowerCase()];
      if (!zid) continue;
      const pct = Math.max(0, Math.min(100, parseInt(m[2], 10)));
      outZones[zid] = { control: pct, held: pct >= 100 };
      const flags = (m[3] || '').toLowerCase();
      if (flags.includes('a')) raided.push(zid);
      if (flags.includes('f')) fronts[zid] = true;
    }
    return {
      system: SYS_NAME[head[1].toUpperCase()] || 'Stanton',
      day: +head[2], days: +head[3],
      zones: outZones, fronts, raided,
    };
  }

  window.OrgMap = { render, geometry, lerpColor, zoneDefs, encodeState, decodeState, ZONE_CODE };
})();
