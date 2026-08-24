import { describe, expect, test } from "bun:test"
import { AppController } from "../../src/app/controller"
import { GitRunner } from "../../src/git/runner"
import { createTempRepository } from "../helpers/temp-repository"

describe("AppController remote checkout", () => {
  test("preserves review state while exposing branch operations", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("file.txt", "base\n")
      await repository.git(["add", "file.txt"])
      await repository.git(["commit", "-m", "base"])
      const controller = new AppController(new GitRunner(repository.path))
      await controller.refresh()
      expect(controller.state.branch).toBeTruthy()
      expect(controller.state.branches).toBeDefined()
    } finally {
      await repository.cleanup()
    }
  })
})
