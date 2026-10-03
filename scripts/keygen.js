'use strict';
const { randomBytes } = require('node:crypto');
// Explicit operator command; startup and logs never print the encryption key.
process.stdout.write(`ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`);
