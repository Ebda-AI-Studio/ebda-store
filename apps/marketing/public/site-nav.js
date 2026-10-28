(function () {
  var header = document.querySelector('.site-header');
  if (!header) return;
  function menus() {
    return Array.prototype.slice.call(header.querySelectorAll('details'));
  }
  function trigger(d) {
    for (var i = 0; i < d.children.length; i++)
      if (d.children[i].tagName === 'SUMMARY') return d.children[i];
    return null;
  }
  function sync(d) {
    var t = trigger(d);
    if (t) t.setAttribute('aria-expanded', String(d.open));
  }
  function closeAll(except) {
    menus().forEach(function (d) {
      if (d !== except && d.open) d.open = false;
    });
  }
  function outside(e) {
    menus().forEach(function (d) {
      if (d.open && !d.contains(e.target)) d.open = false;
    });
  }
  menus().forEach(sync);
  header.addEventListener(
    'toggle',
    function (e) {
      var d = e.target;
      if (!d || d.tagName !== 'DETAILS') return;
      sync(d);
      if (d.open) closeAll(d);
    },
    true
  );
  header.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var a = e.target.closest ? e.target.closest('a') : null;
    var d = a && a.closest('details');
    if (d && header.contains(d)) d.open = false;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = menus().filter(function (d) {
      return d.open;
    })[0];
    if (!open) return;
    open.open = false;
    var t = trigger(open);
    if (t) t.focus();
  });
  document.addEventListener('pointerdown', outside);
  document.addEventListener('focusin', outside);
})();
