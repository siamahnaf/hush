(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const logo = document.body.dataset.logo || "";
  const MIN = 12;

  //Icons
  const svg = (paths, extra = "") => `<svg class="i ${extra}" viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`;
  const CLOUD = '<path d="M4.6 12.5h6.9a2.9 2.9 0 0 0 .5-5.76 4 4 0 0 0-7.7 1A2.4 2.4 0 0 0 4.6 12.5z"/>';
  const icons = {
    shield: svg('<path d="M8 1.8 13 3.6v4c0 3-2.2 5.3-5 6.6-2.8-1.3-5-3.6-5-6.6v-4z"/><path d="M6 8l1.5 1.5L10.2 7"/>'),
    cloud: svg(CLOUD),
    upload: svg(`${CLOUD}<path d="M8 11V7.4M6.6 8.7 8 7.3l1.4 1.4"/>`),
    sync: svg('<path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5M11.8 2v2.7H9.1M4.2 14v-2.7h2.7"/>'),
    spin: svg('<path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5M11.8 2v2.7H9.1M4.2 14v-2.7h2.7"/>', "spin"),
    warn: svg('<path d="M8 2.5 14 13H2zM8 6.5v3M8 11.2v.2"/>'),
    info: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3v3.5M8 5.2v.2"/>'),
    check: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
    lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
    eye: svg('<path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="1.8"/>'),
    eyeOff: svg('<path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"/><path d="M3 13 13 3"/>'),
  };

  let state = null;
  let signature = "";
  const ui = { step: "", connecting: false, busy: false, error: "", pass: "", confirm: "", show: false, saved: false, autoPush: true, selected: new Set(), seen: new Set() };

  //Helpers
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const send = (type, data = {}) => vscode.postMessage({ type, ...data });
  const $ = (id) => document.getElementById(id);
  const on = (id, event, handler) => {
    const el = $(id);
    if (el) el.addEventListener(event, handler);
  };
  const logoBlock = () => `<div class="logo"><img src="${esc(logo)}" alt=""></div>`;
  const account = () => (state.email ? `<p class="account">${icons.check}Connected as ${esc(state.email)}</p>` : "");
  const errorBox = () => `<div class="error" id="error" role="alert" hidden></div>`;

  function strength(value) {
    if (!value) return { score: 0, label: "" };
    let pool = 0;
    if (/[a-z]/.test(value)) pool += 26;
    if (/[A-Z]/.test(value)) pool += 26;
    if (/\d/.test(value)) pool += 10;
    if (/[^a-zA-Z0-9]/.test(value)) pool += 33;
    const words = value.trim().split(/[\s\-_.]+/).filter(Boolean).length;
    let bits = value.length * Math.log2(Math.max(pool, 2));
    if (words >= 4) bits = Math.max(bits, words * 11);
    if (/^(.)\1+$/.test(value)) bits = 4;
    const score = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
    return { score, label: ["", "Weak", "Fair", "Good", "Strong"][score] };
  }

  function steps(active) {
    const names = ["Connect", "Passphrase", "Back up"];
    const items = names.map((name, index) => {
      const n = index + 1;
      const cls = n < active ? "done" : n === active ? "on" : "";
      return `<li class="${cls}"><span>${n < active ? "✓" : n}</span>${name}</li>`;
    });
    return `<ol class="steps" aria-label="Setup progress">${items.join("")}</ol>`;
  }

  function passField(id, label, autocomplete, extra = "") {
    const type = ui.show ? "text" : "password";
    const value = id === "pass" ? ui.pass : ui.confirm;
    const toggle = id === "pass" ? `<button class="icon" id="toggle" type="button" aria-label="${ui.show ? "Hide" : "Show"} passphrase">${ui.show ? icons.eyeOff : icons.eye}</button>` : "";
    return `<div class="field">
      <div class="label"><label for="${id}">${label}</label>${extra}</div>
      <div class="input"><input id="${id}" type="${type}" autocomplete="${autocomplete}" spellcheck="false" value="${esc(value)}">${toggle}</div>`;
  }

  //Views
  const views = {
    welcome: () => `${logoBlock()}
      <h1>Never lose a .env file again</h1>
      <p class="lede">Hush keeps a private backup of your .env files in your Google Drive, locked with a passphrase only you know.</p>
      <ul class="features">
        <li>${icons.shield}<span><b>Locked before it leaves your computer</b><small>No one else can read your secrets, not even Google or us</small></span></li>
        <li>${icons.cloud}<span><b>Kept in your own Google Drive</b><small>Hidden from your files. Nothing to sign up for</small></span></li>
        <li>${icons.sync}<span><b>Saved automatically</b><small>Every save is backed up. Restore on any computer</small></span></li>
      </ul>
      <div class="actions"><button class="primary" id="start" type="button">Get started</button><button class="link" id="close" type="button">Maybe later</button></div>
      <p class="foot">Free and open source. Open this again anytime from any .env file.</p>`,

    connect: () => `${steps(1)}
      <h1>Connect Google Drive</h1>
      <p class="lede">Your browser opens Google's sign-in page. Come back here when you're done.</p>
      <div class="card">${icons.info}<span><b>Hush only touches its own backups.</b> Your other Drive files stay private, and your backups stay out of sight. Google will ask you to allow this.</span></div>
      ${errorBox()}
      ${
        ui.connecting
          ? `<p class="waiting">${icons.spin}Waiting for Google… <button class="link" id="cancel" type="button">Cancel</button></p>`
          : `<div class="actions"><button class="primary" id="connect" type="button">Continue in browser</button></div>`
      }`,

    pass: () => `${steps(2)}${account()}
      <h1>Create your passphrase</h1>
      <p class="lede">Your passphrase is the only key to your backups. Without it, nobody can open them.</p>
      ${passField("pass", "Passphrase", "new-password", `<button class="link small" id="generate" type="button">Generate one</button>`)}
        <div class="meter" id="meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="hint" id="hint"></div>
      </div>
      ${passField("confirm", "Confirm passphrase", "new-password")}
        <div class="hint" id="match"></div>
      </div>
      <div class="warning">${icons.warn}<span><b>There is no way to recover a lost passphrase.</b> If you lose it, nobody can open your backups, including you. Save it in a password manager.</span></div>
      <label class="check"><input type="checkbox" id="saved" ${ui.saved ? "checked" : ""}>I've saved my passphrase somewhere safe</label>
      ${errorBox()}
      <div class="actions"><button class="primary" id="create" type="button"></button></div>
      <p class="foot">You won't need to type it again on this computer.</p>`,

    unlock: () => {
      const s = state.summary;
      const found = s
        ? `We found your backups: <b>${plural(s.projects, "project")}</b> with <b>${plural(s.files, "file")}</b>.`
        : "We found your backups in this Google Drive.";
      return `${logoBlock()}${account()}
        <h1>Unlock your backups</h1>
        <p class="lede">${found} Enter your passphrase to open them on this computer.</p>
        ${passField("pass", "Passphrase", "current-password")}</div>
        ${errorBox()}
        <div class="actions"><button class="primary" id="unlock" type="button">${icons.lock}<span id="unlockLabel">Unlock</span></button><button class="link" id="forgot" type="button">Forgot passphrase?</button></div>`;
    },

    files: () => {
      if (!state.files.length) {
        return `${steps(3)}
          <h1>No .env files found</h1>
          <p class="lede">Hush didn't find any .env files in ${esc(state.projectName)}. New .env files are backed up when you save them.</p>
          <div class="actions"><button class="primary" id="finish" type="button">Done</button></div>`;
      }
      const rows = state.files
        .map(
          (file) => `<label class="file"><input type="checkbox" data-key="${esc(file.key)}" ${ui.selected.has(file.key) ? "checked" : ""}><code>${esc(file.path)}</code>${
            file.gitIgnored === false ? `<span class="tag warn">Not in .gitignore <button class="link small" type="button" data-fix="${esc(file.key)}">Fix</button></span>` : ""
          }</label>`,
        )
        .join("");
      return `${steps(3)}
        <h1>${plural(state.files.length, ".env file")} found</h1>
        <p class="lede">Choose what to back up from <b>${esc(state.projectName)}</b>.</p>
        <div class="files">${rows}</div>
        <label class="check"><input type="checkbox" id="auto" ${ui.autoPush ? "checked" : ""}>Back up automatically when I save</label>
        ${errorBox()}
        <div class="actions"><button class="primary" id="backup" type="button">${icons.upload}<span id="backupLabel"></span></button><button class="link" id="close" type="button">Skip</button></div>`;
    },

    done: () => {
      if (!state.hasWorkspace) {
        return `${logoBlock()}
          <h1>You're all set</h1>
          <p class="lede">Open a folder with .env files and Hush will find them. You can back them up from the Hush sidebar.</p>
          <div class="actions"><button class="primary" id="close" type="button">Close</button></div>`;
      }
      const r = state.result;
      const t = state.totals;
      let notes = "";
      if (r && r.conflicts) notes += `<div class="warning">${icons.warn}<span>${plural(r.conflicts, "file")} changed here and in the cloud. Open the Hush sidebar to compare them.</span></div>`;
      if (r && r.failed) notes += `<div class="error">${plural(r.failed, "file")} couldn't be backed up. Open the Hush output panel for details.</div>`;
      const how = state.autoPush ? "Hush backs up your .env files every time you save." : "Push changes from the Hush sidebar or the cloud button on any .env file.";
      return `${logoBlock()}
        <h1>You're all set</h1>
        <p class="lede">${plural(t.backedUp, "file")} backed up from ${esc(state.projectName)}. ${how}</p>
        ${notes}
        <div class="actions"><button class="primary" id="openView" type="button">Open Hush sidebar</button><button class="link" id="close" type="button">Close</button></div>`;
    },
  };

  //Render
  function render() {
    if (!state) return;
    const active = document.activeElement && document.activeElement.id;
    app.innerHTML = views[state.step]();
    bind();
    if (active && $(active)) $(active).focus();
    showError();
    update();
  }

  function bind() {
    on("start", "click", () => send("start"));
    on("close", "click", () => send("close"));
    on("openView", "click", () => send("openView"));
    on("connect", "click", () => send("connect"));
    on("cancel", "click", () => send("cancelConnect"));
    on("generate", "click", () => send("generate"));
    on("forgot", "click", () => send("forgot"));
    on("toggle", "click", () => {
      ui.show = !ui.show;
      render();
    });
    on("pass", "input", (event) => {
      ui.pass = event.target.value;
      ui.error = "";
      showError();
      update();
    });
    on("confirm", "input", (event) => {
      ui.confirm = event.target.value;
      update();
    });
    on("pass", "keydown", (event) => {
      if (event.key !== "Enter") return;
      if (state.step === "unlock") unlock();
      else if ($("confirm")) $("confirm").focus();
    });
    on("confirm", "keydown", (event) => {
      if (event.key === "Enter") create();
    });
    on("saved", "change", (event) => {
      ui.saved = event.target.checked;
      update();
    });
    on("create", "click", create);
    on("unlock", "click", unlock);
    on("auto", "change", (event) => {
      ui.autoPush = event.target.checked;
    });
    on("backup", "click", () => {
      if (ui.busy || !ui.selected.size) return;
      ui.busy = true;
      update();
      send("backup", { keys: [...ui.selected], autoPush: ui.autoPush });
    });
    on("finish", "click", () => send("backup", { keys: [], autoPush: ui.autoPush }));
    app.querySelectorAll("input[data-key]").forEach((el) =>
      el.addEventListener("change", () => {
        if (el.checked) ui.selected.add(el.dataset.key);
        else ui.selected.delete(el.dataset.key);
        update();
      }),
    );
    app.querySelectorAll("button[data-fix]").forEach((el) =>
      el.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        send("gitignore", { key: el.dataset.fix });
      }),
    );
  }

  function canCreate() {
    return ui.pass.length >= MIN && ui.pass === ui.confirm && ui.saved;
  }

  function create() {
    if (ui.busy || !canCreate()) return;
    ui.busy = true;
    update();
    send("create", { passphrase: ui.pass });
  }

  function unlock() {
    if (ui.busy || !ui.pass) return;
    ui.busy = true;
    update();
    send("unlock", { passphrase: ui.pass });
  }

  function showError() {
    const el = $("error");
    if (!el) return;
    el.hidden = !ui.error;
    el.textContent = ui.error;
  }

  function update() {
    const createButton = $("create");
    if (createButton) {
      const s = strength(ui.pass);
      createButton.disabled = ui.busy || !canCreate();
      createButton.textContent = ui.busy ? "Setting up…" : "Create passphrase";
      const meter = $("meter");
      meter.dataset.score = String(s.score);
      meter.querySelectorAll("i").forEach((bar, index) => bar.classList.toggle("on", index < s.score));
      $("hint").textContent = !ui.pass
        ? `At least ${MIN} characters. A few random words work well.`
        : ui.pass.length < MIN
          ? `${plural(MIN - ui.pass.length, "more character")} needed.`
          : `${s.label} · ${ui.pass.length} characters`;
      const match = $("match");
      const mismatch = ui.confirm && ui.confirm !== ui.pass;
      match.textContent = mismatch ? "Passphrases don't match." : ui.confirm ? "Passphrases match." : "";
      match.className = `hint ${mismatch ? "bad" : ""}`;
    }
    const unlockButton = $("unlock");
    if (unlockButton) {
      unlockButton.disabled = ui.busy || !ui.pass;
      $("unlockLabel").textContent = ui.busy ? "Unlocking…" : "Unlock";
    }
    const backupButton = $("backup");
    if (backupButton) {
      backupButton.disabled = ui.busy || !ui.selected.size;
      $("backupLabel").textContent = ui.busy ? "Backing up…" : `Back up ${plural(ui.selected.size, "file")}`;
    }
  }

  //Messages
  function onState(next) {
    const changed = next.step !== ui.step;
    state = next;
    if (changed) {
      Object.assign(ui, { step: next.step, busy: false, error: "", pass: "", confirm: "", show: false, saved: false });
    }
    if (next.step === "files") {
      for (const file of next.files) {
        if (ui.seen.has(file.key)) continue;
        ui.seen.add(file.key);
        if (file.tracked) ui.selected.add(file.key);
      }
      ui.autoPush = changed ? next.autoPush : ui.autoPush;
    }
    const nextSignature = JSON.stringify([next.step, next.files, next.summary, next.result, next.totals, next.email, next.hasWorkspace]);
    if (changed || nextSignature !== signature) {
      signature = nextSignature;
      render();
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "state":
        onState(message);
        break;
      case "connecting":
        ui.connecting = message.value;
        if (state && state.step === "connect") render();
        break;
      case "error":
        ui.busy = false;
        ui.error = message.message;
        showError();
        update();
        break;
      case "generated":
        ui.pass = message.value;
        ui.confirm = message.value;
        ui.show = true;
        render();
        break;
    }
  });

  send("ready");
})();
