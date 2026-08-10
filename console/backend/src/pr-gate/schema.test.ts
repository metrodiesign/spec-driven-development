import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

const schemaDir = join(import.meta.dirname, '..', '..', '..', '..', '.ai', 'schemas');

test('durable PR review/Judge/result schemas compile together and reject action output', () => {
  const review = JSON.parse(readFileSync(join(schemaDir, 'pr-review.schema.json'), 'utf8')) as Record<string, unknown>;
  const judge = JSON.parse(readFileSync(join(schemaDir, 'pr-judge.schema.json'), 'utf8')) as Record<string, unknown>;
  const result = JSON.parse(readFileSync(join(schemaDir, 'pr-quality-result.schema.json'), 'utf8')) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true });
  ajv.addSchema(review);
  ajv.addSchema(judge);
  ajv.addSchema(result);
  const validate = ajv.getSchema('https://local.platform/schemas/pr-review.schema.json');
  assert.ok(validate);
  const snapshot = {
    repository: 'acme/repo', pullRequest: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40),
    diffRef: `sha256:${'d'.repeat(64)}`, policyRef: `sha256:${'e'.repeat(64)}`,
  };
  assert.equal(validate!({ snapshot, findings: [], actionRequests: [] }), true);
  assert.equal(validate!({ snapshot, findings: [], actionRequests: [{}] }), false);
});
