'use strict';
/**
 * SEC EDGAR Form D puller (Node.js port of pullEDGAR() / parseFormD_() from
 * the Google Apps Script). Runs on GitHub Actions, where a real User-Agent
 * header can be sent. Writes data/edgar-latest.json for the Apps Script to read.
 *
 * The logic and settings below are copied unchanged from the Apps Script.
 * Required environment variable: SEC_USER_AGENT  (e.g. "Jane Smith jane@gmail.com")
 */
const fs = require('fs');
const path = require('path');

// =============================== SETTINGS (same as Apps Script) ============
const SETTINGS = {
  SEC_USER_AGENT: process.env.SEC_USER_AGENT || '',

  EDGAR_LOOKBACK_DAYS: 2,
  EDGAR_ONLY_UNDER_5_YEARS_OLD: true,
  EDGAR_MAX_FILINGS_TO_OPEN: 400,
  EDGAR_EXCLUDED_INDUSTRIES: [
    'Pooled Investment Fund', 'Hedge Fund', 'Private Equity Fund',
    'Venture Capital Fund', 'Other Investment Fund', 'Investing',
    'REITS and Finance', 'Residential', 'Commercial', 'Construction',
    'Other Real Estate', 'Other Banking and Financial Services',
    'Commercial Banking', 'Investment Banking', 'Insurance'
  ],
  EDGAR_EXCLUDED_NAME_PATTERN:
    /\b(fund|funds|l\.?p\.?|series|trust|feeder|reit|real estate|properties|realty|estates?|apartments?|housing|mortgage|spv|jv|joint venture|opportunit(y|ies)|investors?|investments?|equity|capital|partners|ventures?|foundation|facility|gaingels|acquisitions?)\b/i,
  EDGAR_SKIP_INDUSTRY_OTHER: false
};

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL',
  'IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
  'WV','WI','WY','PR','GU','VI'];

const EDGAR_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'edgar-latest.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================ SEC HTTP HELPERS =============================
/** One SEC request; retries once if the SEC says "slow down" or has a hiccup. */
async function secFetch(url) {
  let code = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': SETTINGS.SEC_USER_AGENT, 'Accept': '*/*' } });
      code = res.status;
      if (code !== 429 && code < 500) return { code, text: await res.text() };
    } catch (e) {
      code = 599; // network hiccup: treated like a server error
    }
    await sleep(3000);
  }
  return { code, text: '' };
}

/** Several SEC requests at once (each retried the same way). */
function secFetchAll(urls) {
  return Promise.all(urls.map(secFetch));
}

// ============================ FORM D PARSING ===============================
function filingXmlUrl(f) {
  return 'https://www.sec.gov/Archives/edgar/data/' + f.cik + '/' + f.adsh.replace(/-/g, '') + '/primary_doc.xml';
}

/** Turns one Form D XML document into a row, or null if it should be skipped. */
function parseFormD(xml, f) {
  const entityType = xmlTag(xml, 'entityType');
  const industry = xmlTag(xml, 'industryGroupType');
  const state = xmlTag(xml, 'stateOrCountry'); // first occurrence = the issuer's address

  if (state && US_STATES.indexOf(state) === -1) return null;
  if (/partnership|trust/i.test(entityType)) return null;
  if (SETTINGS.EDGAR_EXCLUDED_INDUSTRIES.indexOf(industry) !== -1) return null;
  if (SETTINGS.EDGAR_SKIP_INDUSTRY_OTHER && industry === 'Other') return null;

  // Year of incorporation appears as <value>2024</value>, or "over five years ago" with no year.
  const yoiBlock = (/<yearOfInc>([\s\S]*?)<\/yearOfInc>/.exec(xml) || [])[1] || '';
  let yearFounded = xmlTag(yoiBlock, 'value');
  const olderThanFive = /<overFiveYears>\s*true/i.test(yoiBlock);
  if (SETTINGS.EDGAR_ONLY_UNDER_5_YEARS_OLD && olderThanFive) return null;
  if (!/^\d{4}$/.test(yearFounded)) yearFounded = '';

  // Officers / directors / promoters listed on the filing.
  const people = [];
  const re = /<relatedPersonInfo>([\s\S]*?)<\/relatedPersonInfo>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const nm = [xmlTag(block, 'firstName'), xmlTag(block, 'middleName'), xmlTag(block, 'lastName')]
      .filter((x) => x && !/^(n\/?a|-)$/i.test(x)).join(' '); // "-" = company, not a person
    const roles = [];
    const rr = /<relationship>([\s\S]*?)<\/relationship>/g;
    let r;
    while ((r = rr.exec(block)) !== null) roles.push(decodeXml(r[1]).trim());
    if (nm) people.push(roles.length ? nm + ' (' + roles.join('/') + ')' : nm);
  }

  const cityState = xmlTag(xml, 'city');
  const location = f.location || (cityState ? cityState + ', ' + state : state);
  const offering = xmlTag(xml, 'totalOfferingAmount');
  const sold = xmlTag(xml, 'totalAmountSold');
  const revenue = xmlTag(xml, 'revenueRange');

  const why = 'Filed SEC Form D on ' + f.fileDate + ' (recent fundraising)' +
    (offering ? '; offering ' + money(offering) + (sold ? ', ' + money(sold) + ' sold so far' : '') : '') +
    (revenue && !/decline|not applicable/i.test(revenue) ? '; revenue: ' + revenue : '') +
    (entityType ? '; ' + entityType : '') + '.';

  return {
    source: 'SEC Form D',
    company: xmlTag(xml, 'entityName') || f.name,
    yearFounded: yearFounded,
    teamSize: '', // Form D never reports headcount
    people: people.slice(0, 6).join('; '),
    location: location,
    link: 'https://www.sec.gov/Archives/edgar/data/' + f.cik + '/' + f.adsh.replace(/-/g, '') + '/',
    industry: industry,
    why: why
  };
}

function money(v) {
  const n = Number(v);
  return isNaN(n) ? String(v) : '$' + n.toLocaleString('en-US');
}

/** First <tag>value</tag> inside a chunk of XML ('' if absent). */
function xmlTag(xml, tag) {
  const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(xml || '');
  return m ? decodeXml(m[1]).trim() : '';
}

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function formatDateET(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

// ================================== MAIN ===================================
async function main() {
  if (!SETTINGS.SEC_USER_AGENT || /your\.email@example\.com/i.test(SETTINGS.SEC_USER_AGENT)) {
    throw new Error('SEC_USER_AGENT is not set. Add a repository variable named SEC_USER_AGENT ' +
      '(your name and email) under Settings > Secrets and variables > Actions > Variables.');
  }

  // 1. Ask EDGAR search for every Form D filed in the recent window (100 per page).
  const end = new Date();
  const start = new Date(end.getTime() - SETTINGS.EDGAR_LOOKBACK_DAYS * 24 * 3600 * 1000);
  const startStr = formatDateET(start);
  const endStr = formatDateET(end);
  let hits = [];
  let total = 0;
  for (let from = 0; from < 3000; from += 100) { // hard ceiling of 30 pages
    const url = EDGAR_SEARCH_URL + '?forms=D&dateRange=custom&startdt=' + startStr +
      '&enddt=' + endStr + '&from=' + from + '&size=100';
    const page = await secFetch(url);
    if (page.code !== 200) throw new Error('EDGAR search returned HTTP ' + page.code +
      (page.code === 403 || page.code === 429 ? ' (the SEC is rate-limiting or rejecting this request; check SEC_USER_AGENT and try later)' : ''));
    const json = JSON.parse(page.text);
    total = (json.hits && json.hits.total && json.hits.total.value) || 0;
    const batch = (json.hits && json.hits.hits) || [];
    hits = hits.concat(batch);
    if (batch.length < 100 || hits.length >= total) break;
    await sleep(150);
  }

  // 2. Cheap filters using only the search results (no extra downloads).
  const seenFilings = {};
  let filings = [];
  hits.forEach((h) => {
    const s = h._source || {};
    if (s.form !== 'D' || !s.adsh || seenFilings[s.adsh]) return;
    seenFilings[s.adsh] = true;
    const state = (s.biz_states && s.biz_states[0]) || '';
    if (state && US_STATES.indexOf(state) === -1) return;
    const name = ((s.display_names && s.display_names[0]) || '').replace(/\s*\(CIK \d+\)\s*$/, '').trim();
    if (!name || SETTINGS.EDGAR_EXCLUDED_NAME_PATTERN.test(name)) return;
    filings.push({ adsh: s.adsh, cik: String(parseInt(s.ciks && s.ciks[0], 10)), name: name,
      fileDate: s.file_date, location: (s.biz_locations && s.biz_locations[0]) || '' });
  });
  const candidateCount = filings.length;
  filings = filings.slice(0, SETTINGS.EDGAR_MAX_FILINGS_TO_OPEN);

  // 3. Open each filing's XML (8 at a time, 1 second apart; SEC's limit is 10 per second).
  const rows = [];
  let opened = 0, unreadable = 0;
  for (let i = 0; i < filings.length; i += 8) {
    const chunk = filings.slice(i, i + 8);
    const results = await secFetchAll(chunk.map(filingXmlUrl));
    for (let j = 0; j < chunk.length; j++) {
      opened++;
      if (results[j].code !== 200) { unreadable++; continue; }
      try {
        const row = parseFormD(results[j].text, chunk[j]);
        if (row) { row.fileDate = chunk[j].fileDate; row.accession = chunk[j].adsh; rows.push(row); }
      } catch (e) { unreadable++; }
    }
    await sleep(1000);
  }

  const summary = 'Window ' + startStr + ' to ' + endStr + ': ' + total + ' Form D filings found; ' +
    candidateCount + ' looked like possible operating companies; opened ' + opened +
    '; ' + rows.length + ' passed filters' +
    (unreadable ? '; ' + unreadable + ' filings could not be read' : '') + '.';

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    windowStart: startStr, windowEnd: endStr, totalFilings: total, summary: summary, rows: rows
  }, null, 1) + '\n');
  console.log(summary);
}

main().catch((err) => {
  console.error('FAILED: ' + (err && err.message ? err.message : err));
  process.exit(1); // marks the GitHub run as failed and leaves the previous JSON untouched
});
