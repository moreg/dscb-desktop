# -*- coding: utf-8 -*-
"""Scrub 追踪/伏笔.md chapter cells to format_checker + parseChapterNum compliant form.

Volume map for 民国老六: 卷N 第M章 (卷内) -> 全局章号 (N-1)*30 + M
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

ROOT = Path(r"O:\book") / "民国老六，我靠算命搅乱世"
PATH = ROOT / "追踪" / "伏笔.md"


def chapter_cell_ok(t: str) -> bool:
    t = str(t or "").strip()
    if not t:
        return True
    if re.fullmatch(r"(未回收|未定|未埋设|续篇|待定|—|－|-)", t):
        return True
    if re.match(r"^第\s*\d+(?:\s*/\s*\d+)?\s*章", t):
        return True
    if re.match(r"^第\s*\d+", t) and "章" in t:
        return True
    return False


def vol_range(vol: int) -> tuple[int, int]:
    """全局章号范围：每卷 30 章。卷1=1-30, 卷2=31-60, …"""
    return (vol - 1) * 30 + 1, vol * 30


def resolve_vol_chapter(vol: int, ch: int) -> int:
    """解析「卷V第C章」。

    - 若 C 已落在卷 V 的全局范围内 → 视作全局章号（如 卷2第31章 → 31）
    - 若 C 在 1..30 且不在该卷全局范围 → 视作卷内序号（如 卷2第22章 → 52）
    - 其它 → 按全局章号保留
    """
    lo, hi = vol_range(vol)
    if lo <= ch <= hi:
        return ch
    if 1 <= ch <= 30:
        return (vol - 1) * 30 + ch
    return ch


def normalize_cell(val: str) -> tuple[str, bool, str]:
    t = str(val or "").strip()
    if chapter_cell_ok(t):
        return t, False, ""
    orig = t

    # 跨卷母题：卷1/卷2（…）
    if re.fullmatch(r"卷\s*\d+\s*[/、]\s*卷\s*\d+.*", t):
        return "续篇", True, "cross-vol-theme"

    # 卷N开端/收尾（无章号）
    m = re.fullmatch(r"卷\s*(\d+)\s*(开端|开始|收尾|收束|阶段)?(.*)", t)
    if m and "第" not in t:
        vol = int(m.group(1))
        kind = m.group(2) or ""
        lo, hi = vol_range(vol)
        if kind in ("开端", "开始") or not kind:
            return f"第 {lo} 章", True, "vol-start"
        if kind in ("收尾", "收束"):
            return f"第 {hi} 章", True, "vol-end"
        return "续篇", True, "vol-prose"

    def repl_vol_ch(mo: re.Match) -> str:
        vol = int(mo.group(1))
        a = resolve_vol_chapter(vol, int(mo.group(2)))
        b = mo.group(3)
        if b:
            bb = resolve_vol_chapter(vol, int(b))
            if a == bb:
                return f"第 {a} 章"
            lo, hi = (a, bb) if a <= bb else (bb, a)
            return f"第 {lo}/{hi} 章"
        return f"第 {a} 章"

    # 卷X第Y章 / 卷X第Y-Z章 / 卷X第Y/Z章
    t2 = re.sub(
        r"卷\s*(\d+)\s*第\s*(\d+)(?:\s*[-~—至到/]\s*(\d+))?\s*章",
        repl_vol_ch,
        t,
    )

    # 卷X第Y-Z 无「章」
    t2 = re.sub(
        r"卷\s*(\d+)\s*第\s*(\d+)(?:\s*[-~—至到/]\s*(\d+))?(?!\s*章)",
        repl_vol_ch,
        t2,
    )

    if not chapter_cell_ok(t2):
        m2 = re.search(r"第\s*(\d+)(?:\s*/\s*(\d+))?\s*章", t2)
        if m2:
            nums = [int(x) for x in re.findall(r"第\s*(\d+)", t2)]
            if len(nums) >= 2:
                core = f"第 {nums[0]}/{nums[-1]} 章"
            elif m2.group(2):
                core = f"第 {int(m2.group(1))}/{int(m2.group(2))} 章"
            else:
                core = f"第 {int(m2.group(1))} 章"
            notes = re.findall(r"[（(]([^）)]+)[）)]", orig)
            if notes:
                note_s = "；".join(notes[:2])
                if len(note_s) > 40:
                    note_s = note_s[:40]
                t2 = f"{core}（{note_s}）"
            else:
                t2 = core
        else:
            if re.search(r"续|主线|长期|跨卷", orig):
                t2 = "续篇"
            else:
                t2 = "待定"

    if chapter_cell_ok(t2):
        return t2, t2 != orig, "normalized"
    return "待定", True, "fallback"


def parse_header(cells: list[str]) -> dict[str, int] | None:
    if not any("埋设" in c for c in cells):
        return None
    if not any(("预计" in c) or ("实际" in c) for c in cells):
        return None
    m: dict[str, int] = {}
    for idx, c in enumerate(cells):
        if c in ("伏笔编号", "编号"):
            m["id"] = idx
        elif "原编号" in c:
            m["oid"] = idx
        elif "内容" in c:
            m["content"] = idx
        elif "类型" in c:
            m["type"] = idx
        elif "埋设" in c:
            m["plant"] = idx
        elif "预计" in c:
            m["exp"] = idx
        elif "实际" in c:
            m["act"] = idx
        elif "状态" in c:
            m["st"] = idx
    if "id" not in m:
        m["id"] = 0
    if "plant" not in m:
        return None
    return m


def main() -> None:
    text = PATH.read_text(encoding="utf-8")
    lines = text.splitlines()
    current: dict[str, int] | None = None
    changes: list[tuple] = []
    new_lines: list[str] = []
    reason_c: Counter[str] = Counter()

    for i, line in enumerate(lines, 1):
        s = line.strip()
        if not s.startswith("|"):
            new_lines.append(line)
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        header = parse_header(cells)
        if header is not None and any(
            x in "".join(cells) for x in ("埋设章节", "埋设", "预计回收")
        ):
            # only treat as header if looks like header row
            if any("埋设" in c for c in cells) and any(
                "章节" in c or "回收" in c or "预计" in c for c in cells
            ):
                # exclude data rows that happen to mention these words in content
                if cells[0] in ("伏笔编号", "编号") or "编号" in cells[0]:
                    current = header
                    new_lines.append(line)
                    continue

        if re.match(r"^[\s|:\-]+$", s):
            new_lines.append(line)
            continue
        if current is None:
            new_lines.append(line)
            continue
        if len(cells) < max(current.values()) + 1:
            new_lines.append(line)
            continue
        fid = cells[current.get("id", 0)]
        if not re.match(r"^FB-", fid):
            new_lines.append(line)
            continue

        changed_any = False
        for key in ("plant", "exp", "act"):
            if key not in current:
                continue
            idx = current[key]
            if idx >= len(cells):
                continue
            newv, ch, reason = normalize_cell(cells[idx])
            if ch:
                changes.append((i, fid, key, cells[idx], newv, reason))
                reason_c[reason] += 1
                cells[idx] = newv
                changed_any = True
        if changed_any:
            new_lines.append("| " + " | ".join(cells) + " |")
        else:
            new_lines.append(line)

    print("changes", len(changes))
    print("reasons", dict(reason_c))
    print("--- sample ---")
    for c in changes[:50]:
        print(f"L{c[0]} {c[1]} {c[2]}: {c[3]!r} -> {c[4]!r} ({c[5]})")

    # verify
    bad_left: list[tuple] = []
    current = None
    for i, line in enumerate(new_lines, 1):
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if cells and (cells[0] in ("伏笔编号", "编号") or "编号" in cells[0]):
            header = parse_header(cells)
            if header:
                current = header
            continue
        if current is None:
            continue
        if len(cells) < max(current.values()) + 1:
            continue
        fid = cells[current.get("id", 0)]
        if not re.match(r"^FB-", fid):
            continue
        for key in ("plant", "exp", "act"):
            if key not in current:
                continue
            val = cells[current[key]]
            if not chapter_cell_ok(val):
                bad_left.append((i, fid, key, val))

    print("BAD LEFT", len(bad_left))
    for b in bad_left[:40]:
        print(b)

    backup = PATH.with_suffix(".md.bak-scrub")
    if not backup.exists():
        backup.write_text(text, encoding="utf-8")
        print("backup", backup)
    PATH.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    print("WROTE", PATH, "bad_left=", len(bad_left))


if __name__ == "__main__":
    main()
