/**
 * Triage engine tests — T025, T025b, T026.
 *
 * Verifies:
 *   - Aho-Corasick keyword classification (trivial vs complex)
 *   - AST cyclomatic scan (threshold 15)
 *   - Adversarial sanitization strips inflation vectors
 *   - Obfuscated prompts classified correctly after sanitization
 *
 * Ported from upstream tests/unit/triage-engine.test.ts (vitest) to node:test, with a shim for
 * the matchers it uses. The RouterPipeline cases went with the pipeline: each keeps the triage
 * verdict its prompt had to produce, and the pipeline's wall-clock latency budget is dropped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CYCLOMATIC_THRESHOLD,
  cyclomaticScan,
  sanitize,
  triage,
} from '../src/triage/triage-engine.ts';
import {
  checkEntropyTail,
  normalizedTokenEntropy,
  tokenizeForEntropy,
} from '../src/triage/entropy-check.ts';

// ─── The vitest matchers these tests use ──────────────────────────────────────

function expect(actual: unknown, message?: string) {
  const text = (): string => {
    assert.equal(typeof actual, 'string', message);
    return actual as string;
  };
  const number = (): number => {
    assert.equal(typeof actual, 'number', message);
    return actual as number;
  };
  const shown = JSON.stringify(actual);
  return {
    toBe(expected: unknown): void {
      assert.strictEqual(actual, expected, message);
    },
    toContain(expected: string): void {
      assert.ok(text().includes(expected), message ?? `${shown} should contain ${JSON.stringify(expected)}`);
    },
    toBeGreaterThan(bound: number): void {
      assert.ok(number() > bound, message ?? `${shown} should be > ${bound}`);
    },
    toBeGreaterThanOrEqual(bound: number): void {
      assert.ok(number() >= bound, message ?? `${shown} should be >= ${bound}`);
    },
    toHaveProperty(key: string): void {
      assert.ok(typeof actual === 'object' && actual !== null && key in actual, message ?? `${shown} should have ${key}`);
    },
    not: {
      toContain(expected: string): void {
        assert.ok(!text().includes(expected), message ?? `${shown} should not contain ${JSON.stringify(expected)}`);
      },
    },
  };
}

// ─── T026: Adversarial Sanitization ──────────────────────────────────────────

describe('sanitize (T026)', () => {
  it('strips base64-encoded blocks', () => {
    const base64 = 'A'.repeat(80);
    const result = sanitize(`Fix this ${base64} file`);
    expect(result).not.toContain(base64);
    expect(result).toContain('Fix this');
    expect(result).toContain('file');
  });

  it('strips long hex strings', () => {
    const hex = 'a1b2c3d4'.repeat(8);
    const result = sanitize(`Debug ${hex} issue`);
    expect(result).not.toContain(hex);
    expect(result).toContain('Debug');
  });

  it('strips HTML tags', () => {
    const result = sanitize('Fix <div class="big">the</div> bug');
    expect(result).not.toContain('<div');
    expect(result).not.toContain('</div>');
    expect(result).toContain('Fix');
    expect(result).toContain('the');
    expect(result).toContain('bug');
  });

  it('strips HTML comments', () => {
    const result = sanitize('Task <!-- hidden complex payload --> here');
    expect(result).not.toContain('hidden complex payload');
    expect(result).toContain('Task');
    expect(result).toContain('here');
  });

  it('removes URL-encoded sequences', () => {
    const result = sanitize('Rename%20the%20variable');
    expect(result).not.toContain('%20');
    expect(result).toContain('Renamethe');
  });

  it('collapses repeated characters', () => {
    const result = sanitize('Format this!!!!!!!!!! file');
    expect(result).toBe('Format this!! file');
  });

  it('normalizes horizontal whitespace without destroying newlines', () => {
    const result = sanitize('line one\n    indented\n      deep');
    expect(result).toContain('\n');
    expect(result).toContain('indented');
  });

  it('leaves clean text substantially unchanged', () => {
    const clean = 'Format this JSON file';
    expect(sanitize(clean)).toBe(clean);
  });

  it('handles empty string', () => {
    expect(sanitize('')).toBe('');
  });
});

// ─── T025: Aho-Corasick Keyword Classification ──────────────────────────────

describe('triage keyword scan (T025)', () => {
  describe('trivial prompts', () => {
    for (const [prompt, expectedReason] of [
      ['Format this JSON file', 'keyword_economical'],
      ['Lint the codebase', 'keyword_economical'],
      ['Rename the variable from foo to bar', 'keyword_economical'],
      ['Fix the typo in the README', 'keyword_economical'],
      ['Sort imports in the module', 'keyword_economical'],
      ['Add export for the helper function', 'keyword_economical'],
      ['Fix whitespace in the config', 'keyword_economical'],
      ['Remove unused import', 'keyword_economical'],
    ] as const) {
      it(`classifies "${prompt}" as trivial (${expectedReason})`, () => {
        const result = triage(prompt);
        expect(result.verdict).toBe('trivial');
        expect(result.reason_code).toBe(expectedReason);
        expect(result.trivial_hits).toBeGreaterThan(0);
      });
    }
  });

  describe('complex prompts', () => {
    for (const [prompt, expectedReason] of [
      ['Debug the memory leak in the WebSocket handler', 'keyword_frontier'],
      ['Architect a distributed caching system', 'keyword_frontier'],
      ['Refactor the authentication module', 'keyword_frontier'],
      ['Fix the race condition in the worker pool', 'keyword_frontier'],
      ['Design a state machine for the checkout flow', 'keyword_frontier'],
      ['Investigate the deadlock in concurrent writes', 'keyword_frontier'],
      ['Optimize the algorithm for large datasets', 'keyword_frontier'],
    ] as const) {
      it(`classifies "${prompt}" as complex (${expectedReason})`, () => {
        const result = triage(prompt);
        expect(result.verdict).toBe('complex');
        expect(result.reason_code).toBe(expectedReason);
        expect(result.complex_hits).toBeGreaterThan(0);
      });
    }
  });

  describe('repo-hygiene / destructive-intent (SP-176, #97)', () => {
    for (const prompt of [
      'help me clean up mistakenly added files in the repo',
      'Help me clean up the repo',
      'Please cleanup the repo after the accidental add',
      'Unstage the mistakenly added files',
      'Do not force push or run rm -rf on production',
    ]) {
      it(`classifies "${prompt}" as complex (keyword_frontier)`, () => {
        const result = triage(prompt);
        expect(result.verdict).toBe('complex');
        expect(result.reason_code).toBe('keyword_frontier');
        expect(result.complex_hits).toBeGreaterThan(0);
      });
    }
  });

  describe('ambiguous prompts', () => {
    it('classifies generic prompt as ambiguous', () => {
      const result = triage('Hello, how are you?');
      expect(result.verdict).toBe('ambiguous');
      expect(result.reason_code).toBe('no_fast_path');
    });

    it('classifies empty prompt as ambiguous', () => {
      const result = triage('');
      expect(result.verdict).toBe('ambiguous');
      expect(result.reason_code).toBe('empty_prompt');
    });

    it('classifies whitespace-only prompt as ambiguous', () => {
      const result = triage('   \n\n  ');
      expect(result.verdict).toBe('ambiguous');
      expect(result.reason_code).toBe('empty_prompt');
    });
  });

  describe('word boundary enforcement', () => {
    it('does not match "format" inside "information"', () => {
      const result = triage('Gather information about the project');
      expect(result.trivial_hits).toBe(0);
    });

    it('does not match "lint" inside "splinter"', () => {
      const result = triage('Fix the splinter issue');
      expect(result.trivial_hits).toBe(0);
    });

    it('does not match "debug" inside "debugger" when "debugging" is present', () => {
      const result = triage('The debugging session found issues');
      expect(result.complex_hits).toBe(1);
    });
  });

  describe('mixed signals', () => {
    it('resolves to dominant set when complex > trivial', () => {
      const result = triage(
        'Refactor the architecture and fix the race condition, then format the output',
      );
      expect(result.verdict).toBe('complex');
      expect(result.complex_hits).toBeGreaterThan(result.trivial_hits);
    });

    it('resolves to dominant set when trivial > complex', () => {
      const result = triage(
        'Format the file, fix the typo, rename the variable, and lint the module to debug one thing',
      );
      expect(result.verdict).toBe('trivial');
      expect(result.trivial_hits).toBeGreaterThan(result.complex_hits);
    });
  });
});

// ─── T025b: AST Cyclomatic Scan ─────────────────────────────────────────────

describe('cyclomaticScan (T025b)', () => {
  it('returns baseline 1 for text without code', () => {
    expect(cyclomaticScan('Just a plain text prompt')).toBe(1);
  });

  it('counts decision points in fenced code blocks', () => {
    const prompt = [
      'Review this function:',
      '```typescript',
      'function process(items: string[]) {',
      '  for (const item of items) {',
      '    if (item.length > 0) {',
      '      console.log(item);',
      '    }',
      '  }',
      '}',
      '```',
    ].join('\n');
    const score = cyclomaticScan(prompt);
    expect(score).toBe(3); // 1 base + for + if
  });

  it('counts logical operators as decision points', () => {
    const prompt = [
      '```js',
      'if (a && b || c) {',
      '  return true;',
      '}',
      '```',
    ].join('\n');
    const score = cyclomaticScan(prompt);
    expect(score).toBe(4); // 1 base + if + && + ||
  });

  it('detects high cyclomatic complexity above threshold', () => {
    const branches = Array.from(
      { length: 16 },
      (_, i) => `  if (x === ${i}) { return ${i}; }`,
    ).join('\n');
    const prompt = `\`\`\`ts\nfunction f(x: number) {\n${branches}\n}\n\`\`\``;
    const score = cyclomaticScan(prompt);
    expect(score).toBeGreaterThanOrEqual(CYCLOMATIC_THRESHOLD);
  });

  it('falls back to indented blocks when no fences', () => {
    const prompt = [
      'Check this code:',
      '',
      '    if (a) {',
      '        for (const b of items) {',
      '            if (b && c) {',
      '                handle();',
      '            }',
      '        }',
      '    }',
    ].join('\n');
    const score = cyclomaticScan(prompt);
    expect(score).toBeGreaterThan(1);
  });

  it('counts Python-style elif', () => {
    const prompt = [
      '```python',
      'if x > 0:',
      '    pass',
      'elif x < 0:',
      '    pass',
      '```',
    ].join('\n');
    const score = cyclomaticScan(prompt);
    expect(score).toBe(3); // 1 base + if + elif
  });

  it('counts switch/case statements', () => {
    const prompt = [
      '```ts',
      'switch (action) {',
      '  case "start": break;',
      '  case "stop": break;',
      '  case "pause": break;',
      '}',
      '```',
    ].join('\n');
    const score = cyclomaticScan(prompt);
    expect(score).toBe(4); // 1 base + 3 cases
  });

  it('counts catch blocks', () => {
    const prompt = [
      '```ts',
      'try {',
      '  riskyOp();',
      '} catch (e) {',
      '  handle(e);',
      '}',
      '```',
    ].join('\n');
    const score = cyclomaticScan(prompt);
    expect(score).toBe(2); // 1 base + catch
  });

  it('counts nullish coalescing', () => {
    const prompt = [
      '```ts',
      'const x = a ?? b ?? c;',
      '```',
    ].join('\n');
    const score = cyclomaticScan(prompt);
    expect(score).toBe(3); // 1 base + 2 ??
  });
});

// ─── Triage verdict with cyclomatic ──────────────────────────────────────────

describe('triage with cyclomatic override', () => {
  it('classifies high-cyclomatic code as complex regardless of keywords', () => {
    const branches = Array.from(
      { length: 16 },
      (_, i) => `  if (x === ${i}) { return ${i}; }`,
    ).join('\n');
    const prompt = `Format this:\n\`\`\`ts\nfunction f(x: number) {\n${branches}\n}\n\`\`\``;
    const result = triage(prompt);
    expect(result.verdict).toBe('complex');
    expect(result.reason_code).toBe('cyclomatic_high');
    expect(result.cyclomatic_score).toBeGreaterThanOrEqual(CYCLOMATIC_THRESHOLD);
  });
});

// ─── Obfuscated / adversarial prompts ────────────────────────────────────────

describe('obfuscated prompt classification', () => {
  it('classifies trivial prompt with base64 padding correctly', () => {
    const padding = 'A'.repeat(100);
    const result = triage(`Format the file ${padding}`);
    expect(result.verdict).toBe('trivial');
    expect(result.reason_code).toBe('keyword_economical');
    expect(result.sanitized_length_delta).toBeGreaterThan(0);
  });

  it('classifies complex prompt with HTML noise correctly', () => {
    const result = triage(
      '<div><span>Debug</span></div> the <b>memory leak</b> in the handler',
    );
    expect(result.verdict).toBe('complex');
    expect(result.reason_code).toBe('keyword_frontier');
  });

  it('classifies trivial prompt with repeated char inflation correctly', () => {
    const result = triage('Lint!!!!!!!!!!! the codebase!!!!!!!!!!!');
    expect(result.verdict).toBe('trivial');
    expect(result.sanitized_length_delta).toBeGreaterThan(0);
  });

  it('classifies complex prompt hidden in HTML comments correctly', () => {
    const result = triage(
      'Format the file <!-- architect distributed microservices -->',
    );
    expect(result.verdict).toBe('trivial');
    expect(result.reason_code).toBe('keyword_economical');
    expect(result.sanitized_length_delta).toBeGreaterThan(0);
  });

  it('handles prompt with long hex and actual keywords', () => {
    const hex = 'deadbeef'.repeat(8);
    const result = triage(`Refactor ${hex} the module architecture`);
    expect(result.verdict).toBe('complex');
    expect(result.sanitized_length_delta).toBeGreaterThan(0);
  });
});

// ─── TriageResult shape ──────────────────────────────────────────────────────

describe('TriageResult contract', () => {
  it('returns all required fields', () => {
    const result = triage('Format this file');
    expect(result).toHaveProperty('verdict');
    expect(result).toHaveProperty('reason_code');
    expect(result).toHaveProperty('trivial_hits');
    expect(result).toHaveProperty('complex_hits');
    expect(result).toHaveProperty('cyclomatic_score');
    expect(result).toHaveProperty('sanitized_length_delta');
    expect(result).toHaveProperty('entropy_score');
    expect(result).toHaveProperty('entropy_tail_delta');
    expect(result).toHaveProperty('entropy_tail_stripped_length');
  });

  it('returns non-negative numeric fields', () => {
    const result = triage('Debug the issue');
    expect(result.trivial_hits).toBeGreaterThanOrEqual(0);
    expect(result.complex_hits).toBeGreaterThanOrEqual(0);
    expect(result.cyclomatic_score).toBeGreaterThanOrEqual(0);
    expect(result.sanitized_length_delta).toBeGreaterThanOrEqual(0);
    expect(result.entropy_score).toBeGreaterThanOrEqual(0);
    expect(result.entropy_tail_stripped_length).toBeGreaterThanOrEqual(0);
  });
});

// ─── SP-154: Entropy tail anomaly detection ──────────────────────────────────

/** GCG-style high-entropy adversarial suffix (unique single-char tokens). */
function makeAdversarialSuffix(tokenCount = 24): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const tokens: string[] = [];
  for (let i = 0; i < tokenCount; i++) {
    tokens.push(chars[i % chars.length]! + String(i));
  }
  return tokens.join(' ');
}

describe('entropy tail check (SP-154)', () => {
  it('detects high normalized entropy on adversarial suffix tokens', () => {
    const tokens = tokenizeForEntropy(makeAdversarialSuffix(24));
    const entropy = normalizedTokenEntropy(tokens);
    expect(entropy).toBeGreaterThan(0.85);
  });

  it('strips high-entropy suffix appended to trivial prompt', () => {
    const suffix = makeAdversarialSuffix(24);
    const prompt = `Format this JSON file please review ${suffix}`;
    const result = checkEntropyTail(prompt);

    expect(result.anomaly_detected).toBe(true);
    expect(result.tail_stripped_length).toBeGreaterThan(0);
    expect(result.text).toContain('Format this JSON file');
    expect(result.text).not.toContain(suffix.slice(0, 8));
  });

  it('classifies trivial prompt correctly after adversarial suffix strip', () => {
    const suffix = makeAdversarialSuffix(24);
    const result = triage(`Format this JSON file ${suffix}`);
    expect(result.verdict).toBe('trivial');
    expect(result.reason_code).toBe('keyword_economical');
    expect(result.entropy_tail_stripped_length).toBeGreaterThan(0);
  });

  it('classifies complex prompt correctly after adversarial suffix strip', () => {
    const suffix = makeAdversarialSuffix(24);
    const result = triage(`Debug the memory leak in handler ${suffix}`);
    expect(result.verdict).toBe('complex');
    expect(result.reason_code).toBe('keyword_frontier');
    expect(result.entropy_tail_stripped_length).toBeGreaterThan(0);
  });

  it('does not strip normal English tail on typical prompts', () => {
    const normalPrompts = [
      'Format this JSON file',
      'Lint the codebase',
      'Debug the memory leak in the WebSocket handler',
      'Architect a distributed caching system',
      'Hello, how are you today?',
      'Refactor the authentication module',
      'Rename the variable from foo to bar',
    ];

    for (const prompt of normalPrompts) {
      const entropy = checkEntropyTail(prompt);
      expect(entropy.anomaly_detected, prompt).toBe(false);
      expect(entropy.tail_stripped_length, prompt).toBe(0);
      expect(entropy.text, prompt).toBe(prompt);
    }
  });

  it('preserves triage verdicts on normal prompts corpus sample', () => {
    const expectations: Array<[string, 'trivial' | 'complex' | 'ambiguous', string]> = [
      ['Format this JSON file', 'trivial', 'keyword_economical'],
      ['Lint the codebase', 'trivial', 'keyword_economical'],
      ['Debug the memory leak in the WebSocket handler', 'complex', 'keyword_frontier'],
      ['Architect a distributed caching system', 'complex', 'keyword_frontier'],
      ['Hello, how are you today?', 'ambiguous', 'no_fast_path'],
      ['Refactor the authentication module', 'complex', 'keyword_frontier'],
    ];

    for (const [prompt, verdict, reason] of expectations) {
      const result = triage(prompt);
      expect(result.verdict, prompt).toBe(verdict);
      expect(result.reason_code, prompt).toBe(reason);
      expect(result.entropy_tail_stripped_length, prompt).toBe(0);
    }
  });

  it('exports entropy metrics on every triage result', () => {
    const suffix = makeAdversarialSuffix(24);
    const result = triage(`Format this file ${suffix}`);
    expect(result.entropy_score).toBeGreaterThan(0);
    expect(result.entropy_tail_delta).toBeGreaterThan(0);
  });
});

// ─── T027/T028: pipeline fixtures ────────────────────────────────────────────
// Upstream drove these prompts through RouterPipeline, which the port deletes. Each case keeps the
// triage verdict its prompt had to produce for the pipeline to take the fast path or fall through.

describe('pipeline fixtures keep their triage verdicts (T027, T028)', () => {
  const fixtures: Array<[string, 'trivial' | 'complex' | 'ambiguous', string]> = [
    ['Format this JSON file', 'trivial', 'keyword_economical'],
    ['Lint the codebase', 'trivial', 'keyword_economical'],
    ['Debug the memory leak in the WebSocket handler', 'complex', 'keyword_frontier'],
    ['Architect a distributed caching system', 'complex', 'keyword_frontier'],
    ['help me clean up mistakenly added files in the repo', 'complex', 'keyword_frontier'],
    ['Hello, how are you today?', 'ambiguous', 'no_fast_path'],
    ['', 'ambiguous', 'empty_prompt'],
    ['Format this file', 'trivial', 'keyword_economical'],
    ['Debug the deadlock in concurrent writes', 'complex', 'keyword_frontier'],
    ['Rename the variable', 'trivial', 'keyword_economical'],
    ['Lint the code', 'trivial', 'keyword_economical'],
    ['Refactor the authentication module', 'complex', 'keyword_frontier'],
  ];

  for (const [prompt, verdict, reason] of fixtures) {
    it(`classifies ${JSON.stringify(prompt)} as ${verdict} (${reason})`, () => {
      const result = triage(prompt);
      expect(result.verdict, prompt).toBe(verdict);
      expect(result.reason_code, prompt).toBe(reason);
    });
  }
});
