# Company Lead Finder

Finds small, early-stage US companies that are likely hiring and writes them into a Google Sheet.

- `apps-script/CompanyLeadFinder.gs` - paste into Google Sheets > Extensions > Apps Script. `pullYC()` reads the YC hiring feed; `pullEDGAR()` reads `data/edgar-latest.json` from this repo.
- `scripts/edgar.js` - fetches recent SEC Form D filings (needs a real User-Agent, which Google Apps Script cannot send).
- `.github/workflows/edgar.yml` - runs the script every 6 hours and saves `data/edgar-latest.json`.
- Setup: add a repository *variable* named `SEC_USER_AGENT` (your name and email) under Settings > Secrets and variables > Actions > Variables.
