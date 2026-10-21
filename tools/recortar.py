"""Quita el fondo blanco liso de las imágenes de Lacey y las deja listas para la web.

Solo borra el blanco que está conectado con el borde de la imagen, así no se
come la blusa crema ni los brillos de los lentes. Suaviza el contorno y
exporta un WEBP transparente y una carita para el botón flotante.

Uso:  python3 tools/recortar.py            (procesa todas las poses de assets-src/)
      python3 tools/recortar.py origen.png public/lacey/nombre
"""
import glob, os
import sys
from collections import deque
from PIL import Image, ImageFilter

UMBRAL = 232      # qué tan blanco tiene que ser un píxel para contar como fondo
TAM_WEB = 640     # tamaño final en píxeles
CARA = (305, 10, 725, 430)  # recuadro de la cara en la imagen original de 1024 px
TAM_CARA = 192


def recortar(origen, destino_sin_ext):
    im = Image.open(origen).convert("RGBA")
    w, h = im.size
    px = im.load()

    def es_fondo(x, y):
        r, g, b, _ = px[x, y]
        return min(r, g, b) >= UMBRAL and max(r, g, b) - min(r, g, b) < 18

    # Relleno desde los bordes
    fondo = bytearray(w * h)
    cola = deque()
    for x in range(w):
        cola.extend([(x, 0), (x, h - 1)])
    for y in range(h):
        cola.extend([(0, y), (w - 1, y)])
    while cola:
        x, y = cola.popleft()
        i = y * w + x
        if fondo[i] or not es_fondo(x, y):
            continue
        fondo[i] = 1
        if x > 0: cola.append((x - 1, y))
        if x < w - 1: cola.append((x + 1, y))
        if y > 0: cola.append((x, y - 1))
        if y < h - 1: cola.append((x, y + 1))

    # Máscara: 255 = personaje. Suavizado leve para que el borde no se vea serruchado.
    mask = Image.new("L", (w, h))
    mask.putdata([0 if f else 255 for f in fondo])
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))

    # En el borde, quitar el halo blanco: los píxeles claros del contorno se vuelven más transparentes.
    mpx = mask.load()
    for y in range(h):
        for x in range(w):
            a = mpx[x, y]
            if 0 < a < 255:
                r, g, b, _ = px[x, y]
                claridad = min(r, g, b) / 255
                mpx[x, y] = int(a * (1 - 0.6 * max(0, claridad - 0.75) / 0.25))
    im.putalpha(mask)

    # Se conserva el lienzo cuadrado completo: así todas las poses quedan alineadas igual.
    final = im.resize((TAM_WEB, TAM_WEB), Image.LANCZOS)
    final.save(destino_sin_ext + ".webp", quality=88, method=6)
    # Carita para el botón flotante
    cara = im.crop(CARA).resize((TAM_CARA, TAM_CARA), Image.LANCZOS)
    carpeta, nombre = os.path.split(destino_sin_ext)
    cara.save(os.path.join(carpeta, "cara-" + nombre + ".webp"), quality=90, method=6)
    print("listo:", destino_sin_ext)


if __name__ == "__main__":
    if len(sys.argv) == 3:
        recortar(sys.argv[1], sys.argv[2])
    else:
        os.makedirs("public/lacey", exist_ok=True)
        for origen in sorted(glob.glob("assets-src/lacey-*-original.png")):
            pose = os.path.basename(origen)[len("lacey-"):-len("-original.png")]
            recortar(origen, f"public/lacey/{pose}")
