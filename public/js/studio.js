(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var LABELS = {
    paid: "Payée", pending: "En attente", failed: "Refusée", cancelled: "Annulée", review: "À vérifier",
    captured: "Acceptée", rejected: "Refusée", tampered: "Montant falsifié", approved: "Approuvée", null: "Non payée"
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function chip(v) { var k = v == null ? "null" : v; return '<span class="chip ' + esc(k) + '">' + esc(LABELS[k] || k) + "</span>"; }
  function when(iso) { return iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—"; }

  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: "same-origin", headers: { "Content-Type": "application/json" } }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); });
  }

  function showLock(state) {
    $("dash").hidden = true;
    $("lock").hidden = false;
    $("pwdLabel").hidden = $("pwd").hidden = !state.password_required;
  }

  function render(data) {
    $("lock").hidden = true;
    $("dash").hidden = false;
    $("target").textContent = {
      "cawl-preprod": "préproduction CAWL (clés de test)",
      simulator: "simulateur CAWL du Studio",
      "paypal-sandbox": "bac à sable PayPal (clés de test)",
      "paypal-simulator": "simulateur PayPal du Studio"
    }[data.target] || data.target;
    var isPaypal = data.provider === "paypal";
    $("cardsTitle").textContent = isPaypal ? "Comptes PayPal de test" : "Cartes de test";
    $("cardsNote").textContent = isPaypal
      ? "Sur la page PayPal simulée, cliquez sur un compte pour le saisir, puis « Payer »."
      : "Expiration : n'importe quelle date future (ex. 12/29) · Cryptogramme : 3 chiffres (ex. 123).";

    $("cards").innerHTML = Object.keys(data.cards).map(function (num) {
      return "<li><code>" + esc(isPaypal ? num : num.replace(/(\d{4})(?=\d)/g, "$1 ")) + "</code><span>" + esc(data.cards[num].label) + "</span></li>";
    }).join("");

    $("regCount").textContent = "(" + data.registrations.length + ")";
    $("regs").innerHTML = data.registrations.length ? data.registrations.map(function (r) {
      return "<tr><td>" + esc(r.id) + "<small>" + when(r.created_at) + "</small></td>" +
        "<td>" + esc(r.first_name + " " + r.last_name) + "<small>" + esc(r.email) + "</small></td>" +
        "<td>" + chip(r.status) + (r.review_reason ? "<small>" + esc(r.review_reason) + "</small>" : "") + "</td>" +
        "<td>" + esc(r.pay_mode) + "</td>" +
        "<td>" + when(r.confirmation_sent_at) + "</td><td>" + when(r.reminder_sent_at) + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="st-empty">Aucune inscription de test pour l’instant.</td></tr>';

    $("checkouts").innerHTML = data.checkouts.length ? data.checkouts.map(function (c) {
      var action = c.outcome === "pending"
        ? '<button class="st-btn mini" data-webhook="' + esc(c.id) + '">Confirmer (webhook banque)</button>' : "";
      return "<tr><td>" + esc(c.id) + "<small>" + when(c.created_at) + "</small></td><td>" + esc(c.ref) + "</td>" +
        "<td>" + (c.amount / 100).toFixed(2).replace(".", ",") + " €</td><td>" + chip(c.outcome) +
        (c.card ? "<small>" + esc(c.card) + "</small>" : "") + "</td><td>" + action + "</td></tr>";
    }).join("") : '<tr><td colspan="5" class="st-empty">Aucun paiement simulé.</td></tr>';

    $("outbox").innerHTML = data.outbox.length ? data.outbox.map(function (m) {
      return '<li><button data-mail="' + esc(m.file) + '">' + esc(m.subject) + "<small>" + esc(m.to) + "</small></button></li>";
    }).join("") : '<li class="st-empty">Aucun e-mail.</li>';
  }

  function load() {
    return api("/api/studio/state").then(function (state) {
      if (!state.available) { document.querySelector(".st-main").innerHTML = "<p>Studio indisponible.</p>"; return; }
      if (!state.studio) return showLock(state);
      return api("/api/studio/overview").then(render);
    });
  }

  $("unlockForm").addEventListener("submit", function (e) {
    e.preventDefault();
    api("/api/studio/unlock", { method: "POST", body: JSON.stringify({ password: $("pwd").value }) }).then(function (r) {
      if (!r.ok) { $("unlockError").hidden = false; $("unlockError").textContent = "Mot de passe incorrect."; return; }
      load();
    });
  });

  $("refresh").addEventListener("click", load);
  $("leave").addEventListener("click", function () { api("/api/studio/leave", { method: "POST" }).then(load); });

  $("reminders").addEventListener("click", function () {
    api("/api/studio/reminders", { method: "POST" }).then(function (r) {
      $("toolMsg").textContent = r.ok ? r.sent + " rappel(s) envoyé(s) dans la boîte d’envoi." : "Échec de l’envoi.";
      load();
    });
  });

  $("realSend").addEventListener("click", function () {
    $("realMsg").textContent = "Envoi en cours…";
    api("/api/studio/real-email", { method: "POST", body: JSON.stringify({ to: $("realTo").value }) }).then(function (r) {
      if (r.error === "invalid_email") { $("realMsg").textContent = "Adresse e-mail invalide."; return; }
      if (r.error === "no_paid_test_registration") { $("realMsg").textContent = "Faites d’abord une inscription de test payée."; return; }
      if (r.error === "brevo_not_configured") { $("realMsg").textContent = "Brevo n’est pas configuré (BREVO_API_KEY)."; return; }
      $("realMsg").textContent = (r.results || []).map(function (x) {
        return x.kind + " : " + (x.sent ? "accepté par Brevo ✔" : "échec — " + (x.error || "inconnu"));
      }).join(" · ") || "Échec.";
    });
  });

  $("reset").addEventListener("click", function () {
    if (!window.confirm("Effacer toutes les inscriptions, paiements et e-mails de test ?")) return;
    api("/api/studio/reset", { method: "POST" }).then(function (r) {
      $("toolMsg").textContent = r.ok ? r.removed + " inscription(s) de test effacée(s)." : "Échec.";
      $("mailPreview").removeAttribute("src");
      load();
    });
  });

  document.addEventListener("click", function (e) {
    var wh = e.target.closest("[data-webhook]");
    if (wh) {
      wh.disabled = true;
      api("/api/studio/checkouts/" + wh.getAttribute("data-webhook") + "/webhook", { method: "POST" }).then(load);
    }
    var mail = e.target.closest("[data-mail]");
    if (mail) {
      document.querySelectorAll("[data-mail]").forEach(function (b) { b.classList.remove("on"); });
      mail.classList.add("on");
      $("mailPreview").src = "/api/studio/outbox/" + encodeURIComponent(mail.getAttribute("data-mail"));
    }
  });

  load();
})();
