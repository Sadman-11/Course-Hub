// Canonical library layout, shared by the reorganiser, the sync engine,
// the Classroom importer and the Worker (upload suggestions + site ordering).
//
//   COURSE / INSTRUCTOR / Category / [Semester] / [sub-folders...] / file
//
// - COURSE      course code, upper-case, no spaces          e.g. CSE207
// - INSTRUCTOR  faculty initials, or "General" for course-wide material
// - Category    one of CATEGORIES (fixed vocabulary, fixed order)
// - Semester    optional, "<Season>-<YY>"                    e.g. Summer-26
//
// Pure functions only: no I/O, runs in Node and in Workers.

export const CATEGORIES = [
  'Course-Info', // outlines, office hours, rubrics, routines
  'Lectures',    // slides, notes, lecture PDFs
  'Labs',        // lab manuals, lab sheets, lab reports, simulation files
  'Assignments', // assignment briefs, cover pages, sample submissions
  'Questions',   // mid / final / CT / quiz / mock test papers
  'Practice',    // practice problems and problem sets
  'Projects',    // project lists, project code, reports
  'Books',       // textbooks and references
  'Code',        // example source code
];

export const GENERAL = 'General';

const SEASONS = { spring: 'Spring', summer: 'Summer', fall: 'Fall' };
const SEASON_ORDER = { Spring: 1, Summer: 2, Fall: 3 };

// Files whose names are referenced by other files (source code, PSpice
// projects, data inputs). These are moved but never renamed.
const NO_RENAME_EXT = new Set([
  'c', 'cpp', 'h', 'hpp', 'java', 'py', 'js', 'ts', 'cs', 'kt', 'ipynb',
  'cir', 'als', 'net', 'out', 'prb', 'mif', 'mvl', 'sch', 'lib', 'dat', '1op', 'opj', 'dsn', 'asc', 'asy', 'raw', 'log',
  'txt', 'csv', 'in',
]);
const CODE_EXT = new Set(['c', 'cpp', 'h', 'hpp', 'java', 'py', 'js', 'ts', 'cs', 'kt', 'ipynb']);
const SIM_EXT = new Set(['cir', 'als', 'net', 'out', 'prb', 'mif', 'mvl', 'sch', 'opj', 'dsn', 'asc', 'asy']);

/** "Fall-25", "SPRING-2021", "FALL  2023", "summer_26" -> "Fall-25" | null */
export function parseSemester(segment) {
  const m = /^(spring|summer|fall)[\s_'-]*(\d{4}|\d{2})$/i.exec(segment.trim());
  if (!m) return null;
  return `${SEASONS[m[1].toLowerCase()]}-${m[2].slice(-2)}`;
}

/** Sort key for semesters: newest first when sorted descending. */
export function semesterKey(sem) {
  const m = /^(Spring|Summer|Fall)-(\d{2})$/.exec(sem || '');
  return m ? Number(m[2]) * 10 + SEASON_ORDER[m[1]] : -1;
}

const norm = (s) => s.toLowerCase().replace(/[_\s]+/g, ' ').replace(/\s*&\s*/g, ' & ').trim();

// Folder names that ARE a category container: consumed (not kept as sub-folder).
const FOLDER_ALIASES = [
  ['Course-Info', /^(course[ -]?info|course outlines?( \(old and new\))?|outlines?|syllabus)$/],
  ['Lectures', /^(lectures?( slides?| pdf| notes)?|slides?|notes|lecture-pdf)$/],
  ['Labs', /^((cse|phy|che)\d+ )?labs?( manuals?| reports?| ?-?ex(c)?ercises?| sheets?)?$|^lab-ex(c)?ercises?$/],
  ['Assignments', /^assignments?$/],
  ['Questions', /^(questions?|exams?|question bank|previous questions)$/],
  ['Practice', /^practice( problems?| sets?)?$/],
  ['Projects', /^(mini[ -]?)?projects?$/],
  ['Books', /^(books?( & references?)?|references?|study materials?|text ?books?)$/],
  ['Code', /^(codes?|source codes?|java [a-z]+)$/],
];

// Folder names that HINT a category but carry information: kept as sub-folder.
const FOLDER_HINTS = [
  ['Questions', /\b(mid|midterm|final|ct|quiz(zes)?|mock ?tests?|exam)\b/],
  ['Labs', /\b(lab ?\d+|pspice|manuals? printable)\b/],
  ['Assignments', /\b(presentations?|term papers?)\b/],
];

// Ambiguous containers ("LAB & Projects"): consumed, the next folder decides.
const AMBIGUOUS = /^lab & projects?$/;

// Filename rules, first match wins. Order matters.
const FILE_RULES = [
  ['Course-Info', /course[ _-]?outline|(?:^|[^a-z])outline|syllabus|office ?hours?|routine|schedule|classroom ?rules|marks? distribution|rubric|^co[_ -]|^\d{4}\.\d\.[a-z]+\d+\.\d+\.[a-z]+\.[a-z]+$/i],
  ['Practice', /practi[cs]e|ptactice|problem ?sets?|worksheet|tutorial sheet|exercises?(?![a-z])|\dex(?![a-z])|solutions?(?![a-z])|answers?(?![a-z])|classwork/i],
  ['Lectures', /presentation/i],
  ['Questions', /questions?|(?<![a-z])mid(?![a-z])|mid[-_ ]?term|(?<![a-z])final(?![a-z])|(?<![a-z])ct ?-?\d|(?<![a-z])ct(?![a-z])|quiz|exam|mock ?test|lab_final/i],
  ['Assignments', /assignment|cover ?page|homework|(?<![a-z])hw ?\d/i],
  ['Projects', /project/i],
  ['Labs', /(?<![a-z])lab(?![a-z])|lab ?[-_]?\d|^lab|expt|experiment|datasheet/i],
  ['Books', /text ?book|(?<![a-z])book(?![a-z])|edition|\(\d{4}, [^)]+\)|teach yourself|fundamentals[- ]of/i],
  ['Lectures', /lecture|slides?|chapter|(?<![a-z])ch ?[-_]?\d|week ?\d|topic|notes?(?![a-z])|\.pptx?$/i],
];

export const ext = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

/** Classify a bare filename (no folder context). */
export function categoryFromName(name, size = 0) {
  const e = ext(name);
  if (CODE_EXT.has(e)) return 'Code';
  if (SIM_EXT.has(e)) return 'Labs';
  for (const [cat, re] of FILE_RULES) if (re.test(name)) return cat;
  if (e === 'pdf' && size > 15e6) return 'Books';
  if (['pdf', 'doc', 'docx', 'ppt', 'pptx'].includes(e)) return 'Lectures';
  return 'Lectures';
}

/** A whole book rather than notes: big, or named like one ("…Textbook", "10th Ed", "by Author"). */
export function looksLikeBook(name, size = 0) {
  if (size > 15e6) return true;
  if (matchCategory(name) === 'Books') return true;
  return /(?<![a-z])by(?![a-z])|\d+(st|nd|rd|th)[ _-]?ed|approach/i.test(name) && ext(name) === 'pdf';
}

/** Like categoryFromName, but null when no rule matches (no fallback guess). */
export function matchCategory(name) {
  const e = ext(name);
  if (CODE_EXT.has(e)) return 'Code';
  if (SIM_EXT.has(e)) return 'Labs';
  for (const [cat, re] of FILE_RULES) if (re.test(name)) return cat;
  return null;
}

/** Category implied by a folder / Classroom topic name, or null. */
export function categoryFromFolder(name) {
  const n = norm(name);
  const alias = FOLDER_ALIASES.find(([, re]) => re.test(n));
  if (alias) return alias[0];
  const hint = FOLDER_HINTS.find(([, re]) => re.test(n));
  return hint ? hint[0] : null;
}

/** EWU terms: Spring = Jan–Apr, Summer = May–Aug, Fall = Sep–Dec. */
export function semesterFromDate(d) {
  const date = new Date(d);
  const m = date.getUTCMonth();
  const season = m < 4 ? 'Spring' : m < 8 ? 'Summer' : 'Fall';
  return `${season}-${String(date.getUTCFullYear()).slice(-2)}`;
}

/** Tidy a file or folder display name. Never touches names of NO_RENAME_EXT files. */
export function cleanName(name, { isFolder = false } = {}) {
  const e = ext(name);
  if (!isFolder && NO_RENAME_EXT.has(e)) return name;
  let base = isFolder || !e ? name : name.slice(0, -(e.length + 1));
  base = base
    .replace(/\s*-\s*libgen\.[a-z]+$/i, '')          // piracy-site tags
    .replace(/\.(pptx?|docx?)$/i, '')               // "x.pptx.pdf" -> "x.pdf"
    .replace(/\s*\((\d{1,2})\)$/g, '')              // " (1)" copy suffix
    .replace(/Ptactice/g, 'Practice') // no \b: "_" is a word character, so "_Ptactice" never matched
    .replace(/Excercise/g, 'Exercise')
    .replace(/MANEGEMENT/g, 'MANAGEMENT')
    .replace(/\s+/g, ' ')
    .trim();
  return isFolder || !e ? base : `${base}.${e}`;
}

/**
 * Map a current path to its canonical path.
 * Returns { path, course, instructor, category, semester, reasons[] }.
 */
export function canonicalPath(currentPath, { size = 0, instructorAliases = {} } = {}) {
  const parts = currentPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  const course = parts.shift().toUpperCase().replace(/\s+/g, '');
  const reasons = [];

  let instructor = parts.length ? parts.shift() : GENERAL;
  if (instructorAliases[instructor]) instructor = instructorAliases[instructor];
  if (!parts.length && currentPath.split('/').length === 2) {
    reasons.push('course-root file moved under General');
  }

  let category = null;
  let semester = null;
  const sub = [];
  for (const seg of parts) {
    const n = norm(seg);
    const sem = parseSemester(seg);
    if (sem) { semester = sem; continue; }               // innermost semester wins
    if (AMBIGUOUS.test(n)) continue;
    const alias = FOLDER_ALIASES.find(([, re]) => re.test(n));
    if (alias && !category) { category = alias[0]; continue; }
    if (alias && category) {
      // Second container (e.g. Lab_Manuals/Lab reports): keep as sub-folder.
      sub.push(cleanName(seg, { isFolder: true }));
      continue;
    }
    if (!category) {
      const hint = FOLDER_HINTS.find(([, re]) => re.test(n));
      if (hint) category = hint[0];
    }
    sub.push(cleanName(seg, { isFolder: true }));
  }
  if (!category) {
    category = categoryFromName(fileName, size);
    reasons.push(`category from filename → ${category}`);
  } else if (category === 'Books' && !looksLikeBook(fileName, size)) {
    // "Books & References" / "Study Materials" folders also hold outlines, cover
    // pages, old questions and short notes. Books are Drive-only, so be precise.
    category = matchCategory(fileName) || 'Lectures';
    if (category === 'Books') category = 'Lectures';
    reasons.push(`in a books folder but not a book → ${category}`);
  }

  const cleaned = cleanName(fileName);
  if (cleaned !== fileName) reasons.push('name tidied');

  const path = [course, instructor, category, semester, ...sub, cleaned].filter(Boolean).join('/');
  return { path, course, instructor, category, semester, reasons };
}

/** Parse a canonical path back into its parts (used by the site). */
export function parseCanonical(path) {
  const [course, instructor, category, maybeSem, ...rest] = path.split('/');
  const semester = maybeSem && parseSemester(maybeSem) ? maybeSem : null;
  const tail = semester ? rest : [maybeSem, ...rest].filter((x) => x !== undefined);
  return { course, instructor, category, semester, sub: tail.slice(0, -1), name: tail[tail.length - 1] };
}

export function categoryOrder(cat) {
  const i = CATEGORIES.indexOf(cat);
  return i === -1 ? CATEGORIES.length : i;
}

export const department = (course) => (/^[A-Z]+/.exec(course) || ['OTHER'])[0];
