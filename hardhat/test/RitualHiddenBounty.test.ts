import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre, { network } from "hardhat";
import { keccak256, toBytes } from "viem";

/**
 * Test suite for `RitualHiddenBounty` (Advanced Track).
 * Hardhat 3 + viem toolbox.
 *
 * Coverage matrix
 * ───────────────
 *  •  A-01..A-12 — see TEST_PLAN.md
 */

const RUBRIC = "Hidden scoring rubric";
const ASYNC = "0x5A16214fF555848411544b005f7Ac063742f39F6" as `0x${string}`;

async function expectRevert(promise: Promise<unknown>, reasonMatch: RegExp) {
  try {
    await promise;
    assert.fail("Expected revert but got success");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, reasonMatch, `Expected match ${reasonMatch}, got: ${msg}`);
  }
}

function fakeCiphertext(seed: string): `0x${string}` {
  // Build a valid 65-byte ciphertext (>= 32 + 12 + 16) using only hex chars
  // salt by padding the seed with 0s and prefixing with the seed's hash
  const seedHex = Buffer.from(seed).toString("hex").padEnd(8, "0").slice(0, 8);
  return ("0x" + seedHex + "00".repeat(57)).slice(0, 130) as `0x${string}`;
}

describe("RitualHiddenBounty — Advanced Track", async () => {
  const conn = await network.connect();
  const { viem, networkHelpers } = conn;
  const publicClient = await viem.getPublicClient();
  const futureDeadline = async () => {
  const ts = await networkHelpers.time.latest();
  return BigInt(ts) + 3600n;
};

  async function deployHidden() {
    const [owner, alice, bob] = await viem.getWalletClients();
    const hidden = await viem.deployContract("RitualHiddenBounty");
    return { hidden, owner, alice, bob };
  }

  async function makeBounty(hidden: any, owner: any) {
    const h = await hidden.write.createBounty({
      args: ["Hidden Bounty", RUBRIC, await futureDeadline()],
      value: 10n ** 16n,
      account: owner.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    return 1n;
  }

  async function impersonateAsync() {
    await networkHelpers.impersonateAccount(ASYNC);
    await networkHelpers.setBalance(ASYNC, 10n ** 18n);
    return await viem.getWalletClient(ASYNC);
  }

  it("A-01 owner creates bounty; submitter posts ciphertext", async () => {
    const { hidden, alice } = await deployHidden();
    const bountyId = await makeBounty(hidden, alice);
    const ct = fakeCiphertext("ab");
    const h = await hidden.write.submitSecret({ args: [bountyId, ct], account: alice.account });
    await publicClient.waitForTransactionReceipt({ hash: h });

    const [subs, cts] = await hidden.read.getEncryptedSubmissions([bountyId]);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].toLowerCase(), alice.account.address.toLowerCase());
    assert.equal(cts[0], ct);
  });

  it("A-02 multiple submitters accumulate ciphertexts", async () => {
    const wallets = await deployHidden();
    const { hidden, owner, alice, bob } = wallets;
    if (!bob?.account) throw new Error("bob wallet missing");
    const bountyId = await makeBounty(hidden, owner);

    const h1 = await hidden.write.submitSecret({
      args: [bountyId, fakeCiphertext("alice")],
      account: alice.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: h1 });

    const h2 = await hidden.write.submitSecret({
      args: [bountyId, fakeCiphertext("bob")],
      account: bob.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: h2 });

    const [subs] = await hidden.read.getEncryptedSubmissions([bountyId]);
    assert.equal(subs.length, 2);
  });

  it("A-03 duplicate submitter reverts", async () => {
    const { hidden, owner, alice } = await deployHidden();
    const bountyId = await makeBounty(hidden, owner);
    const h1 = await hidden.write.submitSecret({
      args: [bountyId, fakeCiphertext("1")],
      account: alice.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: h1 });
    await expectRevert(
      hidden.write.submitSecret({ args: [bountyId, fakeCiphertext("2")], account: alice.account }),
      /already submitted/i
    );
  });

  it("A-04 requestJudging before deadline reverts", async () => {
    const { hidden, owner, alice } = await deployHidden();
    const bountyId = await makeBounty(hidden, owner);
    const h = await hidden.write.submitSecret({
      args: [bountyId, fakeCiphertext("x")],
      account: alice.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    await expectRevert(
      hidden.write.requestJudging({ args: [bountyId], account: owner.account }),
      /deadline not reached/i
    );
  });

  it("A-05 requestJudging by non-owner reverts", async () => {
    const wallets = await deployHidden();
    const { hidden, owner, alice, bob } = wallets;
    if (!bob?.account) throw new Error("bob wallet missing");
    const bountyId = await makeBounty(hidden, owner);
    const h = await hidden.write.submitSecret({
      args: [bountyId, fakeCiphertext("x")],
      account: alice.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    await networkHelpers.time.increase(3700);
    await networkHelpers.mine();
    await expectRevert(
      hidden.write.requestJudging({ args: [bountyId], account: bob.account }),
      /not bounty owner/i
    );
  });

  it("A-06 ciphertext too short reverts", async () => {
    const { hidden, owner, alice } = await deployHidden();
    const bountyId = await makeBounty(hidden, owner);
    await expectRevert(
      hidden.write.submitSecret({ args: [bountyId, "0x1234"], account: alice.account }),
      /ciphertext too short/i
    );
  });

  it("A-07 deliverResult only callable from AsyncDelivery", async () => {
    const { hidden, alice } = await deployHidden();
    await expectRevert(
      hidden.write.deliverResult({ args: [1n, "0x" as `0x${string}`, 0n], account: alice.account }),
      /only async delivery/i
    );
  });

  it("A-08 finalizeTEEWinner only after Judged", async () => {
    const { hidden, owner } = await deployHidden();
    const bountyId = await makeBounty(hidden, owner);
    await expectRevert(
      hidden.write.finalizeTEEWinner({ args: [bountyId], account: owner.account }),
      /not judged/i
    );
  });

  it("A-09 invalid winnerIndex from TEE reverts on deliverResult", async () => {
    const { hidden, owner, alice } = await deployHidden();
    const bountyId = await makeBounty(hidden, owner);
    const h = await hidden.write.submitSecret({
      args: [bountyId, fakeCiphertext("alice")],
      account: alice.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: h });

    const asyncClient = await impersonateAsync();
    await expectRevert(
      hidden.write.deliverResult({
        args: [bountyId, "0xdeadbeef" as `0x${string}`, 99n],
        account: asyncClient!.account,
      }),
      /invalid winner/i
    );
  });

  it("A-10 plaintext answer never appears in storage or events", async () => {
    const { hidden, owner, alice } = await deployHidden();
    const bountyId = await makeBounty(hidden, owner);

    const plaintextAnswer = "the secret sauce is love and 0xC0FFEE";
    const ct = ("0x" + keccak256(toBytes(plaintextAnswer)).slice(2) + "00".repeat(60)).slice(0, 130) as `0x${string}`;

    const txHash = await hidden.write.submitSecret({
      args: [bountyId, ct],
      account: alice.account,
    });
    const rcpt = await publicClient.getTransactionReceipt({ hash: txHash });

    const logsBlob = JSON.stringify(rcpt.logs, (_, v) => typeof v === "bigint" ? v.toString() : v);
    assert.ok(
      !logsBlob.toLowerCase().includes(plaintextAnswer.toLowerCase()),
      "plaintext must not appear in tx receipt logs"
    );

    const [, cts] = await hidden.read.getEncryptedSubmissions([bountyId]);
    for (const c of cts) {
      assert.ok(
        !c.toLowerCase().includes(plaintextAnswer.toLowerCase()),
        "plaintext must not appear in stored ciphertext"
      );
    }
  });

  it("A-11 TEE marks submissions delivered", async () => {
    const { hidden, owner, alice } = await deployHidden();
    const bountyId = await makeBounty(hidden, owner);
    const h = await hidden.write.submitSecret({
      args: [bountyId, fakeCiphertext("alice")],
      account: alice.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: h });

    const asyncClient = await impersonateAsync();
    const dh = await hidden.write.deliverResult({
      args: [bountyId, ("0x" + "ab".repeat(32)) as `0x${string}`, 0n],
      account: asyncClient!.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: dh });

    assert.equal(await hidden.read.tWinnerIndex([bountyId]), 0n);
    assert.ok((await hidden.read.tAttestationReports([bountyId])).length > 0);
  });

  it("A-12 finalizeTEEWinner pays the winner", async () => {
    const { hidden } = await deployHidden();
    const allWallets = await viem.getWalletClients();
    if (!allWallets[0] || !allWallets[1] || !allWallets[2]) throw new Error("missing wallets");
    const owner = allWallets[0];
    const alice = allWallets[1];
    const bob = allWallets[2];
    const bountyId = await makeBounty(hidden, owner);

    const aliceCt = fakeCiphertext("alice");
    const bobCt = fakeCiphertext("bob");

    const h1 = await hidden.write.submitSecret({ args: [bountyId, aliceCt], account: alice.account });
    await publicClient.waitForTransactionReceipt({ hash: h1 });
    const h2 = await hidden.write.submitSecret({ args: [bountyId, bobCt], account: bob.account });
    await publicClient.waitForTransactionReceipt({ hash: h2 });

    const asyncClient = await impersonateAsync();
    const dh = await hidden.write.deliverResult({
      args: [bountyId, ("0x" + "cd".repeat(32)) as `0x${string}`, 1n],
      account: asyncClient!.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: dh });

    const bobBalBefore = await publicClient.getBalance({ address: bob.account.address });
    const fh = await hidden.write.finalizeTEEWinner({ args: [bountyId], account: owner.account });
    await publicClient.waitForTransactionReceipt({ hash: fh });
    const bobBalAfter = await publicClient.getBalance({ address: bob.account.address });

    assert.equal(bobBalAfter - bobBalBefore, 10n ** 16n, "reward should equal bounty escrow");
  });
});