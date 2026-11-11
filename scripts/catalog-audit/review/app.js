/* Catalog review UI: products (arrow keys / J K, A approve, F flag, U undo, 1-9 disagree with a change), collections, rules. */
(async function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
  const D = await (await fetch('api/data')).json();
  let FB = await (await fetch('api/feedback')).json();
  FB.products = FB.products || {}; FB.collections = FB.collections || {};

  const C = Object.fromEntries(D.collections.map((c) => [c.handle, c]));
  const title = (h) => (C[h] && C[h].title) || h;
  const SYSTEM = new Set(['pinterest-feed', 'festive-sale', 'shop-all-collections']);
  const ROOMS = new Set(['living-room', 'bedroom', 'dining-room', 'study-room', 'entrance', 'kitchen', 'bathroom']);
  const ruleTitle = Object.fromEntries(D.rules.map((r) => [r.id, r.title]));
  ruleTitle.Visual = 'Spotted in image check'; ruleTitle.Review = 'Your review';

  // ---------- filters ----------
  const opt = (sel, items) => { for (const [v, t] of items) sel.insertAdjacentHTML('beforeend', `<option value="${esc(v)}">${esc(t)}</option>`); };
  opt($('#fColl'), D.collections.filter((c) => !SYSTEM.has(c.handle)).sort((a, b) => a.title.localeCompare(b.title)).map((c) => [c.handle, `${c.title}${c.isNew ? ' (new)' : ''}  ${c.before}→${c.after}`]));
  opt($('#fRule'), [...D.rules.map((r) => [r.id, `${r.id} ${r.title}`]), ['Visual', 'Visual: spotted in image check']]);
  opt($('#fFam'), [...new Set(D.products.map((p) => p.family))].sort().map((f) => [f, f]));
  const ROOM = Object.fromEntries(D.rooms.map((r) => [r.handle, r]));
  const roomCount = (h) => D.products.filter((p) => p.room.room === h).length;
  opt($('#fRoom'), D.rooms.map((r) => [r.handle, `${r.title}${r.isNew ? ' (new)' : ''}  ${roomCount(r.handle)}`]));
  const myRoom = (p) => (FB.products[p.id] || {}).room;
  const finalRoom = (p) => myRoom(p) || p.room.room;

  const state = { list: [], i: 0 };
  const F = () => ({ scope: $('#fScope').value, coll: $('#fColl').value, mode: $('#fCollMode').value, rule: $('#fRule').value, act: $('#fAct').value,
    conf: $('#fConf').value, fam: $('#fFam').value, status: $('#fStatus').value, q: $('#fq').value.trim().toLowerCase(),
    room: $('#fRoom').value, roomConf: $('#fRoomConf').value });

  function relation(p, h) {
    const b = p.before.includes(h), a = p.after.includes(h);
    return b && !a ? 'leaving' : !b && a ? 'joining' : b && a ? 'staying' : null;
  }
  function applyFilters(keepId) {
    const f = F();
    const list = D.products.filter((p) => {
      const ch = p.changes.filter((c) => (!f.rule || c.rule === f.rule) && (!f.act || c.action === f.act) && (!f.conf || c.confidence === f.conf));
      if (f.coll) {
        const rel = relation(p, f.coll);
        if (!rel) return false;
        if (f.mode === 'any' && rel === 'staying') return false;
        if (['leaving', 'joining', 'staying'].includes(f.mode) && rel !== f.mode) return false;
      } else if (f.scope === 'changed' && !f.room && !f.roomConf && !p.changes.length && !p.notes.length) return false;
      if (f.room && finalRoom(p) !== f.room) return false;
      if (f.roomConf === 'mine' && !myRoom(p)) return false;
      if (f.roomConf && f.roomConf !== 'mine' && p.room.confidence !== f.roomConf) return false;
      if ((f.rule || f.act || f.conf) && !ch.length) return false;
      if (f.fam && p.family !== f.fam) return false;
      const st = (FB.products[p.id] || {}).status;
      if (f.status === 'none' && st) return false;
      if (f.status && f.status !== 'none' && st !== f.status) return false;
      if (f.q && !p.title.toLowerCase().includes(f.q)) return false;
      return true;
    });
    if (f.coll) { const order = { leaving: 0, joining: 1, staying: 2 }; list.sort((a, b) => order[relation(a, f.coll)] - order[relation(b, f.coll)]); }
    state.list = list;
    const idx = keepId ? list.findIndex((p) => p.id === keepId) : -1;
    state.i = idx >= 0 ? idx : 0;
    $('#count').textContent = `${list.length} products`;
    const ctx = $('#ctx');
    if (f.coll) {
      const c = C[f.coll]; const n = { leaving: 0, joining: 0, staying: 0 };
      for (const p of D.products) { const r = relation(p, f.coll); if (r) n[r]++; }
      ctx.classList.remove('hidden');
      ctx.innerHTML = `<b>${esc(c.title)}</b>${c.isNew ? '<span class="tag-new">NEW</span>' : ''} &nbsp; ${c.before} → <b>${c.after}</b> products &nbsp;·&nbsp; leaving ${n.leaving} · joining ${n.joining} · staying ${n.staying} &nbsp;·&nbsp; <span class="small">${esc(c.promise || '')}</span>`;
    } else ctx.classList.add('hidden');
    renderList(); render();
  }
  ['#fScope', '#fColl', '#fCollMode', '#fRule', '#fAct', '#fConf', '#fFam', '#fStatus', '#fRoom', '#fRoomConf'].forEach((s) => $(s).addEventListener('change', () => applyFilters()));
  $('#fq').addEventListener('input', () => applyFilters());

  // ---------- list ----------
  const thumb = (u, w) => (u ? u + (u.includes('?') ? '&' : '?') + 'width=' + w : '');
  function renderList() {
    const el = $('#list');
    const max = Math.min(state.list.length, 1500);
    let html = '';
    for (let k = 0; k < max; k++) {
      const p = state.list[k]; const st = (FB.products[p.id] || {}).status || '';
      const rem = p.changes.filter((c) => c.action === 'remove').length, add = p.changes.filter((c) => c.action === 'add').length;
      html += `<div class="li${k === state.i ? ' on' : ''}" data-k="${k}"><img loading="lazy" src="${esc(thumb(p.image, 100))}"><div><div class="t">${esc(p.title)}</div><div class="m"><span class="rm">${esc(ROOM[finalRoom(p)].title)}${myRoom(p) ? ' ✎' : ''}</span> · ${add ? '+' + add : ''} ${rem ? '−' + rem : ''} · ${esc(p.family)}</div></div><span class="st ${st}">${st === 'flagged' ? 'FLAG' : st === 'approved' ? 'OK' : ''}</span></div>`;
    }
    if (state.list.length > max) html += `<div class="li small">… ${state.list.length - max} more (narrow the filters)</div>`;
    el.innerHTML = html;
  }
  $('#list').addEventListener('click', (e) => { const li = e.target.closest('.li[data-k]'); if (li) { state.i = Number(li.dataset.k); render(); } });

  // ---------- detail ----------
  function chips(p) {
    const all = [...new Set([...p.before, ...p.after])].filter((h) => !SYSTEM.has(h));
    const cls = (h) => (p.before.includes(h) && !p.after.includes(h) ? 'rem' : !p.before.includes(h) && p.after.includes(h) ? 'add' : ROOMS.has(h) ? 'room' : '');
    const order = { rem: 0, add: 1, '': 2, room: 3 };
    return all.sort((a, b) => order[cls(a)] - order[cls(b)]).map((h) => `<span class="chip ${cls(h)}" title="${esc(h)}">${esc(title(h))}</span>`).join('');
  }
  function roomBox(p) {
    const mine = myRoom(p), shown = ROOM[finalRoom(p)];
    const alts = p.room.alternatives.map((a) => a.title).join(', ');
    const buttons = D.rooms.map((r, k) => `<button data-room="${esc(r.handle)}" class="${r.handle === p.room.room ? 'prop' : ''} ${r.handle === mine ? 'mine' : ''}" title="Shift+${k + 1}">${k + 1} ${esc(r.title)}${r.isNew ? ' (new)' : ''}</button>`).join('');
    return `<div class="roombox${mine ? ' changed' : ''}">
      <div class="big"><span class="lab">Best room</span>${esc(shown.title)}${shown.isNew ? '<span class="tag-new">NEW ROOM</span>' : ''}</div>
      <div class="why">${mine ? `Your choice. Proposed was <b>${esc(ROOM[p.room.room].title)}</b> (${esc(p.room.confidence)}): ${esc(p.room.reason)}` : `${esc(p.room.confidence)} confidence · ${esc(p.room.reason)}${alts ? ` · runner-up: ${esc(alts)}` : ''}`}</div>
      <div class="pick">${buttons}</div></div>`;
  }
  function setRoom(h) {
    const p = state.list[state.i]; if (!p) return;
    const fb = entry(p);
    if (h === p.room.room || h === fb.room) delete fb.room; else fb.room = h;
    fb.updatedAt = new Date().toISOString(); cleanup(p); save(); render();
    const li = document.querySelector(`#list .li[data-k="${state.i}"] .rm`);
    if (li) li.textContent = ROOM[finalRoom(p)].title + (myRoom(p) ? ' ✎' : '');
  }
  function render() {
    const p = state.list[state.i];
    document.querySelectorAll('#list .li').forEach((el) => el.classList.toggle('on', Number(el.dataset.k) === state.i));
    const on = document.querySelector('#list .li.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    updateProgress();
    if (!p) { $('#detail').innerHTML = '<p>No products match these filters.</p>'; return; }
    const fb = FB.products[p.id] || {};
    const dis = new Set(fb.disagree || []);
    const changes = p.changes.map((c, k) => `<div class="change${dis.has(c.collection + ':' + c.action) ? ' disagree' : ''}">
        <div class="what ${c.action}">${c.action === 'add' ? '+ Added to' : '− Removed from'} ${esc(title(c.collection))}${C[c.collection] && C[c.collection].isNew ? '<span class="tag-new">NEW</span>' : ''}</div>
        <div class="why">${esc(c.reason)}<div class="small">${esc(c.rule)} · ${esc(ruleTitle[c.rule] || '')}</div></div>
        <div class="conf">${esc(c.confidence)}</div>
        <button data-dis="${esc(c.collection + ':' + c.action)}" title="Key ${k + 1}">${dis.has(c.collection + ':' + c.action) ? 'Undo disagree' : `Disagree (${k + 1})`}</button></div>`).join('');
    const notes = p.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('');
    const next = state.list[state.i + 1]; if (next) new Image().src = thumb(next.image, 900);
    $('#detail').innerHTML = `<div class="img"><img src="${esc(thumb(p.image, 900))}" alt=""></div>
      <div class="info">
        <h2>${esc(p.title)}</h2>
        <div class="sub">${state.i + 1} of ${state.list.length} · ${esc(p.family)} · <a href="${esc(p.url)}" target="_blank">open on site</a></div>
        ${roomBox(p)}
        <div class="small">Collections (red = leaving, green = joining, grey = rooms)</div>
        <div class="chips">${chips(p)}</div>
        ${changes || '<div class="small">No changes proposed for this product.</div>'}
        ${notes}
        <div class="desc">${esc(p.desc)}</div>
        <div class="fb">
          <div class="row"><span>Your review:</span> <span class="status ${fb.status || ''}">${fb.status ? fb.status.toUpperCase() : 'not reviewed'}</span>
            <span style="margin-left:auto"></span>
            <button class="btn" data-act="approve">Approve (A)</button> <button class="btn" data-act="flag">Flag (F)</button> <button class="btn" data-act="undo">Undo (U)</button></div>
          <textarea id="comment" placeholder="What is wrong? e.g. keep in Boho, should also be in Peacock">${esc(fb.comment || '')}</textarea>
        </div>
        <div class="keys"><kbd>↑</kbd><kbd>↓</kbd> or <kbd>K</kbd><kbd>J</kbd> move · <kbd>A</kbd> approve and next · <kbd>F</kbd> flag and type a comment · <kbd>U</kbd> clear · <kbd>1</kbd>–<kbd>9</kbd> disagree with one change · <kbd>Shift</kbd>+<kbd>1</kbd>–<kbd>9</kbd> pick the room · <kbd>Esc</kbd> leave the comment box</div>
      </div>`;
  }
  $('#detail').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.room) setRoom(b.dataset.room);
    if (b.dataset.dis) toggleDisagree(b.dataset.dis);
    if (b.dataset.act) act(b.dataset.act);
  });
  $('#detail').addEventListener('input', (e) => {
    if (e.target.id !== 'comment') return;
    const p = state.list[state.i]; const fb = entry(p);
    fb.comment = e.target.value;
    if (fb.comment && !fb.status) { fb.status = 'flagged'; const s = document.querySelector('.fb .status'); if (s) { s.className = 'status flagged'; s.textContent = 'FLAGGED'; } }
    save();
  });

  function entry(p) { return (FB.products[p.id] = FB.products[p.id] || { title: p.title, handle: p.handle }); }
  function cleanup(p) { const fb = FB.products[p.id]; if (fb && !fb.status && !fb.comment && !fb.room && !(fb.disagree || []).length) delete FB.products[p.id]; }
  function toggleDisagree(key) {
    const p = state.list[state.i]; const fb = entry(p);
    const s = new Set(fb.disagree || []); s.has(key) ? s.delete(key) : s.add(key); fb.disagree = [...s];
    if (fb.disagree.length) fb.status = 'flagged';
    fb.updatedAt = new Date().toISOString(); cleanup(p); save(); render(); renderListItem();
  }
  function act(a) {
    const p = state.list[state.i]; if (!p) return;
    const fb = entry(p);
    if (a === 'approve') { fb.status = 'approved'; fb.disagree = []; }
    if (a === 'flag') fb.status = 'flagged';
    if (a === 'undo') { const room = fb.room; delete FB.products[p.id]; if (room) FB.products[p.id] = { title: p.title, handle: p.handle, room }; }
    else fb.updatedAt = new Date().toISOString();
    save(); renderListItem();
    if (a === 'approve') move(1); else render();
    if (a === 'flag') setTimeout(() => { const t = $('#comment'); if (t) t.focus(); }, 0);
  }
  function renderListItem() {
    const el = document.querySelector(`#list .li[data-k="${state.i}"] .st`); const p = state.list[state.i];
    if (!el || !p) return; const st = (FB.products[p.id] || {}).status || '';
    el.className = 'st ' + st; el.textContent = st === 'flagged' ? 'FLAG' : st === 'approved' ? 'OK' : '';
  }
  function move(d) { state.i = Math.max(0, Math.min(state.list.length - 1, state.i + d)); render(); }

  document.addEventListener('keydown', (e) => {
    if ($('#products-view').style.display === 'none') return;
    const typing = ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
    if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    const k = e.key.toLowerCase();
    if (e.shiftKey && /^Digit[1-9]$/.test(e.code)) { const r = D.rooms[Number(e.code.slice(5)) - 1]; if (r) setRoom(r.handle); return; }
    if (k === 'arrowdown' || k === 'j') { e.preventDefault(); move(1); }
    else if (k === 'arrowup' || k === 'k') { e.preventDefault(); move(-1); }
    else if (k === 'a') act('approve');
    else if (k === 'f') { e.preventDefault(); act('flag'); }
    else if (k === 'u') act('undo');
    else if (/^[1-9]$/.test(k)) { const p = state.list[state.i]; const c = p && p.changes[Number(k) - 1]; if (c) toggleDisagree(c.collection + ':' + c.action); }
  });

  // ---------- save ----------
  let timer;
  function save() {
    $('#save').textContent = 'Saving…';
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { const r = await fetch('api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(FB) }); $('#save').textContent = r.ok ? 'Saved ' + new Date().toLocaleTimeString() : 'Save failed'; }
      catch { $('#save').textContent = 'Save failed (is serve.js running?)'; }
    }, 400);
    updateProgress();
  }
  function updateProgress() {
    const changed = D.products.filter((p) => p.changes.length);
    const vals = Object.values(FB.products);
    const reviewed = changed.filter((p) => FB.products[p.id] && FB.products[p.id].status).length;
    $('#progress').textContent = `${reviewed} of ${changed.length} changed products reviewed · ${vals.filter((v) => v.status === 'flagged').length} flagged · ${vals.filter((v) => v.room).length} rooms changed · ${Object.keys(FB.collections).length} collection notes`;
  }

  // ---------- collections tab ----------
  let sortKey = 'family', sortDir = 1;
  function renderColl() {
    const rows = D.collections.filter((c) => !SYSTEM.has(c.handle)).slice().sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      return (typeof va === 'number' ? va - vb : String(va || '').localeCompare(String(vb || ''))) * sortDir || a.title.localeCompare(b.title);
    });
    const cc = (h) => D.collectionChanges.filter((x) => x.handle === h).map((x) => `<b>${esc(x.type)}:</b> ${esc(x.change)}`).join('<br>');
    const parentCell = (c) => c.parent === c.currentParent ? esc(c.parent ? title(c.parent) : '') : `<span class="moved">${esc(c.currentParent ? title(c.currentParent) : '—')} → ${esc(c.parent ? title(c.parent) : '—')}</span>`;
    const kids = (c) => c.children.map((k) => `${c.currentChildren.includes(k) ? '' : '<b>+</b>'}${esc(title(k))}`).join(', ') + c.currentChildren.filter((k) => !c.children.includes(k)).map((k) => ` <s>${esc(title(k))}</s>`).join('');
    const rel = (c) => c.related.map((r) => `${esc(title(r.handle))}${r.why === 'curated' ? '' : `<span class="small"> (${r.why})</span>`}`).join(', ');
    $('#coll').innerHTML = `<p class="small">Click a product count to review that collection's products. Parent and nested changes are in orange; <b>+</b> marks a new nested link, struck-through is removed. Notes autosave.</p>
      <table><thead><tr>
        <th data-k="title">Collection</th><th data-k="family">Family</th><th data-k="before" class="num">Now</th><th data-k="after" class="num">After</th><th data-k="added" class="num">+</th><th data-k="removed" class="num">−</th>
        <th data-k="parent">Parent (breadcrumb)</th><th>Nested children</th><th>Related (up to 8)</th><th>Collection-level change</th><th>Your note</th></tr></thead><tbody>
      ${rows.map((c) => `<tr><td><b>${esc(c.title)}</b>${c.isNew ? '<span class="tag-new">NEW</span>' : ''}<div class="small">${esc(c.handle)}</div><div class="small">${esc(c.promise || '')}</div>${c.menus.length ? `<div class="small">Menu: ${esc(c.menus.slice(0, 2).join(' | '))}</div>` : ''}</td>
        <td>${esc(c.family)}</td><td class="num"><a href="#" data-open="${esc(c.handle)}" data-mode="all">${c.before}</a></td><td class="num"><b>${c.after}</b></td>
        <td class="num"><a href="#" data-open="${esc(c.handle)}" data-mode="joining">${c.added || ''}</a></td><td class="num"><a href="#" data-open="${esc(c.handle)}" data-mode="leaving">${c.removed || ''}</a></td>
        <td>${parentCell(c)}</td><td>${kids(c)}</td><td>${rel(c)}</td><td>${cc(c.handle)}</td>
        <td><textarea class="cfb" data-c="${esc(c.handle)}" rows="2" placeholder="Issue?">${esc((FB.collections[c.handle] || {}).comment || '')}</textarea></td></tr>`).join('')}
      </tbody></table>`;
  }
  $('#coll').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]'); if (th) { sortDir = sortKey === th.dataset.k ? -sortDir : 1; sortKey = th.dataset.k; renderColl(); return; }
    const a = e.target.closest('a[data-open]'); if (!a) return;
    e.preventDefault(); $('#fColl').value = a.dataset.open; $('#fCollMode').value = a.dataset.mode; showTab('products'); applyFilters();
  });
  $('#coll').addEventListener('input', (e) => {
    const t = e.target.closest('textarea[data-c]'); if (!t) return;
    if (t.value.trim()) FB.collections[t.dataset.c] = { title: title(t.dataset.c), comment: t.value, updatedAt: new Date().toISOString() };
    else delete FB.collections[t.dataset.c];
    save();
  });

  // ---------- rules tab ----------
  function renderRules() {
    const s = D.stats;
    $('#rules').innerHTML = `<h2>How products were re-mapped</h2>
      <p class="small">Generated ${esc(new Date(D.generatedAt).toLocaleString())}. ${s.changed} of ${s.products} products change: ${s.removals} removals, ${s.additions} additions. Nothing has been changed on the live store.</p>
      <h3>Principles</h3><ol>${D.principles.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>
      <h3>Rules</h3><table><thead><tr><th>ID</th><th>Rule</th><th>What it does</th><th>Changes</th></tr></thead><tbody>
      ${D.rules.map((r) => `<tr><td>${r.id}</td><td><b>${esc(r.title)}</b></td><td>${esc(r.text)}</td><td class="num"><a href="#" data-rule="${r.id}">${s.byRule[r.id] || 0}</a></td></tr>`).join('')}
      <tr><td>Visual</td><td><b>Image check</b></td><td>Low-confidence removals were checked against the product image. Kept items show a blue note; confirmed ones say "(image checked)".</td><td class="num"><a href="#" data-rule="Visual">${s.byRule.Visual || 0}</a></td></tr>
      </tbody></table>
      <h3>Best room</h3><p class="small">One room per product, scored from its collections and words in the title and description. Low confidence usually means "no strong signal, defaulted to Living Room".</p>
      <table><thead><tr><th>Room</th><th class="num">Products</th><th class="num">High</th><th class="num">Medium</th><th class="num">Low</th><th>Note</th></tr></thead><tbody>
      ${D.rooms.map((r) => { const c = (s.rooms || {})[r.handle] || { high: 0, medium: 0, low: 0 }; return `<tr><td><a href="#" data-room="${esc(r.handle)}">${esc(r.title)}</a>${r.isNew ? '<span class="tag-new">NEW</span>' : ''}</td><td class="num">${c.high + c.medium + c.low}</td><td class="num">${c.high}</td><td class="num">${c.medium}</td><td class="num">${c.low}</td><td class="small">${esc(r.promise)}</td></tr>`; }).join('')}
      </tbody></table>
      <h3>New collections</h3><table><thead><tr><th>Collection</th><th>Tag</th><th>Parent</th><th class="num">Products</th><th>Why</th></tr></thead><tbody>
      ${D.newCollections.map((n) => `<tr><td><a href="#" data-open="${esc(n.handle)}">${esc(n.title)}</a></td><td>${esc(n.tag)}</td><td>${esc(n.parent ? title(n.parent) : '')}</td><td class="num">${C[n.handle] ? C[n.handle].after : 0}</td><td>${esc(n.promise)}</td></tr>`).join('')}
      </tbody></table>`;
  }
  $('#rules').addEventListener('click', (e) => {
    const a = e.target.closest('a'); if (!a) return; e.preventDefault();
    if (a.dataset.rule) { $('#fColl').value = ''; $('#fRule').value = a.dataset.rule; }
    if (a.dataset.room) { $('#fColl').value = ''; $('#fRule').value = ''; $('#fRoom').value = a.dataset.room; $('#fScope').value = 'all'; }
    if (a.dataset.open) { $('#fColl').value = a.dataset.open; $('#fCollMode').value = 'all'; $('#fRule').value = ''; }
    showTab('products'); applyFilters();
  });

  // ---------- tabs ----------
  function showTab(t) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $('#products-view').style.display = t === 'products' ? 'flex' : 'none';
    $('#filters').style.display = t === 'products' ? 'flex' : 'none';
    $('#coll').classList.toggle('hidden', t !== 'coll');
    $('#rules').classList.toggle('hidden', t !== 'rules');
    if (t === 'coll') renderColl();
    if (t === 'rules') renderRules();
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  applyFilters();
})();
