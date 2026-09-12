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

/* Relics — found along the voyage. `test` receives the summary from badgeState(). */
const BADGES = [
  { icon: '⚑', name: 'FIRST SAIL',     test: s => s.clearedCount >= 1,        hint: 'Clear your first chapter' },
  { icon: '✦', name: '7 DAY',          test: s => s.streak >= 7,              hint: 'Study seven days running' },
  { icon: '☀', name: '30 DAY',         test: s => s.streak >= 30,             hint: 'Study thirty days running' },
  { icon: '≡', name: 'SCHOLAR',        test: s => s.cardsReviewed >= 50,      hint: 'Review fifty cards in Athena’s Counsel' },
  { icon: '★', name: 'PERFECT',        test: s => s.perfectTrial,             hint: 'Score 100% in a trial' },
  { icon: '❀', name: 'LOTUS BLOOM',    test: s => s.seasDone.ba,              hint: 'Clear every chapter of Lotus Shore' },
  { icon: '≈', name: 'BAG OF WINDS',   test: s => s.seasDone.comm,            hint: 'Clear every chapter of the Tower of Winds' },
  { icon: '◎', name: 'CHARON’S OBOL',  test: s => s.seasDone.stats,           hint: 'Clear every chapter of the Isle of Shades' },
  { icon: '◈', name: 'SCYLLA’S TOOTH', test: s => s.seasDone.econs,           hint: 'Clear every chapter of Spire & Maelstrom' },
  { icon: '☉', name: 'HELIOS’S BRAND', test: s => s.seasDone.fin,             hint: 'Clear every chapter of Sun Pastures' },
  { icon: '⚓', name: 'SEA TRIAL',      test: s => s.bestMock >= 70,           hint: 'Score 70% or better in a mock exam' },
  { icon: '⌂', name: 'ITHACA',         test: s => s.clearedCount >= 83,       hint: 'Chart all 83 chapters' }
];

/* Rank names by level. The last entry holds for every level beyond the list. */
const RANKS = [
  'DECKHAND', 'OARSMAN', 'LOOKOUT', 'HELMSMAN', 'NAVIGATOR', 'QUARTERMASTER',
  'FIRST MATE', 'CAPTAIN', 'ADMIRAL', 'HERO OF ITHACA'
];

/* Mock exams at Ithaca. Change these once the real paper's format is known. */
const MOCK_QUESTIONS = 40;   // drawn across every chapter you have cleared
const MOCK_MINUTES = 60;
const MOCK_XP_PER_CORRECT = 1;

/* XP required to reach each level. */
const LEVELS = [0, 200, 450, 750, 1100, 1500, 1950, 2500, 3100, 3750, 4450, 5200, 6000, 6850, 7750];

const EXAM_DATE = '2026-11-12';
