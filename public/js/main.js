(function () {
  "use strict";

  var E = window.EVENT || {};
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasGsap = !!(window.gsap && window.ScrollTrigger);
  var isHome = document.body.classList.contains("home");

  /* ---------- Données de l'événement ---------- */
  document.querySelectorAll("[data-event]").forEach(function (el) {
    var k = el.getAttribute("data-event");
    if (E[k] != null) el.textContent = E[k];
  });

  /* ---------- Navigation ---------- */
  var nav = document.getElementById("nav");
  function onScrollNav() { if (nav) nav.classList.toggle("scrolled", window.scrollY > 60); }
  onScrollNav();
  window.addEventListener("scroll", onScrollNav, { passive: true });

  /* ---------- Vidéo du hero : fondu au noir à chaque reprise ---------- */
  var heroVideo = document.getElementById("heroVideo");
  var heroDip = document.getElementById("heroDip");
  if (heroVideo && heroDip) {
    var lastT = 0;
    heroVideo.addEventListener("timeupdate", function () {
      var t = heroVideo.currentTime, d = heroVideo.duration;
      if (d && d - t < 0.95) heroDip.classList.add("on");
      if (t < lastT) setTimeout(function () { heroDip.classList.remove("on"); }, 80);
      lastT = t;
    });
  }

  /* ---------- Vidéos des rounds : chargées et jouées seulement à l'écran ---------- */
  var roundVideos = document.querySelectorAll(".round-video");
  if (roundVideos.length) {
    var small = window.matchMedia("(max-width: 760px)").matches;
    var loadVideo = function (v) {
      if (v.dataset.loaded) return;
      v.src = small ? v.dataset.srcM : v.dataset.srcD;
      v.dataset.loaded = "1";
    };
    if ("IntersectionObserver" in window) {
      var playIfVisible = function (v) {
        if (reduce || document.visibilityState !== "visible" || !v.dataset.inview) return;
        var p = v.play(); if (p && p.catch) p.catch(function () {});
      };
      document.addEventListener("visibilitychange", function () {
        roundVideos.forEach(playIfVisible);
      });
      var vio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          var v = e.target;
          if (e.isIntersecting) v.dataset.inview = "1"; else delete v.dataset.inview;
          if (e.isIntersecting) {
            loadVideo(v);
            if (!reduce) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
          } else if (!v.paused) v.pause();
        });
      }, { rootMargin: "200px 0px 200px 0px" });
      roundVideos.forEach(function (v) { vio.observe(v); });
    } else {
      roundVideos.forEach(function (v) { loadVideo(v); if (!reduce) v.play(); });
    }
  }

  /* ---------- Compte à rebours ---------- */
  var cd = document.getElementById("countdown");
  if (cd && E.dateISO) {
    var target = new Date(E.dateISO + "T" + (E.startTime || "18:30") + ":00");
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var tick = function () {
      var ms = Math.max(0, target - new Date());
      var m = Math.floor(ms / 60000);
      cd.querySelector('[data-cd="d"]').textContent = pad(Math.floor(m / 1440));
      cd.querySelector('[data-cd="h"]').textContent = pad(Math.floor((m % 1440) / 60));
      cd.querySelector('[data-cd="m"]').textContent = pad(m % 60);
    };
    tick();
    setInterval(tick, 30000);
  }

  /* ---------- Manifeste : découpage en lignes ---------- */
  var manifesto = document.querySelector("[data-lines]");
  var manifestoHTML = manifesto ? manifesto.innerHTML : "";
  if (manifesto) manifesto.setAttribute("aria-label", manifesto.textContent.replace(/\s+/g, " ").trim());

  // Découpe le texte en lignes réelles (selon la largeur) en gardant l'italique doré.
  function splitLines() {
    if (!manifesto) return [];
    manifesto.innerHTML = manifestoHTML;
    var words = [], frag = document.createDocumentFragment(), prevSpace = true, last = null;
    var forceBreak = false;
    Array.prototype.slice.call(manifesto.childNodes).forEach(function (node) {
      if (node.nodeName === "BR") {
        if (getComputedStyle(node).display !== "none") forceBreak = true;
        return;
      }
      var isEm = node.nodeType === 1;
      node.textContent.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { prevSpace = true; return; }
        var piece = isEm ? document.createElement("em") : document.createTextNode(part);
        if (isEm) piece.textContent = part;
        if (!prevSpace && last) { last.appendChild(piece); }
        else {
          last = document.createElement("span");
          last.className = "w";
          last.style.display = "inline-block";
          last.appendChild(piece);
          if (forceBreak) { last.setAttribute("data-break", ""); forceBreak = false; }
          words.push(last);
        }
        prevSpace = false;
      });
    });
    manifesto.innerHTML = "";
    words.forEach(function (w, i) {
      if (w.hasAttribute("data-break")) manifesto.appendChild(document.createElement("br"));
      else if (i) manifesto.appendChild(document.createTextNode(" "));
      manifesto.appendChild(w);
    });
    var lines = [], top = null;
    words.forEach(function (w) {
      var t = w.offsetTop;
      if (top === null || Math.abs(t - top) > 4 || w.hasAttribute("data-break")) { lines.push([]); top = t; }
      lines[lines.length - 1].push(w);
    });
    manifesto.innerHTML = "";
    return lines.map(function (ws) {
      var ml = document.createElement("span"), mi = document.createElement("span");
      ml.className = "ml"; mi.className = "ml-in";
      ws.forEach(function (w, i) { if (i) mi.appendChild(document.createTextNode(" ")); mi.appendChild(w); });
      ml.appendChild(mi);
      manifesto.appendChild(ml);
      return mi;
    });
  }

  /* ---------- Sans animation ---------- */
  var intro = document.getElementById("intro");
  function endIntro() {
    document.body.classList.remove("is-loading");
    if (intro) intro.classList.add("done");
  }
  if (!hasGsap || reduce || !isHome) {
    endIntro();
    return;
  }

  /* ==========================================================
     Animations (GSAP + ScrollTrigger + Lenis)
     ========================================================== */
  var gsap = window.gsap;
  var ST = window.ScrollTrigger;
  gsap.registerPlugin(ST);

  // Apparition avec état final explicite (évite les éléments restés invisibles)
  var END = { autoAlpha: 1, x: 0, y: 0, xPercent: 0, yPercent: 0, scale: 1, scaleX: 1, rotate: 0 };
  function from2(targets, vars) {
    var fromVars = {}, toVars = {};
    Object.keys(vars).forEach(function (k) {
      if (k in END) { fromVars[k] = vars[k]; toVars[k] = END[k]; }
      else toVars[k] = vars[k];
    });
    return gsap.fromTo(targets, fromVars, toVars);
  }

  var lenis = null;
  if (window.Lenis) {
    lenis = new window.Lenis({ duration: 1.25, smoothWheel: true });
    lenis.on("scroll", ST.update);
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
    lenis.stop();
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener("click", function (e) {
        var id = a.getAttribute("href");
        if (id.length > 1 && document.querySelector(id)) {
          e.preventDefault();
          lenis.scrollTo(id, { offset: -40 });
        }
      });
    });
  }

  /* ---------- Ouverture ---------- */
  var heroIn = ".hero-kicker, .hero-lede, .hero-info, .nav";
  gsap.set(".hero-title .word", { yPercent: 108 });
  gsap.set(heroIn, { autoAlpha: 0, y: 18 });
  gsap.set(".hero-kicker .rule", { scaleX: 0 });
  gsap.set(".hero-video", { autoAlpha: 0, scale: 1.06 });

  var tl = gsap.timeline({ defaults: { ease: "expo.out" }, onComplete: function () {
    endIntro();
    if (lenis) lenis.start();
  } });

  tl.to(".intro-kicker", { autoAlpha: 1, duration: 1 }, 0.2)
    .to(".intro-line", { scaleX: 1, duration: 1.2, ease: "expo.inOut" }, 0.3)
    .to(".intro-title", { autoAlpha: 1, duration: 1.2 }, 0.7)
    .to(".intro", { autoAlpha: 0, duration: 1.1, ease: "power2.inOut" }, 1.9)
    .to(".hero-video", { autoAlpha: 1, scale: 1, duration: 2.6, ease: "power2.out" }, 2.0)
    .add(function () { endIntro(); if (lenis) lenis.start(); }, 2.6)
    .to(".hero-kicker", { autoAlpha: 1, y: 0, duration: 1.2 }, 2.5)
    .to(".hero-kicker .rule", { scaleX: 1, duration: 1.2, ease: "expo.inOut" }, 2.55)
    .to(".hero-title .word", { yPercent: 0, duration: 1.5, stagger: 0.12 }, 2.65)
    .to(".hero-lede", { autoAlpha: 1, y: 0, duration: 1.3 }, 3.0)
    .to(".hero-info, .nav", { autoAlpha: 1, y: 0, duration: 1.3, stagger: 0.08 }, 3.15);

  /* ---------- Hero au défilement ---------- */
  gsap.to(".hero-video", {
    yPercent: 14, ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true }
  });
  gsap.to(".hero-content", {
    yPercent: -18, autoAlpha: 0, ease: "none",
    scrollTrigger: { trigger: ".hero", start: "top top", end: "45% top", scrub: true }
  });

  /* ---------- Manifeste : double page ---------- */
  var lineTweens = [];
  function animateLines() {
    lineTweens.forEach(function (t) { t.scrollTrigger && t.scrollTrigger.kill(); t.kill(); });
    lineTweens = splitLines().map(function (line) {
      return gsap.fromTo(line,
        { yPercent: 100, autoAlpha: 0.2 },
        { yPercent: 0, autoAlpha: 1, ease: "power2.out",
          scrollTrigger: { trigger: line.parentNode, start: "top 92%", end: "top 62%", scrub: 0.6 } });
    });
  }
  if (manifesto) {
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () {
      animateLines();
      ST.refresh();
    });
    var lastW = window.innerWidth, rt;
    window.addEventListener("resize", function () {
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      clearTimeout(rt);
      rt = setTimeout(function () { animateLines(); ST.refresh(); }, 200);
    });
  }

  gsap.utils.toArray(".folio").forEach(function (folio) {
    gsap.fromTo(folio.querySelector(".folio-line"), { scaleX: 0 }, { scaleX: 1, duration: 1.4, ease: "expo.inOut",
      scrollTrigger: { trigger: folio, start: "top 90%" } });
    from2(folio.querySelectorAll("span:not(.folio-line)"), { autoAlpha: 0, y: 12, duration: 1.2, stagger: 0.08, ease: "expo.out",
      scrollTrigger: { trigger: folio, start: "top 90%" } });
  });

  gsap.fromTo(".sig-rule", { scaleX: 0 }, { scaleX: 1, duration: 1.4, ease: "expo.inOut",
    scrollTrigger: { trigger: ".signature", start: "top 88%" } });
  from2(".sig-name, .sig-place", { autoAlpha: 0, x: -16, duration: 1.3, stagger: 0.1, delay: 0.3, ease: "expo.out",
    scrollTrigger: { trigger: ".signature", start: "top 88%" } });

  from2(".manifesto-foot > *", { autoAlpha: 0, y: 28, duration: 1.3, stagger: 0.1, ease: "expo.out",
    scrollTrigger: { trigger: ".manifesto-foot", start: "top 88%" } });

  gsap.fromTo(".spread-photo", { clipPath: "inset(100% 0% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 1.8, ease: "expo.inOut",
    scrollTrigger: { trigger: ".spread-figure", start: "top 85%" } });
  gsap.fromTo(".spread-photo img", { scale: 1.18, yPercent: -4 }, { scale: 1.02, yPercent: 4, ease: "none",
    scrollTrigger: { trigger: ".spread-figure", start: "top bottom", end: "bottom top", scrub: true } });
  from2(".spread-figure figcaption", { autoAlpha: 0, y: 10, duration: 1.2, delay: 0.6, ease: "expo.out",
    scrollTrigger: { trigger: ".spread-figure", start: "top 85%" } });

  /* ---------- Rounds ---------- */
  from2(".rounds-head > *", {
    autoAlpha: 0, y: 60, duration: 1.5, stagger: 0.1, ease: "expo.out",
    scrollTrigger: { trigger: ".rounds-head", start: "top 82%" }
  });

  var mm = gsap.matchMedia();

  mm.add("(min-width: 761px)", function () {
    var track = document.getElementById("roundsTrack");
    var distance = function () { return track.scrollWidth - window.innerWidth; };

    var scroller = gsap.to(track, {
      x: function () { return -distance(); },
      ease: "none",
      scrollTrigger: {
        trigger: "#roundsPin",
        start: "top top",
        end: function () { return "+=" + distance(); },
        pin: true,
        scrub: 1,
        invalidateOnRefresh: true,
        anticipatePin: 1
      }
    });

    gsap.to("#roundsProgress", {
      scaleX: 1, ease: "none",
      scrollTrigger: { trigger: "#roundsPin", start: "top top", end: function () { return "+=" + distance(); }, scrub: true }
    });

    gsap.utils.toArray(".round").forEach(function (round, i) {
      var media = round.querySelector(".round-media");
      var img = round.querySelector(".round-video, img");
      var body = round.querySelector(".round-body");
      var opts = i === 0
        ? { trigger: round, start: "top 75%", end: "top 20%", scrub: true }
        : { trigger: round, containerAnimation: scroller, start: "left 95%", end: "left 35%", scrub: true };
      gsap.fromTo(media, { clipPath: "inset(8% 8% 8% 8%)" }, { clipPath: "inset(0% 0% 0% 0%)", ease: "none", scrollTrigger: opts });
      gsap.fromTo(img, { scale: 1.25 }, { scale: 1, ease: "none", scrollTrigger: opts });
      // Le texte reste toujours lisible : seul un léger décalage accompagne le défilement
      gsap.fromTo(body, { x: 50 }, { x: 0, ease: "none", scrollTrigger: opts });
    });
  });

  mm.add("(max-width: 760px)", function () {
    gsap.utils.toArray(".round").forEach(function (round) {
      from2(round.querySelector(".round-video, img"), { scale: 1.3, ease: "none",
        scrollTrigger: { trigger: round, start: "top bottom", end: "bottom top", scrub: true } });
      from2(round.querySelector(".round-body").children, {
        autoAlpha: 0, y: 40, stagger: 0.08, duration: 1.2, ease: "expo.out",
        scrollTrigger: { trigger: round.querySelector(".round-body"), start: "top 85%" }
      });
    });
  });

  /* ---------- Fenêtre qui s'ouvre ---------- */
  mm.add("(min-width: 761px)", function () {
    gsap.fromTo("#reelFrame", { clipPath: "inset(12% 22% 12% 22%)" }, {
      clipPath: "inset(0% 0% 0% 0%)", ease: "none",
      scrollTrigger: { trigger: ".reel", start: "top 75%", end: "center center", scrub: true }
    });
  });
  mm.add("(max-width: 760px)", function () {
    gsap.fromTo("#reelFrame", { clipPath: "inset(6% 6% 6% 6%)" }, {
      clipPath: "inset(0% 0% 0% 0%)", ease: "none",
      scrollTrigger: { trigger: ".reel", start: "top 80%", end: "center center", scrub: true }
    });
  });
  gsap.fromTo("#reelFrame img", { scale: 1.2 }, {
    scale: 1, ease: "none",
    scrollTrigger: { trigger: ".reel", start: "top bottom", end: "bottom top", scrub: true }
  });
  from2(".reel-overlay > *", {
    autoAlpha: 0, y: 50, stagger: 0.12, duration: 1.4, ease: "expo.out",
    scrollTrigger: { trigger: ".reel", start: "top 55%" }
  });

  /* ---------- Invitation : la carte se pose, puis le reflet passe ---------- */
  var card = document.getElementById("inviteCard");
  if (card) {
    var cardTl = gsap.timeline({
      scrollTrigger: { trigger: "#inviteStage", start: "top 88%" },
      onComplete: function () { card.classList.add("lit"); }
    });
    cardTl
      .fromTo("#inviteStage", { autoAlpha: 0, y: 90 }, { autoAlpha: 1, y: 0, duration: 1.6, ease: "expo.out" }, 0)
      .fromTo(".invite-sheet", { rotation: 0, xPercent: 0, yPercent: 0 }, { rotation: -2.4, xPercent: -1.2, yPercent: 1.6, duration: 1.8, ease: "expo.out" }, 0.5)
      .fromTo(card, { "--rx": "16deg" }, { "--rx": "0deg", duration: 1.9, ease: "expo.out" }, 0)
      .fromTo(".invite-frame", { autoAlpha: 0 }, { autoAlpha: 1, duration: 1.2, ease: "power2.out" }, 0.35)
      .fromTo(".invite-corners, .invite-head > *", { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 1.2, stagger: 0.1, ease: "expo.out" }, 0.55)
      .fromTo(".invite-rule", { scaleX: 0 }, { scaleX: 1, duration: 1.3, ease: "expo.inOut" }, 0.8)
      .fromTo(".invite-grid > div, .invite-cta > *", { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 1.1, stagger: 0.08, ease: "expo.out" }, 1.0);

    // Inclinaison très légère qui suit la souris (ordinateur uniquement)
    if (window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 1081px)").matches) {
      card.addEventListener("mousemove", function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        card.style.setProperty("--ry", (px * 5).toFixed(2) + "deg");
        card.style.setProperty("--rx", (-py * 4).toFixed(2) + "deg");
        card.style.setProperty("--gx", ((px + 0.5) * 100).toFixed(1) + "%");
        card.style.setProperty("--gy", ((py + 0.5) * 100).toFixed(1) + "%");
      });
      card.addEventListener("mouseleave", function () {
        card.style.setProperty("--ry", "0deg");
        card.style.setProperty("--rx", "0deg");
      });
    }
  }
  from2(".invite-notes li", { autoAlpha: 0, y: 20, duration: 1.2, stagger: 0.08, ease: "expo.out",
    scrollTrigger: { trigger: ".invite-notes", start: "top 90%" } });

  /* ---------- Pied de page ---------- */
  from2(".footer-top > *", { autoAlpha: 0, y: 30, duration: 1.3, stagger: 0.1, ease: "expo.out",
    scrollTrigger: { trigger: ".footer-top", start: "top 88%" } });
  from2(".footer-word", {
    yPercent: 40, autoAlpha: 0, ease: "none",
    scrollTrigger: { trigger: ".footer", start: "top bottom", end: "bottom bottom", scrub: true }
  });

  window.addEventListener("load", function () { ST.refresh(); });
})();
