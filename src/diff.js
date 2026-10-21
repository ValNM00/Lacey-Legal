// Comparación de dos textos palabra por palabra (algoritmo de Myers).
import { escapeHTML } from "./util.js";

const tokenize = (text) => text.match(/\n+|[^\S\n]+|[^\s]+/g) || [];

/** Devuelve [{ op: "=", "+", "-", text }] */
export function diffWords(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  // Recortar el principio y el final iguales: acelera mucho los contratos largos
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }
  const a2 = A.slice(start, endA);
  const b2 = B.slice(start, endB);

  const ops = myers(a2, b2);
  const out = [];
  const push = (op, text) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  if (start) push("=", A.slice(0, start).join(""));
  for (const o of ops) push(o.op, o.text);
  if (endA < A.length) push("=", A.slice(endA).join(""));
  return out;
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((text) => ({ op: "+", text }));
  if (!m) return a.map((text) => ({ op: "-", text }));
  const max = n + m;
  const off = max;
  let v = new Int32Array(2 * max + 2);
  const trace = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { trace.push(v.slice()); break outer; }
    }
    if (d > 4000) return [...a.map((text) => ({ op: "-", text })), ...b.map((text) => ({ op: "+", text }))];
  }
  // Reconstrucción hacia atrás
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ op: "=", text: a[x - 1] }); x--; y--; }
    if (d === 0) break;
    if (x === prevX) { ops.push({ op: "+", text: b[y - 1] }); y--; }
    else { ops.push({ op: "-", text: a[x - 1] }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ op: "=", text: a[x - 1] }); x--; y--; }
  return ops.reverse();
}

export function diffStats(parts) {
  const words = (s) => (s.match(/[^\s]+/g) || []).length;
  return {
    added: parts.filter((p) => p.op === "+").reduce((n, p) => n + words(p.text), 0),
    removed: parts.filter((p) => p.op === "-").reduce((n, p) => n + words(p.text), 0),
  };
}

export function renderDiff(parts) {
  const html = (s) => escapeHTML(s).replace(/\n+/g, (m) => "<br>".repeat(Math.min(2, m.length)));
  return parts.map((p) => p.op === "=" ? html(p.text) : p.op === "+" ? `<ins>${html(p.text)}</ins>` : `<del>${html(p.text)}</del>`).join("");
}

/** Texto de un HTML respetando párrafos (necesita estar en la página para innerText). */
export function htmlToText(html) {
  const div = document.createElement("div");
  div.style.cssText = "position:absolute;left:-10000px;top:0;width:700px;white-space:normal";
  div.innerHTML = html;
  document.body.append(div);
  const text = div.innerText;
  div.remove();
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
