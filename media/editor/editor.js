(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const logo = document.body.dataset.logo || "";
  const saved = vscode.getState() || {};
  const ui = { mode: saved.mode === "raw" ? "raw" : "vars", reveal: !!saved.reveal, shown: new Set(), filter: "" };
  const isMac = navigator.platform.toUpperCase().includes("MAC");

  let text = "";
  let view = null;
  let entries = [];
  let renderLater = false;

  //Icons
  const svg = (paths, extra = "") => `<svg class="i ${extra}" viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;
  const CLOUD = '<path d="M4.6 12.5h6.9a2.9 2.9 0 0 0 .5-5.76 4 4 0 0 0-7.7 1A2.4 2.4 0 0 0 4.6 12.5z"/>';
  const SYNC = '<path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5M11.8 2v2.7H9.1M4.2 14v-2.7h2.7"/>';
  const icons = {
    push: svg(`${CLOUD}<path d="M8 11V7.4M6.6 8.7 8 7.3l1.4 1.4"/>`),
    pull: svg(`${CLOUD}<path d="M8 7.2v3.7M6.6 9.6 8 11l1.4-1.4"/>`),
    compare: svg('<rect x="2.5" y="3" width="4.5" height="10" rx="1"/><rect x="9" y="3" width="4.5" height="10" rx="1"/>'),
    history: svg('<path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8M2.6 2.6v2.6h2.6M8 5v3.2l2 1.3"/>'),
    check: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
    okCloud: svg(`${CLOUD}<path d="M6.2 9.4l1.3 1.2 2.4-2.6"/>`),
    sync: svg(SYNC, "spin"),
    warn: svg('<path d="M8 2.5 14 13H2zM8 6.5v3M8 11.2v.2"/>'),
    error: svg('<circle cx="8" cy="8" r="5.5"/><path d="M6 6l4 4M10 6l-4 4"/>'),
    info: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3v3.5M8 5.2v.2"/>'),
    lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
    slash: svg('<circle cx="8" cy="8" r="5.2"/><path d="M4.4 11.6l7.2-7.2"/>'),
    eye: svg('<path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="1.8"/>'),
    eyeOff: svg('<path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"/><path d="M3 13 13 3"/>'),
    copy: svg('<rect x="5" y="5" width="8" height="8.5" rx="1.2"/><path d="M3 10.5V3.8C3 3.3 3.3 3 3.8 3H10"/>'),
    trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
    plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
    search: svg('<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>'),
    code: svg('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
    list: svg('<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8"/><circle cx="2.8" cy="4.5" r=".6"/><circle cx="2.8" cy="8" r=".6"/><circle cx="2.8" cy="11.5" r=".6"/>'),
    raw: svg('<path d="M3 4h10M3 7h7M3 10h10M3 13h5"/>'),
  };

  const STATUS_ICON = {
    synced: icons.okCloud,
    pending: icons.push,
    uploading: icons.sync,
    downloading: icons.sync,
    remoteNewer: icons.pull,
    conflict: icons.warn,
    error: icons.error,
    untracked: icons.slash,
    missingLocal: icons.pull,
    excluded: icons.slash,
  };

  //Helpers
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const post = (message) => vscode.postMessage(message);
  const command = (id) => post({ type: "command", id });
  const $ = (id) => document.getElementById(id);
  const persist = () => vscode.setState({ mode: ui.mode, reveal: ui.reveal });

  //Parsing
  const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
  const LINE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/;

  function parseValue(raw) {
    const quote = raw[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      for (let i = 1; i < raw.length; i++) {
        if (raw[i] === "\\" && quote === '"') {
          i++;
          continue;
        }
        if (raw[i] === quote) return { value: raw.slice(1, i), quote, rest: raw.slice(i + 1) };
      }
    }
    const hash = raw.search(/\s#/);
    if (hash >= 0) return { value: raw.slice(0, hash).trimEnd(), quote: "", rest: raw.slice(raw.slice(0, hash).trimEnd().length) };
    return { value: raw.trimEnd(), quote: "", rest: raw.slice(raw.trimEnd().length) };
  }

  function parse(source) {
    return source.split("\n").map((raw, index) => {
      const match = raw.match(LINE);
      if (match) {
        const value = parseValue(match[5]);
        return { kind: "var", index, indent: match[1], exp: match[2] || "", key: match[3], sep: match[4], ...value };
      }
      if (/^\s*#/.test(raw)) return { kind: "comment", index, text: raw.replace(/^\s*#+\s?/, "") };
      return { kind: raw.trim() ? "other" : "blank", index, raw };
    });
  }

  function format(entry) {
    let quote = entry.quote;
    if (!quote && (/\s/.test(entry.value) || /^[#"'`]/.test(entry.value))) quote = entry.value.includes('"') ? "'" : '"';
    return `${entry.indent}${entry.exp}${entry.key}${entry.sep}${quote}${entry.value}${quote}${entry.rest}`;
  }

  function setLine(index, line) {
    const lines = text.split("\n");
    if (line === null) lines.splice(index, 1);
    else lines[index] = line;
    commit(lines.join("\n"));
  }

  function commit(next) {
    text = next;
    entries = parse(text);
    post({ type: "edit", text });
    renderFoot();
  }

  //Shell
  function renderShell() {
    app.innerHTML = `
      <header class="top" id="head"></header>
      <nav class="toolbar" id="toolbar"></nav>
      <div id="banner"></div>
      <main id="main"></main>
      <footer class="foot" id="foot"></footer>`;
  }

  function renderHead() {
    const status = view.session === "unlocked" ? view.status : view.session;
    const icon = view.session === "unlocked" ? STATUS_ICON[view.status] || icons.info : icons.lock;
    const label = view.session === "unlocked" ? view.headline : view.session === "locked" ? "Locked" : "Not set up";
    $("head").innerHTML = `
      <div class="title">
        <img class="logo" src="${esc(logo)}" alt="">
        <div class="names"><h1>${esc(view.name)}</h1><p>${esc(view.path)}</p></div>
      </div>
      <button class="pill pill-${esc(status)}" id="pill" type="button" title="${esc(view.detail)}">${icon}<span>${esc(label)}</span></button>`;
    $("pill").addEventListener("click", () => command(view.session === "unlocked" ? "menu" : view.session === "locked" ? "unlock" : "setup"));
  }

  function renderToolbar() {
    const ready = view.session === "unlocked" && view.status !== "excluded";
    const busy = view.status === "uploading" || view.status === "downloading";
    const canPush = ready && !busy && ["synced", "pending", "error", "untracked"].includes(view.status);
    const canPull = ready && !busy && view.hasRemote && view.status !== "conflict";
    const canCloud = ready && view.hasRemote;
    const pushLabel = view.status === "untracked" ? "Back up" : "Push";
    const tool = (id, label, icon, enabled, hint) =>
      `<button class="tool tool-${id}" data-cmd="${id}" type="button" ${enabled ? "" : "disabled"} title="${esc(hint)}"><span class="tile">${icon}</span>${label}</button>`;
    $("toolbar").innerHTML = `
      <div class="tools">
        ${tool(view.status === "untracked" ? "track" : "push", pushLabel, icons.push, canPush, "Upload this file to your Google Drive")}
        ${tool("pull", "Pull", icons.pull, canPull, "Replace this file with the cloud copy")}
        ${tool("compare", "Compare", icons.compare, canCloud, "Compare this file with the cloud copy")}
        ${tool("history", "History", icons.history, canCloud, "Browse and restore earlier versions")}
      </div>
      <div class="views">
        <div class="seg" role="tablist" aria-label="View">
          <button type="button" role="tab" data-mode="vars" aria-selected="${ui.mode === "vars"}">${icons.list}Variables</button>
          <button type="button" role="tab" data-mode="raw" aria-selected="${ui.mode === "raw"}">${icons.raw}Raw</button>
        </div>
        <button class="icon-btn" data-cmd="text" type="button" title="Open in the standard text editor" aria-label="Open in text editor">${icons.code}</button>
      </div>`;
    $("toolbar").querySelectorAll("[data-cmd]").forEach((el) => el.addEventListener("click", () => command(el.dataset.cmd)));
    $("toolbar").querySelectorAll("[data-mode]").forEach((el) =>
      el.addEventListener("click", () => {
        if (ui.mode === el.dataset.mode) return;
        ui.mode = el.dataset.mode;
        persist();
        renderToolbar();
        renderMain();
      }),
    );
  }

  function renderBanner() {
    const banner = (tone, icon, message, actions) =>
      `<div class="banner banner-${tone}" role="status">${icon}<span class="msg">${message}</span><span class="actions">${actions
        .map(([id, label, primary]) => `<button type="button" class="${primary ? "btn" : "btn ghost"}" data-cmd="${id}">${label}</button>`)
        .join("")}</span></div>`;
    let html = "";
    if (view.session === "disconnected" || view.session === "noVault") {
      html = banner("info", icons.info, "Hush isn't set up yet. Set it up to keep a private backup of this file.", [["setup", "Set up Hush", true]]);
    } else if (view.session === "locked") {
      html = banner("info", icons.lock, "Hush is locked on this computer. Unlock it to back up this file.", [["unlock", "Unlock", true]]);
    } else if (view.status === "excluded") {
      html = banner("muted", icons.slash, "Hush doesn't back up this file because of your include and exclude settings.", [["settings", "Settings", false]]);
    } else if (view.status === "untracked") {
      html = banner("muted", icons.slash, "This file isn't backed up.", [["track", "Back up this file", true]]);
    } else if (view.status === "conflict") {
      html = banner("warn", icons.warn, "This file changed here and in the cloud. Backups are paused until you choose a version.", [
        ["compare", "Compare", false],
        ["useCloud", "Use cloud", false],
        ["keepLocal", "Keep this device", true],
      ]);
    } else if (view.status === "remoteNewer") {
      html = banner("info", icons.pull, "A newer version of this file is in the cloud.", [
        ["compare", "Compare", false],
        ["pull", "Pull", true],
      ]);
    } else if (view.status === "error") {
      html = banner("error", icons.error, esc(view.detail), [["push", "Retry", true]]);
    } else if (view.gitIgnored === false) {
      html = banner("warn", icons.warn, "This file isn't in .gitignore, so it could be committed to git.", [["gitignore", "Add to .gitignore", true]]);
    }
    $("banner").innerHTML = html;
    $("banner").querySelectorAll("[data-cmd]").forEach((el) => el.addEventListener("click", () => command(el.dataset.cmd)));
  }

  function renderFoot() {
    const vars = entries.filter((entry) => entry.kind === "var").length;
    const save = isMac ? "⌘S" : "Ctrl+S";
    $("foot").innerHTML = `
      <span>${plural(vars, "variable")}</span>
      <span class="${view && view.dirty ? "dirty" : ""}">${view && view.dirty ? `Unsaved changes · ${save} to save and back up` : "All changes saved"}</span>`;
  }

  //Variables view
  function renderVars() {
    const counts = {};
    for (const entry of entries) if (entry.kind === "var") counts[entry.key] = (counts[entry.key] || 0) + 1;
    const filter = ui.filter.trim().toLowerCase();
    const visible = entries.filter((entry) => {
      if (entry.kind === "blank") return false;
      if (!filter) return true;
      return entry.kind === "var" && entry.key.toLowerCase().includes(filter);
    });
    const others = entries.filter((entry) => entry.kind === "other").length;

    const rows = visible
      .map((entry) => {
        if (entry.kind === "comment") return `<div class="section">${esc(entry.text) || "&nbsp;"}</div>`;
        if (entry.kind === "other") return `<div class="row row-other"><code>${esc(entry.raw)}</code><span class="hint">Edit in Raw view</span></div>`;
        const shown = ui.reveal || ui.shown.has(entry.index);
        const dup = counts[entry.key] > 1;
        return `<div class="row" data-index="${entry.index}">
          <span class="key-wrap">
            <input class="key" value="${esc(entry.key)}" spellcheck="false" autocomplete="off" aria-label="Name">
            ${dup ? `<span class="dup" title="Duplicate name. The last one wins.">${icons.warn}</span>` : ""}
          </span>
          <span class="value-wrap">
            <input class="value ${shown ? "" : "masked"}" value="${esc(entry.value)}" spellcheck="false" autocomplete="off" placeholder="empty" aria-label="Value of ${esc(entry.key)}">
            <button class="mini" data-act="eye" type="button" title="${shown ? "Hide" : "Show"} value" aria-label="${shown ? "Hide" : "Show"} value">${shown ? icons.eyeOff : icons.eye}</button>
          </span>
          <span class="row-actions">
            <button class="mini" data-act="copy" type="button" title="Copy value" aria-label="Copy value">${icons.copy}</button>
            <button class="mini danger" data-act="delete" type="button" title="Delete variable" aria-label="Delete variable">${icons.trash}</button>
          </span>
        </div>`;
      })
      .join("");

    const empty = !entries.some((entry) => entry.kind === "var")
      ? `<div class="empty"><div class="empty-icon">${icons.list}</div><h2>No variables yet</h2><p>Add your first variable, or paste your file in the Raw view.</p></div>`
      : !visible.length
        ? `<div class="empty small"><p>No variables match "${esc(ui.filter)}".</p></div>`
        : "";

    $("main").className = "vars";
    $("main").innerHTML = `
      <div class="vars-bar">
        <label class="search">${icons.search}<input id="filter" type="search" placeholder="Filter by name" value="${esc(ui.filter)}" spellcheck="false" aria-label="Filter variables"></label>
        <button class="chip ${ui.reveal ? "on" : ""}" id="reveal" type="button">${ui.reveal ? icons.eyeOff : icons.eye}${ui.reveal ? "Hide values" : "Show values"}</button>
        <button class="btn" id="add" type="button">${icons.plus}Add variable</button>
      </div>
      <div class="list">${rows}${empty}</div>
      ${others ? `<p class="note">${plural(others, "line")} can only be edited in the Raw view.</p>` : ""}`;
    bindVars();
  }

  function bindVars() {
    $("filter").addEventListener("input", (event) => {
      ui.filter = event.target.value;
      const caret = event.target.selectionStart;
      renderVars();
      const input = $("filter");
      input.focus();
      input.setSelectionRange(caret, caret);
    });
    $("reveal").addEventListener("click", () => {
      ui.reveal = !ui.reveal;
      ui.shown.clear();
      persist();
      renderVars();
    });
    $("add").addEventListener("click", addVariable);

    $("main").querySelectorAll(".row[data-index]").forEach((row) => {
      const index = Number(row.dataset.index);
      const entry = () => entries.find((item) => item.index === index && item.kind === "var");
      const key = row.querySelector(".key");
      const value = row.querySelector(".value");
      key.addEventListener("input", () => {
        const valid = KEY.test(key.value);
        key.classList.toggle("invalid", !valid);
        key.title = valid ? "" : "Use letters, numbers and underscores. Don't start with a number.";
        const current = entry();
        if (valid && current) setLine(index, format({ ...current, key: key.value }));
      });
      value.addEventListener("input", () => {
        const current = entry();
        if (current) setLine(index, format({ ...current, value: value.value }));
      });
      row.querySelector('[data-act="eye"]').addEventListener("click", () => {
        if (ui.shown.has(index)) ui.shown.delete(index);
        else ui.shown.add(index);
        renderVars();
      });
      row.querySelector('[data-act="copy"]').addEventListener("click", () => {
        const current = entry();
        if (current) post({ type: "copy", value: current.value });
      });
      row.querySelector('[data-act="delete"]').addEventListener("click", () => {
        ui.shown.clear();
        setLine(index, null);
        renderVars();
      });
    });
  }

  function addVariable() {
    const names = new Set(entries.filter((entry) => entry.kind === "var").map((entry) => entry.key));
    let name = "NEW_VARIABLE";
    for (let n = 2; names.has(name); n++) name = `NEW_VARIABLE_${n}`;
    const base = text && !text.endsWith("\n") ? `${text}\n` : text;
    const lines = base.split("\n");
    const index = lines.length - 1;
    ui.filter = "";
    commit(`${base}${name}=\n`);
    ui.shown.add(index);
    renderVars();
    const input = $("main").querySelector(`.row[data-index="${index}"] .key`);
    if (input) {
      input.focus();
      input.select();
    }
  }

  //Raw view
  function highlight(source) {
    return source
      .split("\n")
      .map((raw) => {
        const match = raw.match(LINE);
        if (match) {
          const value = parseValue(match[5]);
          const shownValue = value.quote ? `${value.quote}${value.value}${value.quote}` : value.value;
          return `${esc(match[1])}${match[2] ? `<span class="t-x">${esc(match[2])}</span>` : ""}<span class="t-k">${esc(match[3])}</span><span class="t-o">${esc(match[4])}</span><span class="t-v">${esc(shownValue)}</span><span class="t-c">${esc(value.rest)}</span>`;
        }
        if (/^\s*#/.test(raw)) return `<span class="t-c">${esc(raw)}</span>`;
        return esc(raw);
      })
      .join("\n");
  }

  function renderRaw() {
    $("main").className = "raw-main";
    $("main").innerHTML = `
      <div class="raw">
        <div class="gutter" id="gutter" aria-hidden="true"></div>
        <div class="code">
          <pre class="hl" id="hl" aria-hidden="true"></pre>
          <textarea id="src" wrap="off" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="File contents"></textarea>
        </div>
      </div>`;
    const area = $("src");
    area.value = text;
    paintRaw();
    area.addEventListener("input", () => {
      commit(area.value);
      paintRaw();
    });
    area.addEventListener("scroll", syncScroll);
    area.addEventListener("keydown", (event) => {
      if (event.key !== "Tab" || event.shiftKey) return;
      event.preventDefault();
      const start = area.selectionStart;
      area.setRangeText("  ", start, area.selectionEnd, "end");
      commit(area.value);
      paintRaw();
    });
  }

  function paintRaw() {
    const lines = text.split("\n").length;
    $("hl").innerHTML = `${highlight(text)}\n`;
    $("gutter").innerHTML = Array.from({ length: lines }, (_, i) => `<span>${i + 1}</span>`).join("");
    syncScroll();
  }

  function syncScroll() {
    const area = $("src");
    if (!area) return;
    $("hl").scrollTop = area.scrollTop;
    $("hl").scrollLeft = area.scrollLeft;
    $("gutter").scrollTop = area.scrollTop;
  }

  function renderMain() {
    if (ui.mode === "raw") renderRaw();
    else renderVars();
  }

  //External text
  function applyExternal(next) {
    if (next === text) return;
    text = next;
    entries = parse(text);
    renderFoot();
    if (ui.mode === "raw") {
      const area = $("src");
      const start = area.selectionStart;
      const end = area.selectionEnd;
      area.value = text;
      area.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
      paintRaw();
      return;
    }
    if (app.contains(document.activeElement) && document.activeElement.matches(".row input")) {
      renderLater = true;
      return;
    }
    renderVars();
  }

  document.addEventListener("focusout", () => {
    if (!renderLater) return;
    setTimeout(() => {
      if (document.activeElement && document.activeElement.matches(".row input")) return;
      renderLater = false;
      if (ui.mode === "vars") renderVars();
    }, 0);
  });

  //Messages
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.view) view = message.view;
    if (message.type === "init") {
      text = message.text;
      entries = parse(text);
      renderShell();
      renderHead();
      renderToolbar();
      renderBanner();
      renderMain();
      renderFoot();
      return;
    }
    if (!$("head")) return;
    if (message.type === "text") applyExternal(message.text);
    renderHead();
    renderToolbar();
    renderBanner();
    renderFoot();
  });

  post({ type: "ready" });
})();
