/* ============================================================================
   PT.dlg — conversations, driven by reading them.

   Before this file the rig talked to people by pressing Space and hoping.
   SKILL.md warned that this "can pick 'Just watching' instead of 'Deal me
   in'" without saying why.  Here is why, from the dialog mode's own onKey:

       if (sigNow !== this.lastSig && performance.now() - this.nodeT < 450){
         this.lastSig = sigNow;
         this.cursor = opts.length - 1;      // <-- parks on the BOTTOM row
         break;                              // <-- and eats the press
       }

   The anti-misclick guard does not merely swallow the press.  It moves the
   cursor to the LAST option, and the last option is almost always the one
   that declines.  So a fast blind Space does not do nothing - it arms the
   refusal, and the second press takes it.

   Everything here follows from three facts:

     1. `pageDone()` must be true before a press means anything; while text
        is still paging, Space only finishes the page.
     2. A press commits once `performance.now() - nodeT >= 450`, OR once
        `lastSig` already equals the current signature - and moving the
        cursor sets `lastSig`, so a deliberate ArrowDown disarms the guard.
     3. Options carry their label on `.t`, not `.label`, and `visibleOpts()`
        has already applied every `if` gate.  Read that, never the screen.
   ============================================================================ */
(() => {
const PT = window.PT;
const D = PT.dlg = PT.dlg || {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* the dialog mode, or null - and not a mode that merely sits under one */
D.mode = () => { const m = topMode(); return (m && m.name === 'dialog') ? m : null; };

/* ------------------------------------------------------------- reading --- */
D.read = () => {
  const m = D.mode();
  if (!m) { const t = topMode(); return t ? { notDialog: t.name } : null; }
  const cur = m.cur();
  if (!cur) return { title: m.title, node: m.node, text: null,
                     dead: 'cur() is empty - this node does not exist' };
  const opts = m.visibleOpts() || [];
  return {
    title: m.title, node: m.node,
    text: typeof cur.text === 'function' ? cur.text() : cur.text,
    opts: opts.map((o, i) => (i === m.cursor ? '>' : ' ') + o.t),
    cursor: m.cursor,
    paging: !m.pageDone(),
    /* ms still to wait before a press commits rather than arming the refusal */
    guard: Math.max(0, 450 - (performance.now() - m.nodeT)) | 0,
    next: cur.next || null
  };
};

/* ------------------------------------------------------------ pressing --- */
/* Finish any text still paging in, so that options exist to choose from. */
D.page = async () => {
  if (!D.mode()) return 'no dialogue';
  let g = 0;
  while (D.mode() && !D.mode().pageDone() && g++ < 40){ PT.tap('Space'); await sleep(60); }
  return D.mode() ? (D.mode().pageDone() ? 'paged' : 'still paging') : 'closed while paging';
};

/* wait out the 450 ms anti-misclick window so the next press commits */
D.disarm = async (m) => {
  m = m || D.mode(); if (!m) return;
  const left = 450 - (performance.now() - m.nodeT);
  if (left > 0) await sleep(left + 60);
};

/* Pick an option by substring (case-insensitive) or by index, and verify it
   actually committed. */
D.say = async (want, o) => {
  o = o || {};
  let m = D.mode();
  if (!m) return { ok: false, why: 'no dialogue open' };
  await D.page();
  m = D.mode();
  if (!m) return { ok: false, why: 'dialogue closed while paging' };

  const opts = m.visibleOpts() || [];
  if (!opts.length){                     // a plain page: Space just advances
    const from = m.node;
    await D.disarm(m);
    PT.tap('Space');
    await sleep(120);
    return { ok: true, picked: '(continue)', from,
             to: D.mode() ? D.mode().node : '(closed)' };
  }

  let idx = -1;
  if (typeof want === 'number') idx = want;
  else {
    const w = String(want).toLowerCase();
    idx = opts.findIndex(x => String(x.t).toLowerCase().indexOf(w) >= 0);
  }
  if (idx < 0 || idx >= opts.length)
    return { ok: false, why: 'no option matching "' + want + '"',
             opts: opts.map(x => x.t), node: m.node };

  /* Walk the cursor with real key events. Each move also sets lastSig, which
     is what disarms the guard - so this is both the selection and the safety. */
  let g = 0;
  while (m.cursor !== idx && g++ < opts.length * 2 + 2){
    const fwd = ((idx - m.cursor + opts.length) % opts.length) <= opts.length / 2;
    PT.tap(fwd ? 'ArrowDown' : 'ArrowUp');
    await sleep(40);
    m = D.mode();
    if (!m) return { ok: false, why: 'dialogue closed while moving the cursor' };
  }
  if (m.cursor !== idx)
    return { ok: false, why: 'cursor would not settle on ' + idx,
             at: m.cursor, opts: opts.map(x => x.t) };

  const from = m.node, label = opts[idx].t, wasT = m.nodeT;
  await D.disarm(m);
  PT.tap('Space');
  await sleep(150);

  const after = D.mode();
  const to = after ? after.node : '(closed)';
  /* The honest commit test is NOT "did the node change" - plenty of options
     loop back to the node they were on (selling one unit at a time re-enters
     'job'), and calling that a failure would be my instrument lying, not the
     game. `go()` re-stamps `nodeT` on every transition INCLUDING same-node
     re-entry, so an advanced nodeT is the signal that the press was taken.
     A press the guard ate leaves nodeT exactly where it was. */
  if (after && after.nodeT === wasT && !o.mayStay)
    return { ok: false, why: 'press did not commit - guard ate it, still on "' + from + '"',
             picked: label, cursor: after.cursor,
             opts: (after.visibleOpts() || []).map(x => x.t) };
  const r = after ? D.read() : null;
  return { ok: true, picked: label, from, to: (to === from ? to + ' (re-entered)' : to),
           text: r && r.text, opts: r && r.opts };
};

/* Run a script of choices in order, stopping at the first that does not match. */
D.run = async (script, o) => {
  o = o || {};
  const trace = [];
  for (const want of script){
    if (!D.mode()){ trace.push('(dialogue closed)'); break; }
    const r = await D.say(want, o);
    trace.push((r.ok ? '' : 'FAILED ') + JSON.stringify(r).slice(0, 240));
    if (!r.ok && !o.loose) break;
  }
  return { trace, open: !!D.mode(), now: D.mode() ? D.read() : null, see: PT.see() };
};

/* Auto-advance without a script: take the option `choose` names, or the FIRST
   by default. Bounded, and it refuses to spin on a node it has already left
   twice - a tree that cycles is a finding, not something to loop on. */
D.walk = async (o) => {
  o = o || {};
  const seen = {}, trace = [];
  for (let i = 0; i < (o.max || 12); i++){
    const m = D.mode(); if (!m) break;
    const r = D.read();
    if (r.dead){ trace.push('DEAD NODE ' + m.node + ' - ' + r.dead); break; }
    seen[m.node] = (seen[m.node] || 0) + 1;
    if (seen[m.node] > 2){ trace.push('LOOP on node ' + m.node); break; }
    const opts = m.visibleOpts() || [];
    const want = o.choose ? o.choose(opts.map(x => x.t), m.node, r) : 0;
    if (want === null || want === false){ trace.push('stop at ' + m.node); break; }
    const res = await D.say(want === undefined ? 0 : want, { mayStay: true });
    trace.push(m.node + ' --[' + (res.picked || res.why) + ']--> ' + (res.to || '?'));
    if (!res.ok && res.why && /no option/.test(res.why)) break;
  }
  return { trace, open: !!D.mode(), now: D.mode() ? D.read() : null };
};

/* Leave. The 250 ms open-guard applies to Escape too. */
D.close = async () => {
  const m = D.mode();
  if (!m) return topMode() ? ('not dialogue: ' + topMode().name) : 'nothing open';
  const left = 250 - (performance.now() - m.openedT);
  if (left > 0) await sleep(left + 60);
  PT.tap('Escape');
  await sleep(120);
  if (topMode()) PT.act.esc();
  return topMode() ? ('still open: ' + topMode().name) : 'closed';
};

/* ---------------------------------------------------------------- to ----- */
/* Walk to somebody, open them, and hand back the first page - one round trip. */
D.to = async (who, o) => {
  o = o || {};
  const a = (typeof who === 'string')
    ? actors.filter(x => actorHere(x) && x.name === who)
        .sort((p, q) => Math.hypot(p.x - cam.x, p.y - cam.y) -
                        Math.hypot(q.x - cam.x, q.y - cam.y))[0]
    : who;
  if (!a) return { ok: false, why: 'no actor named ' + who + ' in this scene' };
  if (topMode()) await D.close();
  PT.act.reach(a, { want: o.want || 'TALK', kind: 'actor', use: true });
  const s = await PT.see.settle({ ms: o.ms, quiet: true });
  await sleep(250);
  const m = D.mode();
  /* Opening SOMEBODY is not the same as opening WHO YOU ASKED FOR. In a room
     with two named bodies the probe takes the nearer one, and a caller that
     only checks "is a dialogue open" will happily script ROOK's tree at
     VESPER. Compare the title. */
  const wrong = m && a.name && m.title !== a.name;
  return { ok: !!m && !wrong, wrongPerson: wrong ? (m.title + ', not ' + a.name) : undefined,
           reach: PT.act.reachState(), settled: s.settled,
           dlg: D.read(), see: PT.see() };
};
})();
'PT.dlg loaded';
