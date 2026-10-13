// bgm.js -- 把这一页的背景音乐换成指定的曲子（默认：VENI VIDI VICI 无缝循环版）。
//
// 干两件事，游戏本体一个字节不动，刷新页面即恢复原样：
//   1. 把游戏自带的音乐按住（游戏用 YT.audio.playMusic() 放 BGM，
//      我们把它那条路封掉，再把它的播放器音量钉在 0）——打斗音效不动，照响；
//   2. 播我们自己的循环曲子：整个文件先解码成一整块采样，
//      再用 AudioBufferSourceNode 的 loop 循环。这样接缝是「采样级」的，
//      不像 <audio loop> 那样在 mp3 的编码补零处留一个小顿。
//
// 浏览器的自动播放限制：没跟用户交互过时，AudioContext 是挂起状态，
// 这时页面上给一个小提示条，用户点一下（或按任意键）就恢复播放。
//
// 验收用（控制台 / CDP 里调）：__BGM.probe() 看状态，__BGM.measure() 量接缝。
// 网址后面加 ?bgm=0 关掉整件事（游戏用自己的音乐）；?bgm=<0~1> 调音量大小。

(function () {
  'use strict';

  var TUNE = {
    ogg: 'veni_vidi_vici_loop.ogg',           // 无损循环的容器，没有编码补零，优先用
    mp3: 'veni_vidi_vici_loop.mp3',           // 兜底（Safari 之类不认 ogg 的）
    volume: 0.7
  };

  var B = {
    v: 'bgm1', t0: Date.now(), err: null, file: null,
    ctx: null, buf: null, src: null, gain: null,
    started: false, blocked: false, muted: false, musicStops: 0, hint: null
  };
  window.__BGM = B;

  // ?bgm=0 关掉；?bgm=0.5 调音量
  var OFF = false;
  (function () {
    var m = /(^|[?&])bgm=([^&]*)/.exec(location.search);
    if (!m) return;
    if (m[2] === '0') { OFF = true; return; }
    var v = Number(m[2]);
    if (v > 0 && v <= 1) TUNE.volume = v;
  })();
  B.off = OFF;

  // ---------------------------------------------------------------- 1. 按住游戏音乐
  function muteGameMusic() {
    var A = window.YT && window.YT.audio;
    if (!A) return false;
    try {
      var p = Object.getPrototypeOf(A);
      if (p && typeof p.playMusic === 'function' && !p.__bgmPatched) {
        p.playMusic = function () { B.musicStops++; };            // 游戏再也点不着自己的 BGM
        if (typeof p.switchMusic === 'function') p.switchMusic = function () { };
        p.__bgmPatched = true;
      }
    } catch (e) { B.err = 'patch: ' + e; }
    // 分开两段 try：stopMusic 内部偶尔会自己抛错（播放器还没建好），
    // 不能因为这个把「把音量钉 0」也一起跳过。
    try {
      if (A.music && typeof A.stopMusic === 'function') A.stopMusic();
    } catch (e) { B.err = 'stop: ' + e; }
    try {
      if (A.music && A.music.volume) A.music.volume = 0;
    } catch (e) { B.err = 'vol: ' + e; }
    B.muted = true;
    return true;
  }

  // 游戏每次换关都会重建播放器、把音量写回去，所以得一直盯着
  function guard() {
    try {
      var A = window.YT && window.YT.audio;
      if (!A) return;
      if (!B.muted) muteGameMusic();
      var m = A.music;
      if (!m) return;
      if (m.volume) m.volume = 0;
      if (m.playing) { m.stop(); B.musicStops++; }
    } catch (e) { }
  }
  var guardTimer = null;

  // ---------------------------------------------------------------- 2. 播我们的循环
  function pickFile() {
    try {
      var a = document.createElement('audio');
      if (a.canPlayType && a.canPlayType('audio/ogg; codecs="vorbis"')) return TUNE.ogg;
    } catch (e) { }
    return TUNE.mp3;
  }

  function showHint() {
    if (B.hint) return;
    var d = document.createElement('div');
    d.textContent = '点一下开声音';
    d.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);' +
      'z-index:2147483647;padding:7px 16px;border-radius:999px;cursor:pointer;' +
      'background:rgba(0,0,0,.55);color:#fff;font:14px/1.4 -apple-system,"Microsoft YaHei",sans-serif;' +
      'letter-spacing:1px;backdrop-filter:blur(4px);user-select:none';
    document.body.appendChild(d);
    B.hint = d;
  }
  function hideHint() { if (B.hint && B.hint.parentNode) B.hint.parentNode.removeChild(B.hint); B.hint = null; }

  function waitGesture(ctx) {
    B.blocked = true;
    showHint();
    var evs = ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'];
    function off() { evs.forEach(function (e) { window.removeEventListener(e, go, true); }); }
    function ok() { B.blocked = false; hideHint(); off(); }
    function go() {
      ctx.resume().then(function () {
        B.ctxState = ctx.state;
        if (ctx.state === 'running') ok();
      });
    }
    evs.forEach(function (e) { window.addEventListener(e, go, true); });
    var n = 0;
    var t = setInterval(function () {
      if (++n > 30 || ctx.state === 'running') { clearInterval(t); if (ctx.state === 'running') ok(); return; }
      ctx.resume();
    }, 500);
  }

  function start() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { B.err = 'no AudioContext'; return; }
    var ctx = new AC();
    B.ctx = ctx;
    var url = window.__HERE + pickFile();
    B.file = url;
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(function (ab) { return ctx.decodeAudioData(ab); })
      .then(function (buf) {
        B.buf = buf;
        B.bufLen = buf.length;
        B.sr = buf.sampleRate;
        B.dur = buf.duration;
        var g = ctx.createGain();
        g.gain.value = TUNE.volume;
        g.connect(ctx.destination);
        var s = ctx.createBufferSource();
        s.buffer = buf;
        s.loop = true;
        s.connect(g);
        s.start(0);
        B.gain = g; B.src = s; B.started = true;
        B.tStart = ctx.currentTime;
        if (ctx.state === 'running') { B.blocked = false; } else { waitGesture(ctx); }
      })
      .catch(function (e) { B.err = 'load: ' + e; });
  }

  // ---------------------------------------------------------------- 3. 自查工具
  B.probe = function () {
    function q(f) { try { return f(); } catch (e) { return 'err'; } }
    return JSON.stringify({
      v: B.v, err: B.err, file: B.file,
      ctxState: q(function () { return B.ctx ? B.ctx.state : null; }),
      started: B.started, blocked: B.blocked,
      dur: B.dur, bufLen: B.bufLen, sr: B.sr,
      now: q(function () { return B.ctx ? Math.round(B.ctx.currentTime * 1000) / 1000 : null; }),
      muted: B.muted, musicStops: B.musicStops,
      gameVol: q(function () { return window.YT.audio.music.volume; }),
      gamePlaying: q(function () { return !!window.YT.audio.music.playing; }),
      gameClip: q(function () { var c = window.YT.audio.music.clip; return c ? String(c.name || c._name) : null; })
    });
  };

  // 量接缝：解码后的头尾采样差、前后各 200 帧的响度
  B.measure = function () {
    if (!B.buf) return JSON.stringify({ err: 'no buffer' });
    var d = [];
    for (var c = 0; c < B.buf.numberOfChannels; c++) d.push(B.buf.getChannelData(c));
    var n = B.buf.length;
    var jump = Math.abs(d[0][0] - d[0][n - 1]);
    function rms(v, a, b) { var s = 0; for (var i = a; i < b; i++) s += v[i] * v[i]; return Math.sqrt(s / (b - a)); }
    return JSON.stringify({
      sampleRate: B.buf.sampleRate, length: n, dur: B.buf.duration,
      seamJump: jump,
      head200: rms(d[0], 0, 200), tail200: rms(d[0], n - 200, n),
      mid200: rms(d[0], (n >> 1) - 100, (n >> 1) + 100),
      firstSamples: [d[0][0], d[0][1], d[0][2]],
      lastSamples: [d[0][n - 3], d[0][n - 2], d[0][n - 1]]
    });
  };

  function boot() {
    if (OFF) return;                                            // ?bgm=0：什么都不动
    muteGameMusic();
    start();
    guardTimer = setInterval(guard, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
