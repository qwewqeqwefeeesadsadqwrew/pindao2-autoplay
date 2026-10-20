// v12-loop.js -- closed-loop autoplay for the 拼刀2 web game.
//
// Same file runs in two places:
//   * in the page : injected after v12-engine.js; reads the live roles through the
//                   game's own objects and steers with control.mainHeroMove(x,y),
//                   which is the exact call the on-screen joystick makes.
//   * offline     : require()d by v12-test.js with a fake sense()/act().
//
// Loop shape (once per tick):
//   sense -> build a faithful World -> trim to what can reach me in the horizon
//         -> plan() (HP is a hard constraint) -> act(unit direction)
//
// Everything the plan needs is read fresh every tick, so a wrong guess about the
// future can only cost one tick, never the whole run.

(function (root, factory) {
  var E = null;
  if (typeof module !== 'undefined' && module.exports) E = require('./v12-engine.js');
  else if (root && root.ZD12) E = root.ZD12;
  var api = factory(E);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ZD12LOOP = api;
})(typeof window !== 'undefined' ? window : globalThis, function (E) {
  'use strict';

  var D = E.D;

  // ---------------------------------------------------------------- live sensing
  function nowMs() {
    try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
    catch (e) { return Date.now(); }
  }
  function wpos(o) {
    try { var p = o._view.node.worldPosition; return { x: p.x, y: p.y }; } catch (e) { return null; }
  }
  function sizeOf(o) {
    try { return o._size ? { w: o._size.width, h: o._size.height } : null; } catch (e) { return null; }
  }
  // RoleHero: config + weapon module are the authority for every number below.
  function heroState(h) {
    if (!h) return null;
    var p = wpos(h); if (!p) return null;
    var cf = h._config || {};
    var mod = h._weaponModule || {};
    var ws = mod._weapons || [];
    var blades = [];
    for (var i = 0; i < ws.length; i++) {
      var b = ws[i];
      if (!b || b._hp <= 0) continue;
      blades.push({ hp: b._hp, ang: (b._radian || 0) * 180 / Math.PI });
    }
    var mv = h._moveDir;
    return {
      x: p.x, y: p.y, hp: h._hp, maxHp: cf.hp || 10,
      wradius: cf.weapon_radius, wcfg: mod.cfg || D.WEAPON[cf.weapon],
      rot: h._weaponRotationSpeed, wangle: h._weaponAngle,
      blades: blades, speed: h._moveSpeed, size: sizeOf(h),
      agent: cf.agent || 0, id: cf.id || 0,
      dirx: mv ? mv.x : 0, diry: mv ? mv.y : 0
    };
  }
  function monState(m) {
    var p = wpos(m); if (!p) return null;
    var cf = m._config || {}, mv = m._moveDir;
    return {
      x: p.x, y: p.y, dx: mv ? mv.x : 0, dy: mv ? mv.y : 0,
      speed: m._moveSpeed || 200, hp: m._hp, atk: m._atk,
      size: sizeOf(m), id: cf.id || 0
    };
  }
  function propState(o) {
    var p = wpos(o); if (!p) return null;
    var cf = o._config || {};
    return {
      x: p.x, y: p.y, type: cf.type, param: cf.type_param,
      size: sizeOf(o), id: cf.id || 0, auto: !!o.isAutoRefresh
    };
  }
  function liveRoot() {
    if (typeof window === 'undefined') return null;
    var st = window.YT && window.YT.logic && window.YT.logic.state;
    return st || null;
  }
  function liveMapRect() {
    try {
      var ui = liveRoot().ui, ml = ui && ui.mapLayer, r = ml.MAP_RECT;
      return { xMin: r.xMin, xMax: r.xMax, yMin: r.yMin, yMax: r.yMax };
    } catch (e) { return { xMin: -2549.2, xMax: 3450.8, yMin: -2333, yMax: 3667 }; }
  }
  // Read the whole world the way the engine wants it. Returns null when we are not
  // in a live level with a main hero.
  function liveSense() {
    var st = liveRoot();
    if (!st || !st._control) return { ok: false, why: 'no-control' };
    var c = st._control, rt = c._runTimeData;
    if (!rt) return { ok: false, why: 'no-runtime' };
    var mh = rt.mainHero || (c._roleMgr && c._roleMgr._mainHero);
    if (!mh) return { ok: false, why: 'no-main-hero', dead: true };
    var me = heroState(mh);
    if (!me) return { ok: false, why: 'no-main-pos' };
    var rm = rt.roleMap || {};
    var ai = rt.aiHeros || [], foes = [], i, o;
    for (i = 0; i < ai.length; i++) { o = heroState(ai[i]); if (o) foes.push(o); }
    var mons = [], marr = rm['3'] || [];
    for (i = 0; i < marr.length; i++) { if (marr[i]._hp > 0) { o = monState(marr[i]); if (o) mons.push(o); } }
    var props = [], parr = rm['4'] || [];
    for (i = 0; i < parr.length; i++) { o = propState(parr[i]); if (o) props.push(o); }
    var state = {
      t: c._runTime || 0, mapRect: liveMapRect(), me: me, foes: foes, mons: mons, props: props,
      dieHeroCnt: c._dieHeroCnt || 0, totalHeroCnt: c._totalHeroCnt || 0
    };
    return { ok: true, world: new E.World(state), state: state,
      meta: { runTime: c._runTime, die: c._dieHeroCnt, tot: c._totalHeroCnt,
        nFoe: foes.length, nMon: mons.length, nProp: props.length } };
  }
  // The joystick's own call: ZDTouchLayer._onTouchMove normalises the drag vector and
  // then calls exactly this.
  function liveAct(ux, uy) {
    try {
      var st = liveRoot(), c = st && st._control;
      if (!c) return false;
      c.mainHeroMove(ux, uy);
      return true;
    } catch (e) { return false; }
  }
  function liveStop() { try { liveRoot()._control.mainHeroCancelMove(); } catch (e) { } }

  // ---------------------------------------------------------------- target choice
  // Farming is the default. Hunting only opens up when the exchange maths is
  // clearly in our favour: we need fewer clash-hits to strip them than we can
  // absorb, they must be weaker, and they must be alone.
  function pickTarget(world, opt) {
    var me = world.me;
    if (E.heroCnt(me) < (opt.huntMinBlades || 8)) return null;
    var myHp = E.heroBladeHp(me), myAtk = E.bladeAtk(me);
    var cap = opt.finishBlades !== undefined ? opt.finishBlades : 6;
    var finishRange = opt.finishRange !== undefined ? opt.finishRange : 2400;
    var finishSafe = opt.finishSafe !== undefined ? opt.finishSafe : 700;
    var wantFinish = opt.finish !== false;
    // The leash stays on: a 950 px gate is what "react to what is on your screen" means.
    // A separate "once the map is nearly clear, hunt anywhere" switch was built and
    // measured (16 seeds, _ab/r9/_C_finishclear16.txt): 15 of the 16 runs came out
    // byte-identical, and the one run it did touch went from 2 survivors to 6. Rule kept
    // out -- there is no evidence it helps and one seed where it hurts.
    var huntRange = opt.huntRange || 1500;
    if (opt.clearHunt === true && world.foes.length <= (opt.clearFoeMax !== undefined ? opt.clearFoeMax : 6)) {
      huntRange = opt.clearHuntRange !== undefined ? opt.clearHuntRange : 20000;
    }
    var best = null, i, j;
    for (i = 0; i < world.foes.length; i++) {
      var f = world.foes[i];
      if (f.dead) continue;
      if (opt.skipBoss && isBoss(f, opt)) continue;        // 清场阶段：BOSS 不算猎物
      if (E.heroCnt(f) > E.heroCnt(me)) continue;          // 刀比我们多的：不碰
      var d = Math.sqrt((f.x - me.x) * (f.x - me.x) + (f.y - me.y) * (f.y - me.y));
      if (wantFinish && freeKill(world, f, cap, finishSafe)) {
        if (d > finishRange) continue;                     // 空壳：够得着就去捡
      } else {
        var theirHp = E.heroBladeHp(f), theirAtk = E.bladeAtk(f);
        var need = theirHp / myAtk, absorb = myHp / theirAtk;
        if (need * (opt.huntMargin || 1.45) > absorb) continue; // 换不过来：不碰
        if (d > huntRange) continue;
        // 追不上的不追：目标正在远离、速度不比我慢、距离已经拉开——直线追永远缩不短，
        // 画面上只剩「追着跑」。近距离照样追（还能截击）。
        if (d > (opt.chaseNear || 700)) {
          var ux2 = (f.x - me.x) / d, uy2 = (f.y - me.y) / d;
          var away2 = (f.dirx || 0) * ux2 + (f.diry || 0) * uy2;
          if (away2 > (opt.chaseAway || 0.35) && (f.speed || 0) >= (me.speed || 0) * (opt.chaseSpeed || 0.85)) continue;
        }
        // 落单要求：远山 2026-10-21 定「不用落单——只要算出来打得过就冲上去打」。
        // 默认 0 = 关掉这条；`?alone=520` 可以退回到「只打落单的」。
        var aloneR = opt.aloneRange !== undefined ? opt.aloneRange : 0;
        if (aloneR > 0) {
          var alone = true;
          for (j = 0; j < world.foes.length; j++) {
            if (j === i || world.foes[j].dead) continue;
            var g = world.foes[j];
            var gd = Math.sqrt((g.x - f.x) * (g.x - f.x) + (g.y - f.y) * (g.y - f.y));
            if (gd < aloneR) { alone = false; break; }
          }
          if (!alone) continue;
        }
      }
      if (!best || d < best.d) best = { x: f.x, y: f.y, d: d, id: f.id, blades: E.heroCnt(f) };
    }
    return best;
  }

  // ---------------------------------------------------------------- decision
  // Two kinds of prey, and the difference is what the ring can do back.
  //
  //  * A live ring: the old hunt gates apply (fewer blades than us, the exchange maths
  //    comes out ahead, and it is on its own so nobody piles in).
  //  * An empty ring: it literally cannot hurt us. `heroVsHero` trades blade for blade,
  //    and its "hit the body" branch needs a live blade on THEIR side (`ni >= 0`); with
  //    no blades nothing on their side can ever be picked, so contact only ever removes
  //    their hero hp. Those are free kills -- and a body removed from the map is exactly
  //    what the level objective counts ("only the hero and the BOSS left").
  //
  // Measured, this is what every live run leaves behind: defanged survivors nobody ever
  // touched, because `huntRange` (950 px) only ever sees an enemy that walks into our own
  // screen, no matter how harmless it is.
  //   live12g (died at 220 s): 10204/w0  10201/w0  alive at the end
  //   live12h (alive at 299 s): 10206/w0 10204/w7 alive at the end
  // So free kills get a longer leash, but they are still scored by distance against the
  // live targets -- a corpse 2400 px away must not beat a fight 400 px away.
  function freeKill(world, f, cap, safe) {
    if (E.heroCnt(f) > cap) return false;
    // Do not cross a real fight to finish a corpse: if a live ring sits next to it, the
    // detour is not free any more and the normal gates decide.
    for (var j = 0; j < world.foes.length; j++) {
      var g = world.foes[j];
      if (g === f || g.dead) continue;
      if (E.heroCnt(g) <= cap) continue;
      var gd = Math.sqrt((g.x - f.x) * (g.x - f.x) + (g.y - f.y) * (g.y - f.y));
      if (gd < safe) return false;
    }
    return true;
  }

  // Which prop is worth walking to? The ring is the defence, so "add blades" props
  // are the bread and butter; a retype that upgrades the weapon or an attack prop are
  // worth a detour. Value per second, so a far prop loses to a near one.
  // The blade is the shield: `heroVsHero` does `a.blades[i].hp -= bladeAtk(b)`, so what
  // decides a fight is how many HITS a blade absorbs, not its raw hp. Against the level-3
  // BOSS (10303, weapon 20, attack 3) that makes blade hp 4 a breakpoint:
  //   hp 3 -> 3-3 = 0   dead on the first hit
  //   hp 4 -> 4-3 = 1 > 0, survives, dies on the second
  // So a swap is judged against the hardest attack on the field, and a swap that costs a
  // hit (or the reach that came with it) is scored NEGATIVE -- the pickers skip anything
  // <= 0, so those props become things to walk around instead of onto.
  function propValue(p, me, world) {
    var D2 = E.D;
    if (p.type === 1) return 2.0 * (p.param || 1);
    if (p.type === 2) {
      var wc = D2.WEAPON[p.param];
      if (!wc || !me.wcfg) return 0;
      var foeAtk = 1, i;
      if (world) {
        for (i = 0; i < world.foes.length; i++) {
          var f = world.foes[i];
          if (f.dead) continue;
          var a = E.bladeAtk(f);
          if (a > foeAtk) foeAtk = a;
        }
      }
      var hitsNew = Math.ceil(wc.hp / foeAtk), hitsCur = Math.ceil(me.wcfg.hp / foeAtk);
      var gain = (hitsNew - hitsCur) * 12                        // a whole extra hit
        + (wc.width - me.wcfg.width) / 40                        // reach
        + (wc.atk - me.wcfg.atk) * 20;                           // attack (never on this level)
      return gain > 0 ? 3 + gain : -1;
    }
    // +rotation. Measured, not guessed (see _rotmath.js):
    //   src: RoleHero.contactHero does `o.subHp(n.atk); n.subHp(o.atk)` -- one blade pair
    //        per touching frame, damage = the other side's attack. `_weaponRotationSpeed`
    //        appears only in _onInit / _rotationUpdate / contactProp, never in damage.
    //   A/B: rings frozen at a fixed overlap, rot 100/200/400/800/1600 all hit 600 of
    //        600 frames (60/s). vs BOSS: rot 100..1600 -> dead in 1.5-1.8s, dealt 58-60.
    // So spin buys literally nothing. Keep a small positive value only so a prop we walk
    // over gets eaten instead of ignored -- it must never out-rank a blade or a weapon.
    if (p.type === 3) return 0.5;
    if (p.type === 4) return 4.0 * (p.param || 1);               // +attack
    return 0.5;
  }
  // Where can the hero actually stand? The engine (and the page) clamp the hero's CENTRE
  // to `map` inset by its own radius (weapon_radius + blade width). Props are dropped
  // relative to the hero, so some end up inside the map but outside that box -- chasing
  // one parks the hero against the wall for the rest of the match. Measured on seed 7:
  // 85 s frozen at (-2328,3446), radius 221, chasing a prop at (-2471,3487).
  function inReach(world, x, y, opt) {
    var m = world.map;
    if (!m) return true;
    var r = E.heroRadius(world.me);
    var tol = opt && opt.reachTol !== undefined ? opt.reachTol : 90;  // hero box + prop box
    return x >= m.xMin + r - tol && x <= m.xMax - r + tol &&
           y >= m.yMin + r - tol && y <= m.yMax - r + tol;
  }

  // If we have been told to move for a while and the hero has not left a small box, the
  // plan is fighting a wall. Head back inside instead of grinding against the border.
  // (Accumulated drift, not per-tick distance: a clamped hero still jitters a few px.)
  var _stall = { t: -1e9, ax: 0, ay: 0, n: 0 };
  function stallFrames(world, opt) {
    var me = world.me;
    var box = opt.stallBox || 40;
    if (!(world.t > _stall.t)) {          // new/rewound world: forget the old history
      _stall.t = world.t; _stall.ax = me.x; _stall.ay = me.y; _stall.n = 0;
      return 0;
    }
    var dx = me.x - _stall.ax, dy = me.y - _stall.ay;
    if (dx * dx + dy * dy > box * box) { _stall.ax = me.x; _stall.ay = me.y; _stall.n = 0; }
    else _stall.n++;
    _stall.t = world.t;
    return _stall.n;
  }
  function interiorPoint(world, opt) {
    var m = world.map, me = world.me;
    if (!m) return null;
    var pad = opt.unstickPad || 700;
    var tx = me.x < m.xMin + pad ? m.xMin + pad : (me.x > m.xMax - pad ? m.xMax - pad : me.x);
    var ty = me.y < m.yMin + pad ? m.yMin + pad : (me.y > m.yMax - pad ? m.yMax - pad : me.y);
    if (Math.abs(tx - me.x) < 60 && Math.abs(ty - me.y) < 60) {   // already inside: centre
      tx = (m.xMin + m.xMax) / 2; ty = (m.yMin + m.yMax) / 2;
    }
    return { x: tx, y: ty };
  }

  // Two shots at the same problem, both cheap.
  //  * Hysteresis on the run-away decision (see decide()).
  //  * Commitment: once we have picked a destination, keep steering at it for a moment.
  //    A policy that re-picks from scratch every tick will happily oscillate between two
  //    good ideas and travel nowhere.
  var _state = { t: -1e9, panic: false, tgt: null, mode: '', until: -1e9,
    bossIn: false, bossAt: 0, bossKillAt: 0, bossDie: -1,
    lastDie: 0, lastDieT: -1e9 };
  function rewind(world) {
    if (!(world.t > _state.t)) {
      _state.panic = false; _state.tgt = null; _state.mode = ''; _state.until = -1e9;
      _state.bossIn = false; _state.bossAt = 0; _state.bossKillAt = 0; _state.bossDie = -1;
    }
    _state.t = world.t;
  }
  function panicking(world, dom, standoff, standoffOut, opt) {
    var on = dom ? (dom.d < standoff || (_state.panic && dom.d < standoffOut)) : false;
    _state.panic = on;
    return on;
  }

  function pickWaypoint(world, opt) {
    var me = world.me, best = null;
    for (var i = 0; i < world.props.length; i++) {
      var p = world.props[i];
      if (p.taken) continue;
      if (!inReach(world, p.x, p.y, opt)) continue;
      var d = Math.sqrt((p.x - me.x) * (p.x - me.x) + (p.y - me.y) * (p.y - me.y));
      if (d > (opt.waypointRange || 1500)) continue;
      var v = propValue(p, me, world);
      if (v <= 0) continue;
      var s = v / (d + 90);                                      // value per second
      if (!best || s > best.s) best = { x: p.x, y: p.y, s: s, d: d, kind: p.type, param: p.param };
    }
    return best;
  }

  // A foe that can actually hurt us: its ring is bigger than ours, so the exchange goes
  // its way. Close enough to matter, within the threat range. This is not a target, it
  // only decides how careful we have to be about the map border.
  function nearestThreat(world, opt) {
    var me = world.me, myCnt = E.heroCnt(me), best = null;
    for (var i = 0; i < world.foes.length; i++) {
      var f = world.foes[i];
      if (f.dead) continue;
      if (E.heroCnt(f) <= myCnt * (opt.threatRatio || 1.15)) continue;
      var d = Math.sqrt((f.x - me.x) * (f.x - me.x) + (f.y - me.y) * (f.y - me.y));
      if (d > (opt.threatRange || 1800)) continue;
      if (!best || d < best.d) best = { h: f, d: d };
    }
    return best;
  }

  // A foe we cannot come out ahead against. Two ways to be one: it hits much harder per
  // clash (weapon attack -- the ring war is decided by that, not by blade count), or it
  // simply has far more blades. Against these the only play is distance.
  function dominantThreat(world, opt) {
    var me = world.me, myCnt = E.heroCnt(me), myAtk = E.bladeAtk(me), myRing = E.heroBladeHp(me);
    var best = null;
    for (var i = 0; i < world.foes.length; i++) {
      var f = world.foes[i];
      if (f.dead) continue;
      var theirAtk = E.bladeAtk(f), theirRing = E.heroBladeHp(f);
      var mightier = E.heroCnt(f) > myCnt * (opt.domBladeRatio || 1.25);
      var outgunned = (theirRing / myAtk) > (myRing / theirAtk) * (opt.domExchange || 1.3);
      if (!mightier && !outgunned) continue;
      var d = Math.sqrt((f.x - me.x) * (f.x - me.x) + (f.y - me.y) * (f.y - me.y));
      // Range: 2400 px is "close enough to matter right now". Measured on seed 7, the
      // level-3 BOSS lands ~4700 px away when it spawns at t=180 -- outside that radius,
      // so the policy kept farming straight towards it at 255 px/s while it closed at
      // 300, and the ring was gone 19 s later. A dominant threat now counts from anywhere
      // on the map. (16-seed A/B in _ab/: survival median 199.8 -> 210.1 s, mean 185 -> 216 s,
      // sub-100 s wipeouts 4 -> 1, kills 33.0 -> 34.4.)
      // 远处的强者不是威胁，只是「别往那边走」。9000（全图）原本是给 BOSS 用的，
      // 现在 BOSS 由终局规则单独接管；普通敌人按身位算：2200 内才算「要躲的」。
      if (d > (opt.domRange || 2200)) continue;
      if (!best || d < best.d) best = { h: f, d: d, atk: theirAtk, blades: E.heroCnt(f) };
    }
    return best;
  }

  // Where to run. Sample directions and take the one that keeps the most room from every
  // threat, without parking us against the map border (the border is what turns a push
  // into a freeze).
  // A prop lying on the way out is free loot: killing an enemy drops weapons, blades and
  // spin, and walking past a drop while fleeing throws the kill away.
  function propOnTheWay(world, me, wx, wy, opt) {
    var lineX = wx - me.x, lineY = wy - me.y;
    var len = Math.sqrt(lineX * lineX + lineY * lineY);
    if (len < 1) return null;
    var ux = lineX / len, uy = lineY / len;
    var maxOff = opt.lootOff || 210, maxAhead = opt.lootAhead || 900;
    var best = null;
    for (var i = 0; i < world.props.length; i++) {
      var p = world.props[i];
      if (p.taken) continue;
      if (!inReach(world, p.x, p.y, opt)) continue;   // past the wall: not worth a dead end
      var px = p.x - me.x, py = p.y - me.y;
      var ahead = px * ux + py * uy;
      if (ahead <= 0 || ahead > maxAhead) continue;
      var off = Math.abs(px * uy - py * ux);
      if (off > maxOff) continue;
      var v = propValue(p, me, world);
      if (v <= 0) continue;
      var s = v / (ahead + 90);
      if (!best || s > best.s) best = { x: p.x, y: p.y, s: s, d: ahead, kind: p.type, param: p.param };
    }
    return best;
  }
  function fleeWaypoint(world, threats, me, opt) {
    var reach = opt.fleeReach || 1200;
    var bd = opt.fleeBorder || 520;
    var best = null;
    for (var k = 0; k < 24; k++) {
      var a = k * (Math.PI * 2 / 24);
      var cx = me.x + Math.cos(a) * reach, cy = me.y + Math.sin(a) * reach;
      var m = world.map;
      if (!m) continue;
      var e = Math.min(cx - m.xMin, m.xMax - cx, cy - m.yMin, m.yMax - cy);
      if (e < 0) continue;                        // outside the map: not a direction
      var near = 1e9;
      for (var i = 0; i < threats.length; i++) {
        var t = threats[i];
        var d = Math.sqrt((t.x - cx) * (t.x - cx) + (t.y - cy) * (t.y - cy));
        if (d < near) near = d;
      }
      var score = near + Math.min(e, bd) * (opt.fleeBorderW || 0.5);
      if (!best || score > best.score) best = { x: cx, y: cy, score: score, d: reach };
    }
    return best;
  }

  // ---------------------------------------------------------------- end boss（终局规则）
  // 第 3 关的关底 BOSS = 10303：数据里 `is_boss:1`，全关唯一的「攻击 3」刀环、150 把刀、
  // 移速 300、agent 3 只追主角（见 `07-BOSS账与沙盘对齐-20261013.md`）。识别以数据表打头、
  // 攻击力兜底——这一关别处没有 atk 3。
  //
  // 远山 2026-10-14 定的终局：BOSS 一出场就**不再满地图逃**，改成两段——
  //   ① 清场：优先追杀除 BOSS 外的敌人（闸门放开：全图、旁边有别人也照打）；
  //   ② 决战：场上只剩 BOSS 时，径直贴上去对拼。
  // 一句实话写进代码：这个 BOSS 是设计上打不过的（我们 atk 1 / 它 atk 3；刀数拉满 400 把也只能
  // 磨掉它约三分之一，见 07 文档第三节）。所以「决战」的结果基本是主角阵亡——这是远山要的节目
  // 效果，不是策略出错。地址后面加 `?boss=0` 关掉这条规则，回到老的「一直逃」。
  function isBoss(f, opt) {
    if (!f || f.dead) return false;
    var id = opt && opt.bossId !== undefined ? opt.bossId : 10303;
    if (Number(f.id) === Number(id)) return true;
    var t = D && D.HERO && D.HERO[f.id];
    if (t && t.is_boss) return true;
    return E.bladeAtk(f) >= (opt && opt.bossAtk !== undefined ? opt.bossAtk : 3);
  }
  function bossFoe(world, opt) {
    for (var i = 0; i < world.foes.length; i++) if (isBoss(world.foes[i], opt)) return world.foes[i];
    return null;
  }
  // 除 BOSS 外还活着的敌人：这就是「清场」要打完的名单。
  function otherFoes(world, opt) {
    var out = [];
    for (var i = 0; i < world.foes.length; i++) {
      var f = world.foes[i];
      if (f.dead || isBoss(f, opt)) continue;
      out.push(f);
    }
    return out;
  }
  function nearestOf(me, list) {
    var best = null, bd = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var d = Math.sqrt((f.x - me.x) * (f.x - me.x) + (f.y - me.y) * (f.y - me.y));
      if (!best || d < bd) { best = { x: f.x, y: f.y, d: d, id: f.id, blades: E.heroCnt(f) }; bd = d; }
    }
    return best;
  }

  function decide(world, opt) {
    opt = opt || {};
    rewind(world);
    var t0 = nowMs();
    var me = world.me;
    var tgt = null, mode = 'farm';
    // Stuck first: if the world did not move us while we asked it to, nothing else in the
    // plan matters until we are off the wall. Measured cause: an off-map prop used to pin
    // the hero in a corner for 85 s (seed 7, t=215..300).
    if (stallFrames(world, opt) >= (opt.stallFrames || 30)) {
      var esc = interiorPoint(world, opt);
      if (esc) { tgt = esc; mode = 'unstick'; }
    }
    // Danger first: if something we cannot trade with is anywhere near, distance beats
    // loot. Everything else (farming, hunting the weak ones) is what we do in the gaps.
    // Hysteresis: start running at `standoff`, only settle down again past
    // `standoffOut`. Without it the mode flips every tick as a threat drifts across one
    // distance and the two targets point opposite ways -- measured on seed 7 t=200..250,
    // the hero dithered inside a 40 px box for 50 s with a 10202 sitting at exactly 1700.
    var dom = dominantThreat(world, opt);
    // Same reasoning as domRange above: with a 1700 px standoff a BOSS that spawns on the
    // far side of the map is not a reason to run yet, and by the time it is, its 300 px/s
    // has already eaten the gap. Start running the moment one exists.
    // 逃跑距离：普通敌人 1400 像素内才值当跑（接触距离 389~529，留两倍余量）；
    // 6000 的全图撤退原本是防 BOSS 的，但 BOSS 在场时下面 bossPhase 分支会先接管，
    // 用不着普通逃跑逻辑跟着满地图跑——那是「只看逃跑不看架」的最大来源。
    // `?boss=0` 关掉终局规则时退回 6000（那时 BOSS 确实得全图躲）。
    var standoff = opt.standoff || (opt.bossRule === false ? 6000 : 1400);
    var standoffOut = opt.standoffOut || standoff * 1.45;
    var panic = panicking(world, dom, standoff, standoffOut, opt);
    // 终局：BOSS 在场时接管。'clear' = 还有别的敌人要打，'duel' = 只剩 BOSS，去决战。
    // `?boss=0` / `opt.bossRule === false` 关掉，走下面原来那套（危险就跑）。
    var bossF = opt.bossRule === false ? null : bossFoe(world, opt);
    var bossPhase = bossF ? (otherFoes(world, opt).length ? 'clear' : 'duel') : null;
    // 清场阶段还有个「时限」，理由是真机实测出来的（2026-10-14，见 10 号文档第四节）：
    // 剩下的敌人跟我们同速，它一路跑我们永远追不上——真机上主角追着 10302 跑了 60 多秒，
    // 距离一直卡在 1000 像素、一个都没打死，画面上就是「还在满地图跑」。
    // 所以清场给两条线：① 大龙出场后最长 bossClearMax 秒；② 连续 bossIdleMax 秒没有任何人死
    // （`dieHeroCnt` 不动＝我们追的这一只没吃到），谁先到就转决战。
    var bossTag = bossPhase;
    if (mode === 'unstick') {
      // escape only -- no loot detour while we are pinned
    } else if (bossPhase === 'clear') {
      // 先打完别的敌人。闸门放开：旁边有别人也照打、空壳也收、不要求换刀数学占优。
      // 这一段的猎物里**不含 BOSS**（skipBoss），否则它会一直被当成最近的目标。
      //
      // 但有一条硬约束：**不许背对着大龙跑**。大龙 300 移速、我们 255，直线跑必被追上；
      // 沙盘里第一版就是栽在这——去追 1600~4800 像素外的敌人，大龙挂着我们，15 秒把刀圈
      // 从 103 磨到 0（seed 7，rt 180 -> 204.8）。所以「清场」只在**够得着的半径**里成立：
      // 半径 = min(clearLeash, 到大龙的距离 + clearSlack)，大龙越近、能追的范围越小；
      // 半径里没有别的敌人就直接进决战。这样「打得到的别人先打、打不到就打大龙」。
      var bossD = Math.sqrt((bossF.x - me.x) * (bossF.x - me.x) + (bossF.y - me.y) * (bossF.y - me.y));
      // 清场半径：远山 2026-10-21 要「旁边有别的敌人先杀别的」。原来 1800 / +600，
      // 实战里大龙贴上来后只剩 1100 的圈子，圈外还有活人就直接去打大龙了。
      // 放宽到 2400 / +1200，够得着的人都先清掉。
      var maxChase = Math.min(opt.clearLeash !== undefined ? opt.clearLeash : 2400,
        bossD + (opt.clearSlack !== undefined ? opt.clearSlack : 1200));
      if (!_state.bossIn) {
        _state.bossIn = true; _state.bossAt = world.t;
        _state.bossKillAt = world.t; _state.bossDie = world.dieHeroCnt || 0;
      }
      if ((world.dieHeroCnt || 0) > _state.bossDie) {
        _state.bossDie = world.dieHeroCnt; _state.bossKillAt = world.t;
      }
      // 远山 2026-10-21：大龙出来后「旁边有别的敌人要先杀别的，杀完再打大龙」。
      // 所以清场时限放宽（原来 8 秒没死人 / 18 秒就转决战，常常人还没清完就去拼大龙了）。
      var overTime = world.t - _state.bossAt >= (opt.bossClearMax !== undefined ? opt.bossClearMax : 60);
      var overIdle = world.t - _state.bossKillAt >= (opt.bossIdleMax !== undefined ? opt.bossIdleMax : 25);
      if (overTime || overIdle) {
        tgt = { x: bossF.x, y: bossF.y, d: 0, id: bossF.id, blades: E.heroCnt(bossF) };
        mode = 'boss->duel';
        bossTag = overTime ? 'clear-timeout' : 'clear-idle';
      } else {
        var bopt = {};
        for (var bk in opt) if (opt.hasOwnProperty(bk)) bopt[bk] = opt[bk];
        bopt.huntRange = maxChase;
        bopt.aloneRange = 0;
        bopt.finishRange = maxChase;
        bopt.skipBoss = true;
        tgt = pickTarget(world, bopt);
        mode = tgt ? 'boss->clear' : 'farm';
        if (!tgt) {
          // 换刀数学不占优（剩下的敌人比我们强）时，远山要的是「追着打」——但只追
          // **刀不比我们多** 且在半径内的那些，半径外/比我们强的直接打大龙。
          var pick = [], oth = otherFoes(world, opt), myCnt = E.heroCnt(me);
          for (var oi = 0; oi < oth.length; oi++) {
            var of = oth[oi];
            if (E.heroCnt(of) > myCnt) continue;
            var od = Math.sqrt((of.x - me.x) * (of.x - me.x) + (of.y - me.y) * (of.y - me.y));
            if (od <= maxChase) pick.push(of);
          }
          tgt = nearestOf(me, pick);
          if (tgt) mode = 'boss->clear';
        }
        if (!tgt) {
          // 半径里没有别的敌人（清光了，或者都太远/太强）：直接进决战。
          tgt = { x: bossF.x, y: bossF.y, d: 0, id: bossF.id, blades: E.heroCnt(bossF) };
          mode = 'boss->duel';
        }
      }
    } else if (bossPhase === 'duel') {
      // 场上只剩我们和大龙：不逃了，直接贴上去。
      tgt = { x: bossF.x, y: bossF.y, d: 0, id: bossF.id, blades: E.heroCnt(bossF) };
      mode = 'boss->duel';
    } else if (dom && (dom.d < standoff || (panic && dom.d < standoffOut))) {
      // gather every threat, not just the nearest -- one is enough to be cornered by
      var all = [], i, f;
      for (i = 0; i < world.foes.length; i++) {
        f = world.foes[i];
        if (f.dead) continue;
        if (E.heroCnt(f) > E.heroCnt(me) * (opt.domBladeRatio || 1.25) ||
            (E.heroBladeHp(f) / E.bladeAtk(me)) > (E.heroBladeHp(me) / E.bladeAtk(f)) * (opt.domExchange || 1.3))
          all.push(f);
      }
      tgt = fleeWaypoint(world, all, me, opt);
      mode = tgt ? 'flee' : 'farm';
      // ...but do not walk past a drop on the way out.
      var loot = tgt ? propOnTheWay(world, me, tgt.x, tgt.y, opt) : null;
      if (loot) { tgt = loot; mode = 'flee+loot'; }
      // ...and a defanged foe on the way out is a free kill (see freeKill). Two guards,
      // both measured: the thing we are running from has to be far enough to spare the
      // beat, and the corpse has to lie *on the escape line* rather than merely somewhere
      // in front of us. Seed 55 died at 196 s (16 s after the BOSS spawns) on the first
      // version, which let a corpse 90 degrees off the escape line pull the hero sideways;
      // a corridor test is what the loot detour above already uses.
      if (!loot && tgt && opt.finish !== false && (!dom || dom.d > (opt.fleeKillSafe !== undefined ? opt.fleeKillSafe : 1600))) {
        var fkRange = opt.fleeKillRange !== undefined ? opt.fleeKillRange : 800;
        var fkOff = opt.fleeKillOff !== undefined ? opt.fleeKillOff : 300;
        var fkCap = opt.finishBlades !== undefined ? opt.finishBlades : 6;
        var fkSafe = opt.finishSafe !== undefined ? opt.finishSafe : 700;
        var lx = tgt.x - me.x, ly = tgt.y - me.y;
        var ll = Math.sqrt(lx * lx + ly * ly);
        var fk2 = null, fi, fd, fa, fo;
        for (fi = 0; fi < world.foes.length; fi++) {
          var ff = world.foes[fi];
          if (ff.dead) continue;
          if (!freeKill(world, ff, fkCap, fkSafe)) continue;
          var px = ff.x - me.x, py = ff.y - me.y;
          fd = Math.sqrt(px * px + py * py);
          if (ll < 1) continue;
          var ux = lx / ll, uy = ly / ll;
          fa = px * ux + py * uy;                       // how far ahead, along the escape line
          fo = Math.abs(px * uy - py * ux);             // how far off it
          if (fa <= 0 || fa > fkRange || fo > fkOff) continue;
          if (!fk2 || fd < fk2.d) fk2 = { x: ff.x, y: ff.y, d: fd, id: ff.id, blades: E.heroCnt(ff) };
        }
        if (fk2) { tgt = fk2; mode = 'flee+kill'; }
      }
    }
    if (!tgt) {
      // 打完架冲上去捡：死一个人（不管谁杀的）后 3 秒内，900 像素内有掉落就先去捡。
      // 远山 2026-10-21：「打完敌人会掉落东西，要冲上去捡」——这一条只输给逃命和 BOSS 段。
      var dieNow = world.dieHeroCnt || 0;
      if (dieNow > (_state.lastDie || 0)) { _state.lastDie = dieNow; _state.lastDieT = world.t; }
      var sinceDie = world.t - _state.lastDieT;
      // 逃跑中不拐弯捡东西（那会把命捡没）；威胁已经拉开的除外。
      if (sinceDie < (opt.lootAfterKillS !== undefined ? opt.lootAfterKillS : 1.5) &&
          !(dom && dom.d < (opt.lootDangerD || 900))) {
        var lootW = pickWaypoint(world, { waypointRange: opt.lootRadius || 650 });
        if (lootW) { tgt = lootW; mode = 'loot'; }
      }
    }
    if (!tgt) {
      tgt = pickTarget(world, opt);
      mode = tgt ? 'hunt' : 'farm';
      if (!tgt) { tgt = pickWaypoint(world, opt); mode = tgt ? 'farm->prop' : 'farm'; }
      else if (opt.huntLoot === true) {
        // 边打边捡：追击路线上正好躺着刀，顺手收。只认正前方 600 px。
        // 实测（沙盘 6 seeds）默认关：带上它击杀 33.2 -> 30.3、还出现 71 秒早死；
        // 开 `?loot=1` 可以试。等实机画面再决定要不要开。
        var lopt = { lootAhead: 600, lootOff: 180 };
        var lp = propOnTheWay(world, me, tgt.x, tgt.y, lopt);
        if (lp) { tgt = lp; mode = 'hunt+loot'; }
      }
    }
    // Commit to it for a moment (see _state). A fresh urgency always wins; anything else
    // has to wait out the hold, so we stop ping-ponging between two good ideas.
    if (tgt) {
      var holdS = opt.commitS !== undefined ? opt.commitS : 1.0;
      var dropS = opt.commitDrop || 600;
      var ddx = _state.tgt ? tgt.x - _state.tgt.x : 0, ddy = _state.tgt ? tgt.y - _state.tgt.y : 0;
      var sameIdea = _state.tgt && (ddx * ddx + ddy * ddy) < dropS * dropS;
      // 「换策略」那一拍必须立刻生效（远山要的是「立马」）：进入 BOSS 阶段的第一拍
      // 不走「保持上一拍目标」的惯性，免得头 1 秒还在朝着原来的逃跑方向走。
      var wasBossMode = !!_state.mode && _state.mode.indexOf('boss->') === 0;
      var urgent = bossPhase ? !wasBossMode
        : ((mode === 'unstick') || (dom && dom.d < (opt.urgentD || 900)));
      if (_state.tgt && mode !== 'unstick' && world.t < _state.until && !urgent && !sameIdea) {
        tgt = _state.tgt; mode = _state.mode;
      } else {
        _state.tgt = tgt; _state.mode = mode; _state.until = world.t + holdS;
      }
    }
    var huntW = opt.huntWeight !== undefined ? opt.huntWeight : 18;
    if (mode === 'flee') {
      // the closer it is, the louder the run-away target talks
      // `dom` can be null here: the commit hold below keeps the previous `flee` mode for up
      // to commitS while the threat that caused it has already stopped qualifying. Reading
      // dom.d there threw, and the throw skipped act() for that tick -- the hero kept the
      // old direction with a stale plan (measured: ~1 aborted tick per second, every run).
      var urgent = dom ? 1 - Math.min(1, dom.d / standoff) : 0.5;
      huntW = 8 + 60 * urgent;
    }
    if (mode === 'flee+loot') huntW = 20;
    if (mode === 'flee+kill') huntW = 20;   // same licence as the loot detour
    if (mode === 'hunt+loot') huntW = opt.huntLootW !== undefined ? opt.huntLootW : 14;
    if (mode === 'loot') huntW = opt.lootWeight !== undefined ? opt.lootWeight : 24;
    // 清场/决战：目标就是「过去打」，给足权重，别再为路边的掉落磨蹭
    // （HP 是硬约束，见引擎 plan 的 r.hard，所以加这个不会让主角去送死）。
    if (mode === 'boss->clear' || mode === 'boss->clear+loot') huntW = opt.bossClearW || 22;
    if (mode === 'boss->duel' || mode === 'boss->duel+loot') huntW = opt.bossDuelW || 28;
    // Border safety scales with the danger around us. With nothing strong nearby the
    // border is harmless and the props sitting near it are still worth taking; with a
    // bigger ring closing in, being pinned against a wall is how runs end.
    var wts = {};
    if (opt.weights) for (var wk in opt.weights) if (opt.weights.hasOwnProperty(wk)) wts[wk] = opt.weights[wk];
    if (wts.hunt === undefined) wts.hunt = huntW;
    if (wts.edge === undefined) wts.edge = dom ? 42 : 8;
    // 决战要「真打」：把「掉刀血」「拼一刀的节奏」这两项的记分关掉。
    // 引擎原来的账本里丢 1 点刀血 = -1000 分、拼一次 = -400 分，而靠近大龙每 1 像素才 +28 分，
    // 于是主角永远是「绕着大龙转圈、蹭两下就退」——真机实测 dBoss 卡在 400~700 转了 40 多秒
    // （2026-10-14 r2 局）。远山要的是贴上去打，所以这里改成只认「靠近目标」和「削对方刀血」。
    // HP 仍然是引擎里的硬约束（r.hard），不会为了打大龙去送人头。
    if (mode === 'boss->duel' || mode === 'boss->duel+loot') {
      if (wts.bladeHp === undefined) wts.bladeHp = opt.bossDuelBladeHp !== undefined ? opt.bossDuelBladeHp : 0;
      if (wts.clash === undefined) wts.clash = opt.bossDuelClash !== undefined ? opt.bossDuelClash : 0;
    }
    var edgePad = opt.edgePad !== undefined ? opt.edgePad : (dom ? 760 : 420);
    var res = E.plan(world, {
      ndir: opt.ndir || 24,
      speeds: opt.speeds || [1],
      horizon: opt.horizon || 1.4,
      focus: opt.focus || 1250,
      propFocus: opt.propFocus || 620,
      target: tgt,
      minTravel: opt.minTravel,
      weights: wts,
      edgePad: edgePad
    });
    return { best: res.best, target: tgt, ms: nowMs() - t0, mode: mode,
      boss: bossTag, nOther: bossPhase ? otherFoes(world, opt).length : null,
      threat: dom ? { id: dom.h.id, d: Math.round(dom.d), blades: E.heroCnt(dom.h), atk: dom.atk } : null };
  }

  // ---------------------------------------------------------------- driver
  function start(opt) {
    opt = opt || {};
    var sense = opt.sense || liveSense;
    var act = opt.act || liveAct;
    var period = opt.period || 60;
    if (typeof window !== 'undefined' && window.__zd12 && window.__zd12.stop) { try { window.__zd12.stop(); } catch (e) { } }
    var S = {
      ticks: 0, ok: 0, miss: 0, err: null, lastMs: 0, maxMs: 0, sumMs: 0,
      mode: 'farm', target: null, blades: 0, hp: 0, runTime: 0, die: 0, nFoe: 0,
      cmd: [0, 0], t0: nowMs(), trace: [], stopped: false, dead: false, deadAt: null, threat: null,
      boss: null,
      hpMin: 99, bladeHist: []
    };
    function note(x) { S.trace.push(x); if (S.trace.length > 400) S.trace.shift(); }
    function tick() {
      if (S.stopped) return;
      var s;
      try { s = sense(); } catch (e) { S.err = 'sense:' + (e && e.message); return; }
      if (!s || !s.ok) {
        S.miss++;
        if (s && s.dead) { S.dead = true; if (!S.deadAt) S.deadAt = S.runTime; }
        return;
      }
      S.miss = 0;
      S.ok++;
      try {
        var d = decide(s.world, opt);
        var b = d.best;
        if (!b) { S.err = 'no-plan'; return; }
        var ux = b.ux * b.speed, uy = b.uy * b.speed;
        act(ux, uy);
        S.cmd = [Math.round(ux * 100) / 100, Math.round(uy * 100) / 100];
        S.mode = d.mode; S.target = d.target;
        S.threat = d.threat;
        S.boss = d.boss; S.nOther = d.nOther;
        S.lastMs = Math.round(d.ms); S.sumMs += d.ms; if (d.ms > S.maxMs) S.maxMs = d.ms;
        S.ticks++;
        var m = s.meta;
        S.runTime = m.runTime; S.die = m.die; S.nFoe = m.nFoe;
        S.blades = E.heroCnt(s.world.me); S.hp = s.world.me.hp;
        if (S.hp < S.hpMin) S.hpMin = S.hp;
        if (!S.bladeHist.length || m.runTime - S.bladeHist[S.bladeHist.length - 1][0] >= 1) {
          S.bladeHist.push([Math.round(m.runTime * 10) / 10, S.blades, S.hp,
            Math.round(s.world.me.x), Math.round(s.world.me.y), S.cmd[0], S.cmd[1],
            d.mode, b.hpLost, b.travel]);
        }
        if (opt.say) note([Math.round(m.runTime * 100) / 100, S.blades, b.hpLost, d.mode, S.lastMs]);
      } catch (e) { S.err = 'tick:' + (e && e.message ? e.message : String(e)); }
    }
    S.timer = setInterval(tick, period);
    S.stop = function () { S.stopped = true; if (S.timer) clearInterval(S.timer); S.timer = null; liveStop(); };
    S.stat = function () {
      return {
        ticks: S.ticks, ok: S.ok, miss: S.miss, err: S.err, dead: S.dead, deadAt: S.deadAt,
        mode: S.mode, target: S.target, blades: S.blades, hp: S.hp, hpMin: S.hpMin,
        runTime: Math.round(S.runTime * 100) / 100, die: S.die, nFoe: S.nFoe, cmd: S.cmd,
        threat: S.threat,
        boss: S.boss, nOther: S.nOther,
        dt: Math.round((nowMs() - S.t0) / 1000), planMsAvg: S.ticks ? Math.round(S.sumMs / S.ticks) : 0,
        planMsMax: Math.round(S.maxMs), hist: S.bladeHist
      };
    };
    S.tick = tick;
    if (typeof window !== 'undefined') window.__zd12 = S;
    tick();
    return S;
  }

  return {
    VERSION: 'v12-loop',
    start: start, decide: decide, pickTarget: pickTarget, pickWaypoint: pickWaypoint, propValue: propValue,
    nearestThreat: nearestThreat,
    isBoss: isBoss, bossFoe: bossFoe, otherFoes: otherFoes,
    liveSense: liveSense, liveAct: liveAct, heroState: heroState,
    monState: monState, propState: propState
  };
});
