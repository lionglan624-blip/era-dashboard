const NTSTATUS = {
  C0000005: 'ACCESS_VIOLATION',
  C00000FD: 'STACK_OVERFLOW',
  C0000409: 'STACK_BUFFER_OVERRUN',
  C0000374: 'HEAP_CORRUPTION',
  C0000008: 'INVALID_HANDLE',
  C000001D: 'ILLEGAL_INSTRUCTION',
  40010004: 'DBG_TERMINATE_PROCESS',
};

export function decodeExitCode(code) {
  if (code === 0) return 'OK';
  if (code === 1) return 'SIGINT/normal-exit';
  const hex = (code >>> 0).toString(16).toUpperCase();
  return NTSTATUS[hex] || `0x${hex}`;
}
