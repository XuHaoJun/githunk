import { createCliRenderer } from "@opentui/core"
import { captureEnvironment } from "./acceptance-log"
import { createSelectionSpike } from "./app"

if (process.env.GITHUNK_SPIKE_ENV === "1") {
  process.stderr.write(`${JSON.stringify(captureEnvironment())}\n`)
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: true,
  enableMouseMovement: true,
  targetFps: 30,
})

createSelectionSpike(renderer)
