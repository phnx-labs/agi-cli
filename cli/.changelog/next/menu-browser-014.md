- **Browser setup installs Browser CLI 0.1.5 (PHNX-3999).** New installations
  include the status fix that reports unavailable Arc tasks without hiding healthy
  profiles and reads visible Arc tabs once per status request. Existing browser
  installations are preserved; upgrade them explicitly with
  `npm install -g @phnx-labs/browser-cli@0.1.5`. (0.1.5 is a clean re-cut of the
  partially-published 0.1.4; same behavior.)
