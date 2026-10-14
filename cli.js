// Server-side admin commands.
//
//   npm run set-password                 prompts (hidden input, asked twice)
//   node cli.js set-password --stdin     reads one line from stdin (scripts)
//   node cli.js set <path> <value>       e.g. set mode lofi, set restart.at 04:30
//   node cli.js set <path> --stdin       value from stdin — use for secrets so
//                                        they never appear in shell history:
//                                        youtube.streamKey,
//                                        notifications.discordWebhookUrl,
//                                        healthcheck.url
//
// Safe while the server runs: it re-reads config.json before every login and
// every write, so changes take effect immediately and aren't lost. Values go
// through the same validation as the panel's API.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, MIN_PASSWORD } from './src/core/auth.js';
import { SECRETS, Settings, setPath } from './src/core/settings.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('No terminal — use --stdin'));
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdinLine() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0];
}

async function setPassword(args) {
  let password;
  if (args.includes('--stdin')) {
    password = await readStdinLine();
  } else {
    password = await askHidden(`New panel password (min ${MIN_PASSWORD} chars): `);
    if ((await askHidden('Again: ')) !== password) throw new Error('Passwords do not match');
  }
  const settings = await new Settings(dataDir).load();
  await settings.setPasswordHash(await hashPassword(password));
  console.log('Password set. Everyone signed in before has been signed out.');
}

async function set([key, value]) {
  if (!key || value === undefined) throw new Error('usage: node cli.js set <path> <value|--stdin>');
  let raw = value === '--stdin' ? await readStdinLine() : value;
  // Numbers and booleans as JSON; everything else is a string.
  if (/^(true|false|-?\d+)$/.test(raw)) raw = JSON.parse(raw);
  if (raw === 'null') raw = null;
  const patch = {};
  setPath(patch, key, raw);
  const settings = await new Settings(dataDir).load();
  const libraryHasMedia = await hasMedia();
  await settings.patch(patch, { profileLocked: libraryHasMedia });
  const secret = SECRETS.includes(key);
  console.log(`${key} = ${secret ? (raw ? '(set)' : '(cleared)') : JSON.stringify(raw)}`);
}

async function hasMedia() {
  try {
    const lib = JSON.parse(await readFile(path.join(dataDir, 'library.json'), 'utf8'));
    return Object.keys(lib.items ?? {}).length > 0;
  } catch {
    return false;
  }
}

const [command, ...args] = process.argv.slice(2);
const commands = { 'set-password': setPassword, set };
if (!commands[command]) {
  console.log('usage:\n  node cli.js set-password [--stdin]\n  node cli.js set <path> <value|--stdin>');
  process.exit(command ? 1 : 0);
}
commands[command](args).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
