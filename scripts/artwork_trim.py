"""Generic artwork trim for images that don't follow the Atrang (frame + mat) or Nakhrro
(paper margin) layouts: peels uniform light bands (white space, paper, mats) off each side,
plus thin dark frame lines that sit outside a light band. Painted borders and dark artwork
backgrounds are kept."""

import numpy as np

LINE_MATCH = 0.85
LIGHT_TOL = 38
DARK_TOL = 45
THIN_DARK = 0.015
FRAME_DARK = 0.08
MAX_PEEL = 0.30
MIN_KEEP = 0.40


def _line(arr, rect, side, offset):
    x0, y0, x1, y1 = rect
    if side == "top":
        return arr[y0 + offset, x0:x1]
    if side == "bottom":
        return arr[y1 - 1 - offset, x0:x1]
    if side == "left":
        return arr[y0:y1, x0 + offset]
    return arr[y0:y1, x1 - 1 - offset]


def _span(rect, side):
    x0, y0, x1, y1 = rect
    return (y1 - y0) if side in ("top", "bottom") else (x1 - x0)


def _is_light(color, light_min=180):
    return color.min() >= light_min and color.max() - color.min() <= 45


def _is_dark(color):
    return color.max() <= 75


def _band(arr, rect, side, start, kind, limit, light_min=180):
    """Depth of a uniform light or dark band starting `start` lines in from `side`."""
    span = _span(rect, side)
    depth = 0
    color = None
    tol = LIGHT_TOL if kind == "light" else DARK_TOL
    while start + depth < span and depth < limit:
        line = _line(arr, rect, side, start + depth).astype(np.int16)
        median = np.median(line, axis=0)
        if color is None:
            if not (_is_light(median, light_min) if kind == "light" else _is_dark(median)):
                return 0
            color = median
        match = (np.abs(line - color).max(axis=1) <= tol).mean()
        if match < LINE_MATCH:
            break
        color = 0.8 * color + 0.2 * median
        depth += 1
    return depth


def _shrink(rect, side, depth):
    x0, y0, x1, y1 = rect
    if side == "top":
        return (x0, y0 + depth, x1, y1)
    if side == "bottom":
        return (x0, y0, x1, y1 - depth)
    if side == "left":
        return (x0 + depth, y0, x1, y1)
    return (x0, y0, x1 - depth, y1)


def trim_rect(arr, light_min=180):
    """Returns (rect, peeled) on `arr` (H x W x 3 uint8). `light_min` is the darkest channel value
    still treated as a light margin."""
    h, w = arr.shape[:2]
    rect = (0, 0, w, h)
    for _ in range(4):
        changed = False
        for side in ("top", "bottom", "left", "right"):
            full = h if side in ("top", "bottom") else w
            limit = int(full * MAX_PEEL)
            dark = _band(arr, rect, side, 0, "dark", int(full * FRAME_DARK) + 1)
            if dark:
                light_after = _band(arr, rect, side, dark, "light", limit, light_min)
                if dark <= full * THIN_DARK or light_after >= 2:
                    rect = _shrink(rect, side, dark + light_after)
                    changed = True
                    continue
            light = _band(arr, rect, side, 0, "light", limit, light_min)
            if light:
                rect = _shrink(rect, side, light)
                changed = True
        if not changed:
            break
    x0, y0, x1, y1 = rect
    if (x1 - x0) < w * MIN_KEEP or (y1 - y0) < h * MIN_KEEP:
        return (0, 0, w, h), False
    return rect, rect != (0, 0, w, h)


INNER_SEARCH = 0.15
INNER_START = 0.005
LIGHT_MIN_DEPTH = 0.008
DARK_MAX_DEPTH = 0.05


def _uniform_lines(arr, side, kind, count):
    """Flags for the first `count` lines from `side` that are uniform and light/dark (centre 80%)."""
    h, w = arr.shape[:2]
    flags = []
    for offset in range(count):
        if side == "top":
            line = arr[offset, int(w * 0.1):int(w * 0.9)]
        elif side == "bottom":
            line = arr[h - 1 - offset, int(w * 0.1):int(w * 0.9)]
        elif side == "left":
            line = arr[int(h * 0.1):int(h * 0.9), offset]
        else:
            line = arr[int(h * 0.1):int(h * 0.9), w - 1 - offset]
        line = line.astype(np.int16)
        median = np.median(line, axis=0)
        ok = _is_light(median) if kind == "light" else _is_dark(median)
        tol = LIGHT_TOL if kind == "light" else DARK_TOL
        flags.append(bool(ok and (np.abs(line - median).max(axis=1) <= tol).mean() >= LINE_MATCH))
    return flags


def inner_band_rect(arr, kind):
    """Inner edge of a light mat or a thin dark outline that runs round all four sides
    a little way in from the edge (a frame or mount outside it). None if not found."""
    h, w = arr.shape[:2]
    edges = {}
    for side in ("top", "bottom", "left", "right"):
        full = h if side in ("top", "bottom") else w
        flags = _uniform_lines(arr, side, kind, int(full * INNER_SEARCH))
        start = max(1, int(full * INNER_START))
        found = None
        i = start
        while i < len(flags):
            if not flags[i]:
                i += 1
                continue
            j = i
            while j < len(flags) and flags[j]:
                j += 1
            depth = j - i
            if kind == "light" and depth >= max(2, full * LIGHT_MIN_DEPTH) and j < len(flags):
                found = j
                break
            if kind == "dark" and 2 <= depth <= full * DARK_MAX_DEPTH and j < len(flags):
                found = j
                break
            i = j
        if found is None:
            return None
        edges[side] = found
    rect = (edges["left"], edges["top"], w - edges["right"], h - edges["bottom"])
    if rect[2] - rect[0] < w * MIN_KEEP or rect[3] - rect[1] < h * MIN_KEEP:
        return None
    return rect


MOUNT_TOL = 60
MOUNT_MATCH = 0.6
MOUNT_RING = 0.01
MOUNT_RING_MATCH = 0.7
MOUNT_MIN = 0.01


def _dark_line_within(arr, rect, side, start, count):
    """True when one of the `count` lines from `start` is a dark outline (the painting's edge)."""
    span = _span(rect, side)
    for offset in range(start, min(span, start + count)):
        line = _line(arr, rect, side, offset)
        if np.median(line.max(axis=1)) <= 90:
            return True
    return False


def mount_rect(arr):
    """Peels a coloured mount board (or a screenshot's dark surround) off each side: lines that
    are mostly the side's outer colour (or near white). None if no side has a consistent mount."""
    h, w = arr.shape[:2]
    rect = (0, 0, w, h)
    peeled = 0
    outlined = 0
    colors = []
    for side in ("top", "bottom", "left", "right"):
        full = h if side in ("top", "bottom") else w
        ring = max(2, int(full * MOUNT_RING))
        lines = np.concatenate([_line(arr, rect, side, i) for i in range(ring)]).astype(np.int16)
        color = np.median(lines, axis=0)
        if (np.abs(lines - color).max(axis=1) <= MOUNT_TOL).mean() < MOUNT_RING_MATCH:
            continue
        depth = 0
        limit = int(full * MAX_PEEL)
        while depth < limit:
            line = _line(arr, rect, side, depth).astype(np.int16)
            near = np.abs(line - color).max(axis=1) <= MOUNT_TOL
            light = (line.min(axis=1) >= 200) & (line.max(axis=1) - line.min(axis=1) <= 40)
            if (near | light).mean() < MOUNT_MATCH:
                break
            depth += 1
        if depth < full * MOUNT_MIN:
            continue
        outlined += _dark_line_within(arr, rect, side, depth, max(3, int(full * MOUNT_RING)))
        rect = _shrink(rect, side, depth)
        colors.append(color)
        peeled += 1
    if peeled < 3:
        return None
    colors = np.array(colors)
    spread = np.ptp(colors, axis=0).max()
    board = peeled == 4 and spread <= 40 and (colors.max(axis=1) - colors.min(axis=1)).min() >= 70
    if not (board or (outlined >= 3 and spread <= MOUNT_TOL * 1.5)):
        return None
    x0, y0, x1, y1 = rect
    if x1 - x0 < w * MIN_KEEP or y1 - y0 < h * MIN_KEEP:
        return None
    return rect


def find_rect(arr):
    """Returns (rect, method) on `arr`: trimmed margins, the inside of a frame/mount, or the full image."""
    h, w = arr.shape[:2]
    rect, peeled = trim_rect(arr)
    x0, y0, x1, y1 = rect
    margin = max(x0, y0, w - x1, h - y1)
    if peeled and margin >= min(h, w) * 0.01:
        return rect, "trim"
    inner = inner_band_rect(arr, "light")
    if inner:
        return inner, "frame-mat"
    inner = mount_rect(arr)
    if inner:
        return inner, "mount"
    inner = inner_band_rect(arr, "dark")
    if inner:
        return inner, "mount-outline"
    return rect, "trim" if peeled else "full"
