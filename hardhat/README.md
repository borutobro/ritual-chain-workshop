# Privacy-Preserving AI Bounty Judge

> **Assignment 2 — Ritual Academy Cohort**  
> Refining the bounty system so submissions stay hidden until judging completes.

This repo contains two on-chain designs for a fair, copy-proof bounty judge:

| Track | Contract | Strength | When to use |
|---|---|---|---|
| **Required** | `contracts/PrivacyBountyJudge.sol` | Plain Solidity commit-reveal, runs on any EVM | When you want a simple, portable, audit-friendly flow |
| **Advanced** | `contracts/RitualHiddenBounty.sol` | Encrypted submissions judged by a Sovereign Agent inside a Ritual TEE | When you want true hidden answers (no plaintext ever on-chain) and batch AI judging |

Both contracts extend `utils/PrecompileConsumer.sol` from the upstream workshop, which exposes the Ritual precompile addresses (`0x0802` for synchronous LLM, `0x080C` for Sovereign Agent) and a uniform `_executePrecompile(addr, input)` helper.

---

## 🚦 Lifecycle at a Glance

### Required Track — Commit-Reveal

```
owner            submitter                anyone             owner
  │                  │                     │                  │
  │ createBounty     │                     │                  │
  │ ───────────────► │ bounty = Open       │                  │
  │                  │                     │                  │
  │                  │ submitCommitment    │                  │
  │                  │ ──────────────────► │ (commitment hash)│
  │                  │                     │                  │
  │                  │       block.timestamp >= deadline       │
  │                  │                     │                  │
  │                  │ revealAnswer        │                  │
  │                  │ ──────────────────► │ keccak256 check  │
  │                  │                     │                  │
  │                  │                     │     judgeAll     │
  │                  │                     │ ◄──────────────  │ (LLM precompile)
  │                  │                     │                  │
  │                  │                     │   finalizeWinner │
  │                  │ ◄────────────────── │ ◄────────────────│ reward paid
```

### Advanced Track — Ritual-Native Hidden Submissions

```
owner          submitter                  TEE (Sovereign Agent)         AsyncDelivery
  │                │                              │                          │
  │ createBounty   │                              │                          │
  │ ─────────────► │ bounty = Open                │                          │
  │                │                              │                          │
  │                │ encrypt (answer,salt,        │                          │
  │                │   sender,bountyId) with      │                          │
  │                │   TEE secp256k1 pubkey       │                          │
  │                │ submitSecret                 │                          │
  │                │ ───────────────────────────► │ (ciphertext only)        │
  │                │                              │                          │
  │ requestJudging                               │                          │
  │ ─────────────────────────────────────────────►                          │
  │                │                              │ decrypt + LLM batch      │
  │                │                              │ ────────────────────────► │
  │                │                              │                          │
  │                │                              │    deliverResult         │
  │                │                              │ ◄────────────────────────│
  │                │                              │ winnerIndex + attestation│
  │                │                              │                          │
  │ finalizeTEEWinner                            │                          │
  │ ─────────────► │ reward paid                  │                          │
```

---

## 🧬 Required Track — Commit-Reveal

### Why commit-reveal?

The original `AIJudge.sol` from the upstream workshop keeps every answer in plaintext storage. That means:

- **Front-running**: any observer can see the mempool and copy a clever answer before it lands.
- **Replay**: a high-quality answer can be reused across multiple bounties.
- **Asymmetric information**: once a submission lands, anyone can rephrase it.

Commit-reveal fixes all three by separating *intent* (commitment hash) from *content* (reveal), enforced by the deadline.

### Hash construction

The contract enforces:

```
commitment = keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))
```

This binds **four** fields into the hash so that:

- A commitment cannot be reused by another submitter (`msg.sender` is bound).
- The same answer cannot be re-submitted across different bounties (`bountyId` is bound).
- The submitter can't choose their salt retroactively (`salt` is bound).
- The owner can't collude with a single submitter to bypass the reveal phase (the deadline check is enforced by `block.timestamp`).

### Required functions

| Function | Phase | Caller | Purpose |
|---|---|---|---|
| `createBounty(title, rubric, deadline)` | — | anyone (escrows `msg.value`) | Spawn a new bounty in `Phase.Open` |
| `submitCommitment(bountyId, commitment)` | Open | anyone (once per submitter per bounty) | Lock in a hashed submission |
| `revealAnswer(bountyId, answer, salt)` | Reveal | original committer | Prove the hash; advance phase |
| `judgeAll(bountyId, llmInput)` | Open → Judged | bounty owner | Invoke LLM precompile on the revealed set |
| `finalizeWinner(bountyId, winnerIndex)` | Judged → Finalized | bounty owner | Pay reward to winner by index into revealed set |

### Phase machine

```
        createBounty
            │
            ▼
       ┌─────────┐  deadline reached   ┌─────────┐
       │  Open   │ ───────────────────►│ Reveal  │
       └─────────┘                     └─────────┘
            │                                │
            │ judgeAll (owner, at least       │
            │  one reveal)                   │ finalizeWinner
            ▼                                ▼
       ┌─────────┐                       ┌─────────┐
       │ Judged  │ ─────────────────────►│Finalized│
       └─────────┘                       └─────────┘
```

---

## 🔐 Advanced Track — Ritual-Native Hidden Submissions

### Why bother?

Commit-reveal still leaks **two** things:
1. The plaintext answer at reveal time (stored in event logs).
2. The fact that a particular submitter *committed at all* — which is observable in the mempool before the deadline.

The Advanced Track eliminates both by encrypting every answer under the TEE's public key. The chain only ever sees ciphertext blobs.

### Where plaintext answers exist

| Location | Plaintext? |
|---|---|
| Submitter's local memory (pre-encryption) | ✅ briefly, then zeroized by the client |
| `submitSecret` transaction mempool | ❌ only ciphertext |
| On-chain storage / event logs | ❌ only ciphertext + submitter address |
| `SOVEREIGN_AGENT_PRECOMPILE` input | ❌ only ciphertext |
| **TEE enclave** | ✅ decrypted, used as LLM prompt |
| TEE attestation report | ❌ only the winner index + scoring summary |

### How the LLM receives submissions

This is **batch judging**, not "one LLM call per answer":

1. Owner calls `requestJudging(bountyId)`.
2. The contract encodes `(bountyId, rubric, ciphertexts[])` and forwards it to `0x080C` (Sovereign Agent precompile).
3. The TEE agent:
   - Decrypts each ciphertext using its secp256k1 private key (ECIES, **nonce = 12 bytes** — the default of 16 silently fails on Ritual; see the `ritual-dapp-agents` skill).
   - Composes a single LLM prompt containing the rubric + all decrypted answers.
   - Runs the LLM inference once.
   - Returns `winnerIndex` + a signed attestation report.
4. The precompile's async-delivery system calls `deliverResult(bountyId, attestation, winnerIndex)` on the contract.
5. Owner finalizes via `finalizeTEEWinner(bountyId)`.

> **One call to the LLM, no per-answer prompt overhead.** This is materially cheaper than a naive per-submission loop and prevents prompt-injection attacks from being amplified.

### Encryption recipe (off-chain, in `submitSecret`)

```ts
import { secp256k1 } from "@noble/curves/secp256k1";
import { chacha20poly1305 } from "@noble/ciphers/chacha";

const TEE_PUBKEY = await fetchTeePubkey(bountyId); // secp256k1 uncompressed, 65 bytes
const sharedSecret = secp256k1.getSharedSecret(localPriv, TEE_PUBKEY);
const nonce = randomBytes(12);
const ciphertext = chacha20poly1305(sharedSecret, nonce).encrypt(plaintext, aad);
const onchainPayload = concat(ephemeralPub, nonce, ciphertext); // 65 + 12 + N + 16 bytes
```

> See `scripts/encryptSubmission.ts` for a full working example.

### Required functions (Advanced)

| Function | Caller | Purpose |
|---|---|---|
| `submitSecret(bountyId, ciphertext)` | anyone (once) | Post an ECIES-encrypted answer |
| `requestJudging(bountyId)` | bounty owner | Hand the ciphertext bundle to the TEE |
| `deliverResult(bountyId, attestation, winnerIndex)` | `AsyncDelivery` only | TEE callback writing the winner |
| `finalizeTEEWinner(bountyId)` | bounty owner | Pay the reward atomically |

---

## 📐 Reflection — Public, Hidden, AI, Human

> **What should be public, what should stay hidden, and what should be decided by AI versus by a human in a bounty system?**

**Public:** the existence of a bounty (title, deadline, reward), the list of submitters and their ciphertext commitments, the deadline itself, the TEE attestation report, and the final winner's address. Public visibility of *who* submitted and *when* is what makes the system auditable — anyone can verify that the judging was completed inside a genuine TEE and that the winner index matches a real on-chain submission. **Hidden:** plaintext answers must never appear on-chain — not in storage, not in event logs, not in calldata. The reveal phase of the Required Track and the TEE-only decryption of the Advanced Track both exist for this reason. **AI-decided:** the ranking itself and the winner selection. Bounty rubrics are inherently subjective, scoring them deterministically is what LLMs are good at, and running the judgement inside a TEE removes any trust assumption about the operator. **Human-decided:** the lifecycle parameters (deadline, reward, rubric wording), the dispute / appeal policy, and — critically — the *initial* submission review. A human owner gates whether a bounty exists at all, while the AI gates who wins. This split keeps accountability clear: humans set the rules, AI enforces them, and cryptography guarantees that neither side can cheat the other mid-game.

---

## 🧪 Test Plan

See [`TEST_PLAN.md`](./TEST_PLAN.md) for the full case-by-case matrix. Quick summary:

- **R-01 happy path**: 3 commitments → 3 reveals → judge → finalize → correct reward paid.
- **R-02** wrong `(answer, salt)` reverts with `hash mismatch`.
- **R-03** double-reveal reverts with `already revealed`.
- **R-04** duplicate submitter reverts with `already committed`.
- **R-05** reveal before deadline reverts with `reveal not open`.
- **R-06** reveal after judge reverts with `too late`.
- **R-07** `judgeAll` with zero revealed answers reverts with `no revealed answers`.
- **R-08** `finalizeWinner` before `judgeAll` reverts with `not judged yet`.
- **R-09** `finalizeWinner` with out-of-range `winnerIndex` reverts with `invalid winner index`.
- **R-10** same `(answer, salt)` by two submitters yields **different** commitments (binding test).
- **R-11** same `(answer, salt, submitter)` across two bounties yields **different** commitments.
- **R-12** non-owner cannot call `judgeAll` (`not bounty owner`).
- **R-13** `MAX_SUBMISSIONS` enforced.
- **R-14** answer length cap enforced.
- **R-15** `bytes32(0)` commitment rejected.
- **A-01..A-10** Advanced Track: ciphertext-only storage, AsyncDelivery-gated callback, plaintext-never-leaked invariant.

Run with:

```bash
cd hardhat
pnpm install
pnpm hardhat test test/PrivacyBountyJudge.test.ts
pnpm hardhat test test/RitualHiddenBounty.test.ts
```

---

## 🏗️ Architecture Note

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the trust model, threat model, gas estimates, and deployment runbook.

---

## 📦 Deliverables Checklist

- [x] Updated Solidity contract(s): `PrivacyBountyJudge.sol` + `RitualHiddenBounty.sol`
- [x] `README.md` explaining the lifecycle (this file)
- [x] `TEST_PLAN.md` enumerating reveal cases
- [x] `ARCHITECTURE.md` with the public-vs-hidden vs AI-vs-human decision matrix
- [x] Reflection (above, also embedded in `ARCHITECTURE.md`)
- [x] Foundry/Hardhat test suite (`test/*.test.ts`)
- [x] Hardhat Ignition module (`ignition/modules/PrivacyBounty.ts`)

---

## 🚀 Deploy (Ritual Testnet)

```bash
cd hardhat
pnpm install
pnpm hardhat ignition deploy ignition/modules/PrivacyBounty.ts --network ritual
```

> Requires `DEPLOYER_PRIVATE_KEY` and `RITUAL_RPC_URL` in your env. See `hardhat/.env.example`.

---

*Built for Ritual Academy Cohort 2026. Made with 🛡️ commit-reveal + 🐊 Sovereign TEE.*