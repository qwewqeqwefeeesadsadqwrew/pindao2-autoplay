// autoplay.js -- in-page autoplay for the mini-game "pin dao 2" level 3.
//
// 一个网址打开就自己玩，全程零人工，不依赖页面外的任何工具：
//   1. 等游戏启动；
//   2. 在副玩法列表按名字点「拼刀2」卡片；
//   3. 在关卡列表：没解锁就点「提前解锁」直到计数满，再点「开始」；
//   4. 进关后交给判断层（v12-loop）自己打；
//   5. 结算面板一出现（挑战失败/成功）就按「再次挑战」，立刻接着打这一关——无限循环。
//   6. 每开一局之前，把主角的脸换成「敌人图鉴」里的一个形象（外观补丁，见下）。
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

  // ------------------------------------------------ 外观补丁：每局把主角换成敌人的形象
  // 主角长什么样由配置表 ZdHeroConfig[id].res 决定（"1"卡皮巴拉 "12"唐僧 "13"猪八戒 …），
  // HeroCmp 拿它去取 prefab/hero/<res>。我们只在本页内存里改这一格，而且在「开打之前」改，
  // 所以新一局的模型一出生就是新形象。游戏磁盘文件一个字节不动；刷新页面即恢复原样。
  //
  // SKIN_LIST = 花名册（远山 2026-10-13 挑的 6 个）。每局开打前从里面随机抽一个，
  // 洗牌式：把花名册打乱当牌堆，一个一个抽，6 张抽完再洗一遍——一轮里不会连着出同一个人。
  var SKIN_LIST = ['BOSS_02', 'BOSS_03', 'BOSS_04', '51', '48', '13'];
  // 这 6 个是谁：BOSS_02 青龙 / BOSS_03 大猩猩 / BOSS_04 哥斯拉 / 51 熊猫 / 48 吕布 / 13 猪八戒
  // 想换人只改上面这一行；全部 79 个编号+名字见 _skill-out\形象节目单.png、probe\names.json。
  // 常用编号：1 卡皮巴拉(主角原皮) 11 悟空 12 唐僧 13 猪八戒 14 关羽 18 哪吒 24 牛魔王 38 包租婆
  //          40 奶龙 46 九尾狐 47 貂蝉 48 吕布 49 马斯克 51 熊猫 58 东方不败 BOSS_01~04 关底BOSS
  // 网址后面加 ?skin=0 关掉整件事；?skin=12,13,11 只演这几个（一样是洗牌随机）。
  var _heroCfg = null;
  function heroCfgJson() {
    if (_heroCfg) return _heroCfg;
    try {
      cc.assetManager.assets.forEach(function (a) {
        var n = String((a && (a.name || a._name)) || '');
        if (n === 'ZdHeroConfig' && a.json) _heroCfg = a.json;
      });
    } catch (e) { }
    return _heroCfg;
  }
  function playerIds(cfg) {                       // agent===0 的就是「主角」，不写死编号
    var ids = [];
    for (var k in cfg) { var e = cfg[k]; if (e && Number(e.agent) === 0) ids.push(k); }
    return ids;
  }
  var SKIN = { list: [], i: -1, bag: [], want: null, applied: null, at: 0, fails: 0, seen: null,
               node: null, checked: false, staged: false };
  var SKIN_KEY = 'zd12SkinI';      // 一共抽了几张，记在会话里（验收脚本看这个）
  var SKIN_BAG = 'zd12SkinBag';    // 手上还剩的牌，记在会话里：整页重载接着往下抽，不重头洗
  (function skinSetup() {
    SKIN.list = SKIN_LIST.slice();
    var q = /(^|[?&])skin=([^&]*)/.exec(location.search);
    if (q) {
      if (q[2] === '0') SKIN.list = [];                               // ?skin=0 关掉整件事
      else if (q[2]) SKIN.list = q[2].split(',').filter(Boolean);      // ?skin=12,13 只演这几个
    }
    // 花名册只认代码这一行和地址参数：不再读会话里那份旧名单，免得老配置把新名单顶掉
    try { var b = sessionStorage.getItem(SKIN_BAG); if (b) SKIN.bag = b.split(',').filter(Boolean); } catch (e) { }
    try { var s = sessionStorage.getItem(SKIN_KEY); if (s !== null && s !== '') SKIN.i = +s; } catch (e) { }
    S.SKIN = SKIN;                     // 挂到 __AP 上，方便外面看（验收脚本用）
  })();
  function skinShuffle(a) {                    // 洗牌
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  // 抽下一张脸：牌堆空了就重洗；手上的牌跟当前花名册对不上（改了名单或换了 ?skin=）也重洗。
  function skinNext() {
    if (!SKIN.list.length) return null;
    var stale = false;
    for (var k = 0; k < SKIN.bag.length; k++) { if (SKIN.list.indexOf(SKIN.bag[k]) < 0) stale = true; }
    if (!SKIN.bag.length || stale) SKIN.bag = skinShuffle(SKIN.list.slice());
    var res = SKIN.bag.shift();
    SKIN.i++;
    try {
      sessionStorage.setItem(SKIN_BAG, SKIN.bag.join(','));
      sessionStorage.setItem(SKIN_KEY, String(SKIN.i));
    } catch (e) { }
    return res;
  }
  // 开打之前换脸：抽下一张，写进配置表。一整局只做一次。
  function skinStage() {
    if (SKIN.staged) return true;
    SKIN.staged = true;
    SKIN.want = skinNext();
    SKIN.checked = false;
    if (!skinApply(SKIN.want)) log('skin: config not ready (' + SKIN.want + ')');
    return true;
  }
  // 必须在「开打之前」调：改好配置表，下一局的模型才会是新形象。返回 true = 改好了。
  function skinApply(res) {
    if (!res) return true;
    var cfg = heroCfgJson();
    if (!cfg) { SKIN.fails++; return false; }
    var ids = playerIds(cfg);
    if (!ids.length) { SKIN.fails++; return false; }
    for (var i = 0; i < ids.length; i++) cfg[ids[i]].res = String(res);
    SKIN.applied = String(res); SKIN.at = Date.now();
    log('skin -> ' + res + ' (ids ' + ids.join(',') + ')');
    return true;
  }
  // 万一配置表在开打前没读到（理论上不会）：进关后把当前这局的主角模型换个脸兜底
  function skinSwapLive(res) {
    var c = ctl(); if (!c) return false;
    var h = null;
    try { var rt = c._runTimeData || {}; h = rt.mainHero || (c._roleMgr && c._roleMgr._mainHero); } catch (e) { }
    if (!h || !h._view) return false;
    var v = h._view, b = null;
    try { cc.assetManager.bundles.forEach(function (x, k) { if (String(k) === 'zhuandao') b = x; }); } catch (e) { }
    if (!b) return false;
    try {
      b.load('prefab/hero/' + res, cc.Prefab, function (err, pf) {
        if (err || !pf || !v.isValid) return;
        var old = v._modelNode, node = cc.instantiate(pf);
        if (old) { node.setScale(old.scale); node.setPosition(old.position); }
        node.parent = v._viewRoot;
        if (old) { old.removeFromParent(); old.destroy(); }
        v._modelNode = node;
        v._modelSprites = node.getComponentsInChildren(cc.Sprite);
        if (v._setShadowNode) { try { v._setShadowNode(node.getChildByName('shadow')); } catch (e) { } }
        h._config.res = String(res);
        SKIN.node = node;
        log('skin live-swap -> ' + res);
      });
      return true;
    } catch (e) { return false; }
  }
  // 每局第一次在场上看到主角时对一次账：
  //   模型节点是本局新建的  -> 开打前那次换脸生效了，什么都不用做；
  //   模型节点还是上一局那个 -> 这局没重建模型，现场兜底换脸。
  // （不能拿配置表的 res 当证据：我们改的就是它，它永远显示新值。）
  function skinCheck() {
    var c = ctl(); if (!c) return;
    var h = null;
    try { var rt = c._runTimeData || {}; h = rt.mainHero || (c._roleMgr && c._roleMgr._mainHero); } catch (e) { }
    if (!h || !h._view) return;
    var node = h._view._modelNode || null;
    if (!node) return;
    SKIN.seen = h._config ? String(h._config.res) : null;
    if (SKIN.checked) return;
    SKIN.checked = true;
    if (SKIN.want && SKIN.node && node === SKIN.node) {
      log('skin: model reused -> live swap ' + SKIN.want);
      skinSwapLive(SKIN.want);
    } else {
      log('skin: in play as ' + SKIN.seen + ' (want ' + SKIN.want + ')');
    }
    SKIN.node = node;
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
  function levelRow(no) {
    var list = fguiFind('level_list'); if (!list) return null;
    // 关卡列表是虚拟滚动：getChildAt 给的是「可视池里的第几个」，不是关卡号。
    // 先把目标行滚进可视区（行高 178，居中），再按「第 N 关」的文本找。
    try {
      var sp = list.scrollPane;
      sp.posY = Math.max(0, (no - 1) * 178 - sp.viewHeight / 2 + 89);
    } catch (e) { }
    for (var i = 0; i < list.numChildren; i++) {
      var r = null; try { r = list.getChildAt(i); } catch (e) { continue; }
      if (!r) continue;
      var label = '第' + no + '关';
      var hit = search(r, function (o) { return o.text === label || o.title === label; }, 4);
      if (hit) return r;
    }
    return null;
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
  // 终局规则（远山 2026-10-14 定）：大龙（关底 BOSS 10303）一出场就不再满地图逃——
  // 先追着打完别的敌人，场上只剩大龙时直接去决战（见 v12-loop.js 的 end boss 段）。
  // 地址后面加 ?boss=0 关掉这条，回到老的「危险就一直逃」。
  var BOSS_RULE = !/(^|[?&])boss=0(&|$)/.test(location.search);
  S.bossRule = BOSS_RULE;
  // 关卡号：默认第 3 关；`?level=16` 演第 16 关（雾战模式）。关卡列表是虚拟滚动，
  // 所以要先把列表滚到那一行再按「第 N 关」的文本找。
  function intParam(name, dft) {
    var m = new RegExp('[?&]' + name + '=(\\d+)').exec(location.search);
    return m ? Number(m[1]) : dft;
  }
  var LEVEL_NO = intParam('level', 3);
  S.level = LEVEL_NO;
  // 关底 BOSS 的编号按关卡走：第 3 关 10303、第 16 关 100303。
  // 第 16 关还有 5 个 is_boss 的「睡眠」和一只 BOSS_03，不能靠 is_boss / 攻击力兜底认。
  var BOSS_ID = intParam('bossId', LEVEL_NO === 16 ? 100303 : 10303);
  S.bossId = BOSS_ID;
  // 清场时限的两个旋钮（都有默认值，见 v12-loop.js）：?bossIdle=秒 追多久打不到就转决战；
  // ?bossMax=秒 清场最多持续多久。想现场试手感就改链接，不用改代码。
  function numParam(name) {
    var m = new RegExp('[?&]' + name + '=([0-9]+(?:\\.[0-9]+)?)').exec(location.search);
    return m ? Number(m[1]) : undefined;
  }
  S.bossIdleMax = numParam('bossIdle');
  S.bossClearMax = numParam('bossMax');

  var loopS = null;
  function startLoop() {
    if (!window.ZD12LOOP) { log('no ZD12LOOP'); return false; }
    try {
      if (loopS && loopS.stop) loopS.stop();
      // 第 16 关强敌多（5 只 atk3 的睡眠、60 刀敌人），用第 3 关那套威胁圈会一直逃：
      // 公网实测逃跑占 58%。这关把「算威胁」的半径和撤退线都收紧，靠近了才躲。
      var lvOpt = LEVEL_NO === 16 ? { standoff: 1000, domRange: 1600 } : {};
      loopS = window.ZD12LOOP.start({ period: 66, bossRule: BOSS_RULE,
        bossId: BOSS_ID, bossIdleMax: S.bossIdleMax, bossClearMax: S.bossClearMax,
        standoff: lvOpt.standoff, domRange: lvOpt.domRange });
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
    SKIN.staged = false;            // 下一局开打前再抽一张脸
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
          var row = levelRow(LEVEL_NO);
          if (row) {
            var n = buyNeed(row);
            if (!unlocked(row) && n && n.have < n.need) {
              act(function () { log('unlock click ' + (n.have + 1) + '/' + n.need); return fireClick(row.m_buy); });
            } else {
              skinStage();                                  // 开打之前换脸
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
        skinCheck();                                    // 2) 对一次账（首次看到主角时）
        var st = stat();
        S.lastStat = st;
        if (!st || !st.ticks) return;
        // 3) 主角没了
        if (st.dead) { roundOver('dead', Date.now()); return; }
        // 4) 画面不动了（游戏时间不再走）
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
        skinStage();                                    // 新一局开打之前换脸
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
