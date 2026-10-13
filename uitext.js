// uitext.js —— 把游戏界面上那句提示换成远山要的口径（只动显示，游戏本体一个字节不改）
//
// 原样：通过第三关,主界面-进入[color=#00ff00]拼刀2[/color]玩法
// 新版：通过第五关-主界面-进入-[color=#00ff00]拼刀侠[/color]玩法
//
// 这行字在游戏里是 cc.RichText（富文本）组件的 string，可能出现在好几个界面；
// 所以做法是：① 给 cc.RichText.prototype.string 挂个钩子——游戏以后任何时候再设这句话，
// 都被换成新版；② 再定期扫一遍场景，把已经建好的那些也换掉。
//
// 关掉：网址后面加 ?uitext=0。看状态：__UITEXT。
(function () {
  'use strict';

  var NEW_RICH = '<b><outline color=000000 width=3>通过第五关-主界面-进入-<color=#00ff00>拼刀侠</color>玩法</outline></b>';
  var NEW_PLAIN = '通过第五关-主界面-进入-拼刀侠玩法';

  var OFF = /(^|[?&])uitext=0/.test(location.search);
  var U = { v: 'uitext1', off: OFF, hits: 0, patched: false, sweeps: 0, err: null };
  window.__UITEXT = U;
  if (OFF) return;

  // 只认这一类提示：必须同时出现「主界面-进入」和「拼刀」，
  // 别的玩法（打黑龙/双龙戏柱/冲冲龙/双龙汇/弹球/祖玛…）一律不碰。
  function fix(v) {
    if (typeof v !== 'string') return v;
    if (v.indexOf('主界面-进入') < 0 || v.indexOf('拼刀') < 0) return v;
    if (v.indexOf('第五关') >= 0 && v.indexOf('拼刀侠') >= 0) return v;   // 已经是新的了
    U.hits++;
    return v.indexOf('<') >= 0 ? NEW_RICH : NEW_PLAIN;
  }

  function patch() {
    var RT = window.cc && window.cc.RichText;
    if (!RT || !RT.prototype) return false;
    try {
      var d = Object.getOwnPropertyDescriptor(RT.prototype, 'string');
      if (!d || !d.set || !d.get) return false;
      Object.defineProperty(RT.prototype, 'string', {
        configurable: true,
        get: d.get,
        set: function (v) { d.set.call(this, fix(v)); }
      });
      U.patched = true;
      return true;
    } catch (e) { U.err = 'patch: ' + e; return false; }
  }

  function sweep() {
    var sc = null;
    try { sc = window.cc.director.getScene(); } catch (e) { return; }
    if (!sc) return;
    U.sweeps++;
    var stack = [sc];
    while (stack.length) {
      var n = stack.pop();
      var cs = n._components || [];
      for (var i = 0; i < cs.length; i++) {
        var s = null;
        try { s = cs[i].string; } catch (e) { s = null; }
        if (typeof s === 'string' && s.indexOf('主界面-进入') >= 0 && s.indexOf('拼刀') >= 0) {
          try { cs[i].string = s; } catch (e) { }   // 走一遍 setter，钩子会换成新版
        }
      }
      var ch = n.children || [];
      for (var j = 0; j < ch.length; j++) stack.push(ch[j]);
    }
  }

  var n = 0;
  var timer = setInterval(function () {
    n++;
    var ok = patch();
    if (n <= 15 || n % 5 === 0) sweep();       // 头 3 秒密一点，之后每 1 秒扫一遍
    if (n > 3000) clearInterval(timer);
  }, 200);
})();
