"use strict";

(() => {
  const $ = (sel) => document.querySelector(sel);
  const MINE_KEY = "printdrop.myJobs";
  const NAME_KEY = "printdrop.name";

  const el = {
    printerName: $("#printer-name"),
    pill: $("#status-pill"),
    pillText: $("#status-pill .pill-text"),
    dropzone: $("#dropzone"),
    fileInput: $("#file-input"),
    fileList: $("#file-list"),
    typesHint: $("#types-hint"),
    presets: $("#presets"),
    size: $("#opt-size"),
    tray: $("#opt-tray"),
    media: $("#opt-media"),
    copies: $("#opt-copies"),
    pages: $("#opt-pages"),
    scaling: $("#opt-scaling"),
    flip: $("#opt-flip"),
    policy: $("#opt-policy"),
    pin: $("#opt-pin"),
    user: $("#opt-user"),
    printNow: $("#opt-print-now"),
    bypassNote: $("#bypass-note"),
    bypassTitle: $("#bypass-title"),
    bypassText: $("#bypass-text"),
    printBtn: $("#print-btn"),
    formError: $("#form-error"),
    printerPanel: $("#printer-panel"),
    alerts: $("#alerts"),
    trays: $("#trays"),
    toner: $("#toner"),
    jobs: $("#jobs"),
    jobsEmpty: $("#jobs-empty"),
    waiting: $("#waiting"),
    waitingJobs: $("#waiting-jobs"),
    foldersHelp: $("#folders-help"),
    webLink: $("#web-link"),
    template: $("#job-template"),
  };

  let config = null;
  let files = [];
  let lastJobs = [];
  let lastStatus = null;
  let busy = false;

  // ---------------------------------------------------------------- helpers
  const api = async (path, options = {}) => {
    const res = await fetch(path, options);
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const detail = body && (typeof body.detail === "string" ? body.detail : null);
      throw new Error(detail || `Something went wrong (${res.status}).`);
    }
    return body;
  };

  const mine = () => new Set(JSON.parse(localStorage.getItem(MINE_KEY) || "[]"));
  const rememberMine = (ids) => {
    const list = [...ids, ...mine()].slice(0, 100);
    localStorage.setItem(MINE_KEY, JSON.stringify(list));
  };

  const formatBytes = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;

  const timeAgo = (seconds) => {
    const diff = Date.now() / 1000 - seconds;
    if (diff < 45) return "just now";
    if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
    return new Date(seconds * 1000).toLocaleDateString();
  };

  let toastTimer = null;
  const toast = (text) => {
    let node = $(".toast");
    if (!node) {
      node = document.createElement("div");
      node.className = "toast";
      node.setAttribute("role", "status");
      document.body.append(node);
    }
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 5000);
  };

  const option = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  };

  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
  const setRadio = (name, value) => {
    const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  };

  const sizeInfo = (id) => config.page_sizes.find((s) => s.id === id);
  const sizeLabel = (id) => sizeInfo(id)?.label ?? id;
  const mediaLabel = (id) => config.media_types.find((m) => m.id === id)?.label ?? id;

  // ---------------------------------------------------------------- settings
  const readSettings = () => {
    const twoSided = radio("sides") !== "None";
    const settings = {
      PageSize: el.size.value,
      InputSlot: el.tray.value,
      MediaType: el.media.value,
      ColorModel: radio("color"),
      Duplex: twoSided ? el.flip.value : "None",
      RIPaperPolicy: el.policy.value,
      scaling: el.scaling.value,
      copies: Math.max(1, Math.min(999, parseInt(el.copies.value, 10) || 1)),
      page_ranges: el.pages.value.trim(),
      pin: el.pin.value.trim(),
    };
    if (routesToBypass(settings).bypass && el.printNow.checked) settings.hold = false;
    return settings;
  };

  const applySettings = (settings) => {
    const s = { ...config.defaults, ...settings };
    el.size.value = s.PageSize;
    el.tray.value = s.InputSlot;
    el.media.value = s.MediaType;
    setRadio("color", s.ColorModel);
    setRadio("sides", s.Duplex === "None" ? "None" : "DuplexNoTumble");
    if (s.Duplex !== "None") el.flip.value = s.Duplex;
    el.policy.value = s.RIPaperPolicy;
    el.scaling.value = s.scaling;
    el.printNow.checked = false;
    refresh();
  };

  const presetMatches = (preset) => {
    const current = readSettings();
    const wanted = { ...config.defaults, ...preset.settings };
    return ["PageSize", "InputSlot", "MediaType", "ColorModel", "Duplex"].every((k) => String(current[k]) === String(wanted[k]));
  };

  // Mirrors the server's routing so people see the bypass instructions before printing.
  const routesToBypass = (s) => {
    const bypassTray = config.bypass.tray;
    if (s.InputSlot === bypassTray) return { bypass: true, reason: null };
    if (s.InputSlot !== "Auto" || !config.bypass.auto_route) return { bypass: false };
    if (s.PageSize !== "auto" && config.drawer_sizes.length && !config.drawer_sizes.includes(s.PageSize)) {
      return { bypass: true, reason: `None of the drawers holds ${sizeLabel(s.PageSize).split(" (")[0]} paper.` };
    }
    if (s.MediaType !== "Auto") return { bypass: true, reason: "Special paper goes through the bypass tray." };
    return { bypass: false };
  };

  const loadText = (sizeId, mediaId) => {
    const info = sizeInfo(sizeId);
    const size = sizeId === "auto" ? "paper the size of your file" : `${sizeLabel(sizeId).split(" (")[0]}`;
    const media = mediaId === "Auto" ? "plain paper" : mediaLabel(mediaId);
    let text = sizeId === "auto" ? size : `${size} ${media}`;
    if (info?.custom) text += `, ${info.feed_edge_in}-inch edge going in first`;
    return text;
  };

  const refresh = () => {
    const s = readSettings();
    for (const chip of el.presets.children) {
      const preset = config.presets[Number(chip.dataset.index)];
      chip.setAttribute("aria-pressed", String(presetMatches(preset)));
    }
    const route = routesToBypass(s);
    el.bypassNote.hidden = !route.bypass;
    const hold = config.bypass.hold_until_released;
    el.printNow.closest("label").hidden = !hold;
    if (route.bypass) {
      const load = loadText(s.PageSize, s.MediaType);
      el.bypassTitle.textContent = "This goes through the bypass tray";
      const lead = route.reason ? `${route.reason} ` : "";
      el.bypassText.textContent = hold && !el.printNow.checked
        ? `${lead}It will wait here until you're at the printer. Load ${load}, then tap Print now on this page (your phone works too).`
        : `${lead}Load ${load} in the bypass tray before you print.`;
    }
    const count = files.length;
    const waits = route.bypass && hold && !el.printNow.checked;
    el.printBtn.disabled = busy || count === 0;
    el.printBtn.textContent = busy ? "Sending…"
      : waits ? (count > 1 ? `Send ${count} files (they'll wait for you)` : "Send (it'll wait for you)")
      : count > 1 ? `Print ${count} files` : "Print";
  };

  // ---------------------------------------------------------------- files
  const addFiles = (list) => {
    for (const f of list) {
      if (!files.some((x) => x.name === f.name && x.size === f.size)) files.push(f);
    }
    renderFiles();
  };

  const renderFiles = () => {
    el.fileList.replaceChildren(...files.map((f, i) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = f.name;
      const size = document.createElement("span");
      size.className = "size muted";
      size.textContent = formatBytes(f.size);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-btn";
      remove.setAttribute("aria-label", `Remove ${f.name}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => { files.splice(i, 1); renderFiles(); });
      li.append(name, size, remove);
      return li;
    }));
    refresh();
  };

  const showError = (text) => {
    el.formError.textContent = text || "";
    el.formError.hidden = !text;
  };

  const submit = async () => {
    if (!files.length || busy) return;
    const settings = readSettings();
    if (settings.pin && !/^\d{4,8}$/.test(settings.pin)) {
      showError("The PIN must be 4 to 8 digits.");
      el.pin.focus();
      return;
    }
    showError("");
    busy = true;
    refresh();
    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));
    form.append("settings", JSON.stringify(settings));
    form.append("user", el.user.value.trim());
    try {
      const result = await api("/api/jobs", { method: "POST", body: form });
      rememberMine(result.jobs.map((j) => j.id));
      const n = result.jobs.length;
      const waits = routesToBypass(settings).bypass && config.bypass.hold_until_released && settings.hold !== false;
      toast(waits ? "Sent. Load the bypass paper, then tap Print now." : n > 1 ? `${n} files sent to the printer.` : "Sent to the printer.");
      files = [];
      el.pin.value = "";
      renderFiles();
      await loadJobs();
    } catch (err) {
      showError(err.message);
    } finally {
      busy = false;
      refresh();
    }
  };

  // ---------------------------------------------------------------- jobs
  const STATE_LABEL = {
    received: "Received", preparing: "Preparing", queued: "In line", printing: "Sending",
    held: "Waiting for paper", sent: "Sent to printer", failed: "Didn't print", canceled: "Canceled",
  };

  const jobAction = async (job, action) => {
    try {
      const body = action === "reprint" ? (() => { const f = new FormData(); f.append("user", el.user.value.trim()); return f; })() : undefined;
      const result = await api(`/api/jobs/${job.id}/${action}`, { method: "POST", body });
      if (action === "reprint") {
        rememberMine([result.id]);
        toast("Printing it again.");
      } else if (action === "release") {
        toast("Printing now.");
      }
      await loadJobs();
    } catch (err) {
      toast(err.message);
    }
  };

  const renderJob = (job, myIds) => {
    const node = el.template.content.firstElementChild.cloneNode(true);
    node.classList.add(job.state);
    if (myIds.has(job.id)) node.classList.add("mine");
    node.querySelector(".job-name").textContent = job.filename;
    node.querySelector(".job-name").title = job.filename;
    const badge = node.querySelector(".badge");
    badge.textContent = STATE_LABEL[job.state] || job.state;
    badge.classList.add(job.state === "sent" ? "sent" : job.state === "held" ? "held" : job.state === "failed" ? "failed" : job.can_cancel ? "active" : "done");
    const who = myIds.has(job.id) ? "You" : job.user || "Someone";
    const pages = job.pages ? ` · ${job.pages} page${job.pages === 1 ? "" : "s"}` : "";
    node.querySelector(".job-meta").textContent = `${who} · ${timeAgo(job.created)}${pages}`;
    node.querySelector(".job-summary").textContent = job.summary || "";
    const message = node.querySelector(".job-message");
    if (job.state !== "held" && job.state !== "sent") message.textContent = job.message || "";

    if (job.state === "held" && job.load) {
      const load = node.querySelector(".job-load");
      load.hidden = false;
      load.querySelector(".load-size").textContent = job.load.size;
      load.querySelector(".load-media").textContent = job.load.media;
      if (job.load.feed_edge_in) {
        load.querySelector(".load-edge").textContent = `${job.load.feed_edge_in}-inch edge in first`;
      } else {
        load.querySelector(".load-edge-row").hidden = true;
      }
    }

    const actions = node.querySelector(".job-actions");
    const button = (label, action, cls) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener("click", () => { b.disabled = true; jobAction(job, action); });
      actions.append(b);
    };
    if (job.can_release) button("Paper's loaded, print now", "release", "go");
    if (job.can_cancel) button("Cancel", "cancel");
    if (job.can_reprint) button("Print again", "reprint");
    return node;
  };

  const renderJobs = (jobs) => {
    const myIds = mine();
    const held = jobs.filter((j) => j.state === "held");
    // Held jobs go in the strip at the top; mine first.
    held.sort((a, b) => Number(myIds.has(b.id)) - Number(myIds.has(a.id)) || a.created - b.created);
    el.waiting.hidden = held.length === 0;
    el.waitingJobs.replaceChildren(...held.map((j) => renderJob(j, myIds)));
    const rest = jobs.filter((j) => j.state !== "held");
    el.jobs.replaceChildren(...rest.map((j) => renderJob(j, myIds)));
    el.jobsEmpty.hidden = rest.length > 0;
  };

  const loadJobs = async () => {
    try {
      const data = await api("/api/jobs");
      lastJobs = data.jobs;
      renderJobs(lastJobs);
      renderPill();
    } catch { /* keep showing the last list */ }
  };

  // ---------------------------------------------------------------- status
  const setPill = (kind, text) => {
    el.pill.className = `pill ${kind}`;
    el.pillText.textContent = text;
  };

  const renderPill = () => {
    if (!lastStatus) return;
    const { queue, device } = lastStatus;
    const errors = (device.alerts || []).filter((a) => a.level === "error");
    const warnings = (device.alerts || []).filter((a) => a.level !== "error");
    const unreachable = lastJobs.some((j) => j.can_cancel && /can't reach/i.test(j.message || ""));
    if (!queue.ok) return setPill("bad", "Print queue isn't set up");
    if (errors.length) return setPill("bad", errors[0].text.replace(/\.$/, ""));
    if (unreachable) return setPill("bad", "Can't reach the printer");
    if (queue.state === "stopped") return setPill("warn", "Print queue paused");
    if (queue.state === "processing" || lastJobs.some((j) => ["queued", "printing", "preparing"].includes(j.state))) {
      return setPill("busy", "Printing…");
    }
    if (warnings.length) return setPill("warn", warnings[0].text.replace(/\.$/, ""));
    setPill("ok", "Ready");
  };

  const renderPrinterPanel = () => {
    const { device } = lastStatus;
    const show = device.reachable;
    el.printerPanel.hidden = !show;
    if (!show) return;
    el.alerts.replaceChildren(...(device.alerts || []).map((a) => {
      const li = document.createElement("li");
      li.className = a.level === "error" ? "error" : "warning";
      li.textContent = a.text;
      return li;
    }));
    el.trays.replaceChildren(...(device.trays || []).map((t) => {
      const row = document.createElement("div");
      row.className = "tray-row";
      const name = document.createElement("span");
      name.textContent = t.name;
      const state = document.createElement("span");
      state.className = t.status;
      state.textContent = { empty: "Empty", low: "Low", ok: "Has paper", unknown: "" }[t.status] ?? "";
      row.append(name, state);
      return row;
    }));
    el.toner.replaceChildren(...(device.toner || []).filter((t) => t.level >= 0).map((t) => {
      const row = document.createElement("div");
      row.className = "toner-row";
      const name = document.createElement("span");
      name.textContent = t.name.replace(/ ?toner/i, "") || "Toner";
      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("span");
      fill.style.width = `${Math.max(2, Math.min(100, t.level))}%`;
      if (/^#[0-9a-f]{6}$/i.test(t.color || "")) fill.style.background = t.color;
      bar.append(fill);
      const pct = document.createElement("span");
      pct.className = "muted";
      pct.textContent = `${t.level}%`;
      row.append(name, bar, pct);
      return row;
    }));
  };

  const loadStatus = async () => {
    try {
      lastStatus = await api("/api/status");
      renderPill();
      renderPrinterPanel();
    } catch {
      setPill("bad", "PrintDrop isn't responding");
    }
  };

  // ---------------------------------------------------------------- setup
  const buildForm = () => {
    const p = config.printer;
    el.printerName.textContent = [p.name, p.location].filter(Boolean).join(" · ");
    document.title = `PrintDrop · ${p.name}`;

    el.size.replaceChildren(option("auto", "Match the file"), ...config.page_sizes.map((s) => option(s.id, s.label)));
    el.tray.replaceChildren(...config.trays.map((t) => {
      const hint = t.note && !t.bypass && t.id !== "Auto" ? ` (${t.note})` : "";
      return option(t.id, `${t.label}${hint}`);
    }));
    el.media.replaceChildren(...config.media_types.map((m) => option(m.id, m.label)));

    el.presets.replaceChildren(...config.presets.map((preset, index) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.index = index;
      chip.setAttribute("aria-pressed", "false");
      const bypass = preset.settings.InputSlot === config.bypass.tray;
      chip.textContent = preset.name.replace(/\s*\(bypass\)$/i, "");
      if (bypass) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "bypass";
        chip.append(tag);
      }
      chip.addEventListener("click", () => applySettings(preset.settings));
      return chip;
    }));

    const exts = config.extensions;
    el.fileInput.accept = exts.join(",");
    el.typesHint.textContent = config.office
      ? "PDF, Word, Excel, PowerPoint, images, text"
      : "PDF, images, text (save Office files as PDF first)";

    if (p.web_url) {
      el.webLink.href = p.web_url;
      el.webLink.hidden = false;
    }
    if (config.smb.enabled) {
      const host = location.hostname;
      el.foldersHelp.hidden = false;
      el.foldersHelp.innerHTML = "";
      const strong = document.createElement("strong");
      strong.textContent = "Drop folders: ";
      const mac = document.createElement("code");
      mac.textContent = `smb://${host}/${config.smb.share}`;
      const win = document.createElement("code");
      win.textContent = `\\\\${host}\\${config.smb.share}`;
      el.foldersHelp.append(strong, "save a file into a folder and it prints with that folder's settings. Mac: ", mac, " · Windows: ", win);
    }

    el.user.value = localStorage.getItem(NAME_KEY) || "";
    applySettings({});
  };

  const wire = () => {
    el.fileInput.addEventListener("change", () => { addFiles(el.fileInput.files); el.fileInput.value = ""; });
    el.dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); }
    });
    let depth = 0;
    window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; el.dropzone.classList.add("over"); });
    window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; el.dropzone.classList.remove("over"); } });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      el.dropzone.classList.remove("over");
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    });

    for (const input of [el.size, el.tray, el.media, el.flip, el.policy, el.scaling, el.printNow, el.pages, el.copies]) {
      input.addEventListener("change", refresh);
      input.addEventListener("input", refresh);
    }
    document.querySelectorAll('input[name="color"], input[name="sides"]').forEach((r) => r.addEventListener("change", refresh));
    document.querySelectorAll(".stepper button").forEach((b) => b.addEventListener("click", () => {
      const next = (parseInt(el.copies.value, 10) || 1) + Number(b.dataset.step);
      el.copies.value = Math.max(1, Math.min(999, next));
      refresh();
    }));
    el.user.addEventListener("change", () => localStorage.setItem(NAME_KEY, el.user.value.trim()));
    el.printBtn.addEventListener("click", submit);
    el.pill.addEventListener("click", () => {
      if (!el.printerPanel.hidden) el.printerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const poll = () => {
    const active = lastJobs.some((j) => ["received", "preparing", "queued", "printing"].includes(j.state));
    setTimeout(async () => { if (!document.hidden) await loadJobs(); poll(); }, active ? 2000 : 6000);
  };

  const start = async () => {
    try {
      config = await api("/api/config");
    } catch (err) {
      el.printerName.textContent = "Couldn't load settings. Is PrintDrop running?";
      setPill("bad", "PrintDrop isn't responding");
      return;
    }
    buildForm();
    wire();
    await Promise.all([loadJobs(), loadStatus()]);
    poll();
    setInterval(() => { if (!document.hidden) loadStatus(); }, 10000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadJobs(); loadStatus(); } });
  };

  start();
})();
