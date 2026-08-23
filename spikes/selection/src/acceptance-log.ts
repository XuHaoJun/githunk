export type AcceptanceEnvironment = {
  term: string | null
  termProgram: string | null
  ssh: boolean
  tmux: boolean
  zellij: boolean
  columns: number | null
  rows: number | null
}

export function captureEnvironment(): AcceptanceEnvironment {
  return {
    term: process.env.TERM ?? null,
    termProgram: process.env.TERM_PROGRAM ?? null,
    ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY),
    tmux: Boolean(process.env.TMUX),
    zellij: Boolean(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME),
    columns: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
  }
}
