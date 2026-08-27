import { join, basename } from "node:path"
import type { GitRunner } from "./runner"

/**
 * Mirrors lazygit's editor preset resolution (pkg/config/editor_presets.go) in a
 * minimal, config-file-free form. Only the editing side is needed for the
 * `e` keybinding; `o` (open) is handled separately via the desktop opener.
 *
 * Each preset is a pair of `{{filename}}` / `{{line}}` templates together with
 * whether githunk must suspend the TUI while the editor runs. The `suspend`
 * flag is lazygit's `OSConfig.SuspendOnEdit` / `preset.suspend()` (editor_presets.go:193-198):
 * terminal editors need the screen back, GUI editors do not.
 */
export type EditCommand = {
  readonly cmd: string
  readonly suspend: boolean
}

type Preset = {
  readonly edit: string
  readonly editAtLine: string
  readonly suspend: boolean
}

function standardTerminalPreset(editor: string): Preset {
  return {
    edit: `${editor} -- {{filename}}`,
    editAtLine: `${editor} +{{line}} -- {{filename}}`,
    suspend: true,
  }
}

function presetForBase(base: string): Preset | undefined {
  // Keep names aligned with getPreset's keys (editor_presets.go:72-154) so a
  // future `GITHUNK_EDIT_PRESET` override can reuse the same canonical names.
  const table: Record<string, Preset> = {
    vi: standardTerminalPreset("vi"),
    vim: standardTerminalPreset("vim"),
    nvim: standardTerminalPreset("nvim"),
    lvim: standardTerminalPreset("lvim"),
    emacs: standardTerminalPreset("emacs"),
    nano: standardTerminalPreset("nano"),
    kakoune: standardTerminalPreset("kak"),
    micro: {
      edit: "micro {{filename}}",
      editAtLine: "micro +{{line}} {{filename}}",
      suspend: true,
    },
    helix: {
      edit: "helix -- {{filename}}",
      editAtLine: "helix -- {{filename}}:{{line}}",
      suspend: true,
    },
    "helix (hx)": {
      edit: "hx -- {{filename}}",
      editAtLine: "hx -- {{filename}}:{{line}}",
      suspend: true,
    },
    vscode: {
      edit: "code --reuse-window -- {{filename}}",
      editAtLine: "code --reuse-window --goto -- {{filename}}:{{line}}",
      suspend: false,
    },
    sublime: {
      edit: "subl -- {{filename}}",
      editAtLine: "subl -- {{filename}}:{{line}}",
      suspend: false,
    },
    bbedit: {
      edit: "bbedit -- {{filename}}",
      editAtLine: "bbedit +{{line}} -- {{filename}}",
      suspend: false,
    },
    xcode: {
      edit: "xed -- {{filename}}",
      editAtLine: "xed --line {{line}} -- {{filename}}",
      suspend: false,
    },
    zed: {
      edit: "zed -- {{filename}}",
      editAtLine: "zed -- {{filename}}:{{line}}",
      suspend: false,
    },
    acme: {
      edit: "B {{filename}}",
      editAtLine: "B {{filename}}:{{line}}",
      suspend: false,
    },
  }
  if (table[base] !== undefined) return table[base]
  // Aliases that lazygit normalises via `editorToPreset` (editor_presets.go:157-164).
  const alias: Record<string, string> = {
    kak: "kakoune",
    hx: "helix (hx)",
    code: "vscode",
    subl: "sublime",
    xed: "xcode",
  }
  const canonical = alias[base]
  if (canonical !== undefined) return table[canonical]
  return undefined
}

function shellQuote(arg: string): string {
  if (arg.length === 0) return "''"
  if (/^[a-zA-Z0-9_\/.,:+-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function resolvePlaceholders(template: string, values: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(value)
  }
  return out
}

function guessEditorBase(env: Record<string, string | undefined>, gitEditor?: string): string {
  // Mirrors FileCommands.guessDefaultEditor (pkg/commands/git_commands/file.go:80-100):
  // core.editor → GIT_EDITOR → VISUAL → EDITOR → "vi".
  // GITHUNK_EDITOR is an additional, githunk-specific override that outranks all.
  if (env.GITHUNK_EDITOR !== undefined && env.GITHUNK_EDITOR.trim().length > 0) return basename(env.GITHUNK_EDITOR.split(" ")[0]!.trim())
  if (gitEditor !== undefined && gitEditor.trim().length > 0) return basename(gitEditor.split(" ")[0]!.trim())
  for (const key of ["GIT_EDITOR", "VISUAL", "EDITOR"] as const) {
    const value = env[key]
    if (value !== undefined && value.trim().length > 0) return basename(value.split(" ")[0]!.trim())
  }
  return "vi"
}

function choosePreset(base: string): Preset {
  return presetForBase(base) ?? standardTerminalPreset(base)
}

export async function resolveEditCommand(
  files: readonly string[],
  options: {
    readonly line?: number
    readonly runner?: GitRunner
    readonly env?: Record<string, string | undefined>
    readonly cwd?: string
  } = {},
): Promise<EditCommand> {
  const env = options.env ?? (process.env as Record<string, string | undefined>)
  let gitEditor: string | undefined
  if (options.runner !== undefined) {
    try {
      const result = await options.runner.run(["config", "--get", "core.editor"], { readOnly: true, acceptedExitCodes: [0, 1] })
      const trimmed = result.stdout.trim()
      if (trimmed.length > 0) gitEditor = trimmed
    } catch {
      // No git config or no runner; fall back to env.
    }
  }
  const base = guessEditorBase(env, gitEditor)
  const preset = choosePreset(base)

  // GITHUNK_EDIT / GITHUNK_EDIT_AT_LINE are explicit template overrides (like
  // lazygit's `os.edit` / `os.editAtLine`). When set they take precedence over
  // the preset, which is useful for `code --wait` etc.
  const overrideEdit = env.GITHUNK_EDIT?.trim()
  const overrideEditAtLine = env.GITHUNK_EDIT_AT_LINE?.trim()
  const template = options.line !== undefined
    ? (overrideEditAtLine !== undefined && overrideEditAtLine.length > 0 ? overrideEditAtLine : preset.editAtLine)
    : (overrideEdit !== undefined && overrideEdit.length > 0 ? overrideEdit : preset.edit)

  const quoted = files.map(shellQuote).join(" ")
  const values: Record<string, string> = { filename: quoted }
  if (options.line !== undefined) values.line = String(options.line)

  const cmd = resolvePlaceholders(template, values)

  // Suspend flag can be forced via GITHUNK_EDIT_SUSPEND (like lazygit's
  // `os.editInTerminal`). "0"/"false" → never suspend, "1"/"true" → always.
  const suspendOverride = env.GITHUNK_EDIT_SUSPEND?.trim().toLowerCase()
  let suspend = preset.suspend
  if (suspendOverride === "0" || suspendOverride === "false" || suspendOverride === "no") suspend = false
  else if (suspendOverride === "1" || suspendOverride === "true" || suspendOverride === "yes") suspend = true

  return { cmd, suspend }
}

export function resolveEditorForTests(files: readonly string[], line?: number, env?: Record<string, string | undefined>): Promise<EditCommand> {
  return resolveEditCommand(files, { ...(line === undefined ? {} : { line }), ...(env === undefined ? {} : { env }) })
}

/** Absolute path for a repo-relative file, quoted for the shell template. */
export function absolutePath(repoRoot: string, relativePath: string): string {
  // Paths from githunk's model are already repo-relative (e.g. "src/ui/root-view.ts");
  // `join` handles an already-absolute input as well.
  if (relativePath.startsWith("/")) return relativePath
  return join(repoRoot, relativePath)
}
