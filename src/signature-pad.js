// Recuadro para dibujar una firma con mouse, lápiz o dedo.
export function createPad(canvas, hint) {
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let last = null;
  let ink = false;

  function reset() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#2d1a29";
    ink = false;
    hint?.classList.remove("hidden");
  }
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    last = point(e);
    canvas.setPointerCapture?.(e.pointerId);
    ctx.beginPath();
    ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2);
    ctx.fill();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    if (!ink) {
      ink = true;
      hint?.classList.add("hidden");
    }
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => canvas.addEventListener(ev, () => (drawing = false)));

  /** PNG recortado al contenido. */
  function toPNG() {
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const m = 10;
    minX = Math.max(0, minX - m); minY = Math.max(0, minY - m);
    maxX = Math.min(width, maxX + m); maxY = Math.min(height, maxY + m);
    // Escalamos a máx. 400 px de ancho para que pese poco.
    const scale = Math.min(1, 400 / (maxX - minX));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round((maxX - minX) * scale));
    out.height = Math.max(1, Math.round((maxY - minY) * scale));
    out.getContext("2d").drawImage(canvas, minX, minY, maxX - minX, maxY - minY, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }

  return { reset, toPNG, hasInk: () => ink };
}

/** Bloque HTML de firma (mismo formato que usa el servidor). */
export function signatureBlock({ png, name, meta }) {
  const block = document.createElement("div");
  block.className = "sig-block";
  const img = document.createElement("img");
  img.src = png;
  img.alt = name;
  const line = document.createElement("p");
  line.className = "sig-line";
  line.textContent = name;
  const m = document.createElement("p");
  m.className = "sig-meta";
  m.textContent = meta;
  block.append(img, line, m);
  return block;
}
