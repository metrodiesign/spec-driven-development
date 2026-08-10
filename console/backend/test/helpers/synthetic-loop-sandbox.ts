// Synthetic loop scenarios exercise orchestration, not host sandbox availability.
// Real Seatbelt enforcement stays in core's explicit PHASE0_REAL_MACOS_TESTS suite.
export const syntheticLoopSandbox = {
  kind: 'available' as const,
  wrap: ({ shellCmd }: { shellCmd: string }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
};
