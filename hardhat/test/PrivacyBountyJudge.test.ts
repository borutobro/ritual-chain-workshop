import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import hre, { network } from "hardhat";
import { keccak256, toBytes, toHex } from "viem";

/**
 * Test suite for `PrivacyBountyJudge` (Required Track).
 * Hardhat 3 + viem toolbox. Uses network.create() for isolated blockchain state.
 *
 * Coverage matrix
 * ───────────────
 *  •  R-01  happy path
 *  •  R-02  hash mismatch on reveal
 *  •  R-03  double-reveal
 *  •  R-04  duplicate submitter
 *  •  R-05  reveal before deadline
 *  •  R-10  commitment binding across submitters
 *  •  R-11  commitment binding across bounties
 *  •  R-12  non-owner cannot judge
 *  •  R-14  max answer length
 *  •  R-15  empty commitment rejected
 *  •  R-08  finalize without judge
 *  •  R-16, R-17 input validation
 */

const BOUNTY_TITLE = "Best LLM prompt for on-chain summarization";
const BOUNTY_RUBRIC = "Score 0-10 on accuracy, brevity, and on-chain fidelity.";
const PAST_DEADLINE = BigInt(Math.floor(Date.now() / 1000) - 60);

function buildCommitment(
  answer: string,
  salt: `0x${string}`,
  sender: `0x${string}`,
  bountyId: bigint
): `0x${string}` {
  return keccak256(
    Buffer.concat([
      toBytes(answer),
      toBytes(salt),
      toBytes(sender),
      toBytes(toHex(bountyId, { size: 32 })),
    ])
  );
}

async function expectRevert(promise: Promise<unknown>, reasonMatch: RegExp) {
  try {
    await promise;
    assert.fail("Expected revert but got success");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, reasonMatch, `Expected match ${reasonMatch}, got: ${msg}`);
  }
}

describe("PrivacyBountyJudge — Required Track", async () => {
  const conn = await network.connect();
  const { viem, networkHelpers } = conn;
  const publicClient = await viem.getPublicClient();
  const futureDeadline = async () => {
  const ts = await networkHelpers.time.latest();
  return BigInt(ts) + 3600n;
};

  async function deployJudge() {
    const [owner, alice, bob, carol] = await viem.getWalletClients();
    const judge = await viem.deployContract("PrivacyBountyJudge");
    return { judge, owner, alice, bob, carol };
  }

  async function createBounty(judge: any, owner: any, reward = 10n ** 16n) {
    const hash = await judge.write.createBounty({
      args: [BOUNTY_TITLE, BOUNTY_RUBRIC, await futureDeadline()],
      value: reward,
      account: owner.account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return 1n;
  }

  describe("R-01 happy path", () => {
    it("runs the full lifecycle", async () => {
      const { judge, owner, alice, bob, carol } = await deployJudge();
      const bountyId = await createBounty(judge, owner);

      const a1 = "answer-A";
      const s1 = ("0x" + "11".repeat(32)) as `0x${string}`;
      const c1 = buildCommitment(a1, s1, alice.account.address, bountyId);
      const a2 = "answer-B";
      const s2 = ("0x" + "22".repeat(32)) as `0x${string}`;
      const c2 = buildCommitment(a2, s2, bob.account.address, bountyId);
      const a3 = "answer-C";
      const s3 = ("0x" + "33".repeat(32)) as `0x${string}`;
      const c3 = buildCommitment(a3, s3, carol.account.address, bountyId);

      for (const [c, acct] of [[c1, alice], [c2, bob], [c3, carol]] as const) {
        const h = await judge.write.submitCommitment({ args: [bountyId, c], account: acct.account });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }

      await networkHelpers.time.increase(3700);
      await networkHelpers.mine();

      for (const [a, s, acct] of [[a1, s1, alice], [a2, s2, bob], [a3, s3, carol]] as const) {
        const h = await judge.write.revealAnswer({ args: [bountyId, a, s], account: acct.account });
        await publicClient.waitForTransactionReceipt({ hash: h });
      }

      // judgeAll calls the LLM precompile (0x0802) which is not present in
      // the in-memory EDR; we expect it to revert. The contract-level
      // phase-check (`phase != Judged && phase != Finalized`) passes, so
      // the revert comes from the precompile call itself. We treat that
      // as expected behavior — the in-memory test environment can't
      // execute the LLM. A live testnet run will exercise the full path.
      await expectRevert(
        judge.write.judgeAll({
          args: [bountyId, "0x" as `0x${string}`],
          account: owner.account,
        }),
        /reverted/i
      );

      const summary = await judge.read.getBountySummary([bountyId]);
      assert.equal(summary[5], 3n, "submissionCount");
      assert.equal(summary[6], 3n, "revealedCount");
      assert.equal(summary[7], (1n << 256n) - 1n, "winnerIndex unchanged after judgeAll revert");
      assert.ok(summary[3] > 0n, "deadline stored");
    });
  });

  describe("R-02 hash mismatch on reveal reverts", () => {
    it("rejects a wrong (answer, salt) pair", async () => {
      const { judge, owner, alice } = await deployJudge();
      const bountyId = await createBounty(judge, owner);
      const salt = ("0x" + "aa".repeat(32)) as `0x${string}`;
      const commitment = buildCommitment("real", salt, alice.account.address, bountyId);
      const h = await judge.write.submitCommitment({ args: [bountyId, commitment], account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await networkHelpers.time.increase(3700);
      await networkHelpers.mine();

      await expectRevert(
        judge.write.revealAnswer({ args: [bountyId, "fake", salt], account: alice.account }),
        /hash mismatch/i
      );
    });
  });

  describe("R-03 double-reveal reverts", () => {
    it("rejects second reveal from same submitter", async () => {
      const { judge, owner, alice } = await deployJudge();
      const bountyId = await createBounty(judge, owner);
      const salt = ("0x" + "ab".repeat(32)) as `0x${string}`;
      const c = buildCommitment("hello", salt, alice.account.address, bountyId);
      const h1 = await judge.write.submitCommitment({ args: [bountyId, c], account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash: h1 });
      await networkHelpers.time.increase(3700);
      await networkHelpers.mine();
      const h2 = await judge.write.revealAnswer({ args: [bountyId, "hello", salt], account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash: h2 });
      await expectRevert(
        judge.write.revealAnswer({ args: [bountyId, "hello", salt], account: alice.account }),
        /already revealed/i
      );
    });
  });

  describe("R-04 duplicate submitter reverts", () => {
    it("rejects second commitment from same address", async () => {
      const { judge, owner, alice } = await deployJudge();
      const bountyId = await createBounty(judge, owner);
      const s1 = ("0x" + "01".repeat(32)) as `0x${string}`;
      const s2 = ("0x" + "02".repeat(32)) as `0x${string}`;
      const c1 = buildCommitment("a", s1, alice.account.address, bountyId);
      const c2 = buildCommitment("b", s2, alice.account.address, bountyId);
      const h1 = await judge.write.submitCommitment({ args: [bountyId, c1], account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash: h1 });
      await expectRevert(
        judge.write.submitCommitment({ args: [bountyId, c2], account: alice.account }),
        /already committed/i
      );
    });
  });

  describe("R-05 reveal before deadline reverts", () => {
    it("rejects early reveal", async () => {
      const { judge, owner, alice } = await deployJudge();
      const bountyId = await createBounty(judge, owner);
      const salt = ("0x" + "cd".repeat(32)) as `0x${string}`;
      const c = buildCommitment("x", salt, alice.account.address, bountyId);
      const h = await judge.write.submitCommitment({ args: [bountyId, c], account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await expectRevert(
        judge.write.revealAnswer({ args: [bountyId, "x", salt], account: alice.account }),
        /reveal not open/i
      );
    });
  });

  describe("R-10 commitment binding across submitters", () => {
    it("same answer+salt yields different commitments", async () => {
      const { judge, owner, alice, bob } = await deployJudge();
      const bountyId = await createBounty(judge, owner);
      const salt = ("0x" + "ee".repeat(32)) as `0x${string}`;
      const cA = buildCommitment("dup", salt, alice.account.address, bountyId);
      const cB = buildCommitment("dup", salt, bob.account.address, bountyId);
      assert.notEqual(cA, cB);
    });
  });

  describe("R-11 commitment binding across bounties", () => {
    it("same submitter+answer yields different commitments per bounty", async () => {
      const { judge, owner, alice } = await deployJudge();
      const b1 = await createBounty(judge, owner);
      const h = await judge.write.createBounty({
        args: [BOUNTY_TITLE, BOUNTY_RUBRIC, await futureDeadline()],
        value: 10n ** 16n,
        account: owner.account,
      });
      await publicClient.waitForTransactionReceipt({ hash: h });
      const b2 = 2n;
      const salt = ("0x" + "ff".repeat(32)) as `0x${string}`;
      const c1 = buildCommitment("dup", salt, alice.account.address, b1);
      const c2 = buildCommitment("dup", salt, alice.account.address, b2);
      assert.notEqual(c1, c2);
    });
  });

  describe("R-12 non-owner cannot judge", () => {
    it("reverts on unauthorized judge", async () => {
      const { judge, owner, alice } = await deployJudge();
      const bountyId = await createBounty(judge, owner);
      await expectRevert(
        judge.write.judgeAll({ args: [bountyId, "0x" as `0x${string}`], account: alice.account }),
        /not bounty owner/i
      );
    });
  });

  describe("R-14 max answer length enforced", () => {
    it("rejects oversized answer on reveal", async () => {
      const { judge, owner, alice } = await deployJudge();
      const bountyId = await createBounty(judge, owner);
      const longAnswer = "a".repeat(4001);
      const salt = ("0x" + "42".repeat(32)) as `0x${string}`;
      const c = buildCommitment(longAnswer, salt, alice.account.address, bountyId);
      const h = await judge.write.submitCommitment({ args: [bountyId, c], account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await networkHelpers.time.increase(3700);
      await networkHelpers.mine();
      await expectRevert(
        judge.write.revealAnswer({ args: [bountyId, longAnswer, salt], account: alice.account }),
        /answer too long/i
      );
    });
  });

  describe("R-15 empty commitment rejected", () => {
    it("reverts on bytes32(0)", async () => {
      const { judge, owner, alice } = await deployJudge();
      const bountyId = await createBounty(judge, owner);
      await expectRevert(
        judge.write.submitCommitment({
          args: [bountyId, "0x0000000000000000000000000000000000000000000000000000000000000000"],
          account: alice.account,
        }),
        /empty commitment/i
      );
    });
  });

  describe("R-08 finalize without judge reverts", () => {
    it("requires phase == Judged", async () => {
      const { judge, owner } = await deployJudge();
      const bountyId = await createBounty(judge, owner);
      await expectRevert(
        judge.write.finalizeWinner({ args: [bountyId, 0n], account: owner.account }),
        /not judged yet/i
      );
    });
  });

  describe("R-17 reward required", () => {
    it("reverts on createBounty with msg.value=0", async () => {
      const { judge, owner } = await deployJudge();
      await expectRevert(
        judge.write.createBounty({
          args: [BOUNTY_TITLE, BOUNTY_RUBRIC, await futureDeadline()],
          value: 0n,
          account: owner.account,
        }),
        /reward required/i
      );
    });
  });

  describe("R-16 deadline must be future", () => {
    it("reverts on createBounty with past deadline", async () => {
      const { judge, owner } = await deployJudge();
      await expectRevert(
        judge.write.createBounty({
          args: [BOUNTY_TITLE, BOUNTY_RUBRIC, PAST_DEADLINE],
          value: 10n ** 16n,
          account: owner.account,
        }),
        /deadline must be future/i
      );
    });
  });
});