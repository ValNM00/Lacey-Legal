// Ajustes: mi marca (perfil y logo), apariencia, uso de IA y cuenta.
import { $, $$, toast, api, store, openDialog, closeDialog } from "./util.js";
import { t } from "./i18n.js";
import { currentUser, openAuth, changePassword, signOut } from "./auth.js";
import { localLib } from "./storage.js";

const THEMES = ["rosa", "lila", "durazno", "oscuro"];
let app;
let logo = "";

export function setTheme(name) {
  const theme = THEMES.includes(name) ? name : "rosa";
  document.documentElement.dataset.theme = theme;
  $$("#themeMenu [data-theme-pick]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themePick === theme)));
  store.set("laceyLegal.theme", theme);
}

function setTab(name) {
  $$(".settings-tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.stab === name));
  $$("#settingsModal .stab").forEach((p) => p.classList.toggle("hidden", p.id !== `stab-${name}`));
  if (name === "usage") loadUsage();
  if (name === "account") renderAccount();
}

// ───────────────────────── mi marca ─────────────────────────
function renderLogo() {
  $("#logoPreview").innerHTML = logo ? `<img src="${logo}" alt="">` : `<span>${t("yourLogo")}</span>`;
  $("#logoRemove").classList.toggle("hidden", !logo);
}

function fillProfile(p = {}) {
  $("#pName").value = p.name || "";
  $("#pId").value = p.idNumber || "";
  $("#pPhone").value = p.phone || "";
  $("#pEmail").value = p.email || currentUser()?.email || "";
  $("#pAddress").value = p.address || "";
  $("#pBrand").checked = p.brandExports !== false;
  $("#pPartyA").checked = !!p.useAsPartyA;
  logo = p.logo || "";
  renderLogo();
}

/** Achica el logo (máx. 360 px) y lo convierte a PNG para que pese poco y funcione en Word. */
function resizeLogo(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 360 / img.width, 160 / img.height);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error(t("logoBad")));
    img.src = URL.createObjectURL(file);
  });
}

async function saveProfile() {
  const p = {
    name: $("#pName").value.trim(), idNumber: $("#pId").value.trim(), phone: $("#pPhone").value.trim(),
    email: $("#pEmail").value.trim(), address: $("#pAddress").value.trim(), logo,
    brandExports: $("#pBrand").checked, useAsPartyA: $("#pPartyA").checked,
  };
  const btn = $("#saveProfile");
  btn.disabled = true;
  try {
    await app.profiles().save(p);
    app.setProfile(p);
    toast(t("profileSaved"));
  } catch (err) {
    toast(err.message === "storage-full" ? t("storageFull") : err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ───────────────────────── uso de IA ─────────────────────────
async function loadUsage() {
  $("#usageNum").textContent = "…";
  try {
    const u = await api("/api/usage");
    const pct = Math.min(100, Math.round((u.used / u.limit) * 100));
    $("#usageNum").textContent = `${u.used} / ${u.limit}`;
    $("#usageBar").style.width = pct + "%";
    $("#usageBar").classList.toggle("high", pct >= 80);
    $("#usageText").textContent = u.used >= u.limit
      ? t(u.loggedIn ? "usageFull" : "usageFullAnon")
      : t("usageLeft", { n: u.limit - u.used }) + (u.loggedIn ? "" : " " + t("usageMoreWithAccount"));
  } catch {
    $("#usageNum").textContent = "—";
    $("#usageText").textContent = t("usageUnknown");
  }
}

// ───────────────────────── cuenta ─────────────────────────
function renderAccount() {
  const u = currentUser();
  $("#accountIn").classList.toggle("hidden", !u);
  $("#accountOut").classList.toggle("hidden", !!u);
  if (u) $("#accEmail").textContent = u.email;
}

async function deleteAccount() {
  const word = t("deleteWord");
  const typed = prompt(t("deleteAccountConfirm", { word }));
  if ((typed || "").trim().toUpperCase() !== word.toUpperCase()) return;
  try {
    const r = await api("/api/account", { method: "DELETE" });
    closeDialog($("#settingsModal"));
    await signOut();
    toast(r.accountDeleted ? t("accountDeleted") : t("accountDataDeleted"));
  } catch (err) {
    toast(err.message, true);
  }
}

export function openSettings(tab = "brand") {
  setTab(tab);
  app.profiles().get().then(fillProfile).catch(() => fillProfile(app.profile));
  openDialog($("#settingsModal"));
}

export function initSettings(ctx) {
  app = ctx;
  $("#settingsBtn").addEventListener("click", () => openSettings());
  $("#menuSettings").addEventListener("click", () => openSettings());
  $("#closeSettings").addEventListener("click", () => closeDialog($("#settingsModal")));
  $$(".settings-tabs .tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.stab)));
  $("#themeMenu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme-pick]");
    if (b) setTheme(b.dataset.themePick);
  });
  $("#logoInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast(t("logoBad"), true);
    try {
      logo = await resizeLogo(file);
      if (logo.length > 220_000) { logo = ""; return toast(t("logoTooBig"), true); }
      renderLogo();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#logoRemove").addEventListener("click", () => { logo = ""; renderLogo(); });
  $("#saveProfile").addEventListener("click", saveProfile);
  $("#accLogin").addEventListener("click", () => { closeDialog($("#settingsModal")); openAuth(); });
  $("#accPassSave").addEventListener("click", async () => {
    const p = $("#accPass").value;
    if (p.length < 8) return toast(t("authWeak"), true);
    try {
      await changePassword(p);
      $("#accPass").value = "";
      toast(t("passSaved"));
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#deleteAccount").addEventListener("click", deleteAccount);
  $("#clearLocal").addEventListener("click", async () => {
    if (!confirm(t("clearLocalConfirm"))) return;
    localLib.clear();
    store.remove("laceyLegal.templates.v1");
    store.remove("laceyLegal.profile.v1");
    app.setProfile({});
    app.resetDoc();
    await app.refreshList();
    closeDialog($("#settingsModal"));
    toast(t("localCleared"));
  });
  setTheme(store.get("laceyLegal.theme", "rosa"));
}
