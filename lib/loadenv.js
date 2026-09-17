/*
 * Minimal .env loader (zero dependencies).
 * Reads a .env file in the project root and copies any KEY=value lines into
 * process.env — without overwriting variables that are already set in the
 * real environment (so host/PaaS settings still win over the file).
 *
 * Supported:
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='value'
 *   # comments and blank lines are ignored
 */
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const envPath = file || path.join(__dirname, '..', '.env');
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (e) {
    return false; // no .env file — that's fine, just skip
  }

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;

    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding matching quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Do not override variables already provided by the real environment
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

module.exports = loadEnv;
