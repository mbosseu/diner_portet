(function () {
  "use strict";

  var form = document.getElementById("panel-1");
  var panels = [null, form, document.getElementById("panel-2"), document.getElementById("panel-3")];
  var stepper = document.querySelectorAll("#stepper li");
  var data = {};

  /* ---------- Navigation entre étapes ---------- */

  function goTo(step) {
    document.getElementById("panel-wait").hidden = true;
    panels.forEach(function (p, i) { if (p) p.hidden = i !== step; });
    stepper.forEach(function (li) {
      var n = Number(li.getAttribute("data-step"));
      li.classList.toggle("active", n === step);
      li.classList.toggle("done", n < step);
      if (n === step) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
    // Au-delà du formulaire (règlement, invitation, retour de paiement) : on amène l'étape et son message
    // à l'écran, sous la barre de navigation, au lieu de remonter tout en haut de la page.
    var anchor = stepper[0] && stepper[0].parentElement;
    var top = step > 0 && anchor ? anchor.getBoundingClientRect().top + window.scrollY - 90 : 0;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  /* ---------- Validation ---------- */

  var messages = {
    required: "Ce champ est requis.",
    email: "Adresse e-mail invalide.",
    phone: "Numéro de téléphone invalide.",
    url: "Adresse invalide (ex. https://monsite.fr)."
  };

  function setError(input, msg) {
    var field = input.closest(".field");
    if (!field) return;
    field.classList.toggle("invalid", !!msg);
    field.querySelector(".err").textContent = msg || "";
    input.setAttribute("aria-invalid", msg ? "true" : "false");
  }

  function check(input) {
    var v = input.value.trim();
    if (input.required && !v) return messages.required;
    if (!v) return "";
    if (input.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return messages.email;
    if (input.type === "tel" && v.replace(/[^\d]/g, "").length < 9) return messages.phone;
    if (input.type === "url") {
      var url = /^https?:\/\//i.test(v) ? v : "https://" + v;
      try { new URL(url); } catch (e) { return messages.url; }
    }
    return "";
  }

  form.querySelectorAll("input:not([type=checkbox]), select, textarea").forEach(function (input) {
    input.addEventListener("blur", function () { setError(input, check(input)); });
    input.addEventListener("input", function () {
      if (input.closest(".field").classList.contains("invalid")) setError(input, check(input));
    });
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var firstBad = null;

    form.querySelectorAll("input:not([type=checkbox]), select, textarea").forEach(function (input) {
      var msg = check(input);
      setError(input, msg);
      if (msg && !firstBad) firstBad = input;
    });

    var consent = document.getElementById("consent");
    var consentWrap = document.getElementById("consentWrap");
    consentWrap.classList.toggle("invalid", !consent.checked);
    if (!consent.checked && !firstBad) firstBad = consent;

    if (firstBad) {
      firstBad.focus();
      firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    data = Object.fromEntries(new FormData(form).entries());
    Object.keys(data).forEach(function (k) { if (typeof data[k] === "string") data[k] = data[k].trim(); });
    if (data.website && !/^https?:\/\//i.test(data.website)) data.website = "https://" + data.website;

    document.getElementById("sumName").textContent = data.firstName + " " + data.lastName;
    document.getElementById("sumCompany").textContent = data.company;
    showPayError("");
    goTo(2);
  });

  document.getElementById("consent").addEventListener("change", function () {
    document.getElementById("consentWrap").classList.toggle("invalid", !this.checked);
  });

  document.getElementById("backTo1").addEventListener("click", function () { goTo(1); });

  /* ---------- Paiement : inscription côté serveur puis page de paiement sécurisée ---------- */

  var DRAFT_KEY = "bc_draft";
  var payBtn = document.getElementById("payBtn");
  var payError = document.getElementById("payError");
  var current = null; // { id, t } de l'inscription affichée

  var ERRORS = {
    already_registered: "Une inscription payée existe déjà avec cette adresse e-mail. Vérifiez votre boîte de réception (et les indésirables).",
    full: "Toutes les places de cette première édition sont réservées. Contactez le Boxing Center pour être placé en liste d’attente.",
    too_many_attempts: "Trop de tentatives rapprochées. Patientez quelques minutes avant de réessayer.",
    payment_not_configured: "Le paiement en ligne n’est pas encore ouvert. Réessayez un peu plus tard.",
    payment_unavailable: "La plateforme de paiement ne répond pas pour le moment. Réessayez dans quelques instants.",
    network: "Connexion impossible. Vérifiez votre accès à Internet puis réessayez."
  };

  function showPayError(msg) {
    payError.textContent = msg || "";
    payError.hidden = !msg;
    // Le message doit être vu tout de suite (retour de paiement annulé ou refusé, erreur réseau).
    if (msg) setTimeout(function () { payError.scrollIntoView({ behavior: "smooth", block: "center" }); }, 350);
  }

  function saveDraft() {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function restoreDraft() {
    try {
      var d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
      if (!d) return false;
      data = d;
      Object.keys(d).forEach(function (k) {
        var el = form.elements[k];
        if (!el || !el.tagName) return;
        if (el.type === "checkbox") el.checked = d[k] === "on" || d[k] === true;
        else el.value = d[k];
      });
      document.getElementById("sumName").textContent = d.firstName + " " + d.lastName;
      document.getElementById("sumCompany").textContent = d.company;
      return true;
    } catch (e) { return false; }
  }

  function markServerErrors(fields) {
    var map = { first_name: "firstName", last_name: "lastName", email: "email", phone: "phone", company: "company",
      role: "role", activity: "activity", sector: "sector", website: "website", looking: "looking", offer: "offer" };
    Object.keys(fields || {}).forEach(function (k) {
      if (k === "consent") { document.getElementById("consentWrap").classList.add("invalid"); return; }
      var el = form.elements[map[k]];
      if (el) setError(el, fields[k] === "required" ? messages.required : "Valeur invalide.");
    });
  }

  function resetPayBtn() {
    payBtn.disabled = false;
    payBtn.textContent = "Payer 10 €";
  }

  payBtn.addEventListener("click", function () {
    showPayError("");
    payBtn.disabled = true;
    payBtn.textContent = "Redirection vers le paiement…";
    saveDraft();
    var payload = Object.assign({}, data, { consent: document.getElementById("consent").checked });

    fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "payment_unavailable" }; }); })
      .then(function (res) {
        if (res.ok && res.redirectUrl) {
          window.location.assign(res.redirectUrl);
          return;
        }
        resetPayBtn();
        if (res.error === "invalid_fields") {
          goTo(1);
          markServerErrors(res.fields);
          return;
        }
        showPayError(ERRORS[res.error] || ERRORS.payment_unavailable);
      })
      .catch(function () {
        resetPayBtn();
        showPayError(ERRORS.network);
      });
  });

  /* ---------- Retour de la banque : vérification côté serveur ---------- */

  var waitPanel = document.getElementById("panel-wait");

  function showWait(text) {
    panels.forEach(function (p) { if (p) p.hidden = true; });
    waitPanel.hidden = false;
    stepper.forEach(function (li) {
      var n = Number(li.getAttribute("data-step"));
      li.classList.toggle("active", n === 2);
      li.classList.toggle("done", n < 2);
    });
    document.getElementById("waitText").textContent = text ||
      "Nous confirmons votre règlement auprès de la plateforme de paiement. Merci de patienter quelques secondes.";
  }

  function confirmPayment(id, t, attempt, cancelled) {
    return fetch("/api/registrations/" + encodeURIComponent(id) + "/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t: t, cancelled: !!cancelled })
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || "confirmation_failed");
        if (res.paid) { showInvitation(res.registration, id, t); return; }

        if (res.cancelled || res.refused) {
          restoreDraft();
          goTo(2);
          showPayError(res.refused
            ? "Le paiement a été refusé. Aucun montant n’a été débité : vous pouvez réessayer avec un autre moyen de paiement."
            : "Le paiement a été annulé. Votre place n’est pas encore réservée : vous pouvez reprendre le règlement.");
          return;
        }
        if (res.error === "amount_mismatch" || res.error === "reference_mismatch") {
          showWait("Votre paiement nécessite une vérification manuelle par notre équipe. Nous vous recontactons rapidement par e-mail.");
          return;
        }
        if (attempt < 6) {
          showWait("La transaction est en cours de finalisation. Merci de patienter quelques secondes…");
          setTimeout(function () { confirmPayment(id, t, attempt + 1); }, 2500);
          return;
        }
        showWait("Votre paiement est en cours de validation par la plateforme de paiement. Vous recevrez votre invitation par e-mail dès sa confirmation : inutile de payer une seconde fois.");
      })
      .catch(function () {
        showWait("Impossible de vérifier le paiement pour le moment. Si vous avez été débité, votre invitation vous sera envoyée par e-mail.");
      });
  }

  /* ---------- Invitation ---------- */

  function showInvitation(reg, id, t) {
    current = { id: id, t: t };
    try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) {}
    document.getElementById("okEmail").textContent = reg.email;
    document.getElementById("tName").textContent = reg.first_name + " " + reg.last_name;
    document.getElementById("tCompany").textContent = [reg.role, reg.company].filter(Boolean).join(" · ");
    document.getElementById("tRef").textContent = reg.id;

    var qr = document.getElementById("qr");
    qr.innerHTML = "";
    var img = new Image();
    img.alt = "QR code de l’invitation " + reg.id;
    img.width = 132;
    img.height = 132;
    img.src = "/api/registrations/" + encodeURIComponent(id) + "/qr.png?t=" + encodeURIComponent(t);
    qr.appendChild(img);
    goTo(3);
  }

  document.getElementById("calBtn").addEventListener("click", function () {
    if (!current) return;
    window.location.href = "/api/registrations/" + encodeURIComponent(current.id) + "/calendar.ics?t=" + encodeURIComponent(current.t);
  });

  document.getElementById("printBtn").addEventListener("click", function () { window.print(); });

  /* ---------- Bandeau Studio (tests de paiement) ---------- */

  fetch("/api/studio/state", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (s.provider === "cawl") {
        document.getElementById("payInfo").textContent = "Vous allez être redirigé vers la page de paiement sécurisée du Crédit Agricole (CAWL) pour régler par carte bancaire. Votre invitation officielle vous est envoyée par e-mail dès la confirmation.";
      }
      if (!s.studio) return;
      var b = document.createElement("a");
      b.className = "studio-banner";
      b.href = "/studio";
      b.textContent = "Mode Studio — paiements de test, aucun débit réel";
      document.body.appendChild(b);
    })
    .catch(function () {});

  /* ---------- Arrivée sur la page ---------- */

  var params = new URLSearchParams(window.location.search);
  var qid = params.get("id");
  var qt = params.get("t");
  if (qid && qt) {
    showWait();
    if (params.get("pay_return") || params.get("cawl_return")) {
      confirmPayment(qid, qt, 0, params.get("cancelled") === "1");
    } else {
      fetch("/api/registrations/" + encodeURIComponent(qid) + "?t=" + encodeURIComponent(qt))
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res.ok && res.registration.status === "paid") showInvitation(res.registration, qid, qt);
          else if (res.ok) confirmPayment(qid, qt, 0);
          else goTo(1);
        })
        .catch(function () { goTo(1); });
    }
  } else {
    restoreDraft();
  }
})();
