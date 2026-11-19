/* AgentGuard mark: the vault seen from the front. Outer brass ring, an open steel lock ring, the agent at the centre. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="14.2" stroke="#D9B26A" strokeWidth="1.5" />
      <path d="M16 6.5a9.5 9.5 0 1 1-8.2 4.7" stroke="#8E99AB" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16" cy="16" r="3" fill="#EEF0F2" />
    </svg>
  );
}

export function Brand({ href = '/' }: { href?: string }) {
  return (
    <a className="brand" href={href}>
      <Mark />
      <span>AgentGuard</span>
    </a>
  );
}
