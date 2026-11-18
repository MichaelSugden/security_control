(function () {
  'use strict';
  var d = document, w = window, html = d.documentElement;
  var reduce = w.matchMedia('(prefers-reduced-motion: reduce)');
  var $$ = function (s, r) { return Array.prototype.slice.call((r || d).querySelectorAll(s)); };
  var lenis = null, motionOn = false, heroTl = null, tick = null;

  /* Headline line split for the reveal; rebuilt on resize */
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function split(el) {
    var words = el._txt.trim().split(/\s+/);
    el.innerHTML = words.map(function (x) { return '<span class="w">' + esc(x) + '</span>'; }).join(' ');
    var lines = [], top = null;
    $$('.w', el).forEach(function (s) {
      if (top === null || Math.abs(s.offsetTop - top) > 3) { lines.push([]); top = s.offsetTop; }
      lines[lines.length - 1].push(s.textContent);
    });
    el.innerHTML = lines.map(function (l) { return '<span class="ln"><span class="ln__i">' + esc(l.join(' ')) + '</span></span>'; }).join(' ');
    if (w.gsap) w.gsap.set($$('.ln__i', el), { yPercent: el._revealed ? 0 : 115 });
  }

  /* Header state and scroll progress hairline */
  var header = d.querySelector('[data-header]');
  var bar = d.querySelector('[data-progress]');
  function onScroll() {
    var y = w.scrollY || html.scrollTop;
    header.classList.toggle('is-scrolled', y > 24);
    var max = html.scrollHeight - w.innerHeight;
    bar.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, y / max) : 0) + ')';
  }
  w.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* Off-canvas menu: focus moves in, Tab stays in, Esc and Close return focus */
  var menu = d.querySelector('[data-menu]');
  var opener = d.querySelector('[data-menu-open]');
  var outside = [header, d.getElementById('main'), d.querySelector('.foot'), d.querySelector('.skip')];
  function focusables() { return $$('a[href], button:not([disabled])', menu).filter(function (el) { return el.offsetParent !== null; }); }
  function openMenu() {
    menu.classList.add('is-open');
    opener.setAttribute('aria-expanded', 'true');
    outside.forEach(function (el) { if (el) el.inert = true; });
    if (lenis) lenis.stop();
    html.style.overflow = 'hidden';
    var f = menu.querySelector('.menu__close');
    setTimeout(function () { f.focus(); }, 30);
  }
  function closeMenu() {
    if (!menu.classList.contains('is-open')) return;
    menu.classList.remove('is-open');
    opener.setAttribute('aria-expanded', 'false');
    outside.forEach(function (el) { if (el) el.inert = false; });
    html.style.overflow = '';
    if (lenis) lenis.start();
    opener.focus();
  }
  opener.addEventListener('click', openMenu);
  $$('[data-menu-close]', menu).forEach(function (b) { b.addEventListener('click', closeMenu); });
  d.addEventListener('keydown', function (e) {
    if (!menu.classList.contains('is-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    if (e.key !== 'Tab') return;
    var f = focusables(), first = f[0], last = f[f.length - 1];
    if (e.shiftKey && d.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && d.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* Service panels: on touch, the first tap opens a panel and the second follows the link */
  var panelsRoot = d.querySelector('[data-panels]');
  var row = d.querySelector('[data-panels-row]');
  var wide = w.matchMedia('(min-width: 1200px)');
  if (panelsRoot) {
    var lastPointer = 'mouse';
    d.addEventListener('pointerdown', function (e) { lastPointer = e.pointerType; }, true);
    panelsRoot.addEventListener('click', function (e) {
      var link = e.target.closest('.panel__link');
      if (!link || !wide.matches) return;
      var item = link.closest('[data-panel]');
      if (e.detail > 0 && lastPointer !== 'mouse' && !item.classList.contains('is-open')) {
        e.preventDefault();
        $$('[data-panel].is-open', panelsRoot).forEach(function (p) { p.classList.remove('is-open'); });
        item.classList.add('is-open');
      }
    });
    d.addEventListener('click', function (e) {
      if (!panelsRoot.contains(e.target)) $$('[data-panel].is-open', panelsRoot).forEach(function (p) { p.classList.remove('is-open'); });
    });
    var syncRow = function () { if (wide.matches) row.removeAttribute('data-lenis-prevent'); else row.setAttribute('data-lenis-prevent', ''); };
    syncRow();
    if (wide.addEventListener) wide.addEventListener('change', syncRow);
  }

  /* Services index: closed disclosure on small screens, fixed open beside the text from 1024px */
  var svcnav = d.querySelector('[data-svcnav]');
  if (svcnav) {
    var navWide = w.matchMedia('(min-width: 1024px)');
    var sum = svcnav.querySelector('summary');
    var syncNav = function () {
      if (navWide.matches) { svcnav.open = true; sum.setAttribute('tabindex', '-1'); }
      else { svcnav.open = false; sum.removeAttribute('tabindex'); }
    };
    sum.addEventListener('click', function (e) { if (navWide.matches) e.preventDefault(); });
    svcnav.addEventListener('toggle', function () { if (motionOn && w.ScrollTrigger) w.ScrollTrigger.refresh(); });
    syncNav();
    if (navWide.addEventListener) navWide.addEventListener('change', syncNav);
    var navWas = navWide.matches;
    w.addEventListener('resize', function () { if (navWide.matches !== navWas) { navWas = navWide.matches; syncNav(); } });
  }

  /* FAQ accordion: answers close when the script runs (open without it); each button toggles its own answer */
  $$('[data-faq]').forEach(function (b) {
    var a = d.getElementById(b.getAttribute('aria-controls'));
    var set = function (open) { b.setAttribute('aria-expanded', String(open)); a.hidden = !open; };
    set(false);
    b.addEventListener('click', function () {
      set(b.getAttribute('aria-expanded') !== 'true');
      if (motionOn && w.ScrollTrigger) w.ScrollTrigger.refresh();
    });
  });

  /* Scroll motion: Lenis smooth scroll plus GSAP ScrollTrigger; skipped for reduced motion or missing libraries */
  function initMotion() {
    var g = w.gsap, ST = w.ScrollTrigger;
    if (reduce.matches || !g || !ST) { html.classList.remove('motion-pending'); return; }
    g.registerPlugin(ST);
    motionOn = true;
    if (w.Lenis) {
      lenis = new w.Lenis({ duration: 1.15, smoothWheel: true });
      lenis.on('scroll', ST.update);
      tick = function (t) { if (lenis) lenis.raf(t * 1000); };
      g.ticker.add(tick);
      g.ticker.lagSmoothing(0);
    }

    $$('[data-split]').forEach(function (el) { el._txt = el.textContent; el._split = true; split(el); });
    html.classList.remove('motion-pending');

    function revealLines(el, delay) {
      el._revealed = true;
      g.to($$('.ln__i', el), { yPercent: 0, duration: 1.2, ease: 'expo.out', stagger: .09, delay: delay || 0 });
    }

    /* Hero entrance: one timeline played on load (never on a scroll trigger); finishHero() completes it if frames stall */
    var hero = d.querySelector('[data-hero]');
    var heroTitle = hero.querySelector('[data-split]');
    heroTitle._revealed = true;
    heroTl = g.timeline();
    heroTl.to($$('.ln__i', heroTitle), { yPercent: 0, duration: 1, ease: 'expo.out', stagger: .08 }, .1);
    heroTl.from('.hero__lead', { opacity: 0, y: 24, duration: .9, ease: 'power3.out' }, .35);
    $$('[data-hero-reveal]', hero).forEach(function (el, i) { heroTl.from(el, { opacity: 0, y: 20, duration: .9, ease: 'power3.out' }, i ? .55 : 0); });
    if (d.querySelector('[data-hero-bg]')) {
      g.fromTo('[data-hero-bg] img', { scale: 1.1 }, { scale: 1, duration: 2.4, ease: 'power2.out' });
      g.to('[data-hero-bg]', { yPercent: 12, ease: 'none', scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true } });
    }
    if (d.querySelector('[data-hero-in]')) g.to('[data-hero-in]', { y: -70, opacity: .15, ease: 'none', scrollTrigger: { trigger: hero, start: '30% top', end: 'bottom top', scrub: true } });

    /* Section headlines and text blocks; whatever is already in view at start reveals at once */
    var inView = function (el) { return el.getBoundingClientRect().top < w.innerHeight; };
    $$('[data-split]').forEach(function (el) {
      if (el === heroTitle) return;
      if (inView(el)) { revealLines(el, .2); return; }
      ST.create({ trigger: el, start: 'top 86%', once: true, onEnter: function () { revealLines(el); } });
    });
    $$('[data-reveal]').forEach(function (el) {
      if (heroTl && el.closest('[data-hero]')) return;
      var v = { opacity: 0, y: 28, duration: 1.1, ease: 'power3.out' };
      if (inView(el)) v.delay = .2; else v.scrollTrigger = { trigger: el, start: 'top 90%', once: true };
      g.from(el, v);
    });
    $$('[data-reveal-group]').forEach(function (el) {
      var v = { opacity: 0, y: 20, duration: .9, ease: 'power3.out', stagger: .08 };
      if (inView(el)) v.delay = .2; else v.scrollTrigger = { trigger: el, start: 'top 88%', once: true };
      g.from(el.children, v);
    });

    /* Gentle crossfade as each section arrives */
    $$('[data-fade]').forEach(function (el) {
      if (inView(el)) return;
      g.fromTo(el, { opacity: .2 }, { opacity: 1, ease: 'none', scrollTrigger: { trigger: el, start: 'top 98%', end: 'top 62%', scrub: true } });
    });

    /* Photo bands: clip reveal, slow scale and parallax */
    $$('[data-band-frame]').forEach(function (fr) {
      var band = fr.closest('.band');
      var img = fr.querySelector('[data-band-img]');
      g.fromTo(fr, { clipPath: 'inset(8% 0% 8% 14%)' }, { clipPath: 'inset(0% 0% 0% 0%)', ease: 'none', scrollTrigger: { trigger: band, start: 'top 95%', end: 'top 25%', scrub: true } });
      g.fromTo(img, { yPercent: -6, scale: 1.12 }, { yPercent: 6, scale: 1, ease: 'none', scrollTrigger: { trigger: band, start: 'top bottom', end: 'bottom top', scrub: true } });
    });

    /* Glow blobs drift on X and Y with scroll, as on the live site */
    $$('[data-glow]').forEach(function (gl) {
      var dx = parseFloat(gl.getAttribute('data-glow')) || 0;
      g.fromTo(gl, { x: -dx, y: 110 }, { x: dx, y: -110, ease: 'none', scrollTrigger: { trigger: gl.parentNode, start: 'top bottom', end: 'bottom top', scrub: true } });
    });

    /* Panels arrive in a short stagger */
    if (panelsRoot) g.from('.panel', { opacity: 0, y: 48, duration: 1, ease: 'power3.out', stagger: .06, clearProps: 'opacity,transform', scrollTrigger: { trigger: panelsRoot, start: 'top 85%', once: true } });

    /* No frames within 1.2 s (hidden or occluded view, frozen rendering): drop motion and show everything */
    var f0 = g.ticker.frame;
    setTimeout(function () { if (motionOn && g.ticker.frame - f0 < 3) dropMotion(); }, 1200);

    /* Rebuild split lines when the width changes */
    var lastW = w.innerWidth, t = null;
    w.addEventListener('resize', function () {
      if (!motionOn || w.innerWidth === lastW) return;
      lastW = w.innerWidth;
      clearTimeout(t);
      t = setTimeout(function () { $$('[data-split]').forEach(split); ST.refresh(); }, 180);
    });
  }

  /* Safety net: the hero entrance always ends visible */
  function finishHero() {
    if (heroTl) heroTl.progress(1);
    html.classList.remove('motion-pending');
  }

  /* Static end state, as with reduced motion: no tweens, no triggers, no split lines, no smooth scroll */
  function dropMotion() {
    var g = w.gsap, ST = w.ScrollTrigger;
    motionOn = false;
    finishHero();
    ST.getAll().forEach(function (tr) { tr.kill(); });
    g.globalTimeline.getChildren(true, true, false).forEach(function (tw) {
      var tg = tw.targets();
      tw.kill();
      g.set(tg, { clearProps: 'opacity,transform,clipPath,visibility' });
    });
    $$('[data-split]').forEach(function (el) { if (el._split) { el.textContent = el._txt; el._split = false; } });
    if (tick) { g.ticker.remove(tick); tick = null; }
    if (lenis) { lenis.destroy(); lenis = null; }
  }

  function start() {
    setTimeout(finishHero, 2500);
    var fonts = d.fonts && d.fonts.ready ? d.fonts.ready : Promise.resolve();
    var timeout = new Promise(function (r) { setTimeout(r, 1500); });
    Promise.race([fonts, timeout]).then(initMotion);
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start); else start();
})();

/* Contact form: posts URL-encoded to /api/contact, reads the JSON reply whatever the status, shows messages in the page language */
(function () {
  'use strict';
  var form = document.querySelector('[data-contact-form]');
  if (!form) return;
  var msgs = JSON.parse(document.getElementById('cform-msgs').textContent);
  var status = document.querySelector('[data-form-status]');
  var busy = false;
  form.setAttribute('novalidate', '');
  var say = function (key) { status.textContent = msgs[key] || msgs['form.error']; };
  var clear = function () {
    Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (f) { f.removeAttribute('aria-invalid'); });
    Array.prototype.forEach.call(form.querySelectorAll('[data-err]'), function (p) { p.textContent = ''; p.hidden = true; });
  };
  var mark = function (fields) {
    var first = null;
    Array.prototype.forEach.call(form.elements, function (f) {
      if (!f.name || !f.id || !Object.prototype.hasOwnProperty.call(fields, f.name)) return;
      var err = document.getElementById(f.id + '-err');
      f.setAttribute('aria-invalid', 'true');
      if (err) { err.textContent = msgs['field.' + f.name + '.' + fields[f.name]] || msgs['field.other']; err.hidden = false; }
      if (!first) first = f;
    });
    if (first) first.focus();
  };
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (busy) return;
    busy = true;
    clear();
    form.elements.elapsed.value = String(Math.round(performance.now()));
    say('form.sending');
    fetch(form.action, { method: 'POST', headers: { 'Accept': 'application/json' }, body: new URLSearchParams(new FormData(form)) })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok === true) { form.reset(); say('form.success'); return; }
        var code = data && data.code;
        if (code === 'invalid' && data.fields) mark(data.fields);
        say(['invalid', 'rate_limited', 'unavailable', 'error'].indexOf(code) !== -1 ? 'form.' + code : 'form.error');
      })
      .catch(function () { say('form.error'); })
      .then(function () { busy = false; });
  });
})();
