
"""
Turn an AI-generated side-view creature sprite into an editable rig.

The point of this step: a generated image is one static pose. To animate it we
need *parts* we can move. This script chroma-keys the magenta background,
downsamples the artwork to its true logical pixel grid, and slices the
silhouette into a torso plus four legs, each with a pivot at the joint. The
output is a JSON model that tools/pixel/creatures.mjs poses per frame.

Usage: python ai_sprite.py <src.png> <out.json> <name> [target_width]
"""

import json
import sys
from collections import Counter

import numpy as np
from PIL import Image


def load_masked(path):
    """Load the sprite and return an RGBA array with the magenta key removed."""
    image = Image.open(path).convert("RGBA")
    data = np.array(image)
    r = data[:, :, 0].astype(int)
    g = data[:, :, 1].astype(int)
    b = data[:, :, 2].astype(int)
    # Magenta key: high red, low green, high blue. Be generous: the generator
    # leaves anti-aliased fringe on the key colour.
    key = (r > 150) & (g < 110) & (b > 150) & (np.abs(r - b) < 90)
    data[:, :, 3] = np.where(key, 0, 255)
    return data


def crop_to_content(data, pad=2):
    """Trim to the opaque bounding box, with a little margin."""
    alpha = data[:, :, 3] > 0
    rows = np.where(alpha.any(axis=1))[0]
    cols = np.where(alpha.any(axis=0))[0]
    if len(rows) == 0 or len(cols) == 0:
        raise SystemExit("sprite is empty after chroma key")
    y0 = max(0, rows[0] - pad)
    y1 = min(data.shape[0], rows[-1] + pad + 1)
    x0 = max(0, cols[0] - pad)
    x1 = min(data.shape[1], cols[-1] + pad + 1)
    return data[y0:y1, x0:x1]


def estimate_pixel_size(data, target_width):
    """
    Guess how many image pixels make one logical pixel.

    Generated "pixel art" is drawn at some integer block size. We want the
    logical grid, so try every block size and keep the one that makes the most
    blocks perfectly uniform (a real pixel-art block has one colour).
    """
    alpha = data[:, :, 3] > 0
    height, width = alpha.shape
    best = None
    for block in range(4, 40):
        columns = width // block
        if columns < target_width * 0.6 or columns > target_width * 1.8:
            continue
        uniform = 0
        total = 0
        for by in range(0, height - block, block):
            for bx in range(0, width - block, block):
                patch = data[by:by + block, bx:bx + block]
                flat = patch.reshape(-1, 4)
                opaque = flat[flat[:, 3] > 0]
                if len(opaque) == 0:
                    continue
                total += 1
                if len(np.unique(opaque[:, :3], axis=0)) <= 2:
                    uniform += 1
        if total == 0:
            continue
        score = uniform / total
        if best is None or score > best[1]:
            best = (block, score, columns)
    if best is None:
        return max(1, round(width / target_width))
    return best[0]


def downsample(data, block):
    """Average each block into one logical pixel by majority colour."""
    alpha = data[:, :, 3] > 0
    height, width = alpha.shape
    columns = width // block
    rows = height // block
    out = np.zeros((rows, columns, 4), dtype=np.uint8)
    for by in range(rows):
        for bx in range(columns):
            patch = data[by * block:(by + 1) * block, bx * block:(bx + 1) * block]
            flat = patch.reshape(-1, 4)
            opaque = flat[flat[:, 3] > 0]
            if len(opaque) < (block * block) * 0.4:
                continue
            counts = Counter(map(tuple, opaque[:, :3]))
            colour = counts.most_common(1)[0][0]
            out[by, bx] = (colour[0], colour[1], colour[2], 255)
    return out


def reduce_palette(data, colours=22):
    """Quantize to a small palette, keeping transparency."""
    alpha = data[:, :, 3]
    rgb = Image.fromarray(np.dstack([data[:, :, 0], data[:, :, 1], data[:, :, 2]]))
    quantized = rgb.quantize(colors=colours, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    paletted = np.array(quantized.convert("RGB"))
    out = np.dstack([paletted, alpha]).astype(np.uint8)
    return out


def find_legs(data):
    """
    Split the silhouette into a torso plus the legs below the belly line.

    Two passes: the belly line comes from the row-width profile (the torso is
    wide, the legs are thin), then the legs are connected components of the paint
    below that line. Run-lengths from the ground do not work here: a near front
    leg merges into the chest with no gap, so its column looks as tall as the body.
    """
    alpha = data[:, :, 3] > 0
    rows, columns = alpha.shape
    row_width = alpha.sum(axis=1)
    widest = int(alpha.sum(axis=1).argmax())
    max_width = int(row_width.max())

    ground = 0
    for y in range(rows - 1, -1, -1):
        if alpha[y].any():
            ground = y
            break

    # The belly line: the first row below the widest part where the silhouette
    # thins to less than 55% of its widest.
    belly = None
    for y in range(widest, rows):
        if row_width[y] < max_width * 0.55:
            belly = y
            break
    if belly is None:
        belly = max(1, int(rows * 0.55))

    # Connected components of the paint at or below the belly line.
    seen = np.zeros_like(alpha)
    groups = []
    for y in range(belly, rows):
        for x in range(columns):
            if not alpha[y, x] or seen[y, x]:
                continue
            stack = [(y, x)]
            seen[y, x] = True
            pixels = []
            while stack:
                cy, cx = stack.pop()
                pixels.append((cy, cx))
                for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                    if ny < belly or ny >= rows or nx < 0 or nx >= columns:
                        continue
                    if not alpha[ny, nx] or seen[ny, nx]:
                        continue
                    seen[ny, nx] = True
                    stack.append((ny, nx))
            xs = [p[1] for p in pixels]
            groups.append({
                "x0": min(xs), "x1": max(xs), "size": len(pixels),
                "top": min(p[0] for p in pixels),
            })

    # Keep components that look like legs: narrow and at least two pixels tall.
    legs = [g for g in groups if g["x1"] - g["x0"] <= max(6, columns * 0.16)
            and ground - g["top"] >= 2 and g["size"] >= 3]
    legs.sort(key=lambda g: g["x0"])
    return ground, belly, legs


def build_model(data, name):
    """Slice the sprite into torso and legs, and return the model dict."""
    alpha = data[:, :, 3] > 0
    rows, columns = alpha.shape
    ground, belly, leg_groups = find_legs(data)

    leg_masks = []
    torso = alpha.copy()
    for group in leg_groups:
        mask = np.zeros_like(alpha)
        for y in range(belly, rows):
            for x in range(group["x0"], group["x1"] + 1):
                if alpha[y, x]:
                    mask[y, x] = True
                    torso[y, x] = False
        leg_masks.append(mask)

    def encode(mask):
        return mask.astype(np.uint8).reshape(-1).tolist()

    model = {
        "name": name,
        "width": int(columns),
        "height": int(rows),
        "ground": int(ground),
        "belly": int(belly),
        "legBoxes": [[int(g["x0"]), int(g["x1"]), int(g["top"])] for g in leg_groups],
        "legPivots": [[(g["x0"] + g["x1"]) / 2.0, float(belly)] for g in leg_groups],
        "torsoMask": encode(torso),
        "legMasks": [encode(m) for m in leg_masks],
        "rgba": data.reshape(-1).tolist(),
    }
    return model


def main():
    if len(sys.argv) < 4:
        raise SystemExit("usage: ai_sprite.py <src.png> <out.json> <name> [target_width]")
    src, out_path, name = sys.argv[1], sys.argv[2], sys.argv[3]
    target_width = int(sys.argv[4]) if len(sys.argv) > 4 else 58

    data = crop_to_content(load_masked(src))
    block = estimate_pixel_size(data, target_width)
    small = downsample(data, block)
    small = reduce_palette(small)
    model = build_model(small, name)

    # A debug render so the slicing is visible: torso, legs get flat tints.
    debug = np.zeros((small.shape[0], small.shape[1], 4), dtype=np.uint8)
    torso = np.array(model["torsoMask"], dtype=bool).reshape(small.shape[0], small.shape[1])
    debug[torso] = [200, 200, 210, 255]
    tints = [[230, 120, 90, 255], [120, 200, 120, 255], [110, 160, 230, 255], [230, 200, 90, 255],
             [200, 120, 220, 255], [120, 220, 220, 255]]
    for i, mask in enumerate(model["legMasks"]):
        m = np.array(mask, dtype=bool).reshape(small.shape[0], small.shape[1])
        debug[m] = tints[i % len(tints)]
    Image.fromarray(debug).resize((small.shape[1] * 8, small.shape[0] * 8), Image.NEAREST).save(out_path.replace(".json", "-rigdebug.png"))
    Image.fromarray(small).resize((small.shape[1] * 8, small.shape[0] * 8), Image.NEAREST).save(out_path.replace(".json", "-pixels.png"))

    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(model, handle)
    print(json.dumps({
        "name": name,
        "block": block,
        "size": [int(small.shape[1]), int(small.shape[0])],
        "ground": model["ground"],
        "belly": model["belly"],
        "legs": model["legBoxes"],
    }))


if __name__ == "__main__":
    main()