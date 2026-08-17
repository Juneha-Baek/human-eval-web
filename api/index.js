'use strict';

/** Vercel serverless entry — same handler as the local server. */

const { handleRequest } = require('../lib/app');

module.exports = (req, res) => handleRequest(req, res);
