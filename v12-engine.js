// v12-engine.js -- faithful offline model of "拼刀2" level 3 + a rolling-horizon
//                "perfect play" search on top of it.
//
// Every rule below cites the decompiled source it was copied from:
//   RoleMgr.update          frame cadence: i%2 heroes, i%3 monsters, i%5 props; main hero every frame
//   ZDUtils.circleCross     clash test: |r1-r2| < d < r1+r2  (strict overlap)
//   RoleHero.contactHero    mutual blade hp trade in the wedge; rect-circle fallback
//   WeaponModule.findWeaponByVector  wedge = both sub-angles smaller; pick middle index
//   WeaponBase.subHp        blade dies at hp<=0 (hp per weapon config)
//   WeaponModule.updateWeaponCnt / updateWeaponId / updateWeaponAtk  ring maths
//   RoleProp.contactProp    +1/+2/+3 blades, retype, +rot, +atk
//   RoleHero.hurt           HP is life; hp<=0 -> remove
//   RoleMonster._updateMove / Spawner._spawnMonster1  straight line, fixed dir
//   ZDGameControl.update    win when dieHeroCnt >= totalHeroCnt, lose when main hero dies
//
// Usage: node v12-test.js   (offline harness)
//        injected into the page by v12-loop.js

(function (root, factory) {
  var data = null;
  if (typeof module !== 'undefined' && module.exports) data = require('./v12-data.js');
  else if (root && root.ZD12DATA) data = root.ZD12DATA;
  var api = factory(data);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ZD12 = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function (D) {
  'use strict';

  var FRAME_TIME = 1 / 60;          // ZDConst.FRAME_TIME
  var BACK_TM = 0.03;               // HERO_CFG.BACK_TM
  var BACK_SPEED = 500;             // HERO_CFG.BACK_SPEED
  var BACK_TRIGGER_MIN_DIS = 50;    // HERO_CFG.BACK_TRIGGER_MIN_DIS
  var MON_BACK_TM = 0.02;           // MONSTER_CFG.BACK_TM
  var MON_BACK_SPEED = 400;         // MONSTER_CFG.BACK_SPEED
  var MON_CONTACT_DIS = 20;         // MONSTER_CFG.CONTACT_WEAPON_DIS
  var TAU = Math.PI * 2;
  var D2R = Math.PI / 180;

  // ---------------------------------------------------------------- vector math
  // ZDUtils.vectorBetween(a,b,v): both sub-angles must be smaller than angle(a,b).
  // cc.Vec2.angle(a,b) is the unsigned angle in [0,PI].
  function ccAngle(ax, ay, bx, by) {
    var la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
    if (la === 0 || lb === 0) return 0;
    var c = (ax * bx + ay * by) / (la * lb);
    if (c > 1) c = 1; else if (c < -1) c = -1;
    return Math.acos(c);
  }
  function vectorBetween(tx, ty, ex, ey, nx, ny) {
    var a = ccAngle(tx, ty, ex, ey);
    var i = ccAngle(tx, ty, nx, ny);
    var o = ccAngle(ex, ey, nx, ny);
    return i < a && o < a;
  }
  // ZDUtils.isIntersectRectCircle(rectCenter, rectSize, circleCenter, radius)
  function rectCircle(rx, ry, rw, rh, cx, cy, radius) {
    var l = rx - rw / 2, r = rx + rw / 2, b = ry - rh / 2, t = ry + rh / 2;
    var x = cx, y = cy;
    if (x < l) x = l; else if (x > r) x = r;
    if (y < b) y = b; else if (y > t) y = t;
    var dx = cx - x, dy = cy - y;
    return Math.sqrt(dx * dx + dy * dy) <= radius;
  }
  // ZDUtils.isRectIntersect(centerA,sizeA,centerB,sizeB)
  function rectRect(ax, ay, aw, ah, bx, by, bw, bh) {
    return !(ax - aw / 2 > bx + bw / 2 || ax + aw / 2 < bx - bw / 2 ||
             ay - ah / 2 > by + bh / 2 || ay + ah / 2 < by - bh / 2);
  }
  // ZDUtils.circleCross2 -- 0 no touch, 1 degenerate, 2 real cross (the game opens the
  // wedge maths only on 2).
  function circleCross2(c1x, c1y, r1, c2x, c2y, r2) {
    var dx = c2x - c1x, dy = c2y - c1y;
    var p = Math.sqrt(dx * dx + dy * dy);
    if (p <= Math.abs(r1 - r2)) {
      if (r1 > r2) r1 = p;
      else { if (!(r1 < r2)) return 1; r2 = p; }
    }
    if (p > r1 + r2) return 0;
    return 2;
  }
  // ZDUtils.circleCross -- returns the four unit directions + foot point, or null.
  var _cc = { a1x: 0, a1y: 0, a2x: 0, a2y: 0, b1x: 0, b1y: 0, b2x: 0, b2y: 0, mx: 0, my: 0 };
  function circleCross(c1x, c1y, r1, c2x, c2y, r2) {
    var dx = c2x - c1x, dy = c2y - c1y;
    var p = Math.sqrt(dx * dx + dy * dy);
    if (p <= Math.abs(r1 - r2)) return null;
    if (p >= r1 + r2) return null;
    var g = (r1 * r1 - r2 * r2 + p * p) / (2 * p);
    var d = Math.sqrt(r1 * r1 - g * g);
    var lx = c1x + g * dx / p, ly = c1y + g * dy / p;
    var yx = lx + d * dy / p, yy = ly - d * dx / p;
    var xx = lx - d * dy / p, xy = ly + d * dx / p;
    _cc.a1x = (yx - c1x) / r1; _cc.a1y = (yy - c1y) / r1;
    _cc.a2x = (xx - c1x) / r1; _cc.a2y = (xy - c1y) / r1;
    _cc.b1x = (yx - c2x) / r2; _cc.b1y = (yy - c2y) / r2;
    _cc.b2x = (xx - c2x) / r2; _cc.b2y = (xy - c2y) / r2;
    _cc.mx = lx; _cc.my = ly;
    return _cc;
  }

  // ---------------------------------------------------------------- entity model
  // A hero's blade ring. WeaponModule.updateWeaponCnt() lays the blades out at
  // 360*i/n and records that slot angle on each blade (`setRadian`). A blade that
  // dies is spliced out of the array WITHOUT re-spreading the survivors, so from
  // then on every blade keeps its own angle -- we store it per blade (`ang`, deg)
  // exactly like the live object's `_radian`. Only a count change re-spreads.
  function mkBlades(list) {
    var out = [], n = list ? list.length : 0, i;
    for (i = 0; i < n; i++) {
      var v = list[i];
      if (typeof v === 'number') out.push({ hp: v, ang: 360 * i / n });
      else out.push({ hp: v.hp, ang: v.ang !== undefined && v.ang !== null ? v.ang : 360 * i / n });
    }
    return out;
  }
  function spread(h) {                       // WeaponModule.updateWeaponCnt
    var n = h.blades.length, i;
    for (i = 0; i < n; i++) h.blades[i].ang = 360 * i / n;
  }
  function bladeAng(h, i) { var b = h.blades[i]; return b.ang === null || b.ang === undefined ? 360 * i / h.blades.length : b.ang; }
  function heroRadius(h) { return h.wradius + h.wcfg.width; }
  // RoleBase.radius: heroes use weapon_radius+blade width, monsters use max(size)/2.
  function radiusOf(e) {
    if (e.wcfg) return heroRadius(e);
    return e.size ? Math.max(e.size.w, e.size.h) / 2 : 0;
  }
  function heroSpeedOf(h) { return h.speed; }
  function mkHero(src) {
    var h = {
      x: src.x, y: src.y, hp: src.hp, maxHp: src.maxHp || 10,
      wradius: src.wradius, wcfg: src.wcfg,
      rot: src.rot, wangle: src.wangle,
      atkBonus: src.atkBonus || 0,
      blades: mkBlades(src.blades),
      dirx: src.dirx || 0, diry: src.diry || 0,
      speed: src.speed, size: src.size ? { w: src.size.w, h: src.size.h } : null,
      agent: src.agent | 0, id: src.id | 0, dead: false,
      drop: src.drop || null,
      backT: 0, bdx: 0, bdy: 0,
      hpLost: 0, clash: 0, hurtEvents: 0
    };
    return h;
  }
  function heroDef(h) { return D.HERO[h.id] || null; }
  function bladeAtk(h) { return h.wcfg.atk + h.atkBonus; }
  function heroCnt(h) { var n = 0; for (var i = 0; i < h.blades.length; i++) if (h.blades[i].hp > 0) n++; return n; }
  function heroBladeHp(h) { var n = 0; for (var i = 0; i < h.blades.length; i++) if (h.blades[i].hp > 0) n += h.blades[i].hp; return n; }
  function heroFightPower(h) { return bladeAtk(h) * heroCnt(h); }

  // pick the blade the game would pick (WeaponModule.findWeaponByVector)
  function pickBlade(h, d1x, d1y, d2x, d2y) {
    var n = h.blades.length;
    if (!n) return -1;
    var count = 0, i;
    for (i = 0; i < n; i++) {
      if (h.blades[i].hp <= 0) continue;               // waitRemove -> enable === false
      var a = (h.wangle + bladeAng(h, i)) * D2R;
      if (vectorBetween(d1x, d1y, d2x, d2y, Math.cos(a), Math.sin(a))) {
        count++;
      }
    }
    if (!count) return -1;
    // re-walk to get p[Math.floor(count/2)] exactly (ring order = index order)
    var k = Math.floor(count / 2);
    for (i = 0; i < n; i++) {
      if (h.blades[i].hp <= 0) continue;
      var a2 = (h.wangle + bladeAng(h, i)) * D2R;
      if (vectorBetween(d1x, d1y, d2x, d2y, Math.cos(a2), Math.sin(a2))) {
        if (k === 0) return i;
        k--;
      }
    }
    return -1;
  }

  function startBack(h, ax, ay, bx, by, tm, spd) {
    var dx = ax - bx, dy = ay - by;
    var l = Math.sqrt(dx * dx + dy * dy);
    if (l === 0) return;
    h.bdx = dx / l; h.bdy = dy / l; h.backT = tm; h.backSpd = spd;
  }
  // RoleHero.moveBackByHero: only when d + 50 < r1 + r2
  function heroMoveBack(h, other) {
    var d = Math.sqrt((h.x - other.x) * (h.x - other.x) + (h.y - other.y) * (h.y - other.y));
    if (d + BACK_TRIGGER_MIN_DIS >= radiusOf(h) + radiusOf(other)) return;
    startBack(h, h.x, h.y, other.x, other.y, BACK_TM, BACK_SPEED);
  }

  function mkMon(src) {
    return {
      x: src.x, y: src.y, dx: src.dx, dy: src.dy, speed: src.speed || 200,
      hp: src.hp === undefined ? 1 : src.hp, atk: src.atk === undefined ? 2 : src.atk,
      id: src.id | 0,
      size: src.size ? { w: src.size.w, h: src.size.h } : null, dead: false,
      backT: 0, bdx: 0, bdy: 0
    };
  }

  // ---------------------------------------------------------------- world
  function World(state) {
    this.map = state.mapRect;
    this.me = mkHero(state.me);
    this.foes = [];
    for (var i = 0; i < state.foes.length; i++) this.foes.push(mkHero(state.foes[i]));
    this.mons = [];
    for (var j = 0; j < (state.mons || []).length; j++) this.mons.push(mkMon(state.mons[j]));
    this.props = [];
    for (var k = 0; k < (state.props || []).length; k++) {
      var p = state.props[k];
      this.props.push({ x: p.x, y: p.y, type: p.type, param: p.param,
        size: p.size ? { w: p.size.w, h: p.size.h } : { w: 136, h: 136 }, taken: false,
        auto: !!p.auto, id: p.id || 0 });
    }
    this.t = state.t || 0;
    this.frame = state.frame || 0;
    this.dieHeroCnt = state.dieHeroCnt || 0;
    this.totalHeroCnt = state.totalHeroCnt || 41;
    this.meDead = false;
    this.travel = 0; this.propsTaken = 0; this.clashEvents = 0; this.foeHpDealt = 0;
    this.meClash = 0;
    this.boundaryTouch = 0;
    // planner bookkeeping (only kept when track is on)
    this.track = false; this.minMargin = 1e9; this.aliveFrames = 0;
    this.weaponUp = 0; this.atkUp = 0;
    this.events = [];
  }

  World.prototype.clone = function () {
    var w = Object.create(World.prototype);
    w.map = this.map;
    w.me = cloneHero(this.me);
    w.foes = new Array(this.foes.length);
    for (var i = 0; i < this.foes.length; i++) w.foes[i] = cloneHero(this.foes[i]);
    w.mons = new Array(this.mons.length);
    for (var j = 0; j < this.mons.length; j++) {
      var m = this.mons[j];
      w.mons[j] = { x: m.x, y: m.y, dx: m.dx, dy: m.dy, speed: m.speed, hp: m.hp, atk: m.atk,
        id: m.id, size: m.size, dead: m.dead, backT: m.backT, bdx: m.bdx, bdy: m.bdy };
    }
    w.props = new Array(this.props.length);
    for (var k = 0; k < this.props.length; k++) {
      var p = this.props[k];
      w.props[k] = { x: p.x, y: p.y, type: p.type, param: p.param, size: p.size, taken: p.taken,
        auto: p.auto, id: p.id };
    }
    w.t = this.t; w.frame = this.frame;
    w.dieHeroCnt = this.dieHeroCnt; w.totalHeroCnt = this.totalHeroCnt;
    w.meDead = this.meDead; w.travel = this.travel; w.propsTaken = this.propsTaken;
    w.clashEvents = this.clashEvents; w.foeHpDealt = this.foeHpDealt;
    w.meClash = this.meClash;
    w.boundaryTouch = this.boundaryTouch;
    w.track = this.track; w.minMargin = this.minMargin; w.aliveFrames = this.aliveFrames;
    w.weaponUp = this.weaponUp; w.atkUp = this.atkUp;
    w.events = [];
    return w;
  };
  function cloneHero(h) {
    return {
      x: h.x, y: h.y, hp: h.hp, maxHp: h.maxHp, wradius: h.wradius, wcfg: h.wcfg,
      rot: h.rot, wangle: h.wangle, atkBonus: h.atkBonus,
      blades: mkBlades(h.blades), dirx: h.dirx, diry: h.diry, speed: h.speed, size: h.size,
      agent: h.agent, id: h.id, dead: h.dead,
      drop: h.drop,
      backT: h.backT, bdx: h.bdx, bdy: h.bdy, backSpd: h.backSpd,
      hpLost: h.hpLost, clash: h.clash, hurtEvents: h.hurtEvents
    };
  }

  // RoleHero.contactProp
  World.prototype.applyProp = function (h, p, isMe) {
    var t = p.type, param = p.param;
    if (t === 1) {
      var n = h.blades.length + param;
      if (n > 400) n = 400;
      for (var i = h.blades.length; i < n; i++) h.blades.push({ hp: h.wcfg.hp, ang: null });
      spread(h);                                       // updateWeaponCnt re-lays every blade
    } else if (t === 2) {
      var wc = D.WEAPON[param];
      if (wc) {
        if (this.track) this.weaponUp += weaponValue(wc) - weaponValue(h.wcfg);
        h.wcfg = wc;
        var n2 = h.blades.length + 2;                    // updateWeaponId -> len+2
        for (var j = 0; j < n2; j++) {
          if (j < h.blades.length) h.blades[j].hp = wc.hp;  // initAttr refill
          else h.blades.push({ hp: wc.hp, ang: null });
        }
        spread(h);
      }
    } else if (t === 3) {
      h.rot += param;
    } else if (t === 4) {
      if (this.track) this.atkUp += param;
      h.atkBonus += param;
    }
  };

  World.prototype.hurt = function (h, amount, isMe) {
    if (h.hp <= 0) return;
    h.hpLost += amount;
    h.hp -= amount;
    if (h.hp < 0) h.hp = 0;
    h.hurtEvents++;
    if (h.hp <= 0) {
      h.dead = true;
      if (!isMe) this.dieHeroCnt++;
      else this.meDead = true;
    }
  };

  // RoleHero.contactHero -- the heart of the game.
  World.prototype.heroVsHero = function (a, b, isAMe, isBMe) {
    if (a.dead || b.dead) return;
    var ra = heroRadius(a), rb = heroRadius(b);
    var cc = circleCross(a.x, a.y, ra, b.x, b.y, rb);
    if (!cc) return;
    var oi = pickBlade(a, cc.a1x, cc.a1y, cc.a2x, cc.a2y);
    var ni = pickBlade(b, cc.b1x, cc.b1y, cc.b2x, cc.b2y);
    if (oi >= 0) {
      if (ni >= 0) {
        this.clashEvents++;
        if (isAMe || isBMe) this.meClash++;
        var oatk = bladeAtk(a), natk = bladeAtk(b);
        a.blades[oi].hp -= natk; b.blades[ni].hp -= oatk;
        if (a.blades[oi].hp < 0) a.blades[oi].hp = 0;
        if (b.blades[ni].hp < 0) b.blades[ni].hp = 0;
        if (a.blades[oi].hp > 0) heroMoveBack(b, a);      // o.hp>0 -> t.moveBackByHero(e)
        if (b.blades[ni].hp > 0) heroMoveBack(a, b);      // n.hp>0 -> e.moveBackByHero(t)
      } else if (rectCircle(b.x, b.y, b.size.w, b.size.h, a.x, a.y, ra)) {
        var before = b.hp;
        this.hurt(b, bladeAtk(a), isBMe);
        if (!isBMe) this.foeHpDealt += (before - b.hp);
        heroMoveBack(b, a);
      }
    } else if (ni >= 0 && rectCircle(a.x, a.y, a.size.w, a.size.h, b.x, b.y, rb)) {
      var before2 = a.hp;
      this.hurt(a, bladeAtk(b), isAMe);
      if (!isAMe) this.foeHpDealt += (before2 - a.hp);
      heroMoveBack(a, b);
    }
  };

  // RoleHero.contactMonster (via RoleMgr._dealHeroCollisionWithMonster)
  World.prototype.heroVsMonster = function (h, m, isMe) {
    if (h.dead || m.dead) return;
    var mr = (m.size ? Math.max(m.size.w, m.size.h) : 136) - MON_CONTACT_DIS;
    var mode = circleCross2(h.x, h.y, heroRadius(h), m.x, m.y, mr);
    if (mode <= 0) return;
    var oi = -1;
    if (mode === 2) {
      var ra = heroRadius(h);
      var cc = circleCross(h.x, h.y, ra, m.x, m.y, mr);
      if (cc) oi = pickBlade(h, cc.a1x, cc.a1y, cc.a2x, cc.a2y);
    }
    if (oi >= 0) {
      m.hp -= bladeAtk(h);
      if (m.hp <= 0) m.dead = true;
      if (!m.dead) startBack(m, m.x, m.y, h.x, h.y, MON_BACK_TM, MON_BACK_SPEED);
    } else if (h.size && m.size &&
               rectRect(h.x, h.y, h.size.w, h.size.h, m.x, m.y, m.size.w, m.size.h)) {
      this.hurt(h, m.atk, isMe);
      heroMoveBack(h, m);
      startBack(m, m.x, m.y, h.x, h.y, MON_BACK_TM, MON_BACK_SPEED);
    }
  };

  // MoveRole._updateMove / _updatePos
  function clampToMapEdge(e, radius, map) {
    var lo = map.xMin + radius, hi = map.xMax - radius;
    if (e.x < lo) e.x = lo; else if (e.x > hi) e.x = hi;
    var lo2 = map.yMin + radius, hi2 = map.yMax - radius;
    if (e.y < lo2) e.y = lo2; else if (e.y > hi2) e.y = hi2;
  }
  function moveEntity(e, dt, radius, clampToMap, map) {
    if (e.backT > 0) {
      var spd = e.backSpd, dx = e.bdx, dy = e.bdy;
      e.x += dt * dx * spd; e.y += dt * dy * spd;
      e.backT -= dt;
      // The pushed-back move is clamped too. This is the whole reason a hero pinned
      // against the border by a contact is stuck: the game re-arms the back state every
      // frame, the joystick is ignored, and the wall gives nowhere to go. Modelling the
      // push as unclamped made the sandbox let the hero escape into the void -- which is
      // exactly the sandbox-is-too-optimistic difference that hid this failure.
      if (clampToMap) clampToMapEdge(e, radius, map);
    } else {
      if (e.dirx === 0 && e.diry === 0) return 0;
      var ox = e.x, oy = e.y;
      e.x += dt * e.dirx * e.speed; e.y += dt * e.diry * e.speed;
      if (clampToMap) clampToMapEdge(e, radius, map);
      return Math.sqrt((e.x - ox) * (e.x - ox) + (e.y - oy) * (e.y - oy));
    }
    return 0;
  }

  World.prototype.step = function (dt) {
    if (this.meDead) return;
    dt = dt || FRAME_TIME;
    this.t += dt;
    this.frame = (this.frame + 1) % 100;
    var f = this.frame, i, j;

    // ---- RoleMgr._roleUpdate: main hero first, then AI heroes, monsters, props ----
    var moved = moveEntity(this.me, dt, heroRadius(this.me), true, this.map);
    this.travel += moved;
    var me = this.me;
    me.wangle = (me.wangle - me.rot * dt) % 360;
    var m = this.map, pad = 130;
    if (me.x - m.xMin < pad || m.xMax - me.x < pad || me.y - m.yMin < pad || m.yMax - me.y < pad)
      this.boundaryTouch += dt;

    for (i = 0; i < this.foes.length; i++) {
      var h = this.foes[i];
      if (h.dead) continue;
      this._steerFoe(h, i);
      moveEntity(h, dt, heroRadius(h), true, this.map);
      h.wangle = (h.wangle - h.rot * dt) % 360;
    }
    for (j = 0; j < this.mons.length; j++) {
      var mo = this.mons[j];
      if (mo.dead) continue;
      if (mo.backT > 0) {                       // MoveRole._updateMove: back move replaces it
        mo.x += dt * mo.bdx * MON_BACK_SPEED;
        mo.y += dt * mo.bdy * MON_BACK_SPEED;
        mo.backT -= dt;
      } else {                                  // straight line, no clamp (RoleMonster._updatePos)
        mo.x += dt * mo.dx * mo.speed;
        mo.y += dt * mo.dy * mo.speed;
      }
      var mw = mo.size ? mo.size.w : 136, mh = mo.size ? mo.size.h : 136;
      if (mo.x < m.xMin - mw || mo.x > m.xMax + mw || mo.y > m.yMax + mh || mo.y < m.yMin - mh)
        mo.dead = true;
    }

    // ---- RoleMgr._dealMainHeroCollision (every frame, no modulo) ----
    for (i = 0; i < this.props.length; i++) {
      var p = this.props[i];
      if (p.taken) continue;
      if (rectRect(me.x, me.y, me.size.w, me.size.h, p.x, p.y, p.size.w, p.size.h)) {
        this.applyProp(me, p, true);
        p.taken = true;
        this.propsTaken++;
      }
    }
    for (j = 0; j < this.mons.length; j++) this.heroVsMonster(me, this.mons[j], true);
    for (i = 0; i < this.foes.length; i++) {
      var t2 = this.foes[i];
      if (t2.dead) continue;
      this.heroVsHero(me, t2, true, false);
    }

    // ---- RoleMgr._dealAIHeroCollision ----
    if (f % 2 === 0) {
      for (i = 0; i < this.foes.length; i++) {
        var a = this.foes[i];
        if (a.dead) continue;
        for (j = i + 1; j < this.foes.length; j++) {
          var b = this.foes[j];
          if (b.dead) continue;
          this.heroVsHero(a, b, false, false);
        }
      }
    }
    for (i = 0; i < this.foes.length; i++) {
      var g = this.foes[i];
      if (g.dead) continue;
      if (f % 3 === 0) for (j = 0; j < this.mons.length; j++) this.heroVsMonster(g, this.mons[j], false);
      if (g.dead) continue;
      if (f % 5 === 0) for (j = 0; j < this.props.length; j++) {
        var pp = this.props[j];
        if (pp.taken) continue;
        if (rectRect(g.x, g.y, g.size.w, g.size.h, pp.x, pp.y, pp.size.w, pp.size.h)) {
          this.applyProp(g, pp, false);
          pp.taken = true;
        }
      }
    }
    // ---- RoleMgr._removeWaitDestroyRole ----
    for (i = 0; i < this.foes.length; i++) if (this.foes[i].hp <= 0) this.foes[i].dead = true;
    if (this.track) {
      this.aliveFrames++;
      if (!this.meDead) {
        for (i = 0; i < this.foes.length; i++) {
          var q = this.foes[i];
          if (q.dead) continue;
          var qdx = q.x - me.x, qdy = q.y - me.y;
          var gap = Math.sqrt(qdx * qdx + qdy * qdy) - heroRadius(q) - heroRadius(me);
          if (gap < this.minMargin) this.minMargin = gap;
        }
      }
    }
    // ---- WeaponModule.update: dead blades are collected on the role's next update,
    //      and the survivors keep their own slot angle (no re-spread).
    trimBlades(this.me);
    for (i = 0; i < this.foes.length; i++) trimBlades(this.foes[i]);
  };
  function trimBlades(h) {
    var b = h.blades, k = 0;
    for (var i = 0; i < b.length; i++) if (b[i].hp > 0) b[k++] = b[i];
    b.length = k;
  }

  // AIAgentImp1/2/3 behaviour (ai1.fmt.js)
  World.prototype._steerFoe = function (h, idx) {
    var me = this.me, tx = 0, ty = 0, pursue = false;
    if (h.agent === 2) {
      for (var i = 0; i < this.foes.length; i++) {
        if (i === idx) continue;
        var t = this.foes[i];
        if (!t.dead) { tx = t.x; ty = t.y; pursue = true; break; }
      }
    } else if (h.agent === 3) {
      tx = me.x; ty = me.y; pursue = true;
    }
    if (pursue) {
      var dx = tx - h.x, dy = ty - h.y, l = Math.sqrt(dx * dx + dy * dy);
      if (l > 0.001) { h.dirx = dx / l; h.diry = dy / l; }
      return;
    }
    // agent 1 (and anyone else): keep the direction it rolled once
    var padx = 120;
    if (h.x - this.map.xMin < padx) h.dirx = Math.abs(h.dirx);
    else if (this.map.xMax - h.x < padx) h.dirx = -Math.abs(h.dirx);
    if (h.y - this.map.yMin < padx) h.diry = Math.abs(h.diry);
    else if (this.map.yMax - h.y < padx) h.diry = -Math.abs(h.diry);
  };

  // ---------------------------------------------------------------- policy
  // Rolling-horizon search. Enumerate (direction x speed), roll the world forward
  // with the observed motions, then score. HP is a hard constraint, not a weight:
  // a candidate that loses HP is only used when every candidate does.
  //
  // The world is first trimmed to the entities that can still reach me inside the
  // horizon ("focus"), which keeps the search at a few milliseconds per tick.
  World.prototype.focus = function (radius, propRadius) {
    var w = this.clone(), me = w.me, i, out;
    function near(e, r) { var dx = e.x - me.x, dy = e.y - me.y; return dx * dx + dy * dy <= r * r; }
    out = [];
    for (i = 0; i < w.foes.length; i++) if (!w.foes[i].dead && near(w.foes[i], radius)) out.push(w.foes[i]);
    w.foes = out;
    out = [];
    for (i = 0; i < w.mons.length; i++) if (!w.mons[i].dead && near(w.mons[i], radius)) out.push(w.mons[i]);
    w.mons = out;
    out = [];
    for (i = 0; i < w.props.length; i++) if (!w.props[i].taken && near(w.props[i], propRadius)) out.push(w.props[i]);
    w.props = out;
    w.track = true;
    return w;
  };

  // Weapon quality: how much punishment one ring can absorb and dish out.
  // What a blade is worth. Blade hp is how many clash hits the ring can absorb and the
  // attack is how fast it strips the other side, so hp*(atk+0.5) is the core. Width
  // (reach) used to be ignored, and that made the rollout indifferent between an 8 (hp4,
  // width 270 -> ring 340) and a 5 (hp4, width 152 -> ring 222) -- both scored 6. The
  // live run picked a 300-wide blade, then later walked onto a 100-wide one and dropped
  // its ring from 340 to 170 against the BOSS. Reach is the whole reason to swap, so it
  // belongs in the value: /150 makes width 270 worth ~1.8, enough to out-rank a same-hp
  // narrower blade but not enough to beat an extra point of blade hp.
  function weaponValue(w) { return w ? w.hp * (w.atk + 0.5) + w.width / 150 : 0; }
  function ringValue(h) { return heroBladeHp(h) * (bladeAtk(h) + 0.5); }

  // Distance from a point to the nearest map border.
  function borderDist(map, x, y) {
    var e = x - map.xMin, b = map.xMax - x, c = y - map.yMin, d = map.yMax - y;
    return Math.min(e, b, c, d);
  }

  function plan(world, opt) {
    opt = opt || {};
    var ndir = opt.ndir || 24;
    var speeds = opt.speeds || [1, 0.62];
    var horizon = opt.horizon || 1.4;
    var steps = Math.max(6, Math.round(horizon / FRAME_TIME));
    var wMe = opt.weights || {};
    var W = {
      // The currency is blade hp: it is exactly how many clash hits this ring can
      // still absorb. Blade count is worth something on top of that because a ring
      // with no gap in the wedge cannot be hit in the body at all.
      bladeHp: wMe.bladeHp !== undefined ? wMe.bladeHp : 1000,
      blade: wMe.blade !== undefined ? wMe.blade : 300,
      prop: wMe.prop !== undefined ? wMe.prop : 0,
      weapon: wMe.weapon !== undefined ? wMe.weapon : 250,   // per point of weapon value
      atk: wMe.atk !== undefined ? wMe.atk : 900,        // +1 atk pays for itself
      deal: wMe.deal !== undefined ? wMe.deal : 60,      // foe body hp removed
      foeBlade: wMe.foeBlade !== undefined ? wMe.foeBlade : 600, // foe blade hp removed
      kill: wMe.kill !== undefined ? wMe.kill : 4000,
      travel: wMe.travel !== undefined ? wMe.travel : 1.0,
      wall: wMe.wall !== undefined ? wMe.wall : 900,
      margin: wMe.margin !== undefined ? wMe.margin : 6,   // per px of clearance kept
      hunt: wMe.hunt !== undefined ? wMe.hunt : 8,         // per px closed on the waypoint
      clash: wMe.clash !== undefined ? wMe.clash : 400,    // a trade costs tempo
      floor: wMe.floor !== undefined ? wMe.floor : 6       // blade hp below this is critical
    };
    // Border safety. The map border itself is harmless, but the game's own "move back"
    // state (RoleHero.moveBackByHero) ignores the joystick for as long as a contact
    // keeps re-arming it. Pinned against a wall that state never releases, so the hero
    // freezes and is ground down. Staying off the border is what keeps that state
    // survivable -- it becomes a trampoline instead of a trap.
    var EDGE_PAD = opt.edgePad !== undefined ? opt.edgePad : 420;
    W.edge = wMe.edge !== undefined ? wMe.edge : 8;
    var src = opt.focus ? world.focus(opt.focus, opt.propFocus || opt.focus * 0.5) : world.clone();
    src.track = true;
    var best = null, results = [];
    var me0 = src.me;
    var baseBlades = heroCnt(me0), baseHp = me0.hp;
    var baseBladeHp = heroBladeHp(me0);
    var baseWv = weaponValue(me0.wcfg), baseAtk = bladeAtk(me0);
    var baseFoeHp = 0, baseFoeBladeHp = 0, i;
    for (i = 0; i < src.foes.length; i++) {
      baseFoeHp += src.foes[i].hp; baseFoeBladeHp += heroBladeHp(src.foes[i]);
    }
    var tgt = opt.target || null;
    var baseTgtDist = tgt ? Math.sqrt((tgt.x - me0.x) * (tgt.x - me0.x) + (tgt.y - me0.y) * (tgt.y - me0.y)) : 0;
    var minTravel = opt.minTravel !== undefined ? opt.minTravel : 0.55 * horizon * me0.speed;
    for (var d = 0; d < ndir; d++) {
      var ang = d * TAU / ndir;
      var ux = Math.cos(ang), uy = Math.sin(ang);
      for (var s = 0; s < speeds.length; s++) {
        var c = src.clone();
        c.track = true;
        c.me.dirx = ux * speeds[s]; c.me.diry = uy * speeds[s];
        var edgeAcc = 0;
        for (var k = 0; k < steps; k++) {
          c.step(FRAME_TIME);
          if (W.edge) {
            var be = borderDist(c.map, c.me.x, c.me.y);
            if (be < EDGE_PAD) edgeAcc += (EDGE_PAD - be) * FRAME_TIME;
          }
          if (c.meDead) break;
        }
        var foeHp = 0, foeBladeHp = 0;
        for (i = 0; i < c.foes.length; i++) { foeHp += c.foes[i].hp; foeBladeHp += heroBladeHp(c.foes[i]); }
        var tgtDist = tgt ? Math.sqrt((tgt.x - c.me.x) * (tgt.x - c.me.x) + (tgt.y - c.me.y) * (tgt.y - c.me.y)) : 0;
        var r = {
          ux: ux, uy: uy, speed: speeds[s],
          hpLost: baseHp - c.me.hp,
          blades: heroCnt(c.me) - baseBlades,
          bladeHp: heroBladeHp(c.me) - baseBladeHp,
          props: c.propsTaken,
          dealt: baseFoeHp - foeHp,
          foeBladeHp: baseFoeBladeHp - foeBladeHp,
          kills: c.dieHeroCnt,
          clash: c.meClash,
          travel: c.travel,
          wall: c.boundaryTouch,
          margin: c.minMargin,
          hunt: baseTgtDist - tgtDist,
          edge: edgeAcc,
          hard: c.me.hp < baseHp || c.meDead,
          dead: c.meDead,
          score: 0
        };
        r.score = W.bladeHp * r.bladeHp
          + W.blade * r.blades
          + W.prop * r.props
          + W.deal * r.dealt
          + W.foeBlade * r.foeBladeHp
          + W.kill * r.kills
          + W.hunt * r.hunt
          + W.travel * r.travel
          - W.wall * r.wall
          - W.clash * r.clash
          - W.edge * r.edge
          + W.margin * Math.min(r.margin, 120);
        // running the ring down towards zero is what actually loses the run
        if (r.bladeHp + baseBladeHp < W.floor) {
          r.score -= 6000 * (W.floor - (r.bladeHp + baseBladeHp));
        }
        // picking up a retype (type2) or attack (type4) prop is a long-term gain the
        // rollout cannot see, so it is priced in the meta counters the world keeps.
        if (c.weaponUp) r.score += W.weapon * c.weaponUp;
        if (c.atkUp) r.score += W.atk * c.atkUp;
        if (r.hard) {
          r.score -= 1e6 + 1e4 * r.hpLost - 60 * c.aliveFrames;   // survive as long as possible
        }
        if (r.travel < minTravel) r.score -= 800;                  // the audience wants motion
        results.push(r);
        if (!best || r.score > best.score) best = r;
      }
    }
    best.results = results.length;
    return { best: best, results: results, baseBlades: baseBlades, baseHp: baseHp };
  }

  // Danger reading (used for logging / the "am I cornered" check).
  function danger(world, safe) {
    safe = safe || 70;
    var best = 1e9, worst = null;
    for (var i = 0; i < world.foes.length; i++) {
      var h = world.foes[i];
      if (h.dead) continue;
      if (heroCnt(h) <= heroCnt(world.me)) continue;      // not stronger -> not a threat
      var d = Math.sqrt((h.x - world.me.x) * (h.x - world.me.x) + (h.y - world.me.y) * (h.y - world.me.y));
      d = d - heroRadius(h) - heroRadius(world.me) + safe;
      if (d < best) { best = d; worst = h; }
    }
    return { margin: best, foe: worst };
  }

  return {
    VERSION: 'v12',
    FRAME_TIME: FRAME_TIME,
    World: World,
    plan: plan,
    danger: danger,
    heroRadius: heroRadius,
    heroCnt: heroCnt,
    heroBladeHp: heroBladeHp,
    bladeAng: bladeAng,
    heroFightPower: heroFightPower,
    bladeAtk: bladeAtk,
    circleCross: circleCross,
    vectorBetween: vectorBetween,
    pickBlade: pickBlade,
    rectRect: rectRect,
    rectCircle: rectCircle,
    D: D
  };
});
