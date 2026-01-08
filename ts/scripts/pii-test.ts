#!/usr/bin/env bun
/**
 * PII Redaction Test - Verify PII is redacted before sending
 *
 * Run: bun run scripts/pii-test.ts
 *
 * This script tests that PII patterns are properly redacted.
 */

import { createPiiPlugin } from '../src/plugins/pii.js';

// ============================================
// Test Cases
// ============================================

const testCases = [
  {
    name: 'Email addresses',
    input: 'Contact john.doe@example.com or jane@company.org',
    expectRedacted: ['john.doe@example.com', 'jane@company.org'],
  },
  {
    name: 'Phone numbers',
    input: 'Call me at (555) 123-4567 or 555-987-6543',
    expectRedacted: ['(555) 123-4567', '555-987-6543'],
  },
  {
    name: 'SSN',
    input: 'SSN: 123-45-6789',
    expectRedacted: ['123-45-6789'],
  },
  {
    name: 'Credit cards',
    input: 'Card: 4111 1111 1111 1111',
    expectRedacted: ['4111 1111 1111 1111'],
  },
  {
    name: 'API keys',
    input: 'api_key=sk-1234567890abcdef',
    expectRedacted: ['api_key=sk-1234567890abcdef'],
  },
  {
    name: 'Passwords',
    input: 'password: mysecretpass123',
    expectRedacted: ['password: mysecretpass123'],
  },
  {
    name: 'Street addresses',
    input: 'I live at 123 Main Street',
    expectRedacted: ['123 Main Street'],
  },
  // NOTE: Name redaction is OFF by default in TS SDK (unlike Python)
  // Python has well-known names list (11,546 names), TS does not
];

// ============================================
// Run Tests
// ============================================

console.log('\n🔒 PII REDACTION TEST\n');
console.log('='.repeat(60));

// Use default options (redactNames: false in TS, unlike Python which defaults to true)
const plugin = createPiiPlugin();

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  console.log(`\nTest: ${tc.name}`);
  console.log(`  Input: "${tc.input}"`);

  // Create a mock trace object to test
  const trace = {
    traceId: 'test',
    provider: 'openai' as const,
    model: 'test',
    input: tc.input,
    output: tc.input,
    startTime: Date.now(),
  };

  // Run plugin
  plugin.onTrace?.(trace);

  const result = String(trace.input);
  console.log(`  Output: "${result}"`);

  // Check if all expected values are redacted
  let allRedacted = true;
  for (const expected of tc.expectRedacted) {
    if (result.includes(expected)) {
      console.log(`  ✗ FAIL: "${expected}" not redacted`);
      allRedacted = false;
    }
  }

  // Check that <REDACTED> appears
  if (!result.includes('<REDACTED>') && tc.expectRedacted.length > 0) {
    console.log(`  ✗ FAIL: No <REDACTED> token found`);
    allRedacted = false;
  }

  if (allRedacted) {
    console.log(`  ✓ PASS`);
    passed++;
  } else {
    failed++;
  }
}

console.log('\n' + '='.repeat(60));
console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('\n✓ All PII patterns properly redacted!\n');
