# Architecture Note — Privacy Bounty Judge

## 1. Goals & Non-Goals

**Goals**
- Prevent copy-cat submissions during the open phase.
- Keep plaintext answers off-chain in the Advanced Track.
- Provide a single batch LLM call for judging (not one call per answer).
- Make every state transition auditable from on-chain data alone.

**Non-Goals**
- Anonymous submission identities (zero-knowledge identity is out of scope; we assume `msg.sender` is a meaningful address).
- Resolving rubric ambiguity — the rubric is supplied by the bounty owner as text.
- Off-chain dispute resolution. Once `finalize*Winner` runs, the contract is done.

## 2. Trust Model

| Actor | Trusts | Doesn't Trust |
|---|---|---|
| Submitter | Contract, Ritual TEE | Bounty owner, other submitters |
| Bounty owner | Contract, Ritual TEE, LLM rubric honesty | Submitters (cannot see plaintext until judging) |
| TEE / LLM | Contract (uses canonical ABI) | Anyone — but produces a signed attestation proving what it did |
| Outside observer | Contract, TEE attestation | Whoever controls the bounty owner wallet |

## 3. Threat Model

| Threat | Required Track mitigation | Advanced Track mitigation |
|---|---|---|
| Copy-cat submits after seeing a clever answer | Commitment hash hides plaintext until reveal | Ciphertext is unreadable without TEE key |
| Replay same answer across bounties | `bountyId` bound into commitment | `bountyId` bound into plaintext pre-encryption |
| Front-run a submission in mempool | Commitment hash prevents copying without the salt | Ciphertext prevents copying without the TEE key |
| Bounty owner colludes with one submitter | Phase machine + `block.timestamp` enforces sequencing | TEE-decided winner, attestation on-chain |
| Operator tampers with LLM output | Phase requires owner to send `judgeAll` (signed) | TEE attestation report is signed and on-chain |
| Submitter never reveals (griefing) | Commitment is burned (no reward); revealedCount decrements expected participants | Equivalent — encrypted submissions are simply not judged |
| Reused ciphertext across submitters | n/a | `(submitter, ciphertext)` is unique per submission by `_commitmentIndexPlusOne` |

## 4. State Machine

```
   createBounty
       │
       ▼
   ┌────────┐  block.timestamp ≥ deadline  ┌────────┐
   │  Open  │ ────────────────────────────►│ Reveal │
   └────────┘                              └────────┘
       │                                        │
       │ judgeAll (owner)                       │ finalizeWinner
       ▼                                        ▼
   ┌────────┐  finalizeWinner              ┌──────────┐
   │ Judged │ ────────────────────────────►│Finalized │
   └────────┘                              └──────────┘
```

The phase is stored as a single `uint8` (`Phase` enum) per bounty. Every external function enforces its expected phase with `inPhase` modifier (Required Track) or explicit `require(bounty.phase == ...)` (Advanced Track). Any function called in the wrong phase reverts with `wrong phase`.

## 5. Data Layout

### Required Track

```
Bounty {
    address owner
    string  title
    string  rubric
    uint256 reward
    uint256 deadline
    Phase   phase
    bytes   aiReview          // opaque LLM precompile return
    uint256 winnerIndex
    uint256 revealedCount
    Commitment[] commitments  // submitter, hash, revealed flag
}
```

The plaintext answer is **never stored**. It is recovered off-chain from the `AnswerRevealed(bountyId, idx, submitter, answer)` event log during judging. This is intentional: storing plaintext would re-leak the answer to any archive node.

### Advanced Track

```
EncryptedSubmission {
    address submitter
    bytes   ciphertext        // ECIES(answer,salt,sender,bountyId) under TEE pubkey
    bool    delivered         // set true after TEE judging completes
}
```

In addition to the parent `Bounty` struct (used for lifecycle bookkeeping), the Advanced Track keeps a parallel `_encrypted[]` array because the Advanced Track never wants to expose a `reveal` path — once data is encrypted, it stays encrypted until the TEE decrypts it.

## 6. Gas Estimates (Ritual Testnet)

Rough estimates from `ritual-dapp-agents` calibration runs:

| Operation | Required Track | Advanced Track |
|---|---|---|
| `createBounty` | ~85k | (inherited) ~85k |
| `submitCommitment` / `submitSecret` | ~95k | ~140k (ciphertext stored) |
| `revealAnswer` | ~70k | n/a |
| `judgeAll` (LLM precompile, batch=10) | ~3.2M (gas-bounded by LLM call) | n/a |
| `requestJudging` (Sovereign precompile) | n/a | ~250k + LLM cost |
| `deliverResult` | n/a | ~120k |
| `finalizeWinner` / `finalizeTEEWinner` | ~55k | ~55k |

> Numbers above are from the calibration harness documented in `ritual-dapp-agents`. Add ~10% buffer for EIP-1559 base fee variance (recommended `maxFeePerGas ≥ 20 gwei`, `maxPriorityFeePerGas ≥ 1 gwei`).

## 7. Cryptographic Choices

- **Required Track hash**: `keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))`. Same construction as EIP-12 commit-reveal voting schemes.
- **Advanced Track encryption**: ECIES with secp256k1, ephemeral key per submission, ChaCha20-Poly1305 with **12-byte nonce**. The 12-byte nonce is *not* the default — most ECIES libraries default to 16. The `ritual-dapp-agents` skill flags this as the #1 cause of silent decryption failures in production.
- **TEE pubkey retrieval**: On-chain via the Sovereign Agent registry. Never copy-paste from a doc — it can rotate.

## 8. Public vs Hidden vs AI vs Human

> **What should be public, what should stay hidden, and what should be decided by AI versus by a human in a bounty system?**

**Public:** the existence of a bounty (title, deadline, reward), the list of submitters and their ciphertext commitments, the deadline itself, the TEE attestation report, and the final winner's address. Public visibility of *who* submitted and *when* is what makes the system auditable — anyone can verify that the judging was completed inside a genuine TEE and that the winner index matches a real on-chain submission. **Hidden:** plaintext answers must never appear on-chain — not in storage, not in event logs, not in calldata. The reveal phase of the Required Track and the TEE-only decryption of the Advanced Track both exist for this reason. **AI-decided:** the ranking itself and the winner selection. Bounty rubrics are inherently subjective, scoring them deterministically is what LLMs are good at, and running the judgement inside a TEE removes any trust assumption about the operator. **Human-decided:** the lifecycle parameters (deadline, reward, rubric wording), the dispute / appeal policy, and — critically — the *initial* submission review. A human owner gates whether a bounty exists at all, while the AI gates who wins. This split keeps accountability clear: humans set the rules, AI enforces them, and cryptography guarantees that neither side can cheat the other mid-game.

## 9. Deployment Runbook

```bash
cd hardhat
pnpm install

# Unit tests
pnpm hardhat test

# Local deploy (in-memory)
pnpm hardhat ignition deploy ignition/modules/PrivacyBounty.ts

# Ritual testnet
export DEPLOYER_PRIVATE_KEY=0x...
pnpm hardhat ignition deploy ignition/modules/PrivacyBounty.ts --network ritual

# Verify on explorer
# https://explorer.ritualfoundation.org/address/<contract>
```

## 10. Open Questions / Future Work

- **Zero-knowledge identity**: hide submitter addresses behind a Semaphore-style anonymity set. Out of scope for this assignment.
- **Multi-judge rubric**: blend several LLMs (or human + LLM) to reduce single-model bias.
- **Partial payouts**: split reward across top-K winners rather than a single winner. Requires a more sophisticated LLM scoring output format.
- **Encrypted rubric**: the rubric itself is public on-chain today. For ultra-sensitive bounties, the rubric could be encrypted with the TEE pubkey and only revealed during judging.