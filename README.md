# Python Coding Assessment — Version 1

This is the first prototype of a teacher-controlled coding assessment.

## Architecture

- GitHub Pages: student/teacher interface
- Google Apps Script: private backend
- Google Sheets: students, questions, sessions, submissions
- Python execution/testing: intentionally left for Phase 2

## Important security note

Do NOT put student data, access codes, questions, answer keys, or other private assessment information in this GitHub repository.

GitHub Pages is the public-facing website. Private assessment data belongs in Google Sheets and should only be returned by the Apps Script backend when the current session is authorized.

## Files

- `index.html` — website structure
- `style.css` — appearance
- `config.js` — Apps Script URL
- `app.js` — student and teacher interface
- `Code.gs` — Google Apps Script backend (created separately below)

## GitHub Pages setup

1. Create a GitHub repository.
2. Add these files.
3. In GitHub, open Settings → Pages.
4. Under Build and deployment, choose Deploy from a branch.
5. Choose your main branch and `/ (root)`.
6. Save.
7. GitHub will publish the site at your GitHub Pages URL.

GitHub documents this workflow here:
https://docs.github.com/en/pages/quickstart

## Before students use it

1. Create the Google Sheet.
2. Add the Apps Script backend.
3. Deploy Apps Script as a web app.
4. Copy the deployment URL into `config.js`.
5. Create student access codes in the Sheet.
6. Test with a fake student account/code.


## Current prototype status

Version 1 includes:

- unique student access codes
- teacher access code
- Q1 → Q2A/B/C → Q3A/B/C → Q4A/B/C structure
- teacher-controlled advancement
- student submissions stored in the Sheet
- submitted questions hidden from students
- students placed into a waiting state after submitting
- teacher dashboard and submission history

The "Run / Test" button is intentionally a placeholder. In the next phase we can add a browser-based Python execution/testing system using the exact inputs/outputs you want students to work with.
