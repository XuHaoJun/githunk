import { createCliRenderer } from "@opentui/core"
import { createSelectionSpike } from "./app"

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: true,
  enableMouseMovement: true,
  targetFps: 30,
})

createSelectionSpike(renderer)
