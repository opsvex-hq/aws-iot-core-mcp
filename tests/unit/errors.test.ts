import { describe, expect, it } from 'vitest';

import { formatToolError, isMissingShadow, translateAwsError } from '../../src/aws/errors.js';

class AwsError extends Error {
    public readonly $metadata?: { httpStatusCode?: number };
    constructor(name: string, message = name, httpStatusCode?: number) {
        super(message);
        this.name = name;
        if (httpStatusCode !== undefined) {
            this.$metadata = { httpStatusCode };
        }
    }
}

describe('translateAwsError', () => {
    it('explains a missing resource without blaming the caller', () => {
        const translated = translateAwsError(new AwsError('ResourceNotFoundException'));
        expect(translated.code).toBe('ResourceNotFoundException');
        expect(translated.message).toContain('does not exist');
        expect(translated.retryable).toBe(false);
    });

    it('turns an authorization failure into an actionable hint', () => {
        const translated = translateAwsError(new AwsError('UnauthorizedException'));
        expect(translated.hint).toContain('iot:GetThingShadow');
    });

    it('distinguishes "index not ready" from "no results" and marks it retryable', () => {
        const translated = translateAwsError(new AwsError('IndexNotReadyException'));
        expect(translated.message).toContain('not ready');
        expect(translated.retryable).toBe(true);
    });

    it('explains an invalid fleet-index query', () => {
        const translated = translateAwsError(new AwsError('InvalidQueryException'));
        expect(translated.hint).toContain('attributes.');
    });

    it('marks throttling as retryable', () => {
        expect(translateAwsError(new AwsError('ThrottlingException')).retryable).toBe(true);
    });

    it('keeps the AWS name of an error it has never seen', () => {
        const translated = translateAwsError(new AwsError('SomeBrandNewException', 'kaboom'));
        expect(translated.code).toBe('SomeBrandNewException');
        expect(translated.message).toContain('kaboom');
    });

    it('infers retryability from the HTTP status of an unknown error', () => {
        expect(translateAwsError(new AwsError('Weird', 'x', 503)).retryable).toBe(true);
        expect(translateAwsError(new AwsError('Weird', 'x', 429)).retryable).toBe(true);
        expect(translateAwsError(new AwsError('Weird', 'x', 400)).retryable).toBe(false);
    });

    it('does not crash on a non-error value', () => {
        expect(translateAwsError(undefined).code).toBe('UnknownError');
        expect(translateAwsError('a string').code).toBe('UnknownError');
    });
});

describe('formatToolError', () => {
    it('names the operation, the code and the hint', () => {
        const text = formatToolError(
            translateAwsError(new AwsError('UnauthorizedException')),
            'get_device_shadow',
        );
        expect(text).toContain('get_device_shadow failed (UnauthorizedException)');
        expect(text).toContain('Hint:');
    });

    it('says so when a retry might work', () => {
        const text = formatToolError(translateAwsError(new AwsError('ThrottlingException')), 'list_things');
        expect(text).toContain('transient');
    });

    it('stays quiet about retries for a permanent failure', () => {
        const text = formatToolError(
            translateAwsError(new AwsError('InvalidRequestException')),
            'list_things',
        );
        expect(text).not.toContain('transient');
    });
});

describe('isMissingShadow', () => {
    it('recognises the not-found error the data plane returns', () => {
        expect(isMissingShadow(new AwsError('ResourceNotFoundException'))).toBe(true);
    });

    it('does not swallow other errors', () => {
        expect(isMissingShadow(new AwsError('UnauthorizedException'))).toBe(false);
        expect(isMissingShadow(undefined)).toBe(false);
    });
});
