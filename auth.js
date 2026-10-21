// Inicio de sesión con Netlify Identity (paquete @netlify/identity).
import {
  getUser, login, signup, logout, oauthLogin, handleAuthCallback, onAuthChange,
  getSettings, requestPasswordRecovery, updateUser, acceptInvite,
} from "@netlify/identity";
import { $, $$, toast, openDialog, closeDialog } from "./util.js";
import { t } from "./i18n.js";

let user = null;
let available = false;
let manual = false; // mientras el formulario hace login/signup, ignoramos los eventos de la librería
let settings = null;
const subs = new Set();

export const currentUser = () => user;
export const changePassword = (password) => updateUser({ password });
export async function signOut() {
  try { await logout(); } catch { /* igual cerramos */ }
  setUser(null);
}
export const authAvailable = () => available;
export const onUser = (fn) => subs.add(fn);

const norm = (u) => (u ? { id: u.id, email: u.email || "", name: u.name || u.userMetadata?.full_name || "" } : null);

function setUser(u) {
  const next = norm(u);
  if (next?.id === user?.id) { user = next; renderAuthUI(); return; }
  user = next;
  renderAuthUI();
  subs.forEach((fn) => fn(user));
}

export function renderAuthUI() {
  const btn = $("#loginBtn");
  const menu = $("#userMenu");
  if (!btn || !menu) return;
  btn.classList.toggle("hidden", !!user);
  menu.classList.toggle("hidden", !user);
  if (user) {
    const label = user.name || user.email;
    $("#avatar").textContent = (label[0] || "?").toUpperCase();
    $("#userEmail").textContent = user.email;
  }
}

function authError(err) {
  const s = err?.status;
  if (s === 401 || s === 400) return t("authBadCreds");
  if (s === 422) return t("authWeak");
  if (s === 403) return t("authSignupOff");
  if (/already|registered/i.test(err?.message || "")) return t("authExists");
  if (err?.name === "MissingIdentityError") return t("authOff");
  return err?.message || t("genericError");
}

let mode = "login";
function setMode(m) {
  mode = m;
  const dlg = $("#authModal");
  $$(".auth-tab", dlg).forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  $("#authNameRow").classList.toggle("hidden", m !== "signup");
  $("#authPassRow").classList.toggle("hidden", m === "forgot");
  $("#authForgot").classList.toggle("hidden", m !== "login");
  $("#authTabs").classList.toggle("hidden", m === "forgot");
  $("#authSubmit").textContent = m === "login" ? t("authLogin") : m === "signup" ? t("authCreate") : t("authSendReset");
  $("#authTitle").textContent = m === "forgot" ? t("authForgotTitle") : t("authTitle");
  $("#authMsg").textContent = "";
  $("#authPass").autocomplete = m === "signup" ? "new-password" : "current-password";
}

export function openAuth(reason) {
  if (!available) return toast(t("authOff"), true);
  setMode("login");
  $("#authReason").textContent = reason || "";
  $("#authReason").classList.toggle("hidden", !reason);
  const google = settings?.providers?.google;
  $("#googleBtn").classList.toggle("hidden", google === false);
  openDialog($("#authModal"));
  setTimeout(() => $("#authEmail").focus(), 50);
}

function openPasswordDialog(title, onSave) {
  const dlg = $("#passModal");
  $("#passTitle").textContent = title;
  $("#newPass").value = "";
  openDialog(dlg);
  $("#savePass").onclick = async () => {
    const p = $("#newPass").value;
    if (p.length < 8) return toast(t("authWeak"), true);
    try {
      await onSave(p);
      closeDialog(dlg);
      toast(t("passSaved"));
    } catch (err) {
      toast(authError(err), true);
    }
  };
}

export async function initAuth() {
  try {
    settings = await getSettings();
    available = true;
  } catch {
    available = false; // Identity no está activado (o estamos en local)
  }

  $("#loginBtn").addEventListener("click", () => openAuth());
  $$(".auth-tab").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#authForgot").addEventListener("click", () => setMode("forgot"));
  $("#authClose").addEventListener("click", () => closeDialog($("#authModal")));
  $("#googleBtn").addEventListener("click", () => {
    try { oauthLogin("google"); } catch (err) { toast(authError(err), true); }
  });
  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#authEmail").value.trim();
    const pass = $("#authPass").value;
    const msg = $("#authMsg");
    const btn = $("#authSubmit");
    if (mode !== "forgot" && pass.length < (mode === "signup" ? 8 : 1)) {
      msg.textContent = mode === "signup" ? t("authWeak") : t("authBadCreds");
      return;
    }
    btn.disabled = true;
    msg.textContent = "";
    manual = true;
    try {
      if (mode === "login") {
        setUser(await login(email, pass));
        closeDialog($("#authModal"));
        toast(t("welcomeBack"));
      } else if (mode === "signup") {
        const u = await signup(email, pass, { full_name: $("#authName").value.trim() });
        if (settings?.autoconfirm || u?.confirmedAt) {
          // Con confirmación automática iniciamos sesión explícitamente para tener la cookie de sesión.
          setUser(await login(email, pass));
          closeDialog($("#authModal"));
          toast(t("welcomeNew"));
        } else {
          msg.textContent = t("checkEmail");
        }
      } else {
        await requestPasswordRecovery(email);
        msg.textContent = t("resetSent");
      }
    } catch (err) {
      msg.textContent = authError(err);
    } finally {
      manual = false;
      btn.disabled = false;
    }
  });

  $("#logoutBtn").addEventListener("click", async () => {
    await signOut();
    toast(t("loggedOut"));
  });
  $("#avatarBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#userDropdown").classList.toggle("hidden");
  });
  document.addEventListener("click", () => $("#userDropdown")?.classList.add("hidden"));

  if (!available) {
    renderAuthUI();
    return;
  }

  onAuthChange((event, u) => {
    if (manual) return;
    if (event === "recovery") {
      setUser(u);
      openPasswordDialog(t("newPassTitle"), (p) => updateUser({ password: p }));
    } else if (event === "logout") setUser(null);
    else if (u) setUser(u);
  });

  try {
    const result = await handleAuthCallback();
    if (result?.type === "invite" && result.token) {
      openPasswordDialog(t("invitePassTitle"), async (p) => setUser(await acceptInvite(result.token, p)));
    } else if (result?.type === "confirmation") {
      toast(t("emailConfirmed"));
    }
  } catch (err) {
    toast(authError(err), true);
  }
  setUser(await getUser());
}
