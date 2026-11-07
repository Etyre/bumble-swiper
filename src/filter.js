// Decides whether a profile should be liked, based on the configured terms.

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‐-―_/]/g, '-') // fancy dashes, underscores, slashes -> hyphen
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegex(term) {
  const norm = normalizeText(term);
  if (!norm) return null;
  // word boundary on both sides; internal spaces match any whitespace run
  const body = norm.split(' ').map(escapeRegex).join('\\s+');
  return new RegExp(`(^|[^a-z0-9])${body}(?=$|[^a-z0-9])`, 'i');
}

/**
 * @param {{name?:string, age?:string, pills?:string[], text?:string}} profile
 * @param {{terms:string[], excludePhrases:string[], matchIn:'pills'|'anywhere'}} config
 * @returns {{like:boolean, matchedTerms:string[], excludedBy:string[], reason:string, where:string}}
 */
export function evaluate(profile, config) {
  const pillsText = normalizeText((profile.pills || []).join('\n'));
  const fullText = normalizeText(profile.text || '');
  const haystack = config.matchIn === 'pills' ? pillsText : fullText;

  const excludedBy = [];
  for (const phrase of config.excludePhrases || []) {
    const re = termRegex(phrase);
    if (re && re.test(haystack)) excludedBy.push(phrase);
  }

  const matchedTerms = [];
  let where = '';
  for (const term of config.terms || []) {
    const re = termRegex(term);
    if (!re) continue;
    if (re.test(haystack)) {
      matchedTerms.push(term);
      if (!where) where = re.test(pillsText) ? 'badge' : 'bio';
    }
  }

  if (matchedTerms.length && excludedBy.length) {
    return { like: false, matchedTerms, excludedBy, where, reason: `matched ${matchedTerms.join(', ')} but excluded by "${excludedBy[0]}"` };
  }
  if (matchedTerms.length) {
    return { like: true, matchedTerms, excludedBy, where, reason: `matched ${matchedTerms.join(', ')} (${where})` };
  }
  return { like: false, matchedTerms, excludedBy, where, reason: 'no matching terms' };
}
