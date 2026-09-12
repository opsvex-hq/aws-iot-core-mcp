import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            include: ['src/**/*.ts'],
            // Entry points are thin wiring over the tested factory; the AWS ports
            // are integration surface exercised by fakes, not by unit coverage.
            exclude: ['src/index.ts', 'src/http.ts', 'src/aws/clients.ts'],
            thresholds: {
                statements: 85,
                branches: 85,
                functions: 85,
                lines: 85,
            },
        },
    },
});
