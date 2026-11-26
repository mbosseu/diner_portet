/* Back-office du Business Club : inscrits, contrôle des invitations (QR), présents. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var data = { stats: {}, registrations: [] };
  var openId = null;
  var refreshTimer = null;

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
  function hhmm(iso) {
    if (!iso) return "";
    return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)).replace(":", " h ");
  }
  function day(iso) {
    if (!iso) return "";
    return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  }
  function euros(c) { return (c / 100).toLocaleString("fr-FR", { maximumFractionDigits: 0 }) + " €"; }
  function telHref(p) { return "tel:" + String(p || "").replace(/[^\d+]/g, ""); }

  /* ---------- Connexion ---------- */
  function showLock() {
    $("lock").hidden = false; $("app").hidden = true; $("logout").hidden = true;
    setTimeout(function () { $("pwd").focus(); }, 50);
  }
  function showApp() {
    $("lock").hidden = true; $("app").hidden = false; $("logout").hidden = false;
    load();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () { if (!document.hidden) load(); }, 20000);
  }

  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    $("loginError").hidden = true;
    api("/api/gestion/login", { method: "POST", body: JSON.stringify({ password: $("pwd").value }) }).then(function (r) {
      if (r.ok) { $("pwd").value = ""; showApp(); return; }
      $("loginError").hidden = false;
      $("loginError").textContent = r.error === "too_many_attempts"
        ? "Trop de tentatives. Réessayez dans quelques minutes."
        : "Mot de passe incorrect.";
    });
  });
  $("logout").addEventListener("click", function () {
    stopCam();
    api("/api/gestion/logout", { method: "POST" }).then(showLock);
  });

  /* ---------- Données ---------- */
  function load() {
    var test = $("showTest").checked ? "?test=1" : "";
    $("exportCsv").href = "/api/gestion/export.csv" + test;
    return api("/api/gestion/overview" + test).then(function (r) {
      if (r._status === 401) { showLock(); return; }
      if (!r.ok) return;
      data = r;
      renderStats();
      renderList();
      renderPresent();
    });
  }

  function renderStats() {
    var s = data.stats;
    $("sPaid").textContent = s.paid;
    $("sMax").textContent = "sur " + s.max + " places";
    $("sPresent").textContent = s.present;
    $("sExpected").textContent = "sur " + s.expected + " attendus";
    $("sPartners").textContent = s.partners_present + " / " + s.partners_total;
    $("sPending").textContent = s.pending;
    $("sRevenue").textContent = euros(s.revenue_cents);
  }

  function matches(r, q) {
    if (!q) return true;
    var hay = [r.first_name, r.last_name, r.company, r.email, r.phone, r.id, r.role].join(" ").toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "");
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }
  function filtered() {
    var f = $("filter").value;
    var q = $("search").value.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return data.registrations.filter(function (r) {
      if (f === "paid" && r.status !== "paid") return false;
      if (f === "absent" && !(r.status === "paid" && !r.checked_in_at)) return false;
      if (f === "pending" && r.status !== "pending") return false;
      if (f === "partner" && r.status !== "partner") return false;
      return matches(r, q);
    });
  }

  function tags(r) {
    var t = [];
    if (r.test) t.push('<span class="g-tag g-tag--test">Test</span>');
    if (r.status === "paid") t.push('<span class="g-tag g-tag--paid">Payé</span>');
    else if (r.status === "partner") t.push('<span class="g-tag g-tag--paid">Partenaire</span>');
    else if (r.status === "pending") t.push('<span class="g-tag g-tag--pending">En attente</span>');
    else t.push('<span class="g-tag">' + esc({ cancelled: "Annulé", failed: "Refusé", review: "À vérifier" }[r.status] || r.status) + "</span>");
    if (r.checked_in_at) t.push('<span class="g-tag g-tag--in">Arrivé ' + esc(hhmm(r.checked_in_at)) + "</span>");
    return t.join("");
  }

  function detail(r) {
    var fields = [
      ["Référence", r.id], ["Activité", r.activity], ["Secteur", r.sector], ["Site / LinkedIn", r.website],
      ["Recherche", r.looking], ["Peut apporter", r.offer],
      ["Inscrit le", day(r.created_at)], ["Payé le", day(r.paid_at)],
      ["Invitation e-mail", r.confirmation_error ? "Échec : " + r.confirmation_error : (r.confirmation_sent_at ? "Envoyée le " + day(r.confirmation_sent_at) : "—")]
    ].filter(function (f) { return f[1]; });
    var contact = [];
    if (r.email) contact.push('<a href="mailto:' + esc(r.email) + '">' + esc(r.email) + "</a>");
    if (r.phone) contact.push('<a href="' + esc(telHref(r.phone)) + '">' + esc(r.phone) + "</a>");
    var actions = [];
    if (r.status === "paid" || r.status === "partner") {
      actions.push(r.checked_in_at
        ? '<button class="g-btn g-btn--line g-btn--sm" data-act="undo" data-id="' + esc(r.id) + '">Annuler l’arrivée</button>'
        : '<button class="g-btn g-btn--ok g-btn--sm" data-act="in" data-id="' + esc(r.id) + '">Marquer présent</button>');
    }
    if (r.status === "paid" && r.email) actions.push('<button class="g-btn g-btn--line g-btn--sm" data-act="resend" data-id="' + esc(r.id) + '">Renvoyer l’invitation</button>');
    return '<div class="g-detail">' +
      (contact.length ? '<div class="g-contact">' + contact.join("") + "</div>" : "") +
      '<dl class="g-dl">' + fields.map(function (f) { return "<div><dt>" + esc(f[0]) + "</dt><dd>" + esc(f[1]) + "</dd></div>"; }).join("") + "</dl>" +
      (actions.length ? '<div class="g-row-actions">' + actions.join("") + '<span class="g-note" data-msg="' + esc(r.id) + '"></span></div>' : "") +
      "</div>";
  }

  function row(r) {
    var sub = [r.role, r.company].filter(Boolean).join(" · ");
    var open = openId === r.id;
    return '<li class="g-row">' +
      '<button class="g-row-main" data-open="' + esc(r.id) + '" aria-expanded="' + open + '">' +
      '<span class="g-name">' + esc(r.first_name + " " + r.last_name) + "</span>" +
      '<span class="g-sub">' + esc(sub) + "</span>" +
      '<span class="g-tags">' + tags(r) + "</span>" +
      "</button>" + (open ? detail(r) : "") + "</li>";
  }

  function renderList() {
    var list = filtered();
    $("count").textContent = list.length + (list.length > 1 ? " personnes" : " personne");
    $("list").innerHTML = list.length ? list.map(row).join("") : '<li class="g-empty">Aucune inscription pour ce filtre.</li>';
  }

  function renderPresent() {
    var list = data.registrations.filter(function (r) { return r.checked_in_at; })
      .sort(function (a, b) { return String(b.checked_in_at).localeCompare(String(a.checked_in_at)); });
    $("presentCount").textContent = list.length + " présent" + (list.length > 1 ? "s" : "") + " sur " + data.stats.expected + " attendus";
    $("presentList").innerHTML = list.length ? list.map(row).join("") : '<li class="g-empty">Personne n’est encore arrivé.</li>';
  }

  ["search", "filter"].forEach(function (id) { $(id).addEventListener("input", renderList); });
  $("showTest").addEventListener("change", load);

  document.addEventListener("click", function (e) {
    var openBtn = e.target.closest("[data-open]");
    if (openBtn) {
      openId = openId === openBtn.getAttribute("data-open") ? null : openBtn.getAttribute("data-open");
      renderList(); renderPresent();
      return;
    }
    var act = e.target.closest("[data-act]");
    if (!act) return;
    var id = act.getAttribute("data-id");
    var kind = act.getAttribute("data-act");
    act.disabled = true;
    var msg = function (t) { document.querySelectorAll('[data-msg="' + id + '"]').forEach(function (n) { n.textContent = t; }); };
    if (kind === "in") {
      api("/api/gestion/checkin", { method: "POST", body: JSON.stringify({ id: id, allowTest: true }) }).then(function (r) { msg(r.message || ""); load(); });
    } else if (kind === "undo") {
      if (!window.confirm("Annuler l’arrivée de cette personne ?")) { act.disabled = false; return; }
      api("/api/gestion/checkin/undo", { method: "POST", body: JSON.stringify({ id: id }) }).then(load);
    } else if (kind === "resend") {
      api("/api/gestion/resend", { method: "POST", body: JSON.stringify({ id: id }) }).then(function (r) {
        act.disabled = false;
        msg(r.ok ? (r.via === "outbox" ? "Invitation de test déposée dans la boîte d’envoi du Studio." : "Invitation renvoyée ✔") : "Échec de l’envoi.");
      });
    }
  });

  /* ---------- Impression ---------- */
  $("print").addEventListener("click", function () {
    var list = data.registrations.filter(function (r) { return r.status === "paid" || r.status === "partner"; });
    $("printArea").innerHTML = "<h2>Business Club · Rencontre Entrepreneurs — liste d’accueil</h2>" +
      "<p>" + list.length + " personnes · imprimée le " + esc(day(new Date().toISOString())) + "</p>" +
      "<table><thead><tr><th></th><th>Nom</th><th>Entreprise</th><th>Téléphone</th><th>Référence</th></tr></thead><tbody>" +
      list.map(function (r) {
        return '<tr><td class="box"><span></span></td><td><b>' + esc(r.last_name.toUpperCase()) + "</b> " + esc(r.first_name) + "</td><td>" +
          esc([r.company, r.role].filter(Boolean).join(" · ")) + "</td><td>" + esc(r.phone) + "</td><td>" + esc(r.id) + "</td></tr>";
      }).join("") + "</tbody></table>";
    window.print();
  });

  /* ---------- Onglets ---------- */
  document.querySelectorAll(".g-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var name = tab.getAttribute("data-tab");
      document.querySelectorAll(".g-tab").forEach(function (t) { t.setAttribute("aria-selected", String(t === tab)); });
      ["list", "scan", "present"].forEach(function (n) { $("tab-" + n).hidden = n !== name; });
      if (name !== "scan") stopCam();
      if (name !== "scan") load();
    });
  });

  /* ---------- Scanner ---------- */
  var stream = null;
  var scanning = false;
  var busy = false;
  var lastCode = "";
  var lastAt = 0;

  function setResult(state, k, msg, sub) {
    var el = $("result");
    el.setAttribute("data-state", state);
    $("resultK").textContent = k;
    $("resultMsg").textContent = msg;
    $("resultSub").textContent = sub || "";
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

  function submit(payload) {
    if (busy) return;
    busy = true;
    payload.allowTest = $("allowTest").checked;
    setResult("idle", "Vérification…", "Un instant", "");
    api("/api/gestion/checkin", { method: "POST", body: JSON.stringify(payload) }).then(function (r) {
      busy = false;
      if (r._status === 401) { showLock(); return; }
      var reg = r.registration;
      var sub = reg ? [reg.company, reg.role].filter(Boolean).join(" · ") + (reg.id && reg.status !== "partner" ? " — " + reg.id : "") : "";
      var k = { ok: "Entrée validée", already: "Déjà entré", refused: "Refusé" }[r.result] || "Erreur";
      setResult(r.result || "refused", k, r.message || "Erreur de vérification.", sub);
      feedback(r.result);
      load();
    }).catch(function () {
      busy = false;
      setResult("refused", "Réseau", "Pas de connexion internet.", "Réessayez, ou utilisez la liste imprimée.");
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
        var now = Date.now();
        if (code.data !== lastCode || now - lastAt > 4000) {
          lastCode = code.data; lastAt = now;
          submit({ qr: code.data });
        }
      }
    }
    requestAnimationFrame(tick);
  }

  function startCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setResult("refused", "Caméra", "Caméra non disponible sur cet appareil.", "Utilisez la saisie manuelle ci-dessous.");
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then(function (s) {
      stream = s;
      var video = $("video");
      video.srcObject = s;
      video.setAttribute("playsinline", "");
      video.play();
      $("startCam").hidden = true;
      scanning = true;
      setResult("idle", "Prêt", "Présentez le QR code de l’invitation devant la caméra.", "");
      requestAnimationFrame(tick);
    }).catch(function () {
      setResult("refused", "Caméra", "Accès à la caméra refusé.", "Autorisez la caméra dans le navigateur, ou utilisez la saisie manuelle.");
    });
  }
  function stopCam() {
    scanning = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    $("video").srcObject = null;
    $("startCam").hidden = false;
  }
  $("startCam").addEventListener("click", startCam);
  $("manualForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("manual").value.trim();
    if (!v) return;
    submit(/^BC[-\s]?PART/i.test(v) ? { code: v } : { id: v.toUpperCase() });
    $("manual").value = "";
  });
  document.addEventListener("visibilitychange", function () { if (document.hidden) stopCam(); });

  /* ---------- Démarrage ---------- */
  api("/api/gestion/state").then(function (s) {
    if (s.authed) showApp(); else showLock();
  });
})();
