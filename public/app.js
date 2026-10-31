(function () {
  var limits = {
    maxPhotos: 6,
    maxTotalMb: 15,
    noteMax: 4000,
    requireAccessCode: false,
  };

  var EXT = { jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1, heic: 1, heif: 1 };
  var MIME = {
    "image/jpeg": 1,
    "image/jpg": 1,
    "image/pjpeg": 1,
    "image/png": 1,
    "image/gif": 1,
    "image/webp": 1,
    "image/heic": 1,
    "image/heif": 1,
    "image/heic-sequence": 1,
    "image/heif-sequence": 1,
  };

  var form = document.getElementById("report");
  var banner = document.getElementById("form-error");
  var note = document.getElementById("note");
  var senderEmail = document.getElementById("senderEmail");
  var photos = document.getElementById("photos");
  var drop = document.getElementById("drop");
  var dropSub = document.getElementById("drop-sub");
  var previews = document.getElementById("previews");
  var meta = document.getElementById("photo-meta");
  var codeField = document.getElementById("code-field");
  var codeInput = document.getElementById("accessCode");
  var hp = document.getElementById("snitch_hp");
  var sendButton = document.getElementById("send");
  var sendLabel = sendButton.querySelector(".send-label");
  var sendingHint = document.getElementById("sending-hint");
  var files = [];
  var previewUrls = [];
  var sending = false;

  function extOf(name) {
    var match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }

  function typeOk(file) {
    var ext = extOf(file.name);
    if (ext) return !!EXT[ext];
    return !!MIME[(file.type || "").toLowerCase()];
  }

  function totalBytes() {
    var sum = 0;
    for (var i = 0; i < files.length; i++) sum += files[i].size;
    return sum;
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function showError(message) {
    banner.hidden = false;
    banner.textContent = message;
    banner.scrollIntoView({ block: "nearest" });
  }

  function clearError() {
    banner.hidden = true;
    banner.textContent = "";
  }

  function fallbackTile(file) {
    var tile = document.createElement("div");
    tile.className = "tile";
    var label = document.createElement("span");
    label.textContent = file.name || "Photo";
    tile.appendChild(label);
    return tile;
  }

  function renderFiles() {
    for (var u = 0; u < previewUrls.length; u++) URL.revokeObjectURL(previewUrls[u]);
    previewUrls = [];
    previews.replaceChildren();

    files.forEach(function (file, index) {
      var item = document.createElement("li");
      var ext = extOf(file.name);
      if (ext !== "heic" && ext !== "heif") {
        var img = document.createElement("img");
        var url = URL.createObjectURL(file);
        previewUrls.push(url);
        img.src = url;
        img.alt = file.name || "Photo " + (index + 1);
        img.addEventListener("error", function () {
          img.replaceWith(fallbackTile(file));
        });
        item.appendChild(img);
      } else {
        item.appendChild(fallbackTile(file));
      }

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.setAttribute("aria-label", "Remove photo " + (index + 1));
      remove.textContent = "\u00d7";
      remove.addEventListener("click", function () {
        files.splice(index, 1);
        renderFiles();
      });
      item.appendChild(remove);
      previews.appendChild(item);
    });

    if (!files.length) {
      meta.textContent = "";
      return;
    }
    var noun = files.length === 1 ? "photo" : "photos";
    meta.textContent = files.length + " " + noun + " \u00b7 " + formatBytes(totalBytes());
  }

  function addFiles(list) {
    var incoming = Array.prototype.slice.call(list || []);
    if (!incoming.length) return;
    clearError();
    var cap = limits.maxTotalMb * 1024 * 1024;
    for (var i = 0; i < incoming.length; i++) {
      var file = incoming[i];
      if (files.length >= limits.maxPhotos) {
        showError("You can attach up to " + limits.maxPhotos + " photos.");
        break;
      }
      if (!typeOk(file)) {
        showError((file.name || "That file") + " is not a photo Snitch can send. Use JPG, PNG, GIF, WEBP, or HEIC.");
        continue;
      }
      if (!file.size) {
        showError((file.name || "That file") + " is empty.");
        continue;
      }
      if (totalBytes() + file.size > cap) {
        showError("Those photos are too large. Keep the total under " + limits.maxTotalMb + " MB.");
        continue;
      }
      files.push(file);
    }
    renderFiles();
  }

  function setSending(on) {
    sendButton.disabled = on;
    sendLabel.textContent = on ? "Sending report\u2026" : "Send to the HOA";
    form.setAttribute("aria-busy", on ? "true" : "false");
    sendingHint.hidden = !on;
  }

  function wakeMessage(status) {
    if (status === 502 || status === 503 || status === 504) {
      return "The site is waking up or email is temporarily unavailable. Wait a minute and send again.";
    }
    return "Could not send the report. Please try again.";
  }

  photos.addEventListener("change", function () {
    addFiles(photos.files);
    photos.value = "";
  });

  window.addEventListener("dragover", function (event) {
    event.preventDefault();
  });

  drop.addEventListener("dragover", function () {
    drop.classList.add("is-hot");
  });

  drop.addEventListener("dragleave", function () {
    drop.classList.remove("is-hot");
  });

  window.addEventListener("drop", function (event) {
    event.preventDefault();
    drop.classList.remove("is-hot");
    if (event.target && drop.contains(event.target)) addFiles(event.dataTransfer.files);
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (sending) return;
    clearError();

    if (note.value.length > limits.noteMax) {
      showError("The note is too long. Keep it under " + limits.noteMax + " characters.");
      return;
    }
    var email = senderEmail ? senderEmail.value.trim() : "";
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError("That email address doesn't look right. Leave it blank if you prefer.");
      return;
    }
    if (!files.length) {
      showError("Add at least one photo so the HOA can see the issue.");
      return;
    }
    if (limits.requireAccessCode && !codeInput.value.trim()) {
      showError("Enter the community code.");
      return;
    }

    sending = true;
    setSending(true);

    var data = new FormData();
    data.append("note", note.value);
    data.append("senderEmail", email);
    data.append("accessCode", codeInput.value.trim());
    data.append("snitch_hp", hp.value);
    for (var i = 0; i < files.length; i++) data.append("photos", files[i], files[i].name);

    fetch("/api/report", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: data,
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          return { response: response, payload: payload };
        });
      })
      .then(function (result) {
        if (!result.response.ok) {
          showError(result.payload.error || wakeMessage(result.response.status));
          return;
        }
        window.location.assign("/success.html");
      })
      .catch(function () {
        showError("Could not reach Snitch. Check your connection and try again. If the site was asleep, wait a minute.");
      })
      .finally(function () {
        sending = false;
        setSending(false);
      });
  });

  fetch("/api/config", { headers: { Accept: "application/json" } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (data) {
      if (!data) return;
      if (data.maxPhotos) limits.maxPhotos = data.maxPhotos;
      if (data.maxTotalMb) limits.maxTotalMb = data.maxTotalMb;
      if (data.noteMax) limits.noteMax = data.noteMax;
      limits.requireAccessCode = !!data.requireAccessCode;
      note.maxLength = limits.noteMax;
      dropSub.textContent = "JPG, PNG, GIF, WEBP, or HEIC. Up to " + limits.maxPhotos + " photos, " + limits.maxTotalMb + " MB total.";
      if (limits.requireAccessCode) {
        codeField.hidden = false;
        var hint = codeField.querySelector(".hint");
        if (hint) hint.textContent = "Your HOA shared this code so only neighbors can send reports.";
      }
    })
    .catch(function () {});
})();
