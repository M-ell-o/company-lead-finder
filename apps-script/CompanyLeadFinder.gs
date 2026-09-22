/**
 * COMPANY LEAD FINDER
 * ---------------------------------------------------------------------------
 * Finds small, early-stage, US-based companies that are likely hiring and
 * adds them as new rows on a Google Sheet tab called "Companies".
 *
 *   pullYC()         -> Y Combinator companies currently marked "hiring"
 *   pullEDGAR()      -> companies that just filed an SEC Form D (raised money)
 *   pullHackerNews() -> companies posting in HN's monthly "Who is hiring?" thread
 *
 * The three functions are independent: each has its own error handling and
 * its own trigger, so a failure in one does not affect the others.
 *
 * NOTE ON pullEDGAR(): Apps Script cannot send the custom User-Agent header the
 * SEC requires, so the SEC download + filtering runs on GitHub Actions instead
 * (see the GitHub repo in EDGAR_JSON_URL). It saves a JSON file; pullEDGAR()
 * just reads that file and adds the rows to the Sheet.
 *
 * NOTE ON pullHackerNews(): Hacker News's own APIs (Firebase + Algolia) allow
 * normal requests, so this one runs entirely inside Apps Script, like pullYC().
 * It reads free-text comments, so the extracted fields (company, team size,
 * location, decision-maker) are best-effort guesses, not verified facts -
 * see the comments in the HACKER NEWS section below for exactly where this
 * is unreliable.
 */

// =============================== SETTINGS ==================================
var SETTINGS = {
  SHEET_NAME: 'Companies',      // tab that receives the results
  LOG_SHEET_NAME: 'Run Log',    // tab that records what each run did
  MAX_RUN_MS: 4.5 * 60 * 1000,  // stop early at 4.5 min (Google's limit is 6)

  // ---- Y Combinator ----
  YC_MAX_TEAM_SIZE: 50,               // "small" = this many people or fewer
  YC_INCLUDE_UNKNOWN_TEAM_SIZE: true, // keep companies that list no team size
  YC_MIN_BATCH: 'Winter 2024',        // oldest YC batch to include, e.g. 'Summer 2023'
                                      // (season = Winter/Spring/Summer/Fall + year).
                                      // Leave '' to include every batch.
  YC_FETCH_PROFILE_PAGES: true,       // look up founder names + founding year
  YC_MAX_NEW_ROWS_PER_RUN: 100,       // newest batches first; rest next run

  // ---- SEC EDGAR Form D (filtering settings now live in the GitHub repo:
  //      scripts/edgar.js) ----
  EDGAR_JSON_URL: 'https://raw.githubusercontent.com/M-ell-o/company-lead-finder/main/data/edgar-latest.json',
  EDGAR_MAX_DATA_AGE_DAYS: 3,         // warn in the Run Log if the file is older than this

  // ---- Hacker News "Who is hiring?" ----
  // Company names containing any of these words (whole word, case-insensitive)
  // are skipped. This is a blunt, easy-to-edit list, not a real company
  // database - it will both miss some large companies and (rarely) catch a
  // small one that happens to share a word with a big one.
  HN_COMPANY_BLOCKLIST: ['google', 'amazon', 'meta', 'microsoft', 'stripe'],
  HN_MAX_COMMENTS_PER_RUN: 250        // new comments to read per run; the rest wait for the next run
};

var HEADERS = ['Date Added', 'Source', 'Company', 'Year Founded', 'Team Size',
  'Decision Makers', 'Location', 'Link', 'Industry', 'Why Listed', 'Match Key'];

var YC_HIRING_URL = 'https://yc-oss.github.io/api/companies/hiring.json';


// ========================= FUNCTION 1: Y COMBINATOR ========================
/** Run this (or attach a trigger to it) to pull Y Combinator companies. */
function pullYC() {
  var startedAt = Date.now();
  try {
    // 1. Download the list of YC companies currently marked as hiring.
    var res = UrlFetchApp.fetch(YC_HIRING_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw new Error('YC feed returned HTTP ' + res.getResponseCode());
    }
    var companies = JSON.parse(res.getContentText());
    if (!Array.isArray(companies)) throw new Error('YC feed was not a list as expected.');

    // 2. Keep US-based, small, active, for-profit companies from recent batches.
    //    (Done before the profile lookups so old companies never cost a request.)
    var minBatchRank = ycBatchRank_(SETTINGS.YC_MIN_BATCH); // 0 if blank = no cutoff
    if (SETTINGS.YC_MIN_BATCH && minBatchRank === 0) {
      throw new Error('YC_MIN_BATCH "' + SETTINGS.YC_MIN_BATCH + '" is not valid. ' +
        'Use a season and year such as "Winter 2024", or leave it blank.');
    }
    var candidates = companies.filter(function (c) {
      if (ycBatchRank_(c.batch) < minBatchRank) return false; // older batch, or "Unspecified"
      var isUS = (c.regions || []).indexOf('United States of America') !== -1 ||
                 /,\s*USA\b/.test(c.all_locations || '');
      var size = c.team_size;
      var sizeOk = (size === null || size === undefined || size === '')
        ? SETTINGS.YC_INCLUDE_UNKNOWN_TEAM_SIZE
        : size <= SETTINGS.YC_MAX_TEAM_SIZE;
      var active = !c.status || c.status === 'Active';
      return isUS && sizeOk && active && !c.nonprofit && c.name;
    });

    // 3. Newest batches first (they are the earliest-stage), and drop any
    //    company already on the sheet so we only spend time on new ones.
    candidates.sort(function (a, b) { return ycBatchRank_(b.batch) - ycBatchRank_(a.batch); });
    var existing = getExistingKeys_();
    var fresh = candidates.filter(function (c) { return !existing[makeKey_(c.name)]; });
    var skippedForCap = Math.max(0, fresh.length - SETTINGS.YC_MAX_NEW_ROWS_PER_RUN);
    fresh = fresh.slice(0, SETTINGS.YC_MAX_NEW_ROWS_PER_RUN);

    // 4. Optionally look up each company's public YC page for founders + year founded.
    var profiles = {};
    var profileFailures = 0;
    if (SETTINGS.YC_FETCH_PROFILE_PAGES) {
      for (var i = 0; i < fresh.length; i += 10) {
        if (Date.now() - startedAt > SETTINGS.MAX_RUN_MS) break; // out of time: leave the rest blank
        var chunk = fresh.slice(i, i + 10);
        var responses = UrlFetchApp.fetchAll(chunk.map(function (c) {
          return { url: c.url, muteHttpExceptions: true };
        }));
        for (var j = 0; j < chunk.length; j++) {
          try {
            if (responses[j].getResponseCode() !== 200) throw new Error('HTTP ' + responses[j].getResponseCode());
            profiles[chunk[j].slug] = parseYcProfile_(responses[j].getContentText());
          } catch (e) {
            profileFailures++; // this company just gets blank founder/year cells
          }
        }
      }
    }

    // 5. Build rows and write them.
    var rows = fresh.map(function (c) {
      var p = profiles[c.slug] || {};
      var founders = (p.founders || []).filter(function (f) { return f && f.full_name; })
        .slice(0, 6)
        .map(function (f) { return f.title ? f.full_name + ' (' + f.title + ')' : f.full_name; })
        .join('; ');
      return {
        source: 'Y Combinator',
        company: c.name,
        yearFounded: p.year_founded || '',
        teamSize: (c.team_size === null || c.team_size === undefined) ? '' : c.team_size,
        people: founders,
        location: c.all_locations || '',
        link: c.website || c.url || '',
        industry: (c.subindustry || c.industry || '').replace(/\s*->\s*/g, ' > '),
        why: 'Marked "hiring" on Y Combinator; batch: ' + (c.batch || 'unknown') + '. ' + (c.url || '')
      };
    });
    var added = writeRows_(rows);

    logRun_('pullYC', 'OK', 'Feed: ' + companies.length + ' hiring companies; ' + candidates.length +
      ' match filters; added ' + added + ' new rows' +
      (skippedForCap ? '; ' + skippedForCap + ' more will be added on later runs' : '') +
      (profileFailures ? '; ' + profileFailures + ' profile pages could not be read' : '') + '.');
  } catch (err) {
    logRun_('pullYC', 'FAILED', String(err && err.message ? err.message : err));
    throw err; // re-throw so Google's "failure notification" email still fires
  }
}


// ============================ FUNCTION 2: SEC EDGAR ========================
/**
 * Run this (or attach a trigger to it) to add recent SEC Form D companies.
 * The SEC lookup itself is done by the GitHub Action, which saves its results
 * to data/edgar-latest.json. This function reads that file and adds any
 * companies not already on the sheet.
 */
function pullEDGAR() {
  try {
    if (/YOUR-GITHUB-USERNAME/.test(SETTINGS.EDGAR_JSON_URL)) {
      throw new Error('Open the SETTINGS block at the top of the script and replace ' +
        'YOUR-GITHUB-USERNAME in EDGAR_JSON_URL with your GitHub username.');
    }

    // 1. Download the JSON file the GitHub Action produced.
    var res = UrlFetchApp.fetch(SETTINGS.EDGAR_JSON_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw new Error('Could not download the EDGAR data file (HTTP ' + res.getResponseCode() +
        '). Check EDGAR_JSON_URL and that the GitHub Action has run at least once.');
    }
    var data = JSON.parse(res.getContentText());
    if (!data || !Array.isArray(data.rows)) throw new Error('The EDGAR data file was not in the expected format.');

    // 2. Warn (but continue) if the file looks stale, i.e. the Action has stopped running.
    var staleNote = '';
    var windowEnd = data.windowEnd ? new Date(data.windowEnd + 'T12:00:00Z') : null;
    if (windowEnd && (Date.now() - windowEnd.getTime()) > SETTINGS.EDGAR_MAX_DATA_AGE_DAYS * 24 * 3600 * 1000) {
      staleNote = ' WARNING: the data file is stale (last covers ' + data.windowEnd +
        '). Check the GitHub Actions tab for failed runs.';
    }

    // 3. Write the rows through the same shared writer/dedupe used by pullYC().
    var rows = data.rows.map(function (r) {
      return {
        source: r.source || 'SEC Form D',
        company: r.company,
        yearFounded: r.yearFounded,
        teamSize: r.teamSize,
        people: r.people,
        location: r.location,
        link: r.link,
        industry: r.industry,
        why: r.why
      };
    });
    var added = writeRows_(rows);

    logRun_('pullEDGAR', 'OK', 'From GitHub file: ' + (data.summary || (rows.length + ' rows')) +
      ' Added ' + added + ' new rows.' + staleNote);
  } catch (err) {
    logRun_('pullEDGAR', 'FAILED', String(err && err.message ? err.message : err));
    throw err; // re-throw so Google's "failure notification" email still fires
  }
}

// ========================= FUNCTION 3: HACKER NEWS ==========================
/**
 * Run this (or attach a trigger to it) to add companies posting in the
 * current month's HN "Who is hiring?" thread. Comments are free text, so the
 * company name, location, team size, and decision-maker fields below are
 * best-effort guesses read out of that text with pattern matching - they are
 * NOT verified data the way YC's and EDGAR's fields are. Always sanity-check
 * a row's "Why Listed" text (or open the link) before treating it as fact.
 */
function pullHackerNews() {
  try {
    // 1. Find the current thread (Algolia first, since it gives the title and
    //    id in one request; fall back to scanning the whoishiring account's
    //    own posts if Algolia is unreachable).
    var thread = getCurrentHnThread_();

    // 2. Get the thread's top-level comment ids.
    var itemRes = UrlFetchApp.fetch('https://hacker-news.firebaseio.com/v0/item/' + thread.id + '.json',
      { muteHttpExceptions: true });
    if (itemRes.getResponseCode() !== 200) {
      throw new Error('Could not load the thread itself (HTTP ' + itemRes.getResponseCode() + ').');
    }
    var kids = (JSON.parse(itemRes.getContentText()).kids || []).map(String);

    // 3. Skip comments already read on an earlier run of this thread.
    var seen = getHnSeenIds_(thread.id);
    var newIds = kids.filter(function (id) { return !seen[id]; });
    var alreadyReadCount = kids.length - newIds.length;
    var toFetch = newIds.slice(0, SETTINGS.HN_MAX_COMMENTS_PER_RUN);
    var deferredCount = newIds.length - toFetch.length; // beyond the per-run cap

    // 4. Fetch and parse new comments (20 at a time), respecting the time budget.
    var startedAt = Date.now();
    var rows = [];
    var newlySeen = [];
    var opened = 0, blocked = 0, unreadable = 0, lowConfidence = 0, ranOutOfTime = false;
    for (var i = 0; i < toFetch.length; i += 20) {
      if (Date.now() - startedAt > SETTINGS.MAX_RUN_MS) { deferredCount += toFetch.length - i; ranOutOfTime = true; break; }
      var chunk = toFetch.slice(i, i + 20);
      var responses = UrlFetchApp.fetchAll(chunk.map(function (id) {
        return { url: 'https://hacker-news.firebaseio.com/v0/item/' + id + '.json', muteHttpExceptions: true };
      }));
      for (var j = 0; j < chunk.length; j++) {
        opened++;
        if (responses[j].getResponseCode() !== 200) { unreadable++; continue; } // not marked seen: retried next run
        newlySeen.push(chunk[j]);
        var item;
        try { item = JSON.parse(responses[j].getContentText()); } catch (e) { unreadable++; continue; }
        var parsed = parseHnComment_(item);
        if (!parsed) continue; // deleted/dead/empty comment
        if (parsed.lowConfidence) lowConfidence++;
        if (isHnBlocklisted_(parsed.company)) { blocked++; continue; }
        rows.push({
          source: 'Hacker News', company: parsed.company, yearFounded: '', teamSize: parsed.teamSize,
          people: parsed.people, location: parsed.location, link: parsed.link, industry: '', why: parsed.why
        });
      }
    }
    var added = writeRows_(rows);
    appendHnSeen_(thread.id, newlySeen);

    logRun_('pullHackerNews', 'OK', 'Thread: "' + thread.title + '" (id ' + thread.id + '); ' + kids.length +
      ' top-level comments; ' + alreadyReadCount + ' already read on an earlier run; opened ' + opened +
      '; ' + blocked + ' matched the blocklist; added ' + added + ' new rows' +
      (lowConfidence ? '; ' + lowConfidence + ' company names are low-confidence guesses (no "Company | ..." header found)' : '') +
      (unreadable ? '; ' + unreadable + ' comments could not be read (will retry)' : '') +
      (ranOutOfTime ? '; stopped early to stay under the time limit' : '') +
      (deferredCount ? '; ' + deferredCount + ' more will be read on later runs' : '') + '.');
  } catch (err) {
    logRun_('pullHackerNews', 'FAILED', String(err && err.message ? err.message : err));
    throw err; // re-throw so Google's "failure notification" email still fires
  }
}


// ============================ YC PARSING HELPERS ===========================
/** Sort key so "Summer 2025" > "Winter 2025" > "Summer 2024"; "Unspecified" sorts last. */
function ycBatchRank_(batch) {
  var m = /(Winter|Spring|Summer|Fall)\s+(\d{4})/.exec(batch || '');
  if (!m) return 0;
  return Number(m[2]) * 10 + { Winter: 1, Spring: 2, Summer: 3, Fall: 4 }[m[1]];
}

/** YC company pages embed their data as JSON inside a data-page="..." attribute. */
function parseYcProfile_(html) {
  var m = /data-page="([^"]+)"/.exec(html);
  if (!m) return null;
  var data = JSON.parse(decodeXml_(m[1]));
  return (data && data.props && data.props.company) || null;
}


// ========================= HACKER NEWS: FIND THE THREAD =====================
/**
 * Finds the current month's "Ask HN: Who is hiring?" thread. Tries the
 * Algolia search API first (one request gives both the id and the title);
 * if that fails, falls back to scanning the "whoishiring" account's own
 * recent posts through HN's Firebase API.
 */
function getCurrentHnThread_() {
  try {
    var url = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10';
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      var hits = JSON.parse(res.getContentText()).hits || [];
      var hit = hits.filter(function (h) { return /^Ask HN: Who is hiring\?/i.test(h.title || ''); })[0];
      if (hit) return { id: Number(hit.objectID), title: hit.title };
    }
  } catch (e) { /* fall through to the Firebase fallback below */ }

  var userRes = UrlFetchApp.fetch('https://hacker-news.firebaseio.com/v0/user/whoishiring.json', { muteHttpExceptions: true });
  if (userRes.getResponseCode() !== 200) {
    throw new Error('Could not reach Hacker News (Algolia failed, and the Firebase API returned HTTP ' +
      userRes.getResponseCode() + ').');
  }
  var submitted = JSON.parse(userRes.getContentText()).submitted || [];
  for (var i = 0; i < Math.min(submitted.length, 8); i++) {
    var itemRes = UrlFetchApp.fetch('https://hacker-news.firebaseio.com/v0/item/' + submitted[i] + '.json', { muteHttpExceptions: true });
    if (itemRes.getResponseCode() !== 200) continue;
    var item = JSON.parse(itemRes.getContentText());
    if (item && /^Ask HN: Who is hiring\?/i.test(item.title || '')) return { id: item.id, title: item.title };
  }
  throw new Error('Could not find a current "Who is hiring?" thread on Hacker News.');
}


// ====================== HACKER NEWS: COMMENT PARSING ========================
// Most "who is hiring" posts start with a line like:
//   COMPANY | Location | Remote/Onsite | Full-time | https://company.com
// but plenty of posters don't follow that format, so every field below is a
// best-effort guess, not a verified fact. Read "why" (or the link) before
// trusting a row.
var HN_JOB_TITLE_WORDS = /\b(engineer|manager|developer|designer|scientist|architect|analyst|director|lead|specialist|researcher|intern|founder|recruiter|marketer|accountant)\b/i;

function parseHnComment_(item) {
  if (!item || item.deleted || item.dead || !item.text) return null;

  var links = hnExtractLinks_(item.text);
  var text = hnStripHtml_(item.text);
  var header = text.split(/\n\n/)[0]; // text before the first paragraph break
  // Some posters use a single line break instead of a paragraph break between
  // the header and the body, so also cut each pipe segment at its first
  // internal newline - otherwise a "location" segment can run on into body text.
  var segs = header.split('|').map(function (s) { return s.split('\n')[0].trim(); }).filter(Boolean);

  var company, lowConfidence = false;
  if (segs.length > 1) {
    company = hnCleanCompany_(segs[0]);
  } else {
    // No "Company | ..." header - fall back to whatever text sits next to the
    // poster's own username, since many companies post from a company-named
    // HN account. This is noticeably less reliable than the pipe format.
    var guess = hnGuessCompanyNoPipes_(header, item.by);
    company = hnCleanCompany_(guess.text);
    lowConfidence = !guess.confident;
  }

  var isRemote = /\bremote\b/i.test(text);
  // Only guess a location from the pipe segments when a real "Company | ..."
  // header exists. Without pipes there's no structural signal for where a
  // location ends, so a whole paragraph can look like one - better to leave
  // this blank than show garbled multi-line text.
  var locSeg = segs.length > 1 ? hnPickLocation_(segs.slice(1)) : '';
  if (locSeg.length > 100) locSeg = locSeg.slice(0, 100) + '…'; // backstop against a segment that ran into body text

  // Team size: only trusted when the text gives one clear number.
  var teamMatch = /team of (?:~|about )?(\d{1,4})\b/i.exec(text) ||
    /\b(\d{1,4})\+?[- ](?:person|people)\b/i.exec(text) ||
    /\b(\d{1,4})\s*employees\b/i.exec(text);

  // Compensation: kept only as a snippet in "why", there's no dedicated field for it.
  var compMatch = /\$\s?\d{2,3}(?:[,.]\d{3})?\s?[kK]\s?(?:[-–—]\s?\$?\d{2,3}(?:[,.]\d{3})?\s?[kK])?(?:\s*(?:TC|total comp|\+\s*equity))?/i.exec(text) ||
    /\b\d{2,3}[-–—]\d{2,3}\s?[kK]\s?(?:EUR|USD|GBP)?\b/i.exec(text);

  // Decision-maker: a real email address if one is written out, or a rough
  // reconstruction of an obfuscated one ("name-at-domain-dot-com"), which is
  // unverified. A personal name is only captured next to "contact"/"reach out
  // to" - this catches very few comments; most posts name no individual.
  var emailMatch = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.exec(text);
  var obfuscatedMatch = !emailMatch &&
    /\b([a-z0-9_.+-]+)[\s-]+(?:at|AT)[\s-]+([a-z0-9.-]+)[\s-]+(?:dot|DOT)[\s-]+(com|org|io|co|net|es|de)\b/i.exec(text);
  var nameMatch = /\b(?:contact|reach out to)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})\b/.exec(text);

  var email = emailMatch ? emailMatch[0] :
    (obfuscatedMatch ? obfuscatedMatch[1] + '@' + obfuscatedMatch[2] + '.' + obfuscatedMatch[3] + ' (reconstructed from obfuscated text, unverified)' : '');
  var people = [
    email,
    nameMatch ? 'name mentioned in post: ' + nameMatch[1] : '',
    'HN user: ' + item.by
  ].filter(Boolean).join('; ');

  var extLink = links.filter(function (l) { return !/news\.ycombinator\.com/.test(l); })[0];
  var link = extLink || ('https://news.ycombinator.com/item?id=' + item.id);

  var whyBits = [];
  if (lowConfidence) whyBits.push('company name is a low-confidence guess (no "Company | ..." header found)');
  if (locSeg) whyBits.push('posted as: "' + locSeg + '"');
  else if (isRemote) whyBits.push('mentions remote work somewhere in the post');
  if (teamMatch) whyBits.push('team-size phrase: "' + teamMatch[0] + '"');
  if (compMatch) whyBits.push('comp figure: "' + compMatch[0] + '"');
  var why = 'HN "Who is hiring?" post by ' + item.by + '. ' +
    (whyBits.length ? whyBits.join('; ') + '.' : 'No location/team-size/comp phrase was recognized in the text - read the post itself.');

  return {
    company: company, lowConfidence: lowConfidence,
    teamSize: teamMatch ? teamMatch[1] : '',
    people: people, location: locSeg || '', link: link, why: why
  };
}

function isHnBlocklisted_(company) {
  return SETTINGS.HN_COMPANY_BLOCKLIST.some(function (word) {
    return new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(company);
  });
}

function hnExtractLinks_(html) {
  var links = [];
  var re = /<a\s+[^>]*href="([^"]+)"[^>]*>/gi, m;
  while ((m = re.exec(html)) !== null) links.push(decodeXml_(m[1]));
  return links;
}

function hnStripHtml_(html) {
  var text = html.replace(/<p>/gi, '\n\n').replace(/<[^>]+>/g, '');
  return decodeXml_(text).trim();
}

function hnCleanCompany_(s) {
  s = s.replace(/^[*\-\s"'>]+|[*\-\s"'>]+$/g, '');
  s = s.replace(/^(remote|onsite|on-site|hybrid)\b\s*(\([^)]*\))?\s*/i, ''); // some posters lead with the location
  s = s.replace(/\s*\(https?:\/\/[^)]+\)\s*$/i, ''); // trailing (url) duplicate of the link
  return s.trim().slice(0, 80);
}

/** Used only when a comment has no "Company | ..." header to split on. */
function hnGuessCompanyNoPipes_(header, username) {
  if (!username || /^(i|we|our|my)$/i.test(username)) {
    return { text: hnFirstSentence_(header), confident: false };
  }
  var re = new RegExp('\\b' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b(\\s+[a-zA-Z]+){0,2}', 'i');
  var m = re.exec(header);
  if (m) return { text: m[0].replace(/\s+(in|at|for|to|on)$/i, ''), confident: true };
  return { text: hnFirstSentence_(header), confident: false };
}

function hnFirstSentence_(header) {
  var flat = header.replace(/\s+/g, ' ').trim();
  var s = flat.split(/[.!?]/)[0].slice(0, 60).trim();
  return s + (flat.length > 60 ? '…' : '');
}

/** Picks the most location-like pipe segment, skipping ones that read as a job title. */
function hnPickLocation_(segs) {
  var m = segs.filter(function (s) { return /^(fully\s*)?(remote|onsite|on-site|hybrid)\b/i.test(s); })[0];
  if (m) return m;
  m = segs.filter(function (s) { return !HN_JOB_TITLE_WORDS.test(s) && /^[A-Za-z][A-Za-z .'-]+,\s*[A-Za-z]{2,}/.test(s); })[0];
  if (m) return m;
  return segs.filter(function (s) { return !HN_JOB_TITLE_WORDS.test(s) && /remote|onsite|on-site|hybrid/i.test(s); })[0] || '';
}


// ==================== HACKER NEWS: "SEEN COMMENTS" TAB =======================
// Mirrors EDGAR's seen-accessions.json: a small persisted list so re-runs only
// read new comments, not the whole thread again. Stored on a hidden sheet tab
// (Apps Script has no file system) and pruned to the current thread only,
// since a new month's thread makes the old list irrelevant.
var HN_SEEN_SHEET_NAME = 'HN Seen';

function getHnSeenSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(HN_SEEN_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(HN_SEEN_SHEET_NAME);
    sheet.getRange(1, 1, 1, 2).setValues([['Comment ID', 'Thread ID']]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.hideSheet();
  }
  return sheet;
}

/** Returns an object whose keys are the comment ids already read for this thread. */
function getHnSeenIds_(threadId) {
  var sheet = getHnSeenSheet_();
  var last = sheet.getLastRow();
  var seen = {};
  if (last < 2) return seen;
  sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (row) {
    if (String(row[1]) === String(threadId)) seen[String(row[0])] = true;
  });
  return seen;
}

/** Adds newly-read comment ids and drops rows from any older thread. */
function appendHnSeen_(threadId, ids) {
  var sheet = getHnSeenSheet_();
  var last = sheet.getLastRow();
  var kept = [];
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (row) {
      if (String(row[1]) === String(threadId)) kept.push(row);
    });
  }
  ids.forEach(function (id) { kept.push([id, threadId]); });
  sheet.getRange(2, 1, Math.max(last - 1, 0), 2).clearContent();
  if (kept.length) sheet.getRange(2, 1, kept.length, 2).setValues(kept);
}


// ================== SHARED HELPERS: SHEET WRITING + DEDUPE =================
/**
 * Adds rows to the sheet, skipping any company already listed (from either
 * source). Returns how many rows were actually added.
 */
function writeRows_(rows) {
  var lock = LockService.getScriptLock(); // stops the two functions writing at the same instant
  lock.waitLock(60000);
  try {
    var sheet = getSheet_();
    var seen = getExistingKeys_();
    var stamp = new Date();
    var out = [];
    rows.forEach(function (r) {
      var key = makeKey_(r.company);
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push([stamp, r.source, r.company, r.yearFounded, r.teamSize, r.people,
        r.location, r.link, r.industry, r.why, key].map(safeCell_));
    });
    if (out.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, out.length, HEADERS.length).setValues(out);
    }
    return out.length;
  } finally {
    lock.releaseLock();
  }
}

/** Returns an object whose keys are the Match Keys already on the sheet. */
function getExistingKeys_() {
  var sheet = getSheet_();
  var keys = {};
  var last = sheet.getLastRow();
  if (last < 2) return keys;
  sheet.getRange(2, HEADERS.length, last - 1, 1).getValues().forEach(function (row) {
    if (row[0]) keys[String(row[0])] = true;
  });
  return keys;
}

/** "Acme, Inc." and "ACME INC" both become "acme" so duplicates are caught. */
function makeKey_(name) {
  var k = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ');
  var suffix = /\s+(inc|incorporated|llc|l l c|corp|corporation|co|company|ltd|limited|pbc|the)$/;
  k = k.replace(/\s+/g, ' ').trim();
  while (suffix.test(k)) k = k.replace(suffix, '');
  k = k.replace(/^the\s+/, '');
  return k.replace(/\s+/g, '');
}

/** Stops text starting with = + - @ from being treated as a formula by Sheets. */
function safeCell_(v) {
  return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v;
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This script must be opened from a Google Sheet (Extensions > Apps Script).');
  var sheet = ss.getSheetByName(SETTINGS.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SETTINGS.SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Adds one line to the "Run Log" tab so you can see what each run did. */
function logRun_(fn, status, message) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SETTINGS.LOG_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SETTINGS.LOG_SHEET_NAME);
      sheet.getRange(1, 1, 1, 4).setValues([['Time', 'Function', 'Status', 'Details']]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([new Date(), fn, status, message]);
  } catch (e) { /* logging must never break a run */ }
  Logger.log(fn + ' ' + status + ': ' + message);
}


// ============================ TEXT/XML HELPERS =============================
function decodeXml_(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
