export type KeyLike = {
  readonly name: string
  readonly sequence?: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
  readonly option?: boolean
  readonly alt?: boolean
  readonly super?: boolean
}

export type KeyStroke = {
  readonly name: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly option: boolean
  readonly super: boolean
}

export type KeyBinding<Action extends string = string> = {
  readonly key: string | KeyLike
  readonly action: Action
}

export type KeymapDefinition<Action extends string = string> = {
  readonly global?: readonly KeyBinding<Action>[]
  readonly contexts?: Readonly<Record<string, readonly KeyBinding<Action>[]>>
  readonly modal?: readonly KeyBinding<Action>[]
}

export type ResolveOptions = {
  readonly context?: string
  readonly modal?: boolean
}

function modifierValue(value: boolean | undefined): boolean {
  return value === true
}

/** Normalize OpenTUI's physical uppercase names to lowercase + Shift. */
export function normalizeKey(key: string | KeyLike): KeyStroke {
  if (typeof key === "string") return parseKeyStroke(key)
  const rawName = key.name
  const isPhysicalUppercase = rawName.length === 1 && rawName >= "A" && rawName <= "Z"
  return {
    name: rawName.toLocaleLowerCase(),
    ctrl: modifierValue(key.ctrl),
    shift: modifierValue(key.shift) || isPhysicalUppercase,
    meta: modifierValue(key.meta),
    option: modifierValue(key.option) || modifierValue(key.alt),
    super: modifierValue(key.super),
  }
}

function parseKeyStroke(value: string): KeyStroke {
  const pieces = value.split("+")
  const rawName = pieces.pop() ?? ""
  const modifiers = new Set(pieces.map((piece) => piece.toLocaleLowerCase()))
  const isPhysicalUppercase = rawName.length === 1 && rawName >= "A" && rawName <= "Z"
  return {
    name: rawName.toLocaleLowerCase(),
    ctrl: modifiers.has("ctrl") || modifiers.has("control"),
    shift: modifiers.has("shift") || isPhysicalUppercase,
    meta: modifiers.has("meta") || modifiers.has("cmd"),
    option: modifiers.has("option") || modifiers.has("alt"),
    super: modifiers.has("super"),
  }
}
function strokeKey(stroke: KeyStroke): string {
  return [stroke.name, stroke.ctrl ? "c" : "", stroke.shift ? "s" : "", stroke.meta ? "m" : "", stroke.option ? "o" : "", stroke.super ? "w" : ""].join("\u0000")
}

/** Throw before dispatch if one context contains the same normalized key twice. */
export function assertNoKeyCollisions<Action extends string>(bindings: readonly KeyBinding<Action>[], context = "global"): void {
  const seen = new Map<string, KeyBinding<Action>>()
  for (const binding of bindings) {
    const normalized = normalizeKey(binding.key)
    const id = strokeKey(normalized)
    const previous = seen.get(id)
    if (previous !== undefined) {
      throw new Error(`Key collision in ${context}: ${displayKey(normalized)} maps to ${previous.action} and ${binding.action}`)
    }
    seen.set(id, binding)
  }
}

function displayKey(key: KeyStroke): string {
  const modifiers = [key.ctrl && "Ctrl", key.shift && "Shift", key.meta && "Meta", key.option && "Option", key.super && "Super"].filter(Boolean)
  return [...modifiers, key.name].join("+")
}

export class Keymap<Action extends string = string> {
  readonly global: readonly KeyBinding<Action>[]
  readonly contexts: Readonly<Record<string, readonly KeyBinding<Action>[]>>
  readonly modal: readonly KeyBinding<Action>[]

  constructor(definition: KeymapDefinition<Action>) {
    this.global = definition.global ?? []
    this.contexts = definition.contexts ?? {}
    this.modal = definition.modal ?? []
    assertNoKeyCollisions(this.global, "global")
    for (const [context, bindings] of Object.entries(this.contexts)) assertNoKeyCollisions(bindings, context)
    assertNoKeyCollisions(this.modal, "modal")
  }

  resolve(key: KeyLike, options: ResolveOptions = {}): KeyBinding<Action> | undefined {
    const normalized = strokeKey(normalizeKey(key))
    // Modals are a hard input boundary: they consume input before pane/global bindings.
    if (options.modal === true) {
      return this.modal.find((binding) => strokeKey(normalizeKey(binding.key)) === normalized)
    }
    const focused = options.context === undefined ? undefined : this.contexts[options.context]?.find((binding) => strokeKey(normalizeKey(binding.key)) === normalized)
    if (focused !== undefined) return focused
    return this.global.find((binding) => strokeKey(normalizeKey(binding.key)) === normalized)
  }

  dispatch(key: KeyLike, options: ResolveOptions = {}): Action | undefined {
    return this.resolve(key, options)?.action
  }
}

export function createKeymap<Action extends string>(definition: KeymapDefinition<Action>): Keymap<Action> {
  return new Keymap(definition)
}

const PANE_NAVIGATION: readonly KeyBinding[] = [
  { key: "j", action: "next" },
  { key: "k", action: "previous" },
  { key: "down", action: "next" },
  { key: "up", action: "previous" },
]

export const CORE_KEYMAP: KeymapDefinition = {
  global: [
    ...["0", "1", "2", "3", "4", "5"].map((key) => ({ key, action: `focus:${key}` })),
    { key: "/", action: "filter" },
    { key: "space", action: "context-action" },
    { key: "enter", action: "inspect" },
    { key: "escape", action: "back" },
    { key: "R", action: "refresh" },
    { key: "f", action: "fetch" },
    { key: "p", action: "pull" },
    { key: "P", action: "push" },
    { key: "c", action: "commit" },
    { key: "A", action: "amend" },
    { key: "@", action: "command-log" },
    { key: "ctrl+o", action: "copy-exact" },
    { key: "y", action: "copy-menu" },
    { key: "q", action: "quit" },
    { key: "ctrl+c", action: "quit" },
  ],
  contexts: {
    panes: PANE_NAVIGATION,
    main: PANE_NAVIGATION,
    status: PANE_NAVIGATION,
    files: PANE_NAVIGATION,
    branches: PANE_NAVIGATION,
    commits: PANE_NAVIGATION,
    stash: PANE_NAVIGATION,
    "command-log": PANE_NAVIGATION,
  },
  modal: [
    { key: "escape", action: "back" },
    { key: "enter", action: "inspect" },
    { key: "backspace", action: "filter-backspace" },
  ],
}
