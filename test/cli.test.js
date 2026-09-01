import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { CLI_SOURCE } from '../src/cli.js';
import { skillBody } from '../src/skill.js';

const SKILL_BODY = skillBody('jmp2.io');

const ON_DISK = readFileSync(new URL('../bin/jmp2', import.meta.url), 'utf8');

test('the served CLI is byte-identical to bin/jmp2', () => {
  assert.equal(
    CLI_SOURCE, ON_DISK,
    'bin/jmp2 changed without regenerating src/cli.js — run `npm run build:cli`',
  );
});

test('the CLI survived embedding with its shell syntax intact', () => {
  assert.ok(CLI_SOURCE.startsWith('#!/usr/bin/env bash\n'), 'the shebang must survive');
  assert.ok(CLI_SOURCE.includes('${JMP2_API:-https://jmp2.io}'), 'bash expansions must not be eaten');
  assert.ok(CLI_SOURCE.includes('"${EXCLUDES[@]}"'), 'array expansions must not be eaten');
  assert.ok(!CLI_SOURCE.includes('\\$'), 'template escaping must not leak into the output');
});

test('bin/jmp2 is executable and parses as bash', () => {
  assert.ok(statSync(new URL('../bin/jmp2', import.meta.url)).mode & 0o111, 'must be executable');
  execFileSync('bash', ['-n', new URL('../bin/jmp2', import.meta.url).pathname]);
});

test('every command the docs advertise actually exists', () => {
  const advertised = [...SKILL_BODY.matchAll(/^jmp2 ([a-z-]+)/gm)].map((m) => m[1]);
  assert.ok(advertised.length >= 6, 'the docs should show the main commands');
  for (const cmd of new Set(advertised)) {
    assert.ok(
      new RegExp(`^\\s*(${cmd}\\)|${cmd}\\s*\\))`, 'm').test(CLI_SOURCE),
      `docs advertise "jmp2 ${cmd}" but the CLI has no such case`,
    );
  }
});

test('the docs tell people where to get the CLI', () => {
  assert.ok(SKILL_BODY.includes('https://jmp2.io/cli'), 'an undiscoverable CLI may as well not exist');
  assert.ok(SKILL_BODY.includes('chmod +x'));
});

test('help output lists the commands and nothing else', () => {
  const help = execFileSync('bash', [new URL('../bin/jmp2', import.meta.url).pathname, 'help'], {
    encoding: 'utf8',
  });
  assert.ok(help.includes('jmp2 push'));
  assert.ok(help.includes('jmp2 token-rm'));
  assert.ok(!help.includes('set -euo'), 'the help window must not spill into the script body');
});

test('an unknown command fails loudly', () => {
  assert.throws(() => execFileSync(
    'bash',
    [new URL('../bin/jmp2', import.meta.url).pathname, 'frobnicate'],
    { encoding: 'utf8', stdio: 'pipe' },
  ), /unknown command/);
});

test('an unknown option is refused rather than read as a path', () => {
  // A stale client that silently ignored --secret would publish publicly while
  // the caller believed the site was unlisted. Flags that decide who can see
  // something must fail loudly when they are not understood.
  const run = (args) => execFileSync(
    'bash', [new URL('../bin/jmp2', import.meta.url).pathname, ...args],
    { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, JMP2_TOKEN: 'x' } },
  );
  assert.throws(() => run(['push', 'slug', '.', '--secrit']), /unknown option/);
  assert.throws(() => run(['push', 'slug', '--visibility=secret']), /unknown option/);
});

test('the visibility flags the docs advertise are all understood', () => {
  const source = readFileSync(new URL('../bin/jmp2', import.meta.url), 'utf8');
  for (const flag of ['--secret', '--public', '--password']) {
    assert.ok(new RegExp(`^\\s*${flag}\\)`, 'm').test(source), `no case for ${flag}`);
  }
  assert.ok(/^\s*secret\)/m.test(source), 'no `jmp2 secret` command');
  assert.ok(/^\s*public\)/m.test(source), 'no `jmp2 public` command');
});
