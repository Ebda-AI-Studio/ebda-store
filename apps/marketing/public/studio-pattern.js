/* Ebda AI Studio home: the living girih (Ruling MKT-STUDIO-C-1). Loaded after window load + idle by an inline loader, never on
   prefers-reduced-motion or save-data; the static SVG poster (GirihPoster.tsx) is the first paint and the fallback. One canvas,
   DPR capped at 2 and at ~3M pixels, 30 fps, paused off-screen and in hidden tabs. It draws NO text. Geometry and lattice origins
   mirror GirihPoster.tsx (field: 8-fold at 64px from the hero corner; windows: 8-fold / 6-fold at 40px from the window corner).
   Pointer (or a slow drifting light when there is none) densifies and brightens the lines; scroll turns the inner stars. */
(function () {
  'use strict';
  var hero = document.querySelector('.sh-hero');
  var cv = hero && hero.querySelector('[data-pattern-canvas]');
  var ctx = cv && cv.getContext && cv.getContext('2d');
  if (!ctx) return;
  var cs = getComputedStyle(hero);
  var rgb = function (n, d) {
    return cs.getPropertyValue(n).trim() || d;
  };
  var GOLD = rgb('--sh-gold-rgb', '176,141,87');
  var BRASS = rgb('--sh-brass-rgb', '138,106,54');
  var SILVER = rgb('--sh-silver-rgb', '125,133,141');
  var wins = [].slice.call(hero.querySelectorAll('[data-win]'));
  var W = 0,
    H = 0,
    rects = [];
  var ptr = { x: 0, y: 0, s: 0 }; // smoothed pointer (hero coords) and strength 0..1
  var target = null; // { cx, cy } client coords of the real pointer
  var PI = Math.PI;

  function measure() {
    var r = hero.getBoundingClientRect();
    W = r.width;
    H = r.height;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cap = Math.sqrt(3e6 / Math.max(1, W * H));
    if (cap < dpr) dpr = Math.max(1, cap);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rects = wins.map(function (el) {
      var b = el.getBoundingClientRect();
      return {
        x: b.left - r.left,
        y: b.top - r.top,
        w: b.width,
        h: b.height,
        fam: el.getAttribute('data-win'),
      };
    });
  }

  /* one closed star: n tips, tip radius from rt(k), inner radius ri, turned by rot, scaled by sc, at (cx,cy) */
  function star(cx, cy, n, rTip, rInner, rot, sc) {
    ctx.beginPath();
    for (var k = 0; k < 2 * n; k++) {
      var a = (k * PI) / n + rot;
      var r = (k % 2 ? rInner : typeof rTip === 'function' ? rTip(k) : rTip) * sc;
      var x = cx + Math.cos(a) * r,
        y = cy + Math.sin(a) * r;
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
  function line(col, a) {
    ctx.strokeStyle = 'rgba(' + col + ',' + (a > 1 ? 1 : a < 0 ? 0 : a) + ')';
    ctx.stroke();
  }

  /* a lattice region. fam '8' | '6'; S cell; ox,oy origin (lattice origin in hero coords); bounds in hero coords */
  function lattice(fam, S, ox, oy, x0, y0, x1, y1, t, prog, reach, dense) {
    var i, j, X, Y, d, k, a, b, ph;
    var rot = prog * (PI / 4);
    if (fam === '8') {
      var i0 = Math.floor((x0 - ox) / S) - 1,
        i1 = Math.ceil((x1 - ox) / S) + 1;
      var j0 = Math.floor((y0 - oy) / S) - 1,
        j1 = Math.ceil((y1 - oy) / S) + 1;
      for (j = j0; j <= j1; j++)
        for (i = i0; i <= i1; i++) {
          X = ox + (i + 0.5) * S;
          Y = oy + (j + 0.5) * S;
          d = Math.hypot(X - ptr.x, Y - ptr.y);
          k = Math.max(0, 1 - d / reach) * ptr.s;
          ph = Math.sin(t / 2600 + i * 0.55 + j * 0.8);
          a = 0.42 + 0.07 * ph + k * 0.5 + prog * 0.08;
          b = 1 + 0.025 * ph + k * 0.1;
          if ((((i + j) % 2) + 2) % 2 === 0) {
            star(
              X,
              Y,
              8,
              function (q) {
                return (q % 4 === 0 ? 0.62 : 0.707) * S;
              },
              0.29 * S,
              0,
              b
            );
            line(GOLD, a);
            var dir = (i + j) % 4 === 0 ? 1 : -1;
            star(X, Y, 8, 0.3 * S, 0.14 * S, (dir * t) / 9000 + rot, 1 + k * 0.6);
            line(SILVER, a * 1.1);
            if (k > 0.12 || dense > 0.05) {
              star(
                X,
                Y,
                8,
                0.3 * S,
                0.14 * S,
                (-dir * t) / 7000 - rot,
                0.55 + 0.3 * Math.max(k, dense)
              );
              line(GOLD, a * Math.max(k, dense) * 1.4);
            }
          } else {
            var dd = 0.38 * S * (1 + k * 0.08);
            ctx.beginPath();
            ctx.moveTo(X + dd, Y);
            ctx.lineTo(X, Y + dd);
            ctx.lineTo(X - dd, Y);
            ctx.lineTo(X, Y - dd);
            ctx.closePath();
            line(BRASS, a * 0.95);
            if (k > 0.12 || dense > 0.05) {
              var d2 = dd * 0.5;
              ctx.beginPath();
              ctx.moveTo(X + d2, Y);
              ctx.lineTo(X, Y + d2);
              ctx.lineTo(X - d2, Y);
              ctx.lineTo(X, Y - d2);
              ctx.closePath();
              line(BRASS, a * Math.max(k, dense) * 1.3);
            }
          }
        }
    } else {
      var RH = (Math.sqrt(3) / 2) * S;
      var jj0 = Math.floor((y0 - oy) / RH) - 1,
        jj1 = Math.ceil((y1 - oy) / RH) + 1;
      var ii0 = Math.floor((x0 - ox) / S) - 1,
        ii1 = Math.ceil((x1 - ox) / S) + 1;
      for (j = jj0; j <= jj1; j++)
        for (i = ii0; i <= ii1; i++) {
          X = ox + (i + (((j % 2) + 2) % 2 ? 0.5 : 0)) * S;
          Y = oy + j * RH;
          d = Math.hypot(X - ptr.x, Y - ptr.y);
          k = Math.max(0, 1 - d / reach) * ptr.s;
          ph = Math.sin(t / 2600 + i * 0.6 + j * 0.9);
          a = 0.42 + 0.07 * ph + k * 0.5 + prog * 0.08;
          b = 1 + 0.025 * ph + k * 0.1;
          star(X, Y, 6, 0.5 * S, 0.2887 * S, 0, b);
          line(GOLD, a);
          star(X, Y, 6, 0.2 * S, 0.1 * S, (((i + j) % 2 ? 1 : -1) * t) / 8000 + rot, 1 + k * 0.6);
          line(SILVER, a * 1.1);
          if (k > 0.12 || dense > 0.05) {
            star(X, Y, 6, 0.2 * S, 0.1 * S, -t / 6500 - rot, 0.5 + 0.3 * Math.max(k, dense));
            line(GOLD, a * Math.max(k, dense) * 1.4);
          }
        }
    }
  }

  var live = false;
  function draw(t) {
    var r = hero.getBoundingClientRect();
    if (Math.abs(r.width - W) > 1 || Math.abs(r.height - H) > 1) measure();
    var prog = Math.max(0, Math.min(1, -r.top / Math.max(1, H)));
    var tx, ty, ts;
    if (target) {
      tx = target.cx - r.left;
      ty = target.cy - r.top;
      ts = 1;
    } else {
      tx = W * (0.5 + 0.3 * Math.sin(t / 5200));
      ty = H * (0.4 + 0.18 * Math.cos(t / 4300));
      ts = 0.55;
    }
    if (!ptr.s) {
      ptr.x = tx;
      ptr.y = ty;
    }
    ptr.x += (tx - ptr.x) * 0.14;
    ptr.y += (ty - ptr.y) * 0.14;
    ptr.s += (ts - ptr.s) * 0.1;
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    var dense = prog * 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    rects.forEach(function (q) {
      ctx.rect(q.x, q.y, q.w, q.h);
    });
    ctx.clip('evenodd');
    lattice('8', 64, 0, 0, 0, 0, W, H, t, prog, 64 * 3.2, dense);
    ctx.restore();
    rects.forEach(function (q) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(q.x, q.y, q.w, q.h);
      ctx.clip();
      lattice(q.fam, 40, q.x, q.y, q.x, q.y, q.x + q.w, q.y + q.h, t, prog, 40 * 3.6, dense + 0.1);
      ctx.restore();
    });
    if (!live) {
      live = true;
      hero.setAttribute('data-live', '');
    }
  }

  var vis = true,
    running = false,
    last = 0;
  function loop(now) {
    if (!vis || document.hidden) {
      running = false;
      return;
    }
    if (now - last >= 33) {
      last = now;
      draw(now);
    }
    requestAnimationFrame(loop);
  }
  function kick() {
    if (!running && vis && !document.hidden) {
      running = true;
      requestAnimationFrame(loop);
    }
  }
  hero.addEventListener('pointermove', function (e) {
    target = { cx: e.clientX, cy: e.clientY };
  });
  hero.addEventListener('pointerdown', function (e) {
    target = { cx: e.clientX, cy: e.clientY };
  });
  hero.addEventListener('pointerleave', function () {
    target = null;
  });
  hero.addEventListener('pointercancel', function () {
    target = null;
  });
  if (window.IntersectionObserver)
    new IntersectionObserver(
      function (es) {
        vis = es[0].isIntersecting;
        kick();
      },
      { rootMargin: '120px' }
    ).observe(hero);
  document.addEventListener('visibilitychange', kick);
  if (window.ResizeObserver)
    new ResizeObserver(function () {
      measure();
    }).observe(hero);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  measure();
  draw(0);
  kick();
})();
