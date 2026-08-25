export function parseNulFields(raw: string, width: number): string[][] {
  const values = raw.split("\0")
  const records: string[][] = []
  let fields: string[] = []
  for (const value of values) {
    const field = value.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
    if (field.length === 0 && fields.length === 0) continue
    fields.push(field)
    if (fields.length === width) {
      records.push(fields)
      fields = []
    }
  }
  return records
}
