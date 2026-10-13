// autoplay.js -- in-page autoplay for the mini-game "pin dao 2" level 3.
//
// 一个网址打开就自己玩，全程零人工，不依赖页面外的任何工具：
//   1. 等游戏启动；
//   2. 在副玩法列表按名字点「拼刀2」卡片；
//   3. 在关卡列表：没解锁就点「提前解锁」直到计数满，再点「开始」；
//   4. 进关后交给判断层（v12-loop）自己打；
//   5. 结算面板一出现（挑战失败/成功）就按「再次挑战」，立刻接着打这一关——无限循环。
//
// 怎么点的：
//   - 菜单是 FairyGUI：调按钮对象自己的 fireClick()（引擎替你按一下）；
//   - 结算面板是 Cocos 节点：对按钮节点 emit('click')（和引擎自己派发点击同一条路）。
//   游戏本体一个字节都不改。
(function () {
  'use strict';

  var S = {
    v: 'ap3', phase: 'boot', rounds: 0, t0: Date.now(),
    log: [], err: null, lastStat: null, fails: 0, retries: 0
  };
  window.__AP = S;

  function log(m) {
    S.log.push({ t: Math.round((Date.now() - S.t0) / 100) / 10, m: String(m).slice(0, 120) });
    if (S.log.length > 160) S.log.splice(0, 80);
  }

  // ------------------------------------------------------------- live game reads
  function state() { try { return (window.YT && YT.logic) ? YT.logic.state : null; } catch (e) { return null; } }
  function stateName() { try { return window.YT && YT.logic ? String(YT.logic.stateName) : null; } catch (e) { return null; } }
  function ctl() { var s = state(); return (s && s._control) || null; }
  function inLevel() {
    var c = ctl(); if (!c) return false;
    try {
      var rt = c._runTimeData || {};
      return !!(rt.mainHero || (c._roleMgr && c._roleMgr._mainHero));
    } catch (e) { return false; }
  }

  // ---------------------------------------------------------- FairyGUI tree walk
  function uiRoot() {
    var s = state(); if (!s) return null;
    try { return (s.view && s.view.ui) || null; } catch (e) { return null; }
  }
  function search(root, pred, maxDepth) {
    var seen = 0;
    function go(o, d) {
      if (!o || d > (maxDepth || 8) || seen > 4000) return null;
      seen++;
      var hit = false; try { hit = !!pred(o); } catch (e) { }
      if (hit) return o;
      var n = 0; try { n = o.numChildren; } catch (e) { }
      for (var i = 0; i < n; i++) {
        var c = null; try { c = o.getChildAt(i); } catch (e) { }
        var r = go(c, d + 1); if (r) return r;
      }
      return null;
    }
    return go(root, 0);
  }
  function fguiFind(name) { return search(uiRoot(), function (o) { return o.name === name; }, 7); }
  function fguiCard(label) {
    return search(uiRoot(), function (x) {
      try { return (x.title === label || x.text === label) && typeof x.fireClick === 'function'; } catch (e) { return false; }
    }, 8);
  }
  function levelRow(idx) {
    var list = fguiFind('level_list'); if (!list) return null;
    try { return list.getChildAt(idx); } catch (e) { return null; }
  }
  function buyNeed(row) {
    try {
      var m = /(\d+)\s*\/\s*(\d+)/.exec(row.m_buy.getChild('price').text || '');
      return m ? { have: +m[1], need: +m[2] } : null;
    } catch (e) { return null; }
  }
  function unlocked(row) { try { return row.m_unlocked.selectedIndex === 1; } catch (e) { return false; } }
  function fireClick(o) {
    if (!o || typeof o.fireClick !== 'function') return false;
    try { o.fireClick(); return true; } catch (e) { S.err = 'fireClick:' + e; return false; }
  }

  // ------------------------------------------------- Cocos node helpers (结算面板)
  function findNodeByName(root, name, maxDepth) {
    var found = null;
    (function go(nd, d) {
      if (!nd || found || d > (maxDepth || 6)) return;
      if (nd.name === name) { found = nd; return; }
      var cs = nd.children || [];
      for (var i = 0; i < cs.length; i++) go(cs[i], d + 1);
    })(root, 0);
    return found;
  }
  function scene() { try { return cc.director.getScene(); } catch (e) { return null; } }
  var _dlg = null, _dlgAt = 0;
  function dialogNode() {
    var sc = scene(); if (!sc) return null;
    if (_dlg && _dlg.isValid) return _dlg;
    if (Date.now() - _dlgAt < 3000) return null;
    _dlgAt = Date.now();
    _dlg = findNodeByName(sc, 'lose_dialog', 6) || findNodeByName(sc, 'win_dialog', 6) || null;
    return _dlg;
  }
  // 结算面板里那个「再次挑战」按钮：按文字找，再往上找带 cc.Button 的那层
  function retryButton() {
    var d = dialogNode();
    if (!d || !d.activeInHierarchy) return null;
    var hit = null;
    (function go(nd, depth) {
      if (!nd || hit || depth > 5) return;
      var isLab = false, cs = nd._components || [];
      for (var i = 0; i < cs.length; i++) {
        var s = cs[i] && cs[i].string;
        if (typeof s === 'string' && /再次挑战|再来一次|再挑战|重新挑战/.test(s)) { isLab = true; break; }
      }
      if (isLab && nd.activeInHierarchy) {
        var p = nd, g = 0;
        while (p && g < 4) {
          var b = null; try { b = p.getComponent(cc.Button); } catch (e) { }
          if (b) { hit = p; return; }
          p = p.parent; g++;
        }
        hit = nd; return;
      }
      var kids = nd.children || [];
      for (var k = 0; k < kids.length; k++) go(kids[k], depth + 1);
    })(d, 0);
    return hit;
  }
  function pressRetry() {
    var b = retryButton(); if (!b) return false;
    try { b.emit('click', null); return true; } catch (e) { S.err = 'retry:' + e; return false; }
  }

  // --------------------------------------------------------------- the play loop
  var loopS = null;
  function startLoop() {
    if (!window.ZD12LOOP) { log('no ZD12LOOP'); return false; }
    try {
      if (loopS && loopS.stop) loopS.stop();
      loopS = window.ZD12LOOP.start({ period: 66 });
      log('loop started');
      return true;
    } catch (e) { S.err = 'loop:' + e; log('loop ERR ' + e); return false; }
  }
  function stopLoop() { try { if (loopS && loopS.stop) loopS.stop(); } catch (e) { } }
  function stat() { try { return loopS && loopS.stat ? loopS.stat() : null; } catch (e) { return null; } }

  var stepAt = 0;
  function act(fn, gapMs) {          // 动作节流：每个动作之间至少隔 gapMs
    var now = Date.now();
    if (now - stepAt < (gapMs || 700)) return false;
    stepAt = now;
    return fn();
  }

  var enterT0 = Date.now(), roundAt = 0, roundWhy = '';
  function reload(why) {
    S.rounds++;
    log('reload (' + why + ')');
    S.phase = 'reloading';
    setTimeout(function () { location.reload(); }, 1200);
  }
  function roundOver(why, at) {
    stopLoop();
    S.retries++;
    log('round over: ' + why);
    roundAt = Date.now(); roundWhy = why;
    S.phase = 'retry';
  }

  var _lt = -1, _lrt = -1;   // 上一拍的 ticks / runTime（卡住检测用）
  function tick() {
    try {
      var sn = stateName();

      if (S.phase === 'boot') {
        if (sn && window.ZD12LOOP) { S.phase = 'enter'; enterT0 = Date.now(); log('game up, state=' + sn); }
        return;
      }
      if (S.phase === 'reloading') return;

      if (S.phase === 'enter') {
        if (inLevel()) { S.phase = 'play'; log('in level: ' + sn); startLoop(); return; }
        if (sn === 'subgame') {
          var row = levelRow(2);
          if (row) {
            var n = buyNeed(row);
            if (!unlocked(row) && n && n.have < n.need) {
              act(function () { log('unlock click ' + (n.have + 1) + '/' + n.need); return fireClick(row.m_buy); });
            } else {
              act(function () { log('start click (unlocked=' + unlocked(row) + ')'); return fireClick(row.m_start); });
            }
          }
        } else {
          var card = fguiCard('拼刀2');
          if (card) act(function () { log('click card'); return fireClick(card); });
        }
        if (Date.now() - enterT0 > 25000) {
          S.fails++;
          log('entry timeout #' + S.fails + ' (state=' + sn + ')');
          enterT0 = Date.now();
          if (S.fails >= 2) { S.fails = 0; reload('entry timeout'); }
        }
        return;
      }

      if (S.phase === 'play') {
        // 1) 结算面板出现 = 这一局结束了
        if (dialogNode() && dialogNode().activeInHierarchy) { roundOver('result panel', Date.now()); return; }
        var st = stat();
        S.lastStat = st;
        if (!st || !st.ticks) return;
        // 2) 主角没了
        if (st.dead) { roundOver('dead', Date.now()); return; }
        // 3) 画面不动了（游戏时间不再走）
        if (st.ticks > 40 && st.runTime === _lrt) {
          S._stall = (S._stall || 0) + 1;
          if (S._stall > 6) { roundOver('stalled at ' + st.runTime + 's', Date.now()); return; }
        } else { S._stall = 0; }
        _lt = st.ticks; _lrt = st.runTime;
        return;
      }

      if (S.phase === 'retry') {
        var el = Date.now() - roundAt;
        var btn = retryButton();
        if (!dialogNode() || !dialogNode().activeInHierarchy) {
          // 没面板：可能是还没弹出来，也可能这一局根本不给面板
          if (el < 3000) return;                       // 先等它 3 秒
          S.bounce = (S.bounce || 0) + 1;
          if (S.bounce > 6) { S.bounce = 0; reload('no result panel at all'); return; }
          S.phase = 'play'; S._stall = 0; _lrt = -1;
          log('no panel -> back to play (' + S.bounce + ')');
          startLoop();
          return;
        }
        S.bounce = 0;
        if (!btn) {
          if (el > 8000) reload('no retry button');      // 认不出按钮就退回整页重载
          return;
        }
        if (el > 15000) { reload('retry did not work'); return; }
        act(function () { log('press retry'); return pressRetry(); }, 1200);
        return;
      }
    } catch (e) { S.err = 'tick:' + e; }
  }

  // 调试开关：地址后面加 ?auto=0 就只开壳、不自动玩（用来单独验页内工具）
  if (/(^|[?&])auto=0(&|$)/.test(location.search)) { log('autoplay disabled by ?auto=0'); return; }

  setInterval(tick, 400);
  log('autoplay.js v3 loaded');
})();
