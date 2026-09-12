/**
 * AWS error translation.
 *
 * A raw `ResourceNotFoundException` tells a model almost nothing, and an
 * `IndexNotReadyException` tells it something actively misleading (the thing
 * exists; the *index* does not). Each known failure is mapped to a stable code,
 * a plain sentence, and — where one exists — the exact operator action that
 * fixes it.
 *
 * Unknown errors are passed through with their AWS name intact rather than
 * flattened into "something went wrong": an error we have not seen before is
 * information, not noise.
 */

export interface TranslatedError {
    /** Stable code for audit logs and tests. */
    code: string;
    /** One sentence for the model. */
    message: string;
    /** Operator action, when there is a concrete one. */
    hint?: string;
    /** True when retrying the same call could plausibly succeed. */
    retryable: boolean;
}

interface AwsErrorLike {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
}

const TRANSLATIONS: Record<string, Omit<TranslatedError, 'code'>> = {
    ResourceNotFoundException: {
        message: 'The requested resource does not exist in this account and region.',
        hint: 'Check the name and that the server points at the right region.',
        retryable: false,
    },
    UnauthorizedException: {
        message: 'The IAM identity used by this server is not allowed to perform that read.',
        hint: 'Grant the specific read action (for example iot:GetThingShadow) to the role.',
        retryable: false,
    },
    AccessDeniedException: {
        message: 'The IAM identity used by this server is not allowed to perform that read.',
        hint: 'Grant the specific read action to the role; see docs/SECURITY-MODEL.md for the minimal policy.',
        retryable: false,
    },
    ForbiddenException: {
        message: 'AWS refused the request as forbidden.',
        hint: 'Usually a missing IAM permission or a data-plane endpoint in the wrong region.',
        retryable: false,
    },
    InvalidRequestException: {
        message: 'AWS rejected the request as invalid.',
        retryable: false,
    },
    IndexNotReadyException: {
        message: 'The fleet index exists but is not ready yet, so search cannot answer.',
        hint: 'Wait for indexing to finish building; it can take several minutes after being enabled.',
        retryable: true,
    },
    InvalidQueryException: {
        message: 'The fleet-index query string is not valid.',
        hint: 'See the AWS fleet indexing query syntax; attribute searches need attributes.<name>:<value>.',
        retryable: false,
    },
    ThrottlingException: {
        message: 'AWS throttled the request.',
        hint: 'Reduce page size or the number of things inspected per call.',
        retryable: true,
    },
    LimitExceededException: {
        message: 'An AWS service limit was exceeded for this request.',
        retryable: true,
    },
    ServiceUnavailableException: {
        message: 'The AWS IoT service is temporarily unavailable.',
        retryable: true,
    },
    InternalFailureException: {
        message: 'AWS reported an internal failure for this request.',
        retryable: true,
    },
    ThrottledException: {
        message: 'AWS throttled the request.',
        retryable: true,
    },
    CredentialsProviderError: {
        message: 'No AWS credentials could be resolved.',
        hint: 'Set AWS_PROFILE, provide standard AWS_* variables, or attach a task/instance role.',
        retryable: false,
    },
};

/** Maps an unknown thrown value to a stable, explainable shape. */
export function translateAwsError(error: unknown): TranslatedError {
    const awsError = (error ?? {}) as AwsErrorLike;
    const name = typeof awsError.name === 'string' ? awsError.name : 'UnknownError';
    const known = TRANSLATIONS[name];

    if (known !== undefined) {
        return { code: name, ...known };
    }

    const status = awsError.$metadata?.httpStatusCode;
    const retryable = status !== undefined && (status === 429 || status >= 500);
    const detail = typeof awsError.message === 'string' && awsError.message !== '' ? awsError.message : name;

    return {
        code: name,
        message: `AWS returned an unexpected error: ${detail}`,
        retryable,
    };
}

/** Renders a translated error as the text a tool returns to the client. */
export function formatToolError(error: TranslatedError, operation: string): string {
    const lines = [`${operation} failed (${error.code}): ${error.message}`];
    if (error.hint !== undefined) {
        lines.push(`Hint: ${error.hint}`);
    }
    if (error.retryable) {
        lines.push('This error is transient; the same call may succeed on retry.');
    }
    return lines.join('\n');
}

/** True when the error means "this thing has no shadow yet", not a failure. */
export function isMissingShadow(error: unknown): boolean {
    const awsError = (error ?? {}) as AwsErrorLike;
    return awsError.name === 'ResourceNotFoundException';
}
