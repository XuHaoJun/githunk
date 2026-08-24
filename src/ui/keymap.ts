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

function modifierValue(value: boolean | undefined): boolean {
  return value === true
}

/**
 * OpenTUI reports a physical carriage return (0x0D) with `key.name === "return"`. `enter` is
 * githunk's canonical name for that key, so every declaration and handler can be written once,
 * in terms of `enter`, regardless of what the terminal layer calls it. Only `return` is aliased
 * here: `linefeed` (Ctrl+J on most terminals) is a distinct key and must not collapse into it.
 */
function canonicalName(name: string): string {
  return name === "return" ? "enter" : name
}

/** Normalize OpenTUI's physical uppercase names to lowercase + Shift. */
export function normalizeKey(key: string | KeyLike): KeyStroke {
  if (typeof key === "string") return parseKeyStroke(key)
  const rawName = key.name
  const isPhysicalUppercase = rawName.length === 1 && rawName >= "A" && rawName <= "Z"
  return {
    name: canonicalName(rawName.toLocaleLowerCase()),
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
    name: canonicalName(rawName.toLocaleLowerCase()),
    ctrl: modifiers.has("ctrl") || modifiers.has("control"),
    shift: modifiers.has("shift") || isPhysicalUppercase,
    meta: modifiers.has("meta") || modifiers.has("cmd"),
    option: modifiers.has("option") || modifiers.has("alt"),
    super: modifiers.has("super"),
  }
}
