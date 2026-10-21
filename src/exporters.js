// Exportar: PDF, Word (.docx) y calendario (.ics).
// Las librerías pesadas se cargan solo cuando se usan.
import { downloadBlob, slugify, escapeHTML } from "./util.js";

const titleOf = (el) => (el.querySelector("h1")?.textContent || "contrato").trim();

/** Encabezado con la marca de la usuaria (logo + datos). */
function brandHeader(brand) {
  if (!brand?.name && !brand?.logo) return null;
  const el = document.createElement("div");
  el.className = "brand-head";
  const details = [brand.idNumber, brand.email, brand.phone].filter(Boolean).map(escapeHTML).join(" · ");
  el.innerHTML =
    (brand.logo ? `<img src="${escapeHTML(brand.logo)}" alt="">` : "") +
    `<div>${brand.name ? `<strong>${escapeHTML(brand.name)}</strong>` : ""}` +
    (details ? `<small>${details}</small>` : "") +
    (brand.address ? `<small>${escapeHTML(brand.address)}</small>` : "") + "</div>";
  return el;
}

/**
 * PDF A4 con numeración de páginas.
 * opts.brand: perfil de la usuaria (logo y datos arriba)
 * opts.certificate: HTML del certificado de firmas (va en una página aparte al final)
 */
export async function exportPDF(docEl, opts = {}) {
  if (typeof opts === "string") opts = { filename: opts };
  const { filename, brand, certificate } = opts;
  const { default: html2pdf } = await import("html2pdf.js");
  // html2pdf necesita el elemento montado en la página para dibujarlo.
  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;left:-10000px;top:0;width:700px;background:#fff";
  const clone = docEl.cloneNode(true);
  clone.removeAttribute("contenteditable");
  clone.removeAttribute("id");
  clone.classList.add("doc");
  clone.style.cssText = "box-shadow:none;max-width:none;min-height:0;padding:0;margin:0;border-radius:0;background:#fff;color:#2d1a29";
  const head = brandHeader(brand);
  if (head) clone.prepend(head);
  if (certificate) {
    const cert = document.createElement("div");
    cert.className = "cert-page";
    cert.innerHTML = certificate;
    clone.append(cert);
  }
  holder.append(clone);
  document.body.append(holder);
  const footer = brand?.name ? `${brand.name}  ·  Lacey Legal` : "Lacey Legal";
  try {
    await html2pdf().set({
      margin: [18, 16, 18, 16],
      filename: `${filename || slugify(titleOf(docEl))}.pdf`,
      image: { type: "jpeg", quality: 0.96 },
      // scrollX/scrollY en 0: si la página está desplazada, html2canvas dibuja en blanco.
      html2canvas: { scale: 2, backgroundColor: "#ffffff", useCORS: true, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"], before: [".cert-page"], avoid: [".sig-block", "h2", "tr", ".cert-status"] },
    }).from(clone).toPdf().get("pdf").then((pdf) => {
      const total = pdf.internal.getNumberOfPages();
      const w = pdf.internal.pageSize.getWidth();
      const h = pdf.internal.pageSize.getHeight();
      for (let i = 1; i <= total; i++) {
        pdf.setPage(i);
        pdf.setFontSize(8);
        pdf.setTextColor(140, 110, 130);
        pdf.text(footer, 16, h - 9);
        pdf.text(`${i} / ${total}`, w - 16, h - 9, { align: "right" });
      }
    }).save();
  } finally {
    holder.remove();
  }
}

export async function exportDocx(docEl, { brand, certificate } = {}) {
  const {
    Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, LevelFormat,
    Header, Footer, PageNumber, PageBreak,
  } = await import("docx");

  const runsOf = (node, fmt = {}) => {
    const runs = [];
    node.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        if (n.nodeValue) runs.push(new TextRun({ text: n.nodeValue.replace(/\s+/g, " "), ...fmt }));
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.tagName;
        if (tag === "BR") runs.push(new TextRun({ break: 1 }));
        else runs.push(...runsOf(n, {
          ...fmt,
          ...(tag === "STRONG" || tag === "B" ? { bold: true } : {}),
          ...(tag === "EM" || tag === "I" ? { italics: true } : {}),
          ...(tag === "U" ? { underline: {} } : {}),
        }));
      }
    });
    return runs;
  };

  const imgData = (src) => {
    const bin = atob(src.split(",")[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  const out = [];
  let olCount = 0;
  const walk = (parent) => {
    parent.childNodes.forEach((el) => {
      if (el.nodeType === Node.TEXT_NODE) {
        if (el.nodeValue.trim()) out.push(new Paragraph({ children: [new TextRun(el.nodeValue.trim())] }));
        return;
      }
      if (el.nodeType !== Node.ELEMENT_NODE) return;
      switch (el.tagName) {
        case "H1":
          out.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: runsOf(el) }));
          break;
        case "H2":
          out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: runsOf(el) }));
          break;
        case "H3": case "H4":
          out.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: runsOf(el) }));
          break;
        case "P": {
          const center = el.classList.contains("sig-line") || el.classList.contains("sig-meta");
          out.push(new Paragraph({
            alignment: center ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
            border: el.classList.contains("sig-line") ? { top: { style: "single", size: 6, color: "2D1A29", space: 4 } } : undefined,
            // espacio en blanco para firmar a mano si todavía no hay firma
            spacing: el.classList.contains("sig-line") && !el.closest(".sig-block")?.querySelector("img") ? { before: 1100 } : undefined,
            children: runsOf(el, el.classList.contains("sig-meta") ? { size: 18, color: "6B5566" } : {}),
          }));
          break;
        }
        case "UL": case "OL": {
          const ordered = el.tagName === "OL";
          const ref = ordered ? `ol-${olCount++}` : null;
          el.querySelectorAll(":scope > li").forEach((li) => out.push(new Paragraph({
            children: runsOf(li),
            ...(ordered ? { numbering: { reference: ref, level: 0 } } : { bullet: { level: 0 } }),
          })));
          break;
        }
        case "IMG": {
          const src = el.getAttribute("src") || "";
          if (!src.startsWith("data:image/png")) break;
          const w = el.naturalWidth || 300;
          const h = el.naturalHeight || 100;
          const height = 60;
          out.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new ImageRun({ type: "png", data: imgData(src), transformation: { width: Math.round((w / h) * height), height } })],
          }));
          break;
        }
        case "HR":
          out.push(new Paragraph({ border: { bottom: { style: "single", size: 6, color: "CCCCCC", space: 1 } } }));
          break;
        case "TABLE":
          el.querySelectorAll("tr").forEach((tr) => {
            const cells = [...tr.children].map((td) => td.innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
            if (cells.length) out.push(new Paragraph({ children: [new TextRun({ text: cells.join("  ·  "), size: 18, bold: tr.parentElement.tagName === "THEAD" })] }));
          });
          break;
        default:
          walk(el); // div, section, signatures...
      }
    });
  };
  walk(docEl);
  if (certificate) {
    const cert = document.createElement("div");
    cert.innerHTML = certificate;
    document.body.append(cert); // innerText necesita el elemento en la página
    cert.style.cssText = "position:absolute;left:-10000px;top:0;width:700px";
    out.push(new Paragraph({ children: [new PageBreak()] }));
    walk(cert);
    cert.remove();
  }

  // Encabezado con la marca y pie con número de página
  const headerKids = [];
  if (brand?.logo?.startsWith("data:image/png")) {
    const img = new Image();
    img.src = brand.logo;
    await img.decode().catch(() => {});
    const h = 36;
    const w = img.naturalHeight ? Math.round((img.naturalWidth / img.naturalHeight) * h) : 90;
    headerKids.push(new Paragraph({ children: [new ImageRun({ type: "png", data: imgData(brand.logo), transformation: { width: w, height: h } })] }));
  }
  if (brand?.name) {
    const details = [brand.idNumber, brand.email, brand.phone].filter(Boolean).join(" · ");
    headerKids.push(new Paragraph({ children: [new TextRun({ text: brand.name, bold: true, size: 20, color: "4A2340" })] }));
    if (details) headerKids.push(new Paragraph({ children: [new TextRun({ text: details, size: 16, color: "7A5470" })] }));
  }
  const footerText = brand?.name ? `${brand.name}  ·  Lacey Legal   ` : "Lacey Legal   ";

  const doc = new Document({
    creator: "Lacey Legal",
    title: titleOf(docEl),
    styles: {
      default: { document: { run: { font: "Georgia", size: 22 }, paragraph: { spacing: { after: 120, line: 300 } } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", run: { size: 34, bold: true, color: "4A2340" }, paragraph: { spacing: { after: 240 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", run: { size: 24, bold: true, color: "C23D70" }, paragraph: { spacing: { before: 240, after: 80 } } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", run: { size: 22, bold: true }, paragraph: { spacing: { before: 160, after: 60 } } },
      ],
    },
    numbering: {
      config: Array.from({ length: Math.max(1, olCount) }, (_, i) => ({
        reference: `ol-${i}`,
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }],
      })),
    },
    sections: [{
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      headers: headerKids.length ? { default: new Header({ children: headerKids }) } : undefined,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: footerText, size: 16, color: "8C6E82" }),
              new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], size: 16, color: "8C6E82" }),
            ],
          })],
        }),
      },
      children: out,
    }],
  });
  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, `${slugify(titleOf(docEl))}.docx`);
}

/** Evento de calendario con alarma X días antes del vencimiento. */
export function downloadICS({ title, endDate, remindDays = 7, url = location.origin }) {
  const d = endDate.replace(/-/g, "");
  const next = new Date(endDate + "T12:00:00");
  next.setDate(next.getDate() + 1);
  const d2 = next.toISOString().slice(0, 10).replace(/-/g, "");
  const esc = (s) => String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lacey Legal//ES", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${crypto.randomUUID?.() || Date.now()}@lacey-legal`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${d2}`,
    `SUMMARY:${esc("Vence: " + title)}`, `DESCRIPTION:${esc("Contrato creado en Lacey Legal: " + url)}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc("Vence: " + title)}`, `TRIGGER:-P${Math.max(0, remindDays)}D`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  downloadBlob(new Blob([ics], { type: "text/calendar" }), `${slugify(title)}.ics`);
}
