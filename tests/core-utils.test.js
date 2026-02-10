import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildTimestampToken,
    convertXmlValue,
    fixYAML,
    looksLikeMojibake,
    parseYAML,
    pruneEmptyFields,
    repairMojibake,
    sanitizeFilename,
    validateJSON,
    validateYAML
} from '../src/utils/core-utils.js';

test('parseYAML: parses valid YAML document', () => {
    const result = parseYAML('openapi: "3.0.2"\ninfo:\n  title: Test');
    assert.equal(result.openapi, '3.0.2');
    assert.equal(result.info.title, 'Test');
});

test('parseYAML: throws meaningful error for invalid YAML', () => {
    assert.throws(
        () => parseYAML('openapi: [\ninfo:'),
        /YAML inválido:/
    );
});

test('fixYAML: replaces tabs and normalizes key value lines', () => {
    const fixed = fixYAML('\tname value');
    assert.equal(fixed, '  name: value');
});

test('fixYAML: collapses excessive blank lines', () => {
    const fixed = fixYAML('a: 1\n\n\n\nb: 2');
    assert.equal(fixed, 'a: 1\n\nb: 2');
});

test('validateJSON: returns valid=true for correct JSON', () => {
    assert.deepEqual(validateJSON('{"ok":true}'), { valid: true, error: null });
});

test('validateJSON: returns valid=false for incorrect JSON', () => {
    const result = validateJSON('{"ok":');
    assert.equal(result.valid, false);
    assert.ok(result.error.length > 0);
});

test('validateYAML: returns valid=true for correct YAML', () => {
    assert.deepEqual(validateYAML('a: 1\nb: test'), { valid: true, error: null });
});

test('validateYAML: returns valid=false for incorrect YAML', () => {
    const result = validateYAML('a: [\nb:');
    assert.equal(result.valid, false);
    assert.ok(result.error.length > 0);
});

test('sanitizeFilename: lowercases and replaces unsafe chars', () => {
    assert.equal(
        sanitizeFilename('Customer Person v1.0.yaml'),
        'customer_person_v1.0.yaml'
    );
});

test('pruneEmptyFields: removes empty fields and nested empties', () => {
    const input = {
        a: '',
        b: null,
        c: undefined,
        d: 0,
        e: false,
        f: {
            g: '',
            h: 'ok'
        },
        i: [{ x: '' }, { x: 'v' }]
    };

    assert.deepEqual(pruneEmptyFields(input), {
        d: 0,
        e: false,
        f: { h: 'ok' },
        i: [{ x: 'v' }]
    });
});

test('pruneEmptyFields: returns undefined for fully empty object', () => {
    assert.equal(pruneEmptyFields({ a: '', b: null, c: {} }), undefined);
});

test('buildTimestampToken: generates deterministic formatted token', () => {
    const token = buildTimestampToken(new Date('2026-02-09T17:18:48.567Z'));
    assert.match(token, /^\d{8}_\d{6}_\d{3}$/);
    assert.equal(token.length, 19);
});

test('looksLikeMojibake: detects common UTF-8/latin1 corruption', () => {
    assert.equal(looksLikeMojibake('TelemÃ³vel'), true);
    assert.equal(looksLikeMojibake('Telemóvel'), false);
});

test('repairMojibake: fixes accented words', () => {
    assert.equal(repairMojibake('ResponsÃ¡vel'), 'Responsável');
    assert.equal(repairMojibake('TelemÃ³vel'), 'Telemóvel');
});

test('convertXmlValue: converts numeric, boolean and string types', () => {
    assert.equal(convertXmlValue('42', 'integer'), 42);
    assert.equal(convertXmlValue('true', 'boolean'), true);
    assert.equal(convertXmlValue('hello', 'string'), 'hello');
});

test('convertXmlValue: preserves non-numeric as string for number/integer', () => {
    assert.equal(convertXmlValue('abc', 'number'), 'abc');
});

test('convertXmlValue: fixes mojibake before conversion', () => {
    assert.equal(convertXmlValue('TelemÃ³vel', 'string'), 'Telemóvel');
});

