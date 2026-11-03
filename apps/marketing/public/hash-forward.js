/* Ruling MKT-HOME-1: the Store landing moved from / to /store. Old links such as /#pricing or /en#faq land on /store/#pricing
   (the trailing slash is the canonical path, so it is one hop). */
(function () {
  var h = location.hash;
  if (!/^#(story|looks|model3d|payments|features|ainative|capabilities|pricing|faq|start)$/.test(h))
    return;
  var en = location.pathname.indexOf('/en') === 0;
  location.replace((en ? '/en' : '') + '/store/' + location.search + h);
})();
