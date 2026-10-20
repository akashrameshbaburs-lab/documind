/* DocuMind AI - vanilla JS chat UI. No build step, no CDN, no external requests. */
(function () {
  "use strict";

  var state = { token: null, user: null, sets: [], config: null };

  var el = function (id) { return document.getElementById(id); };

  function setStatus(node, message, kind) {
    node.textContent = message;
    node.className = "status" + (kind ? " " + kind : "");
  }

  function badge(node, text, kind) {
    node.textContent = text;
    node.className = "badge" + (kind ? " " + kind : " badge-muted");
  }

  async function api(path, options) {
    var opts = options || {};
    opts.headers = opts.headers || {};
    if (state.token) opts.headers["Authorization"] = "Bearer " + state.token;
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    var res = await fetch("/api" + path, opts);
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!res.ok) {
      var msg = (data && (data.message || data.error)) || res.statusText;
      var err = new Error(msg);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  function setEnabled(id, enabled) {
    var card = el(id);
    if (card) card.classList.toggle("disabled", !enabled);
  }

  function refreshAccess() {
    var signedIn = Boolean(state.token);
    el("uploadCard").querySelectorAll("input, button").forEach(function (n) { n.disabled = !signedIn; });
    el("chatCard").querySelectorAll("input, button, select").forEach(function (n) { n.disabled = !signedIn; });
    setEnabled("uploadCard", signedIn);
    setEnabled("chatCard", signedIn);
    el("logoutBtn").hidden = !signedIn;
    badge(el("userBadge"), signedIn ? state.user.email : "signed out", signedIn ? "badge-ok" : "badge-muted");
  }

  async function loadConfig() {
    try {
      state.config = await api("/config");
      badge(
        el("modeBadge"),
        "mode: " + state.config.answerMode + " (" + state.config.embeddingProvider + " embeddings)",
        state.config.answerMode === "llm" ? "badge-warn" : "badge-ok"
      );
    } catch (e) { /* config endpoint is informational only */ }
  }

  async function loadUsage() {
    if (!state.token) { badge(el("usageBadge"), "usage: –", "badge-muted"); return; }
    try {
      var u = await api("/usage");
      badge(el("usageBadge"), "usage: " + u.queries + "/" + u.limit + " today", "badge-muted");
    } catch (e) { /* ignore */ }
  }

  async function loadSets() {
    var data = await api("/sets");
    state.sets = data.sets || [];
    var list = el("setList");
    var select = el("setSelect");
    list.innerHTML = "";
    select.innerHTML = "";
    state.sets.forEach(function (s) {
      var li = document.createElement("li");
      var left = document.createElement("span");
      left.innerHTML = "<strong>" + escapeHtml(s.name) + "</strong>";
      var right = document.createElement("span");
      right.className = "muted";
      right.textContent = s.files + " file(s) · " + s.chunks + " chunks";
      var del = document.createElement("button");
      del.className = "btn"; del.textContent = "Delete";
      del.onclick = async function () {
        try { await api("/docs/" + s.id, { method: "DELETE" }); await loadSets(); }
        catch (e) { setStatus(el("uploadStatus"), "Delete failed: " + e.message, "err"); }
      };
      var wrap = document.createElement("span");
      wrap.style.display = "flex"; wrap.style.gap = "10px"; wrap.style.alignItems = "center";
      wrap.appendChild(right); wrap.appendChild(del);
      li.appendChild(left); li.appendChild(wrap);
      list.appendChild(li);

      var opt = document.createElement("option");
      opt.value = s.id; opt.textContent = s.name + " (" + s.files + " files)";
      select.appendChild(opt);
    });
    if (state.sets.length === 0) {
      var empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "No document sets yet — upload files above.";
      list.appendChild(empty);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  el("registerBtn").onclick = async function () {
    var email = el("email").value.trim(), password = el("password").value;
    try {
      await api("/register", { method: "POST", body: { email: email, password: password } });
      setStatus(el("authStatus"), "Registered. Logging in…", "ok");
      await doLogin(email, password);
    } catch (e) { setStatus(el("authStatus"), "Register failed: " + e.message, "err"); }
  };

  el("loginBtn").onclick = function () { doLogin(el("email").value.trim(), el("password").value); };

  async function doLogin(email, password) {
    try {
      var data = await api("/login", { method: "POST", body: { email: email, password: password } });
      state.token = data.token; state.user = data.user;
      setStatus(el("authStatus"), "Signed in as " + data.user.email + (data.user.isAdmin ? " (admin)" : ""), "ok");
      refreshAccess(); await loadUsage(); await loadSets();
    } catch (e) { setStatus(el("authStatus"), "Login failed: " + e.message, "err"); }
  }

  el("logoutBtn").onclick = function () {
    state.token = null; state.user = null;
    el("messages").innerHTML = "";
    setStatus(el("authStatus"), "Signed out.", "");
    refreshAccess(); loadUsage();
  };

  el("uploadBtn").onclick = async function () {
    var input = el("files");
    if (!input.files || input.files.length === 0) {
      setStatus(el("uploadStatus"), "Choose at least one file.", "err"); return;
    }
    var form = new FormData();
    form.append("name", el("setName").value.trim() || "Untitled set");
    for (var i = 0; i < input.files.length; i++) form.append("files", input.files[i]);
    setStatus(el("uploadStatus"), "Uploading and indexing…", "");
    el("uploadBtn").disabled = true;
    try {
      var data = await api("/docs", { method: "POST", body: form });
      var total = data.files.reduce(function (a, f) { return a + f.chunks; }, 0);
      setStatus(el("uploadStatus"),
        "Indexed set with " + data.files.length + " file(s), " + total + " chunks. " +
        data.files.map(function (f) { return f.name + " (" + f.pages + "p)"; }).join(", "), "ok");
      input.value = ""; el("setName").value = "";
      await loadSets();
    } catch (e) {
      setStatus(el("uploadStatus"), "Upload failed: " + e.message, "err");
    } finally { el("uploadBtn").disabled = false; }
  };

  el("askBtn").onclick = ask;
  el("question").addEventListener("keydown", function (e) { if (e.key === "Enter") ask(); });

  async function ask() {
    var setId = el("setSelect").value;
    var question = el("question").value.trim();
    if (!setId) { setStatus(el("uploadStatus"), "Upload a document set first.", "err"); return; }
    if (question.length < 3) return;

    addUserMessage(question);
    el("question").value = "";
    el("askBtn").disabled = true;
    var pending = addAssistantMessage("Searching your documents…", null);

    try {
      var data = await api("/chat", { method: "POST", body: { setId: setId, question: question } });
      renderAnswer(pending, data);
      await loadUsage();
    } catch (e) {
      pending.querySelector(".answer").textContent =
        "Request failed (" + (e.status || "?") + "): " + e.message;
    } finally { el("askBtn").disabled = false; }
  }

  function addUserMessage(text) {
    var div = document.createElement("div");
    div.className = "msg user";
    div.innerHTML = '<div class="role">you</div><div class="answer">' + escapeHtml(text) + "</div>";
    el("messages").appendChild(div);
    return div;
  }

  function addAssistantMessage(text) {
    var div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = '<div class="role">documind</div><div class="answer">' + escapeHtml(text) + "</div>";
    el("messages").appendChild(div);
    div.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return div;
  }

  function renderAnswer(node, data) {
    var answerEl = node.querySelector(".answer");
    answerEl.innerHTML = linkifySources(escapeHtml(data.answer));

    var meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML =
      '<span class="badge ' + (data.answerMode === "llm" ? "badge-warn" : "badge-ok") + '">answerMode: ' + data.answerMode + "</span>" +
      '<span class="badge ' + (data.cached ? "badge-warn" : "badge-muted") + '">cached: ' + data.cached + "</span>" +
      '<span class="badge badge-muted">latency: ' + data.latencyMs + " ms</span>" +
      '<span class="badge badge-muted">citations: ' + data.citations.length + "</span>";
    node.appendChild(meta);

    if (data.citations && data.citations.length) {
      var list = document.createElement("div");
      list.className = "citations";
      data.citations.forEach(function (c) {
        var row = document.createElement("div");
        row.className = "citation";
        row.innerHTML = "<strong>" + escapeHtml(c.fileName) + " — p." + c.page + "</strong> " +
          '<span class="badge badge-muted">score ' + c.score + "</span><br>" + escapeHtml(c.snippet);
        list.appendChild(row);
      });
      node.appendChild(list);
    }

    var thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    var up = document.createElement("button");
    up.className = "btn"; up.textContent = "👍 Helpful";
    var down = document.createElement("button");
    down.className = "btn"; down.textContent = "👎 Not helpful";
    function send(v) {
      api("/chat/" + data.id + "/feedback", { method: "POST", body: { thumbs: v } })
        .then(function () { up.disabled = down.disabled = true; up.textContent = v === 1 ? "👍 Thanks!" : up.textContent; down.textContent = v === -1 ? "👎 Thanks!" : down.textContent; })
        .catch(function (e) { alert("Feedback failed: " + e.message); });
    }
    up.onclick = function () { send(1); };
    down.onclick = function () { send(-1); };
    thumbs.appendChild(up); thumbs.appendChild(down);
    node.appendChild(thumbs);
    node.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /** Turn "[source: file, p.3]" markers into highlighted spans (text is already escaped). */
  function linkifySources(escaped) {
    return escaped.replace(/\[source:\s*([^\]]+)\]/g, function (_m, inner) {
      return '<span class="badge badge-muted">[source: ' + inner + "]</span>";
    });
  }

  // Boot
  refreshAccess();
  loadConfig();
  loadUsage();
})();
