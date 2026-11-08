
"""
Turn an AI-generated side-view creature sprite into an editable rig.

A generated image is one static pose. To animate it we need *parts* we can move:
this script chroma-keys the magenta background, downsamples the artwork to its
true logical pixel grid, and slices the silhouette into a torso plus a set of
legs, each with a pivot at the joint. tools/pixel/rig.mjs then poses those parts
per frame to produce the walk and run cycles.

Usage: python ai_rig.py <sprites.json> <outdir>
  sprites.json: { "wolf": "<path to png>", ... }
"""

import json
import os
import sys
from collections import Counter

import numpy as np
from PIL import Image


def load_masked(path):
    """Load the sprite and return an RGBA array with the magenta key removed."""
    data = np.array(Image.open(path).convert("RGBA"))
    red = data[:, :, 0].astype(int)
    green = data[:, :, 1].astype(int)
    blue = data[:, :, 2].astype(int)
    key = (red > 150) & (green < 110) & (blue > 150) & (np.abs(red - blue) < 90)
    data[:, :, 3] = np.where(key, 0, 255)
    return data


def crop_to_content(data, pad=1):
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

    Generated "pixel art" is drawn at some integer block size; we want the
    logical grid, so try each block and keep the one that makes the most blocks
    perfectly uniform, which is what a real pixel-art block looks like.
    """
    alpha = data[:, :, 3] > 0
    height, width = alpha.shape
    best = None
    for block in range(4, 44):
        columns = width // block
        if columns < 30 or columns > 64:
            continue
        uniform = 0
        total = 0
        for by in range(0, height - block, block):
            for bx in range(0, width - block, block):
                flat = data[by:by + block, bx:bx + block].reshape(-1, 4)
                opaque = flat[flat[:, 3] > 0]
                if len(opaque) == 0:
                    continue
                total += 1
                if len(np.unique(opaque[:, :3], axis=0)) <= 2:
                    uniform += 1
        if total < 20:
            continue
        score = uniform / total
        # Prefer the finest grid that is still consistent: a larger block throws
        # away real detail, so only beat the incumbent by a clear margin.
        if best is None or score > best[0] * 1.06:
            best = (score, block)
    if best is None:
        return max(1, round(width / target_width))
    return best[1]


def downsample(data, block):
    """Average each block into one logical pixel by majority colour."""
    alpha = data[:, :, 3] > 0
    height, width = alpha.shape
    columns = width // block
    rows = height // block
    out = np.zeros((rows, columns, 4), dtype=np.uint8)
    for by in range(rows):
        for bx in range(columns):
            flat = data[by * block:(by + 1) * block, bx * block:(bx + 1) * block].reshape(-1, 4)
            opaque = flat[flat[:, 3] > 0]
            if len(opaque) < (block * block) * 0.4:
                continue
            colour = Counter(map(tuple, opaque[:, :3])).most_common(1)[0][0]
            out[by, bx] = (colour[0], colour[1], colour[2], 255)
    return out


def reduce_palette(data, colours=20):
    """Quantize to a small palette, keeping transparency."""
    alpha = data[:, :, 3]
    rgb = Image.fromarray(np.dstack([data[:, :, 0], data[:, :, 1], data[:, :, 2]]))
    quantized = rgb.quantize(colors=colours, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    return np.dstack([np.array(quantized.convert("RGB")), alpha]).astype(np.uint8)


def column_runs(flags):
    """Group consecutive True columns into [start, end] runs."""
    runs = []
    start = None
    for index in range(len(flags) + 1):
        has = index < len(flags) and flags[index]
        if has and start is None:
            start = index
        elif not has and start is not None:
            runs.append([start, index - 1])
            start = None
    return runs


def slice_rig(data):
    """Cut the sprite into a torso and a set of legs with pivots."""
    alpha = data[:, :, 3] > 0
    rows, columns = alpha.shape
    ground = 0
    for y in range(rows - 1, -1, -1):
        if alpha[y].any():
            ground = y
            break

    # Feet band: the lowest few rows, where nothing but legs exists.
    feet = [bool(alpha[max(0, ground - 2):ground + 1, x].any()) for x in range(columns)]
    runs = column_runs(feet)
    widths = [r[1] - r[0] + 1 for r in runs]
    median_width = float(np.median(widths)) if widths else 2.0
    split = []
    for start, end in runs:
        width = end - start + 1
        parts = max(1, int(round(width / max(1.6, median_width))))
        if parts <= 1:
            split.append([start, end])
            continue
        step = width / parts
        for index in range(parts):
            split.append([int(start + index * step), int(start + (index + 1) * step) - 1])

    # Belly line: a fixed fraction of the body height. Measuring it per leg does
    # not work, because a near front leg merges into the chest with no gap and
    # reports the whole body as its length.
    belly = max(1, ground - max(3, int(round(rows * 0.22))))

    legs = []
    torso = alpha.copy()
    for start, end in split:
        mask = np.zeros_like(alpha)
        for y in range(belly, rows):
            for x in range(start, end + 1):
                if alpha[y, x]:
                    mask[y, x] = True
                    torso[y, x] = False
        if mask.any():
            legs.append({"x0": start, "x1": end, "mask": mask})

    legs.sort(key=lambda leg: leg["x0"])
    return ground, belly, legs, torso



# Head and tail rotation is wired end to end, but the automatic cut puts the neck
# seam too far back on these sprites (the body profile is flat from shoulder to
# muzzle), which makes the whole chest swing. Off until the cut is hand-tuned per
# species; the renderer already handles a null part.
SPLIT_PARTS = True
# Where to cut the neck, as a fraction of body width. Automatic detection put the
# seam at the chest on these generated sprites (the body profile from shoulder to
# muzzle is nearly flat), which swung the whole front of the animal. Hand-set per
# species instead; the rig debug image shows the cut.
HEAD_CUT = {
    "wolf": 0.80, "wolf-run": 0.80,
    "deer": 0.86, "deer-run": 0.84,
    "fox": 0.80, "fox-run": 0.80,
    "bear": 0.80, "bear-run": 0.80,
    "rabbit": 0.82, "rabbit-run": 0.82,
    "otter": 0.74, "otter-run": 0.74,
}


def split_head_tail(alpha, columns, rows, belly):
    """Find the neck and tail-base columns and cut the two parts out.

    Both cuts are made at a narrow point so the rotated part hides its own seam:
    the head overlaps a couple of columns back into the neck, the tail a couple of
    columns forward. Without that overlap a rotated head leaves a hole where the
    neck used to be.
    """
    # Measure the BODY profile only, above the belly line: a column that also
    # contains a leg is tall from chest to foot and would never look like a neck.
    extent = []
    for x in range(columns):
        ys = np.where(alpha[:max(1, belly), x])[0]
        extent.append(int(ys[-1] - ys[0] + 1) if len(ys) else 0)
    body = max(extent) if extent else 1

    # Neck: the narrowest column in the right part of the body, ignoring the very
    # tip (a canid muzzle is thinner than its neck and would win otherwise).
    head_cut = int(columns * 0.82)
    best = None
    for x in range(int(columns * 0.55), max(int(columns * 0.55) + 1, int(columns * 0.86))):
        if extent[x] == 0:
            continue
        if best is None or extent[x] < best[1]:
            best = (x, extent[x])
    if best is not None:
        head_cut = best[0]

    # Tail: the leftmost column where the silhouette is as thick as the body.
    tail_cut = 0
    for x in range(columns):
        if extent[x] >= body * 0.55:
            tail_cut = x
            break

    def mask_for(x0, x1, grow):
        mask = np.zeros_like(alpha)
        start = max(0, x0 - grow)
        end = min(columns - 1, x1 + grow)
        for y in range(rows):
            for x in range(start, end + 1):
                if alpha[y, x]:
                    mask[y, x] = True
        return mask

    head = mask_for(head_cut, columns - 1, 2)
    tail = mask_for(0, tail_cut - 1, 2) if tail_cut > 1 else np.zeros_like(alpha)
    return head, tail, head_cut, tail_cut
def build_model(data, name, block):
    """Assemble the model dict for one species."""
    alpha = data[:, :, 3] > 0
    rows, columns = alpha.shape
    ground, belly, legs, torso = slice_rig(data)

    if SPLIT_PARTS and name in HEAD_CUT:
        head_cut = max(2, min(columns - 1, int(round(columns * HEAD_CUT[name]))))
        head = np.zeros_like(alpha)
        for y in range(rows):
            for x in range(max(0, head_cut - 2), columns):
                if alpha[y, x]:
                    head[y, x] = True
        # The tail stays part of the body: a side-view tail is already hidden
        # behind the rump, and rotating it was not worth a second seam.
        tail = np.zeros_like(alpha)
        tail_cut = 0
        for y in range(rows):
            for x in range(columns):
                if not alpha[y, x]:
                    continue
                if x >= head_cut or x < tail_cut:
                    torso[y, x] = False
    else:
        head = np.zeros_like(alpha)
        tail = np.zeros_like(alpha)
        head_cut = columns
        tail_cut = 0

    def encode(mask):
        return mask.astype(np.uint8).reshape(-1).tolist()

    # Pivots: the head turns about its neck cut, the tail about its base.
    head_rows = np.where(head.any(axis=1))[0]
    head_pivot_y = float(ground - 2)
    if len(head_rows):
        head_pivot_y = float((head_rows[0] + head_rows[-1]) / 2.0)
    tail_rows = np.where(tail.any(axis=1))[0]
    tail_pivot_y = float(ground - 4)
    if len(tail_rows):
        tail_pivot_y = float((tail_rows[0] + tail_rows[-1]) / 2.0)

    return {
        "name": name,
        "block": int(block),
        "width": int(columns),
        "height": int(rows),
        "ground": int(ground),
        "belly": int(belly),
        "headCut": int(head_cut),
        "tailCut": int(tail_cut),
        "headPivot": [float(head_cut), head_pivot_y],
        "tailPivot": [float(max(1, tail_cut)), tail_pivot_y],
        "legs": [
            {
                "x": [(leg["x0"] + leg["x1"] + 1) / 2.0, float(belly)],
                "mask": encode(leg["mask"]),
            }
            for leg in legs
        ],
        "headMask": encode(head),
        "tailMask": encode(tail),
        "torsoMask": encode(torso),
        "rgba": data.reshape(-1).tolist(),
    }


def debug_image(model, path, scale=8):
    """Colour the torso and each leg differently so the slicing is visible."""
    width, height = model["width"], model["height"]
    out = np.zeros((height, width, 4), dtype=np.uint8)
    torso = np.array(model["torsoMask"], dtype=bool).reshape(height, width)
    out[torso] = [190, 190, 200, 255]
    tints = [[232, 116, 86, 255], [116, 200, 116, 255], [104, 160, 232, 255],
             [232, 200, 88, 255], [200, 116, 220, 255], [104, 220, 220, 255],
             [232, 150, 200, 255], [170, 210, 120, 255]]
    for index, leg in enumerate(model["legs"]):
        mask = np.array(leg["mask"], dtype=bool).reshape(height, width)
        out[mask] = tints[index % len(tints)]
    head = np.array(model["headMask"], dtype=bool).reshape(height, width)
    out[head] = [250, 240, 120, 255]
    tail = np.array(model["tailMask"], dtype=bool).reshape(height, width)
    out[tail] = [250, 120, 250, 255]
    Image.fromarray(out).resize((width * scale, height * scale), Image.NEAREST).save(path)


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: python ai_rig.py <sprites.json> <outdir>")
    sprites = json.load(open(sys.argv[1], encoding="utf-8"))
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    summary = {}
    for name, path in sprites.items():
        data = crop_to_content(load_masked(path))
        block = estimate_pixel_size(data, 58)
        # A "-run" pose must be sampled on the SAME logical pixel grid as the
        # standing pose of the same species, or the animal changes pixel density
        # the moment it starts running.
        if name.endswith("-run"):
            base_path = os.path.join(outdir, name[:-4] + ".json")
            if os.path.exists(base_path):
                block = json.load(open(base_path, encoding="utf-8")).get("block", block)
        small = reduce_palette(downsample(data, block))
        model = build_model(small, name, block)
        with open(os.path.join(outdir, name + ".json"), "w", encoding="utf-8") as handle:
            json.dump(model, handle)
        Image.fromarray(small).resize((model["width"] * 8, model["height"] * 8), Image.NEAREST).save(
            os.path.join(outdir, name + "-pixels.png"))
        debug_image(model, os.path.join(outdir, name + "-rig.png"))
        summary[name] = {
            "pixels": [model["width"], model["height"]],
            "block": block,
            "belly": model["belly"],
            "ground": model["ground"],
            "legs": [[int(leg["x"][0]), int(leg["x"][1])] for leg in model["legs"]],
        }
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
