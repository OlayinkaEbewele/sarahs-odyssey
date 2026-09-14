# Odyssey — CIPM Intermediate I

A gamified study app for the CIPM (Chartered Institute of Personnel Management of Nigeria)
Intermediate I exam, themed as a voyage home to Ithaca.

## Run

```bash
python3 -m http.server 4321
```

Open <http://localhost:4321>. A server is required — `fetch()` of local JSON is blocked
under `file://`, and `localStorage` is too.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Shell: top bar, view container, bottom nav, toast |
| `styles.css` | Design tokens and every component; mobile-first, 900px desktop breakpoint |
| `content.js` | **Config only** — subjects, chapter counts, XP/pass constants, relics, level table |
| `app.js` | State, sync, content loader, routing, rendering, trial and card engines |
| `content/<id>/ch<N>.json` | Chapter content, loaded at runtime |
| `worker.js`, `wrangler.toml` | Cloudflare Worker + KV backend (deployed) |
| `assets/ambient.m4a`, `.mp3` | Ambient score, loaded only when music is on |

## The five seas

| Id | Subject | Odyssey location | Chapters |
| --- | --- | --- | --- |
| `ba` | Business Administration & Practices | Lotus-eaters' shore | 15 |
| `comm` | Communication Process, Management & Development | Isle of Aeolus | 15 |
| `stats` | Business Statistics & Social Research Methods | Land of the dead | 15 |
| `econs` | Fundamentals of Economics | Scylla and Charybdis | 19 |
| `fin` | Finance for HR Managers | Cattle of the sun god | 19 |

83 chapters total. Ithaca is the exam itself.

## Adding chapter content

Drop a file at `content/<subjectId>/ch<N>.json`. Nothing else needs touching — no code
change, no rebuild, no restart. Refresh the page and the chapter is live.

```json
{
  "subject": "ba",
  "subjectName": "Business Administration & Practices",
  "chapter": 1,
  "title": "Nature of Business",
  "objectives": ["...", "..."],
  "study": "<p>HTML string</p>",
  "recap": "<ul><li>HTML string</li></ul>",
  "quiz": [{ "q": "...", "opts": ["...", "..."], "correct": 1, "why": "optional" }],
  "cards": [{ "front": "optional recall prompt", "back": "the answer" }]
}
```

`correct` is a 0-based index into `opts`. `why` is optional — when present, the verdict
box after each answer *explains* rather than just correcting, and it's repeated in the
end-of-trial review. `cards` is optional too — proper recall prompts for Athena's Counsel.
Without them the deck falls back to the chapter's quiz questions, which work but are weaker
cards (a multiple-choice stem isn't a recall cue). The validator notes which chapters lack
either. Inside `study` and `recap` you can use
`<p>`, `<ul>`/`<ol>`, `<b>`, `<table>`, plus two styled boxes:

```html
<div class="callout"><b>Key term</b>Definition text.</div>
<div class="callout tip"><b>Exam tip</b>Advice text.</div>
```

A chapter with no file shows the "island hasn't been charted yet" placeholder. Its region
card reads "Uncharted". Everything else in the voyage keeps working.

## Validating content

```bash
python3 scripts/validate-content.py
```

Checks every `content/*/ch*.json` against the schema — required keys, `subject` and
`chapter` matching the file's location, option lists, `correct` in range, `why` a string
when present — and exits non-zero on any error. It also writes `content/<sea>/index.json`,
a small manifest of chapter titles that the region page loads instead of fetching every
chapter file. **Run it before you commit new chapters** and commit the manifest with them.

The same script runs in GitHub Actions on every push that touches `content/`; a broken
file or a stale manifest fails the check. (Vercel deploys regardless — the check is a
signal, not a gate.)

## How content loads

`loadChapter(subjectId, n)` fetches `content/<subjectId>/ch<N>.json`, caches the result in
an in-memory `Map` for the session, and returns `null` on a 404, a network failure, or a
malformed file — which drives the placeholder. Nothing is fetched twice.

Chapter titles are cached into saved state as they're seen, so region grids render
instantly without refetching. Locked chapters aren't fetched at all.

## Sign-in and sync

On first load the app asks for an email. There is **no password** — anyone who enters a
given address sees the progress stored under it. This is a deliberate tradeoff for study
progress; don't put anything sensitive in it.

- The email is remembered in `localStorage` (`odyssey.email`), so it's asked once per browser.
- On sign-in, progress is pulled from the Worker. Existing data resumes the voyage; no data
  starts a fresh one at Chapter 1 of Sea I.
- Every mutation saves to `localStorage` immediately and pushes to the Worker on a 1.2s
  debounce — so a completed trial is persisted both places.
- If the backend is unreachable the app carries on local-only and says so in Ship's Log.
- "Switch navigator" in Ship's Log signs out and clears local state.

Backend: `https://odyssey-progress-api.sarah-s-odyssey.workers.dev`, KV namespace
`87d0a9dd26cc49de97261d41493d6f7a`. Redeploy with `npx wrangler deploy`.

### Endpoints

| Route | Purpose |
| --- | --- |
| `GET /progress?email=` | Read one navigator's saved state (`null` if none) |
| `POST /progress?email=` | Write it (JSON body, 200KB cap) |
| `GET /crew?email=` | The roster — every navigator, ranked by XP |

`/crew` returns **display names only** (the part of the address before the `@`), never full
email addresses. The caller's own row is flagged `you: true`. Like everything else here it
is unauthenticated, so treat the roster as public.

## Screens

- **Map** — the five seas plus Ithaca, with the ship at the current sea
- **Region** — a sea's chapters as islands, locked in sequence
- **Island** — the four-stage chapter: Study → Recap → Trial → Victory
- **Athena's Counsel** — flashcard review (tab reads `COUNSEL` to fit the pixel font;
  `#/counsel` is the route, `#/cards` still works as an alias)
- **Ship's Log** — level, XP, streak, per-sea progress, relics, sync panel
- **Crew** — every navigator as a character, ranked by XP
- **Ithaca** — the mock exam (see below)

## Design system

All values come from tokens in `:root` — no raw hex, px sizes or alpha values in component
rules. If you need a new size or shade, add a token rather than a literal.

| Group | Tokens |
| --- | --- |
| Pixel font (UI chrome) | `--px-xs` 8px · `--px-sm` 9px · `--px-md` 11px · `--px-lg` 14px |
| Reading (IBM Plex) | `--t-xs` 13px · `--t-sm` 14px · `--t-md` 15px · `--t-lg` 17px |
| Muted ink | `--ink-80` · `--ink-65` · `--ink-45` |
| Muted parchment | `--parch-72` · `--parch-dim` |
| Radii | `--r-pip` 3 · `--r-xs` 5 · `--r-sm` 8 · `--r-md` 10 · `--r-lg` 14 |
| Motion | `--dur-fast` · `--dur` · `--dur-slow` · `--step` |

**8px is the floor for the pixel font.** Press Start 2P below that is unreadable; the
6px and 7px uses that existed before were all raised. Per the project brief, the pixel
font is for short UI labels only — never paragraphs.

Text utilities (`.txt`, `.txt--ink`, `.txt--parch`, `.txt--dim`, `.pixnum`, `.rowbetween`,
`.vstack`) exist so markup doesn't carry repeated inline font/colour declarations.

## Motion

Entrance animations are keyed to the **view key** — route, plus chapter stage, plus whether
async content has landed. So a screen animates when you arrive and again when its content
finishes loading, but *not* when it re-renders in place (answering a question, flipping a
card). That distinction is the whole trick; if you add a screen, extend `viewKey()`.

What moves: views fade up on arrival; island, crew, relic and ledger tiles stagger in; map
markers pop in along the route; progress bars fill left to right; the flashcard turns on its
Y axis; a correct answer pulses and a wrong one shakes.

**Clearing a chapter** stamps a medal in with a confetti burst, reveals the heading, tally
and button in sequence, and ticks the XP up from zero. The medal is tiered — gold at 85%+,
bronze at 70–84%, clay below the pass mark — and 100% adds a "perfect voyage" ribbon. The
celebration fires only on a genuine first clear, not when revisiting a cleared chapter.
Crossing a level threshold raises a gold toast.

Everything above is disabled under `prefers-reduced-motion: reduce`.

## The trial

- **Options are shuffled every attempt**, and **question order is shuffled on retakes**,
  so a second run tests the material rather than the memory of "C, then A". The
  permutation is stored in saved state, so a reload mid-trial keeps the same order.
  Answers are recorded as the *original* option index — scoring never depends on how
  things were displayed.
- A right answer earns one of sixteen affirmations (chosen per question, so no two in a
  row repeat); a wrong one is corrected. With an authored `why`, both are followed by the
  explanation.
- The victory screen ends with **What you missed** — every wrong answer with the question,
  what you chose, the true answer and the `why` if there is one. A perfect run has no
  review section.

## Redoing a chapter

A cleared chapter can be sailed again as often as you like. Nothing is ever lost by trying.

- **SAIL IT AGAIN** on the victory screen resets to Study with a clean trial waiting, so you
  can re-read then re-test.
- The **stage rail** jumps straight to any stage. Landing on Trial for an already-cleared
  chapter starts a fresh attempt rather than dropping you on the last question with every
  answer already filled in.
- **The best run is the one that counts.** A retake updates the recorded score only when it
  beats the previous best. A worse run — even a failing one — leaves the chapter cleared,
  the next chapter unlocked and the score untouched.
- **XP is earned once.** Retakes never award it again, so the voyage can't be farmed. They
  do count toward your streak, since you did sit down and study.
- `attempts` is tracked per chapter and shown on the victory tally.

The victory screen reads the situation: a first clear celebrates, a new best says so, a
repeat run shows **this run / best / attempts**, and a failed retake says plainly that the
chapter still stands cleared. Confetti fires only for a first clear or a new personal best.

## Background music

An ambient score plays while you sail, toggled by the **♪** control in the top bar.

- **Default is on**, but nothing plays until you interact — browsers block autoplay without
  a gesture, so playback is armed on the first click or keypress (and starts immediately on
  sign-in, which is itself a gesture). It fades in rather than cutting in, at 34% volume.
- **The preference is per-device**, stored in `localStorage` under `odyssey.music`. It is
  deliberately *not* synced to the cloud — how loud your room is isn't voyage progress.
- **Off costs nothing.** The `<audio>` element is `preload="none"`, so with music off the
  file is never fetched. Verified: after a reload with the preference off, `readyState 0`
  and `networkState 1` — zero bytes transferred.

Two encodings ship, and the browser picks one:

| File | Size | Notes |
| --- | --- | --- |
| `assets/ambient.m4a` | 1.04 MB | AAC 93 kbps — what virtually every browser loads |
| `assets/ambient.mp3` | 2.80 MB | MP3 256 kbps fallback, source file |

The source was 256 kbps MP3; re-encoding to AAC cut the transfer by ~62% with no audible
loss for an ambient bed. The loop is 91.7s and seams on repeat — unavoidable without a
crossfade layer.

## Ithaca — the exam papers

Click Ithaca on the map. There are **five papers, one per sea**, in the real CIPM shape:
**50 questions, 2 marks each, out of 100.** `PASS_MARK` (70%) is a pass.

- A paper draws from **every charted chapter of its sea — cleared or not** — so it can be
  sat as soon as the sea has content. Every chapter gets at least one question; the rest
  are shared out in proportion to chapter size. It's reshuffled every sitting (questions
  and options).
- `MOCK_MINUTES` (60) on the clock. This is **not yet confirmed** against the real paper.
- No feedback until the end. Answers can be changed and questions revisited until you
  submit; submitting with blanks asks you to confirm.
- **A reload resumes the paper** with the time you had left — the deadline is wall-clock,
  saved in state. Time running out submits automatically.
- Results: marks out of 100, a **per-chapter breakdown** (so you can see which chapters let
  you down), and the same "what you missed" review as a trial. `MOCK_XP_PER_CORRECT` (1) XP
  per right answer. Every paper is kept; Ship's Log shows the last six with their sea.

A paper whose sea has no chapters yet shows "not yet charted". The lobby reads
`content/<sea>/index.json` for chapter and question counts, so keep the manifests current
(`python3 scripts/validate-content.py`).

## Spaced repetition

Athena's Counsel schedules each card with a light SM-2. Rating **easy** grows the interval
by an ease factor that itself drifts with how the card has gone — roughly 4, 10, 26, 69
days on successive easies — so well-known cards get out of the way. **Hard** creeps
(1, 2, 3, 4 days) and dents the ease; **again** sends the card back to today and resets it.
The intervals shown under the three buttons are the real ones for that card.

## Ranks, relics, the log

Levels carry rank names (`RANKS` in `content.js`): Deckhand → Oarsman → Lookout → Helmsman →
Navigator → Quartermaster → First Mate → Captain → Admiral → Hero of Ithaca. Shown in Ship's
Log and on the Crew roster.

Twelve relics, earned by state rather than by event, so a navigator who cleared a sea before
a relic existed still gets it: one per sea named for its myth (Lotus Bloom, Bag of Winds,
Charon's Obol, Scylla's Tooth, Helios's Brand), streaks of 7 and 30 days, 50 cards reviewed,
a perfect trial, a passing paper, and Ithaca itself. New relics are dated, announced with a
toast, and hover shows how to earn each one.

**The Log** in Ship's Log is a dated timeline — chapters cleared, seas finished, relics found,
papers sat — derived entirely from saved state, so it fills in retroactively.

The map's "Next port" card nudges: cards due in Athena's Counsel, and a streak that ends
tonight if nothing is studied.

## Sound

Alongside the ambient score, short synthesised 8-bit effects: a rising blip on a right
answer, a low buzz on a wrong one, a fanfare on clearing a chapter or passing a paper, a
sparkle on a relic, a tick on a card flip. Generated with WebAudio — no files. They follow
the same **♪** toggle as the music, so muting one mutes both.

## Mechanics

Strictly sequential. A chapter unlocks when the one before it is cleared; a sea unlocks
when the one before it is finished. A trial needs **70%** to clear a chapter, which awards
**40 XP** and adds that chapter's questions to Athena's Counsel. Cards are rated
again/hard/easy on 0/2/6-day intervals and give 5 XP each. Levels come from the `LEVELS`
table in `content.js`.

## Known gaps

- **Crew sprites are placeholders** — a deterministic colour tile with the navigator's
  initial. Swap `crewCard()` in `app.js` to render real character art when it exists.
- **The exam clock (60 minutes) is a placeholder** until the real paper's duration is
  confirmed. Question count and marks are correct.
- **Reduced-motion is implemented but not runtime-verified** — the media block is in place
  and parses, but I had no way to emulate the setting in the preview browser.
- **Flashcards are derived from quiz questions** (prompt = question, answer = correct
  option), since the chapter schema has no dedicated card list. If you'd rather author
  cards explicitly, add a `cards` array to the schema and the deck builder can read it.
- **Shape language** uses `border-radius`, not the notched `clip-path` corners the project
  brief specifies. Inherited from the design canvas; not yet reconciled.
- **Multi-level support** (Intermediate II) isn't designed. Content paths would need a
  level segment, e.g. `content/int1/ba/ch1.json`.
