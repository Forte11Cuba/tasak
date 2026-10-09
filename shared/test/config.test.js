import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv, buildConfig, renderConfig } from '../../build.mjs';

// The same vectors are checked by the Rust server (cargo test in server/)
const { cases } = JSON.parse(readFileSync(new URL('config-cases.json', import.meta.url), 'utf8'));
const web = new URL('../../web/', import.meta.url);

test('web/config.js from .env (config-cases.json)', () => {
  for (const { name, env, processEnv, errors, configJs } of cases) {
    const fileEnv = env == null ? {} : parseEnv(env);
    const r = buildConfig(k => processEnv[k] ?? fileEnv[k], web);
    assert.deepEqual(r.errors, errors, name);
    assert.equal(r.errors.length ? null : renderConfig(r.config), configJs, name);
  }
});
