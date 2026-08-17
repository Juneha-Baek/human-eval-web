'use strict';

/** Local / self-hosted runner. Vercel uses api/index.js with the same handler. */

const http = require('http');
const { handleRequest, cfg, PROTOCOL } = require('./lib/app');
const data = require('./lib/data');
const db = require('./lib/db');

http.createServer(handleRequest).listen(cfg.port, cfg.host, () => {
  console.log(`\n  ${cfg.studyTitle}`);
  console.log(`  protocol ${PROTOCOL.version} | ${data.papers.length} papers (HE1) | ${data.pairs.length} pairs (HE2)`);
  console.log(`  storage: ${db.isMock ? 'IN-MEMORY MOCK (tests only — nothing is persisted)' : 'Supabase'}`);
  console.log(`\n  annotator:  http://localhost:${cfg.port}/`);
  console.log(`  admin:      http://localhost:${cfg.port}/admin.html`);
  if (!cfg.adminToken || cfg.adminToken === 'CHANGE-ME-admin-token') {
    console.log('\n  ! set ADMIN_TOKEN before collecting data\n');
  }
});
