/* Back-office du Business Club : tableau de bord, accueil (QR + recherche), invités, e-mails. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var data = { stats: {}, registrations: [], audiences: {}, sectors: [] };
  var view = "dash";
  var filter = "paid";
  var sortBy = "name";
  var PAGE = 40;
  var shown = PAGE;
  var openId = null;
  var editing = false;
  var refreshTimer = null;

  var TITLES = { dash: "Tableau de bord", entry: "Entrée des invités", guests: "Invités", mail: "E-mails" };
  var HASH = { dash: "#tableau", entry: "#entree", guests: "#invites", mail: "#emails" };
  var EVENT_DAY = "2026-12-04";

  /* ---------- Outils ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: "same-origin", headers: { "Content-Type": "application/json" } }, opts || {}))
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; });
      });
  }
  function post(path, body) { return api(path, { method: "POST", body: JSON.stringify(body || {}) }); }
  function hhmm(iso) {
    if (!iso) return "";
    return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)).replace(":", " h ");
  }
  function day(iso) {
    if (!iso) return "";
    return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      .format(new Date(iso)).replace(":", " h ");
  }
  function todayParis() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date()); }
  function euros(c) { return ((c || 0) / 100).toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €"; }
  function telHref(p) { return "tel:" + String(p || "").replace(/[^\d+]/g, ""); }
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  function fullName(r) { return [r.first_name, r.last_name].filter(Boolean).join(" ") || r.id; }
  function plural(n, one, many) { return n + " " + (n > 1 ? many : one); }
  function pct(a, b) { return b ? Math.min(100, Math.round((a / b) * 100)) : 0; }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $("toast");
    t.textContent = msg;
    t.setAttribute("data-kind", kind || "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3800);
  }

  /** Fenêtre de confirmation (remplace window.confirm). */
  function ask(title, text, okLabel) {
    var d = $("confirm");
    $("cTitle").textContent = title;
    $("cText").textContent = text || "";
    $("cOk").textContent = okLabel || "Confirmer";
    if (typeof d.showModal !== "function") return Promise.resolve(window.confirm(title + "\n\n" + (text || "")));
    return new Promise(function (resolve) {
      d.returnValue = "";
      d.addEventListener("close", function once() {
        d.removeEventListener("close", once);
        resolve(d.returnValue === "ok");
      });
      d.showModal();
    });
  }

  /* ---------- Connexion ---------- */
  function showLock() {
    $("lock").hidden = false; $("app").hidden = true;
    clearInterval(refreshTimer);
    stopCam();
    setTimeout(function () { $("pwd").focus(); }, 50);
  }
  function showApp() {
    $("lock").hidden = true; $("app").hidden = false;
    setView(viewFromHash(), true);
    measureTop();
    load();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () { if (!document.hidden) load(); }, 20000);
  }

  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    $("loginError").hidden = true;
    post("/api/gestion/login", { password: $("pwd").value }).then(function (r) {
      if (r.ok) { $("pwd").value = ""; showApp(); return; }
      $("loginError").hidden = false;
      $("loginError").textContent = r.error === "too_many_attempts"
        ? "Trop de tentatives. Réessayez dans quelques minutes."
        : "Mot de passe incorrect.";
    });
  });
  function logout() { stopCam(); post("/api/gestion/logout").then(showLock); }
  $("logout").addEventListener("click", logout);
  $("logoutM").addEventListener("click", logout);

  /* ---------- Navigation ---------- */
  function viewFromHash() {
    var h = location.hash;
    var found = Object.keys(HASH).filter(function (k) { return HASH[k] === h; })[0];
    return found || "dash";
  }
  function setView(name, silent) {
    view = name;
    $$(".nav-item, .tab-item").forEach(function (b) {
      if (b.getAttribute("data-view") === name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    $$(".view").forEach(function (s) { s.hidden = s.getAttribute("data-view") !== name; });
    $("viewTitle").textContent = TITLES[name];
    document.title = TITLES[name] + " · Business Club";
    if (name !== "entry") stopCam();
    if (!silent && history.replaceState) history.replaceState(null, "", HASH[name]);
    closeMenu();
    window.scrollTo(0, 0);
    if (name === "mail") { refreshPreview(); nlLoad(); }
  }
  $$(".nav-item, .tab-item").forEach(function (b) {
    b.addEventListener("click", function () { setView(b.getAttribute("data-view")); });
  });
  document.addEventListener("click", function (e) {
    var go = e.target.closest("[data-goto]");
    if (go) setView(go.getAttribute("data-goto"));
  });

  function closeMenu() { $("moreMenu").hidden = true; $("moreBtn").setAttribute("aria-expanded", "false"); }
  $("moreBtn").addEventListener("click", function (e) {
    e.stopPropagation();
    var open = $("moreMenu").hidden;
    $("moreMenu").hidden = !open;
    $("moreBtn").setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", function (e) { if (!e.target.closest("#moreMenu, #moreBtn")) closeMenu(); });

  function includeTest() { return $("showTest").checked; }
  function syncTestToggles(src) {
    $("showTest").checked = src.checked;
    $("showTestM").checked = src.checked;
    $("testBanner").hidden = !src.checked;
    load();
  }
  $("showTest").addEventListener("change", function () { syncTestToggles(this); });
  $("showTestM").addEventListener("change", function () { syncTestToggles(this); });
  $("refresh").addEventListener("click", function () { load().then(function () { toast("Données à jour"); }); });

  /* ---------- Données ---------- */
  function load() {
    var q = includeTest() ? "?test=1" : "";
    $("exportCsv").href = "/api/gestion/export.csv" + q;
    return api("/api/gestion/overview" + q).then(function (r) {
      if (r._status === 401) { showLock(); return; }
      if (!r.ok) { $("sync").textContent = "Connexion perdue"; return; }
      data = r;
      $("sync").textContent = "Mis à jour à " + hhmm(new Date().toISOString());
      renderAll();
    }).catch(function () { $("sync").textContent = "Hors ligne"; });
  }

  function byId(id) { return data.registrations.filter(function (r) { return r.id === id; })[0]; }
  function paidList() { return data.registrations.filter(function (r) { return r.status === "paid"; }); }
  function arrivals() {
    return data.registrations.filter(function (r) { return r.checked_in_at && (r.status === "paid" || r.status === "partner"); })
      .sort(function (a, b) { return String(b.checked_in_at).localeCompare(String(a.checked_in_at)); });
  }

  function renderAll() {
    renderHeader();
    renderDash();
    renderEntry();
    renderGuests();
    renderMail();
    if (openId && !editing && !isTyping()) renderDrawer();
  }
  function isTyping() {
    var a = document.activeElement;
    return a && $("drawer").contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName);
  }

  function countdown() {
    var today = todayParis();
    if (today === EVENT_DAY) return "Aujourd’hui";
    var d = Math.round((Date.parse(EVENT_DAY) - Date.parse(today)) / 86400000);
    if (d < 0) return "Terminé";
    return "J-" + d;
  }
  function renderHeader() {
    $("eventMeta").textContent = "Vendredi 4 décembre 2026 · " + countdown();
    $("mailDot").hidden = !(data.stats.invitations_failed > 0);
  }

  /* ---------- Étiquettes de statut ---------- */
  function statusPills(r) {
    var t = [];
    if (r.test) t.push('<span class="pill pill--bad">Test</span>');
    if (r.status === "paid") {
      t.push('<span class="pill pill--gold">' + ({ onsite: "Payé sur place", free: "Invité" }[r.source] || "Payé") + "</span>");
    } else if (r.status === "partner") t.push('<span class="pill pill--gold">Partenaire</span>');
    else if (r.status === "pending") t.push('<span class="pill pill--warn">Paiement en attente</span>');
    else t.push('<span class="pill pill--bad">' + esc({ cancelled: "Annulé", failed: "Refusé", review: "À vérifier" }[r.status] || r.status) + "</span>");
    if (r.status === "paid" && r.confirmation_error) t.push('<span class="pill pill--bad">Invitation en échec</span>');
    if (r.checked_in_at) t.push('<span class="pill pill--ok">Arrivé ' + esc(hhmm(r.checked_in_at)) + "</span>");
    return t.join("");
  }
  function sub(r) { return [r.company, r.role].filter(Boolean).join(" · "); }

  /* ---------- Tableau de bord ---------- */
  function renderDash() {
    var s = data.stats;
    $("kPaid").textContent = s.paid;
    $("kPaidMax").textContent = "/ " + s.max;
    $("kPaidBar").style.width = pct(s.paid, s.max) + "%";
    $("kPaidFoot").textContent = plural(Math.max(0, s.max - s.paid), "place restante", "places restantes");
    $("kPresent").textContent = s.present;
    $("kPresentMax").textContent = "/ " + s.expected;
    $("kPresentBar").style.width = pct(s.present, s.expected) + "%";
    $("kPresentFoot").textContent = "dont " + plural(s.partners_present, "partenaire", "partenaires") + " sur " + s.partners_total;
    $("kRevenue").textContent = euros(s.revenue_cents);
    $("kRevenueFoot").textContent = (s.onsite ? plural(s.onsite, "inscription ajoutée sur place", "inscriptions ajoutées sur place") : "paiements en ligne confirmés");
    $("kPending").textContent = s.pending;
    $("countdown").textContent = countdown();

    var w = data.reminders || {};
    var items = [];
    var failed = s.invitations_failed || 0;
    items.push(failed
      ? ["bad", "<b>" + plural(failed, "invitation n’a", "invitations n’ont") + " pas pu partir.</b> <button class=\"link\" data-goto=\"mail\">Renvoyer</button>"]
      : ["ok", "<b>Invitations envoyées</b> : " + (s.invitations_sent || 0) + " / " + s.paid]);
    if (w.today && w.sends_on && w.today < w.sends_on) items.push(["", "<b>Rappel de la veille</b> : envoi automatique le 3 décembre vers 10 h"]);
    else items.push([(s.reminders_sent || 0) >= (s.reminders_target || s.paid) ? "ok" : "warn", "<b>Rappels envoyés</b> : " + (s.reminders_sent || 0) + " / " + (s.reminders_target || s.paid)]);
    if (s.review) items.push(["bad", "<b>" + plural(s.review, "paiement", "paiements") + " à vérifier</b> (montant ou référence inattendus)"]);
    var left = Math.max(0, s.max - s.paid);
    items.push([left === 0 ? "bad" : left < 10 ? "warn" : "ok", "<b>Places</b> : " + plural(left, "restante", "restantes") + " sur " + s.max]);
    items.push(["", "<b>Invitations partenaires</b> : " + s.partners_present + " / " + s.partners_total + " utilisées"]);
    if (s.pending) items.push(["warn", "<b>" + plural(s.pending, "paiement", "paiements") + " non finalisé" + (s.pending > 1 ? "s" : "") + "</b> <button class=\"link\" data-template=\"relance\">Relancer par e-mail</button>"]);
    $("watchList").innerHTML = items.map(function (i) {
      return '<li><span class="dot' + (i[0] ? " dot--" + i[0] : "") + '"></span><span class="txt">' + i[1] + "</span></li>";
    }).join("");

    $("dashArrivals").innerHTML = miniRows(arrivals().slice(0, 6), function (r) { return hhmm(r.checked_in_at); }, "Personne n’est encore arrivé.");
    var latest = paidList().sort(function (a, b) { return String(b.paid_at).localeCompare(String(a.paid_at)); }).slice(0, 6);
    $("dashLatest").innerHTML = miniRows(latest, function (r) { return day(r.paid_at); }, "Aucune inscription pour l’instant.");

    var counts = {};
    paidList().forEach(function (r) { var k = r.sector || "Non précisé"; counts[k] = (counts[k] || 0) + 1; });
    var rows = Object.keys(counts).map(function (k) { return [k, counts[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    var max = rows.length ? rows[0][1] : 1;
    $("dashSectors").innerHTML = rows.length ? rows.slice(0, 7).map(function (x) {
      return '<li><span class="lbl">' + esc(x[0]) + '</span><span class="n">' + x[1] + '</span><span class="meter"><i style="width:' + pct(x[1], max) + '%"></i></span></li>';
    }).join("") : '<li class="empty">Les secteurs s’afficheront avec les inscriptions.</li>';
  }

  function miniRows(list, right, empty) {
    if (!list.length) return '<li class="empty">' + esc(empty) + "</li>";
    return list.map(function (r) {
      return '<li><button class="who" data-open="' + esc(r.id) + '"><b>' + esc(fullName(r)) + "</b><small>" + esc(sub(r) || r.id) + '</small></button><span class="when">' + esc(right(r)) + "</span></li>";
    }).join("");
  }

  /* ---------- Accueil ---------- */
  function renderEntry() {
    var s = data.stats;
    $("eCount").textContent = s.present;
    $("eCountOf").textContent = (s.present > 1 ? "présents" : "présent") + " sur " + s.expected + " attendus";
    $("eBar").style.width = pct(s.present, s.expected) + "%";
    var arr = arrivals();
    $("entryArrivals").innerHTML = miniRows(arr.slice(0, 8), function (r) { return hhmm(r.checked_in_at); }, "Les arrivées s’afficheront ici.") +
      (arr.length > 8 ? '<li><button class="link" data-show-present>Voir les ' + arr.length + " présents</button></li>" : "");
    renderEntryResults();
  }

  function searchGuests(q, limit) {
    var n = norm(q).trim();
    if (n.length < 2) return [];
    var digits = n.replace(/\D/g, "");
    var words = n.split(/\s+/);
    return data.registrations.filter(function (r) {
      var hay = norm([r.first_name, r.last_name, r.company, r.email, r.id, r.role].join(" "));
      var phone = String(r.phone || "").replace(/\D/g, "");
      if (digits.length >= 4 && phone.indexOf(digits) !== -1) return true;
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    }).sort(function (a, b) {
      var rank = function (r) { return r.status === "paid" ? 0 : r.status === "partner" ? 1 : 2; };
      return rank(a) - rank(b) || String(a.last_name).localeCompare(String(b.last_name), "fr");
    }).slice(0, limit || 8);
  }

  function renderEntryResults() {
    var q = $("entrySearch").value;
    var box = $("entryResults");
    if (norm(q).trim().length < 2) { box.innerHTML = ""; return; }
    var list = searchGuests(q);
    if (!list.length) {
      box.innerHTML = '<li class="empty">Aucun invité ne correspond. Vérifiez l’orthographe, ou ajoutez la personne dans « Invités ».</li>';
      return;
    }
    box.innerHTML = list.map(function (r) {
      var act = "";
      if ((r.status === "paid" || r.status === "partner") && !r.checked_in_at) {
        act = '<button class="btn btn--ok btn--sm act" data-checkin="' + esc(r.id) + '"><svg><use href="#i-check"/></svg>Valider l’entrée</button>';
      } else if (r.checked_in_at) {
        act = '<button class="btn btn--ghost btn--sm act" data-open="' + esc(r.id) + '">Fiche</button>';
      } else if (["pending", "cancelled", "failed"].indexOf(r.status) !== -1) {
        act = '<button class="btn btn--primary btn--sm act" data-onsite="' + esc(r.id) + '">Encaisser 10 €</button>';
      }
      return '<li><div class="who"><b>' + esc(fullName(r)) + "</b><small>" + esc([sub(r), r.id].filter(Boolean).join(" · ")) + "</small></div>" +
        act + '<div class="state">' + statusPills(r) + "</div></li>";
    }).join("");
  }
  $("entrySearch").addEventListener("input", renderEntryResults);

  /* Téléphone : bascule entre la caméra et la recherche par nom */
  $$('input[name="entryMode"]').forEach(function (r) {
    r.addEventListener("change", function () {
      $("entryGrid").setAttribute("data-mode", r.value);
      if (r.value === "search") {
        if (window.matchMedia("(max-width: 959px)").matches) stopCam();
        setTimeout(function () { $("entrySearch").focus(); }, 50);
      }
    });
  });

  function showResult(r) {
    var reg = r.registration;
    var subTxt = reg ? [sub(reg), reg.status !== "partner" ? reg.id : ""].filter(Boolean).join(" · ") : "";
    var k = { ok: "Entrée validée", already: "Déjà entré", refused: "Refusé" }[r.result] || "Erreur";
    setResult(r.result || "refused", k, r.message || "Erreur de vérification.", subTxt);
  }

  function checkin(payload) {
    payload.allowTest = payload.allowTest === true || $("rehearsal").checked;
    setResult("idle", "Vérification…", "Un instant", "");
    return post("/api/gestion/checkin", payload).then(function (r) {
      if (r._status === 401) { showLock(); return r; }
      showResult(r);
      feedback(r.result);
      load();
      return r;
    }).catch(function () {
      setResult("refused", "Réseau", "Pas de connexion internet.", "Réessayez dans un instant, ou cochez la personne sur la liste imprimée.");
      return {};
    });
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-checkin]");
    if (!b) return;
    b.disabled = true;
    checkin({ id: b.getAttribute("data-checkin") }).then(function (r) {
      if (view === "entry" && r.result === "ok") {
        $("entrySearch").value = "";
        renderEntryResults();
        $("entrySearch").focus();
      }
      if (r.result === "ok" && view !== "entry") toast(r.message);
    });
  });

  /* Paiement non finalisé en ligne : la personne règle à l'entrée. */
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-onsite]");
    if (!b) return;
    var r = byId(b.getAttribute("data-onsite"));
    if (!r) return;
    ask("Encaisser 10 € sur place ?", fullName(r) + " n’a pas finalisé son paiement en ligne. Encaissez 10 € (espèces ou carte), puis confirmez : la personne sera inscrite et marquée présente.", "Encaissé, valider l’entrée").then(function (ok) {
      if (!ok) return;
      b.disabled = true;
      post("/api/gestion/guests/status", { id: r.id, action: "pay_onsite" }).then(function (x) {
        if (!x.ok) { b.disabled = false; toast("Action impossible : le paiement a peut-être déjà été confirmé. Actualisez.", "bad"); load(); return; }
        setResult("ok", "Entrée validée", "Bienvenue " + fullName(r) + ".", "Payé sur place · " + r.id);
        feedback("ok");
        $("entrySearch").value = "";
        renderEntryResults();
        load();
      });
    });
  });

  $("partnerForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = $("partnerCode").value.trim();
    if (!code) return;
    checkin({ code: code, name: $("partnerName").value.trim() }).then(function (r) {
      if (r.result === "ok") { $("partnerCode").value = ""; $("partnerName").value = ""; }
    });
  });

  /* ---------- Scanner ---------- */
  var stream = null;
  var scanning = false;
  var busy = false;
  var lastCode = "";
  var lastSeen = 0;

  function setResult(state, k, msg, subTxt) {
    $("result").setAttribute("data-state", state);
    $("resultK").textContent = k;
    $("resultMsg").textContent = msg;
    $("resultSub").textContent = subTxt || "";
  }

  function feedback(state) {
    try { if (navigator.vibrate) navigator.vibrate(state === "ok" ? 80 : [120, 80, 120]); } catch (e) { /* facultatif */ }
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = feedback.ctx || (feedback.ctx = new Ctx());
      var o = ctx.createOscillator(); var g = ctx.createGain();
      o.frequency.value = state === "ok" ? 880 : state === "already" ? 520 : 220;
      g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + (state === "ok" ? 0.12 : 0.3));
    } catch (e) { /* facultatif */ }
  }

  function submitQr(code) {
    if (busy) return;
    busy = true;
    checkin({ qr: code }).then(function () {
      busy = false;
      lastSeen = Date.now(); // réseau lent : le délai repart de la réponse, pas de la lecture
    });
  }

  function tick() {
    if (!scanning) return;
    var video = $("video");
    if (video.readyState === video.HAVE_ENOUGH_DATA && !busy) {
      var canvas = $("canvas");
      var w = video.videoWidth; var h = video.videoHeight;
      var size = Math.min(w, h);
      var target = Math.min(size, 640);
      canvas.width = target; canvas.height = target;
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, (w - size) / 2, (h - size) / 2, size, size, 0, 0, target, target);
      var img = ctx.getImageData(0, 0, target, target);
      var code = window.jsQR ? window.jsQR(img.data, target, target, { inversionAttempts: "dontInvert" }) : null;
      if (code && code.data) {
        // Un QR qui reste devant la caméra n'est vérifié qu'une fois ; il est relu s'il quitte l'image 3 s puis revient.
        var now = Date.now();
        var again = code.data !== lastCode || now - lastSeen > 3000;
        lastCode = code.data; lastSeen = now;
        if (again) submitQr(code.data);
      }
    }
    requestAnimationFrame(tick);
  }

  function startCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setResult("refused", "Caméra", "Caméra non disponible sur cet appareil.", "Utilisez la recherche manuelle.");
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then(function (s) {
      stream = s;
      var video = $("video");
      video.srcObject = s;
      video.setAttribute("playsinline", "");
      video.play();
      $("startCam").hidden = true;
      $("stopCam").hidden = false;
      scanning = true;
      setResult("idle", "Caméra active", "Présentez le QR code de l’invitation dans le cadre.", "");
      requestAnimationFrame(tick);
    }).catch(function () {
      setResult("refused", "Caméra", "Accès à la caméra refusé.", "Autorisez la caméra dans le navigateur, ou utilisez la recherche manuelle.");
    });
  }
  function stopCam() {
    scanning = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    if ($("video")) $("video").srcObject = null;
    $("startCam").hidden = false;
    $("stopCam").hidden = true;
  }
  $("startCam").addEventListener("click", startCam);
  $("stopCam").addEventListener("click", stopCam);
  document.addEventListener("visibilitychange", function () { if (document.hidden) stopCam(); });

  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-show-present]")) return;
    filter = "present"; sortBy = "arrival"; $("sort").value = "arrival"; shown = PAGE;
    setView("guests");
    renderGuests();
  });

  /* ---------- Invités ---------- */
  var FILTERS = [
    ["paid", "Payés", function (r) { return r.status === "paid"; }],
    ["upcoming", "Pas encore arrivés", function (r) { return r.status === "paid" && !r.checked_in_at; }],
    ["present", "Arrivés", function (r) { return r.checked_in_at && (r.status === "paid" || r.status === "partner"); }],
    ["pending", "Paiement en attente", function (r) { return r.status === "pending"; }],
    ["partner", "Partenaires", function (r) { return r.status === "partner"; }],
    ["closed", "Annulés", function (r) { return ["cancelled", "failed", "review"].indexOf(r.status) !== -1; }],
    ["all", "Tous", function () { return true; }],
  ];

  /* Ligne compacte : seules les situations particulières ont une étiquette (« Payé » est le cas normal). */
  function rowStatus(r) {
    var t = [];
    if (r.test) t.push('<span class="pill pill--bad">Test</span>');
    if (r.status === "paid" && r.source === "onsite") t.push('<span class="pill pill--gold">Sur place</span>');
    if (r.status === "paid" && r.source === "free") t.push('<span class="pill pill--gold">Invité</span>');
    if (r.status === "partner") t.push('<span class="pill pill--gold">Partenaire</span>');
    if (r.status === "pending") t.push('<span class="pill pill--warn">En attente</span>');
    if (["cancelled", "failed", "review"].indexOf(r.status) !== -1) {
      t.push('<span class="pill pill--bad">' + esc({ cancelled: "Annulé", failed: "Refusé", review: "À vérifier" }[r.status]) + "</span>");
    }
    if (r.status === "paid" && r.confirmation_error) t.push('<span class="pill pill--bad">E-mail en échec</span>');
    if (r.checked_in_at) t.push('<span class="arr"><svg><use href="#i-check"/></svg>' + esc(hhmm(r.checked_in_at)) + "</span>");
    else if (r.status === "paid" || r.status === "partner") t.push('<span class="todo">À venir</span>');
    return t.join("");
  }

  function sortList(list) {
    var by = {
      name: function (a, b) { return nameKey(a).localeCompare(nameKey(b), "fr") || norm(a.first_name).localeCompare(norm(b.first_name), "fr"); },
      arrival: function (a, b) { return String(b.checked_in_at || "").localeCompare(String(a.checked_in_at || "")); },
      recent: function (a, b) { return String(b.paid_at || b.created_at).localeCompare(String(a.paid_at || a.created_at)); },
      company: function (a, b) { return norm(a.company || "~").localeCompare(norm(b.company || "~"), "fr"); },
    }[sortBy];
    return list.slice().sort(by);
  }

  /* Clé de tri du nom, sans particule : « de La Rochefoucauld » est rangé à R. */
  function nameKey(r) {
    return norm(r.last_name || r.first_name).replace(/^((de|du|des|le|la|les)\s+|(l|d)['’]\s*)+/, "").trim();
  }
  function letterOf(r) {
    var c = nameKey(r).charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : "#";
  }

  function renderGuests() {
    $("filters").innerHTML = FILTERS.map(function (f) {
      var n = data.registrations.filter(f[2]).length;
      return '<button class="chip" role="tab" data-filter="' + f[0] + '" aria-selected="' + (filter === f[0]) + '">' + esc(f[1]) + " <b>" + n + "</b></button>";
    }).join("");
    var test = FILTERS.filter(function (f) { return f[0] === filter; })[0][2];
    var q = norm($("search").value).trim();
    var words = q ? q.split(/\s+/) : [];
    var digits = q.replace(/\D/g, "");
    var list = data.registrations.filter(test).filter(function (r) {
      if (!words.length) return true;
      var hay = norm([r.first_name, r.last_name, r.company, r.email, r.id, r.role, r.sector].join(" "));
      var phone = String(r.phone || "").replace(/\D/g, "");
      return (digits.length >= 4 && phone.indexOf(digits) !== -1) || words.every(function (w) { return hay.indexOf(w) !== -1; });
    });
    list = sortList(list);
    var total = list.length;
    var visible = list.slice(0, shown);
    var lastLetter = "";
    $("listCount").innerHTML = "<b>" + total + "</b> " + (total > 1 ? "invités" : "invité") + (q ? " trouvés" : "");
    $("rows").innerHTML = total ? visible.map(function (r) {
      var head = "";
      if (sortBy === "name") {
        var L = letterOf(r);
        if (L !== lastLetter) { head = '<div class="letter" role="presentation">' + L + "</div>"; lastLetter = L; }
      }
      return head + '<button class="tr" role="row" data-open="' + esc(r.id) + '">' +
        '<span class="c-name" role="cell"><b>' + esc(fullName(r)) + "</b><small>" + esc(r.id) + "</small></span>" +
        '<span class="c-co" role="cell">' + esc(r.company || "—") + '<span class="c-ref"> · ' + esc(r.id) + "</span><small>" + esc(r.role) + "</small></span>" +
        '<span class="c-contact" role="cell"><span>' + esc(r.email || "—") + "</span><small>" + esc(r.phone) + "</small></span>" +
        '<span class="c-status" role="cell">' + rowStatus(r) + "</span></button>";
    }).join("") : '<p class="rows-empty">Aucun invité pour ce filtre.</p>';
    var rest = total - visible.length;
    $("more").hidden = rest <= 0;
    $("more").textContent = "Afficher " + Math.min(PAGE, rest) + " de plus (" + rest + " restant" + (rest > 1 ? "s" : "") + ")";
  }
  $("more").addEventListener("click", function () { shown += PAGE; renderGuests(); });
  $("sort").addEventListener("change", function () { sortBy = this.value; shown = PAGE; renderGuests(); });
  $("filters").addEventListener("click", function (e) {
    var c = e.target.closest("[data-filter]");
    if (!c) return;
    filter = c.getAttribute("data-filter");
    shown = PAGE;
    if (filter === "present" && sortBy === "name") { sortBy = "arrival"; $("sort").value = "arrival"; }
    renderGuests();
  });
  $("search").addEventListener("input", function () { shown = PAGE; renderGuests(); });

  /* ---------- Fiche invité ---------- */
  function openDrawer(id) {
    openId = id;
    editing = false;
    renderDrawer();
    $("drawer").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeDrawers() {
    openId = null; editing = false;
    $("drawer").hidden = true;
    $("addDrawer").hidden = true;
    $("partnerDrawer").hidden = true;
    $("nlDrawer").hidden = true;
    document.body.style.overflow = "";
  }
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-close]")) { closeDrawers(); return; }
    var o = e.target.closest("[data-open]");
    if (o) openDrawer(o.getAttribute("data-open"));
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && (openId || !$("addDrawer").hidden || !$("partnerDrawer").hidden || !$("nlDrawer").hidden)) closeDrawers(); });

  function kv(rows) {
    var list = rows.filter(function (x) { return x[1]; });
    if (!list.length) return "";
    return '<dl class="kv">' + list.map(function (x) { return "<div><dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd></div>"; }).join("") + "</dl>";
  }

  function sectorOptions(current) {
    var list = (data.sectors || []).slice();
    if (current && list.indexOf(current) === -1) list.push(current);
    return '<option value="">—</option>' + list.map(function (s) {
      return '<option' + (s === current ? " selected" : "") + ">" + esc(s) + "</option>";
    }).join("");
  }

  function renderDrawer() {
    var r = byId(openId);
    if (!r) { closeDrawers(); return; }
    $("dTitle").textContent = fullName(r);
    $("dSub").textContent = [sub(r), r.id].filter(Boolean).join(" · ");
    if (editing) { $("dBody").innerHTML = editForm(r); return; }

    var actions = [];
    if (r.status === "paid" || r.status === "partner") {
      actions.push(r.checked_in_at
        ? '<button class="btn btn--ghost btn--sm" data-act="undo">Annuler l’arrivée</button>'
        : '<button class="btn btn--ok btn--sm" data-act="in"><svg><use href="#i-check"/></svg>Marquer présent</button>');
    }
    if (r.status === "paid" && r.email) actions.push('<button class="btn btn--ghost btn--sm" data-act="resend">Renvoyer l’invitation</button>');
    actions.push('<button class="btn btn--ghost btn--sm" data-act="edit">Modifier</button>');
    if (r.status === "paid") actions.push('<button class="btn btn--ghost btn--sm btn--danger" data-act="cancel">Annuler l’inscription</button>');
    if (r.status === "cancelled" && r.paid_at) actions.push('<button class="btn btn--ghost btn--sm" data-act="restore">Rétablir l’inscription</button>');
    if (["pending", "cancelled", "failed"].indexOf(r.status) !== -1) actions.unshift('<button class="btn btn--primary btn--sm" data-onsite="' + esc(r.id) + '">Encaisser 10 € sur place</button>');

    var contact = [];
    if (r.email) contact.push('<a href="mailto:' + esc(r.email) + '">' + esc(r.email) + "</a>");
    if (r.phone) contact.push('<a href="' + esc(telHref(r.phone)) + '">' + esc(r.phone) + "</a>");

    var invitation = r.confirmation_error ? "Échec : " + r.confirmation_error
      : r.confirmation_sent_at ? "Envoyée le " + day(r.confirmation_sent_at) : (r.status === "paid" ? "Pas encore envoyée" : "");
    var origin = { onsite: "Ajouté sur place (payé 10 €)", free: "Invité gratuit", partner: "Invitation partenaire", online: "Inscription en ligne" }[r.source];
    var msgs = (r.messages || []).map(function (m) { return m.subject + " (" + day(m.at) + ")"; }).join("\n");

    $("dBody").innerHTML =
      '<section class="d-section"><div class="d-tags">' + statusPills(r) + '</div><div class="d-actions">' + actions.join("") + "</div></section>" +
      (contact.length ? '<section class="d-section"><h3>Contact</h3><div class="d-contact">' + contact.join("") + "</div></section>" : "") +
      '<section class="d-section"><h3>Profil</h3>' + (kv([
        ["Entreprise", r.company], ["Fonction", r.role], ["Secteur", r.sector], ["Activité", r.activity],
        ["Site / LinkedIn", r.website], ["Recherche", r.looking], ["Peut apporter", r.offer],
      ]) || '<p class="hint">Aucune information.</p>') + "</section>" +
      '<section class="d-section"><h3>Suivi</h3>' + kv([
        ["Référence", r.id], ["Origine", origin], ["Inscrit le", day(r.created_at)], ["Payé le", day(r.paid_at)],
        ["Arrivée", r.checked_in_at ? hhmm(r.checked_in_at) + (r.checked_in_via === "qr" ? " (QR code)" : " (manuelle)") : ""],
        ["Invitation e-mail", invitation], ["Rappel de la veille", r.reminder_sent_at ? "Envoyé le " + day(r.reminder_sent_at) : ""],
        ["Messages reçus", msgs],
      ]) + "</section>" +
      '<section class="d-section"><h3>Note interne</h3><textarea class="input" id="dNote" rows="3" placeholder="Visible uniquement dans le back-office">' + esc(r.note) + '</textarea>' +
      '<div class="d-actions"><button class="btn btn--ghost btn--sm" data-act="note">Enregistrer la note</button></div></section>';
  }

  function editForm(r) {
    var f = function (name, label, type) {
      return '<label class="field"><span class="field-label">' + label + '</span><input class="input" name="' + name + '" type="' + (type || "text") + '" value="' + esc(r[name]) + '"><span class="field-err"></span></label>';
    };
    return '<form class="stack" id="editForm" novalidate>' +
      '<div class="row-2">' + f("first_name", "Prénom") + f("last_name", "Nom") + "</div>" +
      f("email", "E-mail", "email") + f("phone", "Téléphone", "tel") +
      '<div class="row-2">' + f("company", "Entreprise") + f("role", "Fonction") + "</div>" +
      '<label class="field"><span class="field-label">Secteur</span><select class="input" name="sector">' + sectorOptions(r.sector) + "</select></label>" +
      '<label class="field"><span class="field-label">Note interne</span><textarea class="input" name="note" rows="3">' + esc(r.note) + "</textarea></label>" +
      '<p class="form-error" id="editError" hidden></p>' +
      '<div class="card-actions"><button class="btn btn--primary" type="submit">Enregistrer</button><button class="btn btn--ghost" type="button" data-act="view">Annuler</button></div></form>';
  }

  function showFieldErrors(form, fields) {
    $$(".field", form).forEach(function (f) { f.classList.remove("invalid"); var e = f.querySelector(".field-err"); if (e) e.textContent = ""; });
    Object.keys(fields || {}).forEach(function (k) {
      var input = form.querySelector('[name="' + k + '"]');
      if (!input) return;
      var field = input.closest(".field");
      field.classList.add("invalid");
      var e = field.querySelector(".field-err");
      if (e) e.textContent = fields[k] === "required" ? "Champ requis." : (k === "email" ? "Adresse e-mail invalide." : "Valeur invalide.");
    });
  }

  $("dBody").addEventListener("submit", function (e) {
    if (e.target.id !== "editForm") return;
    e.preventDefault();
    var form = e.target;
    var body = Object.fromEntries(new FormData(form).entries());
    body.id = openId;
    post("/api/gestion/guests/update", body).then(function (r) {
      if (r.error === "invalid_fields") { showFieldErrors(form, r.fields); return; }
      if (!r.ok) { $("editError").hidden = false; $("editError").textContent = "Enregistrement impossible."; return; }
      editing = false;
      toast("Fiche mise à jour");
      load();
    });
  });

  $("dBody").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var act = b.getAttribute("data-act");
    var r = byId(openId);
    if (!r) return;
    if (act === "edit") { editing = true; renderDrawer(); return; }
    if (act === "view") { editing = false; renderDrawer(); return; }
    b.disabled = true;
    var done = function () { b.disabled = false; };
    if (act === "in") {
      checkin({ id: r.id, allowTest: r.test }).then(function (x) { done(); toast(x.message || "Vérifié", x.result === "ok" ? "" : "bad"); });
    } else if (act === "undo") {
      ask("Annuler l’arrivée ?", fullName(r) + " sera de nouveau compté(e) comme « pas encore arrivé(e) ».", "Annuler l’arrivée").then(function (ok) {
        if (!ok) return done();
        post("/api/gestion/checkin/undo", { id: r.id }).then(function () { done(); toast("Arrivée annulée"); load(); });
      });
    } else if (act === "resend") {
      ask("Renvoyer l’invitation ?", "L’invitation avec QR code sera renvoyée à " + r.email + ".", "Renvoyer").then(function (ok) {
        if (!ok) return done();
        post("/api/gestion/resend", { id: r.id }).then(function (x) {
          done();
          toast(x.ok ? (x.via === "outbox" ? "Invitation de test déposée dans la boîte d’envoi du Studio" : "Invitation renvoyée") : "Échec de l’envoi", x.ok ? "" : "bad");
          load();
        });
      });
    } else if (act === "cancel") {
      ask("Annuler l’inscription ?", "La place de " + fullName(r) + " sera libérée et son QR code refusé à l’entrée. Un éventuel remboursement se fait dans CAWL.", "Annuler l’inscription").then(function (ok) {
        if (!ok) return done();
        post("/api/gestion/guests/status", { id: r.id, action: "cancel" }).then(function (x) { done(); toast(x.ok ? "Inscription annulée" : "Action impossible", x.ok ? "" : "bad"); load(); });
      });
    } else if (act === "restore") {
      post("/api/gestion/guests/status", { id: r.id, action: "restore" }).then(function (x) { done(); toast(x.ok ? "Inscription rétablie" : "Action impossible", x.ok ? "" : "bad"); load(); });
    } else if (act === "note") {
      post("/api/gestion/guests/update", { id: r.id, note: $("dNote").value }).then(function (x) { done(); toast(x.ok ? "Note enregistrée" : "Échec", x.ok ? "" : "bad"); load(); });
    }
  });

  /* ---------- Ajout d'un invité ---------- */
  $("addGuest").addEventListener("click", function () {
    var form = $("addForm");
    form.reset();
    showFieldErrors(form, {});
    $("addError").hidden = true;
    form.querySelector("[data-sectors]").innerHTML = sectorOptions("");
    form.querySelector('[name="checkin"]').checked = todayParis() === EVENT_DAY;
    $("addDrawer").hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(function () { form.querySelector('[name="first_name"]').focus(); }, 60);
  });

  function submitAdd(force) {
    var form = $("addForm");
    var fd = new FormData(form);
    var body = Object.fromEntries(fd.entries());
    body.checkin = form.querySelector('[name="checkin"]').checked;
    body.send = form.querySelector('[name="send"]').checked;
    body.force = Boolean(force);
    $("addError").hidden = true;
    post("/api/gestion/guests", body).then(function (r) {
      if (r.error === "invalid_fields") { showFieldErrors(form, r.fields); return; }
      if (r.error === "already_registered" || r.error === "full") {
        var txt = r.error === "full"
          ? "Les " + r.max + " places sont toutes prises. Ajouter quand même cette personne ?"
          : "Une inscription payée existe déjà avec cette adresse e-mail. Ajouter quand même ?";
        ask("Confirmer l’ajout", txt, "Ajouter quand même").then(function (ok) { if (ok) submitAdd(true); });
        return;
      }
      if (!r.ok) { $("addError").hidden = false; $("addError").textContent = "Ajout impossible. Réessayez."; return; }
      closeDrawers();
      var reg = r.registration;
      var mail = r.email ? (r.email.error ? " · e-mail non envoyé" : " · invitation envoyée") : "";
      toast(fullName(reg) + " ajouté" + (reg.checked_in_at ? " et marqué présent" : "") + mail, r.email && r.email.error ? "bad" : "");
      load();
    });
  }
  $("addForm").addEventListener("submit", function (e) { e.preventDefault(); submitAdd(false); });

  /* ---------- Impressions ---------- */
  function guestsForPrint() {
    return data.registrations.filter(function (r) { return r.status === "paid" || r.status === "partner"; })
      .sort(function (a, b) { return String(a.last_name).localeCompare(String(b.last_name), "fr"); });
  }
  function printNow(html) {
    $("printArea").innerHTML = html;
    window.print();
  }
  $("printList").addEventListener("click", function () {
    var list = guestsForPrint();
    printNow("<h2>Business Club · Rencontre Entrepreneurs — liste d’accueil</h2>" +
      "<p>" + list.length + " personnes · imprimée le " + esc(day(new Date().toISOString())) + "</p>" +
      "<table><thead><tr><th></th><th>Nom</th><th>Entreprise</th><th>Téléphone</th><th>Référence</th></tr></thead><tbody>" +
      list.map(function (r) {
        return '<tr><td class="box"><span></span></td><td><b>' + esc(String(r.last_name).toUpperCase()) + "</b> " + esc(r.first_name) + "</td><td>" +
          esc(sub(r)) + "</td><td>" + esc(r.phone) + "</td><td>" + esc(r.id) + "</td></tr>";
      }).join("") + "</tbody></table>");
  });
  $("printBadges").addEventListener("click", function () {
    var list = guestsForPrint().filter(function (r) { return r.status === "paid" || r.first_name !== "Invité partenaire"; });
    if (!list.length) { toast("Aucun invité à imprimer pour l’instant", "bad"); return; }
    printNow('<div class="badges">' + list.map(function (r) {
      return '<div class="badge"><span class="ev">Business Club · 4 décembre 2026</span><span class="nm">' + esc(fullName(r)) +
        '</span><span class="co">' + esc(sub(r)) + '</span><span class="se">' + esc(r.sector) + "</span></div>";
    }).join("") + "</div>");
  });

  /* ---------- E-mails ---------- */
  function renderMail() {
    var s = data.stats;
    var failed = paidList().filter(function (r) { return r.confirmation_error; });
    $("invPill").className = "pill " + (failed.length ? "pill--bad" : "pill--ok");
    $("invPill").textContent = (s.invitations_sent || 0) + " / " + s.paid + " envoyées";
    $("invText").textContent = failed.length
      ? plural(failed.length, "invitation n’a", "invitations n’ont") + " pas pu partir. Vérifiez l’adresse dans la fiche, puis renvoyez."
      : "Chaque inscrit reçoit automatiquement son invitation avec QR code dès que son paiement est confirmé.";
    $("invFailed").innerHTML = failed.slice(0, 6).map(function (r) {
      return '<li><button class="who" data-open="' + esc(r.id) + '"><b>' + esc(fullName(r)) + "</b><small>" + esc(r.email) + " · " + esc(r.confirmation_error) + "</small></button>" +
        '<button class="btn btn--ghost btn--sm" data-resend="' + esc(r.id) + '">Renvoyer</button></li>';
    }).join("") + (failed.length > 6 ? '<li class="empty">et ' + (failed.length - 6) + " autres : filtre « Payés », étiquette « E-mail en échec »</li>" : "");
    $("resendFailed").hidden = failed.length < 2;

    var w = data.reminders || {};
    var before = w.today && w.sends_on && w.today < w.sends_on;
    var target = s.reminders_target || s.paid;
    $("remPill").className = "pill " + (before ? "" : (s.reminders_sent >= target ? "pill--ok" : "pill--warn"));
    $("remPill").textContent = (s.reminders_sent || 0) + " / " + target + " envoyés";
    $("remText").textContent = before
      ? "Envoi automatique le 3 décembre vers 10 h aux inscrits payés et aux partenaires invités par e-mail, avec deux nouveaux essais à 14 h et 18 h. Le bouton ci-dessous ne sert qu’en secours, la veille ou le jour même."
      : "Chaque invité (inscrits payés et partenaires ayant une adresse e-mail) ne reçoit le rappel qu’une fois. Le bouton l’envoie à ceux qui ne l’ont pas encore reçu.";
    $("sendReminders").disabled = Boolean(before);

    var sel = $("msgAudience");
    var current = sel.value || "everyone";
    sel.innerHTML = Object.keys(data.audiences || {}).map(function (k) {
      var a = data.audiences[k];
      return '<option value="' + k + '"' + (k === current ? " selected" : "") + ">" + esc(a.label) + " (" + a.count + ")</option>";
    }).join("");
    updateSendLabel();

    renderPartners();

    var groups = {};
    data.registrations.forEach(function (r) {
      (r.messages || []).forEach(function (m) {
        var g = groups[m.id] || (groups[m.id] = { subject: m.subject, at: m.at, n: 0 });
        g.n += 1;
        if (m.at > g.at) g.at = m.at;
      });
    });
    var hist = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
    $("msgHistory").innerHTML = hist.length ? hist.map(function (g) {
      return '<li><div class="who"><b>' + esc(g.subject) + "</b><small>" + plural(g.n, "destinataire", "destinataires") + '</small></div><span class="when">' + esc(day(g.at)) + "</span></li>";
    }).join("") : '<li class="empty">Aucun message envoyé depuis le back-office.</li>';
  }

  /* ---------- Invitations partenaires ---------- */
  var partnerN = null;
  function partnerName(p) { return [p.first_name, p.last_name].filter(Boolean).join(" "); }
  function renderPartners() {
    var list = data.partners || [];
    var sent = list.filter(function (p) { return p.sent_at; }).length;
    $("partPill").textContent = sent + " / " + list.length + " envoyées";
    $("partPill").className = "pill " + (sent ? "pill--ok" : "");
    $("partnerList").innerHTML = list.map(function (p) {
      var st = [];
      if (p.checked_in_at) st.push('<span class="pill pill--ok">Arrivé ' + esc(hhmm(p.checked_in_at)) + "</span>");
      if (p.error) st.push('<span class="pill pill--bad">Envoi en échec</span>');
      else if (p.sent_at) st.push('<span class="pill pill--gold">Envoyée le ' + esc(day(p.sent_at)) + "</span>");
      else if (p.first_name && !p.email) st.push('<span class="pill">Sans e-mail</span>');
      else if (p.first_name) st.push('<span class="pill pill--warn">Pas encore envoyée</span>');
      var label = !p.first_name ? "Attribuer" : (p.email && !p.sent_at ? "Envoyer" : "Modifier");
      return '<li><span class="code">' + esc(p.code.replace("BC-", "")) + '</span><div class="who">' +
        (p.first_name ? "<b>" + esc(partnerName(p)) + "</b><small>" + esc([p.company, p.email].filter(Boolean).join(" · ")) + "</small>"
          : '<b class="free">Non attribué</b><small>Disponible</small>') +
        '</div><button class="btn btn--' + (label === "Modifier" ? "ghost" : "primary") + ' btn--sm act" data-partner="' + p.n + '">' + label + "</button>" +
        (st.length ? '<div class="st">' + st.join("") + "</div>" : "") + "</li>";
    }).join("");
  }

  function openPartner(n) {
    var p = (data.partners || []).filter(function (x) { return x.n === n; })[0];
    if (!p) return;
    partnerN = n;
    var f = $("partnerEdit");
    showFieldErrors(f, {});
    $("pError").hidden = true;
    ["first_name", "last_name", "email", "company", "role"].forEach(function (k) { f.elements[k].value = p[k] || ""; });
    $("pTitle").textContent = p.first_name ? partnerName(p) : "Invitation partenaire";
    $("pSub").textContent = p.code + " · déjeuner offert";
    $("pState").textContent = p.checked_in_at ? "Déjà utilisée à l’entrée à " + hhmm(p.checked_in_at) + "."
      : p.sent_at ? "Invitation envoyée le " + day(p.sent_at) + (p.email ? " à " + p.email : "") + ". Renvoyer l’envoie de nouveau."
      : "Le partenaire recevra une invitation nominative avec QR code, valable pour une entrée.";
    $("pSend").textContent = p.sent_at ? "Enregistrer et renvoyer l’invitation" : "Enregistrer et envoyer l’invitation";
    $("pClear").hidden = !p.first_name || Boolean(p.checked_in_at);
    $("partnerDrawer").hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(function () { f.elements.first_name.focus(); }, 60);
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-partner]");
    if (b) openPartner(Number(b.getAttribute("data-partner")));
  });

  $("partnerEdit").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var send = e.submitter && e.submitter.getAttribute("data-send") === "1";
    var body = Object.fromEntries(new FormData(f).entries());
    body.n = partnerN;
    if (send && !body.email.trim()) { showFieldErrors(f, { email: "required" }); return; }
    $("pError").hidden = true;
    post("/api/gestion/partners", body).then(function (r) {
      if (r.error === "invalid_fields") { showFieldErrors(f, r.fields); return; }
      if (!r.ok) { $("pError").hidden = false; $("pError").textContent = "Enregistrement impossible."; return; }
      if (!send) { closeDrawers(); toast("Code attribué"); load(); return; }
      post("/api/gestion/partners/send", { n: partnerN }).then(function (x) {
        closeDrawers();
        toast(x.ok ? "Invitation envoyée à " + body.email.trim() : "Échec de l’envoi : vérifiez l’adresse", x.ok ? "" : "bad");
        load();
      });
    });
  });

  $("pClear").addEventListener("click", function () {
    ask("Libérer ce code ?", "Le nom et l’e-mail associés seront effacés. Une invitation déjà envoyée ne sera plus valable à l’entrée.", "Libérer le code").then(function (ok) {
      if (!ok) return;
      post("/api/gestion/partners/clear", { n: partnerN }).then(function (r) {
        closeDrawers();
        toast(r.ok ? "Code libéré" : "Ce code a déjà servi à l’entrée", r.ok ? "" : "bad");
        load();
      });
    });
  });

  /* ---------- Newsletter (campagne Brevo) ---------- */
  var nl = { lists: [], loaded: false };
  function nlError(msg) { $("nlError").hidden = !msg; $("nlError").textContent = msg || ""; }
  function nlSelected() {
    return $$("#nlLists input:checked").map(function (i) { return Number(i.value); });
  }
  function nlUpdateSend() {
    var ids = nlSelected();
    var total = nl.lists.filter(function (l) { return ids.indexOf(l.id) !== -1; }).reduce(function (s, l) { return s + (l.count || 0); }, 0);
    $("nlSend").disabled = !ids.length;
    $("nlSend").textContent = ids.length ? "Envoyer la newsletter (" + plural(total, "contact", "contacts") + ")" : "Envoyer la newsletter";
  }
  function nlRenderLists(keep) {
    var checked = keep || nlSelected();
    $("nlLists").innerHTML = nl.lists.length ? nl.lists.map(function (l) {
      return '<li><label><input type="checkbox" value="' + l.id + '"' + (checked.indexOf(l.id) !== -1 ? " checked" : "") + '><span class="nm">' + esc(l.name) +
        '</span><span class="n">' + plural(l.count || 0, "contact", "contacts") + "</span></label></li>";
    }).join("") : '<li class="hint">Aucune liste. Créez-en une ci-dessous.</li>';
    var cur = $("nlAddList").value;
    $("nlAddList").innerHTML = nl.lists.map(function (l) { return '<option value="' + l.id + '">' + esc(l.name) + "</option>"; }).join("");
    if (cur) $("nlAddList").value = cur;
    nlUpdateSend();
  }
  function nlRenderCampaigns(list) {
    $("nlCampaigns").innerHTML = (list && list.length) ? list.map(function (c) {
      var st = c.status === "sent" ? (c.sent != null ? plural(c.sent, "envoi", "envois") + (c.opens != null ? " · " + c.opens + " ouvertures" : "") + (c.clicks != null ? " · " + c.clicks + " clics" : "") : "Envoyée")
        : ({ queued: "En cours d’envoi", in_process: "En cours d’envoi", draft: "Brouillon" }[c.status] || c.status);
      return '<li><div class="who"><b>' + esc(c.subject || c.name) + "</b><small>" + esc(st) + '</small></div><span class="when">' + esc(c.sentDate ? day(c.sentDate) : "") + "</span></li>";
    }).join("") : '<li class="empty">Aucune newsletter envoyée depuis le back-office.</li>';
  }
  function nlLoad() {
    return api("/api/gestion/newsletter").then(function (r) {
      if (r.error === "brevo_not_configured") { nlError("Brevo n’est pas configuré sur ce site : la newsletter ne peut pas partir d’ici."); $("nlBody").hidden = true; return; }
      if (!r.ok) { nlError("Brevo ne répond pas pour le moment. Réessayez dans un instant."); return; }
      nlError("");
      nl.lists = r.lists || [];
      if (!nl.loaded && r.subject) $("nlSubject").value = r.subject;
      nl.loaded = true;
      $("nlPill").textContent = plural(nl.lists.length, "liste", "listes");
      nlRenderLists();
      nlRenderCampaigns(r.campaigns);
    });
  }
  $("nlLists").addEventListener("change", nlUpdateSend);

  $("nlNewList").addEventListener("submit", function (e) {
    e.preventDefault();
    var name = $("nlNewName").value.trim();
    if (!name) return;
    post("/api/gestion/newsletter/lists", { name: name }).then(function (r) {
      if (!r.ok) { toast("Création impossible : " + (r.message || "réessayez"), "bad"); return; }
      $("nlNewName").value = "";
      nl.lists.unshift(r.list);
      nlRenderLists(nlSelected().concat([r.list.id]));
      $("nlAddList").value = String(r.list.id);
      toast("Liste « " + r.list.name + " » créée");
    });
  });

  $("nlAdd").addEventListener("submit", function (e) {
    e.preventDefault();
    var listId = Number($("nlAddList").value);
    var lines = $("nlAddLines").value.trim();
    if (!listId) { toast("Créez ou choisissez d’abord une liste", "bad"); return; }
    if (!lines) { toast("Saisissez au moins une adresse e-mail", "bad"); return; }
    var btn = e.target.querySelector("button");
    btn.disabled = true;
    var tot = { created: 0, updated: 0, invalid: [], failed: [] };
    $("nlAddStatus").textContent = "Ajout en cours…";
    (function run(text) {
      post("/api/gestion/newsletter/contacts", { listId: listId, lines: text }).then(function (r) {
        if (!r.ok) { btn.disabled = false; $("nlAddStatus").textContent = "Échec : " + (r.message || "réessayez"); return; }
        tot.created += r.created; tot.updated += r.updated; tot.invalid = tot.invalid.concat(r.invalid); tot.failed = tot.failed.concat(r.failed);
        if (r.remaining && r.remaining.length) { run(r.remaining.join("\n")); return; }
        btn.disabled = false;
        var parts = [plural(tot.created + tot.updated, "contact ajouté", "contacts ajoutés")];
        if (tot.updated) parts.push("dont " + tot.updated + " déjà connu" + (tot.updated > 1 ? "s" : "") + " de Brevo");
        if (tot.invalid.length) parts.push(tot.invalid.length + " ligne" + (tot.invalid.length > 1 ? "s" : "") + " sans adresse valide");
        if (tot.failed.length) parts.push(tot.failed.length + " refusé" + (tot.failed.length > 1 ? "s" : "") + " par Brevo");
        $("nlAddStatus").textContent = parts.join(", ") + ".";
        $("nlAddLines").value = tot.invalid.concat(tot.failed.map(function (f) { return f.line; })).join("\n");
        nlLoad();
      }).catch(function () { btn.disabled = false; $("nlAddStatus").textContent = "Connexion perdue. Réessayez."; });
    })(lines);
  });

  $("nlPreviewBtn").addEventListener("click", function () {
    api("/api/gestion/newsletter/preview").then(function (r) {
      if (!r.ok) return;
      $("nlFrame").srcdoc = r.html;
      $("nlDTitle").textContent = $("nlSubject").value.trim() || r.subject;
      $("nlDrawer").hidden = false;
      document.body.style.overflow = "hidden";
    });
  });

  $("nlTest").addEventListener("click", function () {
    var to = $("nlTestTo").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) { toast("Adresse d’essai invalide", "bad"); return; }
    var btn = this;
    btn.disabled = true;
    post("/api/gestion/newsletter/test", { to: to, subject: $("nlSubject").value.trim() }).then(function (r) {
      btn.disabled = false;
      toast(r.ok ? "Essai envoyé à " + to : "Échec de l’essai : " + (r.message || "réessayez"), r.ok ? "" : "bad");
    });
  });

  $("nlSend").addEventListener("click", function () {
    var ids = nlSelected();
    var subject = $("nlSubject").value.trim();
    if (!ids.length) return;
    if (!subject) { toast("Écrivez l’objet de l’e-mail", "bad"); return; }
    var names = nl.lists.filter(function (l) { return ids.indexOf(l.id) !== -1; }).map(function (l) { return "« " + l.name + " »"; }).join(", ");
    ask("Envoyer la newsletter ?", "« " + subject + " » partira maintenant aux contacts de " + names + ". Une personne présente dans plusieurs listes ne la reçoit qu’une fois. Cet envoi ne peut pas être annulé.", "Envoyer maintenant").then(function (ok) {
      if (!ok) return;
      $("nlSend").disabled = true;
      $("nlSendStatus").textContent = "Envoi en cours…";
      post("/api/gestion/newsletter/send", { listIds: ids, subject: subject }).then(function (r) {
        $("nlSendStatus").textContent = r.ok ? "Newsletter envoyée. Brevo la distribue dans les minutes qui viennent." : "Échec : " + (r.message || "réessayez");
        toast(r.ok ? "Newsletter envoyée" : "Échec de l’envoi", r.ok ? "" : "bad");
        $$("#nlLists input:checked").forEach(function (i) { i.checked = false; });
        nlUpdateSend();
        nlLoad();
      });
    });
  });

  function resendOne(id) {
    return post("/api/gestion/resend", { id: id });
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-resend]");
    if (!b) return;
    b.disabled = true;
    resendOne(b.getAttribute("data-resend")).then(function (x) { toast(x.ok ? "Invitation renvoyée" : "Échec de l’envoi", x.ok ? "" : "bad"); load(); });
  });
  $("resendFailed").addEventListener("click", function () {
    var ids = paidList().filter(function (r) { return r.confirmation_error; }).map(function (r) { return r.id; });
    var btn = this;
    ask("Renvoyer " + plural(ids.length, "invitation", "invitations") + " ?", "Les invitations en échec seront renvoyées une par une.", "Renvoyer").then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      var okCount = 0;
      ids.reduce(function (p, id) {
        return p.then(function () { return resendOne(id).then(function (x) { if (x.ok) okCount += 1; }); });
      }, Promise.resolve()).then(function () {
        btn.disabled = false;
        toast(okCount + " / " + ids.length + " invitations renvoyées", okCount === ids.length ? "" : "bad");
        load();
      });
    });
  });

  $("sendReminders").addEventListener("click", function () {
    var btn = this;
    ask("Envoyer les rappels maintenant ?", "Le rappel « C’est demain » part à tous les invités (inscrits payés et partenaires) qui ne l’ont pas encore reçu.", "Envoyer").then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      post("/api/gestion/reminders").then(function (r) {
        btn.disabled = false;
        if (r.error === "too_early") { toast("Les rappels ne partent que la veille ou le jour même", "bad"); return; }
        if (!r.ok) { toast("Échec de l’envoi, réessayez", "bad"); return; }
        toast(r.sent + " rappel(s) envoyé(s)" + (r.failed ? ", " + r.failed + " en échec" : "") + (r.remaining ? ", " + r.remaining + " restant(s) : cliquez à nouveau" : ""), r.failed ? "bad" : "");
        load();
      });
    });
  });

  /* Composition d'un message */
  var TEMPLATES = {
    infos: {
      audience: "everyone", invite: true,
      subject: "Infos pratiques · Rencontre Entrepreneurs du 4 décembre",
      body: "Bonjour {prenom},\n\nNous avons hâte de vous accueillir vendredi 4 décembre au Boxing Center, 61 route d’Espagne à Portet-sur-Garonne.\n\nAccueil dès 11 h 30 pour l’initiation boxe encadrée par nos coachs : prévoyez une tenue souple. Le déjeuner est servi à 12 h 15, suivi d’un temps de rencontres entre entrepreneurs.\n\nGardez votre invitation avec son QR code à portée de main : elle sera scannée à l’entrée.\n\nÀ très vite,\nLe Business Club du Boxing Center",
    },
    merci: {
      audience: "present", invite: false,
      subject: "Merci pour votre venue",
      body: "Bonjour {prenom},\n\nMerci d’avoir participé à la première Rencontre Entrepreneurs du Business Club. Nous espérons que l’initiation, le déjeuner et les échanges vous ont plu.\n\nN’hésitez pas à répondre à cet e-mail pour nous partager votre avis ou vos idées pour la prochaine édition.\n\nÀ bientôt,\nLe Business Club du Boxing Center",
    },
    relance: {
      audience: "pending", invite: false,
      subject: "Votre inscription n’est pas encore finalisée",
      body: "Bonjour {prenom},\n\nVous avez commencé votre inscription à la Rencontre Entrepreneurs du vendredi 4 décembre, mais le paiement n’a pas été finalisé : votre place n’est donc pas encore réservée.\n\nPour la confirmer, il suffit de reprendre l’inscription sur dinerportet.vercel.app/inscription (10 €, déjeuner compris).\n\nUne question ? Répondez simplement à cet e-mail.\n\nLe Business Club du Boxing Center",
    },
  };

  function applyTemplate(key) {
    var t = TEMPLATES[key];
    $("msgTemplate").value = key || "";
    if (!t) return;
    $("msgSubject").value = t.subject;
    $("msgBody").value = t.body;
    $("msgAudience").value = t.audience;
    $("msgInvite").checked = t.invite;
    updateSendLabel();
    refreshPreview();
  }
  $("msgTemplate").addEventListener("change", function () { applyTemplate(this.value); });
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-template]");
    if (!t) return;
    setView("mail");
    applyTemplate(t.getAttribute("data-template"));
  });

  function audienceCount() {
    var a = (data.audiences || {})[$("msgAudience").value];
    return a ? a.count : 0;
  }
  function updateSendLabel() {
    var n = audienceCount();
    $("msgSend").textContent = "Envoyer à " + plural(n, "destinataire", "destinataires");
    $("msgSend").disabled = n === 0;
  }
  $("msgAudience").addEventListener("change", updateSendLabel);

  function messagePayload() {
    return { subject: $("msgSubject").value.trim(), body: $("msgBody").value.trim(), withInvitation: $("msgInvite").checked };
  }
  var previewTimer = null;
  function refreshPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      post("/api/gestion/messages/preview", messagePayload()).then(function (r) {
        if (r.ok) $("msgPreview").srcdoc = r.html;
      });
    }, 350);
  }
  ["msgSubject", "msgBody"].forEach(function (id) { $(id).addEventListener("input", refreshPreview); });
  $("msgInvite").addEventListener("change", refreshPreview);

  $("msgTest").addEventListener("click", function () {
    var to = $("msgTestTo").value.trim();
    var m = messagePayload();
    if (!m.subject || !m.body) { toast("Écrivez l’objet et le message", "bad"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) { toast("Adresse d’essai invalide", "bad"); return; }
    var btn = this;
    btn.disabled = true;
    post("/api/gestion/messages/send", Object.assign(m, { testTo: to })).then(function (r) {
      btn.disabled = false;
      toast(r.ok ? "Essai envoyé à " + to : "Échec de l’envoi de l’essai", r.ok ? "" : "bad");
    });
  });

  $("msgForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var m = messagePayload();
    if (!m.subject || !m.body) { toast("Écrivez l’objet et le message", "bad"); return; }
    var aud = $("msgAudience").value;
    var n = audienceCount();
    var label = (data.audiences[aud] || {}).label || "";
    ask("Envoyer à " + plural(n, "destinataire", "destinataires") + " ?", "« " + m.subject + " » sera envoyé à : " + label.toLowerCase() + ". Chaque personne ne le recevra qu’une fois.", "Envoyer").then(function (ok) {
      if (!ok) return;
      var campaign = "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
      var total = 0; var failed = 0; var rounds = 0;
      $("msgSend").disabled = true;
      $("msgStatus").textContent = "Envoi en cours…";
      (function round() {
        rounds += 1;
        post("/api/gestion/messages/send", Object.assign({}, m, { audience: aud, campaign: campaign, includeTest: includeTest() })).then(function (r) {
          if (!r.ok) { $("msgStatus").textContent = "Envoi interrompu. Relancez : personne ne recevra le message deux fois."; $("msgSend").disabled = false; return; }
          total += r.sent; failed += r.failed;
          $("msgStatus").textContent = total + " envoyé(s)…";
          if (r.remaining > 0 && rounds < 40) { round(); return; }
          $("msgStatus").textContent = total + " envoyé(s)" + (failed ? ", " + failed + " en échec" : "") + ".";
          toast("Message envoyé à " + plural(total, "personne", "personnes"), failed ? "bad" : "");
          $("msgSend").disabled = false;
          load();
        }).catch(function () { $("msgStatus").textContent = "Connexion perdue. Relancez l’envoi."; $("msgSend").disabled = false; });
      })();
    });
  });

  /* Hauteur réelle de la barre du haut : les lettres et le bandeau de résultat se collent juste dessous. */
  function measureTop() {
    var t = document.querySelector(".top");
    if (t && t.offsetHeight) document.documentElement.style.setProperty("--top-h", t.offsetHeight + "px");
  }
  window.addEventListener("resize", measureTop);

  /* ---------- Démarrage ---------- */
  window.addEventListener("hashchange", function () { if (!$("app").hidden) setView(viewFromHash(), true); });
  api("/api/gestion/state").then(function (s) {
    if (s.authed) showApp(); else showLock();
  });
})();
