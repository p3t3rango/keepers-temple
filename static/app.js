const $ = (id) => document.getElementById(id);

const SESSIONS_KEY = "ollama-mempalace.sessions.v1";
const ACTIVE_KEY = "ollama-mempalace.activeSession";
const PREFS_KEY = "ollama-mempalace.prefs.v1";
const WING_PROMPT_KEY = "ollama-mempalace.wing_prompts.v1";
const KNOWN_WINGS_KEY = "ollama-mempalace.knownWings.v1";
const ONBOARDED_KEY = "ollama-mempalace.onboarded";

// Bump when defaults change. Resets behavior toggles to their declared defaults
// without nuking the rest of the user's prefs (model, wing, room, etc.).
const PREFS_DEFAULTS_VERSION = 2;

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function now() {
  return Date.now();
}

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

const state = {
  sessions: loadJSON(SESSIONS_KEY, []),
  activeId: localStorage.getItem(ACTIVE_KEY) || null,
  prefs: loadJSON(PREFS_KEY, {
    model: "",
    wing: "personal",
    room: "general",
    recall: true,
    save: true,
    extract: true,
    identity: true,
    tools: false,
    showMemory: false,
    showAllWings: false,
  }),
  wingPrompts: loadJSON(WING_PROMPT_KEY, {}),
  knownWings: loadJSON(KNOWN_WINGS_KEY, ["personal"]),
  wings: [],
  models: [],
  ollama: { reachable: true, error: null },
  personas: [{ name: "default", is_default: true, identity: "", description: "" }],
};

function rememberWing(name) {
  if (name && !state.knownWings.includes(name)) {
    state.knownWings.push(name);
    saveJSON(KNOWN_WINGS_KEY, state.knownWings);
  }
}

function forgetWing(name) {
  state.knownWings = state.knownWings.filter((w) => w !== name);
  saveJSON(KNOWN_WINGS_KEY, state.knownWings);
}

const els = {
  sidebar: $("sidebar"),
  toggleSidebar: $("toggle-sidebar"),
  showSidebar: $("show-sidebar"),
  newChat: $("new-chat"),
  newIncognito: $("new-incognito"),
  anonBanner: $("anon-banner"),
  openMemory: $("open-memory"),
  openSettings: $("open-settings"),
  sessions: $("sessions"),
  toggleWingFilter: $("toggle-wing-filter"),
  topbarWing: $("topbar-wing"),
  topbarWingNew: $("topbar-wing-new"),
  topbarPersona: $("topbar-persona"),
  personasList: $("personas-list"),
  personaNew: $("persona-new"),
  tokenMeter: $("token-meter"),
  tokenCount: $("token-count"),
  tokenBudget: $("token-budget"),
  palaceLabel: $("palace-label"),
  emptyState: $("empty-state"),
  messages: $("messages"),
  chatArea: $("chat-area"),
  dragOverlay: $("drag-overlay"),
  dragWing: $("drag-wing"),
  attachStaging: $("attach-staging"),
  pendingAttachments: $("pending-attachments"),
  attachFileInput: $("attach-file-input"),
  wingFileInput: $("wing-file-input"),
  uploadWingFileBtn: $("upload-wing-file-btn"),
  attachmentsList: $("attachments-list"),
  wingPromptPicker: $("wing-prompt-picker"),
  input: $("input"),
  composer: $("composer"),
  send: $("send"),
  composerPlus: $("composer-plus"),
  composerMic: $("composer-mic"),
  composerRecall: $("composer-recall"),
  whisperModel: $("whisper-model"),
  tTts: $("t-tts"),
  ttsVoice: $("tts-voice"),
  ttsRate: $("tts-rate"),
  model: $("model"),
  toggleMemoryPane: $("toggle-memory-pane"),
  memoryPane: $("memory-pane"),
  closeMemory: $("close-memory"),
  hits: $("hits"),
  status: $("status"),
  settingsOverlay: $("settings-overlay"),
  closeSettings: $("close-settings"),
  identity: $("identity"),
  saveIdentity: $("save-identity"),
  resetIdentity: $("reset-identity"),
  redoWelcome: $("redo-welcome"),
  identityStatus: $("identity-status"),
  welcomeOverlay: $("welcome-overlay"),
  welcomeName: $("welcome-name"),
  welcomeContinue: $("welcome-continue"),
  welcomeSkip: $("welcome-skip"),
  wing: $("wing"),
  wingNew: $("wing-new"),
  wingRename: $("wing-rename"),
  wingDelete: $("wing-delete"),
  room: $("room"),
  wingPrompt: $("wing-prompt"),
  tRecall: $("t-recall"),
  tSave: $("t-save"),
  tExtract: $("t-extract"),
  tIdentity: $("t-identity"),
  tTools: $("t-tools"),
  tAutoKg: $("t-auto-kg"),
  tThinkingPreview: $("t-thinking-preview"),
  refreshWakeup: $("refresh-wakeup"),
  wakeupTokens: $("wakeup-tokens"),
  wakeupText: $("wakeup-text"),
  memoryOverlay: $("memory-overlay"),
  closeMemoryModal: $("close-memory-modal"),
  statsContent: $("stats-content"),
  taxonomyContent: $("taxonomy-content"),
  recentContent: $("recent-content"),
  browserWing: $("browser-wing"),
  browserRoom: $("browser-room"),
  browserQ: $("browser-q"),
  browserReload: $("browser-reload"),
  browserList: $("browser-list"),
  browserPrev: $("browser-prev"),
  browserNext: $("browser-next"),
  browserPage: $("browser-page"),
  browserSince: $("browser-since"),
  browserUntil: $("browser-until"),
  browserSelectAll: $("browser-select-all"),
  browserBulkBar: $("browser-bulk-bar"),
  bulkSelectedCount: $("bulk-selected-count"),
  bulkMoveWing: $("bulk-move-wing"),
  bulkMoveBtn: $("bulk-move-btn"),
  bulkDeleteBtn: $("bulk-delete-btn"),
  bulkClearBtn: $("bulk-clear-btn"),
};

function savePrefs() {
  state.prefs.model = els.model.value;
  state.prefs.wing = els.wing.value || state.prefs.wing;
  state.prefs.room = els.room.value || state.prefs.room;
  state.prefs.recall = els.tRecall.checked;
  state.prefs.save = els.tSave.checked;
  state.prefs.extract = els.tExtract.checked;
  state.prefs.identity = els.tIdentity.checked;
  if (els.tTools) state.prefs.tools = els.tTools.checked;
  if (els.tAutoKg) state.prefs.autoKg = els.tAutoKg.checked;
  if (els.tThinkingPreview)
    state.prefs.thinkingPreview = els.tThinkingPreview.checked;
  saveJSON(PREFS_KEY, state.prefs);
  syncRecallButton();
}

function syncRecallButton() {
  // Default-on: only explicit `false` should make the button gray.
  const on = state.prefs.recall !== false;
  els.composerRecall.classList.toggle("on", on);
  const lbl = els.composerRecall.querySelector(".lbl");
  if (lbl) lbl.textContent = on ? "recall on" : "recall off";
  els.composerRecall.title = on
    ? "Memory recall is ON — the model gets relevant memories from this wing before each reply. Click to turn off."
    : "Memory recall is OFF — the model has no memory context. Click to turn on.";
}

function escapeHtml(s) {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const MD_OPTS = { breaks: true, gfm: true };

// Render markdown safely. Falls back to escaped text if marked/DOMPurify
// haven't loaded yet (e.g. CDN slow). Adds copy buttons to code blocks.
function renderMarkdown(text) {
  const raw = text ?? "";
  if (!window.marked || !window.DOMPurify) return escapeHtml(raw);
  try {
    const html = window.marked.parse(raw, MD_OPTS);
    const clean = window.DOMPurify.sanitize(html, {
      ADD_ATTR: ["target", "rel"],
    });
    return clean;
  } catch {
    return escapeHtml(raw);
  }
}

// After rendering markdown into the DOM, walk all <pre><code> blocks and
// inject a copy button. Idempotent — won't double-add.
function attachCodeCopyButtons(rootEl) {
  const blocks = rootEl.querySelectorAll("pre > code");
  blocks.forEach((code) => {
    const pre = code.parentElement;
    if (pre.querySelector(".code-copy-btn")) return;
    pre.classList.add("with-copy");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn";
    btn.textContent = "copy";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(code.innerText);
        btn.textContent = "✓ copied";
        setTimeout(() => (btn.textContent = "copy"), 1400);
      } catch {
        btn.textContent = "✗";
        setTimeout(() => (btn.textContent = "copy"), 1400);
      }
    });
    pre.appendChild(btn);
  });
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `${kind} show`;
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => els.status.classList.remove("show"), 4000);
}

/* ─── Sessions ─────────────────────────────────────────────────────────── */

function getActiveSession() {
  return state.sessions.find((s) => s.id === state.activeId);
}

function createSession(opts = {}) {
  const s = {
    id: uuid(),
    title: opts.anonymous ? "Incognito chat" : "New chat",
    wing: state.prefs.wing || "personal",
    room: state.prefs.room || "general",
    model: state.prefs.model || (state.models[0] ?? ""),
    persona: state.prefs.persona || "default",
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    anonymous: !!opts.anonymous,
  };
  state.sessions.unshift(s);
  state.activeId = s.id;
  localStorage.setItem(ACTIVE_KEY, s.id);
  saveJSON(SESSIONS_KEY, state.sessions);
  return s;
}

const ANON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/></svg>`;

function deleteSession(id) {
  const idx = state.sessions.findIndex((s) => s.id === id);
  if (idx < 0) return;
  state.sessions.splice(idx, 1);
  if (state.activeId === id) {
    state.activeId = state.sessions[0]?.id || null;
    localStorage.setItem(ACTIVE_KEY, state.activeId || "");
  }
  saveJSON(SESSIONS_KEY, state.sessions);
}

function setActive(id) {
  state.activeId = id;
  localStorage.setItem(ACTIVE_KEY, id);
  const s = getActiveSession();
  if (s) {
    if (s.model && state.models.includes(s.model)) els.model.value = s.model;
    if (s.wing) {
      ensureWingOption(s.wing);
      els.wing.value = s.wing;
    }
    if (s.room) els.room.value = s.room;
    if (s.persona && els.topbarPersona) els.topbarPersona.value = s.persona;
    state.prefs.wing = s.wing;
    state.prefs.room = s.room;
    state.prefs.model = s.model;
    saveJSON(PREFS_KEY, state.prefs);
    loadWingPromptForCurrent();
  }
  renderSessions();
  renderMessages();
  refreshTokenMeter();
}

function bucketSessionsByDate() {
  const today0 = new Date();
  const today = new Date(
    today0.getFullYear(),
    today0.getMonth(),
    today0.getDate(),
  ).getTime();
  const week = today - 6 * 86400000;
  const buckets = { Today: [], "This Week": [], Older: [] };
  const wing = state.prefs.wing || "personal";
  const showAll = !!state.prefs.showAllWings;
  for (const s of state.sessions) {
    if (!showAll && s.wing !== wing) continue;
    if (s.updatedAt >= today) buckets.Today.push(s);
    else if (s.updatedAt >= week) buckets["This Week"].push(s);
    else buckets.Older.push(s);
  }
  return buckets;
}

function syncWingFilter() {
  const lbl = els.toggleWingFilter.querySelector(".lbl");
  if (state.prefs.showAllWings) {
    lbl.textContent = "all wings";
    els.toggleWingFilter.classList.remove("filtered");
  } else {
    lbl.textContent = state.prefs.wing || "personal";
    els.toggleWingFilter.classList.add("filtered");
  }
}

function renderSessions() {
  els.sessions.innerHTML = "";
  const buckets = bucketSessionsByDate();
  for (const [label, group] of Object.entries(buckets)) {
    if (!group.length) continue;
    const groupEl = document.createElement("div");
    groupEl.className = "sessions-group";
    groupEl.innerHTML = `<div class="sessions-group-label">${label}</div>`;
    for (const s of group) {
      const item = document.createElement("div");
      item.className = `session-item${s.id === state.activeId ? " active" : ""}${s.anonymous ? " anon" : ""}`;
      const mark = s.anonymous
        ? `<span class="anon-mark" title="Incognito">${ANON_SVG}</span>`
        : "";
      item.innerHTML = `
        <span class="title">${mark}${escapeHtml(s.title || "Untitled")}</span>
        <span class="actions">
          <button class="session-btn export" title="Export as markdown">⤓</button>
          <button class="session-btn rename" title="Rename">✎</button>
          <button class="session-btn delete" title="Delete">✕</button>
        </span>
      `;
      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("session-btn")) return;
        setActive(s.id);
      });
      item.querySelector(".export").addEventListener("click", (e) => {
        e.stopPropagation();
        exportSessionAsMarkdown(s);
      });
      item.querySelector(".rename").addEventListener("click", (e) => {
        e.stopPropagation();
        const next = prompt("Rename chat:", s.title);
        if (!next) return;
        s.title = next.trim();
        s.updatedAt = now();
        saveJSON(SESSIONS_KEY, state.sessions);
        renderSessions();
      });
      item.querySelector(".delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        const wantDrawers = e.shiftKey;
        const promptText = wantDrawers
          ? `Delete chat "${s.title}" AND all its filed memories?\n\nThis can't be undone.`
          : `Delete chat "${s.title}"?\n\nFiled memories stay in your palace — they're independent of chat history.\n(Hold Shift while clicking Delete to also wipe the memories.)`;
        if (!confirm(promptText)) return;
        if (wantDrawers) {
          try {
            const r = await fetch(
              `/api/chat-session/${encodeURIComponent(s.id)}?drop_memories=true`,
              { method: "DELETE" },
            );
            if (r.ok) {
              const d = await r.json();
              if (d.deleted) setStatus(`removed ${d.deleted} memor${d.deleted === 1 ? "y" : "ies"}`, "warn");
            }
          } catch {}
        }
        deleteSession(s.id);
        renderSessions();
        renderMessages();
        if (!state.sessions.length) ensureSession();
      });
      groupEl.appendChild(item);
    }
    els.sessions.appendChild(groupEl);
  }
}

function startEditMessage(idx) {
  const session = getActiveSession();
  if (!session || !session.messages[idx] || session.messages[idx].role !== "user") return;
  const m = session.messages[idx];
  const original = m.displayContent || m.content || "";
  const card = els.messages.children[idx];
  if (!card) return;
  card.innerHTML = `
    <span class="role">${m.role} · editing</span>
    <textarea class="edit-area"></textarea>
    <div class="edit-actions">
      <button type="button" class="primary save-edit">Save & resend</button>
      <button type="button" class="ghost cancel-edit">Cancel</button>
    </div>
  `;
  const ta = card.querySelector("textarea");
  ta.value = original;
  ta.focus();
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
  card.querySelector(".cancel-edit").addEventListener("click", () => renderMessages());
  card.querySelector(".save-edit").addEventListener("click", () => {
    const next = ta.value.trim();
    if (!next) return;
    session.messages.splice(idx);
    saveJSON(SESSIONS_KEY, state.sessions);
    sendMessage(next);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      card.querySelector(".save-edit").click();
    } else if (e.key === "Escape") {
      renderMessages();
    }
  });
}

function regenerateAt(idx) {
  const session = getActiveSession();
  if (!session) return;
  let userIdx = -1;
  for (let j = idx - 1; j >= 0; j--) {
    if (session.messages[j].role === "user") {
      userIdx = j;
      break;
    }
  }
  if (userIdx < 0) return;
  const userText =
    session.messages[userIdx].displayContent || session.messages[userIdx].content;
  session.messages.splice(userIdx);
  saveJSON(SESSIONS_KEY, state.sessions);
  sendMessage(userText);
}

function forkAt(idx) {
  const src = getActiveSession();
  if (!src) return;
  const upto = src.messages.slice(0, idx + 1);
  const clean = upto.map((m) => {
    const c = { role: m.role, content: m.content };
    if (m.displayContent) c.displayContent = m.displayContent;
    if (m.attachments) c.attachments = [...m.attachments];
    if (m.images) c.images = [...m.images];
    if (m.thinking) c.thinking = m.thinking;
    if (m.toolCalls) c.toolCalls = JSON.parse(JSON.stringify(m.toolCalls));
    return c;
  });
  const fork = {
    id: uuid(),
    title: `Fork of ${src.title || "Untitled"}`,
    wing: src.wing,
    room: src.room,
    model: src.model,
    persona: src.persona,
    createdAt: now(),
    updatedAt: now(),
    messages: clean,
    anonymous: src.anonymous,
    forkedFrom: { id: src.id, title: src.title, atTurn: idx },
  };
  state.sessions.unshift(fork);
  state.activeId = fork.id;
  localStorage.setItem(ACTIVE_KEY, fork.id);
  saveJSON(SESSIONS_KEY, state.sessions);
  renderSessions();
  renderMessages();
  setStatus(`forked at turn ${idx + 1} → "${fork.title}"`, "ok");
}

els.messages.addEventListener("click", (e) => {
  const t = e.target;
  if (t.classList.contains("edit-msg")) startEditMessage(Number(t.dataset.idx));
  else if (t.classList.contains("regen-msg")) regenerateAt(Number(t.dataset.idx));
  else if (t.classList.contains("fork-msg")) forkAt(Number(t.dataset.idx));
});

function exportSessionAsMarkdown(s) {
  const fmtDate = (ts) => {
    if (!ts) return "?";
    try {
      return new Date(ts).toISOString();
    } catch {
      return String(ts);
    }
  };
  const lines = [];
  lines.push("---");
  lines.push(`title: ${JSON.stringify(s.title || "Untitled")}`);
  lines.push(`wing: ${s.wing || ""}`);
  lines.push(`room: ${s.room || ""}`);
  lines.push(`persona: ${s.persona || "default"}`);
  lines.push(`model: ${s.model || ""}`);
  lines.push(`anonymous: ${s.anonymous ? "true" : "false"}`);
  lines.push(`created: ${fmtDate(s.createdAt)}`);
  lines.push(`updated: ${fmtDate(s.updatedAt)}`);
  lines.push(`turns: ${s.messages?.length || 0}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${s.title || "Untitled"}`);
  lines.push("");
  for (const m of s.messages || []) {
    const role = m.role === "assistant" ? "**Assistant**" : "**You**";
    lines.push(`---`);
    lines.push("");
    lines.push(role);
    lines.push("");
    if (m.attachments && m.attachments.length) {
      lines.push(`*📎 attached: ${m.attachments.join(", ")}*`);
      lines.push("");
    }
    if (m.thinking && m.role === "assistant") {
      lines.push(`<details><summary>💭 thoughts</summary>\n\n${m.thinking}\n\n</details>`);
      lines.push("");
    }
    const body = m.role === "user" && m.displayContent ? m.displayContent : m.content || "";
    lines.push(body);
    lines.push("");
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length) {
      lines.push(`*🔧 tool calls: ${m.toolCalls.map((t) => t.name).join(", ")}*`);
      lines.push("");
    }
    if (m.role === "assistant" && m.stats) {
      lines.push(
        `*${m.stats.tokens} tok · ${m.stats.elapsed.toFixed(1)}s · ${m.stats.tps.toFixed(1)} tok/s*`,
      );
      lines.push("");
    }
  }
  const md = lines.join("\n");
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const safeTitle =
    (s.title || "chat").replace(/[^\w\s.-]/g, "").trim().slice(0, 60).replace(/\s+/g, "-") ||
    "chat";
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date(s.updatedAt || Date.now())
    .toISOString()
    .slice(0, 10);
  a.download = `${stamp}-${safeTitle}.md`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
  setStatus(`exported ${a.download}`, "ok");
}

function ensureSession() {
  if (!getActiveSession()) {
    if (state.sessions.length) {
      state.activeId = state.sessions[0].id;
      localStorage.setItem(ACTIVE_KEY, state.activeId);
    } else {
      createSession();
    }
  }
  renderSessions();
}

/* ─── Messages ─────────────────────────────────────────────────────────── */

// Coalesce many thinking chunks into one rAF-paced render so the DOM
// rebuild + auto-scroll keep up with high-throughput streams.
let _pendingRenderFrame = null;
function scheduleRender() {
  if (_pendingRenderFrame !== null) return;
  _pendingRenderFrame = requestAnimationFrame(() => {
    _pendingRenderFrame = null;
    renderMessages();
    // Defer scroll to a SECOND frame so the browser has actually laid
    // out the new innerHTML before we measure scrollHeight.
    requestAnimationFrame(() => {
      document
        .querySelectorAll(".msg-thinking.is-preview .thinking-body")
        .forEach((el) => {
          el.scrollTop = el.scrollHeight;
        });
    });
  });
}

function renderMessages() {
  const s = getActiveSession();
  els.anonBanner.hidden = !(s && s.anonymous);
  if (!s || !s.messages.length) {
    els.emptyState.hidden = false;
    els.messages.hidden = true;
    els.messages.innerHTML = "";
    renderEmptyState();
    return;
  }
  els.emptyState.hidden = true;
  els.messages.hidden = false;
  els.messages.innerHTML = "";
  const lastAsstIdx = (() => {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i].role === "assistant") return i;
    }
    return -1;
  })();
  for (let i = 0; i < s.messages.length; i++) {
    const m = s.messages[i];
    const div = document.createElement("div");
    div.className = `msg ${m.role}`;
    const shown =
      m.role === "user" && m.displayContent ? m.displayContent : m.content;
    const attachTag =
      m.attachments && m.attachments.length
        ? `<div class="msg-attachments">📎 ${m.attachments
            .map((a) => escapeHtml(a))
            .join(", ")}</div>`
        : "";
    let thinkingTag = "";
    let thinkRenderText = "";
    const think = (m.thinking || "").trim();
    if (think) {
      const stillThinking = !(m.content && m.content.trim());
      const showPreview =
        stillThinking && state.prefs.thinkingPreview !== false;
      const label = stillThinking ? "Thinking…" : "Thoughts";
      const icon = `<svg class="think-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 1 4 12.7c-.6.5-1 1.3-1 2.1V18H9v-1.2c0-.8-.4-1.6-1-2.1A7 7 0 0 1 12 2z"/></svg>`;
      // In preview mode, only render the tail. Full text is restored once
      // thinking is done (collapsed; click to expand the full reasoning).
      thinkRenderText =
        showPreview && think.length > 2000
          ? "…" + think.slice(-2000)
          : think;
      thinkingTag = `<details class="msg-thinking${showPreview ? " is-preview" : ""}"${showPreview ? " open" : ""}><summary>${icon}<span class="think-label">${label}</span></summary><div class="thinking-body">${escapeHtml(thinkRenderText)}</div></details>`;
    }
    const toolsTag =
      m.toolCalls && m.toolCalls.length
        ? `<div class="tool-calls">${m.toolCalls
            .map((tc) => {
              const argsStr =
                typeof tc.arguments === "string"
                  ? tc.arguments
                  : JSON.stringify(tc.arguments ?? {}, null, 2);
              const resultStr =
                tc.result === null
                  ? "…running"
                  : JSON.stringify(tc.result, null, 2);
              return `<details class="tool-chip"><summary>🔧 ${escapeHtml(tc.name)}</summary><pre>args: ${escapeHtml(argsStr)}\n\n→ ${escapeHtml(resultStr)}</pre></details>`;
            })
            .join("")}</div>`
        : "";
    let statsTag = "";
    if (m.role === "assistant" && m.stats && m.content) {
      const tps = m.stats.tps.toFixed(1);
      const t = m.stats.tokens;
      const e = m.stats.elapsed.toFixed(1);
      statsTag = `<div class="msg-stats">${t} tok · ${e}s · ${tps} tok/s</div>`;
    }
    let actionsTag = "";
    if (m.role === "user" && !activeAbort) {
      actionsTag = `<div class="msg-actions">
        <button type="button" class="msg-action fork-msg" data-idx="${i}" title="Fork into a new chat from this point">⑂</button>
        <button type="button" class="msg-action edit-msg" data-idx="${i}" title="Edit and resend">✎</button>
      </div>`;
    } else if (
      m.role === "assistant" &&
      i === lastAsstIdx &&
      !activeAbort &&
      m.content
    ) {
      actionsTag = `<div class="msg-actions">
        <button type="button" class="msg-action fork-msg" data-idx="${i}" title="Fork into a new chat from this point">⑂</button>
        <button type="button" class="msg-action regen-msg" data-idx="${i}" title="Regenerate response">↻</button>
      </div>`;
    }
    div.innerHTML = `<span class="role">${m.role}</span>${thinkingTag}${toolsTag}${attachTag}<div class="markdown-body">${renderMarkdown(shown)}</div>${statsTag}${actionsTag}`;
    attachCodeCopyButtons(div);
    // Render thinking body as markdown too (model often uses markdown in CoT)
    const thinkingBody = div.querySelector(".thinking-body");
    if (thinkingBody && thinkRenderText) {
      thinkingBody.innerHTML = renderMarkdown(thinkRenderText);
      attachCodeCopyButtons(thinkingBody);
      // In preview mode, auto-scroll to keep the latest reasoning visible.
      // Real scroll-anchoring happens in scheduleRender's second rAF —
      // this is a synchronous best-effort for non-rAF render paths.
      if (div.querySelector(".msg-thinking.is-preview")) {
        thinkingBody.scrollTop = thinkingBody.scrollHeight;
      }
    }
    if (m.extracted && m.extracted.length) {
      const ex = document.createElement("div");
      ex.className = "extracted";
      ex.innerHTML =
        `<b>extracted ${m.extracted.length} fact${m.extracted.length === 1 ? "" : "s"}:</b>` +
        `<ul>${m.extracted
          .map((f) => `<li>[${escapeHtml(f.type)}] ${escapeHtml(f.preview)}</li>`)
          .join("")}</ul>`;
      div.appendChild(ex);
    }
    if (m.llmSaves && m.llmSaves.length) {
      const chip = document.createElement("div");
      chip.className = "save-chip";
      chip.innerHTML = m.llmSaves
        .map(
          (s, i) => {
            const preview = (s.preview || "").trim();
            const chipTitle = preview
              ? `Filed: "${preview}"\n\nHover the 'change' button to move it.`
              : `Filed to ${s.topic} › ${s.section}`;
            return `<span class="save-chip-item" data-idx="${i}" title="${escapeHtml(chipTitle)}">📁 Saved to <b>${escapeHtml(s.topic)}</b> › <b>${escapeHtml(s.section)}</b>${
              s.drawer_id
                ? ` <button class="save-chip-edit" data-drawer="${escapeHtml(s.drawer_id)}" type="button" title="Move this memory to a different topic/section if the assistant picked the wrong place">change</button>`
                : ""
            }</span>`;
          },
        )
        .join("");
      div.appendChild(chip);
    }
    els.messages.appendChild(div);
  }
  els.messages.parentElement.scrollTop = els.messages.parentElement.scrollHeight;
}

function renderHits(hits) {
  els.hits.innerHTML = "";
  if (!hits || !hits.length) {
    els.hits.innerHTML =
      '<div class="hit-empty">no memories pulled in for this turn</div>';
    return;
  }
  for (const h of hits) {
    const div = document.createElement("div");
    div.className = "hit";
    div.innerHTML = `
      <div class="hit-meta">
        <span>${escapeHtml(h.wing || "?")}/${escapeHtml(h.room || "?")}</span>
        <span>sim ${h.similarity ?? "?"}</span>
      </div>
      <div class="hit-text">${escapeHtml(h.preview || "")}</div>
    `;
    els.hits.appendChild(div);
  }
}

/* ─── Wings & models ───────────────────────────────────────────────────── */

/* ─── Token meter / model info ────────────────────────────────────────── */

const modelInfoCache = new Map(); // model name -> {context_length, ...}

async function getModelInfo(model) {
  if (!model) return null;
  if (modelInfoCache.has(model)) return modelInfoCache.get(model);
  try {
    const r = await fetch(`/api/model-info?model=${encodeURIComponent(model)}`);
    if (!r.ok) return null;
    const info = await r.json();
    modelInfoCache.set(model, info);
    return info;
  } catch {
    return null;
  }
}

function estimateTokens(s) {
  return Math.max(1, Math.floor((s || "").length / 4));
}

async function refreshTokenMeter() {
  if (!els.tokenMeter || !els.tokenCount || !els.tokenBudget) return;
  const session = getActiveSession();
  if (!session) {
    els.tokenCount.textContent = "0";
    els.tokenBudget.textContent = "?";
    els.tokenMeter.className = "token-meter";
    return;
  }
  const info = await getModelInfo(session.model || els.model.value);
  const ctx = info?.context_length || 4096;
  // Estimate: identity + wing prompt + memory hit budget + messages
  let total = 200; // baseline overhead for system messages
  for (const m of session.messages) {
    total += estimateTokens(m.content) + 4;
    if (m.images) total += 600 * m.images.length;
  }
  els.tokenCount.textContent = total.toLocaleString();
  els.tokenBudget.textContent = ctx.toLocaleString();
  const ratio = total / ctx;
  els.tokenMeter.className = "token-meter";
  if (ratio > 0.85) els.tokenMeter.classList.add("crit");
  else if (ratio > 0.65) els.tokenMeter.classList.add("warn");
}

async function loadModels() {
  try {
    const r = await fetch("/api/models");
    if (!r.ok) {
      // Backend reached us but Ollama itself is down — treat as unreachable.
      const body = await r.text().catch(() => "");
      state.ollama = { reachable: false, error: body || `HTTP ${r.status}` };
      state.models = [];
      els.model.innerHTML = "";
      renderEmptyState();
      syncSendDisabled();
      return;
    }
    const data = await r.json();
    state.models = data.models || [];
    state.ollama = { reachable: true, error: null };
    els.model.innerHTML = state.models
      .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
      .join("");
    if (state.prefs.model && state.models.includes(state.prefs.model)) {
      els.model.value = state.prefs.model;
    } else {
      // First-run pick: prefer tool-capable models for Auto-file memories.
      const PREFERRED_DEFAULTS = [
        "gpt-oss:20b",
        "deepseek-r1:latest",
        "qwen3.6:35b-a3b-q4_K_M",
      ];
      const pick = PREFERRED_DEFAULTS.find((m) => state.models.includes(m));
      if (pick) {
        els.model.value = pick;
        state.prefs.model = pick;
      }
    }
    renderEmptyState();
    syncSendDisabled();
  } catch (e) {
    state.ollama = { reachable: false, error: e.message };
    state.models = [];
    els.model.innerHTML = "";
    renderEmptyState();
    syncSendDisabled();
  }
}

const SUGGESTED_MODELS = [
  { name: "llama3.2:3b", size: "~2 GB", note: "tiny + fast, good first try" },
  { name: "gemma3:4b", size: "~3 GB", note: "Google, balanced" },
  { name: "qwen3:4b", size: "~2.5 GB", note: "Qwen, strong tool use" },
  { name: "deepseek-r1:8b", size: "~5 GB", note: "shows reasoning, slower" },
];

function syncSendDisabled() {
  if (!els.send) return;
  const noModels = !state.models || state.models.length === 0;
  els.send.disabled = noModels;
  els.send.title = noModels
    ? state.ollama && state.ollama.reachable
      ? "Install an Ollama model first (see the chat area)"
      : "Ollama isn't running — start it to chat"
    : "Send (⌘↵)";
}

function renderEmptyState() {
  const host = els.emptyState;
  if (!host) return;
  const s = getActiveSession();
  if (s && s.messages && s.messages.length) return; // Only renders when no chat yet.

  // Case 1: Ollama unreachable
  if (state.ollama && !state.ollama.reachable) {
    host.innerHTML = `
      <img src="/static/logo-256.png" alt="Keepers" class="empty-logo" />
      <div class="empty-card empty-warn">
        <div class="empty-card-title">Ollama isn't running</div>
        <p class="empty-card-body">
          Keepers Temple uses <a href="https://ollama.com/download" target="_blank" rel="noopener">Ollama</a>
          to run models locally on your Mac. Open the Ollama app, then come back and click
          <b>Try again</b>. If you don't have it yet, download it from
          <a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com/download</a>.
        </p>
        <div class="empty-card-row">
          <button class="primary" id="empty-retry" type="button">Try again</button>
          <a class="ghost-link" href="https://ollama.com/download" target="_blank" rel="noopener">Download Ollama →</a>
        </div>
        <div class="empty-card-err">${escapeHtml((state.ollama && state.ollama.error) || "")}</div>
      </div>
    `;
    const btn = document.getElementById("empty-retry");
    if (btn) btn.addEventListener("click", loadModels);
    return;
  }

  // Case 2: Ollama is up but no models
  if (!state.models || state.models.length === 0) {
    host.innerHTML = `
      <img src="/static/logo-256.png" alt="Keepers" class="empty-logo" />
      <div class="empty-card">
        <div class="empty-card-title">No models installed yet</div>
        <p class="empty-card-body">
          Keepers Temple needs an Ollama model to chat with. Pick one below and we'll
          download it for you. The first pull is the slowest — after that, the model
          stays on your Mac forever and runs offline.
        </p>
        <div class="empty-models">
          ${SUGGESTED_MODELS.map(
            (m) => `
            <div class="empty-model-row" data-name="${escapeHtml(m.name)}">
              <div class="emr-info">
                <div class="emr-name">${escapeHtml(m.name)}</div>
                <div class="emr-meta muted">${escapeHtml(m.size)} · ${escapeHtml(m.note)}</div>
              </div>
              <button class="primary emr-pull" type="button" data-name="${escapeHtml(m.name)}">Pull</button>
              <div class="emr-progress muted"></div>
            </div>
          `,
          ).join("")}
        </div>
        <div class="empty-card-row" style="margin-top:14px">
          <span class="muted">Want a different model? Browse <a href="https://ollama.com/library" target="_blank" rel="noopener">ollama.com/library</a>, then add it from Settings → Manage models.</span>
        </div>
      </div>
    `;
    host.querySelectorAll(".emr-pull").forEach((btn) => {
      btn.addEventListener("click", () => emptyStatePullModel(btn.dataset.name));
    });
    return;
  }

  // Case 3: ready, just no chat yet — show the Keepers logo + hint
  const autoFileOn = !!state.prefs?.tools;
  const hint = autoFileOn
    ? "Start typing — I'll remember the important bits automatically, sorted into topics you can browse anytime. Drop files anywhere to attach them."
    : "Send a message to start. Memory recall and save are on by default. Drop files anywhere to attach them to this wing.";
  host.innerHTML = `
    <img src="/static/logo-256.png" alt="Keepers Temple" class="empty-logo" />
    <div class="empty-hint">${escapeHtml(hint)}</div>
  `;
}

async function emptyStatePullModel(name) {
  const row = els.emptyState.querySelector(`.empty-model-row[data-name="${CSS.escape(name)}"]`);
  if (!row) return;
  const btn = row.querySelector(".emr-pull");
  const progress = row.querySelector(".emr-progress");
  btn.disabled = true;
  progress.textContent = "starting…";
  try {
    const r = await fetch("/api/models/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === "error") {
              progress.textContent = `error: ${evt.message}`;
              btn.disabled = false;
              return;
            }
            const status = evt.status || "";
            if (evt.total && evt.completed) {
              const pct = ((evt.completed / evt.total) * 100).toFixed(0);
              progress.textContent = `${status} — ${pct}%`;
            } else {
              progress.textContent = status;
            }
            if (status === "success") {
              progress.textContent = `installed ✓`;
              await loadModels();
              if (els.model && state.models.includes(name)) {
                els.model.value = name;
                state.prefs.model = name;
                saveJSON(PREFS_KEY, state.prefs);
              }
              return;
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    progress.textContent = `error: ${e.message}`;
    btn.disabled = false;
  }
}

function populateWingSelect(select, desired) {
  // Union of wings the API knows about (have drawers) and wings the user
  // has created in this browser (no drawers yet but should still be selectable).
  const apiNames = new Set(state.wings.map((w) => w.name));
  const apiOpts = state.wings.map((w) => ({
    name: w.name,
    label: `${w.name} (${w.drawer_count})`,
  }));
  const knownOnlyOpts = state.knownWings
    .filter((n) => !apiNames.has(n))
    .map((n) => ({ name: n, label: `${n} (empty)` }));
  const all = [...apiOpts, ...knownOnlyOpts].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (desired && !all.some((o) => o.name === desired)) {
    all.unshift({ name: desired, label: `${desired} (new)` });
  }
  select.innerHTML = all
    .map(
      (o) =>
        `<option value="${escapeHtml(o.name)}">${escapeHtml(o.label)}</option>`,
    )
    .join("");
  if (desired) select.value = desired;
}

function ensureWingOption(name) {
  for (const sel of [els.wing, els.topbarWing]) {
    if (![...sel.options].some((o) => o.value === name)) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = `${name} (new)`;
      sel.appendChild(opt);
    }
  }
}

async function loadWings(preferred) {
  try {
    const r = await fetch("/api/wings");
    const data = await r.json();
    state.wings = data.wings || [];
    // Any wing returned by the API is by definition known.
    for (const w of state.wings) rememberWing(w.name);
    const desired = preferred || state.prefs.wing || "personal";
    rememberWing(desired);
    populateWingSelect(els.wing, desired);
    populateWingSelect(els.topbarWing, desired);
  } catch (e) {
    setStatus(`wings: ${e.message}`, "err");
  }
}

function setCurrentWing(name) {
  ensureWingOption(name);
  els.wing.value = name;
  els.topbarWing.value = name;
  state.prefs.wing = name;
  const s = getActiveSession();
  if (s) s.wing = name;
  saveJSON(PREFS_KEY, state.prefs);
  saveJSON(SESSIONS_KEY, state.sessions);
  loadWingPromptForCurrent();
  loadWakeup();
  syncWingFilter();
  renderSessions();
}

function setCurrentRoom(name) {
  els.room.value = name;
  state.prefs.room = name;
  const s = getActiveSession();
  if (s) s.room = name;
  saveJSON(PREFS_KEY, state.prefs);
  saveJSON(SESSIONS_KEY, state.sessions);
}

function populateWingPromptPicker() {
  if (!els.wingPromptPicker) return;
  const seen = new Set();
  const names = [];
  for (const w of state.wings) {
    if (!seen.has(w.name)) {
      seen.add(w.name);
      names.push(w.name);
    }
  }
  for (const w of state.knownWings) {
    if (!seen.has(w)) {
      seen.add(w);
      names.push(w);
    }
  }
  names.sort();
  const current = els.wingPromptPicker.value || els.wing.value || "personal";
  els.wingPromptPicker.innerHTML = names
    .map(
      (n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`,
    )
    .join("");
  if (names.includes(current)) els.wingPromptPicker.value = current;
  else if (names.length) els.wingPromptPicker.value = names[0];
}

function promptTargetWing() {
  return (
    (els.wingPromptPicker && els.wingPromptPicker.value) ||
    els.wing.value ||
    "personal"
  );
}

function loadWingPromptForCurrent() {
  populateWingPromptPicker();
  if (!els.wingPromptPicker) return;
  if (els.wing && !els.wingPromptPicker.value)
    els.wingPromptPicker.value = els.wing.value;
  const w = promptTargetWing();
  els.wingPrompt.value = state.wingPrompts[w] || "";
}

function saveWingPromptForCurrent() {
  const w = promptTargetWing();
  if (!w) return;
  if (els.wingPrompt.value.trim()) {
    state.wingPrompts[w] = els.wingPrompt.value;
  } else {
    delete state.wingPrompts[w];
  }
  saveJSON(WING_PROMPT_KEY, state.wingPrompts);
}

/* ─── Identity / Wakeup ────────────────────────────────────────────────── */

const DEFAULT_IDENTITY = `I am a personal AI assistant for *your name*.
Traits: concise, direct, remembers what matters across conversations.
Tone: warm but not sycophantic. Skip throat-clearing and trailing summaries.
People: *your name* (the user).
`;

/* ─── Personas ─────────────────────────────────────────────────────────── */

async function loadPersonas() {
  try {
    const r = await fetch("/api/personas");
    const d = await r.json();
    state.personas = d.personas || [];
  } catch (e) {
    state.personas = [
      { name: "default", is_default: true, identity: "", description: "" },
    ];
  }
  populatePersonaPicker();
  renderPersonasList();
}

function populatePersonaPicker() {
  const sel = els.topbarPersona;
  if (!sel) return;
  const desired =
    (getActiveSession() && getActiveSession().persona) ||
    state.prefs.persona ||
    "default";
  sel.innerHTML = state.personas
    .map(
      (p) =>
        `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}${p.is_default ? "" : ""}</option>`,
    )
    .join("");
  if (state.personas.some((p) => p.name === desired)) {
    sel.value = desired;
  } else {
    sel.value = "default";
  }
}

function setCurrentPersona(name) {
  state.prefs.persona = name;
  saveJSON(PREFS_KEY, state.prefs);
  const s = getActiveSession();
  if (s) {
    s.persona = name;
    saveJSON(SESSIONS_KEY, state.sessions);
  }
  if (els.topbarPersona) els.topbarPersona.value = name;
}

function renderPersonasList() {
  const host = els.personasList;
  if (!host) return;
  host.innerHTML = "";
  for (const p of state.personas) {
    const row = document.createElement("div");
    row.className = "persona-row" + (p.is_default ? " is-default" : "");
    row.innerHTML = `
      <div class="name-row">
        <span class="name">${escapeHtml(p.name)}</span>
        <span class="actions">
          ${p.is_default ? "" : `<button type="button" class="ghost edit-persona" data-name="${escapeHtml(p.name)}">edit</button>`}
          ${p.is_default ? "" : `<button type="button" class="danger del-persona" data-name="${escapeHtml(p.name)}">delete</button>`}
        </span>
      </div>
      <div class="description">${escapeHtml(p.description || (p.is_default ? "" : "(no description)"))}</div>
    `;
    host.appendChild(row);
  }
}

function openPersonaEditor(opts) {
  // opts.persona: existing persona to edit, or null for new
  const host = els.personasList;
  // Avoid stacking multiple editors
  host.querySelectorAll(".persona-edit").forEach((n) => n.remove());
  const isNew = !opts.persona;
  const p = opts.persona || {
    name: "",
    description: "",
    identity:
      state.personas.find((x) => x.is_default)?.identity || "",
  };
  const editor = document.createElement("div");
  editor.className = "persona-edit";
  editor.innerHTML = `
    <div class="persona-edit-row">
      <span class="muted">name</span>
      <input class="pe-name" placeholder="e.g. code-reviewer" value="${escapeHtml(p.name)}" ${isNew ? "" : "readonly title='click rename to change'"}/>
    </div>
    <div class="persona-edit-row">
      <span class="muted">description</span>
      <input class="pe-desc" placeholder="one-line summary" value="${escapeHtml(p.description || "")}" />
    </div>
    <span class="muted">identity (replaces Layer 0 when this persona is active)</span>
    <textarea class="pe-identity">${escapeHtml(p.identity || "")}</textarea>
    <div class="persona-edit-row">
      <button type="button" class="primary pe-save">${isNew ? "Create" : "Save"}</button>
      <button type="button" class="ghost pe-cancel">Cancel</button>
      <span class="muted pe-status"></span>
    </div>
  `;
  if (isNew) {
    host.appendChild(editor);
  } else {
    // Insert after the matching row
    const row = [...host.querySelectorAll(".persona-row")].find(
      (r) => r.querySelector(".name").textContent === p.name,
    );
    if (row) row.after(editor);
    else host.appendChild(editor);
  }

  editor.querySelector(".pe-cancel").addEventListener("click", () => editor.remove());
  editor.querySelector(".pe-save").addEventListener("click", async () => {
    const name = editor.querySelector(".pe-name").value.trim();
    const description = editor.querySelector(".pe-desc").value.trim();
    const identity = editor.querySelector(".pe-identity").value;
    const status = editor.querySelector(".pe-status");
    if (!name) {
      status.textContent = "name required";
      return;
    }
    status.textContent = "saving…";
    try {
      const url = isNew
        ? "/api/personas"
        : `/api/personas/${encodeURIComponent(p.name)}`;
      const method = isNew ? "POST" : "PUT";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, identity }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      await loadPersonas();
      // If we just edited the active persona, no further action needed
    } catch (e) {
      status.textContent = `error: ${e.message}`;
    }
  });
  editor.querySelector("textarea").focus();
}

/* ─── Identity (Layer 0) ──────────────────────────────────────────────── */

async function loadIdentity() {
  try {
    const r = await fetch("/api/identity");
    const data = await r.json();
    if (data.text && data.text.trim()) {
      els.identity.value = data.text;
      els.identityStatus.textContent = `loaded from ${data.path}`;
    } else {
      els.identity.value = DEFAULT_IDENTITY;
      els.identityStatus.textContent =
        "default shown (not saved) — edit and click Save to persist";
    }
  } catch (e) {
    els.identityStatus.textContent = `load failed: ${e.message}`;
  }
}

function resetIdentity() {
  els.identity.value = DEFAULT_IDENTITY;
  els.identityStatus.textContent = "reset (not saved) — click Save to persist";
}

async function saveIdentity() {
  els.identityStatus.textContent = "saving…";
  try {
    const r = await fetch("/api/identity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: els.identity.value }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || "failed");
    els.identityStatus.textContent = `saved (${data.bytes} B)`;
  } catch (e) {
    els.identityStatus.textContent = `error: ${e.message}`;
  }
}

async function loadWakeup() {
  els.wakeupText.textContent = "loading…";
  try {
    const r = await fetch(
      `/api/wakeup?wing=${encodeURIComponent(els.wing.value || "")}`,
    );
    const data = await r.json();
    els.wakeupText.textContent = data.text || "(empty)";
    els.wakeupTokens.textContent = `~${data.tokens_estimate || 0} tokens`;
  } catch (e) {
    els.wakeupText.textContent = `error: ${e.message}`;
  }
}

/* ─── Chat ─────────────────────────────────────────────────────────────── */

let activeAbort = null;
let activeStreamStart = 0;
let activeStreamTokens = 0;

function setSendingState(sending) {
  if (sending) {
    els.send.classList.add("stopping");
    els.send.title = "Stop generation";
    els.send.innerHTML = "■";
  } else {
    els.send.classList.remove("stopping");
    els.send.title = "Send (⌘↵)";
    els.send.innerHTML = "↑";
  }
  els.send.disabled = false;
}

async function sendMessage(text) {
  let session = getActiveSession();
  if (!session) {
    session = createSession();
    renderSessions();
  }
  // Persist UI choices into the session so they don't drift.
  session.wing = els.wing.value || session.wing;
  session.room = els.room.value || session.room;
  session.model = els.model.value || session.model;

  // Fold any staged attachments into the user's message
  const preamble = buildAttachmentPreamble();
  const attachedNames = pendingFilenames();
  const images = pendingImagesB64();
  const fullUserContent = preamble ? `${preamble}\n${text}` : text;

  const userMsg = {
    role: "user",
    content: fullUserContent,
    displayContent: text,
    attachments: attachedNames,
  };
  if (images.length) {
    userMsg.images = images;
  }
  const asstMsg = { role: "assistant", content: "" };
  session.messages.push(userMsg, asstMsg);
  if (session.title === "New chat" || !session.title) {
    session.title = text.slice(0, 60);
  }
  session.updatedAt = now();
  saveJSON(SESSIONS_KEY, state.sessions);
  renderSessions();
  renderMessages();

  setSendingState(true);
  setStatus("…thinking", "");
  activeAbort = new AbortController();
  activeStreamStart = 0;
  activeStreamTokens = 0;

  // Strip displayContent / attachments / dataUrl from outgoing messages —
  // backend only knows role/content/images.
  const wireMessages = session.messages.slice(0, -1).map((m) => {
    const w = { role: m.role, content: m.content };
    if (m.images) w.images = m.images;
    return w;
  });
  const body = {
    model: session.model,
    wing: session.wing,
    room: session.room,
    messages: wireMessages,
    use_memory: session.anonymous ? false : state.prefs.recall,
    save_to_memory: session.anonymous ? false : state.prefs.save,
    auto_extract: session.anonymous ? false : state.prefs.extract,
    use_identity: state.prefs.identity,
    enable_tools: session.anonymous ? false : !!state.prefs.tools,
    auto_kg: session.anonymous ? false : !!state.prefs.autoKg,
    persona: session.anonymous ? "default" : (session.persona || "default"),
    system_prompt: session.anonymous
      ? null
      : state.wingPrompts[session.wing] || null,
    session_id: session.id,
  };

  let assistantText = "";
  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: activeAbort.signal,
    });
    if (!resp.ok || !resp.body) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          let evt;
          try {
            evt = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (evt.type === "memory_hits") {
            // Silent — the memory-hits side panel reflects this; no toast needed.
            renderHits(evt.hits);
          } else if (evt.type === "thinking") {
            asstMsg.thinking = (asstMsg.thinking || "") + evt.content;
            scheduleRender();
          } else if (evt.type === "tool_call") {
            if (!asstMsg.toolCalls) asstMsg.toolCalls = [];
            asstMsg.toolCalls.push({
              name: evt.name,
              arguments: evt.arguments,
              result: null,
            });
            setStatus(`🔧 calling ${evt.name}…`, "");
            renderMessages();
          } else if (evt.type === "tool_result") {
            if (asstMsg.toolCalls && asstMsg.toolCalls.length) {
              for (let i = asstMsg.toolCalls.length - 1; i >= 0; i--) {
                if (
                  asstMsg.toolCalls[i].name === evt.name &&
                  asstMsg.toolCalls[i].result === null
                ) {
                  asstMsg.toolCalls[i].result = evt.result;
                  break;
                }
              }
            }
            renderMessages();
          } else if (evt.type === "token") {
            // (token rendering branch — still uses direct renderMessages
            // since each token mutates content, not thinking)
            if (!activeStreamStart) activeStreamStart = performance.now();
            // Rough token count — counting events is more accurate than
            // re-tokenizing the text. Each event is roughly one token.
            activeStreamTokens += 1;
            assistantText += evt.content;
            asstMsg.content = assistantText;
            renderMessages();
          } else if (evt.type === "done") {
            const bits = [];
            if (evt.extracted_facts && evt.extracted_facts.length) {
              asstMsg.extracted = evt.extracted_facts;
              bits.push(`extracted ${evt.extracted_facts.length} fact(s)`);
            }
            if (evt.kg_added && evt.kg_added.length) {
              asstMsg.kgAdded = evt.kg_added;
              bits.push(`+${evt.kg_added.length} kg triple(s)`);
            }
            if (evt.llm_saves && evt.llm_saves.length) {
              // LLM filed the turn itself — surface the chip data on the message.
              asstMsg.llmSaves = evt.llm_saves;
              const where = evt.llm_saves
                .map((s) => `${s.topic} › ${s.section}`)
                .join(", ");
              bits.unshift(`saved to ${where}`);
            } else if (evt.saved_drawer_id) {
              bits.unshift("saved");
            }
            if (evt.save_error) {
              setStatus(`save error: ${evt.save_error}`, "warn");
            } else if (bits.length) {
              setStatus(bits.join(" · "), "ok");
            } else {
              setStatus("done", "");
            }
            // Capture the per-turn token throughput so we can show it
            // as a small footer on the assistant bubble.
            if (activeStreamStart && activeStreamTokens) {
              const elapsed = (performance.now() - activeStreamStart) / 1000;
              if (elapsed > 0.05) {
                asstMsg.stats = {
                  tokens: activeStreamTokens,
                  elapsed,
                  tps: activeStreamTokens / elapsed,
                };
              }
            }
            // Speak the response if TTS is enabled
            if (ttsPrefs().enabled && asstMsg.content && !session.anonymous) {
              speakText(asstMsg.content);
            }
            session.updatedAt = now();
            saveJSON(SESSIONS_KEY, state.sessions);
            renderMessages();
          } else if (evt.type === "error") {
            setStatus(`stream error: ${evt.message}`, "err");
          }
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      // User clicked stop. Append a marker to whatever streamed so far and
      // save it to memory so we know the response was incomplete.
      asstMsg.content = (assistantText || "") + "\n\n_[stopped]_";
      asstMsg.stopped = true;
      setStatus("stopped", "warn");
      // Best-effort save the partial exchange (mirrors what /api/chat would
      // do server-side if it had completed). Skipped for incognito sessions.
      if (!session.anonymous && state.prefs.save !== false) {
        try {
          const transcript = `User: ${userMsg.displayContent || userMsg.content}\n\nAssistant: ${asstMsg.content}`;
          await fetch(`/api/wings/${encodeURIComponent(session.wing)}/attach`, {
            method: "POST",
            body: (() => {
              const fd = new FormData();
              fd.append(
                "file",
                new Blob([transcript], { type: "text/plain" }),
                `stopped-${Date.now()}.txt`,
              );
              return fd;
            })(),
          });
        } catch {}
      }
    } else {
      setStatus(e.message, "err");
      asstMsg.content = assistantText || `[error: ${e.message}]`;
    }
    renderMessages();
  } finally {
    activeAbort = null;
    setSendingState(false);
    pendingAttachments.length = 0;
    renderPendingAttachments();
    saveJSON(SESSIONS_KEY, state.sessions);
    loadWings(els.wing.value);
    refreshTokenMeter();
  }
}

function stopGeneration() {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  // Stop any in-flight TTS playback as well
  stopActiveAudio();
}

/* ─── Wing operations ─────────────────────────────────────────────────── */

async function renameWing() {
  const old = els.wing.value;
  const next = prompt(`Rename wing "${old}" to:`, old);
  if (!next || next.trim() === old) return;
  setStatus(`renaming ${old} → ${next}…`, "");
  try {
    const r = await fetch(`/api/wings/${encodeURIComponent(old)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: next.trim() }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || JSON.stringify(data));
    setStatus(`renamed ${data.renamed} drawers`, "ok");
    const newName = next.trim();
    forgetWing(old);
    rememberWing(newName);
    if (state.wingPrompts[old]) {
      state.wingPrompts[newName] = state.wingPrompts[old];
      delete state.wingPrompts[old];
      saveJSON(WING_PROMPT_KEY, state.wingPrompts);
    }
    for (const s of state.sessions) {
      if (s.wing === old) s.wing = newName;
    }
    saveJSON(SESSIONS_KEY, state.sessions);
    await loadWings(newName);
    setCurrentWing(newName);
    renderSessions();
  } catch (e) {
    setStatus(`rename failed: ${e.message}`, "err");
  }
}

async function deleteWing() {
  const name = els.wing.value;
  if (
    !confirm(
      `Delete wing "${name}" and ALL its drawers? Sessions stay but lose their memory.`,
    )
  )
    return;
  try {
    const r = await fetch(`/api/wings/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || JSON.stringify(data));
    setStatus(`deleted ${data.deleted} drawers from ${name}`, "warn");
    forgetWing(name);
    delete state.wingPrompts[name];
    saveJSON(WING_PROMPT_KEY, state.wingPrompts);
    await loadWings("personal");
    setCurrentWing("personal");
  } catch (e) {
    setStatus(`delete failed: ${e.message}`, "err");
  }
}

/* ─── Event wiring ─────────────────────────────────────────────────────── */

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  // If a generation is in flight OR TTS is reading, the send button acts as STOP.
  if (activeAbort) {
    stopGeneration();
    return;
  }
  if (activeAudio) {
    stopActiveAudio();
    setStatus("speech stopped", "warn");
    return;
  }
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  els.input.style.height = "auto";
  savePrefs();
  sendMessage(text);
});

els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + "px";
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey || true)) {
    if (e.shiftKey) return;
    e.preventDefault();
    els.composer.dispatchEvent(new Event("submit"));
  }
});

els.newChat.addEventListener("click", () => {
  createSession();
  renderSessions();
  renderMessages();
  renderHits([]);
  els.input.focus();
});

els.newIncognito.addEventListener("click", () => {
  createSession({ anonymous: true });
  renderSessions();
  renderMessages();
  renderHits([]);
  setStatus("incognito chat — won't recall or save", "warn");
  els.input.focus();
});

els.toggleWingFilter.addEventListener("click", () => {
  state.prefs.showAllWings = !state.prefs.showAllWings;
  saveJSON(PREFS_KEY, state.prefs);
  syncWingFilter();
  renderSessions();
});

els.composerRecall.addEventListener("click", () => {
  state.prefs.recall = !state.prefs.recall;
  els.tRecall.checked = state.prefs.recall;
  savePrefs();
});

els.toggleMemoryPane.addEventListener("click", () => {
  els.memoryPane.hidden = !els.memoryPane.hidden;
});
els.closeMemory.addEventListener("click", () => {
  els.memoryPane.hidden = true;
});

const isMobile = () => window.matchMedia("(max-width: 768px)").matches;

els.toggleSidebar.addEventListener("click", () => {
  if (isMobile()) {
    document.body.classList.remove("mobile-sidebar-open");
    return;
  }
  document.body.classList.add("no-sidebar");
  els.sidebar.classList.add("hidden");
  els.showSidebar.classList.remove("hidden");
});
els.showSidebar.addEventListener("click", () => {
  if (isMobile()) {
    document.body.classList.add("mobile-sidebar-open");
    return;
  }
  document.body.classList.remove("no-sidebar");
  els.sidebar.classList.remove("hidden");
  els.showSidebar.classList.add("hidden");
});

// Tap the dim backdrop on mobile to close the sidebar
document.addEventListener("click", (e) => {
  if (
    !isMobile() ||
    !document.body.classList.contains("mobile-sidebar-open")
  )
    return;
  // Click was outside the sidebar and not on the toggle? Close.
  if (
    !els.sidebar.contains(e.target) &&
    e.target !== els.showSidebar &&
    !els.showSidebar.contains(e.target)
  ) {
    document.body.classList.remove("mobile-sidebar-open");
  }
});

els.openSettings.addEventListener("click", openSettings);
els.composerPlus.addEventListener("click", () => els.attachFileInput.click());
els.closeSettings.addEventListener("click", () => {
  els.settingsOverlay.hidden = true;
  saveWingPromptForCurrent();
});

els.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === els.settingsOverlay) {
    els.settingsOverlay.hidden = true;
    saveWingPromptForCurrent();
  }
});

async function openSettings() {
  els.settingsOverlay.hidden = false;
  // Default to Identity pane on each open (most users start there)
  showSettingsPane(localStorage.getItem("ollama-mempalace.settingsPane") || "identity");
  await loadPersonas();
  await loadIdentity();
  loadWingPromptForCurrent();
  loadWakeup();
  loadAttachments();
  loadAaak();
  loadVoices();
  loadInstalledModels();
  loadMcpClients();
  loadAgents();
}

async function loadInstalledModels() {
  const host = document.getElementById("installed-models-list");
  if (!host) return;
  host.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/models/installed");
    const d = await r.json();
    const models = d.models || [];
    if (!models.length) {
      host.innerHTML = '<div class="muted">no models installed yet</div>';
      return;
    }
    host.innerHTML = "";
    for (const m of models) {
      const row = document.createElement("div");
      row.className = "model-row";
      const sizeGb = (m.size / 1024 / 1024 / 1024).toFixed(1);
      const params = m.details?.parameter_size || "?";
      const quant = m.details?.quantization_level || "?";
      row.innerHTML = `
        <div class="model-info">
          <span class="model-name">${escapeHtml(m.name)}</span>
          <span class="model-meta">${sizeGb} GB · ${escapeHtml(params)} · ${escapeHtml(quant)}</span>
        </div>
        <button class="danger del-model" data-name="${escapeHtml(m.name)}" type="button">delete</button>
      `;
      row.querySelector(".del-model").addEventListener("click", async () => {
        if (!confirm(`Delete model "${m.name}"? This frees ~${sizeGb} GB of disk and cannot be undone via the UI.`))
          return;
        try {
          const dr = await fetch(`/api/models/${encodeURIComponent(m.name)}`, {
            method: "DELETE",
          });
          const dd = await dr.json();
          if (!dr.ok) throw new Error(dd.detail || "failed");
          setStatus(`deleted ${m.name}`, "warn");
          await loadInstalledModels();
          await loadModels();
        } catch (e) {
          alert(`delete failed: ${e.message}`);
        }
      });
      host.appendChild(row);
    }
  } catch (e) {
    host.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

/* ─── Sub-agents (Settings → Agents) ──────────────────────────────────── */

async function loadAgents() {
  const host = document.getElementById("agents-list");
  if (!host) return;
  host.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/agents");
    const d = await r.json();
    const agents = d.agents || [];
    if (!agents.length) {
      host.innerHTML =
        '<div class="muted">No sub-agents yet. Add one to enable the <code>delegate</code> tool.</div>';
      return;
    }
    host.innerHTML = "";
    for (const a of agents) {
      const row = document.createElement("div");
      row.className = "agent-row";
      const memWing = a.use_memory ? a.wing || "personal" : "no memory";
      row.innerHTML = `
        <div class="name-row">
          <span class="name">${escapeHtml(a.name)}</span>
          <span class="actions">
            <button class="ghost agent-edit" data-name="${escapeHtml(a.name)}" type="button">edit</button>
            <button class="danger agent-del" data-name="${escapeHtml(a.name)}" type="button">delete</button>
          </span>
        </div>
        <div class="muted">${escapeHtml(a.description || "(no description)")}</div>
        <div class="muted agent-meta">model: <code>${escapeHtml(a.model || "?")}</code> · memory: <code>${escapeHtml(memWing)}</code></div>
      `;
      host.appendChild(row);
    }
  } catch (e) {
    host.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

function openAgentEditor(existing) {
  const host = document.getElementById("agents-list");
  if (!host) return;
  host.querySelectorAll(".agent-edit-form").forEach((n) => n.remove());
  const isNew = !existing;
  const a = existing || {
    name: "",
    description: "",
    system_prompt: "",
    model: state.models[0] || "",
    wing: "",
    use_memory: true,
  };
  // Build a model picker from currently installed Ollama models
  const modelOptions = state.models
    .map(
      (m) =>
        `<option value="${escapeHtml(m)}" ${m === a.model ? "selected" : ""}>${escapeHtml(m)}</option>`,
    )
    .join("");
  // Build a wing picker from known wings, plus blank for "use chat's current wing"
  const wingOptions =
    `<option value="">(use the calling chat's wing)</option>` +
    [...new Set([...state.knownWings, ...state.wings.map((w) => w.name)])]
      .sort()
      .map(
        (w) =>
          `<option value="${escapeHtml(w)}" ${w === (a.wing || "") ? "selected" : ""}>${escapeHtml(w)}</option>`,
      )
      .join("");
  const form = document.createElement("div");
  form.className = "persona-edit agent-edit-form";
  form.innerHTML = `
    <div class="persona-edit-row">
      <span class="muted">name</span>
      <input class="ag-name" value="${escapeHtml(a.name)}" ${isNew ? "" : "readonly"} placeholder="e.g. researcher" />
    </div>
    <div class="persona-edit-row">
      <span class="muted">description</span>
      <input class="ag-desc" value="${escapeHtml(a.description || "")}" placeholder="one-line summary the primary agent reads" />
    </div>
    <div class="persona-edit-row">
      <span class="muted">model</span>
      <select class="ag-model">${modelOptions}</select>
    </div>
    <div class="persona-edit-row">
      <span class="muted">wing</span>
      <select class="ag-wing">${wingOptions}</select>
    </div>
    <label class="check"><input class="ag-mem" type="checkbox" ${a.use_memory !== false ? "checked" : ""} /> use memory recall (search the wing before answering)</label>
    <span class="muted">system prompt (the agent's identity / instructions)</span>
    <textarea class="ag-prompt" rows="6">${escapeHtml(a.system_prompt || "")}</textarea>
    <div class="persona-edit-row">
      <button type="button" class="primary ag-save">${isNew ? "Create" : "Save"}</button>
      <button type="button" class="ghost ag-cancel">Cancel</button>
      <span class="muted ag-status"></span>
    </div>
  `;
  host.appendChild(form);
  form.querySelector(".ag-cancel").addEventListener("click", () => form.remove());
  form.querySelector(".ag-save").addEventListener("click", async () => {
    const name = form.querySelector(".ag-name").value.trim();
    const description = form.querySelector(".ag-desc").value.trim();
    const model = form.querySelector(".ag-model").value;
    const wing = form.querySelector(".ag-wing").value || null;
    const use_memory = form.querySelector(".ag-mem").checked;
    const system_prompt = form.querySelector(".ag-prompt").value;
    const status = form.querySelector(".ag-status");
    if (!name || !model) {
      status.textContent = "name + model required";
      return;
    }
    status.textContent = "saving…";
    try {
      const url = isNew
        ? "/api/agents"
        : `/api/agents/${encodeURIComponent(a.name)}`;
      const method = isNew ? "POST" : "PUT";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          system_prompt,
          model,
          wing,
          use_memory,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      form.remove();
      await loadAgents();
    } catch (e) {
      status.textContent = `error: ${e.message}`;
    }
  });
}

document.addEventListener("click", async (e) => {
  if (e.target.id === "agent-new") openAgentEditor(null);
  if (e.target.classList?.contains("agent-edit")) {
    const name = e.target.dataset.name;
    const r = await fetch("/api/agents");
    const d = await r.json();
    const ag = (d.agents || []).find((x) => x.name === name);
    if (ag) openAgentEditor(ag);
  }
  if (e.target.classList?.contains("agent-del")) {
    const name = e.target.dataset.name;
    if (!confirm(`Delete agent "${name}"?`)) return;
    await fetch(`/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" });
    loadAgents();
  }
});

/* ─── MCP clients (Settings → MCP) ────────────────────────────────────── */

async function loadMcpClients() {
  const host = document.getElementById("mcp-clients-list");
  if (!host) return;
  host.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/mcp/clients");
    const d = await r.json();
    const clients = d.clients || [];
    if (!clients.length) {
      host.innerHTML =
        '<div class="muted">No external MCP servers configured yet. Add one below.</div>';
      return;
    }
    host.innerHTML = "";
    for (const c of clients) {
      const row = document.createElement("div");
      row.className = "mcp-client-row";
      const status = c.is_running
        ? "✓ running"
        : c.last_error
          ? `✗ ${c.last_error}`
          : "○ stopped";
      row.innerHTML = `
        <div class="name-row">
          <span class="name">${escapeHtml(c.name)}</span>
          <span class="actions">
            <button class="ghost mcp-probe" data-name="${escapeHtml(c.name)}" type="button">probe</button>
            <button class="ghost mcp-edit" data-name="${escapeHtml(c.name)}" type="button">edit</button>
            <button class="danger mcp-del" data-name="${escapeHtml(c.name)}" type="button">delete</button>
          </span>
        </div>
        <div class="muted mcp-cmd"><code>${escapeHtml(c.command)} ${(c.args || []).map(escapeHtml).join(" ")}</code></div>
        <div class="muted mcp-status">${escapeHtml(status)} · ${c.enabled ? "enabled" : "disabled"} · ${c.tool_count || 0} tools</div>
      `;
      host.appendChild(row);
    }
  } catch (e) {
    host.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

function openMcpEditor(existing) {
  const host = document.getElementById("mcp-clients-list");
  if (!host) return;
  host.querySelectorAll(".mcp-edit-form").forEach((n) => n.remove());
  const isNew = !existing;
  const c = existing || {
    name: "",
    command: "",
    args: [],
    env: {},
    enabled: true,
  };
  const form = document.createElement("div");
  form.className = "persona-edit mcp-edit-form";
  form.innerHTML = `
    <div class="persona-edit-row">
      <span class="muted">name</span>
      <input class="me-name" value="${escapeHtml(c.name)}" ${isNew ? "" : "readonly"} placeholder="e.g. filesystem" />
    </div>
    <div class="persona-edit-row">
      <span class="muted">command</span>
      <input class="me-command" value="${escapeHtml(c.command || "")}" placeholder="e.g. npx" />
    </div>
    <div class="persona-edit-row">
      <span class="muted">args (one per line)</span>
    </div>
    <textarea class="me-args" rows="3" placeholder="-y\n@modelcontextprotocol/server-filesystem\n/Users/me/Documents">${escapeHtml((c.args || []).join("\n"))}</textarea>
    <div class="persona-edit-row">
      <span class="muted">env vars (KEY=VALUE per line)</span>
    </div>
    <textarea class="me-env" rows="2" placeholder="GITHUB_TOKEN=ghp_…">${escapeHtml(
      Object.entries(c.env || {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    )}</textarea>
    <label class="check"><input class="me-enabled" type="checkbox" ${c.enabled !== false ? "checked" : ""} /> enabled</label>
    <div class="persona-edit-row">
      <button type="button" class="primary me-save">${isNew ? "Create" : "Save"}</button>
      <button type="button" class="ghost me-cancel">Cancel</button>
      <span class="muted me-status"></span>
    </div>
  `;
  host.appendChild(form);
  form.querySelector(".me-cancel").addEventListener("click", () => form.remove());
  form.querySelector(".me-save").addEventListener("click", async () => {
    const name = form.querySelector(".me-name").value.trim();
    const command = form.querySelector(".me-command").value.trim();
    const args = form
      .querySelector(".me-args")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const env = {};
    form
      .querySelector(".me-env")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((line) => {
        const idx = line.indexOf("=");
        if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
    const enabled = form.querySelector(".me-enabled").checked;
    const status = form.querySelector(".me-status");
    if (!name || !command) {
      status.textContent = "name + command required";
      return;
    }
    status.textContent = "saving…";
    try {
      const r = await fetch("/api/mcp/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, command, args, env, enabled }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      form.remove();
      await loadMcpClients();
    } catch (e) {
      status.textContent = `error: ${e.message}`;
    }
  });
}

document.addEventListener("click", async (e) => {
  if (e.target.id === "mcp-new") openMcpEditor(null);
  if (e.target.id === "mcp-refresh") loadMcpClients();
  if (e.target.classList?.contains("mcp-edit")) {
    const name = e.target.dataset.name;
    const r = await fetch("/api/mcp/clients");
    const d = await r.json();
    const cli = (d.clients || []).find((c) => c.name === name);
    if (cli) openMcpEditor(cli);
  }
  if (e.target.classList?.contains("mcp-del")) {
    const name = e.target.dataset.name;
    if (!confirm(`Delete MCP server "${name}"?`)) return;
    await fetch(`/api/mcp/clients/${encodeURIComponent(name)}`, { method: "DELETE" });
    loadMcpClients();
  }
  if (e.target.classList?.contains("mcp-probe")) {
    const name = e.target.dataset.name;
    e.target.disabled = true;
    e.target.textContent = "probing…";
    try {
      const r = await fetch(`/api/mcp/clients/${encodeURIComponent(name)}/probe`, {
        method: "POST",
      });
      const d = await r.json();
      if (d.ok) {
        setStatus(`${name}: ${d.tools.length} tools, ${d.resources.length} resources`, "ok");
      } else {
        setStatus(`${name}: ${d.error || "failed"}`, "err");
      }
      loadMcpClients();
    } finally {
      e.target.disabled = false;
      e.target.textContent = "probe";
    }
  }
});

async function pullModelFlow() {
  const inp = document.getElementById("pull-model-name");
  const progress = document.getElementById("pull-progress");
  const btn = document.getElementById("pull-model-btn");
  const name = (inp.value || "").trim();
  if (!name) return;
  btn.disabled = true;
  progress.textContent = "starting…";
  try {
    const r = await fetch("/api/models/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === "error") {
              progress.textContent = `error: ${evt.message}`;
              return;
            }
            const status = evt.status || "";
            const total = evt.total;
            const completed = evt.completed;
            if (total && completed) {
              const pct = ((completed / total) * 100).toFixed(0);
              const mb = (completed / 1024 / 1024).toFixed(0);
              const totalMb = (total / 1024 / 1024).toFixed(0);
              progress.textContent = `${status} — ${pct}% (${mb} / ${totalMb} MB)`;
            } else {
              progress.textContent = status;
            }
            if (status === "success") {
              progress.textContent = `pulled ${name} ✓`;
              await loadInstalledModels();
              await loadModels();
              inp.value = "";
              return;
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    progress.textContent = `error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

function showSettingsPane(name) {
  document.querySelectorAll(".settings-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.pane === name);
  });
  document.querySelectorAll(".settings-pane").forEach((p) => {
    p.hidden = p.dataset.pane !== name;
  });
  localStorage.setItem("ollama-mempalace.settingsPane", name);
}

document.querySelectorAll(".settings-tab").forEach((t) => {
  t.addEventListener("click", () => showSettingsPane(t.dataset.pane));
});

// Models pane wireup
document.addEventListener("click", (e) => {
  if (e.target.id === "refresh-installed-models") loadInstalledModels();
  if (e.target.id === "pull-model-btn") pullModelFlow();
});

/* ─── Attachments ─────────────────────────────────────────────────────── */

function makeAttachChip(text, kind = "") {
  const chip = document.createElement("div");
  chip.className = `attach-chip ${kind}`;
  chip.textContent = text;
  els.attachStaging.appendChild(chip);
  els.attachStaging.hidden = false;
  return chip;
}

async function uploadAttachment(file) {
  const wing = state.prefs.wing || "personal";
  const chip = makeAttachChip(`uploading ${file.name}…`, "uploading");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await fetch(`/api/wings/${encodeURIComponent(wing)}/attach`, {
      method: "POST",
      body: fd,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || JSON.stringify(data));
    chip.textContent = `✓ ${file.name} → ${data.chunks} chunks in ${wing}`;
    chip.className = "attach-chip ok";
    setStatus(`attached ${file.name} (${data.chunks} chunks)`, "ok");
    rememberWing(wing);
    await loadWings(wing);
    if (!els.settingsOverlay.hidden) loadAttachments();
  } catch (e) {
    chip.textContent = `✗ ${file.name}: ${e.message}`;
    chip.className = "attach-chip err";
    setStatus(`attach failed: ${e.message}`, "err");
  }
  // Auto-dismiss successful chips after 6s
  setTimeout(() => {
    chip.remove();
    if (!els.attachStaging.children.length) els.attachStaging.hidden = true;
  }, 6000);
}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml",
  "py", "js", "jsx", "ts", "tsx", "html", "htm", "css", "scss", "less",
  "rs", "go", "java", "c", "cpp", "h", "hpp", "rb", "php", "sh", "bash",
  "zsh", "sql", "log", "conf", "ini", "toml", "xml", "tex", "rst", "vue",
  "svelte", "lua", "r", "kt", "swift", "dart", "ex", "exs", "elm",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

function fileExt(file) {
  const name = (file.name || "").toLowerCase();
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1);
}

function isLikelyText(file) {
  return TEXT_EXTENSIONS.has(fileExt(file));
}

function isLikelyImage(file) {
  return (
    IMAGE_EXTENSIONS.has(fileExt(file)) ||
    (file.type || "").startsWith("image/")
  );
}

async function walkEntry(entry, out) {
  if (!entry) return;
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file((file) => {
        out.push(file);
        resolve();
      }, resolve);
    });
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    return new Promise((resolve) => {
      const collected = [];
      const readBatch = () => {
        reader.readEntries(async (entries) => {
          if (!entries.length) {
            for (const e of collected) await walkEntry(e, out);
            resolve();
          } else {
            collected.push(...entries);
            readBatch();
          }
        }, resolve);
      };
      readBatch();
    });
  }
}

async function collectFromDataTransfer(dt) {
  if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
    const all = [];
    const promises = [];
    for (const item of dt.items) {
      const entry = item.webkitGetAsEntry();
      promises.push(walkEntry(entry, all));
    }
    await Promise.all(promises);
    return all;
  }
  return Array.from(dt.files || []);
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList);
  const text = files.filter(isLikelyText);
  const skipped = files.length - text.length;
  if (skipped) {
    setStatus(`skipping ${skipped} non-text file(s)`, "warn");
  }
  for (const f of text) {
    await uploadAttachment(f);
  }
}

async function loadAttachments() {
  const wing = state.prefs.wing || "personal";
  if (!els.attachmentsList) return;
  els.attachmentsList.innerHTML = '<div class="attachment-empty">loading…</div>';
  try {
    const r = await fetch(
      `/api/wings/${encodeURIComponent(wing)}/attachments`,
    );
    const data = await r.json();
    els.attachmentsList.innerHTML = "";
    if (!data.attachments?.length) {
      els.attachmentsList.innerHTML =
        '<div class="attachment-empty">No files attached to this wing.</div>';
      return;
    }
    for (const a of data.attachments) {
      const row = document.createElement("div");
      row.className = "attachment-row";
      row.innerHTML = `
        <span>
          <span class="filename">${escapeHtml(a.filename)}</span>
          <span class="meta">${a.chunks} chunks</span>
        </span>
        <button class="danger" type="button">remove</button>
      `;
      row.querySelector("button").addEventListener("click", async () => {
        if (!confirm(`Remove ${a.filename} from wing "${wing}"?`)) return;
        try {
          const dr = await fetch(
            `/api/wings/${encodeURIComponent(wing)}/attachments?filename=${encodeURIComponent(a.filename)}`,
            { method: "DELETE" },
          );
          const dd = await dr.json();
          if (!dr.ok) throw new Error(dd.detail || "failed");
          setStatus(`removed ${a.filename} (${dd.deleted} chunks)`, "warn");
          await loadAttachments();
          await loadWings(wing);
        } catch (e) {
          setStatus(`remove failed: ${e.message}`, "err");
        }
      });
      els.attachmentsList.appendChild(row);
    }
  } catch (e) {
    els.attachmentsList.innerHTML = `<div class="attachment-empty">error: ${escapeHtml(e.message)}</div>`;
  }
}

/* ─── Pending (per-message) attachments ─────────────────────────────── */

const pendingAttachments = []; // { name, size, content }

const STAGE_MAX_BYTES = 5 * 1024 * 1024;

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

async function stageAttachment(file) {
  if (file.size > STAGE_MAX_BYTES) {
    setStatus(`skipped ${file.name} (>5MB)`, "warn");
    return;
  }
  if (isLikelyImage(file)) {
    try {
      const dataUrl = await readFileAsDataURL(file);
      // Strip the data:<mime>;base64, prefix — Ollama wants raw base64
      const b64 = dataUrl.includes(",") ? dataUrl.split(",", 2)[1] : dataUrl;
      pendingAttachments.push({
        kind: "image",
        name: file.name,
        size: file.size,
        dataUrl,
        b64,
      });
      renderPendingAttachments();
    } catch (e) {
      setStatus(`failed to read ${file.name}: ${e.message}`, "err");
    }
    return;
  }
  if (!isLikelyText(file)) {
    setStatus(`skipped ${file.name} (not text or image)`, "warn");
    return;
  }
  try {
    const content = await file.text();
    pendingAttachments.push({
      kind: "text",
      name: file.name,
      size: file.size,
      content,
    });
    renderPendingAttachments();
  } catch (e) {
    setStatus(`failed to read ${file.name}: ${e.message}`, "err");
  }
}

async function stageMany(fileList) {
  for (const f of Array.from(fileList)) {
    await stageAttachment(f);
  }
}

function renderPendingAttachments() {
  const host = els.pendingAttachments;
  host.innerHTML = "";
  if (!pendingAttachments.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  pendingAttachments.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "pending-chip";
    if (p.kind === "image") {
      chip.innerHTML = `
        <img class="pchip-thumb" src="${escapeHtml(p.dataUrl)}" alt="" />
        <span class="fname">${escapeHtml(p.name)}</span>
        <span class="fsize">${(p.size / 1024).toFixed(1)} KB</span>
        <span class="x" title="remove">×</span>
      `;
    } else {
      chip.innerHTML = `
        <span>📎</span>
        <span class="fname">${escapeHtml(p.name)}</span>
        <span class="fsize">${(p.size / 1024).toFixed(1)} KB</span>
        <span class="x" title="remove">×</span>
      `;
    }
    chip.querySelector(".x").addEventListener("click", () => {
      pendingAttachments.splice(i, 1);
      renderPendingAttachments();
    });
    host.appendChild(chip);
  });
}

function buildAttachmentPreamble() {
  const textParts = pendingAttachments
    .filter((p) => p.kind !== "image")
    .map((p) => `[Attached file: ${p.name}]\n${p.content}\n[End of ${p.name}]`);
  return textParts.length ? textParts.join("\n\n") + "\n\n" : "";
}

function pendingImagesB64() {
  return pendingAttachments
    .filter((p) => p.kind === "image")
    .map((p) => p.b64);
}

function pendingFilenames() {
  return pendingAttachments.map((p) => p.name);
}

/* Composer + now stages; wing-permanent upload uses its own button. */
els.attachFileInput.addEventListener("change", async (e) => {
  await stageMany(e.target.files);
  els.attachFileInput.value = "";
});

if (els.wingFileInput) {
  els.wingFileInput.addEventListener("change", async (e) => {
    await uploadFiles(e.target.files);
    els.wingFileInput.value = "";
  });
}

if (els.uploadWingFileBtn) {
  els.uploadWingFileBtn.addEventListener("click", () =>
    els.wingFileInput.click(),
  );
}

/* ─── Voice input (Whisper) ───────────────────────────────────────────── */

let micRecorder = null;
let micChunks = [];
let micStream = null;
let micAudioCtx = null;

const WHISPER_PREF_KEY = "ollama-mempalace.whisperModel";

function preferredWhisperModel() {
  return localStorage.getItem(WHISPER_PREF_KEY) || "base.en";
}

async function startMic() {
  if (micRecorder) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
      },
    });
  } catch (e) {
    setStatus(`mic permission denied: ${e.message}`, "err");
    return;
  }
  // Pick a supported mimeType — Safari prefers mp4, Chrome prefers webm.
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "";
  micRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
  micChunks = [];
  micRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) micChunks.push(e.data);
  };
  micRecorder.onstop = handleMicStop;
  micRecorder.start();
  els.composerMic.classList.add("recording");
  setStatus("recording — click mic to stop", "");
}

function stopMic() {
  if (micRecorder && micRecorder.state !== "inactive") {
    micRecorder.stop();
  }
}

async function handleMicStop() {
  els.composerMic.classList.remove("recording");
  els.composerMic.classList.add("transcribing");
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  const mime = micRecorder?.mimeType || "audio/webm";
  micRecorder = null;
  const blob = new Blob(micChunks, { type: mime });
  micChunks = [];
  if (!blob.size) {
    els.composerMic.classList.remove("transcribing");
    setStatus("nothing recorded", "warn");
    return;
  }
  setStatus("transcribing…", "");
  let wavBlob;
  try {
    wavBlob = await encodeAsWav(blob);
  } catch (e) {
    els.composerMic.classList.remove("transcribing");
    setStatus(`audio decode failed: ${e.message}`, "err");
    return;
  }
  const fd = new FormData();
  fd.append("audio", wavBlob, "recording.wav");
  fd.append("model", preferredWhisperModel());
  try {
    const r = await fetch("/api/transcribe", { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || JSON.stringify(data));
    const text = (data.text || "").trim();
    if (text) {
      const cur = els.input.value;
      els.input.value = cur ? `${cur} ${text}` : text;
      els.input.dispatchEvent(new Event("input"));
      els.input.focus();
      // Silently fill — no toast. The text appearing IS the feedback.
    } else {
      setStatus("transcription empty", "warn");
    }
  } catch (e) {
    setStatus(`transcribe failed: ${e.message}`, "err");
  } finally {
    els.composerMic.classList.remove("transcribing");
  }
}

async function encodeAsWav(blob) {
  if (!micAudioCtx) {
    micAudioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 16000,
    });
  }
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await micAudioCtx.decodeAudioData(arrayBuffer);
  // Downmix to mono if multi-channel
  const samples = mixToMono(audioBuffer);
  // Resample to 16 kHz if needed (AudioContext at 16k usually handles it)
  return audioBufferSamplesToWav(samples, 16000);
}

function mixToMono(audioBuffer) {
  const len = audioBuffer.length;
  if (audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }
  const out = new Float32Array(len);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  for (let i = 0; i < len; i++) out[i] /= audioBuffer.numberOfChannels;
  return out;
}

function audioBufferSamplesToWav(samples, sampleRate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([bytes], { type: "audio/wav" });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

if (els.composerMic) {
  els.composerMic.addEventListener("click", () => {
    if (micRecorder && micRecorder.state !== "inactive") {
      stopMic();
    } else {
      startMic();
    }
  });
}

if (els.whisperModel) {
  els.whisperModel.value = preferredWhisperModel();
  els.whisperModel.addEventListener("change", () => {
    localStorage.setItem(WHISPER_PREF_KEY, els.whisperModel.value);
  });
}

/* ─── Voice output (TTS via macOS `say`) ──────────────────────────────── */

const TTS_PREF_KEY = "ollama-mempalace.tts";

function ttsPrefs() {
  return loadJSON(TTS_PREF_KEY, { enabled: false, voice: "Samantha", rate: null });
}

function saveTtsPrefs(p) {
  saveJSON(TTS_PREF_KEY, p);
}

async function loadVoices() {
  if (!els.ttsVoice) return;
  try {
    const r = await fetch("/api/voices?lang_prefix=en");
    const d = await r.json();
    const cur = ttsPrefs().voice || "Samantha";
    els.ttsVoice.innerHTML = (d.voices || [])
      .map(
        (v) =>
          `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} · ${escapeHtml(v.lang)}</option>`,
      )
      .join("");
    if ([...els.ttsVoice.options].some((o) => o.value === cur)) {
      els.ttsVoice.value = cur;
    }
  } catch (e) {
    setStatus(`voices: ${e.message}`, "err");
  }
}

let activeAudio = null;

function stopActiveAudio() {
  if (activeAudio) {
    try {
      activeAudio.pause();
      if (activeAudio.src && activeAudio.src.startsWith("blob:")) {
        URL.revokeObjectURL(activeAudio.src);
      }
    } catch {}
    activeAudio = null;
    setSendingState(false);
  }
}

async function speakText(text) {
  const t = (text || "").trim();
  if (!t) return;
  const prefs = ttsPrefs();
  stopActiveAudio();
  try {
    const r = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: t,
        voice: prefs.voice || "Samantha",
        rate: prefs.rate || undefined,
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    activeAudio = audio;
    // While audio plays, repurpose the send button as a stop control so
    // there's an obvious way to halt long readings without typing or hunting.
    setSendingState(true);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) {
        activeAudio = null;
        setSendingState(false);
      }
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) {
        activeAudio = null;
        setSendingState(false);
      }
    };
    await audio.play();
  } catch (e) {
    setStatus(`speak failed: ${e.message}`, "err");
  }
}

if (els.tTts) {
  const p = ttsPrefs();
  els.tTts.checked = !!p.enabled;
  if (els.ttsRate && p.rate) els.ttsRate.value = p.rate;
  els.tTts.addEventListener("change", () => {
    const p2 = ttsPrefs();
    p2.enabled = els.tTts.checked;
    saveTtsPrefs(p2);
    if (p2.enabled) loadVoices();
  });
}

if (els.ttsVoice) {
  els.ttsVoice.addEventListener("change", () => {
    const p = ttsPrefs();
    p.voice = els.ttsVoice.value;
    saveTtsPrefs(p);
  });
}

if (els.ttsRate) {
  els.ttsRate.addEventListener("change", () => {
    const p = ttsPrefs();
    const v = parseInt(els.ttsRate.value, 10);
    p.rate = Number.isFinite(v) && v >= 80 && v <= 500 ? v : null;
    saveTtsPrefs(p);
  });
}

let _dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  _dragDepth++;
  els.dragOverlay.hidden = false;
  els.chatArea.classList.add("drag-over");
  els.dragWing.textContent = state.prefs.wing || "personal";
});
window.addEventListener("dragleave", () => {
  _dragDepth = Math.max(0, _dragDepth - 1);
  if (_dragDepth === 0) {
    els.dragOverlay.hidden = true;
    els.chatArea.classList.remove("drag-over");
  }
});
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", async (e) => {
  if (!e.dataTransfer) return;
  e.preventDefault();
  _dragDepth = 0;
  els.dragOverlay.hidden = true;
  els.chatArea.classList.remove("drag-over");
  const files = await collectFromDataTransfer(e.dataTransfer);
  if (!files.length) return;
  // Dropping onto the settings panel → persist to wing; onto the chat area → stage for message.
  const onSettings = els.settingsOverlay && !els.settingsOverlay.hidden;
  if (onSettings) await uploadFiles(files);
  else await stageMany(files);
});

/* ─── Memory modal ────────────────────────────────────────────────────── */

const browserState = { offset: 0, limit: 50, total: 0 };
const browserSelected = new Set(); // drawer_ids checked across renders

function syncBulkBar() {
  if (!els.browserBulkBar) return;
  const n = browserSelected.size;
  els.browserBulkBar.hidden = n === 0;
  if (els.bulkSelectedCount) els.bulkSelectedCount.textContent = String(n);
  if (els.bulkMoveBtn)
    els.bulkMoveBtn.disabled = !els.bulkMoveWing?.value || n === 0;
  // Update select-all state
  if (els.browserSelectAll) {
    const visibleRows = els.browserList?.querySelectorAll(".drawer-row") || [];
    const checked = [...visibleRows].filter((r) =>
      browserSelected.has(r.dataset.id),
    ).length;
    els.browserSelectAll.checked =
      visibleRows.length > 0 && checked === visibleRows.length;
    els.browserSelectAll.indeterminate =
      checked > 0 && checked < visibleRows.length;
  }
}

function populateBulkMoveWingPicker() {
  if (!els.bulkMoveWing) return;
  const wings = [
    ...new Set([...state.knownWings, ...state.wings.map((w) => w.name)]),
  ].sort();
  els.bulkMoveWing.innerHTML =
    `<option value="">— move to wing —</option>` +
    wings
      .map(
        (w) => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`,
      )
      .join("");
}

function fmtTime(iso) {
  if (!iso) return "?";
  try {
    const d = new Date(iso);
    return (
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    );
  } catch {
    return iso;
  }
}

async function loadStats() {
  els.statsContent.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/stats");
    const data = await r.json();
    const wingsArr = Object.entries(data.wings || {}).sort((a, b) => b[1] - a[1]);
    const roomsArr = Object.entries(data.rooms || {}).sort((a, b) => b[1] - a[1]);
    const maxW = Math.max(1, ...wingsArr.map((w) => w[1]));
    const maxR = Math.max(1, ...roomsArr.map((r) => r[1]));
    const wingsCount = Object.keys(data.wings || {}).length;
    const roomsCount = Object.keys(data.rooms || {}).length;
    els.statsContent.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="label">total drawers</div>
          <div class="value">${data.total ?? 0}</div>
        </div>
        <div class="stat-card">
          <div class="label">wings</div>
          <div class="value">${wingsCount}</div>
        </div>
        <div class="stat-card">
          <div class="label">rooms</div>
          <div class="value">${roomsCount}</div>
        </div>
      </div>
      <div class="stats-section">
        <h4>Wings (top 10)</h4>
        ${wingsArr
          .slice(0, 10)
          .map(
            ([name, count]) => `
          <div class="bar-row">
            <span class="bar-name">${escapeHtml(name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(count / maxW) * 100}%"></span></span>
            <span class="bar-count">${count}</span>
          </div>
        `,
          )
          .join("")}
      </div>
      <div class="stats-section">
        <h4>Rooms (top 10)</h4>
        ${roomsArr
          .slice(0, 10)
          .map(
            ([name, count]) => `
          <div class="bar-row">
            <span class="bar-name">${escapeHtml(name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(count / maxR) * 100}%"></span></span>
            <span class="bar-count">${count}</span>
          </div>
        `,
          )
          .join("")}
      </div>
      <div class="muted" style="margin-top:14px">palace path: <code>${escapeHtml(data.palace_path || "")}</code></div>
    `;
  } catch (e) {
    els.statsContent.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadTaxonomy() {
  els.taxonomyContent.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/taxonomy");
    const data = await r.json();
    const tax = data.taxonomy || {};
    const keys = Object.keys(tax).sort();
    if (!keys.length) {
      els.taxonomyContent.innerHTML =
        '<div class="muted">No drawers yet. Send a message or attach a file to get started.</div>';
      return;
    }
    els.taxonomyContent.innerHTML = keys
      .map((wing) => {
        const rooms = tax[wing] || {};
        const roomEntries = Object.entries(rooms).sort((a, b) => b[1] - a[1]);
        const total = roomEntries.reduce((s, [, c]) => s + c, 0);
        return `
        <div class="tax-wing">
          <div class="tax-wing-name">
            <span>${escapeHtml(wing)}</span>
            <span class="tax-wing-count">${total} drawers</span>
          </div>
          <div class="tax-rooms">
            ${roomEntries
              .map(
                ([r, c]) =>
                  `<div class="tax-room"><span>${escapeHtml(r)}</span><span>${c}</span></div>`,
              )
              .join("")}
          </div>
        </div>
      `;
      })
      .join("");
  } catch (e) {
    els.taxonomyContent.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadRecent() {
  els.recentContent.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/recent?limit=30");
    const data = await r.json();
    const rows = data.recent || [];
    if (!rows.length) {
      els.recentContent.innerHTML =
        '<div class="muted">No recent activity.</div>';
      return;
    }
    els.recentContent.innerHTML = rows
      .map(
        (row) => `
      <div class="recent-row">
        <div class="when">${fmtTime(row.filed_at)} · ${escapeHtml(row.added_by || "?")}</div>
        <div class="where">${escapeHtml(row.wing)} / ${escapeHtml(row.room)}</div>
        <div class="preview">${escapeHtml(row.preview || "")}</div>
      </div>
    `,
      )
      .join("");
  } catch (e) {
    els.recentContent.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

function populateBrowserWingFilter() {
  els.browserWing.innerHTML =
    `<option value="">all wings</option>` +
    state.wings
      .map(
        (w) =>
          `<option value="${escapeHtml(w.name)}">${escapeHtml(w.name)} (${w.drawer_count})</option>`,
      )
      .join("");
}

async function loadBrowser() {
  const wing = els.browserWing.value || undefined;
  const room = els.browserRoom.value.trim() || undefined;
  const q = els.browserQ.value.trim() || undefined;
  // <input type="date"> gives YYYY-MM-DD; expand to inclusive range so
  // 'until = 2026-04-18' includes everything that day.
  const since = els.browserSince?.value
    ? `${els.browserSince.value}T00:00:00`
    : undefined;
  const until = els.browserUntil?.value
    ? `${els.browserUntil.value}T23:59:59.999`
    : undefined;
  const params = new URLSearchParams();
  if (wing) params.set("wing", wing);
  if (room) params.set("room", room);
  if (q) params.set("q", q);
  if (since) params.set("since", since);
  if (until) params.set("until", until);
  params.set("limit", String(browserState.limit));
  params.set("offset", String(browserState.offset));
  els.browserList.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch(`/api/drawers?${params.toString()}`);
    const data = await r.json();
    browserState.total = data.total || 0;
    const rows = data.drawers || [];
    if (!rows.length) {
      els.browserList.innerHTML =
        '<div class="muted">No drawers match these filters.</div>';
    } else {
      els.browserList.innerHTML = "";
      for (const row of rows) {
        const card = document.createElement("div");
        card.className = "drawer-row";
        card.dataset.id = row.drawer_id;
        if (browserSelected.has(row.drawer_id)) card.classList.add("is-selected");
        card.innerHTML = `
          <div class="meta-line">
            <label class="select-wrap">
              <input type="checkbox" class="drawer-select" ${browserSelected.has(row.drawer_id) ? "checked" : ""} />
            </label>
            <span>${escapeHtml(row.wing)} / ${escapeHtml(row.room)}</span>
            <span>${fmtTime(row.filed_at)} · ${row.length}c · ${escapeHtml(row.added_by || "?")}</span>
          </div>
          <div class="preview">${escapeHtml(row.preview || "")}</div>
          <div class="edit-area">
            <textarea></textarea>
            <div class="edit-row">
              <span class="muted">wing</span>
              <input class="edit-wing" value="${escapeHtml(row.wing)}" />
              <span class="muted">room</span>
              <input class="edit-room" value="${escapeHtml(row.room)}" />
              <button class="primary save-btn" type="button">save</button>
              <button class="danger del-btn" type="button">delete</button>
              <span class="muted edit-status"></span>
            </div>
          </div>
        `;
        // Bulk-select checkbox handler — separate from row click expansion
        const sel = card.querySelector(".drawer-select");
        sel.addEventListener("click", (e) => e.stopPropagation());
        sel.addEventListener("change", () => {
          if (sel.checked) browserSelected.add(row.drawer_id);
          else browserSelected.delete(row.drawer_id);
          card.classList.toggle("is-selected", sel.checked);
          syncBulkBar();
        });

        let loadedFull = false;
        card.addEventListener("click", async (e) => {
          if (
            e.target.tagName === "TEXTAREA" ||
            e.target.tagName === "INPUT" ||
            e.target.tagName === "BUTTON" ||
            e.target.tagName === "LABEL"
          )
            return;
          const wasExpanded = card.classList.toggle("expanded");
          if (wasExpanded && !loadedFull) {
            const ta = card.querySelector("textarea");
            ta.value = "loading…";
            try {
              const dr = await fetch(
                `/api/drawers/${encodeURIComponent(row.drawer_id)}`,
              );
              const dd = await dr.json();
              ta.value = dd.content || dd.error || "";
              loadedFull = true;
            } catch (err) {
              ta.value = `error: ${err.message}`;
            }
          }
        });
        card.querySelector(".save-btn").addEventListener("click", async (e) => {
          e.stopPropagation();
          const ta = card.querySelector("textarea");
          const ewing = card.querySelector(".edit-wing").value.trim();
          const eroom = card.querySelector(".edit-room").value.trim();
          const status = card.querySelector(".edit-status");
          status.textContent = "saving…";
          try {
            const r = await fetch(
              `/api/drawers/${encodeURIComponent(row.drawer_id)}`,
              {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  content: ta.value,
                  wing: ewing || undefined,
                  room: eroom || undefined,
                }),
              },
            );
            const d = await r.json();
            if (!r.ok || d.success === false)
              throw new Error(d.error || d.detail || "failed");
            status.textContent = "saved";
            setTimeout(() => (status.textContent = ""), 2000);
            loadWings(state.prefs.wing);
          } catch (err) {
            status.textContent = `error: ${err.message}`;
          }
        });
        card.querySelector(".del-btn").addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm("Delete this drawer? This cannot be undone."))
            return;
          try {
            const r = await fetch(
              `/api/drawers/${encodeURIComponent(row.drawer_id)}`,
              { method: "DELETE" },
            );
            const d = await r.json();
            if (!r.ok || d.success === false)
              throw new Error(d.error || d.detail || "failed");
            card.remove();
            loadWings(state.prefs.wing);
          } catch (err) {
            alert(`delete failed: ${err.message}`);
          }
        });
        els.browserList.appendChild(card);
      }
    }
    const start = browserState.offset + 1;
    const end = browserState.offset + rows.length;
    els.browserPage.textContent = `${start}-${end} of ${browserState.total}`;
    els.browserPrev.disabled = browserState.offset <= 0;
    els.browserNext.disabled =
      browserState.offset + browserState.limit >= browserState.total;
    populateBulkMoveWingPicker();
    syncBulkBar();
  } catch (e) {
    els.browserList.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll(".tab-pane").forEach((p) => {
    p.hidden = p.dataset.tab !== name;
  });
  if (name === "stats") loadStats();
  else if (name === "taxonomy") loadTaxonomy();
  else if (name === "recent") loadRecent();
  else if (name === "browser") {
    populateBrowserWingFilter();
    loadBrowser();
  } else if (name === "graph") {
    loadKgStats();
    if (kgViewMode === "graph") loadKgGraph();
  } else if (name === "tunnels") loadTunnels();
  else if (name === "diary") loadDiary();
  else if (name === "review") loadReview();
  else if (name === "questions") loadQuestions();
  else if (name === "memories") loadMemoriesTab();
}

/* ─── Knowledge Graph ──────────────────────────────────────────────────── */

let kgNetwork = null; // active vis-network instance
let kgViewMode = "list"; // "list" or "graph"

async function loadKgStats() {
  const el = document.getElementById("kg-stats");
  if (!el) return;
  el.textContent = "loading…";
  try {
    const r = await fetch("/api/kg/stats");
    const d = await r.json();
    if (d.error) {
      el.textContent = `KG: ${d.error}`;
      return;
    }
    const parts = [];
    if ("triples" in d) parts.push(`${d.triples} facts`);
    if ("entities" in d) parts.push(`${d.entities} entities`);
    if ("predicates" in d) parts.push(`${d.predicates} predicates`);
    el.textContent = parts.length ? parts.join(" · ") : JSON.stringify(d);
  } catch (e) {
    el.textContent = `error: ${e.message}`;
  }
}

function renderKgFacts(facts, container) {
  if (!facts || !facts.length) {
    container.innerHTML = '<div class="muted">no facts</div>';
    return;
  }
  container.innerHTML = "";
  for (const f of facts) {
    const subj = f.subject || f.subj || "?";
    const pred = f.predicate || f.pred || "?";
    const obj = f.object || f.obj || "?";
    const vf = f.valid_from || "";
    const vu = f.valid_until || f.ended || "";
    const row = document.createElement("div");
    row.className = "kg-fact";
    row.innerHTML = `
      <div>
        <div class="triple">${escapeHtml(subj)} → <b>${escapeHtml(pred)}</b> → ${escapeHtml(obj)}</div>
        <div class="when">${vf ? `from ${escapeHtml(vf)}` : ""}${vu ? ` · ended ${escapeHtml(vu)}` : ""}</div>
      </div>
      <div class="actions">
        <button class="danger invalidate-btn" type="button">invalidate</button>
      </div>
    `;
    row.querySelector(".invalidate-btn").addEventListener("click", async () => {
      if (!confirm(`Mark this fact as no longer true?`)) return;
      try {
        const r = await fetch("/api/kg/invalidate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: subj, predicate: pred, object: obj }),
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || "failed");
        setStatus(`invalidated`, "warn");
        document.getElementById("kg-search").click();
      } catch (e) {
        setStatus(`invalidate failed: ${e.message}`, "err");
      }
    });
    container.appendChild(row);
  }
}

async function loadKgGraph() {
  const host = document.getElementById("kg-graph");
  if (!host || !window.vis || !window.vis.Network) {
    if (host) host.innerHTML = '<div class="muted" style="padding:20px">graph library not loaded</div>';
    return;
  }
  try {
    const r = await fetch("/api/kg/timeline");
    const d = await r.json();
    const facts = d.timeline || [];
    if (!facts.length) {
      host.innerHTML = '<div class="muted" style="padding:20px">no facts yet — add some via chat (with auto-KG on or tools enabled) or the form below</div>';
      return;
    }

    const nodeMap = new Map();
    const edges = [];
    for (const f of facts) {
      const s = f.subject;
      const o = f.object;
      if (!nodeMap.has(s)) nodeMap.set(s, { id: s, label: s, facts: [] });
      if (!nodeMap.has(o)) nodeMap.set(o, { id: o, label: o, facts: [] });
      nodeMap.get(s).facts.push(f);
      edges.push({
        from: s,
        to: o,
        label: f.predicate,
        arrows: "to",
        color: f.current === false
          ? { color: "rgba(208,80,80,0.3)" }
          : { color: "rgba(123,166,255,0.5)" },
        dashes: f.current === false,
      });
    }
    // Style nodes — bigger if more connected
    for (const n of nodeMap.values()) {
      n.value = n.facts.length;
      n.title = `${n.label} — ${n.facts.length} fact(s)`;
    }

    const data = {
      nodes: new vis.DataSet([...nodeMap.values()]),
      edges: new vis.DataSet(edges),
    };
    const options = {
      nodes: {
        shape: "dot",
        scaling: { min: 8, max: 28, label: { enabled: true, min: 11, max: 16 } },
        color: {
          background: "#2c2c2c",
          border: "#7aa6ff",
          highlight: { background: "#3a466b", border: "#ffffff" },
        },
        font: { color: "#ececec", face: "Inter, system-ui, sans-serif", size: 12 },
        borderWidth: 1,
      },
      edges: {
        font: { color: "#888", size: 10, face: "ui-monospace, monospace", align: "middle", strokeWidth: 0 },
        smooth: { type: "continuous" },
        arrows: { to: { scaleFactor: 0.5 } },
        width: 1,
      },
      physics: {
        barnesHut: { gravitationalConstant: -2400, springLength: 110, springConstant: 0.04 },
        stabilization: { iterations: 80 },
      },
      interaction: { hover: true, dragNodes: true, zoomView: true },
    };

    if (kgNetwork) kgNetwork.destroy();
    kgNetwork = new vis.Network(host, data, options);
    kgNetwork.on("click", (params) => {
      if (!params.nodes.length) return;
      const id = params.nodes[0];
      // Drop the entity into the query input + run query so the side panel updates
      const inp = document.getElementById("kg-entity");
      if (inp) {
        inp.value = id;
        document.getElementById("kg-search").click();
      }
    });
  } catch (e) {
    host.innerHTML = `<div class="muted" style="padding:20px">graph error: ${escapeHtml(e.message)}</div>`;
  }
}

function setKgViewMode(mode) {
  kgViewMode = mode;
  const listBtn = document.getElementById("kg-mode-list");
  const graphBtn = document.getElementById("kg-mode-graph");
  const graphContainer = document.getElementById("kg-graph-container");
  if (listBtn && graphBtn) {
    listBtn.className = mode === "list" ? "primary" : "ghost";
    graphBtn.className = mode === "graph" ? "primary" : "ghost";
  }
  if (graphContainer) graphContainer.hidden = mode !== "graph";
  if (mode === "graph") loadKgGraph();
}

document.addEventListener("click", async (e) => {
  if (e.target.id === "kg-mode-list") {
    setKgViewMode("list");
    return;
  }
  if (e.target.id === "kg-mode-graph") {
    setKgViewMode("graph");
    return;
  }
  if (e.target.id === "kg-search") {
    const entity = document.getElementById("kg-entity").value.trim();
    const asof = document.getElementById("kg-asof").value.trim();
    const out = document.getElementById("kg-results");
    if (!entity) {
      out.innerHTML = '<div class="muted">enter an entity name first</div>';
      return;
    }
    out.innerHTML = '<div class="muted">querying…</div>';
    try {
      const params = new URLSearchParams({ entity });
      if (asof) params.set("as_of", asof);
      const r = await fetch(`/api/kg/query?${params.toString()}`);
      const d = await r.json();
      if (d.error) {
        out.innerHTML = `<div class="muted">${escapeHtml(d.error)}</div>`;
        return;
      }
      renderKgFacts(d.facts || [], out);
    } catch (err) {
      out.innerHTML = `<div class="muted">error: ${escapeHtml(err.message)}</div>`;
    }
  } else if (e.target.id === "kg-timeline-btn") {
    const entity = document.getElementById("kg-entity").value.trim();
    const out = document.getElementById("kg-results");
    out.innerHTML = '<div class="muted">loading timeline…</div>';
    try {
      const params = new URLSearchParams();
      if (entity) params.set("entity", entity);
      const r = await fetch(`/api/kg/timeline?${params.toString()}`);
      const d = await r.json();
      renderKgFacts(d.timeline || [], out);
    } catch (err) {
      out.innerHTML = `<div class="muted">error: ${escapeHtml(err.message)}</div>`;
    }
  } else if (e.target.id === "kg-add-btn") {
    const subj = document.getElementById("kg-subj").value.trim();
    const pred = document.getElementById("kg-pred").value.trim();
    const obj = document.getElementById("kg-obj").value.trim();
    const vf = document.getElementById("kg-from").value.trim();
    const status = document.getElementById("kg-add-status");
    if (!subj || !pred || !obj) {
      status.textContent = "subject, predicate, and object are required";
      return;
    }
    status.textContent = "adding…";
    try {
      const r = await fetch("/api/kg/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subj,
          predicate: pred,
          object: obj,
          valid_from: vf || null,
        }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "failed");
      status.textContent = `added: ${d.fact}`;
      ["kg-subj", "kg-pred", "kg-obj", "kg-from"].forEach(
        (i) => (document.getElementById(i).value = ""),
      );
      loadKgStats();
    } catch (err) {
      status.textContent = `error: ${err.message}`;
    }
  } else if (e.target.id === "tunnel-add-btn") {
    setStatus("tunnel create not yet wired (Pack D)", "warn");
  } else if (e.target.id === "diary-write-btn") {
    const entry = document.getElementById("diary-entry").value.trim();
    const topic =
      document.getElementById("diary-topic").value.trim() || "general";
    const status = document.getElementById("diary-write-status");
    if (!entry) {
      status.textContent = "write something first";
      return;
    }
    status.textContent = "saving…";
    try {
      const r = await fetch("/api/diary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry, topic }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "failed");
      status.textContent = `saved`;
      document.getElementById("diary-entry").value = "";
      loadDiary();
    } catch (err) {
      status.textContent = `error: ${err.message}`;
    }
  }
});

/* ─── Diary ────────────────────────────────────────────────────────────── */

async function loadDiary() {
  const el = document.getElementById("diary-list");
  if (!el) return;
  el.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/diary?last_n=20");
    const d = await r.json();
    const entries = d.entries || d.diary || [];
    if (!entries.length) {
      el.innerHTML = '<div class="muted">No diary entries yet.</div>';
      return;
    }
    el.innerHTML = "";
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "diary-row";
      const when = e.timestamp || e.filed_at || "";
      const text = e.entry || e.content || "";
      const topic = e.topic ? ` · ${e.topic}` : "";
      row.innerHTML = `
        <div class="when">${fmtTime(when)}${escapeHtml(topic)}</div>
        <div class="entry">${escapeHtml(text)}</div>
      `;
      el.appendChild(row);
    }
  } catch (err) {
    el.innerHTML = `<div class="muted">error: ${escapeHtml(err.message)}</div>`;
  }
}

/* ─── Tunnels ──────────────────────────────────────────────────────────── */

async function loadTunnels() {
  const el = document.getElementById("tunnels-list");
  if (!el) return;
  el.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/tunnels");
    const d = await r.json();
    const tunnels = Array.isArray(d) ? d : d.tunnels || d.results || [];
    if (!tunnels.length) {
      el.innerHTML =
        '<div class="muted">No tunnels yet. Create one above to link two rooms across wings.</div>';
      return;
    }
    el.innerHTML = "";
    for (const t of tunnels) {
      const row = document.createElement("div");
      row.className = "tunnel-row";
      const sw = t.source?.wing || t.source_wing || "?";
      const sr = t.source?.room || t.source_room || "?";
      const tw = t.target?.wing || t.target_wing || "?";
      const tr = t.target?.room || t.target_room || "?";
      const lbl = t.label || t.kind || "";
      const id = t.id || t.tunnel_id || "";
      row.innerHTML = `
        <div>
          <div>${escapeHtml(sw)}/${escapeHtml(sr)} ⇆ ${escapeHtml(tw)}/${escapeHtml(tr)}</div>
          <div class="muted" style="font-size:10px">${escapeHtml(lbl)} · ${escapeHtml(id)}</div>
        </div>
        <button class="danger del-tunnel" type="button">delete</button>
      `;
      row.querySelector(".del-tunnel").addEventListener("click", async () => {
        if (!confirm("Delete this tunnel?")) return;
        try {
          const dr = await fetch(`/api/tunnels/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          const dd = await dr.json();
          if (dd.error) throw new Error(dd.error);
          loadTunnels();
        } catch (e) {
          alert(`delete failed: ${e.message}`);
        }
      });
      el.appendChild(row);
    }
  } catch (e) {
    el.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

document.addEventListener("click", async (e) => {
  if (e.target.id === "tunnel-add-btn") {
    const sw = document.getElementById("tunnel-wing-a").value.trim();
    const sr = document.getElementById("tunnel-room-a").value.trim();
    const tw = document.getElementById("tunnel-wing-b").value.trim();
    const tr = document.getElementById("tunnel-room-b").value.trim();
    const lbl = document.getElementById("tunnel-kind").value.trim();
    const status = document.getElementById("tunnel-status");
    if (!sw || !sr || !tw || !tr) {
      status.textContent = "all four wing/room fields are required";
      return;
    }
    status.textContent = "creating…";
    try {
      const r = await fetch("/api/tunnels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_wing: sw,
          source_room: sr,
          target_wing: tw,
          target_room: tr,
          label: lbl || "related",
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      status.textContent = "created";
      ["tunnel-wing-a", "tunnel-room-a", "tunnel-wing-b", "tunnel-room-b"].forEach(
        (i) => (document.getElementById(i).value = ""),
      );
      loadTunnels();
    } catch (err) {
      status.textContent = `error: ${err.message}`;
    }
  } else if (e.target.id === "reconnect-btn") {
    e.target.disabled = true;
    e.target.textContent = "reconnecting…";
    try {
      const r = await fetch("/api/reconnect", { method: "POST" });
      const d = await r.json();
      setStatus(
        d.success ? `reconnected (${d.drawers} drawers)` : `failed: ${d.error || d.message}`,
        d.success ? "ok" : "err",
      );
      loadStats();
    } catch (err) {
      setStatus(`reconnect failed: ${err.message}`, "err");
    } finally {
      e.target.disabled = false;
      e.target.textContent = "reconnect to palace";
    }
  } else if (e.target.id === "import-convos-btn") {
    const wing = state.prefs.wing || "personal";
    const path = document.getElementById("import-convos-path").value.trim();
    const status = document.getElementById("import-convos-status");
    const extractGeneral = !!document.getElementById("import-extract-general")?.checked;
    if (!path) {
      status.textContent = "enter a folder path first";
      return;
    }
    status.textContent = "importing… (this can take minutes)";
    e.target.disabled = true;
    try {
      const body = { path };
      if (extractGeneral) {
        body.extract = "general";
        body.review = true;
      }
      const r = await fetch(
        `/api/wings/${encodeURIComponent(wing)}/import-convos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      if (extractGeneral) {
        const pc = d.pending_count ?? 0;
        const qc = d.questions_count ?? 0;
        status.innerHTML = `imported into ${wing} — <b>${pc}</b> pending, <b>${qc}</b> questions. Open the Memory modal → Review / Questions.`;
        refreshReviewBadges();
      } else {
        status.textContent = `imported into ${wing}`;
      }
      loadAttachments();
      loadWings(wing);
    } catch (err) {
      status.textContent = `error: ${err.message}`;
    } finally {
      e.target.disabled = false;
    }
  }
});

/* ─── AAAK viewer ──────────────────────────────────────────────────────── */

async function loadAaak() {
  const el = document.getElementById("aaak-spec-text");
  if (!el) return;
  el.textContent = "loading…";
  try {
    const r = await fetch("/api/aaak-spec");
    const d = await r.json();
    el.textContent = d.aaak_spec || JSON.stringify(d, null, 2);
  } catch (e) {
    el.textContent = `error: ${e.message}`;
  }
}

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
});

els.openMemory.addEventListener("click", () => {
  els.memoryOverlay.hidden = false;
  applyAdvancedMode(); // ensure tab visibility reflects current toggle
  switchTab("memories");
});
els.closeMemoryModal.addEventListener("click", () => {
  els.memoryOverlay.hidden = true;
});
els.memoryOverlay.addEventListener("click", (e) => {
  if (e.target === els.memoryOverlay) els.memoryOverlay.hidden = true;
});

els.browserReload.addEventListener("click", () => {
  browserState.offset = 0;
  loadBrowser();
});
els.browserPrev.addEventListener("click", () => {
  browserState.offset = Math.max(0, browserState.offset - browserState.limit);
  loadBrowser();
});
els.browserNext.addEventListener("click", () => {
  browserState.offset += browserState.limit;
  loadBrowser();
});
[
  els.browserWing,
  els.browserRoom,
  els.browserQ,
  els.browserSince,
  els.browserUntil,
]
  .filter(Boolean)
  .forEach((el) => {
    el.addEventListener("change", () => {
      browserState.offset = 0;
      loadBrowser();
    });
  });

if (els.browserSelectAll) {
  els.browserSelectAll.addEventListener("change", () => {
    const checked = els.browserSelectAll.checked;
    const visibleRows = els.browserList?.querySelectorAll(".drawer-row") || [];
    visibleRows.forEach((r) => {
      const id = r.dataset.id;
      const cb = r.querySelector(".drawer-select");
      if (checked) browserSelected.add(id);
      else browserSelected.delete(id);
      if (cb) cb.checked = checked;
      r.classList.toggle("is-selected", checked);
    });
    syncBulkBar();
  });
}

if (els.bulkClearBtn) {
  els.bulkClearBtn.addEventListener("click", () => {
    browserSelected.clear();
    document
      .querySelectorAll(".drawer-row")
      .forEach((r) => r.classList.remove("is-selected"));
    document
      .querySelectorAll(".drawer-select")
      .forEach((cb) => (cb.checked = false));
    syncBulkBar();
  });
}

if (els.bulkMoveWing) {
  els.bulkMoveWing.addEventListener("change", syncBulkBar);
}

if (els.bulkMoveBtn) {
  els.bulkMoveBtn.addEventListener("click", async () => {
    const wing = els.bulkMoveWing.value;
    if (!wing || browserSelected.size === 0) return;
    const ids = [...browserSelected];
    if (
      !confirm(
        `Move ${ids.length} drawer(s) to wing "${wing}"? Their content stays the same — only the wing tag changes.`,
      )
    )
      return;
    try {
      const r = await fetch("/api/drawers/bulk-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, wing }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      setStatus(`moved ${d.moved} drawer(s) → ${wing}`, "ok");
      browserSelected.clear();
      els.bulkMoveWing.value = "";
      rememberWing(wing);
      await loadBrowser();
      await loadWings(state.prefs.wing);
    } catch (e) {
      setStatus(`bulk move failed: ${e.message}`, "err");
    }
  });
}

if (els.bulkDeleteBtn) {
  els.bulkDeleteBtn.addEventListener("click", async () => {
    if (browserSelected.size === 0) return;
    const ids = [...browserSelected];
    if (
      !confirm(
        `Delete ${ids.length} drawer(s)? This cannot be undone via the UI.`,
      )
    )
      return;
    try {
      const r = await fetch("/api/drawers/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      setStatus(`deleted ${d.deleted} drawer(s)`, "warn");
      browserSelected.clear();
      await loadBrowser();
      await loadWings(state.prefs.wing);
    } catch (e) {
      setStatus(`bulk delete failed: ${e.message}`, "err");
    }
  });
}

els.saveIdentity.addEventListener("click", saveIdentity);
els.resetIdentity.addEventListener("click", resetIdentity);

if (els.redoWelcome) {
  els.redoWelcome.addEventListener("click", async () => {
    if (
      !confirm(
        "Clear your saved identity and replay the welcome screen?\n\n" +
          "This deletes ~/.mempalace/identity.txt and resets the onboarded flag. " +
          "Your chats and memories are NOT affected.",
      )
    )
      return;
    try {
      await fetch("/api/identity", { method: "DELETE" });
    } catch {}
    localStorage.removeItem(ONBOARDED_KEY);
    location.reload();
  });
}

async function finishWelcome(name) {
  localStorage.setItem(ONBOARDED_KEY, String(Date.now()));
  els.welcomeOverlay.hidden = true;
  if (!name) return;
  const identity = DEFAULT_IDENTITY.replace(/\*your name\*/g, name);
  try {
    await fetch("/api/identity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: identity }),
    });
    setStatus(`welcome, ${name}`, "ok");
  } catch (e) {
    setStatus(`saved welcome but identity write failed: ${e.message}`, "warn");
  }
}

els.welcomeContinue.addEventListener("click", async () => {
  const name = els.welcomeName.value.trim();
  if (!name) {
    els.welcomeName.focus();
    return;
  }
  await finishWelcome(name);
});

els.welcomeName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    els.welcomeContinue.click();
  }
});

els.welcomeSkip.addEventListener("click", () => finishWelcome(""));
els.refreshWakeup.addEventListener("click", loadWakeup);

els.wing.addEventListener("change", () => setCurrentWing(els.wing.value));
els.topbarWing.addEventListener("change", () => setCurrentWing(els.topbarWing.value));
if (els.topbarPersona) {
  els.topbarPersona.addEventListener("change", () =>
    setCurrentPersona(els.topbarPersona.value),
  );
}
if (els.personaNew) {
  els.personaNew.addEventListener("click", () => openPersonaEditor({}));
}
if (els.personasList) {
  els.personasList.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.classList.contains("edit-persona")) {
      const name = t.dataset.name;
      const persona = state.personas.find((p) => p.name === name);
      if (persona) openPersonaEditor({ persona });
    } else if (t.classList.contains("del-persona")) {
      const name = t.dataset.name;
      if (!confirm(`Delete persona "${name}"?`)) return;
      try {
        const r = await fetch(`/api/personas/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "failed");
        // If we deleted the active persona, fall back to default
        if ((state.prefs.persona || "default") === name) {
          setCurrentPersona("default");
        }
        await loadPersonas();
      } catch (err) {
        alert(`delete failed: ${err.message}`);
      }
    }
  });
}
els.room.addEventListener("change", () => setCurrentRoom(els.room.value || "general"));

async function newWingFlow() {
  const name = prompt("New wing name");
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  rememberWing(trimmed);
  await loadWings(trimmed);
  setCurrentWing(trimmed);
}

els.wingNew.addEventListener("click", newWingFlow);
els.topbarWingNew.addEventListener("click", newWingFlow);

els.wingRename.addEventListener("click", renameWing);
els.wingDelete.addEventListener("click", deleteWing);

const prefInputs = [
  els.model,
  els.tRecall,
  els.tSave,
  els.tExtract,
  els.tIdentity,
];
if (els.tTools) prefInputs.push(els.tTools);
if (els.tAutoKg) prefInputs.push(els.tAutoKg);
if (els.tThinkingPreview) prefInputs.push(els.tThinkingPreview);
prefInputs.forEach((el) => el.addEventListener("change", savePrefs));

if (els.model) {
  els.model.addEventListener("change", () => {
    // Picking a new model should immediately apply to the active session
    // and the token meter (otherwise the meter keeps showing the
    // session's original model's context length).
    const s = getActiveSession();
    if (s) {
      s.model = els.model.value;
      saveJSON(SESSIONS_KEY, state.sessions);
    }
    refreshTokenMeter();
  });
}

els.wingPrompt.addEventListener("blur", saveWingPromptForCurrent);
if (els.wingPromptPicker) {
  els.wingPromptPicker.addEventListener("change", () => {
    const w = promptTargetWing();
    els.wingPrompt.value = state.wingPrompts[w] || "";
  });
}

/* ─── Init ─────────────────────────────────────────────────────────────── */

// Register the service worker as soon as the script loads — once
// registered, the browser surfaces the "Install" affordance.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    // Silent — PWA install just won't be available; everything else still works.
  });
}

// In-page keyboard shortcuts (Mac convention: Cmd; Win/Linux: Ctrl)
function isMod(e) {
  return e.metaKey || e.ctrlKey;
}
window.addEventListener("keydown", (e) => {
  // Ignore if user is mid-edit in a textarea/input that handles its own shortcuts,
  // unless they're using a modifier we explicitly capture.
  const target = e.target;
  const isComposer =
    target === els.input || target?.classList?.contains("edit-area");
  // Cmd/Ctrl + K → focus the composer input
  if (isMod(e) && !e.shiftKey && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    els.input.focus();
    return;
  }
  // Cmd/Ctrl + Shift + N → new chat
  if (isMod(e) && e.shiftKey && (e.key === "n" || e.key === "N")) {
    e.preventDefault();
    els.newChat?.click();
    return;
  }
  // Cmd/Ctrl + Shift + I → new incognito
  if (isMod(e) && e.shiftKey && (e.key === "i" || e.key === "I")) {
    e.preventDefault();
    els.newIncognito?.click();
    return;
  }
  // Cmd/Ctrl + B → toggle sidebar
  if (isMod(e) && !e.shiftKey && (e.key === "b" || e.key === "B")) {
    if (isComposer && !e.shiftKey) return; // don't steal text-formatting attempts
    e.preventDefault();
    if (isMobile()) {
      document.body.classList.toggle("mobile-sidebar-open");
    } else if (document.body.classList.contains("no-sidebar")) {
      els.showSidebar?.click();
    } else {
      els.toggleSidebar?.click();
    }
    return;
  }
  // Esc — first priority: stop in-flight generation or TTS
  if (e.key === "Escape" && (activeAbort || activeAudio)) {
    e.preventDefault();
    if (activeAbort) stopGeneration();
    else if (activeAudio) {
      stopActiveAudio();
      setStatus("speech stopped", "warn");
    }
    return;
  }
  // Esc closes any open modal
  if (e.key === "Escape") {
    if (els.settingsOverlay && !els.settingsOverlay.hidden) {
      els.settingsOverlay.hidden = true;
      saveWingPromptForCurrent();
      return;
    }
    if (els.memoryOverlay && !els.memoryOverlay.hidden) {
      els.memoryOverlay.hidden = true;
      return;
    }
    if (
      isMobile() &&
      document.body.classList.contains("mobile-sidebar-open")
    ) {
      document.body.classList.remove("mobile-sidebar-open");
      return;
    }
  }
});

// URL-param quick capture: ?q=text&wing=...&persona=...&model=...&submit=1
// Lets external tools (Raycast, Shortcuts, Hammerspoon) push a thought
// straight into a new chat with one keypress.
async function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const q = params.get("q");
  if (q == null) return;
  // Strip the query so a refresh doesn't re-trigger
  history.replaceState({}, "", window.location.pathname);
  // Always start in a fresh session for capture
  const incognito = params.get("incognito") === "1";
  createSession({ anonymous: incognito });
  const wing = params.get("wing");
  const persona = params.get("persona");
  const model = params.get("model");
  if (wing) setCurrentWing(wing);
  if (persona) setCurrentPersona(persona);
  if (model && state.models.includes(model)) {
    els.model.value = model;
    const s = getActiveSession();
    if (s) s.model = model;
    saveJSON(SESSIONS_KEY, state.sessions);
  }
  renderSessions();
  renderMessages();
  els.input.value = q;
  els.input.dispatchEvent(new Event("input"));
  els.input.focus();
  if (params.get("submit") === "1" && q.trim()) {
    await sendMessage(q.trim());
    els.input.value = "";
  }
}

(async function init() {
  setStatus("loading…", "");
  // One-time migration: prefs from earlier sessions may have stored
  // recall/save/etc. as false. The empty-state text promises these are
  // on by default, so reset them once when the defaults version changes.
  if ((state.prefs.defaultsVersion || 0) < PREFS_DEFAULTS_VERSION) {
    state.prefs.recall = true;
    state.prefs.save = true;
    state.prefs.extract = true;
    state.prefs.identity = true;
    state.prefs.defaultsVersion = PREFS_DEFAULTS_VERSION;
  }
  els.tRecall.checked = state.prefs.recall !== false;
  els.tSave.checked = state.prefs.save !== false;
  els.tExtract.checked = state.prefs.extract !== false;
  els.tIdentity.checked = state.prefs.identity !== false;
  if (els.tTools) els.tTools.checked = !!state.prefs.tools;
  if (els.tAutoKg) els.tAutoKg.checked = !!state.prefs.autoKg;
  if (els.tThinkingPreview)
    els.tThinkingPreview.checked = state.prefs.thinkingPreview !== false;
  state.prefs.recall = els.tRecall.checked;
  state.prefs.save = els.tSave.checked;
  state.prefs.extract = els.tExtract.checked;
  state.prefs.identity = els.tIdentity.checked;
  saveJSON(PREFS_KEY, state.prefs);
  els.room.value = state.prefs.room || "general";
  syncRecallButton();

  await loadModels();
  await loadWings(state.prefs.wing);
  await loadPersonas();

  ensureSession();
  syncWingFilter();
  renderMessages();
  renderHits([]);
  refreshTokenMeter();

  try {
    const h = await fetch("/api/health").then((r) => r.json());
    els.palaceLabel.textContent = h.palace_path;
  } catch {}

  // First-run: if the user has never been onboarded AND there's no identity
  // saved yet, pop the welcome step to collect their name.
  if (!localStorage.getItem(ONBOARDED_KEY)) {
    let hasIdentity = false;
    try {
      const r = await fetch("/api/identity");
      const d = await r.json();
      hasIdentity = !!(d.text && d.text.trim());
    } catch {}
    if (!hasIdentity) {
      els.welcomeOverlay.hidden = false;
      setTimeout(() => els.welcomeName.focus(), 50);
    } else {
      localStorage.setItem(ONBOARDED_KEY, String(Date.now()));
    }
  }

  setStatus("ready", "ok");
  els.input.focus();
  // Process URL-driven quick capture last so it sees fully-loaded state.
  await applyUrlParams();
  refreshReviewBadges();
})();

/* ─── Filesystem picker (import browse button) ──────────────────────────── */

const fsPicker = {
  overlay: null,
  entriesEl: null,
  crumbsEl: null,
  currentEl: null,
  showHidden: false,
  path: null,
};

function openFsPicker(startPath) {
  fsPicker.overlay = document.getElementById("fs-picker-overlay");
  fsPicker.entriesEl = document.getElementById("fs-entries");
  fsPicker.crumbsEl = document.getElementById("fs-crumbs");
  fsPicker.currentEl = document.getElementById("fs-current");
  if (!fsPicker.overlay) return;
  fsPicker.overlay.hidden = false;
  const hidden = document.getElementById("fs-show-hidden");
  if (hidden) {
    hidden.checked = fsPicker.showHidden;
    hidden.onchange = () => {
      fsPicker.showHidden = !!hidden.checked;
      renderFsEntries();
    };
  }
  loadFsPath(startPath || "~");
}

function closeFsPicker() {
  if (fsPicker.overlay) fsPicker.overlay.hidden = true;
}

async function loadFsPath(path) {
  fsPicker.entriesEl.innerHTML = '<div class="muted">loading…</div>';
  try {
    const u = new URL("/api/fs/browse", location.origin);
    if (path) u.searchParams.set("path", path);
    const r = await fetch(u);
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
    fsPicker.path = d.path;
    fsPicker.entries = d.entries;
    fsPicker.parent = d.parent;
    fsPicker.crumbs = d.crumbs;
    fsPicker.home = d.home;
    renderFsEntries();
    renderFsCrumbs();
    fsPicker.currentEl.textContent = d.path;
  } catch (err) {
    fsPicker.entriesEl.innerHTML = `<div class="err">error: ${escHtml(err.message)}</div>`;
  }
}

function renderFsEntries() {
  const parts = [];
  if (fsPicker.parent) {
    parts.push(
      `<div class="fs-entry" data-path="${escHtml(fsPicker.parent)}"><span class="fs-icon">↰</span><span>..</span></div>`,
    );
  }
  const visible = fsPicker.showHidden
    ? fsPicker.entries
    : fsPicker.entries.filter((e) => !e.hidden);
  for (const e of visible) {
    parts.push(
      `<div class="fs-entry${e.hidden ? " hidden-dir" : ""}" data-path="${escHtml(e.path)}"><span class="fs-icon">📁</span><span>${escHtml(e.name)}</span></div>`,
    );
  }
  if (!parts.length) {
    fsPicker.entriesEl.innerHTML = '<div class="muted">(no subfolders)</div>';
  } else {
    fsPicker.entriesEl.innerHTML = parts.join("");
  }
}

function renderFsCrumbs() {
  const parts = (fsPicker.crumbs || []).map((c, i, arr) => {
    const active = i === arr.length - 1 ? " active" : "";
    return `<button class="fs-crumb${active}" data-path="${escHtml(c.path)}" type="button">${escHtml(c.name)}</button>`;
  });
  fsPicker.crumbsEl.innerHTML = parts.join(
    '<span style="color:#555">/</span>',
  );
}

// Direct wiring of static fs-picker controls — bulletproof vs. delegation
function wireFsPickerControls() {
  async function nativePickOrFallback(kind, triggerBtn) {
    const input = document.getElementById("import-convos-path");
    const prev = triggerBtn.textContent;
    triggerBtn.disabled = true;
    triggerBtn.textContent = "opening Finder…";
    try {
      const r = await fetch("/api/fs/native-pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.cancelled) return;
        if (d.path && input) input.value = d.path;
        return;
      }
      if (r.status !== 501) {
        const err = await r.json().catch(() => ({}));
        console.warn("native picker failed, falling back:", err);
      }
      if (kind === "folder") {
        const current = input?.value?.trim();
        openFsPicker(current || null);
      } else if (input) {
        alert("File picker needs macOS native dialog. Not available in this environment.");
      }
    } catch (err) {
      console.warn("native picker error:", err);
      if (kind === "folder") {
        const current = input?.value?.trim();
        openFsPicker(current || null);
      }
    } finally {
      triggerBtn.disabled = false;
      triggerBtn.textContent = prev;
    }
  }

  const browseBtn = document.getElementById("import-browse-btn");
  if (browseBtn && !browseBtn.dataset.wired) {
    browseBtn.dataset.wired = "1";
    browseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      // Reliable AppleScript folder picker. For single-file imports the user
      // pastes/types the path into the editable input — macOS doesn't give us
      // a reliable unified dialog from osascript.
      nativePickOrFallback("folder", browseBtn);
    });
  }
  const closeBtn = document.getElementById("fs-picker-close");
  if (closeBtn && !closeBtn.dataset.wired) {
    closeBtn.dataset.wired = "1";
    closeBtn.addEventListener("click", closeFsPicker);
  }
  const pickBtn = document.getElementById("fs-pick-current");
  if (pickBtn && !pickBtn.dataset.wired) {
    pickBtn.dataset.wired = "1";
    pickBtn.addEventListener("click", () => {
      const input = document.getElementById("import-convos-path");
      if (input && fsPicker.path) input.value = fsPicker.path;
      closeFsPicker();
    });
  }
  const overlay = document.getElementById("fs-picker-overlay");
  if (overlay && !overlay.dataset.wired) {
    overlay.dataset.wired = "1";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeFsPicker();
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireFsPickerControls);
} else {
  wireFsPickerControls();
}

// Delegated click handler for dynamic entries + crumbs inside the picker
document.addEventListener("click", (e) => {
  if (!fsPicker.overlay || fsPicker.overlay.hidden) return;
  const entry = e.target.closest?.(".fs-entry");
  if (entry) {
    const p = entry.dataset.path;
    if (p) loadFsPath(p);
    return;
  }
  const crumb = e.target.closest?.(".fs-crumb");
  if (crumb) {
    const p = crumb.dataset.path;
    if (p) loadFsPath(p);
  }
});

/* ─── Smart Import (LLM wing classifier) ───────────────────────────────── */

const smartImport = {
  path: null,
  plan: null,
  titles: {},
  summaries: {},
};

async function populateClassifierModels() {
  const select = document.getElementById("import-classifier-model");
  if (!select || select.dataset.loaded) return;
  try {
    const r = await fetch("/api/models");
    const d = await r.json();
    const models = (d.models || []).map((m) => m.name || m);
    select.innerHTML = models
      .map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`)
      .join("");
    // Prefer a fast small model if one is installed
    const preferred = [
      "igorls/gemma-4-E4B-it-heretic-GGUF:latest",
      "gemma4:26b",
      "gpt-oss:20b",
    ];
    for (const p of preferred) {
      if (models.includes(p)) {
        select.value = p;
        break;
      }
    }
    select.dataset.loaded = "1";
  } catch {}
}

function wireSmartImport() {
  const btn = document.getElementById("import-smart-btn");
  populateClassifierModels();
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", async () => {
      const path = document.getElementById("import-convos-path")?.value?.trim();
      const status = document.getElementById("import-convos-status");
      const modelSel = document.getElementById("import-classifier-model");
      const model = modelSel?.value || null;
      if (!path) {
        if (status) status.textContent = "pick a folder first";
        return;
      }
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = "classifying…";
      if (status) status.textContent = "";

      const progress = document.getElementById("import-progress");
      const progressText = document.getElementById("import-progress-text");
      const elapsed = document.getElementById("import-progress-elapsed");
      const cancelBtn = document.getElementById("import-progress-cancel");
      if (progress) progress.hidden = false;
      if (progressText) {
        progressText.textContent = `scanning export + classifying via ${model || "default model"}…`;
      }
      const startedAt = Date.now();
      if (elapsed) elapsed.textContent = "0s";
      const timer = setInterval(() => {
        if (!elapsed) return;
        const s = Math.floor((Date.now() - startedAt) / 1000);
        const m = Math.floor(s / 60);
        elapsed.textContent = m ? `${m}m ${s % 60}s` : `${s}s`;
      }, 1000);

      const controller = new AbortController();
      if (cancelBtn) {
        cancelBtn.onclick = () => {
          controller.abort();
          if (progressText) progressText.textContent = "cancelled.";
        };
      }

      const fill = document.getElementById("import-progress-fill");
      const detail = document.getElementById("import-progress-detail");
      const eta = document.getElementById("import-progress-eta");
      if (fill) {
        fill.style.width = "0%";
        fill.classList.add("indeterminate");
      }

      try {
        const r = await fetch("/api/imports/plan/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ path, model }),
          signal: controller.signal,
        });
        if (!r.ok) {
          const txt = await r.text();
          throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`);
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let approxTotal = 0;
        let lastBytes = 0;
        let bytesStartedAt = 0;
        let terminal = null;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          // SSE frames separated by blank lines
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              let evt;
              try { evt = JSON.parse(payload); }
              catch { continue; }
              if (evt.type === "phase") {
                if (progressText) progressText.textContent = evt.label || "working…";
                if (detail) detail.textContent = evt.label || "";
                if (evt.approx_total) {
                  approxTotal = evt.approx_total;
                  bytesStartedAt = Date.now();
                  if (fill) {
                    fill.classList.remove("indeterminate");
                    fill.style.width = "0%";
                  }
                }
              } else if (evt.type === "progress") {
                const b = evt.bytes || 0;
                lastBytes = b;
                if (approxTotal && fill) {
                  const pct = Math.min(99, Math.round((b / approxTotal) * 100));
                  fill.style.width = pct + "%";
                }
                if (detail) detail.textContent = `generating… ${b.toLocaleString()} bytes`;
                if (eta && bytesStartedAt && b > 200) {
                  const elapsedMs = Date.now() - bytesStartedAt;
                  const rate = b / (elapsedMs / 1000);
                  const remaining = Math.max(0, approxTotal - b);
                  const secsLeft = rate > 1 ? Math.ceil(remaining / rate) : 0;
                  eta.textContent = secsLeft > 0
                    ? `~${secsLeft > 60 ? Math.ceil(secsLeft / 60) + "m" : secsLeft + "s"} remaining (rough)`
                    : "";
                }
              } else if (evt.type === "done") {
                terminal = { ok: true, payload: evt.payload };
              } else if (evt.type === "error") {
                terminal = { ok: false, message: evt.message };
              }
            }
          }
        }
        if (!terminal) throw new Error("stream ended without a terminal event");
        if (!terminal.ok) throw new Error(terminal.message || "unknown error");
        if (fill) fill.style.width = "100%";
        const d = terminal.payload;
        smartImport.path = d.path;
        smartImport.plan = d.plan;
        smartImport.titles = d.titles || {};
        smartImport.summaries = d.summaries || {};
        renderImportPlan(d);
        if (status) status.textContent = "";
      } catch (err) {
        if (err.name === "AbortError") {
          if (status) status.textContent = "cancelled (server request may still drain)";
        } else {
          if (status) status.textContent = `error: ${err.message}`;
          console.error(err);
        }
      } finally {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = prev;
        if (progress) setTimeout(() => (progress.hidden = true), 400);
      }
    });
  }
  const closeBtn = document.getElementById("import-plan-close");
  if (closeBtn && !closeBtn.dataset.wired) {
    closeBtn.dataset.wired = "1";
    closeBtn.addEventListener("click", () => {
      document.getElementById("import-plan-overlay").hidden = true;
    });
  }
  const overlay = document.getElementById("import-plan-overlay");
  if (overlay && !overlay.dataset.wired) {
    overlay.dataset.wired = "1";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.hidden = true;
    });
  }
  const commit = document.getElementById("import-plan-commit");
  if (commit && !commit.dataset.wired) {
    commit.dataset.wired = "1";
    commit.addEventListener("click", commitImportPlan);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireSmartImport);
} else {
  wireSmartImport();
}

function renderImportPlan(d) {
  const overlay = document.getElementById("import-plan-overlay");
  const summary = document.getElementById("import-plan-summary");
  const body = document.getElementById("import-plan-body");
  if (!overlay || !summary || !body) return;

  const skipped = d.skipped || [];
  const meta = d.metadata_files || [];
  summary.innerHTML = `
    <div><b>${d.convos_total}</b> conversations found in <code>${escHtml(d.path)}</code></div>
    <div class="muted" style="margin-top:4px">
      Classifier: <code>${escHtml(d.model_used)}</code> ·
      Existing wings considered: ${(d.existing_wings || []).length
        ? (d.existing_wings || []).map(escHtml).join(", ")
        : "(none)"} ·
      Metadata files set aside: ${meta.length ? meta.map((m) => escHtml(m.name)).join(", ") : "(none)"} ·
      Skipped: ${skipped.length}
    </div>`;

  const parts = [];
  (d.plan || []).forEach((wing, idx) => {
    const sampleIds = wing.convo_ids.slice(0, 8);
    parts.push(`
      <div class="plan-wing" data-idx="${idx}">
        <div class="plan-wing-head">
          <input class="plan-wing-name" data-idx="${idx}" value="${escHtml(wing.name)}" />
          <span class="plan-wing-count"><b>${wing.convo_ids.length}</b> conversations</span>
          <span class="grow" style="flex:1"></span>
          <button class="ghost plan-wing-drop" data-idx="${idx}" type="button" title="Exclude this wing from commit">Drop</button>
        </div>
        <div class="plan-wing-desc">${escHtml(wing.description || "")}</div>
        <div class="plan-wing-convos">
          <details>
            <summary>show ${wing.convo_ids.length} titles</summary>
            <ul>${wing.convo_ids
              .map((id) => `<li>${escHtml(smartImport.titles[id] || id)}</li>`)
              .join("")}</ul>
          </details>
        </div>
      </div>`);
  });
  body.innerHTML = parts.join("") || '<div class="muted">(empty plan)</div>';
  overlay.hidden = false;

  // Wire per-wing controls
  body.querySelectorAll(".plan-wing-drop").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      smartImport.plan[idx] = null;
      btn.closest(".plan-wing").remove();
    });
  });
  body.querySelectorAll(".plan-wing-name").forEach((inp) => {
    inp.addEventListener("change", () => {
      const idx = Number(inp.dataset.idx);
      const v = inp.value.trim().toLowerCase().replace(/\s+/g, "-");
      inp.value = v;
      if (smartImport.plan[idx]) smartImport.plan[idx].name = v;
    });
  });
}

async function commitImportPlan() {
  const status = document.getElementById("import-plan-status");
  const extractBox = document.getElementById("import-plan-extract");
  const reviewBox = document.getElementById("import-plan-review");
  const btn = document.getElementById("import-plan-commit");
  if (!smartImport.path || !smartImport.plan) return;
  const plan = smartImport.plan.filter((w) => w && w.convo_ids && w.convo_ids.length);
  if (!plan.length) {
    status.textContent = "plan is empty";
    return;
  }
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "committing…";
  if (status) status.textContent = "writing to palace…";
  try {
    const body = {
      path: smartImport.path,
      plan,
      review: !!reviewBox?.checked,
    };
    if (extractBox?.checked) body.extract = "general";
    const r = await fetch("/api/imports/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
    const perWingSummary = (d.per_wing || [])
      .map((w) => `${w.wing}: ${w.committed} committed${w.pending ? `, ${w.pending} pending` : ""}`)
      .join(" · ");
    status.innerHTML = `<b>Done.</b> ${d.total_committed} committed, ${d.total_pending} pending. ${escHtml(perWingSummary)}`;
    refreshReviewBadges();
    loadWings();
  } catch (err) {
    status.textContent = `error: ${err.message}`;
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

/* ─── Review + Questions (import-time gate) ─────────────────────────────── */

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function refreshReviewBadges() {
  try {
    const [rv, qs] = await Promise.all([
      fetch("/api/review?limit=1").then((r) => r.json()),
      fetch("/api/questions").then((r) => r.json()),
    ]);
    const rBadge = document.getElementById("review-badge");
    const qBadge = document.getElementById("questions-badge");
    if (rBadge) {
      if (rv.total > 0) {
        rBadge.textContent = rv.total;
        rBadge.hidden = false;
      } else rBadge.hidden = true;
    }
    if (qBadge) {
      if (qs.total > 0) {
        qBadge.textContent = qs.total;
        qBadge.hidden = false;
      } else qBadge.hidden = true;
    }
  } catch {}
}

async function loadReview() {
  const list = document.getElementById("review-list");
  const status = document.getElementById("review-status");
  if (!list) return;
  list.innerHTML = '<div class="muted">loading…</div>';
  if (status) status.textContent = "";
  try {
    const [bucketsR, itemsR] = await Promise.all([
      fetch("/api/review/sources").then((r) => r.json()),
      fetch("/api/review?limit=500").then((r) => r.json()),
    ]);
    const buckets = bucketsR.sources || [];
    const items = itemsR.items || [];
    const total = itemsR.total || 0;
    if (!total) {
      list.innerHTML =
        '<div class="muted">No pending inferences. Import a chat export with “extract inferred facts” enabled to populate this list.</div>';
      return;
    }
    const bySrc = new Map();
    for (const b of buckets) bySrc.set(b.source, []);
    for (const it of items) {
      const k = it.source_conversation || "(unknown)";
      if (!bySrc.has(k)) bySrc.set(k, []);
      bySrc.get(k).push(it);
    }
    const parts = [];
    parts.push(
      `<div class="muted" style="margin-bottom:10px"><b>${total}</b> pending across <b>${bySrc.size}</b> conversations</div>`,
    );
    for (const [src, rows] of bySrc) {
      const sid = `src-${btoa(src).replace(/[^a-zA-Z0-9]/g, "")}`;
      parts.push(`
        <section class="review-bucket" style="border:1px solid #2a2a2a;border-radius:8px;margin-bottom:12px;padding:10px">
          <header style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <b>${escHtml(src)}</b>
            <span class="muted">${rows.length} pending</span>
            <span class="grow" style="flex:1"></span>
            <button class="ghost bulk-accept" data-src="${escHtml(src)}" type="button">Accept all</button>
            <button class="danger bulk-reject" data-src="${escHtml(src)}" type="button">Reject all</button>
          </header>
          <div id="${sid}" class="review-rows" style="margin-top:8px"></div>
        </section>`);
    }
    list.innerHTML = parts.join("");
    for (const [src, rows] of bySrc) {
      const sid = `src-${btoa(src).replace(/[^a-zA-Z0-9]/g, "")}`;
      const host = document.getElementById(sid);
      host.innerHTML = rows
        .map((r) => renderReviewRow(r))
        .join("");
    }
  } catch (err) {
    list.innerHTML = `<div class="err">error: ${escHtml(err.message)}</div>`;
  }
}

function renderReviewRow(r) {
  const score = r.keyword_score != null ? Number(r.keyword_score).toFixed(1) : "—";
  return `
    <div class="review-row" data-id="${escHtml(r.id)}" style="border-top:1px solid #222;padding:8px 0">
      <div class="row" style="gap:6px;align-items:center">
        <span class="muted" title="keyword-density score from extractor; higher = more marker words">kw ${score}</span>
        <code class="muted">${escHtml(r.proposed_wing)} › ${escHtml(r.proposed_room)}</code>
        <span class="grow" style="flex:1"></span>
        <button class="primary act-accept" type="button">Accept</button>
        <button class="ghost act-edit" type="button">Edit</button>
        <button class="danger act-reject" type="button">Reject</button>
      </div>
      <div class="review-content" style="margin-top:6px;white-space:pre-wrap;font-size:13px">${escHtml(r.content)}</div>
      <div class="review-edit" hidden style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
        <input class="edit-wing" value="${escHtml(r.proposed_wing)}" style="width:140px" />
        <input class="edit-room" value="${escHtml(r.proposed_room)}" style="width:160px" />
        <textarea class="edit-content" style="flex:1;min-width:200px;min-height:60px">${escHtml(r.content)}</textarea>
        <button class="primary act-save-edit" type="button">Save + Accept</button>
      </div>
    </div>`;
}

document.addEventListener("click", async (e) => {
  const row = e.target.closest?.(".review-row");
  const bucket = e.target.closest?.(".review-bucket");

  if (e.target.classList?.contains("bulk-accept") && bucket) {
    const src = e.target.dataset.src;
    if (!confirm(`Accept ALL pending memories from "${src}"?`)) return;
    e.target.disabled = true;
    try {
      const r = await fetch("/api/review/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: src, action: "accept" }),
      });
      if (!r.ok) throw new Error(await r.text());
      await loadReview();
      refreshReviewBadges();
    } catch (err) {
      alert("error: " + err.message);
    } finally {
      e.target.disabled = false;
    }
    return;
  }
  if (e.target.classList?.contains("bulk-reject") && bucket) {
    const src = e.target.dataset.src;
    if (!confirm(`Reject ALL pending memories from "${src}"?`)) return;
    e.target.disabled = true;
    try {
      const r = await fetch("/api/review/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: src, action: "reject" }),
      });
      if (!r.ok) throw new Error(await r.text());
      await loadReview();
      refreshReviewBadges();
    } catch (err) {
      alert("error: " + err.message);
    } finally {
      e.target.disabled = false;
    }
    return;
  }

  if (!row) return;
  const id = row.dataset.id;

  if (e.target.classList?.contains("act-accept")) {
    e.target.disabled = true;
    try {
      const r = await fetch(`/api/review/${encodeURIComponent(id)}/accept`, {
        method: "POST",
      });
      if (!r.ok) throw new Error(await r.text());
      row.remove();
      refreshReviewBadges();
    } catch (err) {
      alert("accept failed: " + err.message);
    } finally {
      e.target.disabled = false;
    }
  } else if (e.target.classList?.contains("act-reject")) {
    e.target.disabled = true;
    try {
      const r = await fetch(`/api/review/${encodeURIComponent(id)}/reject`, {
        method: "POST",
      });
      if (!r.ok) throw new Error(await r.text());
      row.remove();
      refreshReviewBadges();
    } catch (err) {
      alert("reject failed: " + err.message);
    } finally {
      e.target.disabled = false;
    }
  } else if (e.target.classList?.contains("act-edit")) {
    const panel = row.querySelector(".review-edit");
    if (panel) panel.hidden = !panel.hidden;
  } else if (e.target.classList?.contains("act-save-edit")) {
    const wing = row.querySelector(".edit-wing").value.trim();
    const roomVal = row.querySelector(".edit-room").value.trim();
    const content = row.querySelector(".edit-content").value;
    e.target.disabled = true;
    try {
      const er = await fetch(`/api/review/${encodeURIComponent(id)}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wing, room: roomVal, content }),
      });
      if (!er.ok) throw new Error(await er.text());
      const ar = await fetch(`/api/review/${encodeURIComponent(id)}/accept`, {
        method: "POST",
      });
      if (!ar.ok) throw new Error(await ar.text());
      row.remove();
      refreshReviewBadges();
    } catch (err) {
      alert("save+accept failed: " + err.message);
    } finally {
      e.target.disabled = false;
    }
  }
});

document.addEventListener("click", (e) => {
  if (e.target.id === "review-refresh") loadReview();
  if (e.target.id === "questions-refresh") loadQuestions();
  if (e.target.classList?.contains("save-chip-edit")) {
    const drawerId = e.target.dataset.drawer;
    if (!drawerId) return;
    const newTopic = prompt("Move to topic (lowercase, hyphenated). Leave blank to keep current.");
    if (newTopic === null) return;
    const newSection = prompt("Move to section (lowercase, hyphenated). Leave blank to keep current.");
    if (newSection === null) return;
    const body = {};
    if (newTopic && newTopic.trim()) body.topic = newTopic.trim().toLowerCase().replace(/\s+/g, "-");
    if (newSection && newSection.trim()) body.section = newSection.trim().toLowerCase().replace(/\s+/g, "-");
    if (!body.topic && !body.section) return;
    fetch(`/api/drawers/${encodeURIComponent(drawerId)}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        const d = await r.json();
        e.target.closest(".save-chip-item").innerHTML =
          `📁 Moved to <b>${d.topic || "?"}</b> › <b>${d.section || "?"}</b>`;
      })
      .catch((err) => alert("move failed: " + err.message));
  }
});

async function loadQuestions() {
  const list = document.getElementById("questions-list");
  if (!list) return;
  list.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/questions");
    const d = await r.json();
    const items = d.items || [];
    if (!items.length) {
      list.innerHTML =
        '<div class="muted">No open questions.</div>';
      return;
    }
    list.innerHTML = items.map((q) => renderQuestion(q)).join("");
  } catch (err) {
    list.innerHTML = `<div class="err">error: ${escHtml(err.message)}</div>`;
  }
}

function renderQuestion(q) {
  const blocks = (q.blocks_pending_ids || []).length;
  const answers = (q.proposed_answers || []).map(
    (a, i) =>
      `<label style="display:flex;gap:6px;align-items:center"><input type="radio" name="qa-${q.id}" value="${escHtml(a)}" /> ${escHtml(a)}</label>`,
  ).join("");
  return `
    <section class="question-row" data-id="${escHtml(q.id)}" style="border:1px solid #2a2a2a;border-radius:8px;padding:10px;margin-bottom:10px">
      <div><b>${escHtml(q.question)}</b></div>
      ${blocks ? `<div class="muted" style="font-size:12px;margin-top:4px">Answering unblocks ${blocks} pending memories.</div>` : ""}
      ${q.context ? `<pre style="white-space:pre-wrap;font-size:12px;margin-top:8px;color:#aaa">${escHtml(q.context)}</pre>` : ""}
      <div style="display:flex;flex-direction:column;gap:4px;margin-top:8px">${answers}</div>
      <div class="row" style="gap:6px;margin-top:8px;align-items:center">
        <input class="qa-freeform" type="text" placeholder="Or type a custom answer…" style="flex:1" />
        <button class="primary qa-submit" type="button">Submit</button>
        <button class="ghost qa-skip" type="button">Skip</button>
      </div>
    </section>`;
}

document.addEventListener("click", async (e) => {
  const row = e.target.closest?.(".question-row");
  if (!row) return;
  const id = row.dataset.id;

  if (e.target.classList?.contains("qa-submit")) {
    const radios = row.querySelectorAll(`input[name="qa-${id}"]`);
    let picked = "";
    radios.forEach((r) => {
      if (r.checked) picked = r.value;
    });
    const freeform = row.querySelector(".qa-freeform").value.trim();
    const answer = freeform || picked;
    if (!answer) {
      alert("pick an option or type an answer");
      return;
    }
    e.target.disabled = true;
    try {
      const r = await fetch(`/api/questions/${encodeURIComponent(id)}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      if (!r.ok) throw new Error(await r.text());
      row.remove();
      refreshReviewBadges();
    } catch (err) {
      alert("submit failed: " + err.message);
    } finally {
      e.target.disabled = false;
    }
  } else if (e.target.classList?.contains("qa-skip")) {
    e.target.disabled = true;
    try {
      const r = await fetch(`/api/questions/${encodeURIComponent(id)}/skip`, {
        method: "POST",
      });
      if (!r.ok) throw new Error(await r.text());
      row.remove();
      refreshReviewBadges();
    } catch (err) {
      alert("skip failed: " + err.message);
    } finally {
      e.target.disabled = false;
    }
  }
});

/* ─── Advanced mode (hide developer tabs by default) ────────────────────── */

const ADVANCED_KEY = "kt.advancedMode";

function isAdvancedMode() {
  return localStorage.getItem(ADVANCED_KEY) === "on";
}

function applyAdvancedMode() {
  const on = isAdvancedMode();
  document.querySelectorAll(".tab.advanced-only").forEach((el) => {
    el.hidden = !on;
  });
  // Sections that only appear in advanced mode (e.g. the full Import UI).
  document.querySelectorAll(".advanced-only-section").forEach((el) => {
    el.hidden = !on;
  });
  // Paired teaser shown in place of a hidden section when advanced is off.
  document.querySelectorAll(".advanced-only-teaser").forEach((el) => {
    el.hidden = on;
  });
  const toggle = document.getElementById("t-advanced");
  if (toggle) toggle.checked = on;
  // If advanced is off and the currently-active tab is advanced-only,
  // snap back to the Memories tab.
  const active = document.querySelector(".tab.active");
  if (!on && active?.classList?.contains("advanced-only")) {
    switchTab("memories");
  }
}

document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "t-advanced") {
    localStorage.setItem(ADVANCED_KEY, e.target.checked ? "on" : "off");
    applyAdvancedMode();
  }
});

// Apply on initial load, and whenever the Memory overlay opens.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyAdvancedMode);
} else {
  applyAdvancedMode();
}

/* ─── Memories tab (unified list + search + edit/move/delete) ───────────── */

const memoriesState = {
  query: "",
  topic: "",
  section: "",
  limit: 30,
  offset: 0,
  total: 0,
  mode: "list", // "list" | "search"
  selected: new Set(),
};

function wireMemoriesTab() {
  const search = document.getElementById("memories-search");
  if (search && !search.dataset.wired) {
    search.dataset.wired = "1";
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        memoriesState.query = search.value.trim();
        memoriesState.offset = 0;
        memoriesState.mode = memoriesState.query ? "search" : "list";
        loadMemoriesTab();
      }, 250);
    });
  }
  const topicSel = document.getElementById("memories-topic-filter");
  if (topicSel && !topicSel.dataset.wired) {
    topicSel.dataset.wired = "1";
    topicSel.addEventListener("change", () => {
      memoriesState.topic = topicSel.value;
      memoriesState.offset = 0;
      loadMemoriesTab();
    });
  }
  const sectionInp = document.getElementById("memories-section-filter");
  if (sectionInp && !sectionInp.dataset.wired) {
    sectionInp.dataset.wired = "1";
    let t2 = null;
    sectionInp.addEventListener("input", () => {
      clearTimeout(t2);
      t2 = setTimeout(() => {
        memoriesState.section = sectionInp.value.trim();
        memoriesState.offset = 0;
        loadMemoriesTab();
      }, 250);
    });
  }
  const refresh = document.getElementById("memories-refresh");
  if (refresh && !refresh.dataset.wired) {
    refresh.dataset.wired = "1";
    refresh.addEventListener("click", () => loadMemoriesTab(true));
  }
  const rename = document.getElementById("memories-rename-topic");
  if (rename && !rename.dataset.wired) {
    rename.dataset.wired = "1";
    rename.addEventListener("click", async () => {
      const fromTopic = memoriesState.topic;
      if (!fromTopic) return;
      const to = prompt(
        `Rename topic "${fromTopic}" to what?\n\n` +
          `Every memory under it will move to the new name.\n` +
          `To merge with an existing topic, type that exact name.\n` +
          `(lowercase, hyphenated — no spaces)`,
        fromTopic,
      );
      if (!to || !to.trim()) return;
      const toClean = to.trim().toLowerCase().replace(/\s+/g, "-");
      if (toClean === fromTopic) return;
      rename.disabled = true;
      try {
        const r = await fetch("/api/memories/rename-topic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from_topic: fromTopic, to_topic: toClean }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
        alert(`Moved ${d.moved} memor${d.moved === 1 ? "y" : "ies"} to "${toClean}".`);
        memoriesState.topic = toClean;
        memoriesState.offset = 0;
        memoriesState.selected.clear();
        loadMemoriesTab(true);
      } catch (err) {
        alert("rename failed: " + err.message);
      } finally {
        rename.disabled = false;
      }
    });
  }
  const prev = document.getElementById("memories-prev");
  if (prev && !prev.dataset.wired) {
    prev.dataset.wired = "1";
    prev.addEventListener("click", () => {
      memoriesState.offset = Math.max(0, memoriesState.offset - memoriesState.limit);
      loadMemoriesTab();
    });
  }
  const next = document.getElementById("memories-next");
  if (next && !next.dataset.wired) {
    next.dataset.wired = "1";
    next.addEventListener("click", () => {
      memoriesState.offset += memoriesState.limit;
      loadMemoriesTab();
    });
  }
}

async function populateMemoriesTopics() {
  const sel = document.getElementById("memories-topic-filter");
  if (!sel) return;
  try {
    const r = await fetch("/api/memories/topics");
    const d = await r.json();
    const current = sel.value;
    sel.innerHTML = '<option value="">all topics</option>';
    for (const t of d.topics || []) {
      const opt = document.createElement("option");
      opt.value = t.topic;
      opt.textContent = `${t.topic} (${t.count})`;
      sel.appendChild(opt);
    }
    sel.value = current;
  } catch {}
  // Show/hide rename button based on whether a topic is currently filtered
  const renameBtn = document.getElementById("memories-rename-topic");
  if (renameBtn) renameBtn.hidden = !memoriesState.topic;
}

async function loadMemoriesTab(forceRefresh) {
  wireMemoriesTab();
  const list = document.getElementById("memories-list");
  const page = document.getElementById("memories-page");
  if (!list) return;
  if (forceRefresh) {
    memoriesState.offset = 0;
  }
  await populateMemoriesTopics();
  list.textContent = "loading…";
  try {
    let items = [];
    let total = 0;
    if (memoriesState.mode === "search" && memoriesState.query) {
      const u = new URL("/api/memories/search", location.origin);
      u.searchParams.set("q", memoriesState.query);
      if (memoriesState.topic) u.searchParams.set("topic", memoriesState.topic);
      u.searchParams.set("n", "50");
      const r = await fetch(u);
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      items = d.items || [];
      total = items.length;
    } else {
      const u = new URL("/api/memories/list", location.origin);
      if (memoriesState.topic) u.searchParams.set("topic", memoriesState.topic);
      if (memoriesState.section) u.searchParams.set("section", memoriesState.section);
      u.searchParams.set("limit", String(memoriesState.limit));
      u.searchParams.set("offset", String(memoriesState.offset));
      const r = await fetch(u);
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      items = d.items || [];
      total = d.total || items.length;
    }
    memoriesState.total = total;

    if (!items.length) {
      list.innerHTML =
        '<div class="muted" style="padding:12px">no memories match the current filters.</div>';
    } else {
      list.innerHTML = items.map(renderMemoryRow).join("");
    }
    updateMemoriesBulkBar();

    if (page) {
      if (memoriesState.mode === "search") {
        page.textContent = `${items.length} result${items.length === 1 ? "" : "s"} for "${memoriesState.query}"`;
      } else {
        const start = memoriesState.offset + (items.length ? 1 : 0);
        const end = memoriesState.offset + items.length;
        page.textContent = `${start}–${end} of ${total}`;
      }
    }
    const prev = document.getElementById("memories-prev");
    const next = document.getElementById("memories-next");
    const canPaginate = memoriesState.mode === "list";
    if (prev) prev.disabled = !canPaginate || memoriesState.offset === 0;
    if (next) next.disabled =
      !canPaginate ||
      memoriesState.offset + memoriesState.limit >= memoriesState.total;
  } catch (err) {
    list.innerHTML = `<div class="err" style="padding:12px">error: ${escapeHtml(err.message)}</div>`;
  }
}

function formatRelativeTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const now = Date.now();
  const s = Math.round((now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  const d = new Date(t);
  const yr = d.getFullYear();
  const nowYr = new Date().getFullYear();
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = d.getDate();
  return yr === nowYr ? `${month} ${day}` : `${month} ${day}, ${yr}`;
}

function renderMemoryRow(item) {
  const id = item.drawer_id || item.id || "";
  const topic = item.wing || "?";
  const section = item.room || "?";
  const preview = item.content_preview || item.content || "";
  const sim =
    item.similarity != null ? `<span class="muted">sim ${Number(item.similarity).toFixed(2)}</span>` : "";
  const when = formatRelativeTime(item.filed_at);
  const whenHtml = when
    ? `<span class="memory-when muted" title="${escapeHtml(item.filed_at || "")}">${escapeHtml(when)}</span>`
    : "";
  const checked = memoriesState.selected.has(id) ? "checked" : "";
  return `
    <div class="memory-row" data-id="${escapeHtml(id)}">
      <div class="memory-head">
        <input type="checkbox" class="memory-pick" title="Select this memory for bulk actions" ${checked} />
        <code class="memory-loc" title="topic › section — where this memory is filed">${escapeHtml(topic)} › ${escapeHtml(section)}</code>
        ${whenHtml}
        ${sim}
        <span class="grow" style="flex:1"></span>
        <button class="ghost memory-edit" type="button" title="Edit the content of this memory in place (no topic/section change)">Edit</button>
        <button class="ghost memory-move" type="button" title="Move this memory to a different topic and/or section">Move</button>
        <button class="danger memory-delete" type="button" title="Delete this single memory — cannot be undone">Delete</button>
      </div>
      <div class="memory-body">${escapeHtml(preview)}</div>
      <div class="memory-edit-form" hidden>
        <textarea class="memory-edit-content" rows="4">${escapeHtml(preview)}</textarea>
        <div class="row" style="gap:6px;margin-top:6px">
          <button class="primary memory-save-edit" type="button" title="Save content changes to this memory">Save</button>
          <button class="ghost memory-cancel-edit" type="button" title="Discard edits and close this form">Cancel</button>
        </div>
      </div>
    </div>`;
}

function updateMemoriesBulkBar() {
  const bar = document.getElementById("memories-bulk-bar");
  if (!bar) return;
  const count = memoriesState.selected.size;
  const countEl = document.getElementById("memories-selected-count");
  const delBtn = document.getElementById("memories-bulk-delete");
  const clrBtn = document.getElementById("memories-bulk-clear");
  const selectAll = document.getElementById("memories-select-all");
  // Show the bar whenever the Memories tab is loaded (we need the "delete all
  // matching filter" button regardless of selection).
  bar.hidden = false;
  if (countEl) countEl.textContent = `${count} selected`;
  if (delBtn) delBtn.disabled = count === 0;
  if (clrBtn) clrBtn.disabled = count === 0;
  if (selectAll) {
    const visibleIds = Array.from(
      document.querySelectorAll(".memory-row"),
    ).map((el) => el.dataset.id);
    const allPicked =
      visibleIds.length > 0 &&
      visibleIds.every((id) => memoriesState.selected.has(id));
    selectAll.checked = allPicked;
  }
}

// Per-row checkbox toggle + Select-all-on-page
document.addEventListener("change", (e) => {
  if (e.target.classList?.contains("memory-pick")) {
    const row = e.target.closest(".memory-row");
    const id = row?.dataset.id;
    if (!id) return;
    if (e.target.checked) memoriesState.selected.add(id);
    else memoriesState.selected.delete(id);
    updateMemoriesBulkBar();
    return;
  }
  if (e.target && e.target.id === "memories-select-all") {
    const rows = document.querySelectorAll(".memory-row");
    const checking = e.target.checked;
    rows.forEach((row) => {
      const id = row.dataset.id;
      if (!id) return;
      if (checking) memoriesState.selected.add(id);
      else memoriesState.selected.delete(id);
      const cb = row.querySelector(".memory-pick");
      if (cb) cb.checked = checking;
    });
    updateMemoriesBulkBar();
  }
});

// Bulk bar buttons
document.addEventListener("click", async (e) => {
  if (e.target && e.target.id === "memories-bulk-clear") {
    memoriesState.selected.clear();
    document.querySelectorAll(".memory-pick").forEach((cb) => (cb.checked = false));
    updateMemoriesBulkBar();
    return;
  }
  if (e.target && e.target.id === "memories-bulk-delete") {
    const ids = Array.from(memoriesState.selected);
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected memor${ids.length === 1 ? "y" : "ies"}? This can't be undone.`)) return;
    e.target.disabled = true;
    try {
      const r = await fetch("/api/memories/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      memoriesState.selected.clear();
      loadMemoriesTab();
    } catch (err) {
      alert("bulk delete failed: " + err.message);
      e.target.disabled = false;
    }
    return;
  }
  if (e.target && e.target.id === "memories-delete-all") {
    const scope = [];
    if (memoriesState.topic) scope.push(`topic "${memoriesState.topic}"`);
    if (memoriesState.section) scope.push(`section "${memoriesState.section}"`);
    const desc = scope.length ? scope.join(" · ") : "EVERY memory in the palace";
    if (!confirm(`Delete ALL memories matching ${desc}?\n\nThis can't be undone.`)) return;
    if (!scope.length) {
      // Extra guard for the nuke case.
      if (!confirm("Final confirm: wipe the entire palace?")) return;
    }
    e.target.disabled = true;
    try {
      const r = await fetch("/api/memories/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          all_matching: true,
          topic: memoriesState.topic || undefined,
          section: memoriesState.section || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      alert(`Deleted ${d.deleted} of ${d.requested}.`);
      memoriesState.selected.clear();
      loadMemoriesTab();
    } catch (err) {
      alert("delete-all failed: " + err.message);
    } finally {
      e.target.disabled = false;
    }
    return;
  }
});

document.addEventListener("click", async (e) => {
  const row = e.target.closest?.(".memory-row");
  if (!row) return;
  const id = row.dataset.id;
  if (!id) return;

  if (e.target.classList?.contains("memory-delete")) {
    if (!confirm("Delete this memory? This can't be undone.")) return;
    e.target.disabled = true;
    try {
      const r = await fetch(`/api/memories/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(await r.text());
      row.remove();
    } catch (err) {
      alert("delete failed: " + err.message);
      e.target.disabled = false;
    }
  } else if (e.target.classList?.contains("memory-move")) {
    const newTopic = prompt("Move to topic (lowercase, hyphenated). Leave blank to keep current.");
    if (newTopic === null) return;
    const newSection = prompt("Move to section (lowercase, hyphenated). Leave blank to keep current.");
    if (newSection === null) return;
    const body = {};
    if (newTopic && newTopic.trim()) body.topic = newTopic.trim().toLowerCase().replace(/\s+/g, "-");
    if (newSection && newSection.trim()) body.section = newSection.trim().toLowerCase().replace(/\s+/g, "-");
    if (!body.topic && !body.section) return;
    try {
      const r = await fetch(`/api/drawers/${encodeURIComponent(id)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      loadMemoriesTab();
    } catch (err) {
      alert("move failed: " + err.message);
    }
  } else if (e.target.classList?.contains("memory-edit")) {
    const form = row.querySelector(".memory-edit-form");
    if (form) form.hidden = !form.hidden;
  } else if (e.target.classList?.contains("memory-cancel-edit")) {
    const form = row.querySelector(".memory-edit-form");
    if (form) form.hidden = true;
  } else if (e.target.classList?.contains("memory-save-edit")) {
    const newContent = row.querySelector(".memory-edit-content").value;
    e.target.disabled = true;
    try {
      const r = await fetch(`/api/drawers/${encodeURIComponent(id)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      });
      if (!r.ok) throw new Error(await r.text());
      loadMemoriesTab();
    } catch (err) {
      alert("save failed: " + err.message);
      e.target.disabled = false;
    }
  }
});

/* ─── Danger zone: wipe entire palace ──────────────────────────────────── */

const nukeState = { phrase: "WIPE MY MEMORY" };

async function openNukeModal() {
  // Refresh phrase from server (source of truth).
  try {
    const r = await fetch("/api/palace/nuke-phrase");
    const d = await r.json();
    if (d.phrase) nukeState.phrase = d.phrase;
  } catch {}
  const overlay = document.getElementById("nuke-overlay");
  const input = document.getElementById("nuke-input");
  const display = document.getElementById("nuke-phrase-display");
  const confirmBtn = document.getElementById("nuke-confirm");
  const status = document.getElementById("nuke-status");
  if (!overlay) return;
  if (display) display.textContent = nukeState.phrase;
  if (input) {
    input.value = "";
    input.placeholder = nukeState.phrase;
  }
  if (status) status.textContent = "";
  if (confirmBtn) confirmBtn.disabled = true;
  overlay.hidden = false;
  setTimeout(() => input?.focus(), 50);
}

function closeNukeModal() {
  const overlay = document.getElementById("nuke-overlay");
  if (overlay) overlay.hidden = true;
}

document.addEventListener("click", async (e) => {
  if (e.target && e.target.id === "memories-nuke-btn") {
    openNukeModal();
    return;
  }
  if (e.target && e.target.id === "nuke-close") { closeNukeModal(); return; }
  if (e.target && e.target.id === "nuke-cancel") { closeNukeModal(); return; }
  if (e.target && e.target.id === "nuke-overlay") { closeNukeModal(); return; }
  if (e.target && e.target.id === "nuke-confirm") {
    const input = document.getElementById("nuke-input");
    const status = document.getElementById("nuke-status");
    const confirmBtn = e.target;
    if (!input || input.value !== nukeState.phrase) return;
    confirmBtn.disabled = true;
    if (status) status.textContent = "wiping…";
    try {
      const r = await fetch("/api/palace/nuke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: input.value }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      const c = d.counts || {};
      if (status) {
        status.innerHTML =
          `Done. Deleted ${c.drawers || 0} drawers, ${c.kg_triples || 0} facts, ` +
          `${c.kg_entities || 0} entities, ${c.pending_drawers || 0} pending, ` +
          `${c.pending_questions || 0} questions.`;
      }
      memoriesState.selected.clear();
      memoriesState.offset = 0;
      loadMemoriesTab();
      setTimeout(closeNukeModal, 1800);
    } catch (err) {
      if (status) status.textContent = `error: ${err.message}`;
      confirmBtn.disabled = false;
    }
  }
});

document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "nuke-input") {
    const confirmBtn = document.getElementById("nuke-confirm");
    if (confirmBtn) confirmBtn.disabled = e.target.value !== nukeState.phrase;
  }
});

/* ─── Backups (Settings → Conversation → Advanced) ──────────────────────── */

async function renderBackupList() {
  const host = document.getElementById("backup-list");
  if (!host) return;
  try {
    const r = await fetch("/api/palace/backups");
    const d = await r.json();
    const items = d.backups || [];
    if (!items.length) {
      host.innerHTML = "<em>no backups yet</em>";
      return;
    }
    host.innerHTML =
      `<b>Existing snapshots:</b><br>` +
      items
        .slice(0, 10)
        .map(
          (b) =>
            `<div>· <code>${escapeHtml(b.name)}</code> <span class="muted">(${formatRelativeTime(b.modified) || "—"})</span></div>`,
        )
        .join("") +
      (items.length > 10 ? `<div class="muted">+${items.length - 10} more</div>` : "");
  } catch {}
}

document.addEventListener("click", async (e) => {
  if (e.target && e.target.id === "backup-now-btn") {
    const status = document.getElementById("backup-status");
    const btn = e.target;
    btn.disabled = true;
    if (status) status.textContent = "backing up…";
    try {
      const r = await fetch("/api/palace/backup", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      const parts = Object.keys(d.created || {});
      if (status) {
        status.textContent = parts.length
          ? `✓ ${d.timestamp} (${parts.join(", ")})`
          : "nothing to back up";
        status.className = "ok";
      }
      renderBackupList();
      setTimeout(() => {
        if (status) {
          status.className = "muted";
        }
      }, 2500);
    } catch (err) {
      if (status) {
        status.textContent = `error: ${err.message}`;
        status.className = "err";
      }
    } finally {
      btn.disabled = false;
    }
  }
});

// Render list on open
(function wireBackupPaneHook() {
  const showPane = window.showSettingsPane;
  if (typeof showPane !== "function") return;
  // Settings pane rendering is via a `data-pane` click. Hook the Advanced
  // show by polling the pane visibility once per settings open.
  const openSettings = document.getElementById("open-settings");
  if (openSettings && !openSettings.dataset.backupHooked) {
    openSettings.dataset.backupHooked = "1";
    openSettings.addEventListener("click", () => {
      setTimeout(renderBackupList, 200);
    });
  }
})();

/* ─── First-run onboarding hint ─────────────────────────────────────────── */

// Enhance the empty state for brand-new users (no chats + no memories).
async function maybeShowFirstRunHint() {
  try {
    const [topics, sessions] = await Promise.all([
      fetch("/api/memories/topics").then((r) => r.json()),
      Promise.resolve(state.sessions || []),
    ]);
    const noMemories = (topics?.total ?? 0) === 0;
    const noChatYet =
      !sessions.length || sessions.every((s) => !s.messages || s.messages.length === 0);
    const host = els.emptyState;
    if (!host || host.hidden) return;
    if (!noMemories || !noChatYet) return;
    if (host.querySelector(".first-run-card")) return; // already present
    const extra = document.createElement("div");
    extra.className = "first-run-card";
    extra.innerHTML = `
      <div class="first-run-title">First time here?</div>
      <p class="first-run-body">
        Try saying something specific — the assistant files the important bits
        into topics automatically, so you can find them again later.
      </p>
      <ul class="first-run-examples">
        <li>"I'm a <i>[your role]</i> working on <i>[your project]</i>."</li>
        <li>"Remember that I prefer <i>[habit/preference]</i>."</li>
        <li>"Kai is my co-founder. He handles <i>[area]</i>."</li>
      </ul>
      <p class="first-run-body muted">
        The <b>Memory</b> sidebar button shows everything it's remembered.
        Auto-file memories is on by default (Settings → Conversation to adjust).
      </p>
    `;
    host.appendChild(extra);
  } catch {}
}

// Observer approach: whenever the empty state's innerHTML changes,
// re-check if we should append the first-run card. Decoupled from
// renderEmptyState's function-declaration scope.
if (typeof MutationObserver !== "undefined") {
  const host = document.getElementById("empty-state");
  if (host) {
    const obs = new MutationObserver(() => maybeShowFirstRunHint());
    obs.observe(host, { childList: true, subtree: false });
  }
}
