import type { CommandRecord } from "../domain/command"

export class CommandLog {
  private readonly entries: CommandRecord[] = []

  append(record: CommandRecord): void {
    this.entries.push(record)
  }

  records(): readonly CommandRecord[] {
    return this.entries
  }
}
