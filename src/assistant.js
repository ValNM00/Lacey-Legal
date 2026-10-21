/* ───────────── Lacey, la asistente animada ─────────────
 * - Botón flotante con su cara, que cambia según su ánimo.
 * - Burbuja ("peek") para avisos cortos cuando el panel está cerrado.
 * - Panel de chat: responde sobre el contrato abierto y sobre cómo usar la app.
 * - Habla: alterna las imágenes "normal" y "hablando" mientras escribe o lee en voz alta.
 * - Recorrido guiado por la página.
 */
import { $, $$, ai, escapeHTML, store } from "./util.js";
import { t, getUILang, langCode } from "./i18n.js";

const MOODS = ["normal", "hablando", "saludando", "pensando", "feliz", "preocupada", "leyendo"];
const IMG = (m) => `/lacey/${m}.webp`;
const FACE = (m) => `/lacey/cara-${m}.webp`;
const KEY_SEEN = "laceyLegal.laceySeen";
const KEY_VOICE = "laceyLegal.laceyVoice";
const KEY_MUTED = "laceyLegal.laceyMuted";
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

let ctx = { getContext: () => ({}), actions: {} };
let mood = "normal";
let talkTimer = null;
let peekTimer = null;
let history = []; // { role: "user" | "lacey", text }
let sending = false;
let voiceOn = store.get(KEY_VOICE, false);
let muted = store.get(KEY_MUTED, false);
let tour = null;
let greeted = false;

const el = {};

// ───────────────────────── imagen y ánimo ─────────────────────────
function show(m) {
  el.body.src = IMG(m);
  el.face.src = FACE(m);
}

export function setMood(m = "normal") {
  if (!MOODS.includes(m)) m = "normal";
  mood = m;
  if (!talkTimer) {
    show(m);
    el.root.dataset.mood = m;
    el.stage.classList.remove("pop");
    void el.stage.offsetWidth; // reinicia la animación
    el.stage.classList.add("pop");
  }
}

function startTalking() {
  stopTalking(false);
  let open = false;
  const tick = () => {
    open = !open;
    show(open ? "hablando" : "normal");
    talkTimer = setTimeout(tick, open ? 120 + Math.random() * 90 : 90 + Math.random() * 120);
  };
  tick();
}

function stopTalking(restore = true) {
  clearTimeout(talkTimer);
  talkTimer = null;
  if (restore) setMood(mood);
}

// ───────────────────────── voz ─────────────────────────
function pickVoice(code) {
  const voices = window.speechSynthesis?.getVoices() || [];
  const base = code.split("-")[0];
  const same = voices.filter((v) => v.lang?.toLowerCase().startsWith(base));
  return same.find((v) => /female|mujer|paulina|monica|mónica|helena|sabina|lucia|elena|francisca|camila|google/i.test(v.name)) || same[0] || null;
}

function speak(text) {
  return new Promise((resolve) => {
    if (!voiceOn || !window.speechSynthesis) return resolve(false);
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[*_#>-]/g, " "));
    u.lang = langCode(getUILang());
    const v = pickVoice(u.lang);
    if (v) u.voice = v;
    u.rate = 1.03;
    u.pitch = 1.08;
    const done = () => resolve(true);
    u.onend = done;
    u.onerror = done;
    setTimeout(done, Math.min(60000, 1500 + text.length * 90)); // por si el navegador nunca avisa
    window.speechSynthesis.speak(u);
  });
}

// ───────────────────────── formato de las respuestas ─────────────────────────
function format(text) {
  const inline = (s) => escapeHTML(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return text.trim().split(/\n{2,}/).map((block) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length && lines.every((l) => /^[-*•]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

// ───────────────────────── botones de acción ─────────────────────────
const ACTION_LABEL = {
  generate: "act_generate", review: "act_review", share: "act_share", sign: "act_sign", due: "act_due",
  versions: "act_versions", translate: "act_translate", pdf: "act_pdf", word: "act_word",
  analyze: "act_analyze", login: "act_login", tour: "act_tour",
  dashboard: "act_dashboard", templates: "act_templates", comments: "act_comments", certificate: "act_certificate", settings: "act_settings",
};

function normalizeActions(actions = []) {
  return actions.map((a) => {
    if (typeof a === "string") {
      if (a === "tour") return { label: t("act_tour"), run: startTour };
      if (!ctx.actions[a]) return null;
      return { label: t(ACTION_LABEL[a] || a), run: ctx.actions[a] };
    }
    return a;
  }).filter(Boolean);
}

function actionButtons(container, actions, { closePanel = true } = {}) {
  normalizeActions(actions).forEach((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-soft btn-sm";
    b.textContent = a.label;
    b.addEventListener("click", () => {
      hidePeek();
      if (closePanel) closeChat();
      a.run();
    });
    container.append(b);
  });
}

// ───────────────────────── burbuja (peek) ─────────────────────────
function hidePeek() {
  clearTimeout(peekTimer);
  el.peek.classList.add("hidden");
}

function showPeek(text, { actions = [], duration = 8000, buttons } = {}) {
  clearTimeout(peekTimer);
  el.peekText.textContent = text;
  el.peekActions.innerHTML = "";
  if (buttons) buttons(el.peekActions);
  else actionButtons(el.peekActions, actions);
  el.peek.classList.remove("hidden");
  if (duration) peekTimer = setTimeout(hidePeek, duration);
}

/**
 * Lacey reacciona a algo que pasó en la página.
 * Devuelve true si mostró el mensaje (para no repetirlo con un toast).
 */
export function react(m, text, { actions = [], duration } = {}) {
  setMood(m);
  if (!text) return false;
  if (isOpen()) {
    addMessage("lacey", text, { actions, animate: false });
    return true;
  }
  if (muted || tour) {
    el.dot.classList.remove("hidden");
    history.push({ role: "lacey", text });
    renderMessage("lacey", text, actions);
    return false;
  }
  showPeek(text, { actions, duration: duration ?? (actions.length ? 12000 : 7000) });
  history.push({ role: "lacey", text });
  renderMessage("lacey", text, actions);
  return true;
}

// ───────────────────────── chat ─────────────────────────
const isOpen = () => !el.panel.classList.contains("hidden");

function renderMessage(role, text, actions = []) {
  const div = document.createElement("div");
  div.className = `msg msg-${role}`;
  div.innerHTML = role === "lacey" ? format(text) : `<p>${escapeHTML(text)}</p>`;
  if (role === "lacey" && actions.length) {
    const row = document.createElement("div");
    row.className = "msg-actions";
    actionButtons(row, actions);
    div.append(row);
  }
  el.msgs.append(div);
  el.msgs.scrollTop = el.msgs.scrollHeight;
  return div;
}

async function typeInto(div, text) {
  const words = text.split(/(\s+)/);
  if (reduceMotion() || words.length < 4) {
    div.innerHTML = format(text);
    return;
  }
  const total = Math.min(2600, words.length * 38);
  const step = total / words.length;
  let shown = "";
  for (const w of words) {
    shown += w;
    div.innerHTML = format(shown);
    el.msgs.scrollTop = el.msgs.scrollHeight;
    await new Promise((r) => setTimeout(r, step));
  }
}

async function addMessage(role, text, { actions = [], animate = true, mood: endMood = "normal" } = {}) {
  history.push({ role, text });
  if (role !== "lacey") return renderMessage(role, text);
  const div = renderMessage("lacey", "", []);
  startTalking();
  const speech = speak(text);
  await typeInto(div, text);
  if (!animate) div.innerHTML = format(text);
  await speech;
  stopTalking(false);
  setMood(endMood);
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "msg-actions";
    actionButtons(row, actions);
    div.append(row);
    el.msgs.scrollTop = el.msgs.scrollHeight;
  }
  return div;
}

async function ask(question) {
  question = question.trim();
  if (!question || sending) return;
  sending = true;
  el.send.disabled = true;
  el.input.value = "";
  autoGrow();
  addMessage("user", question);
  setMood("pensando");
  const typing = document.createElement("div");
  typing.className = "msg msg-lacey typing";
  typing.innerHTML = `<span></span><span></span><span></span><span class="visually-hidden">${escapeHTML(t("lc_thinking"))}</span>`;
  el.msgs.append(typing);
  el.msgs.scrollTop = el.msgs.scrollHeight;
  try {
    const c = ctx.getContext();
    const r = await ai({
      action: "chat",
      language: getUILang(),
      contract: c.contract || "",
      page: c.page || {},
      messages: history.slice(-12),
    });
    typing.remove();
    await addMessage("lacey", r.reply, { actions: r.actions || [], mood: r.mood });
  } catch (err) {
    typing.remove();
    setMood("preocupada");
    renderMessage("lacey", err.message || t("genericError"));
  } finally {
    sending = false;
    el.send.disabled = false;
    el.input.focus();
  }
}

function autoGrow() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(120, el.input.scrollHeight) + "px";
}

export function openChat() {
  hidePeek();
  el.dot.classList.add("hidden");
  el.panel.classList.remove("hidden");
  el.root.classList.add("open");
  el.launcher.setAttribute("aria-expanded", "true");
  if (!greeted) {
    greeted = true;
    addMessage("lacey", t("lc_hello"), { mood: "saludando" });
  }
  setTimeout(() => el.input.focus(), 50);
}

export function closeChat() {
  el.panel.classList.add("hidden");
  el.root.classList.remove("open");
  el.launcher.setAttribute("aria-expanded", "false");
  window.speechSynthesis?.cancel();
  stopTalking();
}

// ───────────────────────── recorrido guiado ─────────────────────────
const TOUR = [
  ["#panel .dash-head", "tour0", "saludando"],
  ["#typeChips", "tour1", "normal"],
  [".input-card .tabs", "tour2", "pensando"],
  ["#generateBtn", "tour3", "feliz"],
  [".editor-card .toolbar", "tour4", "normal"],
  ["#analizar .analyze-card", "tour5", "leyendo"],
  ["#settingsBtn", "tour6", "normal"],
  ["#loginBtn:not(.hidden), #avatarBtn", "tour7", "saludando"],
];

function placeRing() {
  if (!tour) return;
  const target = $(TOUR[tour.i][0]);
  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 8;
    Object.assign(el.ring.style, {
      top: `${r.top - pad}px`, left: `${r.left - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });
  }
  tour.raf = requestAnimationFrame(placeRing);
}

function tourStep(i) {
  if (i >= TOUR.length) return endTour();
  tour.i = i;
  const [sel, key, m] = TOUR[i];
  const target = $(sel);
  if (!target) return tourStep(i + 1);
  target.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
  setMood(m);
  el.ring.classList.remove("hidden");
  showPeek(`${t(key)}`, {
    duration: 0,
    buttons: (box) => {
      const counter = document.createElement("span");
      counter.className = "tour-count";
      counter.textContent = `${i + 1}/${TOUR.length}`;
      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "link-btn";
      skip.textContent = t("tourSkip");
      skip.addEventListener("click", endTour);
      const next = document.createElement("button");
      next.type = "button";
      next.className = "btn btn-primary btn-sm";
      next.textContent = i === TOUR.length - 1 ? t("tourDone") : t("tourNext");
      next.addEventListener("click", () => tourStep(i + 1));
      box.append(counter, skip, next);
      setTimeout(() => next.focus(), 60);
    },
  });
  speak(t(key));
}

export function startTour() {
  closeChat();
  hidePeek();
  if (tour) cancelAnimationFrame(tour.raf);
  tour = { i: 0 };
  el.root.classList.add("touring");
  placeRing();
  tourStep(0);
}

function endTour() {
  if (!tour) return;
  cancelAnimationFrame(tour.raf);
  tour = null;
  el.ring.classList.add("hidden");
  el.root.classList.remove("touring");
  window.speechSynthesis?.cancel();
  showPeek(t("tourEnd"), { duration: 6000 });
  setMood("feliz");
}

// ───────────────────────── inicio ─────────────────────────
function syncToggles() {
  el.voice.setAttribute("aria-pressed", String(voiceOn));
  el.voice.classList.toggle("on", voiceOn);
  el.mute.setAttribute("aria-pressed", String(!muted));
  el.mute.classList.toggle("on", !muted);
}

export function initLacey({ getContext, actions }) {
  ctx = { getContext, actions };
  Object.assign(el, {
    root: $("#lacey"), launcher: $("#laceyLauncher"), face: $("#laceyFace"), dot: $("#laceyDot"),
    peek: $("#laceyPeek"), peekText: $("#laceyPeekText"), peekActions: $("#laceyPeekActions"),
    panel: $("#laceyPanel"), stage: $("#laceyStage"), body: $("#laceyBody"), msgs: $("#laceyMsgs"),
    form: $("#laceyForm"), input: $("#laceyInput"), send: $("#laceySend"),
    voice: $("#laceyVoice"), mute: $("#laceyMute"), ring: $("#tourRing"),
  });

  el.launcher.addEventListener("click", () => (isOpen() ? closeChat() : openChat()));
  $("#laceyClose").addEventListener("click", closeChat);
  $("#laceyPeekClose").addEventListener("click", hidePeek);
  el.peekText.addEventListener("click", () => { if (!tour) openChat(); });
  el.form.addEventListener("submit", (e) => { e.preventDefault(); ask(el.input.value); });
  el.input.addEventListener("input", autoGrow);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(el.input.value); }
  });
  $$("#laceyChips [data-ask]").forEach((b) => b.addEventListener("click", () => ask(b.textContent)));
  $("#laceyChips [data-tour]")?.addEventListener("click", startTour);
  el.voice.addEventListener("click", () => {
    voiceOn = !voiceOn;
    store.set(KEY_VOICE, voiceOn);
    if (!voiceOn) window.speechSynthesis?.cancel();
    syncToggles();
  });
  el.mute.addEventListener("click", () => {
    muted = !muted;
    store.set(KEY_MUTED, muted);
    syncToggles();
  });
  if (!window.speechSynthesis) el.voice.classList.add("hidden");
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (tour) endTour();
    else if (isOpen()) closeChat();
  });
  window.speechSynthesis?.getVoices(); // algunos navegadores cargan las voces tarde
  syncToggles();

  // Precarga de las poses para que el cambio sea instantáneo
  const preload = () => MOODS.forEach((m) => { new Image().src = IMG(m); new Image().src = FACE(m); });
  (window.requestIdleCallback || ((f) => setTimeout(f, 1200)))(preload);

  // Primera visita: saludo e invitación al recorrido
  if (!store.get(KEY_SEEN)) {
    setTimeout(() => {
      store.set(KEY_SEEN, true);
      setMood("saludando");
      showPeek(t("lc_welcome"), {
        duration: 0,
        actions: [
          { label: t("lc_welcomeYes"), run: startTour },
          { label: t("lc_welcomeNo"), run: () => setMood("normal") },
        ],
      });
    }, 1400);
  }
}
