import type { MainPaneContent } from "./panes/main-pane"

export class MainPreviewGate {
  private generation = 0
  private requestedIdentity = ""

  constructor(
    private readonly sink: {
      readonly install: (content: MainPaneContent) => void
      readonly setLoading: (loading: boolean) => void
      readonly reportError: (error: unknown) => void
    },
  ) {}

  installSynchronous(content: MainPaneContent): void {
    this.generation += 1
    this.requestedIdentity = `${content.source}:${content.stableId}`
    this.sink.setLoading(false)
    this.sink.install(content)
  }

  async request<T>(
    source: MainPaneContent["source"],
    stableId: string,
    load: () => Promise<T>,
    present: (value: T) => MainPaneContent,
  ): Promise<void> {
    const identity = `${source}:${stableId}`
    const generation = ++this.generation
    this.requestedIdentity = identity
    this.sink.setLoading(true)
    try {
      const value = await load()
      if (generation !== this.generation || this.requestedIdentity !== identity) return
      this.sink.install(present(value))
    } catch (error) {
      if (generation === this.generation && this.requestedIdentity === identity) this.sink.reportError(error)
    } finally {
      if (generation === this.generation && this.requestedIdentity === identity) this.sink.setLoading(false)
    }
  }
}
