#!/usr/bin/env python3
"""Validate every chapter file under content/ against the schema the app expects,
(optional per-question `why`, optional per-chapter `cards`) and write a per-sea index.json (chapter titles) that the region page can load
instead of fetching every chapter just to learn its name.

    python3 scripts/validate-content.py            # validate + write manifests
    python3 scripts/validate-content.py --no-write # validate only (CI)

Exit code 1 on any error. Warnings are printed but never fail the run.
"""
import json, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "content")
WRITE = "--no-write" not in sys.argv

REQUIRED = ["subject", "subjectName", "chapter", "title", "objectives", "study", "recap", "quiz"]
EXPECTED_QUESTIONS = 20


def subject_counts():
    """Chapter counts per subject id, read straight from content.js so the two
    can't drift apart."""
    src = open(os.path.join(ROOT, "content.js"), encoding="utf-8").read()
    found = dict(re.findall(r"id:\s*'([a-z]+)'.*?chapters:\s*(\d+)", src))
    if not found:
        sys.exit("could not read SUBJECTS from content.js")
    return {k: int(v) for k, v in found.items()}


def check_chapter(path, sid, n, counts):
    errors, warnings = [], []
    try:
        d = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        return None, [f"invalid JSON — {e}"], []

    for k in REQUIRED:
        if k not in d:
            errors.append(f"missing key '{k}'")
    if errors:
        return d, errors, warnings

    if d["subject"] != sid:
        errors.append(f"subject is '{d['subject']}' but file lives in content/{sid}/")
    if d["chapter"] != n:
        errors.append(f"chapter is {d['chapter']} but filename says {n}")
    if n < 1 or n > counts.get(sid, 0):
        errors.append(f"chapter {n} is outside {sid}'s range 1–{counts.get(sid, '?')}")
    if not isinstance(d["title"], str) or not d["title"].strip():
        errors.append("title is empty")
    if not isinstance(d["objectives"], list) or not all(isinstance(o, str) and o.strip() for o in d["objectives"]):
        errors.append("objectives must be a non-empty list of strings")
    elif not d["objectives"]:
        warnings.append("no objectives")
    for f in ("study", "recap"):
        if not isinstance(d[f], str) or len(d[f].strip()) < 20:
            errors.append(f"{f} is missing or implausibly short")

    quiz = d["quiz"]
    if not isinstance(quiz, list) or not quiz:
        errors.append("quiz must be a non-empty list")
    else:
        for i, q in enumerate(quiz):
            tag = f"quiz[{i}]"
            if not isinstance(q, dict):
                errors.append(f"{tag} is not an object"); continue
            if not isinstance(q.get("q"), str) or not q["q"].strip():
                errors.append(f"{tag}.q is empty")
            opts = q.get("opts")
            if not isinstance(opts, list) or len(opts) < 2 or not all(isinstance(o, str) and o.strip() for o in opts):
                errors.append(f"{tag}.opts must be a list of at least 2 non-empty strings")
            elif len(set(opts)) != len(opts):
                warnings.append(f"{tag} has duplicate options")
            c = q.get("correct")
            if not isinstance(c, int) or isinstance(c, bool) or not (isinstance(opts, list) and 0 <= c < len(opts)):
                errors.append(f"{tag}.correct must be an integer index into opts")
            if "why" in q and (not isinstance(q["why"], str) or not q["why"].strip()):
                errors.append(f"{tag}.why must be a non-empty string when present")
        if len(quiz) != EXPECTED_QUESTIONS:
            warnings.append(f"{len(quiz)} questions (others have {EXPECTED_QUESTIONS})")

    cards = d.get("cards")
    if cards is not None:
        if not isinstance(cards, list) or not cards:
            errors.append("cards must be a non-empty list when present")
        else:
            for i, c in enumerate(cards):
                if not isinstance(c, dict) or not isinstance(c.get("front"), str) or not c["front"].strip() \
                        or not isinstance(c.get("back"), str) or not c["back"].strip():
                    errors.append(f"cards[{i}] needs non-empty string 'front' and 'back'")

    return d, errors, warnings


def check_bank(path, sid):
    errors = []
    try:
        d = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        return 0, [f"invalid JSON — {e}"]
    if d.get("subject") != sid:
        errors.append(f"subject is '{d.get('subject')}' but file lives in content/{sid}/")
    qs = d.get("questions")
    if not isinstance(qs, list) or not qs:
        return 0, errors + ["questions must be a non-empty list"]
    for i, q in enumerate(qs):
        tag = f"questions[{i}]"
        if not isinstance(q, dict):
            errors.append(f"{tag} is not an object"); continue
        if not isinstance(q.get("q"), str) or not q["q"].strip():
            errors.append(f"{tag}.q is empty")
        opts = q.get("opts")
        if not isinstance(opts, list) or len(opts) < 2 or not all(isinstance(o, str) and o.strip() for o in opts):
            errors.append(f"{tag}.opts must be a list of at least 2 non-empty strings")
        c = q.get("correct")
        if not isinstance(c, int) or isinstance(c, bool) or not (isinstance(opts, list) and 0 <= c < len(opts)):
            errors.append(f"{tag}.correct must be an integer index into opts")
        if "why" in q and (not isinstance(q["why"], str) or not q["why"].strip()):
            errors.append(f"{tag}.why must be a non-empty string when present")
    return len(qs), errors


def main():
    counts = subject_counts()
    total_err = total_warn = total_files = 0
    manifests = {}
    banks = {}
    chapter_files = 0
    no_why = []
    no_cards = []

    for sid in sorted(counts):
        folder = os.path.join(CONTENT, sid)
        files = sorted(glob.glob(os.path.join(folder, "ch*.json")),
                       key=lambda f: int(re.search(r"ch(\d+)\.json$", f).group(1)))
        chapters = []
        for path in files:
            n = int(re.search(r"ch(\d+)\.json$", path).group(1))
            d, errors, warnings = check_chapter(path, sid, n, counts)
            total_files += 1
            chapter_files += 1
            rel = os.path.relpath(path, ROOT)
            for e in errors:
                print(f"ERROR   {rel}: {e}"); total_err += 1
            for w in warnings:
                print(f"warning {rel}: {w}"); total_warn += 1
            if d and not errors:
                chapters.append({"n": n, "title": d["title"], "questions": len(d["quiz"])})
                if not any("why" in q for q in d["quiz"]):
                    no_why.append(f"{sid}/ch{n}")
                if "cards" not in d:
                    no_cards.append(f"{sid}/ch{n}")
        manifests[sid] = chapters

        bank_path = os.path.join(folder, "bank.json")
        bank_count = 0
        if os.path.exists(bank_path):
            bank_count, berrs = check_bank(bank_path, sid)
            total_files += 1
            for e in berrs:
                print(f"ERROR   content/{sid}/bank.json: {e}"); total_err += 1
            if berrs: bank_count = 0
        banks[sid] = bank_count

        # stray files that aren't chNN.json
        for path in glob.glob(os.path.join(folder, "*")):
            base = os.path.basename(path)
            if base in ("index.json", "bank.json", ".DS_Store") or re.fullmatch(r"ch\d+\.json", base):
                continue
            print(f"warning content/{sid}/{base}: unexpected file, ignored by the app"); total_warn += 1

    if WRITE:
        for sid, chapters in manifests.items():
            folder = os.path.join(CONTENT, sid)
            os.makedirs(folder, exist_ok=True)
            out = os.path.join(folder, "index.json")
            data = {"subject": sid, "chapters": chapters, "bank": banks.get(sid, 0)}
            existing = None
            if os.path.exists(out):
                try: existing = json.load(open(out, encoding="utf-8"))
                except Exception: pass
            if existing != data:
                json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
                open(out, "a", encoding="utf-8").write("\n")
                print(f"wrote   content/{sid}/index.json ({len(chapters)} chapters)")

    if no_why:
        print(f"note    {len(no_why)} of {chapter_files} chapters have no 'why' explanations — "
              f"the verdict box corrects but cannot explain (optional per-question field)")
    if no_cards:
        print(f"note    {len(no_cards)} of {chapter_files} chapters have no authored 'cards' — "
              f"Athena's Counsel falls back to their trial questions (optional per-chapter field)")
    done = {sid: len(ch) for sid, ch in manifests.items()}
    summary = " · ".join(f"{sid} {done[sid]}/{counts[sid]}" + (f"+{banks[sid]}b" if banks.get(sid) else "") for sid in sorted(counts))
    print(f"\n{total_files} files · {total_err} errors · {total_warn} warnings · {summary}")
    sys.exit(1 if total_err else 0)


if __name__ == "__main__":
    main()
