#!/usr/bin/env node
/**
 * Test Suite: Gemini Model Routing & Free-Tier Fallback Chain
 * Elderly Support League
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const functionsModule = require(path.join(__dirname, '..', 'functions', 'index.js'));
const { MODEL_FALLBACK_CHAIN, KNOWN_PAID_MODELS, isPaidModel, callGeminiWithFallback } = functionsModule;

console.log('='.repeat(70));
console.log('TEST SUITE: GEMINI MODEL ROUTING & FREE-TIER FALLBACK CHAIN');
console.log('='.repeat(70));

// Test 1: Fallback chain structure and free-tier exclusivity
console.log('\n[Test 1] Verifying MODEL_FALLBACK_CHAIN:');
const expectedChain = [
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];
assert.deepStrictEqual(MODEL_FALLBACK_CHAIN, expectedChain, 'MODEL_FALLBACK_CHAIN must match expected order');
console.log('✓ MODEL_FALLBACK_CHAIN contains exact free-tier model sequence:', MODEL_FALLBACK_CHAIN);

// Test 2: Paid Model Guard & Verification
console.log('\n[Test 2] Verifying KNOWN_PAID_MODELS and isPaidModel:');
assert(isPaidModel('gemini-3.6-flash'), 'gemini-3.6-flash must be detected as paid');
assert(isPaidModel('gemini-3.7-flash'), 'gemini-3.7-flash must be detected as paid');
assert(isPaidModel('gemini-1.5-pro'), 'gemini-1.5-pro must be detected as paid');
assert(isPaidModel('gemini-2.5-pro'), 'gemini-2.5-pro must be detected as paid');
assert(!isPaidModel('gemini-3.5-flash'), 'gemini-3.5-flash must NOT be detected as paid');
assert(!isPaidModel('gemini-2.5-flash'), 'gemini-2.5-flash must NOT be detected as paid');
assert(!isPaidModel('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite must NOT be detected as paid');

// Invariant: No paid model in MODEL_FALLBACK_CHAIN
MODEL_FALLBACK_CHAIN.forEach(model => {
  assert(!isPaidModel(model), `Paid model "${model}" must NEVER be in MODEL_FALLBACK_CHAIN`);
});
console.log('✓ Paid model guard correctly classifies paid vs free models.');
console.log('✓ Zero paid models found in MODEL_FALLBACK_CHAIN.');

// Test 3: Parameter Compatibility Audit
console.log('\n[Test 3] Parameter Compatibility Audit:');
const functionsCode = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
assert(!functionsCode.includes('temperature:'), 'functions/index.js must not send temperature');
assert(!functionsCode.includes('top_p:'), 'functions/index.js must not send top_p');
assert(!functionsCode.includes('top_k:'), 'functions/index.js must not send top_k');
assert(!functionsCode.includes('thinking_level:'), 'functions/index.js must not send thinking_level');
assert(functionsCode.includes("responseMimeType: 'application/json'"), 'functions/index.js must use responseMimeType: application/json');
console.log('✓ Request payload emits clean universal generationConfig without temperature/top_p/top_k/thinking_level.');

// Test 4: Model Resolution & Fallback Behavior (Simulated fetch)
console.log('\n[Test 4] Testing Fallback Behavior on Simulated Model Errors:');

async function testResolution() {
  const originalFetch = global.fetch;

  try {
    // Scenario A: Preferred model invalid (404), falls back to first in chain
    const callLog = [];
    global.fetch = async (url, opts) => {
      const match = url.match(/\/models\/([^:]+):generateContent/);
      const model = match ? decodeURIComponent(match[1]) : 'unknown';
      callLog.push(model);

      if (model === 'invalid-bogus-model') {
        return {
          ok: false,
          status: 404,
          text: async () => JSON.stringify({ error: { message: 'models/invalid-bogus-model is not found' } })
        };
      }
      if (model === 'gemini-3.5-flash') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"matchType":"Standard"}' }] } }]
          })
        };
      }
      return { ok: false, status: 500, text: async () => 'Server error' };
    };

    const resA = await callGeminiWithFallback('test-key', 'prompt', 'invalid-bogus-model');
    assert.strictEqual(resA.modelUsed, 'gemini-3.5-flash');
    assert.strictEqual(resA.fellBackFrom, 'invalid-bogus-model');
    assert.deepStrictEqual(callLog, ['invalid-bogus-model', 'gemini-3.5-flash']);
    console.log('✓ 404 on preferred model engaged fallback chain and selected gemini-3.5-flash.');

    // Scenario B: Rate limit (429) stops immediately without walking chain
    const callLog429 = [];
    global.fetch = async (url) => {
      const match = url.match(/\/models\/([^:]+):generateContent/);
      const model = match ? decodeURIComponent(match[1]) : 'unknown';
      callLog429.push(model);
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: 'Rate limit exceeded' } })
      };
    };

    let threw429 = false;
    try {
      await callGeminiWithFallback('test-key', 'prompt', 'gemini-3.5-flash');
    } catch (e) {
      threw429 = true;
      assert(e.code === 'resource-exhausted' || e.message.includes('429'), 'Must throw resource-exhausted on 429');
    }
    assert(threw429, '429 must throw an error');
    assert.strictEqual(callLog429.length, 1, '429 MUST NOT cycle through the remaining models in the chain');
    console.log('✓ 429 rate limit halted execution immediately without walking the chain.');

    // Scenario C: Invalid API Key (401) stops immediately without walking chain
    const callLog401 = [];
    global.fetch = async (url) => {
      const match = url.match(/\/models\/([^:]+):generateContent/);
      const model = match ? decodeURIComponent(match[1]) : 'unknown';
      callLog401.push(model);
      return {
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'API key invalid' } })
      };
    };

    let threw401 = false;
    try {
      await callGeminiWithFallback('bad-key', 'prompt', 'gemini-3.5-flash');
    } catch (e) {
      threw401 = true;
      assert(e.code === 'unauthenticated' || e.message.includes('invalid'), 'Must throw unauthenticated on bad key');
    }
    assert(threw401, '401 must throw an error');
    assert.strictEqual(callLog401.length, 1, '401 MUST NOT cycle through the remaining models in the chain');
    console.log('✓ Invalid API key (401) halted execution immediately without walking the chain.');

    // Scenario D: Chain walk when primary and secondary are 404/400
    const callLogChain = [];
    global.fetch = async (url) => {
      const match = url.match(/\/models\/([^:]+):generateContent/);
      const model = match ? decodeURIComponent(match[1]) : 'unknown';
      callLogChain.push(model);

      if (model === 'gemini-3.5-flash' || model === 'gemini-3.1-flash-lite') {
        return { ok: false, status: 404, text: async () => 'Not found' };
      }
      if (model === 'gemini-2.5-flash') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"status":"ok"}' }] } }]
          })
        };
      }
      return { ok: false, status: 500, text: async () => 'Server error' };
    };

    const resD = await callGeminiWithFallback('test-key', 'prompt', 'gemini-3.5-flash');
    assert.strictEqual(resD.modelUsed, 'gemini-2.5-flash');
    assert.strictEqual(resD.fellBackFrom, 'gemini-3.5-flash');
    assert.deepStrictEqual(callLogChain, ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash']);
    console.log('✓ Walked fallback chain [3.5-flash (404) -> 3.1-flash-lite (404) -> 2.5-flash (200 OK)] successfully.');

  } finally {
    global.fetch = originalFetch;
  }
}

testResolution().then(() => {
  console.log('\n' + '='.repeat(70));
  console.log('🎉 ALL GEMINI MODEL ROUTING & FALLBACK CHAIN TESTS PASSED!');
  console.log('='.repeat(70));
  process.exit(0);
}).catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
