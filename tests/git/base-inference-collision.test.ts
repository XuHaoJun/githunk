import { describe, expect, test } from "bun:test"
import { createTempRepository } from "../helpers/temp-repository"
import { GitRunner } from "../../src/git/runner"
import { inferReviewBase } from "../../src/git/base-inference"

describe("base ref identity", () => {
  test("keeps remote namespace when a local branch has the same short name", async () => {
    const repository = await createTempRepository()
    try {
      await repository.write("base.txt", "base\n")
      await repository.git(["add", "base.txt"])
      await repository.git(["commit", "--quiet", "-m", "base"])
      const baseOid = (await repository.git(["rev-parse", "HEAD"])).stdout.trim()
      await repository.git(["branch", "origin/main"])
      await repository.git(["remote", "add", "origin", "https://example.invalid/origin.git"])
      await repository.git(["update-ref", "refs/remotes/origin/main", baseOid])
      await repository.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
      const result = await inferReviewBase(new GitRunner(repository.path))
      expect(result.kind).toBe("confident")
      if (result.kind === "confident") expect(result.ref).toBe("refs/remotes/origin/main")
    } finally {
      await repository.cleanup()
    }
  })

  test("accepts SHA-256-length resolved object IDs", async () => {
    const oid = "a".repeat(64)
    const runner = {
      cwd: "/tmp/repo",
      async run(args: readonly string[]) {
        const command = args.join(" ")
        const stdout = command.includes("symbolic-ref --quiet HEAD")
          ? "refs/heads/main\n"
          : command.includes("for-each-ref")
            ? "main\n"
            : command.includes("remote")
              ? ""
              : command.includes("rev-parse --verify HEAD")
                ? `${oid}\n`
                : ""
        return { stdout }
      },
    }
    const result = await inferReviewBase(runner as never)
    expect(result.kind).toBe("choose")
  })
})
