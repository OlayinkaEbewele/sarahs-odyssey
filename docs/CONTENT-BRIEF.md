# Content brief — chapter files for Odyssey

This is the specification for producing chapter content. Hand it to whatever is doing the
extraction from the CIPM source material. Everything the app needs is in this document.

## What a sea needs

One JSON file per chapter at `content/<sea>/ch<N>.json`, where `N` is the chapter's
position in the syllabus (1-based). Chapter counts are fixed:

| Sea id | Subject | Chapters |
|---|---|---|
| `ba` | Business Administration & Practices | 15 |
| `comm` | Communication Process, Management & Development | 15 |
| `stats` | Business Statistics & Social Research Methods | 15 |
| `econs` | Fundamentals of Economics | 19 |
| `fin` | Finance for HR Managers | 19 |

The file for chapter 7 of Finance is `content/fin/ch7.json`. Nothing else has to change —
drop the file in, run the validator, commit, push, and it is live.

## The schema — exact

```json
{
  "subject": "fin",
  "subjectName": "Finance for HR Managers",
  "chapter": 7,
  "title": "Working Capital Management",
  "objectives": [
    "State the components of working capital.",
    "Distinguish gross from net working capital."
  ],
  "study": "<p>…</p><div class=\"callout\"><b>Key term</b>…</div><p>…</p>",
  "recap": "<ul><li>…</li><li>…</li></ul>",
  "quiz": [
    {
      "q": "The excess of current assets over current liabilities is called …… working capital.",
      "opts": ["gross", "net", "permanent", "temporary"],
      "correct": 1,
      "why": "Net working capital is current assets minus current liabilities; gross working capital is current assets alone."
    }
  ],
  "cards": [
    { "front": "Net working capital", "back": "Current assets minus current liabilities." }
  ]
}
```

- `subject` must match the folder; `chapter` must match the filename.
- `correct` is a 0-based index into `opts`.
- `why` and `cards` are optional but valuable — see below.
- `study` and `recap` are HTML strings. Allowed: `<p>`, `<ul>`/`<ol>`/`<li>`, `<b>`,
  `<table>`, and two styled boxes:
  `<div class="callout"><b>Key term</b>text</div>` and
  `<div class="callout tip"><b>Exam tip</b>text</div>`.

## Study text

- 400–800 words. Enough to teach the chapter, not a summary of a summary.
- **Every term the quiz asks about must appear in the study text.** A question about
  "agent by estoppel" is unfair if the notes never say the words.
- Preserve, do not paraphrase away:
  - **named theorists and what is attributed to them** (Fayol's five functions, Babbage on
    scientific method, Toynbee on the industrial revolution);
  - **acronyms with their expansions** (STEEPLED, SMART, MSME, CATWOE);
  - **classification lists in full** — every sector type, partner type, document type,
    cooperative type, ratio type. The exam asks "which of these is a …" and the answer is
    one member of a list the student must know completely;
  - **numeric thresholds and figures** (the ₦25m small-business ceiling, notice periods,
    percentages).
- One `Key term` callout per important definition. One `Exam tip` per chapter where
  there is a known examiner's favourite.

## Quiz — 20 questions, exam-grade

These rules come from comparing the app's existing questions to the September 2025
Business Administration paper. The exam is pure recall; what makes it hard is precise
terminology and plausible distractors. Match that.

1. **Exactly 20 questions**, four options each, one correct.
2. **Distractors are the neighbouring terms** — the other members of the same
   classification, the adjacent concept, the near-synonym. If the answer is *tertiary
   sector*, the distractors are *primary*, *secondary*, *quaternary* — not *sports*.
3. **Never write a distractor that can be eliminated without knowing the material.** No
   absolutist wording (*never*, *always*, *impossible*, *only*, *whatsoever*, *entirely*,
   *under any circumstances*), no absurdities, no jokes.
4. **Keep the four options the same length.** The correct answer must not be the longest
   option — in the current files it is the longest 63–72% of the time, which a student
   learns to exploit in a week. Where the exam would use one-word options, use one-word
   options.
5. **Mix stem styles to match the paper:** roughly half fill-in-the-blank
   ("… is known as …… ." / "…… ratio."), the rest direct questions. Include two or three
   "which of the following is NOT …" / "…, except ……" items per chapter.
6. **Balance the correct position** across A/B/C/D — roughly five each. The app shuffles
   options anyway, but a key that is 63% B (as the practice bank is) means the generator
   is writing the answer first and padding around it, and rule 4 usually follows.
7. Every question must be answerable from the study text of its own chapter.

## `why` — one or two sentences per question

Optional, but it is what turns a wrong answer into a lesson. State the rule, not just the
answer: not "the answer is B" but "written particulars are due within three months of
engagement under s.7 of the Labour Act". Shown after every answer and in the end-of-trial
review.

## `cards` — 8 to 12 per chapter

Optional. Proper recall prompts for spaced repetition: a term on the front, its definition
or the list it belongs to on the back. Without these the app falls back to using quiz
questions as cards, which are weaker prompts.

## Delivery

```bash
python3 scripts/validate-content.py     # checks every file, writes the manifests
git add content/ && git commit -m "Add <sea> chapters N–M" && git push
```

The validator exits non-zero on any schema error and warns on anything short of 20
questions. Commit the regenerated `content/<sea>/index.json` alongside the chapter files.
The site redeploys on push; the chapters are live in about a minute.

## What not to do

- Do not invent content the source material does not contain. If a chapter is thin, the
  file is thin.
- Do not renumber chapters or split one chapter across two files.
- Do not put exam questions that belong to no chapter into a chapter file — those go in
  `content/<sea>/bank.json` (see README).
