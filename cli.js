// Server-side admin commands.
//
//   npm run set-password                 prompts (hidden input, asked twice)
//   node cli.js set-password --stdin     reads one line from stdin (scripts)
//   node cli.js setup-code [--stdin]     one-time code for choosing the password
//                                        in the browser (made up, or from stdin)
//   node cli.js set-terminal-password    the Terminal tab's own password (prompts;
//                                        --stdin reads it); turns the tab on
//   node cli.js terminal-off             turns the Terminal tab off
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
import { hashPassword, MIN_PASSWORD, verifyPassword } from './src/core/auth.js';
import { newSetupCode, SECRETS, Settings, setPath } from './src/core/settings.js';

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

async function setupCode(args) {
  const settings = await new Settings(dataDir).load();
  if (settings.get().auth.passwordHash) {
    console.log('A panel password is already set, so no setup code is needed (reset it with: npm run set-password).');
    return;
  }
  const code = args.includes('--stdin') ? (await readStdinLine()).trim() : newSetupCode();
  if (!/^[A-Za-z0-9-]{6,64}$/.test(code)) throw new Error('A setup code is 6-64 letters, digits or dashes');
  await settings.setSetupCode(code);
  console.log(`Setup code: ${code}\nOpen the panel and enter it to choose the password.`);
}

async function setTerminalPassword(args) {
  let password;
  if (args.includes('--stdin')) {
    password = await readStdinLine();
  } else {
    password = await askHidden(`New terminal password (min ${MIN_PASSWORD} chars, not the panel's): `);
    if ((await askHidden('Again: ')) !== password) throw new Error('Passwords do not match');
  }
  const settings = await new Settings(dataDir).load();
  const panel = settings.get().auth.passwordHash;
  if (panel && (await verifyPassword(password, panel))) throw new Error('Use a different password from the panel\'s');
  await settings.setTerminalHash(await hashPassword(password));
  console.log('Terminal password set: the panel\'s Terminal tab is on.');
}

async function terminalOff() {
  const settings = await new Settings(dataDir).load();
  await settings.setTerminalHash(null);
  console.log('Terminal turned off. Open sessions close within a few seconds; set a new password to turn it on again.');
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
const commands = { 'set-password': setPassword, 'setup-code': setupCode, 'set-terminal-password': setTerminalPassword, 'terminal-off': terminalOff, set };
if (!commands[command]) {
  console.log('usage:\n  node cli.js set-password [--stdin]\n  node cli.js setup-code [--stdin]\n  node cli.js set-terminal-password [--stdin]\n  node cli.js terminal-off\n  node cli.js set <path> <value|--stdin>');
  process.exit(command ? 1 : 0);
}
commands[command](args).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
