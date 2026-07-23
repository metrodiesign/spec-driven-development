import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // .claude/workflows/**: Workflow-tool scripts, not plain JS modules — the harness wraps the body
    // in an async function, so top-level await/return here are valid by that contract, not ESLint's.
    // [#workflow-script-eslint-ignore] (.ai/shared/LESSONS.md, LESSONS-COVERAGE.md)
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'console/web/dist/**',
      '.claude/workflows/**',
      '**/.claude/worktrees/**',
    ],
  },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
