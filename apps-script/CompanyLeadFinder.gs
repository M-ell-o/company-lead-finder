/**
 * COMPANY LEAD FINDER
 * ---------------------------------------------------------------------------
 * Finds small, early-stage, US-based companies that are likely hiring and
 * adds them as new rows on a Google Sheet tab called "Companies".
 *
 *   pullYC()    -> Y Combinator companies currently marked "hiring"
 *   pullEDGAR() -> companies that just filed an SEC Form D (raised money)
 *
 * The two functions are independent: each has its own error handling and its
 * own trigger, so if one fails the other is unaffected.
 *
 * NOTE ON pullEDGAR(): Apps Script cannot send the custom User-Agent header the
 * SEC requires, so the SEC download + filtering runs on GitHub Actions instead
 * (see the GitHub repo in EDGAR_JSON_URL). It saves a JSON file; pullEDGAR()
 * just reads that file and adds the rows to the Sheet.
 */

// =============================== SETTINGS ==================================
var SETTINGS = {
  SHEET_NAME: 'Companies',      // tab that receives the results
  LOG_SHEET_NAME: 'Run Log',    // tab that records what each run did
  MAX_RUN_MS: 4.5 * 60 * 1000,  // stop early at 4.5 min (Google's limit is 6)

  // ---- Y Combinator ----
  YC_MAX_TEAM_SIZE: 50,               // "small" = this many people or fewer
  YC_INCLUDE_UNKNOWN_TEAM_SIZE: true, // keep companies that list no team size
  YC_FETCH_PROFILE_PAGES: true,       // look up founder names + founding year
  YC_MAX_NEW_ROWS_PER_RUN: 100,       // newest batches first; rest next run

  // ---- SEC EDGAR Form D (filtering settings now live in the GitHub repo:
  //      scripts/edgar.js) ----
  // >>> REPLACE YOUR-GITHUB-USERNAME with your GitHub username <<<
  EDGAR_JSON_URL: 'https://raw.githubusercontent.com/M-ell-o/company-lead-finder/main/data/edgar-latest.json',
  EDGAR_MAX_DATA_AGE_DAYS: 3          // warn in the Run Log if the file is older than this
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

    // 2. Keep US-based, small, active, for-profit companies.
    var candidates = companies.filter(function (c) {
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
