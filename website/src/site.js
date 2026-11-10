// TeamBot website: light/dark toggle (follows the system until you choose) and closing the phone menu.
// No network, no cookies; the choice is kept in this browser only (localStorage, when allowed).
(function () {
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function stored() {
    try {
      var t = localStorage.getItem('tb-theme');
      return t === 'light' || t === 'dark' ? t : null;
    } catch (e) {
      return null;
    }
  }
  function active() {
    return stored() || (media && media.matches ? 'dark' : 'light');
  }
  var btn = document.querySelector('.theme-toggle');
  function paint() {
    var a = active();
    root.setAttribute('data-active-theme', a);
    if (btn) btn.setAttribute('aria-label', btn.getAttribute(a === 'dark' ? 'data-label-light' : 'data-label-dark'));
  }
  if (btn) {
    btn.hidden = false;
    btn.addEventListener('click', function () {
      var next = active() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem('tb-theme', next);
      } catch (e) {}
      paint();
    });
  }
  if (media && media.addEventListener) media.addEventListener('change', paint);
  paint();

  // Phone menu (<details>): close on Escape and when clicking outside.
  var menu = document.querySelector('details.menu');
  if (menu) {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.open) {
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    });
    document.addEventListener('click', function (e) {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
  }
  // Sections come in softly while you scroll. Not for reduced motion, not without IntersectionObserver, and not in an
  // automated browser (so checks and screenshots always see the whole page).
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!calm && 'IntersectionObserver' in window && !navigator.webdriver) {
    var parts = document.querySelectorAll('main .section > .wrap, .hero-media');
    if (parts.length) {
      root.classList.add('js');
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) {
              en.target.classList.add('in');
              io.unobserve(en.target);
            }
          });
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
      );
      parts.forEach(function (el) {
        el.classList.add('reveal');
        io.observe(el);
      });
    }
  }
})();
