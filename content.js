/* Odyssey — configuration only.
   No chapter content lives here. Every chapter's objectives, study notes, recap and
   quiz are loaded at runtime from content/<subjectId>/ch<N>.json. */

const WORKER_URL = 'https://odyssey-progress-api.sarah-s-odyssey.workers.dev';

/* The five seas of CIPM Intermediate I, mapped to their Odyssey locations.
   x/y are percentage positions of the marker on assets/map.png. */
const SUBJECTS = [
  { id: 'ba',    roman: 'I',   name: 'Business Administration & Practices',            myth: 'Lotus-eaters’ shore',   port: 'LOTUS SHORE',       title: 'Lotus Shore',       short: 'LOTUS',     chapters: 15, x: 17, y: 14 },
  { id: 'comm',  roman: 'II',  name: 'Communication Process, Management & Development', myth: 'Isle of Aeolus',        port: 'TOWER OF WINDS',    title: 'Tower of Winds',    short: 'WINDS',     chapters: 15, x: 57, y: 16 },
  { id: 'stats', roman: 'III', name: 'Business Statistics & Social Research Methods',   myth: 'Land of the dead',      port: 'ISLE OF SHADES',    title: 'Isle of Shades',    short: 'SHADES',    chapters: 15, x: 25, y: 38 },
  { id: 'econs', roman: 'IV',  name: 'Fundamentals of Economics',                       myth: 'Scylla and Charybdis',  port: 'SPIRE & MAELSTROM', title: 'Spire & Maelstrom', short: 'MAELSTROM', chapters: 19, x: 46, y: 52 },
  { id: 'fin',   roman: 'V',   name: 'Finance for HR Managers',                         myth: 'Cattle of the sun god', port: 'SUN PASTURES',      title: 'Sun Pastures',      short: 'PASTURES',  chapters: 19, x: 39, y: 73 }
];

const ITHACA = { id: 'ithaca', roman: '✦', name: 'Exam day', port: 'ITHACA', title: 'Ithaca', short: 'ITHACA', x: 78, y: 80, goal: true };

const PASS_MARK = 70;   // % required in a trial to clear a chapter
const CHAPTER_XP = 40;  // XP awarded for clearing a chapter
const CARD_XP = 5;      // XP per flashcard rated

const BADGES = [
  { icon: '⚑', name: 'FIRST SAIL', test: s => s.clearedCount >= 1 },
  { icon: '✦', name: '7 DAY',      test: s => s.streak >= 7 },
  { icon: '≡', name: 'SCHOLAR',    test: s => s.cardsReviewed >= 25 },
  { icon: '◈', name: 'LAW I',      test: s => s.clearedCount >= 5 },
  { icon: '≈', name: 'SEA II',     test: s => s.subjectsCleared >= 1 },
  { icon: '⌂', name: 'ITHACA',     test: s => s.subjectsCleared >= 5 },
  { icon: '★', name: 'PERFECT',    test: s => s.perfectTrial },
  { icon: '⚿', name: 'ALL KEYS',   test: s => s.clearedCount >= 83 }
];

/* XP required to reach each level. */
const LEVELS = [0, 200, 450, 750, 1100, 1500, 1950, 2500, 3100, 3750, 4450, 5200, 6000, 6850, 7750];

const EXAM_DATE = '2026-11-12';
